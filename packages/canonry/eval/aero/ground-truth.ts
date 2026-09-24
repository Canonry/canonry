/**
 * Ground truth for the Aero eval: compact facts computed from the project's own
 * stored data, through the same HTTP reads Aero's tools make, so the grader can
 * check an answer against what the data says rather than against a model's
 * guess.
 *
 * Every read is a GET against the served database COPY the runner points
 * `baseUrl` at, never a live instance. Nothing here starts a sweep, probe,
 * sync, fill or any other provider work, and request headers (the API key) are
 * never logged, echoed into facts, or included in an error message.
 *
 * Facts stay under MAX_FACTS_CHARS: every list is cut to its top N with the
 * total beside it, and fitFacts() halves any list still over budget and records
 * what it cut in `_trimmed`.
 *
 * A question names its builder in `truth`. A builder may take one argument
 * after a colon: `property-drilldown:<targetKey or label>` drills into that
 * Property instead of the weakest one.
 */
import type {
  CompetitorLandscapeResponse,
  CompetitorLandscapeRow,
  MeasurementAnswerEvidence,
  MeasurementChangesResponse,
  MeasurementDataQualityResponse,
  MeasurementMetricDelta,
  MeasurementOverviewResponse,
  MeasurementPortfolioMarket,
  MeasurementPortfolioSummaryResponse,
  MeasurementPortfolioWeakestProperty,
  MeasurementPropertyCompetitorsResponse,
  MeasurementPropertyEvidenceResponse,
  MeasurementPropertyQuestionRow,
  MeasurementPropertyQuestionsResponse,
  MeasurementPropertyRow,
  MetricValue,
  ProjectOverviewDto,
  RankedSourceList,
  RunCompletenessDto,
  RunDto,
  SourceBreakdownDto,
  VisibilityReportQueryRow,
  VisibilityReportRate,
  VisibilityReportRateChange,
  VisibilityReportResponse,
} from '@ainyc/canonry-contracts'
import type { GroundTruth, ProjectKind } from './types.js'

/** Upper bound on the serialized facts the grader sees. */
export const MAX_FACTS_CHARS = 12_000

/** What a builder needs: where the served copy is, how to authenticate, and which project. */
export interface GroundTruthContext {
  /** Origin of the served database copy, e.g. http://127.0.0.1:4791. A trailing /api/v1 is accepted. */
  baseUrl: string
  /** Request headers, including authorization. Never logged, stored in facts, or put in an error. */
  headers: Record<string, string>
  project: string
  kind: ProjectKind
  /** Fetch override for tests. Defaults to the global fetch, looked up at call time. */
  fetch?: typeof fetch
}

const DENOMINATORS = 'Denominators count answers: one per query per engine (and per location), so 8 queries on 3 engines is 24 answers.'
const NAMED_INSTEAD = 'Names written in the answer text of answers that neither named nor cited the Property, counted by answer. They are mentions in the text, not citations.'
const MARKETS_NOTE = 'Markets can share Properties, so market Property counts and numerators never add up to the portfolio totals.'
const SOURCES_COUNTING = 'Each count is the number of answers whose stored sources cite the domain, at most once per answer; the share is of every answer in scope, including answers that cited nothing.'
const QUESTION_LEGEND = 'M+ the answer text names the Property, M- it does not, M? not checked; C+ a source links the Property\'s own page, C- it does not, C? source capture incomplete; "no answer" means the slot was never answered.'
const MAX_METRO_READS = 40
/** Pages of 100 query-engine rows read from the visibility report. */
const MAX_REPORT_PAGES = 25

// ── HTTP ──────────────────────────────────────────────────────────────────

type QueryValue = string | number | boolean | undefined
type QueryParams = Record<string, QueryValue>

/** A read the served copy refused. The message names the path, never the headers. */
export class GroundTruthReadError extends Error {
  constructor(readonly path: string, readonly status: number, detail: string) {
    super(`GET ${path} failed: HTTP ${status}${detail ? ` ${detail}` : ''}`)
    this.name = 'GroundTruthReadError'
  }
}

/** Removes anything shaped like a credential from text that may reach a report. */
function redact(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:cnry|cek|sk|pk)[-_][\w-]{6,}/g, '[redacted]')
}

function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown }; message?: unknown }
    const message = parsed.error?.message ?? parsed.message
    const code = parsed.error?.code
    if (typeof message === 'string') return redact(`${typeof code === 'string' ? `${code}: ` : ''}${message}`).slice(0, 300)
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return redact(body).slice(0, 300)
}

function apiRoot(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '')}/api/v1`
}

/** Reads made for one context are shared, so several builders on one project read each URL once. */
const readCache = new WeakMap<GroundTruthContext, Map<string, Promise<unknown>>>()

async function getJson<T>(ctx: GroundTruthContext, path: string, query: QueryParams = {}): Promise<T> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const search = params.toString()
  const relative = search ? `${path}?${search}` : path
  const reads = readCache.get(ctx) ?? new Map<string, Promise<unknown>>()
  readCache.set(ctx, reads)
  const cached = reads.get(relative)
  if (cached) return cached as Promise<T>
  const pending = (async () => {
    const doFetch = ctx.fetch ?? globalThis.fetch
    const response = await doFetch(`${apiRoot(ctx.baseUrl)}${relative}`, {
      method: 'GET',
      headers: { accept: 'application/json', ...ctx.headers },
    })
    const body = await response.text()
    if (!response.ok) throw new GroundTruthReadError(relative, response.status, errorDetail(body))
    try {
      return JSON.parse(body) as T
    } catch {
      throw new GroundTruthReadError(relative, response.status, 'response was not JSON')
    }
  })()
  reads.set(relative, pending)
  // A failed read is not cached, so a retry reads again.
  pending.catch(() => reads.delete(relative))
  return pending
}

type Soft<T> = { ok: true; value: T } | { ok: false; error: string }

/** A secondary read: its failure is recorded in the facts instead of failing the builder. */
async function soft<T>(promise: Promise<T>): Promise<Soft<T>> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error: redact(error instanceof Error ? error.message : String(error)) }
  }
}

function failed(read: { ok: false; error: string }): string {
  return `read failed: ${read.error}`
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

// ── Reads (the same routes Aero's tools call) ───────────────────────────────

const projectPath = (ctx: GroundTruthContext) => `/projects/${encodeURIComponent(ctx.project)}`

/** Truth reads the whole ranking: limit 50 and every market level, where Aero keeps the default. */
function readPortfolio(ctx: GroundTruthContext): Promise<MeasurementPortfolioSummaryResponse> {
  return getJson(ctx, `${projectPath(ctx)}/measurement-portfolio-summary`, {
    queryClass: 'non-brand',
    limit: 50,
    includeNestedMarkets: true,
  })
}

interface OverviewRows {
  first: MeasurementOverviewResponse
  rows: MeasurementPropertyRow[]
  complete: boolean
}

async function readOverviewRows(ctx: GroundTruthContext, query: QueryParams, maxPages = 10): Promise<OverviewRows> {
  let cursor: string | undefined
  let first: MeasurementOverviewResponse | undefined
  const rows: MeasurementPropertyRow[] = []
  for (let page = 0; page < maxPages; page++) {
    const response = await getJson<MeasurementOverviewResponse>(ctx, `${projectPath(ctx)}/measurement-overview`, {
      scope: 'all',
      sort: 'mentionCoverage-asc',
      limit: 100,
      ...query,
      cursor,
    })
    first ??= response
    rows.push(...response.properties.items)
    cursor = response.properties.nextCursor ?? undefined
    if (!cursor) break
  }
  if (!first) throw new Error('measurement-overview returned no page')
  return { first, rows, complete: cursor === undefined }
}

function readChanges(ctx: GroundTruthContext, queryClass: 'branded' | 'non-brand'): Promise<MeasurementChangesResponse> {
  return getJson(ctx, `${projectPath(ctx)}/measurement-changes`, { scope: 'all', queryClass, limit: 50 })
}

function readSources(ctx: GroundTruthContext, query: QueryParams): Promise<SourceBreakdownDto> {
  return getJson(ctx, `${projectPath(ctx)}/analytics/sources`, { window: 'all', includeByQuery: 'false', ...query })
}

function readReport(ctx: GroundTruthContext, query: QueryParams): Promise<VisibilityReportResponse> {
  return getJson(ctx, `${projectPath(ctx)}/visibility-report`, query)
}

function readProjectOverview(ctx: GroundTruthContext): Promise<ProjectOverviewDto> {
  return getJson(ctx, `${projectPath(ctx)}/overview`)
}

function readLandscape(ctx: GroundTruthContext, query: QueryParams): Promise<CompetitorLandscapeResponse> {
  return getJson(ctx, `${projectPath(ctx)}/analytics/competitors`, query)
}

interface RunLine {
  id: string
  status: string
  trigger: string
  createdAt: string
  finishedAt: string | null
  scope: 'full' | 'spot_check'
  location?: string
  error?: string
}

interface RunContext {
  /** Non-probe answer-visibility runs, newest first. */
  recent: RunLine[]
  latest: RunLine | null
  /** Newest completed whole-project sweep. */
  latestComplete: RunLine | null
  previousComplete: RunLine | null
}

/** A run's error as one line: the top-level message, then each engine's message (never the raw provider payload). */
function runErrorText(error: RunDto['error'] | string | undefined): string | undefined {
  if (!error) return undefined
  if (typeof error === 'string') return redact(error).slice(0, 200)
  const parts = [
    ...(error.message ? [error.message] : []),
    ...Object.entries(error.providers ?? {}).map(([provider, detail]) => `${provider}: ${detail.message}`),
  ]
  return parts.length > 0 ? redact(parts.join('; ')).slice(0, 200) : undefined
}

function runLine(run: RunDto): RunLine {
  const error = runErrorText(run.error)
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger ?? 'manual',
    createdAt: run.createdAt,
    finishedAt: run.finishedAt ?? null,
    scope: run.measurementScope ? 'spot_check' : 'full',
    ...(run.location ? { location: run.location } : {}),
    ...(error ? { error } : {}),
  }
}

async function readRuns(ctx: GroundTruthContext): Promise<RunContext> {
  const rows = await getJson<RunDto[]>(ctx, `${projectPath(ctx)}/runs`, { kind: 'answer-visibility', limit: 10 })
  const recent = rows
    .filter(run => run.trigger !== 'probe')
    .map(runLine)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const complete = recent.filter(run => run.status === 'completed' && run.scope === 'full')
  return {
    recent,
    latest: recent[0] ?? null,
    latestComplete: complete[0] ?? null,
    previousComplete: complete[1] ?? null,
  }
}

function briefRun(run: RunLine | null): string | null {
  if (!run) return null
  const where = run.location ? `, location ${run.location}` : ''
  return `${run.id} (${run.status}, ${run.scope}, created ${run.createdAt}, finished ${run.finishedAt ?? 'n/a'}${where})`
}

function sweepFacts(runs: Soft<RunContext>): Record<string, unknown> {
  if (!runs.ok) return { sweeps: failed(runs) }
  return {
    latestCompleteSweep: briefRun(runs.value.latestComplete),
    previousCompleteSweep: briefRun(runs.value.previousComplete),
  }
}

function measuredRun(
  measurement: MeasurementPortfolioSummaryResponse['measurement'],
  runs: Soft<RunContext>,
): Record<string, unknown> {
  return {
    measuredRunId: measurement.displayedRunId,
    completedAt: measurement.completedAt,
    state: measurement.state,
    planRevision: measurement.planRevision,
    ...sweepFacts(runs),
  }
}

// ── Formatting ────────────────────────────────────────────────────────────

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function signed(value: number, digits: number): string {
  const rounded = Number(value.toFixed(digits))
  if (rounded === 0) return (0).toFixed(digits)
  return rounded > 0 ? `+${rounded.toFixed(digits)}` : rounded.toFixed(digits)
}

function metricValue(metric: MetricValue | undefined): number | null {
  return metric?.state === 'available' ? metric.value : null
}

function metricNumerator(metric: MetricValue | undefined): number | null {
  return metric?.state === 'available' && metric.numerator !== undefined ? metric.numerator : null
}

function metricDenominator(metric: MetricValue | undefined): number | null {
  return metric?.state === 'available' && metric.denominator !== undefined ? metric.denominator : null
}

/** "318/1212 (26.2%)", with any unattributed answers beside it. */
function fmtMetric(metric: MetricValue | undefined): string {
  if (!metric) return 'not returned'
  if (metric.state === 'unavailable') return `unavailable (${metric.reason})`
  const base = metric.numerator !== undefined && metric.denominator !== undefined
    ? `${metric.numerator}/${metric.denominator} (${percent(metric.value)})`
    : percent(metric.value)
  return metric.unattributed ? `${base}, ${metric.unattributed} unattributed answers left out` : base
}

/** A count metric such as Properties mentioned: "91/140". */
function fmtCount(metric: MetricValue | undefined): string {
  if (!metric) return 'not returned'
  if (metric.state === 'unavailable') return `unavailable (${metric.reason})`
  return metric.numerator !== undefined && metric.denominator !== undefined
    ? `${metric.numerator}/${metric.denominator}`
    : String(metric.value)
}

function fmtRate(rate: VisibilityReportRate | undefined): string {
  if (!rate) return 'not returned'
  if (rate.rate === null || rate.numerator === null || rate.denominator === null) return `unavailable (${rate.reason ?? 'unknown'})`
  const base = `${rate.numerator}/${rate.denominator} (${percent(rate.rate)})`
  return rate.unattributed ? `${base}, ${rate.unattributed} unattributed answers left out` : base
}

function fmtDelta(delta: MeasurementMetricDelta | undefined, unit: 'points' | 'count'): string {
  if (!delta) return 'not returned'
  if (delta.state === 'unavailable') return `unavailable (${delta.reason})`
  const format = unit === 'points' ? fmtMetric : fmtCount
  const change = unit === 'points' ? `${signed(delta.delta * 100, 1)} pts` : signed(delta.delta, 0)
  return `${format(delta.previous)} -> ${format(delta.current)} (${change})`
}

function fmtRateChange(change: VisibilityReportRateChange | undefined, current: VisibilityReportRate): string {
  if (!change) return 'not returned'
  if (change.state === 'unavailable') return `unavailable (${change.reason})`
  return `${fmtRate(change.previous)} -> ${fmtRate(current)} (${signed(change.delta * 100, 1)} pts)`
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1
  return counts
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

function rankedTop(list: RankedSourceList | undefined, n: number): string[] {
  return (list?.entries ?? []).slice(0, n).map(entry => {
    const share = entry.answerShare === undefined ? '' : ` (${percent(entry.answerShare)} of answers)`
    return `${entry.domain}: ${entry.count} answers${share} [${entry.surfaceClass}]`
  })
}

function rankedFacts(list: RankedSourceList | undefined, n: number): Record<string, unknown> {
  if (!list) return { note: 'not returned' }
  return {
    answers: list.answerTotal ?? null,
    answersWithSources: list.answersWithSources ?? null,
    domains: list.domainTotal,
    top: rankedTop(list, n),
  }
}

/** Where the project's own domains rank, from a list read with a generous limit. */
function ownSite(list: RankedSourceList | undefined): string[] | string {
  const entries = list?.entries ?? []
  const own = entries
    .map((entry, index) => ({ entry, rank: index + 1 }))
    .filter(item => item.entry.surfaceClass === 'own')
  if (own.length === 0) return `not among the top ${entries.length} of ${list?.domainTotal ?? 0} domains`
  return own.map(item => `#${item.rank} ${item.entry.domain}: ${item.entry.count} answers`)
}

// ── Portfolio helpers ──────────────────────────────────────────────────────

type RankedRow = MeasurementPortfolioSummaryResponse['mentionRanking']['strongest'][number]
type PortfolioRow = MeasurementPortfolioWeakestProperty | RankedRow

function portfolioFacts(summary: MeasurementPortfolioSummaryResponse): Record<string, unknown> {
  return {
    properties: summary.totalProperties,
    propertiesMentioned: fmtCount(summary.metrics.propertiesMentioned),
    mentionCoverage: fmtMetric(summary.metrics.mentionCoverage),
    citationCoverage: fmtMetric(summary.metrics.citationCoverage),
  }
}

function metroLabels(row: PortfolioRow): string[] {
  if (!row.metro) return []
  return [row.metro.label, ...(row.otherMetros ?? []).map(metro => metro.label)]
}

function rankRow(row: PortfolioRow): Record<string, unknown> {
  return {
    property: row.label,
    metro: row.metro?.label ?? null,
    ...(row.otherMetros ? { otherMetros: row.otherMetros.map(metro => metro.label) } : {}),
    submarkets: row.submarkets.slice(0, 3),
    queries: row.queries,
    mention: fmtMetric(row.mentionCoverage),
    citation: fmtMetric(row.citationCoverage),
  }
}

function weakRow(row: MeasurementPortfolioWeakestProperty): Record<string, unknown> {
  const named = row.namedInsteadInAnswerText
    ?? row.recommendedInstead?.map(item => ({ name: item.name, answers: item.occurrences }))
    ?? []
  return {
    ...rankRow(row),
    namedInsteadInAnswerText: named.map(item => `${item.name} (${item.answers})`),
    namedInsteadTotal: row.namedInsteadInAnswerTextTotal ?? row.recommendedInsteadTotal ?? named.length,
    citedDomains: (row.citedDomains ?? []).map(item => `${item.domain} (${item.answers})`),
    citedDomainsTotal: row.citedDomainsTotal ?? null,
  }
}

/**
 * targetKey -> metro labels for every Property. Rows the summary returned carry
 * their metro; the rest come from one overview read per top-level market, so
 * the grader can check the metro of any Property the answer places.
 */
async function metroMembership(
  ctx: GroundTruthContext,
  summary: MeasurementPortfolioSummaryResponse,
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  const add = (targetKey: string, label: string) => {
    const labels = map.get(targetKey) ?? []
    if (!labels.includes(label)) labels.push(label)
    map.set(targetKey, labels)
  }
  const seeded: PortfolioRow[] = [
    ...summary.weakestProperties,
    ...summary.mentionRanking.strongest,
    ...summary.mentionRanking.weakest,
  ]
  for (const row of seeded) for (const label of metroLabels(row)) add(row.targetKey, label)
  const metros = summary.markets.filter(market => market.parentGroupKey === null)
  if (metros.length === 0 || metros.length > MAX_METRO_READS) return map
  await mapLimit(metros, 4, async metro => {
    const read = await readOverviewRows(ctx, { scope: 'group', groupKey: metro.groupKey, queryClass: 'non-brand' }, 5)
    for (const row of read.rows) add(row.targetKey, metro.label)
  })
  return map
}

function groupByMetro(
  rows: readonly { targetKey: string; label: string }[],
  metros: Map<string, string[]> | undefined,
): Array<{ metro: string; count: number; properties: string[] }> {
  const groups = new Map<string, string[]>()
  for (const row of rows) {
    const metro = metros?.get(row.targetKey)?.[0] ?? '(metro not resolved)'
    groups.set(metro, [...(groups.get(metro) ?? []), row.label])
  }
  return [...groups]
    .map(([metro, properties]) => ({ metro, count: properties.length, properties: properties.sort((a, b) => a.localeCompare(b)) }))
    .sort((left, right) => right.count - left.count || left.metro.localeCompare(right.metro))
}

// ── Builders ────────────────────────────────────────────────────────────────

interface BuiltTruth {
  facts: unknown
  placeholders?: Record<string, string>
  basis: string
}

type Builder = (ctx: GroundTruthContext, arg: string | undefined) => Promise<BuiltTruth>

async function portfolioWeakest(ctx: GroundTruthContext): Promise<BuiltTruth> {
  const summary = await readPortfolio(ctx)
  const [overview, runs, metros] = await Promise.all([
    soft(readOverviewRows(ctx, { queryClass: 'non-brand' })),
    soft(readRuns(ctx)),
    soft(metroMembership(ctx, summary)),
  ])
  const rows = summary.weakestProperties
  const overviewRows = overview.ok ? overview.value.rows : []
  const zeroMention = overviewRows.filter(row => metricValue(row.mentionCoverage) === 0)
  const zeroBoth = zeroMention.filter(row => metricValue(row.citationCoverage) === 0)
  const tie = summary.tiedAtWeakest
  const isTied = (row: { mentionCoverage: MetricValue; citationCoverage: MetricValue }) => tie !== null
    && metricValue(row.mentionCoverage) === tie.mentionRate
    && metricValue(row.citationCoverage) === tie.citationRate
  const tied = overviewRows.length > 0 ? overviewRows.filter(isTied) : rows.filter(isTied)
  const largestNamed = rows
    .flatMap(row => (row.namedInsteadInAnswerText ?? []).map(item => ({ ...item, property: row.label })))
    .sort((left, right) => right.answers - left.answers || left.name.localeCompare(right.name))
    .slice(0, 12)
    .map(item => `${item.name}: ${item.answers} answers for ${item.property}`)
  const sources = summary.weakestAnswerSources
  const shown = Math.min(10, rows.length)
  return {
    facts: {
      project: ctx.project,
      run: measuredRun(summary.measurement, runs),
      queryClass: summary.queryClass,
      engines: summary.engines,
      units: DENOMINATORS,
      portfolio: portfolioFacts(summary),
      outcomes: overview.ok
        ? { ...overview.value.first.outcomes, note: 'Properties by which signals they got at all in this class; the buckets sum to total.' }
        : failed(overview),
      propertiesAtZeroMention: overview.ok ? zeroMention.length : 'unknown',
      propertiesAtZeroMentionAndCitation: overview.ok ? zeroBoth.length : 'unknown',
      tiedAtWeakest: tie
        ? { count: tie.count, mentionRate: percent(tie.mentionRate), citationRate: percent(tie.citationRate), note: 'Tied Properties are ordered by name, not ranked.' }
        : null,
      ...(tie ? { tiedPropertiesByMetro: groupByMetro(tied, metros.ok ? metros.value : undefined) } : {}),
      weakest: {
        shown: `${shown} of the ${rows.length} weakest rows (${summary.totalProperties} Properties in total)`,
        rows: rows.slice(0, shown).map(weakRow),
      },
      namedInsteadNote: NAMED_INSTEAD,
      largestNamedInsteadCounts: largestNamed,
      weakestAnswerSources: sources
        ? {
            properties: sources.properties,
            answers: sources.answers,
            domainTotal: sources.domainTotal,
            top: sources.domains.map(domain => `${domain.domain}: ${domain.answers} answers`),
          }
        : null,
    },
    basis: 'GET measurement-portfolio-summary (non-brand, limit 50, every market level); measurement-overview (non-brand, every Property, and one read per metro for membership); runs (answer-visibility).',
  }
}

async function portfolioStrongest(ctx: GroundTruthContext): Promise<BuiltTruth> {
  const summary = await readPortfolio(ctx)
  const [overview, runs] = await Promise.all([
    soft(readOverviewRows(ctx, { queryClass: 'non-brand' })),
    soft(readRuns(ctx)),
  ])
  const ranking = summary.mentionRanking
  const topRate = metricValue(ranking.strongest[0]?.mentionCoverage)
  const values = overview.ok ? overview.value.rows.map(row => metricValue(row.mentionCoverage)) : []
  return {
    facts: {
      project: ctx.project,
      run: measuredRun(summary.measurement, runs),
      queryClass: summary.queryClass,
      engines: summary.engines,
      units: DENOMINATORS,
      portfolio: portfolioFacts(summary),
      ranking: {
        rankedProperties: ranking.eligiblePropertyCount,
        excludedByReason: countBy(ranking.excluded, row => row.reason),
      },
      topMentionRate: topRate === null ? null : percent(topRate),
      propertiesTiedAtTopRate: overview.ok && topRate !== null ? values.filter(value => value === topRate).length : 'unknown',
      mentionDistribution: overview.ok
        ? {
            at100: values.filter(value => value === 1).length,
            from50To99: values.filter(value => value !== null && value >= 0.5 && value < 1).length,
            above0Below50: values.filter(value => value !== null && value > 0 && value < 0.5).length,
            at0: values.filter(value => value === 0).length,
            unavailable: values.filter(value => value === null).length,
          }
        : failed(overview),
      strongest: ranking.strongest.slice(0, 15).map(rankRow),
    },
    basis: 'GET measurement-portfolio-summary (non-brand, limit 50) mentionRanking; measurement-overview (non-brand, every Property) for ties and distribution; runs.',
  }
}

async function marketGaps(ctx: GroundTruthContext): Promise<BuiltTruth> {
  const summary = await readPortfolio(ctx)
  const [overview, runs, metros] = await Promise.all([
    soft(readOverviewRows(ctx, { queryClass: 'non-brand' })),
    soft(readRuns(ctx)),
    soft(metroMembership(ctx, summary)),
  ])
  const byKey = new Map(summary.markets.map(market => [market.groupKey, market]))
  const order = (left: MeasurementPortfolioMarket, right: MeasurementPortfolioMarket) => (
    (metricValue(left.mentionCoverage) ?? -1) - (metricValue(right.mentionCoverage) ?? -1)
    || (metricValue(left.citationCoverage) ?? -1) - (metricValue(right.citationCoverage) ?? -1)
    || left.label.localeCompare(right.label)
  )
  const marketRow = (market: MeasurementPortfolioMarket) => ({
    market: market.label,
    ...(market.parentGroupKey ? { parent: byKey.get(market.parentGroupKey)?.label ?? market.parentGroupKey } : {}),
    properties: market.propertyCount,
    propertiesMentioned: fmtCount(market.propertiesMentioned),
    mention: fmtMetric(market.mentionCoverage),
    citation: fmtMetric(market.citationCoverage),
    childMarkets: market.childMarketCount,
  })
  const top = summary.markets.filter(market => market.parentGroupKey === null).sort(order)
  const nested = summary.markets.filter(market => market.parentGroupKey !== null).sort(order)
  const shownTop = top.length > 25 ? [...top.slice(0, 18), ...top.slice(-5)] : top
  let zeroByMetro: unknown = 'unknown'
  if (overview.ok && metros.ok) {
    const tally = new Map<string, { properties: number; zeroMention: number; zeroMentionAndCitation: number }>()
    for (const row of overview.value.rows) {
      for (const metro of metros.value.get(row.targetKey) ?? ['(metro not resolved)']) {
        const entry = tally.get(metro) ?? { properties: 0, zeroMention: 0, zeroMentionAndCitation: 0 }
        entry.properties++
        if (metricValue(row.mentionCoverage) === 0) {
          entry.zeroMention++
          if (metricValue(row.citationCoverage) === 0) entry.zeroMentionAndCitation++
        }
        tally.set(metro, entry)
      }
    }
    zeroByMetro = [...tally]
      .map(([metro, counts]) => ({ metro, ...counts }))
      .sort((left, right) => right.zeroMentionAndCitation - left.zeroMentionAndCitation || left.metro.localeCompare(right.metro))
  }
  return {
    facts: {
      project: ctx.project,
      run: measuredRun(summary.measurement, runs),
      queryClass: summary.queryClass,
      engines: summary.engines,
      units: DENOMINATORS,
      note: MARKETS_NOTE,
      portfolio: portfolioFacts(summary),
      metros: {
        total: top.length,
        order: 'worst mention first',
        ...(shownTop.length < top.length ? { shown: `${shownTop.length} of ${top.length}: the 18 worst and 5 best` } : {}),
        rows: shownTop.map(marketRow),
      },
      nestedMarkets: {
        total: nested.length,
        worst: nested.slice(0, 10).map(marketRow),
        best: nested.length > 10 ? nested.slice(Math.max(10, nested.length - 5)).reverse().map(marketRow) : [],
      },
      propertiesAtZeroByMetro: zeroByMetro,
    },
    basis: 'GET measurement-portfolio-summary (non-brand, limit 50, includeNestedMarkets); measurement-overview (non-brand) per metro for membership and zero counts; runs.',
  }
}

interface Move {
  label: string
  line: string
  mentionDelta: number | null
  citationDelta: number | null
}

function propertyMoves(current: MeasurementPropertyRow[], previous: MeasurementPropertyRow[]): Record<string, unknown> {
  const before = new Map(previous.map(row => [row.targetKey, row]))
  const moves: Move[] = []
  const answerSteps = { unchanged: 0, oneAnswer: 0, twoAnswers: 0, threeOrMore: 0, notComparable: 0 }
  let populationChanged = 0
  let onlyInOneSweep = previous.filter(row => !current.some(other => other.targetKey === row.targetKey)).length
  for (const row of current) {
    const old = before.get(row.targetKey)
    if (!old) {
      onlyInOneSweep++
      continue
    }
    const nowMention = metricValue(row.mentionCoverage)
    const oldMention = metricValue(old.mentionCoverage)
    const nowCitation = metricValue(row.citationCoverage)
    const oldCitation = metricValue(old.citationCoverage)
    const mentionDelta = nowMention !== null && oldMention !== null ? nowMention - oldMention : null
    const citationDelta = nowCitation !== null && oldCitation !== null ? nowCitation - oldCitation : null
    if (metricDenominator(row.mentionCoverage) !== metricDenominator(old.mentionCoverage)) populationChanged++
    const nowCount = metricNumerator(row.mentionCoverage)
    const oldCount = metricNumerator(old.mentionCoverage)
    if (nowCount === null || oldCount === null) answerSteps.notComparable++
    else {
      const step = Math.abs(nowCount - oldCount)
      if (step === 0) answerSteps.unchanged++
      else if (step === 1) answerSteps.oneAnswer++
      else if (step === 2) answerSteps.twoAnswers++
      else answerSteps.threeOrMore++
    }
    const mentionPart = `mention ${fmtMetric(old.mentionCoverage)} -> ${fmtMetric(row.mentionCoverage)}${mentionDelta === null ? '' : ` (${signed(mentionDelta * 100, 1)} pts)`}`
    const citationPart = `citation ${fmtMetric(old.citationCoverage)} -> ${fmtMetric(row.citationCoverage)}${citationDelta === null ? '' : ` (${signed(citationDelta * 100, 1)} pts)`}`
    moves.push({ label: row.label, line: `${row.label}: ${mentionPart}; ${citationPart}`, mentionDelta, citationDelta })
  }
  const byMention = (sign: 1 | -1) => moves
    .filter(move => move.mentionDelta !== null && Math.sign(move.mentionDelta) === sign)
    .sort((left, right) => sign * ((right.mentionDelta ?? 0) - (left.mentionDelta ?? 0)) || left.label.localeCompare(right.label))
  const byCitation = (sign: 1 | -1) => moves
    .filter(move => move.mentionDelta === 0 && move.citationDelta !== null && Math.sign(move.citationDelta) === sign)
    .sort((left, right) => sign * ((right.citationDelta ?? 0) - (left.citationDelta ?? 0)) || left.label.localeCompare(right.label))
  const denominators = current
    .map(row => metricDenominator(row.mentionCoverage))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)
  const median = denominators.length > 0 ? denominators[Math.floor(denominators.length / 2)] ?? null : null
  const gains = byMention(1)
  const losses = byMention(-1)
  return {
    medianPropertyDenominator: median,
    ...(median ? { oneAnswerMovesAPropertyBy: `${(100 / median).toFixed(1)} pts` } : {}),
    mentionAnswerChangePerProperty: answerSteps,
    propertiesWhosePopulationChanged: populationChanged,
    propertiesInOnlyOneSweep: onlyInOneSweep,
    mentionGainers: { total: gains.length, top: gains.slice(0, 8).map(move => move.line) },
    mentionLosers: { total: losses.length, top: losses.slice(0, 8).map(move => move.line) },
    citationOnlyGainers: byCitation(1).slice(0, 5).map(move => move.line),
    citationOnlyLosers: byCitation(-1).slice(0, 5).map(move => move.line),
  }
}

function classChange(response: MeasurementChangesResponse): unknown {
  if (response.comparison.state === 'unavailable') return `unavailable (${response.comparison.reason})`
  const metrics = response.comparison.metrics
  return {
    propertiesMentioned: fmtDelta(metrics.propertiesMentioned, 'count'),
    mentionCoverage: fmtDelta(metrics.mentionCoverage, 'points'),
    citationCoverage: fmtDelta(metrics.citationCoverage, 'points'),
    propertiesWithAnyChange: response.comparison.totalProperties,
  }
}

function reportComparisons(report: VisibilityReportResponse): unknown[] {
  return report.populations.map(population => {
    const comparison = population.comparison
    let change: unknown = 'not returned'
    if (comparison?.state === 'unavailable') {
      change = `unavailable (${comparison.reason})`
    } else if (comparison?.state === 'available') {
      change = {
        previousRun: `${comparison.previousRun.id} (completed ${comparison.previousRun.completedAt ?? 'n/a'})`,
        mention: fmtRateChange(comparison.mentionCoverage, population.summary.mentionCoverage),
        citation: fmtRateChange(comparison.citationCoverage, population.summary.citationCoverage),
      }
    }
    return {
      queryClass: population.queryClass,
      queries: population.summary.queryCount,
      answers: population.summary.answerCount,
      mention: fmtRate(population.summary.mentionCoverage),
      citation: fmtRate(population.summary.citationCoverage),
      changeSincePreviousSweep: change,
    }
  })
}

async function sweepChanges(ctx: GroundTruthContext): Promise<BuiltTruth> {
  const nonBrand = await readChanges(ctx, 'non-brand')
  const [branded, runs, report] = await Promise.all([
    soft(readChanges(ctx, 'branded')),
    soft(readRuns(ctx)),
    soft(readReport(ctx, { queryClass: 'all', limit: 1 })),
  ])
  const current = nonBrand.current
  const facts: Record<string, unknown> = {
    project: ctx.project,
    current: {
      runId: current.displayedRunId,
      completedAt: current.completedAt,
      state: current.state,
      planRevision: current.planRevision,
      scope: current.measurementScope,
    },
    ...sweepFacts(runs),
    units: DENOMINATORS,
  }
  if (nonBrand.comparison.state === 'unavailable') {
    facts.comparison = `unavailable (${nonBrand.comparison.reason}): there is no comparable previous sweep for these reads`
    facts.branded = branded.ok ? classChange(branded.value) : failed(branded)
    facts.projectReportByClass = report.ok ? reportComparisons(report.value) : failed(report)
    return { facts, basis: 'GET measurement-changes (non-brand and branded, separately); visibility-report (all classes, split); runs.' }
  }
  const previous = nonBrand.comparison.previous
  facts.previous = {
    runId: previous.displayedRunId,
    completedAt: previous.completedAt,
    planRevision: previous.planRevision,
    scope: previous.measurementScope,
  }
  facts.nonBrand = classChange(nonBrand)
  facts.branded = branded.ok ? classChange(branded.value) : failed(branded)
  const [now, before] = await Promise.all([
    soft(readOverviewRows(ctx, { queryClass: 'non-brand', runId: current.displayedRunId ?? undefined })),
    soft(readOverviewRows(ctx, { queryClass: 'non-brand', runId: previous.displayedRunId })),
  ])
  if (now.ok && before.ok) facts.nonBrandPropertyMoves = propertyMoves(now.value.rows, before.value.rows)
  else if (!now.ok) facts.nonBrandPropertyMoves = failed(now)
  else if (!before.ok) facts.nonBrandPropertyMoves = failed(before)
  facts.projectReportByClass = report.ok ? reportComparisons(report.value) : failed(report)
  return {
    facts,
    basis: 'GET measurement-changes (non-brand and branded, separately); measurement-overview (non-brand) for the current and previous run, compared per Property; visibility-report (all classes, split); runs.',
  }
}

function movement(summary: ProjectOverviewDto['mentionMovement'] | undefined): unknown {
  if (!summary) return 'not returned'
  return {
    hasPreviousRun: summary.hasPreviousRun,
    gained: summary.gained,
    lost: summary.lost,
    gainedQueries: (summary.gainedQueries ?? []).slice(0, 12),
    lostQueries: (summary.lostQueries ?? []).slice(0, 12),
  }
}

async function projectChanges(ctx: GroundTruthContext): Promise<BuiltTruth> {
  const [report, overview, runs] = await Promise.all([
    soft(readReport(ctx, { queryClass: 'all', limit: 1 })),
    soft(readProjectOverview(ctx)),
    soft(readRuns(ctx)),
  ])
  if (!report.ok && !overview.ok) throw new Error(`project-changes: no change read succeeded (${report.error}; ${overview.error})`)
  let queryMovement: unknown
  if (overview.ok) {
    const value = overview.value
    const comparison = value.movementComparison
    queryMovement = {
      note: 'Project overview: query-level movement over queries shared by both sweeps, with branded and non-brand pooled.',
      comparison: comparison
        ? {
            comparable: comparison.comparable,
            querySetChanged: comparison.querySetChanged,
            previousRunAt: comparison.previousRunAt,
            currentQueries: comparison.currentQueryCount,
            previousQueries: comparison.previousQueryCount,
            comparableQueries: comparison.comparableQueryCount,
            added: comparison.addedQueryCount,
            removed: comparison.removedQueryCount,
          }
        : 'not returned',
      mention: movement(value.mentionMovement),
      citation: movement(value.citationMovement ?? value.movementSummary),
      recentSweeps: [...(value.runHistory ?? [])]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 4)
        .map(point => `${point.createdAt} ${point.runId} (${point.status}): mentioned ${point.mentionedCount}/${point.totalCount}, cited ${point.citedCount}/${point.totalCount} queries`),
    }
  } else {
    queryMovement = failed(overview)
  }
  return {
    facts: {
      project: ctx.project,
      ...sweepFacts(runs),
      byClass: report.ok
        ? {
            mode: report.value.selection.mode,
            availability: report.value.selection.availability.state,
            selectedRun: report.value.selection.run.id,
            populations: reportComparisons(report.value),
          }
        : failed(report),
      queryMovement,
    },
    basis: 'GET visibility-report (all classes, split by class, with the change since the previous sweep); overview (query-level movement, pooled); runs.',
  }
}

async function measuredRunId(ctx: GroundTruthContext, runs: Soft<RunContext>): Promise<{ runId: string | null; run: Record<string, unknown> }> {
  if (ctx.kind === 'advanced') {
    const summary = await soft(readPortfolio(ctx))
    if (summary.ok && summary.value.measurement.displayedRunId) {
      return { runId: summary.value.measurement.displayedRunId, run: measuredRun(summary.value.measurement, runs) }
    }
  }
  const latest = runs.ok ? runs.value.latestComplete : null
  return { runId: latest?.id ?? null, run: { runId: latest?.id ?? null, ...sweepFacts(runs) } }
}

async function sourcesNonBrand(ctx: GroundTruthContext): Promise<BuiltTruth> {
  const runs = await soft(readRuns(ctx))
  const { runId, run } = await measuredRunId(ctx, runs)
  if (!runId) {
    return {
      facts: { project: ctx.project, noCompletedSweep: true, ...sweepFacts(runs) },
      basis: 'No completed sweep, so no sources can be read.',
    }
  }
  const nonBrand = await readSources(ctx, { runId, queryClass: 'non-brand', limit: 50 })
  const [sameRun, everySweep] = await Promise.all([
    soft(readSources(ctx, { runId, limit: 50 })),
    soft(readSources(ctx, { limit: 50 })),
  ])
  return {
    facts: {
      project: ctx.project,
      run,
      queryClass: nonBrand.filters?.queryClass ?? 'non-brand',
      classBasis: nonBrand.filters?.queryClassBasis ?? null,
      sweepsPooled: nonBrand.runCount ?? null,
      answers: nonBrand.answerTotal ?? null,
      unclassifiedAnswers: nonBrand.unclassifiedAnswers ?? 0,
      counting: SOURCES_COUNTING,
      nonBrand: rankedFacts(nonBrand.ranked, 15),
      ownSiteNonBrand: ownSite(nonBrand.ranked),
      bySurfaceClass: nonBrand.ranked.bySurfaceClass.map(row => `${row.label}: ${row.count} cited slots across ${row.domainCount} domains`),
      byEngine: Object.fromEntries(Object.entries(nonBrand.byProvider).map(([provider, list]) => [
        provider,
        { answers: list.answerTotal ?? null, top: rankedTop(list, 5) },
      ])),
      enginesWithoutSources: nonBrand.providersWithoutSources ?? [],
      pooledContrast: {
        note: 'Only to recognise pooled figures in an answer. These are NOT the answer to a non-brand question.',
        sameSweepBothClasses: sameRun.ok
          ? { answers: sameRun.value.answerTotal ?? null, top: rankedTop(sameRun.value.ranked, 6), ownSite: ownSite(sameRun.value.ranked) }
          : failed(sameRun),
        everySweepBothClasses: everySweep.ok
          ? { sweepsPooled: everySweep.value.runCount ?? null, answers: everySweep.value.answerTotal ?? null, top: rankedTop(everySweep.value.ranked, 5), ownSite: ownSite(everySweep.value.ranked) }
          : failed(everySweep),
      },
    },
    basis: `GET analytics/sources (runId ${runId}, queryClass non-brand, limit 50); the same run with both classes and every sweep pooled, as a contrast; runs.`,
  }
}

async function sourcesLatest(ctx: GroundTruthContext): Promise<BuiltTruth> {
  const runs = await soft(readRuns(ctx))
  const runId = runs.ok ? runs.value.latestComplete?.id ?? null : null
  if (!runId) {
    return {
      facts: { project: ctx.project, noCompletedSweep: true, ...sweepFacts(runs) },
      basis: 'No completed sweep, so no sources can be read.',
    }
  }
  const latest = await readSources(ctx, { runId, limit: 50 })
  const everySweep = await soft(readSources(ctx, { limit: 50 }))
  return {
    facts: {
      project: ctx.project,
      run: { runId, ...sweepFacts(runs) },
      scope: ctx.kind === 'legacy'
        ? 'Every tracked query in one sweep. A legacy schema-v1 plan does not classify queries, so there is no branded/non-brand split.'
        : 'Every tracked query in one sweep, branded and non-brand pooled.',
      answers: latest.answerTotal ?? null,
      sweepsPooled: latest.runCount ?? null,
      counting: SOURCES_COUNTING,
      latestSweep: rankedFacts(latest.ranked, 15),
      ownSite: ownSite(latest.ranked),
      byEngine: Object.fromEntries(Object.entries(latest.byProvider).map(([provider, list]) => [
        provider,
        { answers: list.answerTotal ?? null, top: rankedTop(list, 5) },
      ])),
      enginesWithoutSources: latest.providersWithoutSources ?? [],
      everySweepContrast: everySweep.ok
        ? { note: 'Every sweep pooled; not the latest sweep.', sweepsPooled: everySweep.value.runCount ?? null, top: rankedTop(everySweep.value.ranked, 5) }
        : failed(everySweep),
    },
    basis: `GET analytics/sources (runId ${runId}, limit 50); every sweep pooled as a contrast; runs.`,
  }
}

async function pickProperty(
  ctx: GroundTruthContext,
  summary: MeasurementPortfolioSummaryResponse,
  arg: string | undefined,
): Promise<{ targetKey: string; label: string; row?: PortfolioRow }> {
  const candidates: PortfolioRow[] = [
    ...summary.weakestProperties,
    ...summary.mentionRanking.weakest,
    ...summary.mentionRanking.strongest,
  ]
  if (arg !== undefined && arg.trim() !== '') {
    const needle = arg.trim().toLowerCase()
    const matches = (row: { targetKey: string; label: string }) => row.targetKey.toLowerCase() === needle || row.label.toLowerCase() === needle
    const hit = candidates.find(matches)
    if (hit) return { targetKey: hit.targetKey, label: hit.label, row: hit }
    const search = await getJson<MeasurementOverviewResponse>(ctx, `${projectPath(ctx)}/measurement-overview`, {
      scope: 'all',
      search: arg.trim(),
      limit: 20,
    })
    const items = search.properties.items
    const match = items.find(matches) ?? (items.length === 1 ? items[0] : undefined)
    if (!match) throw new Error(`property-drilldown: no Property matches "${arg}"`)
    return { targetKey: match.targetKey, label: match.label }
  }
  // The weakest measured row whose answers name someone else most often: the
  // drill-down with the most evidence to get right or wrong.
  const rows = summary.weakestProperties
  const weakest = metricValue(rows.find(row => row.mentionCoverage.state === 'available')?.mentionCoverage)
  const topNamed = (row: MeasurementPortfolioWeakestProperty) => Math.max(0, ...(row.namedInsteadInAnswerText ?? []).map(item => item.answers))
  const pick = rows
    .filter(row => metricValue(row.mentionCoverage) === weakest && topNamed(row) > 0)
    .sort((left, right) => topNamed(right) - topNamed(left)
      || (metricDenominator(right.mentionCoverage) ?? 0) - (metricDenominator(left.mentionCoverage) ?? 0)
      || left.label.localeCompare(right.label))[0]
    ?? rows.find(row => row.mentionCoverage.state === 'available')
    ?? rows[0]
  if (!pick) throw new Error('property-drilldown: the portfolio summary returned no Property to drill into')
  return { targetKey: pick.targetKey, label: pick.label, row: pick }
}

async function readPropertyQuestions(ctx: GroundTruthContext, targetKey: string): Promise<{ rows: MeasurementPropertyQuestionRow[]; total: number }> {
  const rows: MeasurementPropertyQuestionRow[] = []
  let total = 0
  for (let page = 0; page < 3; page++) {
    const response = await getJson<MeasurementPropertyQuestionsResponse>(ctx, `${projectPath(ctx)}/measurement-property-questions`, {
      targetKey,
      queryClass: 'non-brand',
      limit: 100,
      offset: rows.length,
    })
    rows.push(...response.questions)
    total = response.total
    if (response.questions.length === 0 || rows.length >= total) break
  }
  return { rows, total }
}

async function readPropertyAnswers(ctx: GroundTruthContext, targetKey: string): Promise<MeasurementAnswerEvidence[]> {
  const items: MeasurementAnswerEvidence[] = []
  let cursor: string | undefined
  for (let page = 0; page < 3; page++) {
    const response = await getJson<MeasurementPropertyEvidenceResponse>(ctx, `${projectPath(ctx)}/measurement-property-evidence`, {
      targetKey,
      queryClass: 'non-brand',
      shape: 'answers',
      limit: 100,
      cursor,
    })
    items.push(...(response.answers?.items ?? []))
    cursor = response.answers?.nextCursor ?? undefined
    if (!cursor) break
  }
  return items
}

function questionFacts(rows: MeasurementPropertyQuestionRow[], total: number): Record<string, unknown> {
  const byQuery = new Map<string, { text: string; outcomes: string[]; named: boolean }>()
  for (const row of rows) {
    const entry = byQuery.get(row.queryId) ?? { text: row.text, outcomes: [], named: false }
    const engine = row.location ? `${row.provider}@${row.location}` : row.provider
    if (row.status === 'missing') {
      entry.outcomes.push(`${engine} no answer`)
    } else {
      const mention = row.mentioned === null ? 'M?' : row.mentioned ? 'M+' : 'M-'
      const citation = row.cited === null ? 'C?' : row.cited ? 'C+' : 'C-'
      entry.outcomes.push(`${engine} ${mention}${citation}`)
      if (row.mentioned === true) entry.named = true
    }
    byQuery.set(row.queryId, entry)
  }
  const queries = [...byQuery.values()].sort((left, right) => Number(left.named) - Number(right.named) || left.text.localeCompare(right.text))
  return {
    legend: QUESTION_LEGEND,
    answerRows: total,
    queries: queries.length,
    queriesNotNamedByAnyEngine: queries.filter(query => !query.named).length,
    lines: queries.slice(0, 24).map(query => `${query.text} | ${query.outcomes.join(', ')}`),
  }
}

function answerSourceFacts(answers: MeasurementAnswerEvidence[]): Record<string, unknown> {
  const domains = new Map<string, number>()
  let citingOwnPage = 0
  let withoutSources = 0
  let mentionNotChecked = 0
  for (const answer of answers) {
    const hosts = new Set(answer.sources.map(source => hostOf(source.sourceUrl)).filter((host): host is string => host !== null))
    for (const host of hosts) domains.set(host, (domains.get(host) ?? 0) + 1)
    if (answer.sources.some(source => source.classification === 'assigned')) citingOwnPage++
    if (answer.sourceCount === 0) withoutSources++
    if (answer.mentioned === null) mentionNotChecked++
  }
  return {
    answers: answers.length,
    answersCitingItsOwnPage: citingOwnPage,
    answersWithNoSources: withoutSources,
    answersWithMentionNotChecked: mentionNotChecked,
    domainTotal: domains.size,
    top: [...domains]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 10)
      .map(([domain, count]) => `${domain}: ${count} answers`),
  }
}

async function propertyDrilldown(ctx: GroundTruthContext, arg: string | undefined): Promise<BuiltTruth> {
  const summary = await readPortfolio(ctx)
  const target = await pickProperty(ctx, summary, arg)
  const overviewPath = `${projectPath(ctx)}/measurement-overview`
  const [runs, nonBrand, branded, questions, competitors, answers, metros] = await Promise.all([
    soft(readRuns(ctx)),
    soft(getJson<MeasurementOverviewResponse>(ctx, overviewPath, { scope: 'property', targetKey: target.targetKey, queryClass: 'non-brand' })),
    soft(getJson<MeasurementOverviewResponse>(ctx, overviewPath, { scope: 'property', targetKey: target.targetKey, queryClass: 'branded' })),
    soft(readPropertyQuestions(ctx, target.targetKey)),
    soft(getJson<MeasurementPropertyCompetitorsResponse>(ctx, `${projectPath(ctx)}/measurement-property-competitors`, {
      targetKey: target.targetKey,
      queryClass: 'non-brand',
      limit: 10,
    })),
    soft(readPropertyAnswers(ctx, target.targetKey)),
    target.row?.metro ? Promise.resolve(undefined) : soft(metroMembership(ctx, summary)),
  ])
  const row = target.row
  const nonBrandRow = nonBrand.ok ? nonBrand.value.properties.items[0] : undefined
  const brandedRow = branded.ok ? branded.value.properties.items[0] : undefined
  const mention = nonBrandRow?.mentionCoverage ?? row?.mentionCoverage
  const citation = nonBrandRow?.citationCoverage ?? row?.citationCoverage
  const tie = summary.tiedAtWeakest
  const inTie = tie !== null && metricValue(mention) === tie.mentionRate && metricValue(citation) === tie.citationRate
  let namedInstead: unknown
  if (competitors.ok) {
    const basis = competitors.value.basis
    namedInstead = {
      note: NAMED_INSTEAD,
      basis: basis.state === 'available'
        ? `${basis.answeredResults} answered, ${basis.targetMissResults} neither named nor cited it, ${basis.recommendationOccurrences} name occurrences`
        : `unavailable (${basis.reason})`,
      total: competitors.value.total,
      top: competitors.value.competitors.map(item => `${item.name}: ${item.occurrences} answers, ${item.questionTotal} queries, engines ${item.providers.join('/')}`),
    }
  } else {
    namedInstead = failed(competitors)
  }
  const metro = row?.metro?.label ?? (metros?.ok ? metros.value.get(target.targetKey)?.join(', ') : undefined) ?? null
  return {
    facts: {
      project: ctx.project,
      property: {
        name: target.label,
        targetKey: target.targetKey,
        metro,
        ...(row?.otherMetros ? { otherMetros: row.otherMetros.map(item => item.label) } : {}),
        submarkets: row?.submarkets ?? 'not returned',
        nonBrandQueries: row?.queries ?? 'not returned',
      },
      run: measuredRun(summary.measurement, runs),
      units: DENOMINATORS,
      nonBrand: {
        mention: fmtMetric(mention),
        citation: fmtMetric(citation),
        byEngine: nonBrandRow
          ? nonBrandRow.providers.map(item => `${item.provider}: mention ${fmtMetric(item.mentionCoverage)}, citation ${fmtMetric(item.citationCoverage)}`)
          : (nonBrand.ok ? 'not returned' : failed(nonBrand)),
      },
      branded: brandedRow
        ? { mention: fmtMetric(brandedRow.mentionCoverage), citation: fmtMetric(brandedRow.citationCoverage), note: 'Separate population; never pooled with non-brand.' }
        : (branded.ok ? 'not returned' : failed(branded)),
      tie: inTie && tie ? `One of ${tie.count} Properties tied at ${percent(tie.mentionRate)} mention and ${percent(tie.citationRate)} citation (ordered by name, not ranked).` : null,
      nonBrandQueries: questions.ok ? questionFacts(questions.value.rows, questions.value.total) : failed(questions),
      namedInstead,
      citedDomains: answers.ok
        ? answerSourceFacts(answers.value)
        : { fromSummaryRow: row && 'citedDomains' in row ? row.citedDomains.map(item => `${item.domain}: ${item.answers} answers`) : [], evidence: failed(answers) },
    },
    placeholders: { property: target.label },
    basis: `Property ${target.targetKey}: GET measurement-overview (scope property, non-brand and branded), measurement-property-questions, measurement-property-competitors and measurement-property-evidence (shape answers), all non-brand; picked ${arg ? `by name "${arg}"` : 'as the weakest-rate row whose answers name another place most often'}.`,
  }
}

function landscapeLine(row: CompetitorLandscapeRow): string {
  const share = row.shareOfVoice === null ? '' : `, share of voice ${row.shareOfVoice}%`
  return `${row.label} (${row.domain}): named in ${row.mentionCount} answers, cited in ${row.citationCount}${share}`
}

async function competitorsNamed(ctx: GroundTruthContext): Promise<BuiltTruth> {
  const runs = await soft(readRuns(ctx))
  const { runId, run } = await measuredRunId(ctx, runs)
  let classNote: string | undefined
  let landscape: CompetitorLandscapeResponse
  try {
    landscape = await readLandscape(ctx, { queryClass: 'non-brand', runId: runId ?? undefined })
  } catch (error) {
    // A Simple project with no brand alias cannot split classes; the pooled landscape is all there is.
    if (ctx.kind === 'advanced' || !(error instanceof GroundTruthReadError) || error.status >= 500) throw error
    landscape = await readLandscape(ctx, { runId: runId ?? undefined })
    classNote = `The non-brand split was refused (${error.message}); these counts pool branded and non-brand.`
  }
  const report = await soft(readReport(ctx, { queryClass: 'non-brand', limit: 1 }))
  const population = report.ok ? report.value.populations[0] : undefined
  return {
    facts: {
      project: ctx.project,
      run,
      queryClass: landscape.filters.queryClass,
      scope: landscape.filters.scope,
      ...(classNote ? { classNote } : {}),
      evidence: landscape.evidence,
      ourBrand: landscapeLine(landscape.project),
      pinnedCompetitors: landscape.pinned.map(landscapeLine),
      observedCompetitors: { total: landscape.observed.length, top: landscape.observed.slice(0, 10).map(landscapeLine) },
      namesWrittenInAnswers: {
        note: 'Names written in the answer text (not cited sources), counted by answer.',
        total: landscape.observedNamesTotal ?? landscape.observedNames?.length ?? 0,
        top: (landscape.observedNames ?? []).slice(0, 20).map(item => `${item.name}: ${item.answerCount} answers`),
      },
      otherCitedSources: landscape.otherSources.slice(0, 8).map(row => `${row.domain}: cited in ${row.citationCount} answers, named in ${row.mentionCount} [${row.surfaceClass}]`),
      visibilityReportNonBrand: population
        ? {
            answers: population.summary.answerCount,
            namesInAnswerText: [...population.observedCompetitors]
              .sort((left, right) => right.answerCount - left.answerCount || left.name.localeCompare(right.name))
              .slice(0, 15)
              .map(item => `${item.name}: ${item.answerCount} answers`),
            trackedCompetitors: [...population.competitors]
              .sort((left, right) => (right.mentionCoverage.numerator ?? 0) - (left.mentionCoverage.numerator ?? 0) || left.domain.localeCompare(right.domain))
              .slice(0, 10)
              .map(item => `${item.domain}: mention ${fmtRate(item.mentionCoverage)}, citation ${fmtRate(item.citationCoverage)}`),
          }
        : (report.ok ? 'not returned' : failed(report)),
    },
    basis: `GET analytics/competitors (queryClass non-brand${runId ? `, runId ${runId}` : ''}); visibility-report (non-brand); runs.`,
  }
}

async function dataQuality(ctx: GroundTruthContext): Promise<BuiltTruth> {
  const advanced = ctx.kind === 'advanced'
  const [runs, quality, summary, report] = await Promise.all([
    soft(readRuns(ctx)),
    advanced ? soft(getJson<MeasurementDataQualityResponse>(ctx, `${projectPath(ctx)}/measurement-data-quality`)) : Promise.resolve(undefined),
    advanced ? soft(readPortfolio(ctx)) : Promise.resolve(undefined),
    soft(readReport(ctx, { queryClass: 'non-brand', limit: 1 })),
  ])
  if (!runs.ok && !quality?.ok) throw new Error(`data-quality: no run read succeeded (${runs.error})`)
  const latest = runs.ok ? runs.value.latest : null
  const completeness = latest ? await soft(getJson<RunCompletenessDto>(ctx, `/runs/${encodeURIComponent(latest.id)}/completeness`)) : undefined
  const measurement = report.ok ? report.value.selection.measurement : undefined
  const population = report.ok ? report.value.populations[0] : undefined
  let completenessFacts: unknown = 'no sweep to check'
  if (completeness?.ok) {
    const value = completeness.value
    completenessFacts = {
      runId: value.runId,
      status: value.status,
      planned: value.planned,
      readable: value.readable,
      expected: value.expected,
      executed: value.executed,
      missing: value.missing,
      missingByEngine: value.missingByProvider,
      refusal: value.refusal?.code ?? null,
      latestFill: value.latestFill ? `${value.latestFill.status}: filled ${value.latestFill.filled} of ${value.latestFill.expected}` : null,
    }
  } else if (completeness) {
    completenessFacts = failed(completeness)
  }
  return {
    facts: {
      project: ctx.project,
      sweeps: runs.ok
        ? {
            latest: briefRun(runs.value.latest),
            latestComplete: briefRun(runs.value.latestComplete),
            recent: runs.value.recent.slice(0, 8).map(run => `${briefRun(run)}${run.error ? ` error: ${run.error}` : ''}`),
          }
        : failed(runs),
      latestSweepCompleteness: completenessFacts,
      ...(quality
        ? { measurementDataQuality: quality.ok ? quality.value : failed(quality) }
        : {}),
      ...(summary?.ok
        ? {
            mentionAnswersUnattributed: summary.value.metrics.mentionCoverage.state === 'available'
              ? summary.value.metrics.mentionCoverage.unattributed ?? 0
              : `mention unavailable (${summary.value.metrics.mentionCoverage.reason})`,
            propertiesExcludedFromRanking: countBy(summary.value.mentionRanking.excluded, row => row.reason),
          }
        : {}),
      reportMeasurement: measurement
        ? {
            state: measurement.state,
            activeRevision: measurement.activeRevision,
            measuredRevision: measurement.measuredRevision,
            awaitingSweep: measurement.awaitingSweep,
            pendingAssignments: measurement.pendingAssignmentCount,
            completedAt: measurement.completedAt,
            availability: report.ok ? report.value.selection.availability.state : null,
          }
        : (report.ok ? 'not returned' : failed(report)),
      nonBrandAnswers: population
        ? { answers: population.summary.answerCount, queries: population.summary.queryCount, mention: fmtRate(population.summary.mentionCoverage), citation: fmtRate(population.summary.citationCoverage) }
        : 'not returned',
    },
    basis: `GET runs (answer-visibility); runs/{id}/completeness for the latest sweep${advanced ? '; measurement-data-quality; measurement-portfolio-summary' : ''}; visibility-report (non-brand) selection.`,
  }
}

async function legacyPropertyMetrics(ctx: GroundTruthContext): Promise<BuiltTruth> {
  const overview = await getJson<MeasurementOverviewResponse>(ctx, `${projectPath(ctx)}/measurement-overview`, { scope: 'all', limit: 100 })
  const [project, runs] = await Promise.all([soft(readProjectOverview(ctx)), soft(readRuns(ctx))])
  const metrics = overview.metrics
  const anyPropertyRate = overview.properties.items.some(row => row.mentionCoverage.state === 'available')
  let projectLevel: unknown
  if (project.ok) {
    const counts = project.value.queryCounts
    projectLevel = {
      note: 'Project-wide over tracked queries, branded and non-brand pooled; counts queries with at least one mentioning or citing answer.',
      mentionedQueries: `${counts.mentionedQueries}/${counts.totalQueries}`,
      citedQueries: `${counts.citedQueries}/${counts.totalQueries}`,
      byEngine: project.value.providers.map(item => `${item.provider}: cited ${item.cited}/${item.total}`),
      latestRun: project.value.latestRun?.run
        ? `${project.value.latestRun.run.id} (${project.value.latestRun.run.status}, finished ${project.value.latestRun.run.finishedAt ?? 'n/a'})`
        : null,
    }
  } else {
    projectLevel = failed(project)
  }
  return {
    facts: {
      project: ctx.project,
      planMode: overview.mode,
      perPropertyMetricsAvailable: anyPropertyRate,
      portfolioMetrics: {
        mentionCoverage: fmtMetric(metrics.mentionCoverage),
        citationCoverage: fmtMetric(metrics.citationCoverage),
        propertiesMentioned: fmtCount(metrics.propertiesMentioned),
      },
      properties: overview.properties.totalEstimate ?? overview.outcomes.total,
      sampleProperties: overview.properties.items.slice(0, 10).map(row => `${row.label}: mention ${fmtMetric(row.mentionCoverage)}`),
      measurement: overview.measurement,
      projectLevel,
      ...sweepFacts(runs),
    },
    basis: 'GET measurement-overview (scope all); overview (project-wide query counts); runs.',
  }
}

function simpleQueryRows(rows: VisibilityReportQueryRow[]): Record<string, unknown> {
  type Tally = { text: string; mentionN: number; mentionD: number; citationN: number; citationD: number; engines: string[] }
  const byQuery = new Map<string, Tally>()
  const byEngine = new Map<string, { mentionN: number; mentionD: number; citationN: number; citationD: number }>()
  for (const row of rows) {
    const tally = byQuery.get(row.queryKey) ?? { text: row.query, mentionN: 0, mentionD: 0, citationN: 0, citationD: 0, engines: [] }
    const engine = byEngine.get(row.provider) ?? { mentionN: 0, mentionD: 0, citationN: 0, citationD: 0 }
    const mention = row.mentionCoverage
    const citation = row.citationCoverage
    if (mention.numerator !== null && mention.denominator !== null) {
      tally.mentionN += mention.numerator
      tally.mentionD += mention.denominator
      engine.mentionN += mention.numerator
      engine.mentionD += mention.denominator
    }
    if (citation.numerator !== null && citation.denominator !== null) {
      tally.citationN += citation.numerator
      tally.citationD += citation.denominator
      engine.citationN += citation.numerator
      engine.citationD += citation.denominator
    }
    const m = mention.numerator === null ? 'M?' : mention.numerator > 0 ? 'M+' : 'M-'
    const c = citation.numerator === null ? 'C?' : citation.numerator > 0 ? 'C+' : 'C-'
    tally.engines.push(`${row.provider} ${m}${c}`)
    byQuery.set(row.queryKey, tally)
    byEngine.set(row.provider, engine)
  }
  const queries = [...byQuery.values()]
  const never = queries
    .filter(query => query.mentionD > 0 && query.mentionN === 0)
    .sort((left, right) => left.citationN - right.citationN || left.text.localeCompare(right.text))
  const strongest = queries
    .filter(query => query.mentionD > 0 && query.mentionN > 0)
    .sort((left, right) => right.mentionN / right.mentionD - left.mentionN / left.mentionD || left.text.localeCompare(right.text))
  const line = (query: Tally) => `${query.text} | mention ${query.mentionN}/${query.mentionD}, citation ${query.citationN}/${query.citationD} | ${query.engines.join(', ')}`
  return {
    legend: 'Per engine: M+ the answer text names the brand, M- it does not, M? not checked; C+ a source links the site, C- it does not, C? capture incomplete.',
    queries: queries.length,
    queriesNeverNamed: { total: never.length, lines: never.slice(0, 20).map(line) },
    queriesNamedByEveryAnswer: queries.filter(query => query.mentionD > 0 && query.mentionN === query.mentionD).length,
    strongest: strongest.slice(0, 5).map(line),
    byEngine: Object.fromEntries([...byEngine].map(([provider, tally]) => [
      provider,
      `mention ${tally.mentionN}/${tally.mentionD}, citation ${tally.citationN}/${tally.citationD}`,
    ])),
  }
}

async function simpleQueryGaps(ctx: GroundTruthContext): Promise<BuiltTruth> {
  const first = await readReport(ctx, { queryClass: 'non-brand', limit: 100 })
  const population = first.populations[0]
  if (!population) throw new Error('simple-query-gaps: the visibility report returned no population')
  const rows = [...population.queries.items]
  let cursor = population.queries.nextCursor
  for (let page = 1; page < MAX_REPORT_PAGES && cursor; page++) {
    const next = await readReport(ctx, { queryClass: 'non-brand', limit: 100, cursor })
    const nextPopulation = next.populations[0]
    rows.push(...(nextPopulation?.queries.items ?? []))
    cursor = nextPopulation?.queries.nextCursor ?? null
  }
  const [branded, runs] = await Promise.all([
    soft(readReport(ctx, { queryClass: 'branded', limit: 1 })),
    soft(readRuns(ctx)),
  ])
  const brandedPopulation = branded.ok ? branded.value.populations[0] : undefined
  return {
    facts: {
      project: ctx.project,
      run: { selectedRun: first.selection.run.id, completedAt: first.selection.measurement.completedAt, mode: first.selection.mode, ...sweepFacts(runs) },
      queryClass: 'non-brand',
      units: DENOMINATORS,
      summary: {
        queries: population.summary.queryCount,
        answers: population.summary.answerCount,
        mention: fmtRate(population.summary.mentionCoverage),
        citation: fmtRate(population.summary.citationCoverage),
      },
      rowsRead: cursor
        ? `${rows.length} of ${population.queries.total} query-engine rows (cut at ${MAX_REPORT_PAGES} pages; the lists below cover only these)`
        : `${rows.length} of ${population.queries.total} query-engine rows`,
      ...simpleQueryRows(rows),
      namesWrittenInAnswers: {
        note: 'Names written in the answer text, counted by answer; not citations.',
        total: population.observedCompetitors.length,
        top: [...population.observedCompetitors]
          .sort((left, right) => right.answerCount - left.answerCount || left.name.localeCompare(right.name))
          .slice(0, 15)
          .map(item => `${item.name}: ${item.answerCount} answers`),
      },
      trackedCompetitors: [...population.competitors]
        .sort((left, right) => (right.mentionCoverage.numerator ?? 0) - (left.mentionCoverage.numerator ?? 0) || left.domain.localeCompare(right.domain))
        .slice(0, 8)
        .map(item => `${item.domain}: mention ${fmtRate(item.mentionCoverage)}, citation ${fmtRate(item.citationCoverage)}`),
      branded: brandedPopulation
        ? { note: 'Separate population; never pooled with non-brand.', queries: brandedPopulation.summary.queryCount, mention: fmtRate(brandedPopulation.summary.mentionCoverage), citation: fmtRate(brandedPopulation.summary.citationCoverage) }
        : (branded.ok ? 'not returned' : failed(branded)),
    },
    basis: 'GET visibility-report (non-brand, every query row page; branded summary separately); runs.',
  }
}

async function dataUnavailable(ctx: GroundTruthContext): Promise<BuiltTruth> {
  const [report, runs] = await Promise.all([
    soft(readReport(ctx, { queryClass: 'all', limit: 1 })),
    soft(readRuns(ctx)),
  ])
  const project = report.ok ? undefined : await soft(readProjectOverview(ctx))
  let engines: unknown = 'unknown'
  if (report.ok) engines = report.value.filterOptions.providers
  else if (project?.ok) engines = project.value.providers.map(item => item.provider)
  return {
    facts: {
      project: ctx.project,
      requestedDataAvailable: false,
      notStored: [
        'real user prompt or conversation volume for any AI engine',
        'impressions, views or reach of AI answers',
        'which real users saw or acted on an answer',
      ],
      whatIsStored: 'Sampled answers: each sweep asks every tracked query once per engine (and per location) and stores the answer text and its cited sources. Mention and citation rates are shares of those sampled answers.',
      relatedButDifferent: 'Connected analytics (GA4, server logs) can count AI referral visits and crawler fetches. Those are visits and fetches, not questions asked or answers seen.',
      measuredEngines: engines,
      ...sweepFacts(runs),
      sampledAnswersLatestSweep: report.ok
        ? report.value.populations.map(population => `${population.queryClass}: ${population.summary.answerCount} answers over ${population.summary.queryCount} queries`)
        : 'not read',
    },
    basis: 'Static: Canonry stores sampled sweep answers, not user volume. GET visibility-report (engines, answer counts); runs.',
  }
}

async function productQuestion(): Promise<BuiltTruth> {
  return {
    facts: { note: 'Product or how-it-works question: no project data applies. Grade on the rubric.' },
    basis: 'No reads.',
  }
}

interface BuilderSpec {
  kinds: ProjectKind[]
  description: string
  build: Builder
}

const ALL_KINDS: ProjectKind[] = ['advanced', 'simple', 'legacy']

/** Every builder a question may name in `truth`, with the project kinds it reads. */
export const GROUND_TRUTH_BUILDERS: Readonly<Record<string, BuilderSpec>> = {
  'portfolio-weakest': {
    kinds: ['advanced'],
    description: 'Weakest Properties (non-brand): rates, ties, metros, names written instead, cited domains.',
    build: portfolioWeakest,
  },
  'portfolio-strongest': {
    kinds: ['advanced'],
    description: 'Strongest Properties (non-brand) with ties and the mention distribution.',
    build: portfolioStrongest,
  },
  'market-gaps': {
    kinds: ['advanced'],
    description: 'Every metro and nested market worst-first, and Properties at zero per metro.',
    build: marketGaps,
  },
  'sweep-changes': {
    kinds: ['advanced'],
    description: 'Change since the previous comparable sweep, branded and non-brand separately, with per-Property movers and noise.',
    build: sweepChanges,
  },
  'property-drilldown': {
    kinds: ['advanced'],
    description: 'One Property (the weakest with names written instead, or `property-drilldown:<key or label>`): rates, queries, names instead, cited domains. Sets {property}.',
    build: propertyDrilldown,
  },
  'sources-nonbrand': {
    kinds: ['advanced', 'simple'],
    description: 'Cited domains behind non-brand answers in the latest sweep, per engine, with pooled figures as a contrast.',
    build: sourcesNonBrand,
  },
  'sources-latest': {
    kinds: ALL_KINDS,
    description: 'Cited domains in the latest sweep over every tracked query.',
    build: sourcesLatest,
  },
  'competitors-named': {
    kinds: ['advanced', 'simple'],
    description: 'Competitors and names written in non-brand answers, kept apart from citations.',
    build: competitorsNamed,
  },
  'data-quality': {
    kinds: ALL_KINDS,
    description: 'Latest sweep status and completeness, capture and retrieval quality, pending assignments.',
    build: dataQuality,
  },
  'data-unavailable': {
    kinds: ALL_KINDS,
    description: 'For questions Canonry cannot answer (user volume, impressions): what is and is not stored.',
    build: dataUnavailable,
  },
  'simple-query-gaps': {
    kinds: ['simple'],
    description: 'Non-brand queries never named, per engine, with names written instead.',
    build: simpleQueryGaps,
  },
  'project-changes': {
    kinds: ['simple', 'legacy'],
    description: 'Change since the previous sweep by class (visibility report) and query-level movement (overview, pooled).',
    build: projectChanges,
  },
  'legacy-property-metrics': {
    kinds: ['legacy'],
    description: 'A schema-v1 plan: per-Property rates are unavailable; project-wide figures instead.',
    build: legacyPropertyMetrics,
  },
  none: {
    kinds: ALL_KINDS,
    description: 'Product or how-it-works question; graded on the rubric alone.',
    build: productQuestion,
  },
}

/** Splits `name:arg` (the argument is optional). */
export function parseBuilderRef(ref: string): { name: string; arg?: string } {
  const index = ref.indexOf(':')
  if (index < 0) return { name: ref.trim() }
  const arg = ref.slice(index + 1).trim()
  return { name: ref.slice(0, index).trim(), ...(arg ? { arg } : {}) }
}

/** Placeholder names a builder fills, so a question set can be checked before a run. */
export function builderPlaceholders(ref: string): string[] {
  return parseBuilderRef(ref).name === 'property-drilldown' ? ['property'] : []
}

/** Fills {name} placeholders; unknown names are left in place so a check can catch them. */
export function applyPlaceholders(prompt: string, placeholders: Record<string, string> | undefined): string {
  return prompt.replace(/\{([a-z]\w*)\}/gi, (whole, name: string) => placeholders?.[name] ?? whole)
}

interface ArrayRef {
  parent: Record<string, unknown> | unknown[]
  key: string | number
  path: string
  length: number
  size: number
}

function findArrays(value: unknown, path: string, parent: ArrayRef['parent'] | null, key: string | number | null, out: ArrayRef[]): void {
  if (Array.isArray(value)) {
    if (parent !== null && key !== null && value.length > 1) {
      out.push({ parent, key, path, length: value.length, size: JSON.stringify(value).length })
    }
    value.forEach((item, index) => findArrays(item, `${path}[${index}]`, value, index, out))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      findArrays(child, path ? `${path}.${childKey}` : childKey, value as Record<string, unknown>, childKey, out)
    }
  }
}

/**
 * Keeps facts under `maxChars` of JSON: halves the largest list until it fits
 * and records each cut in `_trimmed`, so the grader knows a list is partial.
 */
export function fitFacts(facts: unknown, maxChars = MAX_FACTS_CHARS): unknown {
  if (JSON.stringify(facts ?? null).length <= maxChars) return facts
  const copy = structuredClone(facts) as unknown
  const original = new Map<string, number>()
  const budget = Math.max(200, maxChars - 600)
  for (let pass = 0; pass < 400 && JSON.stringify(copy).length > budget; pass++) {
    const arrays: ArrayRef[] = []
    findArrays(copy, '', null, null, arrays)
    const largest = arrays.sort((left, right) => right.size - left.size)[0]
    if (!largest) break
    if (!original.has(largest.path)) original.set(largest.path, largest.length)
    const keep = Math.max(1, Math.floor(largest.length / 2))
    const list = (largest.parent as Record<string | number, unknown>)[largest.key] as unknown[]
    ;(largest.parent as Record<string | number, unknown>)[largest.key] = list.slice(0, keep)
  }
  const notes = [...original].map(([path, length]) => {
    const kept = path.split(/\.|\[/).reduce<unknown>((node, part) => {
      if (node === null || typeof node !== 'object') return undefined
      const key = part.endsWith(']') ? Number(part.slice(0, -1)) : part
      return (node as Record<string | number, unknown>)[key]
    }, copy)
    return `${path}: kept ${Array.isArray(kept) ? kept.length : '?'} of ${length}`
  })
  const serialized = JSON.stringify(copy)
  if (serialized.length > maxChars) {
    return { _trimmed: ['facts cut as text; lists could not shrink them enough'], text: serialized.slice(0, maxChars - 200) }
  }
  if (copy !== null && typeof copy === 'object' && !Array.isArray(copy)) {
    return { ...(copy as Record<string, unknown>), _trimmed: notes }
  }
  return { facts: copy, _trimmed: notes }
}

/**
 * Computes ground truth for one question. `builder` is the question's `truth`
 * (`name` or `name:arg`). The primary read failing throws; a failed secondary
 * read is recorded in the facts instead.
 */
export async function buildGroundTruth(builder: string, ctx: GroundTruthContext): Promise<GroundTruth> {
  const { name, arg } = parseBuilderRef(builder)
  const spec = GROUND_TRUTH_BUILDERS[name]
  if (!spec) {
    throw new Error(`Unknown ground-truth builder "${name}". Known: ${Object.keys(GROUND_TRUTH_BUILDERS).join(', ')}`)
  }
  if (!spec.kinds.includes(ctx.kind)) {
    throw new Error(`Ground-truth builder "${name}" reads ${spec.kinds.join('/')} projects, not a ${ctx.kind} project`)
  }
  const built = await spec.build(ctx, arg)
  return {
    builder,
    facts: fitFacts(built.facts),
    ...(built.placeholders ? { placeholders: built.placeholders } : {}),
    basis: built.basis,
  }
}
