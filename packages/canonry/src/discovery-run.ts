import crypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import {
  competitors,
  insights,
  parseJsonColumn,
  projects,
  runs,
} from '@ainyc/canonry-db'
import {
  DiscoveryCompetitorTypes,
  effectiveDomains,
  RunStatuses,
  type DiscoveryCompetitorType,
  type LocationContext,
} from '@ainyc/canonry-contracts'
import { embedQueries } from '@ainyc/canonry-provider-gemini'
import {
  executeDiscovery,
  markSessionFailed,
  type DiscoveryDeps,
  type DiscoveryDomainClassification,
  type DiscoveryProjectContext,
  type DiscoveryProbeResult,
  type DiscoverySeedResult,
  type ExecuteDiscoveryResult,
} from '@ainyc/canonry-api-routes'
import type { ProviderRegistry } from './provider-registry.js'
import { createLogger } from './logger.js'

const log = createLogger('DiscoveryRun')

const DEFAULT_SEED_COUNT = 30

export interface ExecuteDiscoveryRunOptions {
  db: DatabaseClient
  registry: ProviderRegistry
  runId: string
  sessionId: string
  projectId: string
  icpDescription: string
  dedupThreshold?: number
  maxProbes?: number
  /**
   * Resolved service-area locations for this session (see `resolveLocations`
   * in contracts). Forwarded to the seed prompt so generated queries stay
   * inside the project's service area. Omitted / empty leaves seeding
   * location-unaware — the behaviour for projects with no locations.
   */
  locations?: LocationContext[]
  /** Override for tests / future multi-provider amplification. Defaults to Gemini-only. */
  deps?: DiscoveryDeps
}

/**
 * Runs the full discovery pipeline for a single session and marks the
 * associated `runs` row terminal. Always returns rather than throws — the
 * route fired this in the background, so the only safe response to a failure
 * is to record it in `discovery_sessions.error` + `runs.error` and move on.
 *
 * After the orchestrator returns, this handler also writes a single
 * `discovery.basket-divergence` insight summarizing the bucket counts. PR 5
 * will hoist the insight write into the shared `persistInsight()` helper —
 * for PR 1 it's inlined here per the handoff doc's "no shared helper yet" call.
 */
export async function executeDiscoveryRun(opts: ExecuteDiscoveryRunOptions): Promise<void> {
  const startedAt = new Date().toISOString()
  opts.db
    .update(runs)
    .set({ status: RunStatuses.running, startedAt })
    .where(eq(runs.id, opts.runId))
    .run()

  try {
    const projectRow = opts.db.select().from(projects).where(eq(projects.id, opts.projectId)).get()
    if (!projectRow) throw new Error(`Project ${opts.projectId} not found`)

    const projectCompetitors = opts.db
      .select({ domain: competitors.domain })
      .from(competitors)
      .where(eq(competitors.projectId, opts.projectId))
      .all()
      .map(r => r.domain.toLowerCase())

    const canonicalDomains = effectiveDomains({
      canonicalDomain: projectRow.canonicalDomain,
      ownedDomains: parseJsonColumn<string[]>(projectRow.ownedDomains, []),
    })

    const project: DiscoveryProjectContext = {
      id: projectRow.id,
      name: projectRow.name,
      canonicalDomains,
      competitorDomains: projectCompetitors,
    }

    const deps = opts.deps ?? buildDefaultDeps(opts.registry)

    const result = await executeDiscovery({
      db: opts.db,
      runId: opts.runId,
      sessionId: opts.sessionId,
      project,
      icpDescription: opts.icpDescription,
      dedupThreshold: opts.dedupThreshold,
      maxProbes: opts.maxProbes,
      locations: opts.locations,
      deps,
    })

    writeDiscoveryInsight(opts.db, {
      projectId: opts.projectId,
      runId: opts.runId,
      sessionId: opts.sessionId,
      seedProvider: result.seedProvider,
      result,
    })

    opts.db
      .update(runs)
      .set({ status: RunStatuses.completed, finishedAt: new Date().toISOString() })
      .where(eq(runs.id, opts.runId))
      .run()

    log.info('discovery.completed', {
      runId: opts.runId,
      sessionId: opts.sessionId,
      buckets: result.buckets,
      competitorCount: result.competitorMap.length,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.error('discovery.failed', { runId: opts.runId, sessionId: opts.sessionId, error: errorMsg })

    markSessionFailed(opts.db, opts.sessionId, errorMsg)
    opts.db
      .update(runs)
      .set({
        status: RunStatuses.failed,
        finishedAt: new Date().toISOString(),
        error: errorMsg,
      })
      .where(eq(runs.id, opts.runId))
      .run()
  }
}

/**
 * Default deps — Gemini-only. v2 multi-provider amplification will wrap
 * multiple deps in a composite and surface a label like `"gemini+chatgpt"`
 * in the `DiscoverySeedResult.provider` field.
 */
function buildDefaultDeps(registry: ProviderRegistry): DiscoveryDeps {
  const gemini = registry.get('gemini')
  if (!gemini) {
    throw new Error('Gemini provider is not configured. Add a Gemini API key (or Vertex project) before running discovery.')
  }
  const cfg = gemini.config
  if (!cfg.apiKey && !cfg.vertexProject) {
    throw new Error('Gemini provider is missing both apiKey and vertexProject — cannot run discovery.')
  }

  const adapter = gemini.adapter

  return {
    async seed(input): Promise<DiscoverySeedResult> {
      const prompt = buildSeedPrompt(input)
      const raw = await adapter.executeTrackedQuery(
        {
          query: prompt,
          canonicalDomains: input.project.canonicalDomains,
          competitorDomains: input.project.competitorDomains,
        },
        cfg,
      )
      const normalized = adapter.normalizeResult(raw)
      const fromAnswer = parseQueryLines(normalized.answerText, DEFAULT_SEED_COUNT * 2)
      // Gemini's grounding metadata also exposes the actual web search queries
      // it ran — those are *real* user-intent strings that show live demand,
      // so they make excellent seed candidates alongside the model's response.
      const fromGrounding = normalized.searchQueries ?? []
      return {
        candidates: [...fromAnswer, ...fromGrounding],
        provider: 'gemini',
      }
    },
    async embed(queries: string[]): Promise<number[][]> {
      if (cfg.apiKey) {
        return embedQueries(queries, { apiKey: cfg.apiKey })
      }
      // Vertex-mode embeddings need a Vertex-aware client; this is outside
      // PR 1's scope. Throw early with a clear remediation so we don't
      // silently fall through to a half-broken pipeline.
      throw new Error('Discovery currently requires a Gemini API key. Vertex-mode embeddings are not yet implemented.')
    },
    async probe(input): Promise<DiscoveryProbeResult> {
      const raw = await adapter.executeTrackedQuery(
        {
          query: input.query,
          canonicalDomains: input.project.canonicalDomains,
          competitorDomains: input.project.competitorDomains,
        },
        cfg,
      )
      const normalized = adapter.normalizeResult(raw)
      const canonical = new Set(input.project.canonicalDomains.map(d => d.toLowerCase()))
      const isCited = normalized.citedDomains.some(d => canonical.has(d.toLowerCase()))
      return {
        citationState: isCited ? 'cited' : 'not-cited',
        citedDomains: normalized.citedDomains,
        rawResponse: raw.rawResponse as Record<string, unknown>,
      }
    },
    async classifyDomains(input): Promise<DiscoveryDomainClassification> {
      // One plain-text generation per session — no grounding tool needed, the
      // model just types the domains it is handed. The orchestrator catches a
      // throw here and degrades every domain to `unknown`.
      const prompt = buildClassificationPrompt(input)
      const text = await adapter.generateText(prompt, cfg)
      return parseClassificationResponse(text, input.domains)
    },
  }
}

/**
 * Recognized competitor categories the classifier emits. `unknown` is the
 * orchestrator's fallback, not a category the model is asked to assign.
 */
const CLASSIFICATION_CATEGORIES: readonly DiscoveryCompetitorType[] = [
  DiscoveryCompetitorTypes['direct-competitor'],
  DiscoveryCompetitorTypes['ota-aggregator'],
  DiscoveryCompetitorTypes['editorial-media'],
  DiscoveryCompetitorTypes.other,
]

/**
 * `CLASSIFICATION_CATEGORIES` paired with whole-token matchers. The
 * alphanumeric boundaries keep a category from matching inside a hostname —
 * without them `other` matches inside `brothersolar.com` on an arrow-less line.
 */
const CLASSIFICATION_CATEGORY_MATCHERS: ReadonlyArray<{
  category: DiscoveryCompetitorType
  pattern: RegExp
}> = CLASSIFICATION_CATEGORIES.map(category => ({
  category,
  pattern: new RegExp(`(?<![a-z0-9])${category}(?![a-z0-9])`),
}))

/**
 * Build the post-probe domain-classification prompt. Hands the model the
 * project context plus the deduped cited-domain list and asks for one
 * `domain => category` line per domain. Exported for unit testing.
 */
export function buildClassificationPrompt(input: {
  project: DiscoveryProjectContext
  icpDescription: string
  domains: string[]
}): string {
  const tracked = input.project.competitorDomains.length > 0
    ? input.project.competitorDomains.join(', ')
    : 'none'
  return [
    'You are an AEO (Answer Engine Optimization) analyst classifying the domains that AI answer engines cited for a customer\'s tracked queries.',
    '',
    `Customer: ${input.project.name} (own domains: ${input.project.canonicalDomains.join(', ')})`,
    `ICP: ${input.icpDescription}`,
    `Already-tracked competitors: ${tracked}`,
    '',
    'Classify EACH domain below into exactly one category:',
    ' - direct-competitor: a business competing directly with the customer for the same customers (another company in the same category). Every already-tracked competitor above is a direct-competitor.',
    ' - ota-aggregator: online travel agencies, marketplaces, directories, booking platforms, or review aggregators that list many businesses (e.g. expedia.com, booking.com, tripadvisor.com, yelp.com, g2.com).',
    ' - editorial-media: news sites, magazines, blogs, or "best of" listicle / round-up articles (e.g. timeout.com, nytimes.com, personal blogs).',
    ' - other: anything else — government sites, social media, the customer itself, or domains unrelated to the competitive space.',
    '',
    'Domains:',
    ...input.domains,
    '',
    'Return ONE line per domain in EXACTLY this format:',
    '<domain> => <category>',
    '',
    'Plain text only. No numbering, bullets, commentary, or markdown.',
  ].join('\n')
}

/**
 * Parse the classifier's response into a domain → type map. Forgiving by
 * design: it locates each input domain in the response and reads the category
 * to the right of `=>` (falling back to a whole-line scan). Any domain the
 * model omits or labels with an unrecognized category is left out of the map,
 * which the orchestrator treats as `unknown`. Exported for unit testing.
 */
export function parseClassificationResponse(
  text: string,
  domains: string[],
): DiscoveryDomainClassification {
  const lines = text
    .split('\n')
    .map(l => l.trim().toLowerCase())
    .filter(Boolean)
  const result: DiscoveryDomainClassification = {}
  for (const domain of domains) {
    const key = domain.toLowerCase()
    // Match the domain as a whole token so a shorter domain can't pick up a
    // longer domain's line (`solar.com` inside `mysolar.com` / `solar.com.au`).
    // Prefer a line that starts with the domain (the `domain => category`
    // shape the prompt asks for); fall back to a token match anywhere on the
    // line for output the model prefixed with numbering / bullets / markdown.
    const line =
      lines.find(l => startsWithDomainToken(l, key)) ?? lines.find(l => containsDomainToken(l, key))
    if (!line) continue
    const category = extractClassificationCategory(line)
    if (category) result[domain] = category
  }
  return result
}

/** A domain token can be extended left or right by these characters. */
function isDomainChar(ch: string): boolean {
  return /[a-z0-9.-]/.test(ch)
}

/**
 * True if `line` begins with `domain` as a complete token — the next character
 * can't be a domain character, or `solar.com` would match a `solar.com.au` line.
 */
function startsWithDomainToken(line: string, domain: string): boolean {
  return line.startsWith(domain) && !isDomainChar(line[domain.length] ?? '')
}

/**
 * True if `domain` appears anywhere in `line` as a complete token. The boundary
 * check stops a shorter domain from matching inside a longer one (`solar.com`
 * inside `mysolar.com`) once a numbering/bullet prefix has pushed the domain
 * off the start of the line.
 */
function containsDomainToken(line: string, domain: string): boolean {
  let idx = line.indexOf(domain)
  while (idx !== -1) {
    const before = line[idx - 1] ?? ''
    const after = line[idx + domain.length] ?? ''
    if (!isDomainChar(before) && !isDomainChar(after)) return true
    idx = line.indexOf(domain, idx + 1)
  }
  return false
}

function extractClassificationCategory(line: string): DiscoveryCompetitorType | null {
  // Read the category from the right of `=>` (the shape the prompt asks for)
  // so a category word inside the hostname can't pollute the match. Without an
  // arrow, scan the whole line — but each category must match as a whole
  // token, so `other` can't match inside a domain like `brothersolar.com`.
  const arrowIdx = line.indexOf('=>')
  const haystack = arrowIdx >= 0 ? line.slice(arrowIdx + 2) : line
  for (const { category, pattern } of CLASSIFICATION_CATEGORY_MATCHERS) {
    if (pattern.test(haystack)) return category
  }
  return null
}

/** Render a `LocationContext` as a human "City, Region, Country" line for the prompt. */
function formatLocationLine(location: LocationContext): string {
  return [location.city, location.region, location.country].map(part => part.trim()).filter(Boolean).join(', ')
}

/**
 * Build the location-constraint lines spliced into the seed prompt. Returns
 * `[]` for a project with no locations (seeding stays location-unaware).
 *
 * - one location  → a single "must be relevant to this service area" rule.
 * - 2+ locations  → lists every area plus a per-area quota of
 *   `floor(DEFAULT_SEED_COUNT / locationCount)` (min 1) so one service area
 *   cannot dominate the seed set.
 *
 * Exported for unit testing.
 */
export function buildLocationConstraint(locations: readonly LocationContext[]): string[] {
  if (locations.length === 0) return []
  const formatted = locations.map(formatLocationLine)
  if (locations.length === 1) {
    return [
      `The business serves ${formatted[0]}. Every query must be relevant to that service area — work the city or region into the query the way a real searcher would.`,
    ]
  }
  const perLocation = Math.max(1, Math.floor(DEFAULT_SEED_COUNT / locations.length))
  return [
    'The business serves these locations:',
    ...formatted.map(line => ` - ${line}`),
    `Generate at least ${perLocation} queries for EACH service area listed above so coverage stays balanced — do not let one area dominate. Every query must be relevant to at least one of these service areas, working the city or region into the query the way a real searcher would.`,
  ]
}

/**
 * Build the Gemini seed prompt. When `locations` is non-empty the prompt is
 * geo-constrained via `buildLocationConstraint` so discovered queries stay
 * inside the project's service area; otherwise the prompt is unchanged from
 * the pre-location behaviour. Exported for unit testing.
 */
export function buildSeedPrompt(input: {
  project: DiscoveryProjectContext
  icpDescription: string
  locations?: readonly LocationContext[]
}): string {
  const locationConstraint = buildLocationConstraint(input.locations ?? [])
  return [
    'You are an AEO (Answer Engine Optimization) analyst expanding a tracked-query basket for a customer.',
    '',
    `Customer: ${input.project.name} (domains: ${input.project.canonicalDomains.join(', ')})`,
    `ICP: ${input.icpDescription}`,
    ...(locationConstraint.length > 0 ? ['', ...locationConstraint] : []),
    '',
    'Brainstorm a wide set of queries a member of this ICP would type into an AI answer engine (Gemini, ChatGPT, Perplexity) when they are about to make a decision in this space. Aim for 30+ candidates covering:',
    ' - Comparison queries ("best X for Y")',
    ' - Specific feature / capability queries',
    ' - Pricing / vendor-shortlist queries',
    ' - Workflow / how-to queries',
    ' - Adjacent jobs-to-be-done queries',
    '',
    'Return ONE query per line. Plain text only — no numbering, bullets, quotes, or commentary.',
  ].join('\n')
}

function parseQueryLines(text: string, max: number): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of lines) {
    let line = raw.trim()
    if (!line) continue
    line = line.replace(/^\s*(?:\d+[.)]\s*|[-*•]\s*)/, '').replace(/^["']|["']$/g, '').trim()
    if (!line) continue
    if (/^(here are|sure|certainly|of course|i['']ve|these are|below are)/i.test(line)) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
    if (out.length >= max) break
  }
  return out
}

function writeDiscoveryInsight(
  db: DatabaseClient,
  input: {
    projectId: string
    runId: string
    sessionId: string
    seedProvider: string
    result: ExecuteDiscoveryResult
  },
): void {
  const { buckets, competitorMap } = input.result
  const totalProbes = buckets.cited + buckets.aspirational + buckets['wasted-surface']
  if (totalProbes === 0) return

  const wastedRatio = buckets['wasted-surface'] / totalProbes
  const citedRatio = buckets.cited / totalProbes
  // High severity if competitors are cited far more than the project, or if
  // the project is missing from 70%+ of the discovered basket. Medium
  // otherwise — the insight always fires so the operator has something to
  // hand to Aero in PR 1, but only the "you've got real divergence" case
  // calls them off the desk.
  const severity = wastedRatio >= 0.4 || (buckets['wasted-surface'] > buckets.cited && wastedRatio >= 0.2)
    ? 'high'
    : citedRatio >= 0.6
      ? 'low'
      : 'medium'

  const topCompetitors = competitorMap.slice(0, 5)
  const title = buildDiscoveryInsightTitle({
    cited: buckets.cited,
    wasted: buckets['wasted-surface'],
    aspirational: buckets.aspirational,
    totalProbes,
  })

  // Dismiss prior basket-divergence insights for this project before
  // writing the new one. The insight is session-level — every discovery
  // run produces one. Without this dedup, every session leaves a fresh
  // insight in the active list AND keeps the older ones around, drowning
  // the analyst's view (12 stale entries after 12 sessions, as observed
  // on azcoatings May 2026). The newest session's findings supersede the
  // older ones by definition, so auto-dismiss is the right semantic.
  db.transaction((tx) => {
    tx.update(insights)
      .set({ dismissed: true })
      .where(and(
        eq(insights.projectId, input.projectId),
        eq(insights.type, 'discovery.basket-divergence'),
        eq(insights.dismissed, false),
      ))
      .run()

    tx.insert(insights).values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      runId: input.runId,
      type: 'discovery.basket-divergence',
      severity,
      title,
      // query/provider fields don't fit the visibility-snapshot model for
      // a session-level insight. Use the session marker so the
      // (query, provider) index stays distinct across sessions; PR 5 will
      // formalize a session-scoped insight subtype.
      query: `discovery:${input.sessionId}`,
      provider: input.seedProvider,
      recommendation: JSON.stringify({
        action: 'review-discovered-basket',
        summary: `Run \`canonry discover show ${input.sessionId} --format json\` to inspect the per-query breakdown, then \`canonry discover promote <project> ${input.sessionId}\` to merge cited + aspirational findings into the project.`,
        bucketCounts: buckets,
        topCompetitors,
      }),
      cause: JSON.stringify({
        sessionId: input.sessionId,
        totalProbes,
        seedProvider: input.seedProvider,
      }),
      dismissed: false,
      createdAt: new Date().toISOString(),
    }).run()
  })
}

function buildDiscoveryInsightTitle(input: {
  cited: number
  wasted: number
  aspirational: number
  totalProbes: number
}): string {
  const parts: string[] = []
  parts.push(`Discovery probed ${input.totalProbes} representative queries`)
  if (input.wasted > 0) parts.push(`${input.wasted} where competitors are cited but you are not`)
  if (input.cited > 0) parts.push(`${input.cited} where you are cited`)
  if (input.aspirational > 0) parts.push(`${input.aspirational} aspirational greenfield queries`)
  return parts.join(' • ')
}

/** Re-export so the canonry-side has one place to import the orchestrator hook. */
export type {
  DiscoveryDeps,
  DiscoveryDomainClassification,
  DiscoveryProjectContext,
  DiscoverySeedResult,
  DiscoveryProbeResult,
}
