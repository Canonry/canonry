import crypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import {
  competitors,
  insights,
  projects,
  runs,
} from '@ainyc/canonry-db'
import {
  determineAnswerMentioned,
  DiscoveryCompetitorTypes,
  effectiveBrandNames,
  effectiveDomains,
  isRetryableHttpError,
  RunStatuses,
  withRetry,
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

/**
 * Embedding-call resilience. The embed sits BETWEEN two paid grounded Gemini
 * calls (seed before it, probes after) — a transient blip here used to throw
 * away an already-paid seed call and fail the whole session. Retry transient
 * failures (429/5xx/network, per `isRetryableHttpError`) with the shared
 * jittered backoff; a permanent failure (4xx auth/validation) still fails the
 * session immediately. Each attempt is bounded by a wall-clock timeout so a
 * hung connection cannot wedge the session past the route's zombie window.
 */
export const EMBED_RETRY_MAX_RETRIES = 3
export const EMBED_RETRY_MAX_DELAY_MS = 10_000
export const EMBED_ATTEMPT_TIMEOUT_MS = 60_000

/** Race `promise` against a wall-clock ceiling. The timeout Error carries no
 *  `.status`, so `isRetryableHttpError` treats it as transient (retryable). */
function withAttemptTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err: unknown) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))) },
    )
  })
}

/**
 * Wrap a raw embedding call with the transient-failure retry policy above.
 * `fn` is invoked fresh per attempt. Exported (with injectable knobs) so the
 * policy is unit-testable without the Gemini client.
 */
export async function embedWithRetry(
  fn: () => Promise<number[][]>,
  opts: {
    maxRetries?: number
    attemptTimeoutMs?: number
    sleep?: (ms: number) => Promise<void>
    onRetry?: (info: { attempt: number; err: unknown; delayMs: number }) => void
  } = {},
): Promise<number[][]> {
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? EMBED_ATTEMPT_TIMEOUT_MS
  return withRetry(
    () => withAttemptTimeout(fn(), attemptTimeoutMs, 'Discovery embedding call'),
    {
      maxRetries: opts.maxRetries ?? EMBED_RETRY_MAX_RETRIES,
      isRetryable: isRetryableHttpError,
      maxDelayMs: EMBED_RETRY_MAX_DELAY_MS,
      sleep: opts.sleep,
      onRetry: opts.onRetry ?? (({ attempt, delayMs }) => {
        log.warn('discovery.embed.retry', { attempt, delayMs })
      }),
    },
  )
}

/**
 * Per-intent-bucket quota the seed prompt requests. Multiplied by the five
 * intent buckets (informational / commercial / navigational / comparative /
 * transactional) it yields {@link DEFAULT_SEED_COUNT}. The bucket structure
 * is what stops Gemini from collapsing the candidate list into 30+ near-
 * synonyms of a single intent (issue #505) — semantically distinct intents
 * cluster apart at the dedup threshold, producing multiple representatives
 * and therefore multiple probes per session.
 */
const QUERIES_PER_INTENT_BUCKET = 6

export interface ExecuteDiscoveryRunOptions {
  db: DatabaseClient
  registry: ProviderRegistry
  runId: string
  sessionId: string
  projectId: string
  icpDescription: string
  /**
   * Who evaluates or buys the offering, separate from what is sold. Forwarded
   * to the seed prompt: when present, every generated query must be one this
   * buyer would plausibly type.
   */
  buyerDescription?: string
  dedupThreshold?: number
  maxProbes?: number
  /**
   * Probe worker-pool width, forwarded to the orchestrator. Omitted = 1
   * (strictly serial); the orchestrator clamps to the contract cap.
   */
  probeConcurrency?: number
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
      ownedDomains: projectRow.ownedDomains,
    })
    // Brand identity for answer-text mention matching, same shape the
    // answer-visibility snapshot writer (job-runner) uses.
    const brandNames = effectiveBrandNames({
      displayName: projectRow.displayName,
      aliases: projectRow.aliases,
    })

    const project: DiscoveryProjectContext = {
      id: projectRow.id,
      name: projectRow.name,
      brandNames,
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
      buyerDescription: opts.buyerDescription,
      dedupThreshold: opts.dedupThreshold,
      maxProbes: opts.maxProbes,
      probeConcurrency: opts.probeConcurrency,
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
export function buildDefaultDeps(registry: ProviderRegistry): DiscoveryDeps {
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
        // Session diagnostics: the raw-candidate split by source, persisted on
        // discovery_sessions so seed-quality calibration is measurable.
        fromAnswerCount: fromAnswer.length,
        fromGroundingCount: fromGrounding.length,
      }
    },
    async embed(queries: string[]): Promise<number[][]> {
      const apiKey = cfg.apiKey
      if (apiKey) {
        // The embed sits between two paid grounded calls (seed already spent,
        // probes not yet started) — retry transient failures so a blip does
        // not discard the paid seed; a permanent failure still fails the session.
        return embedWithRetry(() => embedQueries(queries, { apiKey, baseUrl: cfg.baseUrl }))
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
          // Same geo mechanism as sweeps: the provider renders the location
          // into the prompt so the probe measures from the buyer's area.
          ...(input.location ? { location: input.location } : {}),
        },
        cfg,
      )
      const normalized = adapter.normalizeResult(raw)
      const canonical = new Set(input.project.canonicalDomains.map(d => d.toLowerCase()))
      const isCited = normalized.citedDomains.some(d => canonical.has(d.toLowerCase()))
      // Mention is the answer-TEXT signal, independent of the citation/source
      // signal above. Same deterministic helper the answer-visibility snapshot
      // writer uses, so discovery and sweeps agree on what "mentioned" means.
      const answerMentioned = determineAnswerMentioned(
        normalized.answerText,
        input.project.brandNames ?? [],
        input.project.canonicalDomains,
      )
      return {
        citationState: isCited ? 'cited' : 'not-cited',
        citedDomains: normalized.citedDomains,
        answerMentioned,
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
  buyerDescription?: string
  locations?: readonly LocationContext[]
}): string {
  const locationConstraint = buildLocationConstraint(input.locations ?? [])
  const currentYear = new Date().getFullYear()
  const buyer = input.buyerDescription?.trim() ?? ''
  const brandIdentities = [...(input.project.brandNames ?? []), ...input.project.canonicalDomains]
  return [
    'You are an AEO (Answer Engine Optimization) analyst expanding a tracked-query basket for a customer.',
    '',
    `Customer: ${input.project.name} (domains: ${input.project.canonicalDomains.join(', ')})`,
    `ICP: ${input.icpDescription}`,
    ...(buyer
      ? [
          `Buyer: ${buyer}`,
          'Every query must be one this buyer would plausibly type into an answer engine. Skip queries only an industry insider, investor, or job seeker would ask.',
        ]
      : []),
    ...(locationConstraint.length > 0 ? ['', ...locationConstraint] : []),
    '',
    'Brainstorm queries a member of this ICP would type into an AI answer engine (Gemini, ChatGPT, Perplexity). Generate candidates across the five intent buckets below — these are SEMANTICALLY DISTINCT search intents, not stylistic variants. A query should fit one bucket cleanly. Diversity across buckets is the point: it keeps the list from collapsing into near-synonyms of a single intent.',
    '',
    ' 1. Informational — the searcher wants to understand a concept, market, or problem. Templates: "what is X", "how does X work", "X explained", "why X matters".',
    ` 2. Commercial — the searcher is researching category leaders before a purchase. Templates: "best X for Y", "top X ${currentYear}", "leading X providers", "X for [use case]".`,
    ' 3. Navigational — the searcher is looking for a specific brand, place, or directory. Templates: "X near me", "X reviews", "X website", "X directory".',
    ' 4. Comparative — the searcher is weighing named alternatives head-to-head. Templates: "X vs Y", "X or Y for Z", "alternatives to X".',
    ' 5. Transactional — the searcher is ready to act on a purchase or booking. Templates: "book X", "X pricing", "X discount code", "buy X online".',
    '',
    `Hard rule: NEVER include the customer's own brand name or domain (${brandIdentities.join(', ') || input.project.name}) in any query. A buyer who already knows the business by name is out of scope for this list; the goal is queries where the customer must EARN the mention. Naming competitors or directories is fine (Navigational queries should target directories and platforms, never the customer).`,
    '',
    `Generate EXACTLY ${QUERIES_PER_INTENT_BUCKET} queries per bucket — ${QUERIES_PER_INTENT_BUCKET * 5} total. Return ONE query per line. Plain text only — no numbering, bullets, quotes, bucket labels, or commentary.`,
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
    if (/^(?:here are|sure|certainly|of course|i[’']ve|these are|below are)/i.test(line)) continue
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
      recommendation: {
        action: 'review-discovered-basket',
        target: input.sessionId,
        reason: `Run \`canonry discover show ${input.sessionId} --format json\` to inspect the per-query breakdown, then \`canonry discover promote <project> ${input.sessionId}\` to merge cited + aspirational findings into the project. Top competitors: ${topCompetitors.map(c => c.domain).join(', ') || 'none'} | Buckets: cited=${buckets.cited} aspirational=${buckets.aspirational} wasted=${buckets['wasted-surface']}`,
      },
      cause: {
        cause: `Discovery session ${input.sessionId} probed ${totalProbes} representative queries via ${input.seedProvider}`,
        details: `sessionId=${input.sessionId}, totalProbes=${totalProbes}, seedProvider=${input.seedProvider}`,
      },
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
