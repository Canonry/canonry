/**
 * Scripted Aero turns for the public demo's dashboard starters.
 *
 * Built once at startup from the seeded rows, so every number, name and date
 * in a turn is the one the dashboard shows for the same sample. Nothing here
 * calls a model or a provider: the demo replays these turns in the Aero bar
 * instead of running the agent. Tool names, titles and arguments are checked
 * against the real MCP registry, so a renamed tool fails demo startup rather
 * than shipping a card for a tool that no longer exists.
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import {
  aeroPreviewResponseSchema,
  formatPercent,
  parseStoredMeasurementPlanAnyVersion,
  wilsonInterval,
  type AeroPreviewResponse,
  type AeroPreviewStarter,
  type AeroPreviewStep,
} from '@ainyc/canonry-contracts'
import {
  insights,
  measurementPlanVersions,
  querySnapshots,
  runs,
  simpleMeasurementDefinitions,
  siteCrawlFindings,
  siteCrawlSnapshots,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { canonryMcpTools } from '../mcp/tool-registry.js'
import { SUMMIT_QUERIES } from './summit-sweeps.js'
import type { DemoSeedContext, DemoSeedProject } from './types.js'

type QueryClass = 'branded' | 'non-brand'

interface Competitor { label: string; domain: string }

interface Answer {
  queryId: string
  query: string
  provider: string
  queryClass: QueryClass | null
  /** Portfolio Property the query is assigned to; null for a simple project. */
  targetKey: string | null
  mentioned: boolean
  cited: boolean
  /** Tracked competitors the answer text names. */
  named: string[]
  /**
   * Tracked competitors whose domain is among the answer's cited sources.
   * Not `competitorOverlap`, which also counts a competitor the text only names.
   */
  competitorCited: string[]
  citedDomains: string[]
  ownCitedPaths: string[]
}

interface Sweep {
  id: string
  createdAt: string
  planRevision: number | null
  executionChecksum: string | null
  expectedAnswers: number | null
  answers: Answer[]
}

interface Property { key: string; label: string; market: string; pathPrefixes: string[] }

interface ProjectFacts {
  project: DemoSeedProject
  sweeps: Sweep[]
  latest: Sweep
  previous: Sweep
  competitors: Competitor[]
  properties: Map<string, Property>
}

interface Tally { mentioned: number; cited: number; total: number }

const ENGINE_ORDER = ['openai', 'gemini', 'claude']
// The dashboard's engine names (VisibilityTrendSection), so the preview matches the charts.
const ENGINE_NAMES: Record<string, string> = { openai: 'OpenAI', gemini: 'Gemini', claude: 'Claude' }

const SUMMIT_TOPICS: Record<string, string> = {
  'reviews': 'Reviews',
  'warranty': 'Warranty',
  'near-me': 'Local repair',
  'emergency-leak': 'Emergency repair',
  'metal-installer': 'Metal roofing',
  'replacement-cost': 'Replacement cost',
  'storm-claims': 'Storm damage',
  'asphalt-shingles': 'Shingle replacement',
  'seamless-gutters': 'Gutters',
  'pre-purchase-inspection': 'Inspections',
}

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
/** A UTC calendar day such as "Sep 23", so the text never depends on the host time zone. */
export function formatPreviewDay(iso: string): string {
  return DAY.format(new Date(iso))
}

const engineName = (provider: string): string => ENGINE_NAMES[provider] ?? provider
const quoted = (text: string): string => `"${text}"`
const ratio = (numerator: number, denominator: number): string => `${numerator}/${denominator}`
/** The share as Aero states every ratio: through `formatPercent`, from the unrounded counts. */
const percent = (numerator: number, denominator: number): string => denominator === 0 ? formatPercent(0) : formatPercent(numerator / denominator)
const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)]

function listJoin(items: readonly string[], conjunction: 'and' | 'or' = 'and'): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items.at(-1)}`
}

function engineOrder(left: string, right: string): number {
  const rank = (provider: string) => {
    const index = ENGINE_ORDER.indexOf(provider)
    return index === -1 ? ENGINE_ORDER.length : index
  }
  return rank(left) - rank(right) || (left < right ? -1 : left > right ? 1 : 0)
}

function tally(answers: readonly Answer[]): Tally {
  return {
    mentioned: answers.filter(answer => answer.mentioned).length,
    cited: answers.filter(answer => answer.cited).length,
    total: answers.length,
  }
}

/** The visibility-compare rule: two 95% Wilson intervals that overlap are within run-to-run noise. */
function withinNoise(before: { n: number; d: number }, after: { n: number; d: number }): boolean {
  const a = wilsonInterval(before.n, before.d)
  const b = wilsonInterval(after.n, after.d)
  if (!a || !b) return true
  return a.low <= b.high && b.low <= a.high
}

function noisePhrase(within: boolean): string {
  return within ? 'Within normal run-to-run noise.' : 'Bigger than normal run-to-run noise.'
}

function movement(current: number, previous: number, denominator: number): string {
  if (current === previous) return `${ratio(current, denominator)}, unchanged`
  return `${ratio(current, denominator)}, ${current > previous ? 'up' : 'down'} from ${ratio(previous, denominator)}`
}

function step(name: string, args: Record<string, unknown>, result: unknown, durationMs: number, text?: string): AeroPreviewStep {
  const tool = canonryMcpTools.find(candidate => candidate.name === name)
  if (!tool) throw new Error(`Aero preview names an unregistered tool: ${name}`)
  const parsed = tool.inputSchema.safeParse(args)
  if (!parsed.success) throw new Error(`Aero preview passes invalid arguments to ${name}: ${parsed.error.message}`)
  // A schema parse drops keys it does not know, so a misspelled argument would pass silently.
  const unknownKeys = Object.keys(args).filter(key => !(key in (parsed.data as Record<string, unknown>)))
  if (unknownKeys.length > 0) throw new Error(`Aero preview passes unknown arguments to ${name}: ${unknownKeys.join(', ')}`)
  return { ...(text ? { text } : {}), tool: { name, label: tool.title, arguments: args, result, durationMs } }
}

/**
 * The instruction in a stored recommendation reason, as a clause such as
 * "audit content and schema for this topic", without the dash aside the
 * analyzer appends.
 */
function recommendationClause(reason: string | undefined): string {
  if (!reason) return ''
  const head = reason.split(/\s+[\u2014\u2013]\s+/)[0]!.trim()
  const sentences = head.split(/(?<=\.)\s+/).filter(Boolean)
  const last = (sentences.at(-1) ?? head).replace(/\.$/, '')
  return last.charAt(0).toLowerCase() + last.slice(1)
}

function storedRecommendation(reasons: Array<string | undefined>): string {
  const clauses = reasons.map(recommendationClause).filter(Boolean)
  if (clauses.length === 0) return ''
  return `Stored recommendation${clauses.length === 1 ? '' : 's'}: ${clauses.join(', and ')}.`
}

// ---------------------------------------------------------------------------
// Loading the seeded rows
// ---------------------------------------------------------------------------

function loadFacts(db: DatabaseClient, project: DemoSeedProject): ProjectFacts {
  const rows = db.select().from(runs)
    .where(and(eq(runs.projectId, project.id), eq(runs.kind, 'answer-visibility'), eq(runs.status, 'completed')))
    .orderBy(asc(runs.createdAt), asc(runs.id))
    .all()
    .filter(run => run.trigger !== 'probe')
  const competitors = new Map<string, Competitor>()
  const properties = new Map<string, Property>()
  const sweeps = rows.map((run): Sweep => {
    const classes = new Map<string, { queryClass: QueryClass | null; targetKey: string | null }>()
    let planRevision: number | null = null
    if (run.measurementPlanVersionId) {
      const version = db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, run.measurementPlanVersionId)).get()
      if (!version) throw new Error(`Demo sweep ${run.id} names a missing plan revision`)
      const plan = parseStoredMeasurementPlanAnyVersion(version.canonicalJson)
      if (plan.schemaVersion !== 2) throw new Error(`Demo sweep ${run.id} is not measured by a portfolio plan`)
      planRevision = version.revision
      for (const assignment of plan.assignments) classes.set(assignment.queryId, { queryClass: assignment.queryClass, targetKey: assignment.targetKey })
      for (const group of plan.groups) {
        const market = group.label.replace(/\s+market$/i, '')
        for (const competitor of group.competitors) {
          if (competitor.domain) competitors.set(competitor.domain, { label: competitor.label, domain: competitor.domain })
        }
        for (const targetKey of group.targetKeys) {
          const target = plan.targets.find(candidate => candidate.stableKey === targetKey)
          if (target) {
            const pathPrefixes = target.urlMatchers.flatMap(matcher => matcher.kind === 'prefix' ? [matcher.pathPrefix] : [])
            properties.set(targetKey, { key: targetKey, label: target.label, market, pathPrefixes })
          }
        }
      }
    } else {
      const definition = db.select().from(simpleMeasurementDefinitions).where(eq(simpleMeasurementDefinitions.runId, run.id)).get()
      if (!definition) throw new Error(`Demo sweep ${run.id} has no frozen measurement definition`)
      for (const query of definition.definition.queries) {
        classes.set(query.queryId, { queryClass: query.queryClass === 'branded' || query.queryClass === 'non-brand' ? query.queryClass : null, targetKey: null })
      }
      for (const competitor of definition.definition.competitors ?? []) competitors.set(competitor.domain, { label: competitor.label, domain: competitor.domain })
    }
    const answers = db.select().from(querySnapshots).where(eq(querySnapshots.runId, run.id)).all().map((row): Answer => {
      const assigned = row.queryId ? classes.get(row.queryId) : undefined
      const citedUrls = row.citedUrls ?? []
      return {
        queryId: row.queryId ?? row.queryText ?? '',
        query: row.queryText ?? '',
        provider: row.provider,
        queryClass: assigned?.queryClass ?? null,
        targetKey: assigned?.targetKey ?? null,
        mentioned: row.answerMentioned === true,
        cited: row.citationState === 'cited',
        named: [...competitors.values()].filter(competitor => (row.answerText ?? '').includes(competitor.label)).map(competitor => competitor.label),
        competitorCited: [...competitors.values()]
          .filter(competitor => row.citedDomains.some(domain => domain === competitor.domain || domain.endsWith(`.${competitor.domain}`)))
          .map(competitor => competitor.label),
        citedDomains: row.citedDomains,
        ownCitedPaths: citedUrls.flatMap(url => {
          const parsed = new URL(url)
          return parsed.hostname === project.domain ? [parsed.pathname] : []
        }),
      }
    })
    const manifest = run.measurementManifest as { expectedSlots?: unknown[] } | null
    return {
      id: run.id,
      createdAt: run.createdAt,
      planRevision,
      executionChecksum: run.measurementExecutionIdentity?.checksum ?? null,
      expectedAnswers: Array.isArray(manifest?.expectedSlots) ? manifest.expectedSlots.length : null,
      answers,
    }
  })
  if (sweeps.length < 2) throw new Error(`Demo project ${project.name} needs two completed sweeps for the Aero preview`)
  return { project, sweeps, latest: sweeps.at(-1)!, previous: sweeps.at(-2)!, competitors: [...competitors.values()], properties }
}

// ---------------------------------------------------------------------------
// Shared readings
// ---------------------------------------------------------------------------

function enginesOf(sweep: Sweep): string[] {
  return unique(sweep.answers.map(answer => answer.provider)).sort(engineOrder)
}

function ofClass(sweep: Sweep, queryClass: QueryClass, provider?: string): Answer[] {
  return sweep.answers.filter(answer => answer.queryClass === queryClass && (provider === undefined || answer.provider === provider))
}

function queryIdsOf(answers: readonly Answer[]): string[] {
  return unique(answers.map(answer => answer.queryId))
}

function byQuery(answers: readonly Answer[]): Map<string, Answer[]> {
  const grouped = new Map<string, Answer[]>()
  for (const answer of answers) grouped.set(answer.queryId, [...(grouped.get(answer.queryId) ?? []), answer])
  return grouped
}

function series(facts: ProjectFacts, queryClass: QueryClass, key: 'mentioned' | 'cited', provider?: string): number[] {
  return facts.sweeps.map(sweep => tally(ofClass(sweep, queryClass, provider))[key])
}

function summary(answers: readonly Answer[]) {
  const counts = tally(answers)
  return {
    queryCount: queryIdsOf(answers).length,
    answerCount: counts.total,
    mentionCoverage: { numerator: counts.mentioned, denominator: counts.total },
    citationCoverage: { numerator: counts.cited, denominator: counts.total },
  }
}

function providerRollup(sweep: Sweep, queryClass: QueryClass) {
  return Object.fromEntries(enginesOf(sweep).map(provider => {
    const counts = tally(ofClass(sweep, queryClass, provider))
    return [provider, { mentioned: counts.mentioned, cited: counts.cited, answers: counts.total }]
  }))
}

/** Named-instead competitors across the answers that do not name the business, with how many engines name each. */
function namedInstead(answers: readonly Answer[]): Array<{ label: string; engines: string[] }> {
  const missing = answers.filter(answer => !answer.mentioned)
  return unique(missing.flatMap(answer => answer.named)).map(label => ({
    label,
    engines: unique(missing.filter(answer => answer.named.includes(label)).map(answer => answer.provider)).sort(engineOrder),
  }))
}

/** A dashboard link. The demo document is served at the root, so absolute paths resolve there. */
function link(label: string, path: string): string {
  return `[${label}](${path})`
}

// ---------------------------------------------------------------------------
// Standard business (summit-roofing)
// ---------------------------------------------------------------------------

function summitTopic(query: string): string | null {
  const key = SUMMIT_QUERIES.find(candidate => candidate.text === query)?.key
  return key ? SUMMIT_TOPICS[key] ?? null : null
}

function summitStatus(facts: ProjectFacts): AeroPreviewStarter {
  const { project, latest, sweeps } = facts
  const engines = enginesOf(latest)
  const queryCount = queryIdsOf(latest.answers).length
  const branded = ofClass(latest, 'branded')
  const nonBrand = ofClass(latest, 'non-brand')
  const brandedCounts = tally(branded)
  const nonBrandCounts = tally(nonBrand)
  const nonBrandQueries = queryIdsOf(nonBrand).length
  const perEngine = engines.map(provider => ({ provider, ...tally(ofClass(latest, 'non-brand', provider)) }))
  const unnamed = [...byQuery(nonBrand).values()].filter(answers => answers.every(answer => !answer.mentioned))
  const unnamedRivals = unique(unnamed.flatMap(answers => namedInstead(answers).map(entry => entry.label)))
  const allAnswered = engines.every(provider => latest.answers.filter(answer => answer.provider === provider).length === queryCount)
  const weakest = [...perEngine].sort((left, right) => left.mentioned - right.mentioned)
  const uniqueWeakest = weakest.length > 1 && weakest[0]!.mentioned < weakest[1]!.mentioned ? weakest[0]! : null
  const brandedMisses = branded.filter(answer => !answer.cited)
  const brandedUnnamed = branded.filter(answer => !answer.mentioned)

  const attention: string[] = []
  if (unnamed.length > 0) {
    const queries = listJoin(unnamed.map(answers => quoted(answers[0]!.query)), 'or')
    const rivals = unnamedRivals.length > 0 ? ` ${listJoin(unnamedRivals)} ${unnamedRivals.length === 1 ? 'is' : 'are'} named ${unnamed.length === 1 ? 'there' : `on ${unnamed.length === 2 ? 'both' : 'all of them'}`}.` : ''
    attention.push(`- No engine names ${project.displayName} on ${queries}.${rivals}`)
  }
  if (uniqueWeakest) attention.push(`- ${engineName(uniqueWeakest.provider)} is the weakest engine on non-brand, naming you on ${uniqueWeakest.mentioned} of ${uniqueWeakest.total}.`)
  if (brandedUnnamed.length === 0 && brandedMisses.length > 0) {
    attention.push(`- Branded mentions are complete. The ${brandedMisses.length === 1 ? 'one branded gap is a citation' : 'branded gaps are citations'}: ${listJoin(brandedMisses.map(answer => `${engineName(answer.provider)} does not cite your site on ${quoted(answer.query)}`))}.`)
  }

  const answer = [
    `**Latest sweep: ${formatPreviewDay(latest.createdAt)}, completed.** ${listJoin(engines.map(engineName))} ${allAnswered ? `all answered all ${queryCount} queries` : 'answered'}, ${latest.answers.length} answers in total. That makes ${sweeps.length} sweeps so far; the first ran on ${formatPreviewDay(sweeps[0]!.createdAt)}.`,
    [
      '| Queries | Mentioned | Cited |',
      '|---|---|---|',
      `| Branded (${queryIdsOf(branded).length}) | ${ratio(brandedCounts.mentioned, brandedCounts.total)} | ${ratio(brandedCounts.cited, brandedCounts.total)} |`,
      `| Non-brand (${nonBrandQueries}) | ${ratio(nonBrandCounts.mentioned, nonBrandCounts.total)} (${percent(nonBrandCounts.mentioned, nonBrandCounts.total)}) | ${ratio(nonBrandCounts.cited, nonBrandCounts.total)} (${percent(nonBrandCounts.cited, nonBrandCounts.total)}) |`,
    ].join('\n'),
    `Non-brand by engine, mentioned then cited: ${perEngine.map(entry => `${engineName(entry.provider)} ${ratio(entry.mentioned, entry.total)} and ${ratio(entry.cited, entry.total)}`).join(', ')}.`,
    ...(attention.length > 0 ? [`**Needs attention**\n${attention.join('\n')}`] : []),
    unnamed.length > 0
      ? `Next: open ${unnamed.length === 1 ? 'that query' : `those ${unnamed.length} queries`} and read the answers that name ${listJoin(unnamedRivals)}; that is the content your pages need to match. ${link('Open queries', `/projects/${project.name}/queries`)}`
      : `Next: keep the weekly sweep running and watch the weakest engine. ${link('Open queries', `/projects/${project.name}/queries`)}`,
  ].join('\n\n')

  return {
    id: 'status',
    steps: [
      step('canonry_project_overview', { project: project.name }, {
        latestRun: { run: { id: latest.id, kind: 'answer-visibility', status: 'completed', createdAt: latest.createdAt } },
        health: {
          runId: latest.id,
          totalPairs: latest.answers.length,
          mentionedPairs: tally(latest.answers).mentioned,
          citedPairs: tally(latest.answers).cited,
          providerBreakdown: Object.fromEntries(engines.map(provider => {
            const counts = tally(latest.answers.filter(item => item.provider === provider))
            return [provider, { mentioned: counts.mentioned, cited: counts.cited, total: counts.total }]
          })),
        },
      }, 820, 'Checking the latest sweep and which engines answered.'),
      step('canonry_visibility_report', { project: project.name, queryClass: 'all' }, {
        selection: { queryClass: 'all', run: { id: latest.id } },
        populations: [
          { queryClass: 'branded', summary: summary(branded) },
          {
            queryClass: 'non-brand',
            summary: summary(nonBrand),
            providerRollup: providerRollup(latest, 'non-brand'),
            unnamedQueries: unnamed.map(answers => ({ query: answers[0]!.query, namedInstead: namedInstead(answers).map(entry => entry.label) })),
          },
        ],
      }, 1140, 'The overview pools branded and non-brand, so reading the classes separately.'),
    ],
    answer,
  }
}

function summitChanges(facts: ProjectFacts): AeroPreviewStarter {
  const { project, latest, previous, sweeps } = facts
  const sameQueries = queryIdsOf(latest.answers).sort().join('\n') === queryIdsOf(previous.answers).sort().join('\n')
  const lines: string[] = []
  const reading = (queryClass: QueryClass, key: 'mentioned' | 'cited') => {
    const now = tally(ofClass(latest, queryClass))
    const before = tally(ofClass(previous, queryClass))
    return { now: now[key], before: before[key], total: now.total, beforeTotal: before.total }
  }
  const verdicts: boolean[] = []
  for (const [key, heading] of [['mentioned', 'Mentions'], ['cited', 'Citations']] as const) {
    const rows: string[] = []
    for (const [queryClass, label] of [['non-brand', 'Non-brand'], ['branded', 'Branded']] as const) {
      const value = reading(queryClass, key)
      if (value.total === 0) continue
      let line = `- ${label}: ${movement(value.now, value.before, value.total)}.`
      if (value.now !== value.before) {
        const within = withinNoise({ n: value.before, d: value.beforeTotal }, { n: value.now, d: value.total })
        verdicts.push(within)
        line += ` ${noisePhrase(within)}`
        const history = series(facts, queryClass, key)
        if (key === 'mentioned' && value.now === Math.max(...history) && history.slice(0, -1).every(item => item < value.now)) {
          line += ` It is the highest of the ${sweeps.length} sweeps (${history.join(', ')}).`
        }
      }
      rows.push(line)
    }
    lines.push(`**${heading}**\n${rows.join('\n')}`)
  }

  // Query-level flips, the way snapshots/diff aggregates across engines.
  const queryState = (sweep: Sweep) => new Map([...byQuery(sweep.answers)].map(([queryId, answers]) => [queryId, {
    query: answers[0]!.query,
    mentioned: answers.some(answer => answer.mentioned),
    cited: answers.some(answer => answer.cited),
  }]))
  const before = queryState(previous)
  const after = queryState(latest)
  const diff = [...after].flatMap(([queryId, state]) => {
    const prior = before.get(queryId)
    if (!prior || (prior.mentioned === state.mentioned && prior.cited === state.cited)) return []
    return [{
      query: state.query,
      run1MentionState: prior.mentioned ? 'mentioned' : 'not-mentioned',
      run2MentionState: state.mentioned ? 'mentioned' : 'not-mentioned',
      run1State: prior.cited ? 'cited' : 'not-cited',
      run2State: state.cited ? 'cited' : 'not-cited',
    }]
  })
  const gainedMention = diff.filter(row => row.run2MentionState === 'mentioned' && row.run1MentionState !== 'mentioned')
  const gainedCitation = diff.filter(row => row.run2State === 'cited' && row.run1State !== 'cited')
  const lost = diff.filter(row => (row.run1MentionState === 'mentioned' && row.run2MentionState !== 'mentioned') || (row.run1State === 'cited' && row.run2State !== 'cited'))
  const citationFirsts = gainedCitation.map(row => {
    const everCited = sweeps.slice(0, -1).some(sweep => sweep.answers.some(answer => answer.query === row.query && answer.cited))
    const citedBy = latest.answers.filter(answer => answer.query === row.query && answer.cited).map(answer => engineName(answer.provider))
    return `${quoted(row.query)} gained a citation${everCited ? '' : `, its first from any engine (${listJoin(citedBy)})`}`
  })
  const flipParts = [
    ...gainedMention.map(row => `${quoted(row.query)} gained a mention`),
    ...citationFirsts,
  ]
  const flips = flipParts.length > 0
    ? `At query level, ${listJoin(flipParts)}. ${lost.length === 0 ? 'No query lost either signal.' : `${listJoin(lost.map(row => quoted(row.query)))} lost a signal.`}`
    : 'No query changed state at query level.'

  // The engine whose non-brand mentions never dropped and gained the most.
  const climbs = enginesOf(latest).map(provider => ({
    provider,
    mentions: series(facts, 'non-brand', 'mentioned', provider),
    citations: series(facts, 'non-brand', 'cited', provider),
    total: tally(ofClass(latest, 'non-brand', provider)).total,
  })).filter(entry => entry.mentions.every((value, index) => index === 0 || value >= entry.mentions[index - 1]!) && entry.mentions.at(-1)! > entry.mentions[0]!)
    .sort((left, right) => (right.mentions.at(-1)! - right.mentions[0]!) - (left.mentions.at(-1)! - left.mentions[0]!))
  const climb = climbs.at(0)
  const allWithin = verdicts.every(Boolean)
  let trend = allWithin ? 'Nothing between these two sweeps is bigger than normal run-to-run noise.' : 'At least one change is bigger than normal run-to-run noise.'
  if (climb) {
    const firstToLast = withinNoise({ n: climb.mentions[0]!, d: climb.total }, { n: climb.mentions.at(-1)!, d: climb.total })
    trend += ` The direction worth watching is ${engineName(climb.provider)}: its non-brand mentions have not dropped in ${sweeps.length} sweeps (${climb.mentions.join(', ')} of ${climb.total}), and citations went from ${climb.citations[0]} to ${climb.citations.at(-1)} of ${climb.total}.`
    trend += firstToLast
      ? ` Even first to last is within noise at ${climb.total} answers a sweep, so treat it as a direction to confirm, not a win.`
      : ` First to last is bigger than noise at ${climb.total} answers a sweep.`
  }
  const nextParts = [
    ...(climb ? [`let the next sweep land before calling the ${engineName(climb.provider)} climb real`] : ['let the next sweep land before acting on any single move']),
    ...(gainedCitation[0] ? [`check that the new ${quoted(gainedCitation[0].query)} citation holds`] : []),
  ]

  const answer = [
    `**${formatPreviewDay(latest.createdAt)} vs ${formatPreviewDay(previous.createdAt)}${sameQueries ? `: the same ${queryIdsOf(latest.answers).length} queries on both sweeps` : ''}.**`,
    ...lines,
    flips,
    trend,
    `Next: ${nextParts.join(', and ')}. ${link('Open queries', `/projects/${project.name}/queries`)}`,
  ].join('\n\n')

  const populations = (['branded', 'non-brand'] as const).map(queryClass => {
    const now = summary(ofClass(latest, queryClass))
    const prior = tally(ofClass(previous, queryClass))
    return {
      queryClass,
      summary: now,
      comparison: {
        previousRun: { id: previous.id, createdAt: previous.createdAt },
        mentionCoverage: { previous: { numerator: prior.mentioned, denominator: prior.total } },
        citationCoverage: { previous: { numerator: prior.cited, denominator: prior.total } },
      },
      ...(queryClass === 'non-brand' ? { trend: { runs: sweeps.map(sweep => sweep.id), mentioned: series(facts, 'non-brand', 'mentioned'), cited: series(facts, 'non-brand', 'cited'), answers: tally(ofClass(latest, 'non-brand')).total } } : {}),
    }
  })
  const steps: AeroPreviewStep[] = [
    step('canonry_visibility_report', { project: project.name, queryClass: 'all' }, {
      selection: { queryClass: 'all', run: { id: latest.id } },
      populations,
    }, 1060, `Comparing the ${formatPreviewDay(latest.createdAt)} sweep with ${formatPreviewDay(previous.createdAt)}, branded and non-brand kept apart.`),
    step('canonry_snapshots_diff', { project: project.name, run1: previous.id, run2: latest.id }, { run1: previous.id, run2: latest.id, changed: diff }, 540, 'Checking which queries flipped.'),
  ]
  if (climb) {
    steps.push(step('canonry_visibility_report', { project: project.name, queryClass: 'non-brand', provider: climb.provider }, {
      selection: { queryClass: 'non-brand', provider: climb.provider, run: { id: latest.id } },
      trend: { mentioned: climb.mentions, cited: climb.citations, answers: climb.total },
    }, 910, `${engineName(climb.provider)} has moved the most, so reading its trend.`))
  }
  return { id: 'changes', steps, answer }
}

function summitGaps(facts: ProjectFacts): AeroPreviewStarter {
  const { project, latest } = facts
  const nonBrand = ofClass(latest, 'non-brand')
  const groups = [...byQuery(nonBrand).values()]
  const engines = enginesOf(latest)
  const unnamed = groups.filter(answers => answers.every(answer => !answer.mentioned))
  const partial = groups.filter(answers => answers.some(answer => answer.mentioned) && answers.some(answer => !answer.mentioned))
  const topicOf = (query: string) => summitTopic(query) ?? query
  const rivals = unique(unnamed.flatMap(answers => namedInstead(answers).map(entry => entry.label)))

  const rows = unnamed.map(answers => {
    const query = answers[0]!.query
    const instead = namedInstead(answers).map(entry => `${entry.label}, by ${entry.engines.length} of ${answers.length} engines`).join('; ') || 'no tracked competitor'
    const citedBy = answers.filter(answer => answer.cited).map(answer => engineName(answer.provider))
    return `| ${topicOf(query)} | ${query} | ${instead} | ${citedBy.length} of ${answers.length}${citedBy.length > 0 ? ` (${listJoin(citedBy)})` : ''} |`
  })
  const readButUnnamed = unnamed.flatMap(answers => answers.filter(answer => answer.cited && answer.ownCitedPaths.length > 0).map(answer =>
    `On ${quoted(answer.query)}, ${engineName(answer.provider)} cites ${answer.ownCitedPaths[0]} without naming ${project.displayName}, so the page is read but the brand does not come through.`))
  const partialLines = partial.map(answers => {
    const missing = answers.filter(answer => !answer.mentioned)
    const who = listJoin(missing.map(answer => engineName(answer.provider)))
    const instead = unique(missing.flatMap(answer => answer.named))
    const stillCited = missing.every(answer => answer.cited)
    return `- ${topicOf(answers[0]!.query)}, ${quoted(answers[0]!.query)}: ${who} ${instead.length > 0 ? `name${missing.length === 1 ? 's' : ''} ${listJoin(instead)} instead` : `do${missing.length === 1 ? 'es' : ''} not name you`}${stillCited ? `, though ${missing.length === 1 ? 'it still cites' : 'both still cite'} your site` : ''}.`
  })
  const pages = unique(unnamed.map(answers => {
    const cited = answers.find(answer => answer.ownCitedPaths.length > 0)?.ownCitedPaths[0]
    return cited ?? SUMMIT_QUERIES.find(candidate => candidate.text === answers[0]!.query)?.pages[0]
  }).filter((page): page is string => Boolean(page)))

  const answer = unnamed.length === 0
    ? `**Every non-brand query is named by at least one engine on ${formatPreviewDay(latest.createdAt)}.**\n\n${partialLines.join('\n')}\n\nNext: work the partial gaps above. ${link('Open queries', `/projects/${project.name}/queries`)}`
    : [
      `**${unnamed.length} of ${groups.length} non-brand queries are named by no engine on ${formatPreviewDay(latest.createdAt)}.** ${rivals.length === 1 ? `${rivals[0]} takes ${unnamed.length === 1 ? 'it' : unnamed.length === 2 ? 'both' : 'all of them'}.` : ''}`.trim(),
      ['| Topic | Query | Named instead | Your site cited |', '|---|---|---|---|', ...rows].join('\n'),
      ...readButUnnamed,
      ...(partialLines.length > 0 ? [`Partial gaps, where some engines name you and others do not:\n${partialLines.join('\n')}`] : []),
      `Next: make ${project.displayName} and the service explicit on ${listJoin(pages)}, then check ${unnamed.length === 1 ? 'the query' : unnamed.length === 2 ? 'both queries' : 'these queries'} on the next sweep. ${link('Open queries', `/projects/${project.name}/queries`)}`,
    ].join('\n\n')

  const queryRows = groups.map(answers => ({
    query: answers[0]!.query,
    mentionedBy: answers.filter(answer => answer.mentioned).map(answer => answer.provider).sort(engineOrder),
    citedBy: answers.filter(answer => answer.cited).map(answer => answer.provider).sort(engineOrder),
  }))
  const missingAnswers = nonBrand.filter(answer => !answer.mentioned).sort((left, right) => left.query.localeCompare(right.query) || engineOrder(left.provider, right.provider)).map(answer => ({
    query: answer.query,
    provider: answer.provider,
    answerMentioned: false,
    citationState: answer.cited ? 'cited' : 'not-cited',
    recommendedCompetitors: answer.named,
  }))
  return {
    id: 'gaps',
    steps: [
      step('canonry_visibility_report', { project: project.name, queryClass: 'non-brand' }, {
        selection: { queryClass: 'non-brand', run: { id: latest.id } },
        engines,
        queries: queryRows,
      }, 980, 'Reading the latest non-brand query rows.'),
      step('canonry_run_get', { runId: latest.id }, { id: latest.id, status: 'completed', snapshots: missingAnswers }, 690, 'Pulling the answers that leave you out to see who they name.'),
    ],
    answer,
  }
}

function summitInsights(db: DatabaseClient, facts: ProjectFacts): AeroPreviewStarter {
  const { project, latest, sweeps } = facts
  const active = db.select().from(insights).where(and(eq(insights.projectId, project.id), eq(insights.dismissed, false))).orderBy(desc(insights.createdAt), asc(insights.id)).all()
  const severe = active.filter(row => row.severity === 'high' || row.severity === 'critical')
  const fromLatest = active.filter(row => row.runId === latest.id)
  const medium = fromLatest.filter(row => row.severity === 'medium')
  const low = fromLatest.filter(row => row.severity === 'low')
  if (severe.length > 0) throw new Error('The Summit Aero preview assumes no high or critical insight; rewrite its insights turn')

  const gaps = medium.filter(row => row.type === 'persistent-gap')
  const gains = medium.filter(row => row.type === 'competitor-gained')
  const firsts = medium.filter(row => row.type === 'first-citation')
  const latestByQuery = byQuery(latest.answers.filter(answer => answer.queryClass !== null))
  const answersFor = (query: string) => [...latestByQuery.values()].find(answers => answers[0]!.query === query) ?? []
  const previousFor = (query: string) => facts.previous.answers.filter(answer => answer.query === query)
  const sharedSource = (answers: Answer[]) => {
    const own = project.domain
    const competitorDomains = new Set(facts.competitors.map(competitor => competitor.domain))
    const candidates = unique(answers.flatMap(answer => answer.citedDomains)).filter(domain => domain !== own && !competitorDomains.has(domain))
    return candidates.find(domain => answers.every(answer => answer.citedDomains.includes(domain))) ?? null
  }

  // Rank: gaps the business is not even named on first, then gaps with a competitor gain, then the rest.
  const ranked = [...gaps].sort((left, right) => {
    const score = (row: typeof gaps[number]) => {
      const answers = answersFor(row.query)
      return (answers.every(answer => !answer.mentioned) ? 0 : 2) + (gains.some(gain => gain.query === row.query) ? 0 : 1)
    }
    return score(left) - score(right)
  }).slice(0, 3)

  const items = ranked.map((row, index) => {
    const answers = answersFor(row.query)
    const mentionedBy = answers.filter(answer => answer.mentioned).map(answer => answer.provider).sort(engineOrder)
    const gain = gains.find(candidate => candidate.query === row.query)
    const parts: string[] = []
    if (mentionedBy.length === 0) {
      const instead = namedInstead(answers)
      const everMentioned = sweeps.some(sweep => sweep.answers.some(answer => answer.query === row.query && answer.mentioned))
      parts.push(`No engine names ${project.displayName} on it${everMentioned ? '' : ` in any of the ${sweeps.length} sweeps`}${instead.length > 0 ? `, and ${listJoin(instead.map(entry => entry.engines.length === answers.length ? `all ${answers.length} engines name ${entry.label}` : `${listJoin(entry.engines.map(engineName))} name${entry.engines.length === 1 ? 's' : ''} ${entry.label}`))}` : ''}.`)
    } else {
      const newly = mentionedBy.filter(provider => !previousFor(row.query).some(answer => answer.provider === provider && answer.mentioned))
      parts.push(newly.length === mentionedBy.length
        ? `${listJoin(mentionedBy.map(engineName))} started naming you on this sweep, but no engine cites you.`
        : `${listJoin(mentionedBy.map(engineName))} name${mentionedBy.length === 1 ? 's' : ''} you, but no engine cites you.`)
      const rivalsCited = unique(answers.flatMap(answer => answer.competitorCited))
      for (const rival of rivalsCited) {
        const citing = answers.filter(answer => answer.competitorCited.includes(rival)).map(answer => engineName(answer.provider))
        if (!gain) parts.push(`${listJoin(citing)} cite${citing.length === 1 ? 's' : ''} ${rival} instead.`)
      }
      const source = sharedSource(answers)
      if (source) parts.push(`Every answer cites ${source}, so check how that site covers you.`)
    }
    const stored = storedRecommendation([gain?.recommendation?.reason, row.recommendation?.reason])
    const pages = mentionedBy.length === 0 ? SUMMIT_QUERIES.find(candidate => candidate.text === row.query)?.pages ?? [] : []
    const title = gain
      ? `${quoted(row.query)}: uncited for ${row.title.match(/for (\d+) runs/)?.[1] ?? 'several'} runs, and ${facts.competitors.find(competitor => competitor.domain === gain.cause?.competitorDomain)?.label ?? gain.cause?.competitorDomain ?? 'a competitor'} just earned a citation there`
      : row.title
    return `${index + 1}. **${title}.** ${parts.join(' ')} ${stored}${pages.length > 0 ? ` Start with ${listJoin(pages)}.` : ''}`
  })
  const win = firsts.at(0)
  const winLine = win
    ? `The win: ${quoted(win.query)} got its first citation from any engine (${engineName(win.provider)}). ${storedRecommendation([win.recommendation?.reason])}`
    : null
  const firstUnnamed = ranked.find(row => answersFor(row.query).every(answer => !answer.mentioned))

  const answer = [
    `None of the ${active.length} active insights is high or critical, so I ranked the medium ones from the latest sweep. The ${formatPreviewDay(latest.createdAt)} sweep added ${fromLatest.length}, ${medium.length} medium and ${low.length} low, and the medium ones come down to ${items.length} issues${win ? ' plus one win' : ''}.`,
    items.join('\n'),
    ...(winLine ? [winLine] : []),
    `Next: ${firstUnnamed ? `start with the ${quoted(firstUnnamed.query)} audit, since it is the only one of the ${items.length} where no engine names you` : 'start with the first item'}. ${link('Open queries', `/projects/${project.name}/queries`)}`,
  ].join('\n\n')

  return {
    id: 'insights',
    steps: [
      step('canonry_insights_list', { project: project.name }, {
        active: active.length,
        highOrCritical: severe.length,
        latestSweep: { runId: latest.id, count: fromLatest.length, medium: medium.length, low: low.length },
        medium: medium.map(row => ({ id: row.id, type: row.type, title: row.title, provider: row.provider, recommendation: row.recommendation?.action ?? null, ...(row.cause?.cause ? { cause: row.cause.cause } : {}) })),
      }, 470, 'Listing active insights.'),
      step('canonry_run_get', { runId: latest.id }, {
        id: latest.id,
        status: 'completed',
        snapshots: ranked.flatMap(row => answersFor(row.query).sort((left, right) => engineOrder(left.provider, right.provider)).map(answer => ({
          query: answer.query,
          provider: answer.provider,
          answerMentioned: answer.mentioned,
          citationState: answer.cited ? 'cited' : 'not-cited',
          recommendedCompetitors: answer.named,
          citedDomains: answer.citedDomains,
        }))),
      }, 730, 'All medium, so checking the answers behind each one before ranking them.'),
    ],
    answer,
  }
}

// ---------------------------------------------------------------------------
// Portfolio (harbor-resorts)
// ---------------------------------------------------------------------------

function shortPropertyLabel(property: Property): string {
  const prefix = `Harbor ${property.market} `
  return property.label.startsWith(prefix) ? property.label.slice(prefix.length) : property.label
}

function markets(facts: ProjectFacts): string[] {
  return unique([...facts.properties.values()].map(property => property.market))
}

function marketOf(facts: ProjectFacts, answer: Answer): string | null {
  return answer.targetKey ? facts.properties.get(answer.targetKey)?.market ?? null : null
}

interface DeadLinks {
  state: string
  checked: number
  found: number
  sources: string[]
  targets: string[]
  statusCodes: number[]
  /** The last path segment every broken target shares, such as expired-summer-package. */
  sharedTarget: string | null
  /** True when each broken link sits on a different Property's offers page, one per Property. */
  onePerPropertyOffersPage: boolean
}

function loadDeadLinks(db: DatabaseClient, facts: ProjectFacts): DeadLinks | null {
  const { project } = facts
  const audit = db.select().from(runs).where(and(eq(runs.projectId, project.id), eq(runs.kind, 'site-audit'), eq(runs.status, 'completed'))).orderBy(desc(runs.createdAt), desc(runs.id)).get()
  if (!audit) return null
  const snapshot = db.select().from(siteCrawlSnapshots).where(and(eq(siteCrawlSnapshots.projectId, project.id), eq(siteCrawlSnapshots.runId, audit.id))).get()
  const findings = db.select().from(siteCrawlFindings)
    .where(and(eq(siteCrawlFindings.projectId, project.id), eq(siteCrawlFindings.runId, audit.id), eq(siteCrawlFindings.findingType, 'dead-link')))
    .orderBy(asc(siteCrawlFindings.findingKey))
    .all()
  if (!snapshot || findings.length === 0) return null
  const targets = findings.map(finding => finding.targetNodeKey ?? '')
  const sources = unique(findings.map(finding => finding.sourceNodeKey ?? ''))
  const tails = targets.map(target => target.split('/').filter(Boolean).at(-1) ?? '')
  const owners = sources.map(source => [...facts.properties.values()].find(property => property.pathPrefixes.some(prefix => source.startsWith(`${prefix}/`)))?.key)
  return {
    state: snapshot.deadLinkState,
    checked: snapshot.deadLinksChecked,
    found: snapshot.deadLinksFound,
    sources,
    targets,
    statusCodes: unique(findings.map(finding => Number((finding.evidence as { statusCode?: unknown }).statusCode)).filter(Number.isFinite)),
    sharedTarget: tails[0] && tails.every(tail => tail === tails[0]) ? tails[0] : null,
    onePerPropertyOffersPage: sources.length === findings.length
      && sources.length === facts.properties.size
      && sources.every(source => source.endsWith('/offers/'))
      && owners.every(Boolean)
      && unique(owners).length === owners.length,
  }
}

function deadLinkStep(project: DemoSeedProject, deadLinks: DeadLinks, text: string): AeroPreviewStep {
  return step('canonry_technical_aeo_dead_links', { project: project.name }, {
    state: deadLinks.state,
    checked: deadLinks.checked,
    found: deadLinks.found,
    deadLinks: deadLinks.targets.slice(0, 2).map((target, index) => ({ sourceNodeKey: deadLinks.sources[index], targetNodeKey: target, evidence: { statusCode: deadLinks.statusCodes[0] } })),
  }, 610, text)
}

/** "one on each Property's offers page, all pointing to an expired-summer-package page that returns 404" */
function deadLinkDetail(deadLinks: DeadLinks): string {
  const where = deadLinks.onePerPropertyOffersPage ? "one on each property's offers page" : `on ${deadLinks.sources.length} pages`
  const codes = deadLinks.statusCodes.join(' or ')
  const what = deadLinks.sharedTarget ? `all pointing to an ${deadLinks.sharedTarget} page that returns ${codes}` : `all returning ${codes}`
  return `${where}, ${what}`
}

function harborStatus(facts: ProjectFacts, deadLinks: DeadLinks | null): AeroPreviewStarter {
  const { project, latest } = facts
  const engines = enginesOf(latest)
  const branded = ofClass(latest, 'branded')
  const nonBrand = ofClass(latest, 'non-brand')
  const queryCount = queryIdsOf(latest.answers).length
  const allAnswered = engines.every(provider => latest.answers.filter(answer => answer.provider === provider).length === queryCount)
  const together = latest.answers.every(answer => answer.mentioned === answer.cited)
  const reached = (answers: Answer[]) => unique(answers.filter(answer => answer.mentioned).map(answer => answer.targetKey)).length
  const propertyCount = facts.properties.size
  const row = (label: string, answers: Answer[]) => {
    const counts = tally(answers)
    return `| ${label} (${queryIdsOf(answers).length}) | ${ratio(counts.mentioned, counts.total)} | ${ratio(counts.cited, counts.total)} | ${engines.map(provider => {
      const engine = tally(answers.filter(answer => answer.provider === provider))
      return ratio(engine.mentioned, engine.total)
    }).join(' | ')} |`
  }
  const dropped = engines.map(provider => ({ provider, answers: nonBrand.filter(answer => answer.provider === provider) }))
    .filter(entry => entry.answers.length > 0 && entry.answers.every(answer => !answer.mentioned))
  const attention = [
    ...dropped.map(entry => {
      const instead = namedInstead(entry.answers)
      const top = instead.sort((left, right) => right.engines.length - left.engines.length).at(0)
      const count = top ? entry.answers.filter(answer => answer.named.includes(top.label)).length : 0
      return `- ${engineName(entry.provider)} named Harbor on 0 of ${entry.answers.length} non-brand queries${top ? ` and named ${top.label} on ${count === entry.answers.length ? `all ${count}` : count} instead` : ''}.`
    }),
    ...(deadLinks ? [`- The site audit found ${deadLinks.found} dead links, ${deadLinkDetail(deadLinks)}.`] : []),
  ]
  const answer = [
    `**Latest sweep: ${formatPreviewDay(latest.createdAt)}, complete.** ${latest.expectedAnswers !== null ? `${latest.answers.length} of ${latest.expectedAnswers} expected answers came back: ` : ''}${listJoin(engines.map(engineName))} ${allAnswered ? `each answered all ${queryCount} queries` : 'answered'} for ${propertyCount} properties in ${listJoin(markets(facts))}.`,
    [
      `| Queries | Mentioned | Cited | ${engines.map(engineName).join(' | ')} |`,
      `|---|---|---|${engines.map(() => '---').join('|')}|`,
      row('Branded', branded),
      row('Non-brand', nonBrand),
    ].join('\n'),
    `Engine columns count mentions.${together ? ' In this sample every answer that names a property also cites it, so the two signals match.' : ''}${reached(branded) === propertyCount && reached(nonBrand) === propertyCount ? ` All ${propertyCount} properties were named in both classes.` : ''}`,
    ...(attention.length > 0 ? [`**Needs attention**\n${attention.join('\n')}`] : []),
    `Next: ${[
      ...(dropped[0] ? [`read ${engineName(dropped[0].provider)}'s non-brand answers in one market`] : []),
      ...(deadLinks ? [`remove or redirect the broken link on all ${deadLinks.sources.length} ${deadLinks.onePerPropertyOffersPage ? 'offers pages' : 'pages'}`] : []),
    ].join(', and ') || 'keep the weekly sweep running'}. ${link('Open portfolio', `/projects/${project.name}/portfolio`)}`,
  ].join('\n\n')

  const steps: AeroPreviewStep[] = [
    step('canonry_measurement_data_quality', { project: project.name, runId: latest.id }, {
      run: { state: 'complete', displayedRunId: latest.id, planRevision: latest.planRevision, completedAt: latest.createdAt },
      completeness: { expected: latest.expectedAnswers, answered: latest.answers.length, missing: Math.max(0, (latest.expectedAnswers ?? latest.answers.length) - latest.answers.length) },
      comparison: { previousDisplayedRunId: facts.previous.id },
    }, 520, 'Checking that the latest sweep is complete before reading it.'),
    step('canonry_visibility_report', { project: project.name, queryClass: 'all' }, {
      selection: { queryClass: 'all', run: { id: latest.id } },
      populations: (['branded', 'non-brand'] as const).map(queryClass => ({
        queryClass,
        summary: { ...summary(ofClass(latest, queryClass)), propertyReach: { numerator: reached(ofClass(latest, queryClass)), denominator: propertyCount } },
        providerRollup: providerRollup(latest, queryClass),
      })),
    }, 1210, 'Reading branded and non-brand separately, with the engine split.'),
  ]
  if (deadLinks) steps.push(deadLinkStep(project, deadLinks, 'Checking the latest site audit for anything broken.'))
  return { id: 'status', steps, answer }
}

function harborChanges(facts: ProjectFacts): AeroPreviewStarter {
  const { project, latest, previous, sweeps } = facts
  const engines = enginesOf(latest)
  const together = [latest, previous].every(sweep => sweep.answers.every(answer => answer.mentioned === answer.cited))
  const sameIdentity = latest.planRevision === previous.planRevision && latest.executionChecksum !== null && latest.executionChecksum === previous.executionChecksum
  const propertyMentions = (sweep: Sweep, queryClass: QueryClass) => {
    const counts = new Map<string, number>()
    for (const answer of ofClass(sweep, queryClass)) if (answer.targetKey && answer.mentioned) counts.set(answer.targetKey, (counts.get(answer.targetKey) ?? 0) + 1)
    return counts
  }
  const changedProperties = (queryClass: QueryClass) => {
    const now = propertyMentions(latest, queryClass)
    const before = propertyMentions(previous, queryClass)
    return [...facts.properties.values()].filter(property => (now.get(property.key) ?? 0) !== (before.get(property.key) ?? 0)).map(property => ({
      targetKey: property.key,
      label: property.label,
      previous: before.get(property.key) ?? 0,
      current: now.get(property.key) ?? 0,
      engines: engines.length,
    }))
  }
  let usualMoves = 0
  const beyondDetail = new Map<string, { provider: string; queryClass: QueryClass; history: number[]; previousLow: number; previousHigh: number; total: number }>()
  const classLines = (['non-brand', 'branded'] as const).map(queryClass => {
    const now = tally(ofClass(latest, queryClass))
    const before = tally(ofClass(previous, queryClass))
    const label = queryClass === 'branded' ? 'Branded' : 'Non-brand'
    const perEngine = engines.map(provider => ({
      provider,
      history: series(facts, queryClass, 'mentioned', provider),
      total: tally(ofClass(latest, queryClass, provider)).total,
    }))
    const moves = perEngine.filter(entry => entry.history.at(-1) !== entry.history.at(-2))
    for (const entry of moves) {
      const prior = entry.history.slice(0, -1)
      const value = entry.history.at(-1)!
      const outside = value < Math.min(...prior) || value > Math.max(...prior)
      if (!outside) usualMoves += 1
      else beyondDetail.set(`${entry.provider}:${queryClass}`, { provider: entry.provider, queryClass, history: entry.history, previousLow: Math.min(...prior), previousHigh: Math.max(...prior), total: entry.total })
    }
    const engineMoves = moves.map(entry => `${engineName(entry.provider)} ${entry.history.at(-1)! < entry.history.at(-2)! ? 'fell' : 'rose'} from ${ratio(entry.history.at(-2)!, entry.total)} to ${ratio(entry.history.at(-1)!, entry.total)}`)
    const changed = changedProperties(queryClass)
    const totals = series(facts, queryClass, 'mentioned')
    const alternates = totals.length >= 4 && totals.every((value, index) => index < 2 || value === totals[index - 2]) && totals[0] !== totals[1]
    let line = `**${label}:** `
    if (now.mentioned === before.mentioned) {
      line += `${ratio(now.mentioned, now.total)} on both sweeps`
      line += engineMoves.length > 0 ? `, but the engine mix changed. ${engineMoves.join('; ')}.` : '.'
    } else {
      line += `${movement(now.mentioned, before.mentioned, now.total)}. ${noisePhrase(withinNoise({ n: before.mentioned, d: before.total }, { n: now.mentioned, d: now.total }))}`
      if (alternates) line += ` The ${label.toLowerCase()} total has alternated every sweep: ${totals.join(', ')}.`
      if (engineMoves.length > 0) line += ` ${engineMoves.join('; ')}.`
    }
    if (changed.length === 0) {
      line += ' No property changed.'
    } else {
      const uniform = changed.every(property => property.previous === changed[0]!.previous && property.current === changed[0]!.current)
      // When the same Properties move in every market, name them once.
      const marketList = markets(facts)
      const perMarket = marketList.map(market => changed.filter(property => facts.properties.get(property.targetKey)?.market === market).map(property => shortPropertyLabel(facts.properties.get(property.targetKey)!)).sort().join('|'))
      const who = perMarket.every(value => value !== '' && value === perMarket[0])
        ? `the ${listJoin(perMarket[0]!.split('|'))} in each of the ${marketList.length} markets`
        : listJoin(changed.map(property => property.label))
      line += uniform
        ? ` ${changed.length} ${changed.length === 1 ? 'property' : 'properties'} went from ${changed[0]!.previous} of ${engines.length} engines to ${changed[0]!.current} of ${engines.length}: ${who}.`
        : ` ${changed.length} ${changed.length === 1 ? 'property' : 'properties'} changed: ${who}.`
    }
    return line
  })
  const detail = [...beyondDetail.values()]
  let noise = ''
  if (detail.length > 0) {
    noise = `**Bigger than the usual swing:** only ${listJoin(detail.map(entry => `${engineName(entry.provider)} on ${entry.queryClass}`))}. ${detail.map(entry => `Its series over ${sweeps.length} sweeps is ${entry.history.join(', ')}, so ${entry.history.at(-1)} is ${entry.history.at(-1)! < entry.previousLow ? `below its previous low of ${entry.previousLow}` : `above its previous high of ${entry.previousHigh}`}`).join('. ')}.`
    if (usualMoves > 0) noise += ` Every other engine move stays inside the range that engine has swung through over ${sweeps.length} sweeps, so it is the usual swing, even though a Wilson interval at ${detail[0]!.total} answers would flag it.`
  } else {
    noise = 'Every engine stayed inside the range it has swung through before, so nothing here is bigger than the usual swing.'
  }
  const worst = detail.at(0)
  const worstCompetitor = worst ? namedInstead(ofClass(latest, worst.queryClass, worst.provider))[0]?.label : undefined
  const answer = [
    `**${formatPreviewDay(latest.createdAt)} vs ${formatPreviewDay(previous.createdAt)}${sameIdentity ? `: same plan revision (${latest.planRevision}) and the same engines and models on both sweeps` : ''}.**${together ? ' In this sample every answer that names a property also cites it, so the citation numbers match the mention numbers below.' : ''}`,
    ...classLines,
    noise,
    `Next: ${worst ? `confirm ${engineName(worst.provider)} ${worst.queryClass} on the next sweep before changing pages${worstCompetitor ? `; if it stays at ${worst.history.at(-1)}, compare the ${worstCompetitor} pages it cites with your market pages` : ''}` : 'keep the weekly sweep running'}. ${link('Open portfolio', `/projects/${project.name}/portfolio`)}`,
  ].join('\n\n')

  const changesResult = (queryClass: QueryClass) => {
    const now = tally(ofClass(latest, queryClass))
    const before = tally(ofClass(previous, queryClass))
    return {
      current: { displayedRunId: latest.id, planRevision: latest.planRevision },
      comparison: {
        previous: { displayedRunId: previous.id, planRevision: previous.planRevision },
        sameExecutionIdentity: sameIdentity,
        metrics: {
          mentionCoverage: { previous: { numerator: before.mentioned, denominator: before.total }, current: { numerator: now.mentioned, denominator: now.total } },
          citationCoverage: { previous: { numerator: before.cited, denominator: before.total }, current: { numerator: now.cited, denominator: now.total } },
        },
        changedProperties: changedProperties(queryClass).map(property => ({ label: property.label, mentioned: { previous: `${property.previous}/${property.engines}`, current: `${property.current}/${property.engines}` } })),
      },
    }
  }
  return {
    id: 'changes',
    steps: [
      step('canonry_measurement_changes', { project: project.name, queryClass: 'non-brand' }, changesResult('non-brand'), 780, `Comparing ${formatPreviewDay(latest.createdAt)} with ${formatPreviewDay(previous.createdAt)}, non-brand first.`),
      step('canonry_measurement_changes', { project: project.name, queryClass: 'branded' }, changesResult('branded'), 690),
      step('canonry_visibility_report', { project: project.name, queryClass: 'all' }, {
        selection: { queryClass: 'all' },
        trend: Object.fromEntries((['branded', 'non-brand'] as const).map(queryClass => [queryClass, {
          runs: sweeps.map(sweep => sweep.id),
          mentioned: series(facts, queryClass, 'mentioned'),
          byProvider: Object.fromEntries(engines.map(provider => [provider, series(facts, queryClass, 'mentioned', provider)])),
        }])),
      }, 1180, `Totals hide engine swings here, so reading each engine across all ${sweeps.length} sweeps.`),
    ],
    answer,
  }
}

function harborGaps(facts: ProjectFacts): AeroPreviewStarter {
  const { project, latest } = facts
  const engines = enginesOf(latest)
  const groups = [...byQuery(latest.answers).values()]
  const unnamed = groups.filter(answers => answers.every(answer => !answer.mentioned))
  const namedCounts = groups.map(answers => answers.filter(answer => answer.mentioned).length)
  const uniformCount = namedCounts.every(count => count === namedCounts[0]) ? namedCounts[0]! : null
  const cell = (market: string, queryClass: QueryClass) => {
    const answers = ofClass(latest, queryClass).filter(answer => marketOf(facts, answer) === market)
    const queries = queryIdsOf(answers).length
    const missing = answers.filter(answer => !answer.mentioned)
    const byEngine = engines.map(provider => ({ provider, answers: missing.filter(answer => answer.provider === provider) })).filter(entry => entry.answers.length > 0)
    const rivals = unique(missing.flatMap(answer => answer.named))
    if (missing.length === 0) return 'none'
    const rivalText = rivals.length > 0 ? listJoin(rivals) : 'no tracked competitor'
    if (byEngine.length === 1) return `${engineName(byEngine[0]!.provider)}: ${rivalText} on ${byEngine[0]!.answers.length === queries ? `all ${queries}` : `${byEngine[0]!.answers.length} of ${queries}`}`
    return `${listJoin(byEngine.map(entry => engineName(entry.provider)))}: ${rivalText} on ${byEngine.map(entry => entry.answers.length).every(count => count === byEngine[0]!.answers.length) ? `${byEngine[0]!.answers.length} each` : byEngine.map(entry => `${entry.answers.length} (${engineName(entry.provider)})`).join(', ')}`
  }
  const marketList = markets(facts)
  const rows = marketList.map(market => `| ${market} | ${cell(market, 'non-brand')} | ${cell(market, 'branded')} |`)
  const topics = unique(ofClass(latest, 'non-brand').map(answer => answer.query.match(/\bfor (.+)$/)?.[1]).filter((topic): topic is string => Boolean(topic)))
  const nonBrandMissing = ofClass(latest, 'non-brand').filter(answer => !answer.mentioned)
  const nonBrandEngines = unique(nonBrandMissing.map(answer => answer.provider))
  const nonBrandRivals = unique(nonBrandMissing.flatMap(answer => answer.named))
  const brandedMissing = ofClass(latest, 'branded').filter(answer => !answer.mentioned)
  // Which properties each engine leaves out on branded queries, when it is the same in every market.
  const brandedPattern = unique(brandedMissing.map(answer => answer.provider)).sort(engineOrder).map(provider => {
    const perMarket = marketList.map(market => brandedMissing
      .filter(answer => answer.provider === provider && marketOf(facts, answer) === market && answer.targetKey)
      .map(answer => shortPropertyLabel(facts.properties.get(answer.targetKey!)!))
      .sort()
      .join('|'))
    return perMarket.every(value => value === perMarket[0]) && perMarket[0] ? `by ${engineName(provider)} on ${listJoin(perMarket[0].split('|'))}` : null
  })
  const brandedRivals = unique(brandedMissing.flatMap(answer => answer.named))
  const sentences: string[] = []
  if (nonBrandMissing.length > 0 && nonBrandEngines.length === 1 && topics.length > 0) {
    sentences.push(`Non-brand covers ${listJoin(topics)} in each market. ${engineName(nonBrandEngines[0]!)} names ${listJoin(nonBrandRivals)} instead of Harbor on all of them, ${nonBrandMissing.length} in total.`)
  }
  if (brandedMissing.length > 0 && brandedPattern.every(Boolean)) {
    sentences.push(`On branded "reviews" queries, ${listJoin(brandedRivals)} ${brandedRivals.length === 1 ? 'is' : 'are'} named instead ${(brandedPattern as string[]).join(', and ')}, in every market: ${brandedMissing.length} in total.`)
  }
  const answer = [
    unnamed.length === 0
      ? `**No tracked query goes unnamed by every engine on ${formatPreviewDay(latest.createdAt)}.**${uniformCount !== null ? ` All ${groups.length} are named by ${uniformCount} of ${engines.length} engines.` : ''} The misses repeat the same way in every market:`
      : `**${unnamed.length} of ${groups.length} tracked queries are named by no engine on ${formatPreviewDay(latest.createdAt)}.** By market:`,
    ['| Market | Non-brand, named instead | Branded "reviews", named instead |', '|---|---|---|', ...rows].join('\n'),
    ...sentences,
    `Next: start with ${nonBrandEngines.length === 1 ? `${engineName(nonBrandEngines[0]!)} non-brand, since it covers every market; read one answer per market to see what ${listJoin(nonBrandRivals)} ${nonBrandRivals.length === 1 ? 'is' : 'are'} recommended for` : 'the non-brand misses'}. ${link('Open portfolio', `/projects/${project.name}/portfolio`)}`,
  ].join('\n\n')

  const missing = latest.answers.filter(answer => !answer.mentioned)
  const rollup = unique(missing.map(answer => `${answer.provider}\u0000${answer.queryClass}\u0000${answer.named.join(',')}`)).map(key => {
    const [provider, queryClass, named] = key.split('\u0000')
    const matching = missing.filter(answer => answer.provider === provider && answer.queryClass === queryClass && answer.named.join(',') === named)
    return { provider, queryClass, namedInstead: named ? named.split(',') : [], answers: matching.length, markets: unique(matching.map(answer => marketOf(facts, answer))).length }
  }).sort((left, right) => engineOrder(left.provider!, right.provider!))
  return {
    id: 'gaps',
    steps: [
      step('canonry_visibility_report', { project: project.name, queryClass: 'all' }, {
        selection: { queryClass: 'all', run: { id: latest.id } },
        queries: { total: groups.length, namedByNoEngine: unnamed.length, namedByEngines: uniformCount !== null ? { [`${uniformCount}/${engines.length}`]: groups.length } : namedCounts },
      }, 1020, 'Looking for queries no engine names Harbor on.'),
      step('canonry_run_get', { runId: latest.id }, { id: latest.id, status: 'completed', answersWithoutHarbor: missing.length, byEngine: rollup }, 760, 'None, so reading who gets named on the answers that leave Harbor out.'),
    ],
    answer,
  }
}

function harborInsights(db: DatabaseClient, facts: ProjectFacts, deadLinks: DeadLinks | null): AeroPreviewStarter {
  const { project, latest, sweeps } = facts
  const active = db.select().from(insights).where(and(eq(insights.projectId, project.id), eq(insights.dismissed, false))).all()
  const sweepIds = new Set(sweeps.map(sweep => sweep.id))
  const fromSweeps = active.filter(row => row.runId !== null && sweepIds.has(row.runId))
  const engines = enginesOf(latest)
  const perEngine = engines.map(provider => ({ provider, history: series(facts, 'non-brand', 'mentioned', provider), total: tally(ofClass(latest, 'non-brand', provider)).total }))
  const dropped = perEngine.find(entry => entry.history.at(-1) === 0)
  const droppedRival = dropped ? namedInstead(ofClass(latest, 'non-brand', dropped.provider))[0]?.label : undefined
  const others = perEngine.filter(entry => entry !== dropped)
  const othersSwing = others.filter(entry => Math.min(...entry.history) !== Math.max(...entry.history))
  const totals = series(facts, 'non-brand', 'mentioned')
  const totalDenominator = tally(ofClass(latest, 'non-brand')).total
  const findings: string[] = []
  if (dropped) {
    const prior = dropped.history.slice(0, -1)
    findings.push(`**${engineName(dropped.provider)} stopped naming Harbor on non-brand.** It named Harbor on 0 of ${dropped.total} non-brand queries on ${formatPreviewDay(latest.createdAt)}${droppedRival ? ` and named ${droppedRival} on all ${dropped.total}` : ''}. Its previous low in ${sweeps.length} sweeps was ${Math.min(...prior)} of ${dropped.total}. Action: confirm on the next sweep, then compare the ${droppedRival ?? 'competitor'} pages it cites with your market pages.`)
    findings.push(`**The engines swing every sweep.** ${engineName(dropped.provider)}'s non-brand series is ${dropped.history.join(', ')}${othersSwing.length > 0 ? `, and ${listJoin(othersSwing.map(entry => engineName(entry.provider)))} move between ${Math.min(...othersSwing.flatMap(entry => entry.history))} and ${Math.max(...othersSwing.flatMap(entry => entry.history))} of ${othersSwing[0]!.total}` : ''}. Action: judge each week on the ${engines.length}-engine total, ${totals.at(-1) === totals.at(-2) ? `${totals.at(-1)} of ${totalDenominator} on both of the last two sweeps` : `${totals.at(-1)} of ${totalDenominator} now against ${totals.at(-2)} before`}, not on one engine's week.`)
  }
  if (deadLinks) {
    const detail = deadLinkDetail(deadLinks)
    findings.push(`**${deadLinks.found} dead links from the site audit.** There is ${detail}. Action: remove or redirect that link on all ${deadLinks.sources.length} pages. ${link('Open Site Health', `/projects/${project.name}/technical-aeo`)}`)
  }
  const answer = [
    `Only ${active.length} ${active.length === 1 ? 'insight is' : 'insights are'} stored for ${project.displayName}${fromSweeps.length === 0 ? `, and ${active.length === 2 ? 'neither' : 'none'} comes from a sweep` : ''}, so there is no severity ranking worth walking through. These are the ${findings.length} most important measured findings instead:`,
    findings.map((finding, index) => `${index + 1}. ${finding}`).join('\n'),
    `Next: ${deadLinks ? 'fix the dead links now, since they need no sweep to confirm, and ' : ''}${dropped ? `recheck ${engineName(dropped.provider)} non-brand after the next sweep` : 'keep the weekly sweep running'}.`,
  ].join('\n\n')

  const steps: AeroPreviewStep[] = [
    step('canonry_insights_list', { project: project.name }, { active: active.length, fromSweeps: fromSweeps.length, fromLatestSweep: fromSweeps.filter(row => row.runId === latest.id).length }, 430, 'Listing active insights.'),
    step('canonry_visibility_report', { project: project.name, queryClass: 'non-brand' }, {
      selection: { queryClass: 'non-brand', run: { id: latest.id } },
      summary: summary(ofClass(latest, 'non-brand')),
      trend: { runs: sweeps.map(sweep => sweep.id), byProvider: Object.fromEntries(perEngine.map(entry => [entry.provider, entry.history])) },
      ...(dropped && droppedRival ? { namedInstead: { [dropped.provider]: { [droppedRival]: ofClass(latest, 'non-brand', dropped.provider).filter(answer => answer.named.includes(droppedRival)).length } } } : {}),
    }, 1090, 'Too few stored insights to rank, so reading the measured non-brand picture instead.'),
  ]
  if (deadLinks) steps.push(deadLinkStep(project, deadLinks, 'And the latest site audit.'))
  return { id: 'insights', steps, answer }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * One scripted turn per dashboard starter for each sample project, keyed by
 * project name. Reads only the seeded database; throws when the seed no longer
 * has the shape a turn describes, so the demo fails to start instead of
 * showing numbers the dashboard contradicts.
 */
export function buildDemoAeroPreviews(db: DatabaseClient, context: DemoSeedContext): Map<string, AeroPreviewResponse> {
  const seededAt = context.now.toISOString()
  const previews = new Map<string, AeroPreviewResponse>()

  const summit = loadFacts(db, context.simple)
  previews.set(context.simple.name, aeroPreviewResponseSchema.parse({
    project: context.simple.name,
    seededAt,
    starters: [summitStatus(summit), summitChanges(summit), summitGaps(summit), summitInsights(db, summit)],
  }))

  const harbor = loadFacts(db, context.portfolio)
  const deadLinks = loadDeadLinks(db, harbor)
  previews.set(context.portfolio.name, aeroPreviewResponseSchema.parse({
    project: context.portfolio.name,
    seededAt,
    starters: [harborStatus(harbor, deadLinks), harborChanges(harbor), harborGaps(harbor), harborInsights(db, harbor, deadLinks)],
  }))
  return previews
}
