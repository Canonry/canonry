import { z } from 'zod'
import { citationStateSchema } from './run.js'
import { cosineSimilarity } from './embeddings.js'
import { hostOf } from './url-normalize.js'
import { locationContextSchema } from './provider.js'

export const discoveryBucketSchema = z.enum(['cited', 'aspirational', 'wasted-surface'])
export type DiscoveryBucket = z.infer<typeof discoveryBucketSchema>
export const DiscoveryBuckets = discoveryBucketSchema.enum
export const DEFAULT_DISCOVERY_PROMOTE_BUCKETS = [
  DiscoveryBuckets.cited,
  DiscoveryBuckets.aspirational,
] as const satisfies readonly DiscoveryBucket[]
export const DISCOVERY_PROMOTE_COMPETITOR_CAP = 20
export const DISCOVERY_PROMOTE_COMPETITOR_MIN_HITS = 2

/**
 * Classification of a cited domain in a discovery session's competitor map.
 * The orchestrator runs one AI call per session post-probe to type every
 * recurring cited domain so promotion can promote real competitors and
 * suppress the noise (OTAs, editorial round-ups, off-topic sites).
 *
 * - `direct-competitor` — a business competing for the same customers as the
 *   project (another hotel, another tool in the category). Promotable.
 * - `ota-aggregator`   — online travel agencies, marketplaces, directories,
 *   review aggregators that list many businesses (expedia.com, booking.com,
 *   g2.com, yelp.com). Suppressed from competitor tracking by default.
 * - `editorial-media`  — news, blogs, "best of" listicles, editorial round-ups
 *   (timeout.com, a personal blog). A channel to earn placement in, not a
 *   competitor — suppressed by default, promotable with an explicit override.
 * - `other`            — government sites, social platforms, anything off the
 *   competitive map. Suppressed.
 * - `unknown`          — not yet classified: pre-classification sessions, a
 *   classification call that failed, or a domain the model skipped. The
 *   default for any competitor-map entry without an explicit type.
 */
export const discoveryCompetitorTypeSchema = z.enum([
  'direct-competitor',
  'ota-aggregator',
  'editorial-media',
  'other',
  'unknown',
])
export type DiscoveryCompetitorType = z.infer<typeof discoveryCompetitorTypeSchema>
export const DiscoveryCompetitorTypes = discoveryCompetitorTypeSchema.enum

/**
 * Competitor types `canonry discover promote` adopts when the caller does not
 * pass an explicit `competitorTypes` override. Only `direct-competitor` is
 * promoted by default — aggregators, editorial media, and `other` are noise
 * for a tracked-competitor watchlist. Legacy `unknown` entries are excluded by
 * this default; pass `competitorTypes: ['unknown']` to recover a
 * pre-classification session.
 */
export const DEFAULT_DISCOVERY_PROMOTE_COMPETITOR_TYPES = [
  DiscoveryCompetitorTypes['direct-competitor'],
] as const satisfies readonly DiscoveryCompetitorType[]

export const discoverySessionStatusSchema = z.enum(['queued', 'seeding', 'probing', 'completed', 'failed'])
export type DiscoverySessionStatus = z.infer<typeof discoverySessionStatusSchema>
export const DiscoverySessionStatuses = discoverySessionStatusSchema.enum

export const discoveryCompetitorMapEntrySchema = z.object({
  domain: z.string().min(1),
  hits: z.number().int().positive(),
  /**
   * Domain classification from the session's post-probe AI classification
   * pass. Defaults to `unknown` so competitor maps persisted before
   * classification existed (or by a session whose classification call failed)
   * still parse — those entries are excluded from the default promote filter.
   */
  competitorType: discoveryCompetitorTypeSchema.default('unknown'),
})
export type DiscoveryCompetitorMapEntry = z.infer<typeof discoveryCompetitorMapEntrySchema>

export const discoveryProbeDtoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  projectId: z.string(),
  query: z.string(),
  bucket: discoveryBucketSchema.nullable().default(null),
  citationState: citationStateSchema,
  citedDomains: z.array(z.string()).default([]),
  // Answer-text mention signal, independent of citationState. Tri-state: true
  // (named in the answer prose), false (probed, not named), null (unknown: a
  // legacy probe written before the engine computed it). Consumers must treat
  // null as unknown, never as false.
  answerMentioned: z.boolean().nullable().default(null),
  createdAt: z.string(),
})
export type DiscoveryProbeDto = z.infer<typeof discoveryProbeDtoSchema>

export const discoverySessionDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: discoverySessionStatusSchema,
  icpDescription: z.string().nullable().optional(),
  seedProvider: z.string().nullable().optional(),
  seedCountRaw: z.number().int().nullable().optional(),
  seedCount: z.number().int().nullable().optional(),
  /**
   * Diagnostics: how many raw seed candidates came from the model's answer
   * text vs. from the grounding fan-out (the search queries the engine
   * actually issued). Recorded at seed time so seed-quality calibration is
   * measurable per session. Null on legacy sessions (or when a seed dep does
   * not report the split). Purely additive — no gate or warning reads these.
   */
  seedFromAnswerCount: z.number().int().nullable().optional(),
  seedFromGroundingCount: z.number().int().nullable().optional(),
  /**
   * Diagnostics: how many raw seed candidates were dropped by the branded
   * self-query filter before seedCountRaw was recorded (the customer's own
   * brand or domain in the query text). Null on legacy sessions. Purely
   * additive: no gate or warning reads it.
   */
  seedBrandFilteredCount: z.number().int().nullable().optional(),
  /** Buyer definition the session was seeded with (part of session identity
   *  for in-flight consolidation). Null on legacy / no-buyer sessions. */
  buyerDescription: z.string().nullable().optional(),
  /** Resolved service areas the session was seeded/probed with (part of
   *  session identity for in-flight consolidation). Null on legacy sessions. */
  locations: z.array(locationContextSchema).nullable().optional(),
  /** Seed provenance: the seed dep's original candidate list (pre-filter),
   *  so filter/dedup changes replay against real sessions. Null on legacy. */
  seedRawCandidates: z.array(z.string()).nullable().optional(),
  /** Dedup calibration: min pairwise cosine per multi-member cluster. */
  dedupClusterMinSims: z.array(z.number()).nullable().optional(),
  /** Dedup calibration: fraction of all pairs in the ambiguous 0.90-0.97 band. */
  dedupBandPairFraction: z.number().nullable().optional(),
  dedupPairsTotal: z.number().int().nullable().optional(),
  /** Seed provider set the session ran with (canonical order); null = legacy /
   *  Gemini-only default. */
  seedProviders: z.array(z.string()).nullable().optional(),
  /** Raw candidate count contributed per seed provider. */
  seedProviderCounts: z.record(z.string(), z.number().int()).nullable().optional(),
  /** True post-dedup canonical count BEFORE the probe-budget slice (seedCount
   *  is post-truncation). Null on legacy sessions. */
  canonicalCount: z.number().int().nullable().optional(),
  dedupThreshold: z.number().nullable().optional(),
  probeCount: z.number().int().nullable().optional(),
  citedCount: z.number().int().nullable().default(null),
  aspirationalCount: z.number().int().nullable().default(null),
  wastedCount: z.number().int().nullable().default(null),
  competitorMap: z.array(discoveryCompetitorMapEntrySchema).default([]),
  /**
   * Non-fatal operator warning recorded while the session ran (currently the
   * seed dedup collapse guard). The session still completes; the warning flags
   * that its coverage may be misleading.
   */
  warning: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  createdAt: z.string(),
})
export type DiscoverySessionDto = z.infer<typeof discoverySessionDtoSchema>

export const discoverySessionDetailDtoSchema = discoverySessionDtoSchema.extend({
  probes: z.array(discoveryProbeDtoSchema).default([]),
})
export type DiscoverySessionDetailDto = z.infer<typeof discoverySessionDetailDtoSchema>

/**
 * Per-session probe budget ceiling. Spec §9 caps per-session at 100 by default
 * and 500 absolute; the contract enforces the absolute cap here so a bad input
 * cannot burn through quota before the service-layer guard kicks in.
 */
export const DISCOVERY_MAX_PROBES_CAP = 500

/**
 * Ceiling on how many discovery probes may be in flight at once. Each probe is
 * a paid grounded Gemini call (~7s wall-clock); the orchestrator runs them
 * through a bounded worker pool. The default is 1 (strictly serial — the
 * pre-concurrency behaviour); callers opt in per request via
 * `probeConcurrency`, and the cap keeps a bad input from stampeding the
 * provider's rate limits.
 */
export const DISCOVERY_PROBE_CONCURRENCY_CAP = 8

/** Default probe concurrency when the request does not opt in: strictly serial. */
export const DISCOVERY_DEFAULT_PROBE_CONCURRENCY = 1

/**
 * Default cosine-similarity threshold for seed dedup clustering.
 *
 * Calibrated against gemini-embedding-001 (CLUSTERING task, 768 dims), the
 * embedding model the discovery pipeline uses for seeds. Measured bands:
 *
 *   - distinct buyer intents in a homogeneous local-service vertical
 *     ("emergency repair near me" vs "how much does a replacement cost" vs
 *     "will insurance cover the damage") score ~0.82-0.91 pairwise;
 *   - true near-duplicate phrasings of one intent score ~0.987-0.998.
 *
 * The threshold must sit in the gap BETWEEN those bands. The previous default
 * (0.85) sat inside the distinct-intent band, and because `clusterByCosine`
 * is single-link, one chain of >= 0.85 neighbors merged the entire seed set
 * into a single canonical query for homogeneous verticals. 0.95 keeps
 * distinct intents apart while still collapsing genuine rephrasings.
 */
export const DISCOVERY_DEFAULT_DEDUP_THRESHOLD = 0.95

/**
 * Degenerate seed-collapse guard: dedup is expected to trim a seed set, not
 * vaporize it. When the canonical count falls to this fraction of the raw
 * candidate count OR BELOW (inclusive — retaining exactly 6 of 30 warns), the
 * clustering almost certainly chained distinct intents together and the
 * session's coverage is misleading.
 */
export const DISCOVERY_SEED_COLLAPSE_RATIO = 0.2

/**
 * Minimum raw candidate count before the collapse guard applies. Tiny seed
 * sets can legitimately dedup to one or two canonicals; flagging those would
 * be noise.
 */
export const DISCOVERY_SEED_COLLAPSE_MIN_RAW = 10

/**
 * Build the operator-facing warning for a degenerate seed-dedup collapse, or
 * `null` when the dedup outcome is healthy. Callers must pass the canonical
 * count BEFORE any probe-budget truncation: a deliberately small `maxProbes`
 * shrinks the probed set without indicating a clustering problem.
 */
export function seedCollapseWarning(input: {
  seedCountRaw: number
  canonicalCount: number
  dedupThreshold: number
}): string | null {
  const { seedCountRaw, canonicalCount, dedupThreshold } = input
  if (seedCountRaw < DISCOVERY_SEED_COLLAPSE_MIN_RAW) return null
  // Inclusive threshold: retention AT the collapse ratio is already degenerate
  // (6 of 30 = 0.20 warns), so only strictly-above passes as healthy. A `>=`
  // here let the exact-boundary session slip through unwarned.
  if (canonicalCount / seedCountRaw > DISCOVERY_SEED_COLLAPSE_RATIO) return null
  const noun = canonicalCount === 1 ? 'query' : 'queries'
  return (
    `Seed dedup collapsed ${seedCountRaw} raw candidates into ${canonicalCount} canonical ${noun} ` +
    `at threshold ${dedupThreshold}. Distinct intents were likely merged into one cluster; ` +
    `re-run with a higher --dedup-threshold.`
  )
}

/**
 * Seed hygiene: split raw seed candidates into branded self-queries (the
 * customer's own brand name or domain appears in the query text) and everything
 * else. Branded self-queries measure brand recall, not buyer visibility: the
 * searcher already knows the business by name, the product's own taxonomy
 * excludes branded-navigational clusters from ad groups, and on invisible
 * domains they waste probe budget without even inflating the cited signal.
 *
 * MUST run on the RAW candidate list BEFORE `seedCountRaw` is recorded:
 * per-session brand shares of 37-60% were observed live, and filtering after
 * the count would deflate the retention ratio and false-trip collapse guards.
 *
 * Matching is deliberately conservative:
 *  - brand names match as whole-token phrases (case- and whitespace-insensitive),
 *    plus their squashed form ("AZ Coatings" also matches "azcoatings") when it
 *    is 4+ characters;
 *  - canonical domains match as full hosts with and without "www."
 *    ("azcoatings.com", "www.azcoatings.com") but NEVER as the bare label —
 *    a business at roofing.com must not drop every "roofing" query;
 *  - competitor brand names are untouched (only the customer's identities are
 *    filtered), so comparative queries between competitors survive.
 */
export function filterBrandedSeedCandidates(input: {
  candidates: readonly string[]
  /** The customer's brand identities (effectiveBrandNames output). */
  brandNames: readonly string[]
  canonicalDomains: readonly string[]
}): { kept: string[]; droppedBranded: string[] } {
  const tokens = brandMatchTokens(input.brandNames, input.canonicalDomains)
  if (tokens.length === 0) return { kept: [...input.candidates], droppedBranded: [] }
  const kept: string[] = []
  const droppedBranded: string[] = []
  for (const candidate of input.candidates) {
    const normalized = normalizeForBrandMatch(candidate)
    if (tokens.some(token => containsWholeToken(normalized, token))) droppedBranded.push(candidate)
    else kept.push(candidate)
  }
  return { kept, droppedBranded }
}

function normalizeForBrandMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function brandMatchTokens(brandNames: readonly string[], canonicalDomains: readonly string[]): string[] {
  const tokens = new Set<string>()
  for (const name of brandNames) {
    const normalized = normalizeForBrandMatch(name)
    // One- or two-character "brands" ("A", "GO") are indistinguishable from
    // ordinary words; matching them would shred generic queries.
    if (normalized.length < 3) continue
    tokens.add(normalized)
    const squashed = normalized.replace(/[^a-z0-9]/g, '')
    if (squashed.length >= 4 && squashed !== normalized) tokens.add(squashed)
  }
  for (const domain of canonicalDomains) {
    // Configured domains arrive raw (project upsert/apply store them as
    // given), so a value like "https://www.Example.com/path" must still
    // yield the "example.com" token. hostOf is the canonical extractor;
    // fall back to the normalized raw string for values it cannot parse.
    const host = hostOf(domain) ?? normalizeForBrandMatch(domain).replace(/^www\./, '')
    if (!host) continue
    tokens.add(host)
    tokens.add(`www.${host}`)
  }
  return [...tokens]
}

/** Whole-token containment: the match must not extend an adjacent alphanumeric
 *  run ("subclassing" never matches "class"; "azcoatings.com/reviews" matches
 *  "azcoatings.com" because "/" is a boundary). */
function containsWholeToken(normalized: string, token: string): boolean {
  let index = normalized.indexOf(token)
  while (index !== -1) {
    const before = index === 0 ? ' ' : normalized[index - 1]!
    const afterIndex = index + token.length
    const after = afterIndex >= normalized.length ? ' ' : normalized[afterIndex]!
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true
    index = normalized.indexOf(token, index + 1)
  }
  return false
}

/** Providers able to generate seed candidates (v1: the two whose phrasing
 *  distributions the product measures against). Embeddings stay Gemini. */
export const DISCOVERY_SEED_PROVIDERS = ['gemini', 'openai'] as const
export const discoverySeedProviderSchema = z.enum(DISCOVERY_SEED_PROVIDERS)
export type DiscoverySeedProvider = z.infer<typeof discoverySeedProviderSchema>

export const discoveryRunRequestSchema = z.object({
  icpDescription: z.string().min(1).optional(),
  /**
   * Who evaluates or buys the offering, separate from what is sold
   * (icpDescription). When present, the seed prompt anchors every generated
   * query on this buyer, so discovery selects buyer-fit demand instead of
   * generic provider comparisons.
   */
  buyerDescription: z.string().min(1).optional(),
  /**
   * Which providers generate seed candidates. Omitted = Gemini-only (the
   * historical behaviour). Canonicalized (deduped + sorted) so the value is
   * stable for session-identity comparison. Part of the consolidation
   * IDENTITY: a different provider set produces a different phrasing
   * distribution, so it must never reuse another set's session.
   */
  seedProviders: z
    .array(discoverySeedProviderSchema)
    .min(1)
    .transform((arr) => [...new Set(arr)].sort())
    .optional(),
  dedupThreshold: z.number().min(0).max(1).optional(),
  maxProbes: z.number().int().positive().max(DISCOVERY_MAX_PROBES_CAP).optional(),
  /**
   * How many probes may run in parallel for this session. Defaults to
   * `DISCOVERY_DEFAULT_PROBE_CONCURRENCY` (1 — strictly serial, the historical
   * behaviour) when omitted; capped at `DISCOVERY_PROBE_CONCURRENCY_CAP`.
   * Probe results are persisted in canonical order regardless of concurrency,
   * so this only changes wall-clock time, never output order.
   */
  probeConcurrency: z.number().int().min(1).max(DISCOVERY_PROBE_CONCURRENCY_CAP).optional(),
  /**
   * Optional override of the project's location labels, constraining seed
   * generation to a subset of the configured service areas. Each label must
   * match a configured project location (resolved server-side via
   * `resolveLocations`). Omitted means "use every project location" — a
   * project with no locations is unaffected.
   */
  locations: z.array(z.string().min(1)).optional(),
})
export type DiscoveryRunRequest = z.infer<typeof discoveryRunRequestSchema>

/**
 * `POST /projects/:name/discover/sessions/:id/promote` request.
 *
 * - `buckets` — which probe buckets to adopt into the tracked basket. Omitted
 *   means the production-safe default (`cited`, `aspirational`). Include
 *   `wasted-surface` explicitly when off-ICP competitor gaps should also be
 *   tracked.
 * - `includeCompetitors` — whether to also merge the session's discovered
 *   competitor domains into the project. Omitted means `true`; only recurring
 *   domains with at least `DISCOVERY_PROMOTE_COMPETITOR_MIN_HITS` hits are
 *   eligible.
 * - `competitorTypes` — which classified competitor types to merge. Omitted
 *   means `DEFAULT_DISCOVERY_PROMOTE_COMPETITOR_TYPES` (`direct-competitor`
 *   only). Pass an explicit list to also adopt `editorial-media` channels or
 *   to recover legacy `unknown` entries. Ignored when `includeCompetitors` is
 *   `false`.
 */
export const discoveryPromoteRequestSchema = z.object({
  buckets: z.array(discoveryBucketSchema).min(1).optional(),
  includeCompetitors: z.boolean().optional(),
  competitorTypes: z.array(discoveryCompetitorTypeSchema).min(1).optional(),
})
export type DiscoveryPromoteRequest = z.infer<typeof discoveryPromoteRequestSchema>

/**
 * `GET .../promote` response — a read-only preview of what a promote would
 * persist. Bucketed query lists plus competitor domains not already tracked.
 */
export const discoveryPromotePreviewSchema = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  status: discoverySessionStatusSchema,
  queriesByBucket: z.object({
    cited: z.array(z.string()),
    aspirational: z.array(z.string()),
    'wasted-surface': z.array(z.string()),
  }),
  suggestedCompetitors: z.array(discoveryCompetitorMapEntrySchema),
})
export type DiscoveryPromotePreview = z.infer<typeof discoveryPromotePreviewSchema>

/**
 * `POST .../promote` response. Promotion is add-only and idempotent: queries
 * and competitor domains already tracked by the project land in `skipped`
 * rather than being inserted twice, so re-running a promote is safe.
 */
export const discoveryPromoteResultSchema = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  promoted: z.object({
    queries: z.array(z.string()),
    competitors: z.array(z.string()),
  }),
  skipped: z.object({
    queries: z.array(z.string()),
    competitors: z.array(z.string()),
  }),
})
export type DiscoveryPromoteResult = z.infer<typeof discoveryPromoteResultSchema>

/**
 * `queries.provenance` / `competitors.provenance` value vocabulary.
 *
 * - `'cli'` — operator-entered via `canonry query add` / `competitor add` (or
 *   the v55 backfill for pre-discovery rows).
 * - `'discovery:<sessionId>'` — adopted out of a discovery session via
 *   `canonry discover promote`.
 *
 * NULL means a post-v55 row whose writer forgot to set provenance; treat as a
 * bug rather than as a meaningful state.
 */
export const queryProvenanceSchema = z.union([
  z.literal('cli'),
  z.string().regex(/^discovery:.+$/),
])
export type QueryProvenance = z.infer<typeof queryProvenanceSchema>

// ─── Probe fan-out harvest (issue #713) ──────────────────────────────────────
//
// A grounded answer engine returns the search queries it actually issued to
// answer a prompt — Gemini `groundingMetadata.webSearchQueries`, OpenAI
// `web_search_call.action.queries`, Claude `server_tool_use` web-search input.
// Discovery already persists the full provider payload on every
// `discovery_probes.raw_response`, so those issued queries can be read back as
// candidate seeds with NO new model call.
//
// These are a THIRD signal — *issued retrieval queries* — distinct from
// "mention" (`answer_mentioned`, brand named in the answer text) and "cited"
// (`citation_state`, domain in the source list). Never conflate them: a
// harvested query is what the model SEARCHED, not demand and not a citation.
//
// The harvest is surfaced read-only for an operator/agent to review; it is
// never auto-probed or auto-promoted (issue #713 expert-panel guidance — the
// risk is a model→harvest→track→model feedback loop). The quality gate below
// is mandatory and runs BEFORE a candidate is admitted: roughly half a raw
// harvest is navigational, over-specific, or already-tracked noise, and the
// noise is worst exactly where the seed universe is thin/ambiguous.
//
// Novelty (is a candidate already covered by a tracked query?) runs in two
// stages: a cheap pure-lexical EXACT match in `gateHarvestedSearchQueries`,
// then — when embeddings are available — a SEMANTIC pass
// (`applyHarvestSemanticNovelty`) that drops a candidate whose embedding is
// within the cosine novelty threshold of any tracked query. The semantic pass
// is what catches synonyms / paraphrases / stem variants that a token-overlap
// measure is blind to, and it reuses the same cosine machinery
// (`cosineSimilarity`) and calibrated threshold the discovery seed pipeline
// already uses to decide "are these the same query intent?".

/** Max word count for an admitted harvested query. Longer strings are
 *  over-specific retrieval phrasings that won't generalize as tracked queries. */
export const DISCOVERY_HARVEST_MAX_WORDS = 12

/** Min normalized character length for an admitted harvested query. */
export const DISCOVERY_HARVEST_MIN_CHARS = 3

/** Cosine similarity at/above which a harvested candidate's embedding is treated
 *  as a semantic duplicate of an already-tracked query (and dropped for
 *  novelty). Reuses `DISCOVERY_DEFAULT_DEDUP_THRESHOLD` — the value the discovery
 *  seed pipeline calibrated against `gemini-embedding-001` to separate
 *  "near-duplicate phrasings" (≈0.987+) from "distinct buyer intents" (≈0.82–0.91).
 *  Sitting in that gap, it collapses true rephrasings of a tracked query while
 *  keeping a distinct-but-adjacent intent (which is exactly the new coverage the
 *  harvest exists to surface). */
export const DISCOVERY_HARVEST_NOVELTY_THRESHOLD = DISCOVERY_DEFAULT_DEDUP_THRESHOLD

/** Min significant subject terms required before the anchor engages. Set to 1:
 *  the anchor stays ON whenever the corpus (ICP + tracked queries + the labels
 *  of every owned domain — see `buildHarvestAnchorTerms`) yields ANY subject
 *  term, and stands down only when there is no subject signal at all.
 *  Thin/new projects are exactly where the fan-out's off-subject acronym
 *  collisions peak, so the anchor must not silently skip there and flood the
 *  operator with noise (issue #713). Trade-off accepted deliberately: with a
 *  sparse or abstract corpus the lexical OR-anchor (no stemming) can be
 *  over-aggressive and drop on-subject candidates — `anchor=false` is the recall
 *  escape, and the response reports `anchorApplied` so the operator knows. */
export const DISCOVERY_HARVEST_MIN_ANCHOR_TERMS = 1

/** Min length of a CONTIGUOUS run of digits for a harvested query to read as a
 *  phone/number lookup (navigational). A contiguous run — not a total digit
 *  count — so a query mentioning several years or model numbers
 *  ("iphone 15 pro 2024 2025", max run 4) never trips it, while an unformatted
 *  phone string ("5125550143", run 10) does. Formatted phones with separators
 *  are instead caught by the "phone number" word marker. */
export const DISCOVERY_HARVEST_PHONE_DIGITS = 7

/** Min length of a "significant" token used for anchoring + dedup novelty. */
const HARVEST_SIGNIFICANT_TOKEN_MIN = 4

const HARVEST_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'near', 'best', 'top', 'your', 'you', 'are',
  'how', 'what', 'does', 'this', 'that', 'from', 'into', 'about', 'who', 'why',
])

/** Whole-word/phrase navigational markers — a harvested query containing one is
 *  a name/address/phone style lookup, not a buyer-intent query worth tracking.
 *  Deliberately conservative (does NOT include "reviews"/"website"/"near me",
 *  which carry real local buyer intent) to avoid dropping useful candidates. */
const HARVEST_NAV_MARKERS: readonly string[] = [
  'address', 'directions', 'hours', 'login', 'log in', 'sign in', 'signin',
  'phone number', 'zip code', 'postal code', 'email address',
]

/** One harvested candidate: the normalized issued query + how many distinct
 *  probes in the session issued it (recurrence = confidence). */
export const discoveryHarvestCandidateSchema = z.object({
  query: z.string().min(1),
  probeHits: z.number().int().positive(),
})
export type DiscoveryHarvestCandidate = z.infer<typeof discoveryHarvestCandidateSchema>

export const discoveryHarvestStatsSchema = z.object({
  /** Distinct candidates extracted before gating. */
  rawCandidates: z.number().int().nonnegative(),
  /** Candidates that passed every gate. */
  admitted: z.number().int().nonnegative(),
  /** Per-reason rejection tally (each rejected candidate counted exactly once,
   *  at the first gate it failed). Lexical-gate order: belowFloor → length →
   *  navigational → duplicate (EXACT already-tracked) → offAnchor; then
   *  `semanticDuplicate` for candidates dropped by the cosine novelty pass.
   *  Invariant: `admitted + Σ(rejected) === rawCandidates`. */
  rejected: z.object({
    belowFloor: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(),
    navigational: z.number().int().nonnegative(),
    /** Dropped by the cheap exact-match check against the tracked basket. */
    duplicate: z.number().int().nonnegative(),
    offAnchor: z.number().int().nonnegative(),
    /** Dropped by the embedding cosine novelty pass (a paraphrase / synonym /
     *  stem variant of a tracked query that exact match can't see). 0 when the
     *  semantic pass did not run — see `semanticNoveltyApplied`. */
    semanticDuplicate: z.number().int().nonnegative(),
  }),
})
export type DiscoveryHarvestStats = z.infer<typeof discoveryHarvestStatsSchema>

export const discoveryHarvestDtoSchema = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  /** The provider whose probes were harvested (the session's seed provider).
   *  Discovery is Gemini-only today; carried so a future multi-provider
   *  discovery can attribute candidates. */
  provider: z.string(),
  status: discoverySessionStatusSchema,
  /** Recurrence floor applied: a candidate must have appeared in ≥ this many
   *  distinct probes to be admitted. */
  minProbeHits: z.number().int().positive(),
  /** Whether the subject-anchor filter actually ran (requested AND the corpus
   *  had ≥ `DISCOVERY_HARVEST_MIN_ANCHOR_TERMS` significant terms). */
  anchorApplied: z.boolean(),
  /** Whether the embedding cosine novelty pass ran. False when embeddings were
   *  unavailable (no Gemini key / no tracked queries / no candidates), in which
   *  case novelty fell back to the cheap exact-match check only. */
  semanticNoveltyApplied: z.boolean(),
  candidates: z.array(discoveryHarvestCandidateSchema),
  stats: discoveryHarvestStatsSchema,
})
export type DiscoveryHarvestDto = z.infer<typeof discoveryHarvestDtoSchema>

/** Trim, collapse internal whitespace, lowercase. The canonical key for a
 *  harvested query across aggregation, dedup, and output. */
export function normalizeHarvestQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase()
}

function harvestTokens(query: string): string[] {
  return normalizeHarvestQuery(query)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function significantHarvestTokens(query: string): string[] {
  return harvestTokens(query).filter(
    t => t.length >= HARVEST_SIGNIFICANT_TOKEN_MIN && !HARVEST_STOPWORDS.has(t),
  )
}

/** Length of the longest run of consecutive digit characters. Used to spot an
 *  unformatted phone string without false-positiving on a query that merely
 *  mentions several short numbers (years, model numbers), which a naive total
 *  digit count would catch. */
function longestDigitRun(query: string): number {
  let max = 0
  let run = 0
  for (const ch of query) {
    if (ch >= '0' && ch <= '9') {
      run++
      if (run > max) max = run
    } else {
      run = 0
    }
  }
  return max
}

/** True when the query is a name/address/phone style navigational lookup. */
export function isNavigationalHarvestQuery(query: string): boolean {
  const norm = normalizeHarvestQuery(query)
  if (longestDigitRun(norm) >= DISCOVERY_HARVEST_PHONE_DIGITS) return true
  const tokens = new Set(harvestTokens(norm))
  for (const marker of HARVEST_NAV_MARKERS) {
    if (marker.includes(' ')) {
      // Multi-word marker: match as a whole phrase with word boundaries.
      const re = new RegExp(`(?<![a-z0-9])${marker.replace(/ /g, '\\s+')}(?![a-z0-9])`)
      if (re.test(norm)) return true
    } else if (tokens.has(marker)) {
      return true
    }
  }
  return false
}

/**
 * Build the subject-anchor term set from a project's subject corpus (ICP
 * description + tracked query texts) plus the labels of every domain it owns
 * (`canonicalDomain` + `ownedDomains` — pass `effectiveDomains(project)`).
 *
 * Domain labels are folded in because the anchor's whole job is to drop the
 * off-subject acronym collisions that a model's fan-out produces (issue #713
 * thin-site finding, where a brand acronym collided with a customs program / an
 * enforcement unit / a retail brand) — and those collisions peak precisely on
 * thin/new projects with few tracked queries and a terse ICP. A domain label is
 * an always-present subject/identity term, so folding it in means even such a
 * project has a subject term to anchor against — the anchor engages
 * (`DISCOVERY_HARVEST_MIN_ANCHOR_TERMS`) instead of standing down and flooding
 * the operator with noise exactly where it is needed most. Owned domains matter
 * as much as the canonical one: a project whose canonical domain is an abstract
 * brand (`demand-iq.com`) but which owns a descriptive domain (`solar-leads.com`)
 * still gets real subject terms, which is what keeps the anchor from over-dropping
 * on-subject candidates.
 *
 * We fold in the registrable LABEL (TLD stripped), NOT the bare brand
 * acronym: anchoring on a generic seed acronym is what lets the collisions back
 * in, and the `HARVEST_SIGNIFICANT_TOKEN_MIN` floor already drops short acronyms
 * (e.g. "aeo" from "aeo.com"). Stripping the public suffix keeps a generic TLD
 * (".tech"/".info") from leaking in as an anchor term. Free-text brand NAMES are
 * still intentionally NOT a source for the same acronym-collision reason.
 */
export function buildHarvestAnchorTerms(corpus: readonly string[], domains: readonly string[] = []): string[] {
  const set = new Set<string>()
  for (const text of corpus) {
    for (const token of significantHarvestTokens(text)) set.add(token)
  }
  for (const domain of domains) {
    const host = hostOf(domain)
    if (!host) continue
    // Drop the public suffix so ".com"/".tech"/".info" never become anchor terms.
    const label = host.replace(/\.[a-z0-9]+$/, '')
    for (const token of significantHarvestTokens(label)) set.add(token)
  }
  return [...set]
}

export interface HarvestGateInput {
  /** Pre-aggregated unique candidates (see `aggregateHarvestedQueries`). */
  candidates: readonly DiscoveryHarvestCandidate[]
  /** The project's already-tracked query texts. This lexical gate drops only
   *  EXACT (case/space-normalized) matches; the semantic novelty pass
   *  (`applyHarvestSemanticNovelty`) handles paraphrases/synonyms. */
  trackedQueries: readonly string[]
  /** Significant subject terms (see `buildHarvestAnchorTerms`). */
  anchorTerms?: readonly string[]
  /** Recurrence floor; a candidate below it is rejected. Default 1 (no-op). */
  minProbeHits?: number
  /** Apply the subject anchor. Default true; auto-skipped when `anchorTerms`
   *  is sparse (< `DISCOVERY_HARVEST_MIN_ANCHOR_TERMS`). */
  applyAnchor?: boolean
}

export interface HarvestGateResult {
  admitted: DiscoveryHarvestCandidate[]
  anchorApplied: boolean
  stats: DiscoveryHarvestStats
}

/**
 * Mandatory pre-admission LEXICAL quality gate for harvested issued-search
 * queries. Pure + deterministic. Each candidate is rejected at the FIRST gate it
 * fails (belowFloor → length → navigational → duplicate(EXACT) → offAnchor) and
 * counted once in the matching rejection tally; survivors are returned sorted by
 * recurrence (probeHits desc, then query asc). `semanticDuplicate` is left at 0
 * here — the embedding cosine novelty pass (`applyHarvestSemanticNovelty`) fills
 * it in afterwards when embeddings are available.
 */
export function gateHarvestedSearchQueries(input: HarvestGateInput): HarvestGateResult {
  const minProbeHits = Math.max(1, Math.floor(input.minProbeHits ?? 1))
  const anchorTermSet = new Set(input.anchorTerms ?? [])
  const applyAnchor =
    (input.applyAnchor ?? true) && anchorTermSet.size >= DISCOVERY_HARVEST_MIN_ANCHOR_TERMS

  const trackedNorm = new Set(
    input.trackedQueries.map(normalizeHarvestQuery).filter(Boolean),
  )

  const stats: DiscoveryHarvestStats = {
    rawCandidates: input.candidates.length,
    admitted: 0,
    rejected: { belowFloor: 0, length: 0, navigational: 0, duplicate: 0, offAnchor: 0, semanticDuplicate: 0 },
  }
  const admitted: DiscoveryHarvestCandidate[] = []

  for (const candidate of input.candidates) {
    if (candidate.probeHits < minProbeHits) {
      stats.rejected.belowFloor++
      continue
    }
    const norm = normalizeHarvestQuery(candidate.query)
    const words = norm ? norm.split(' ').length : 0
    if (norm.length < DISCOVERY_HARVEST_MIN_CHARS || words > DISCOVERY_HARVEST_MAX_WORDS) {
      stats.rejected.length++
      continue
    }
    if (isNavigationalHarvestQuery(norm)) {
      stats.rejected.navigational++
      continue
    }
    // Cheap, high-precision exact-match novelty. Synonyms/paraphrases are left
    // for the semantic pass — a token-overlap measure here is blind to them and
    // brittle at any fixed threshold, so we do not attempt it lexically.
    if (trackedNorm.has(norm)) {
      stats.rejected.duplicate++
      continue
    }
    if (applyAnchor) {
      const sig = significantHarvestTokens(norm)
      if (!sig.some(t => anchorTermSet.has(t))) {
        stats.rejected.offAnchor++
        continue
      }
    }
    admitted.push({ query: norm, probeHits: candidate.probeHits })
    stats.admitted++
  }

  admitted.sort((a, b) => b.probeHits - a.probeHits || a.query.localeCompare(b.query))
  return { admitted, anchorApplied: applyAnchor, stats }
}

/**
 * Semantic novelty pass — drops candidates whose embedding is within the cosine
 * novelty threshold of ANY tracked-query embedding. This is what catches the
 * synonyms / paraphrases / stem variants the lexical exact-match gate cannot
 * (e.g. "solar panel price" vs a tracked "solar panel cost"). Pure: the caller
 * supplies the embeddings (the route injects a Gemini embed seam), so this stays
 * deterministic and unit-testable with hand-built vectors.
 *
 * `candidateVectors` must be aligned 1:1 with `result.admitted`. If the lengths
 * disagree, or there are no tracked vectors, the input result is returned
 * unchanged (fail open — never mis-drop on a wiring mistake). The dropped count
 * folds into `stats.rejected.semanticDuplicate`, preserving the
 * `admitted + Σ(rejected) === rawCandidates` invariant.
 */
export function applyHarvestSemanticNovelty(input: {
  result: HarvestGateResult
  candidateVectors: readonly number[][]
  trackedVectors: readonly number[][]
  threshold?: number
}): HarvestGateResult {
  const { result, candidateVectors, trackedVectors } = input
  const threshold = input.threshold ?? DISCOVERY_HARVEST_NOVELTY_THRESHOLD
  if (candidateVectors.length !== result.admitted.length || trackedVectors.length === 0) {
    return result
  }

  const admitted: DiscoveryHarvestCandidate[] = []
  let semanticDuplicate = 0
  for (let i = 0; i < result.admitted.length; i++) {
    const vec = candidateVectors[i]!
    const isDup = trackedVectors.some(t => cosineSimilarity(vec as number[], t as number[]) >= threshold)
    if (isDup) semanticDuplicate++
    else admitted.push(result.admitted[i]!)
  }

  return {
    admitted,
    anchorApplied: result.anchorApplied,
    stats: {
      ...result.stats,
      admitted: admitted.length,
      rejected: { ...result.stats.rejected, semanticDuplicate },
    },
  }
}

/**
 * Aggregate issued search queries across a session's probes into unique
 * candidates, counting the number of DISTINCT probes each query appeared in (a
 * query the model issued for several probes is a more confident recurring
 * intent than a one-off). Each probe's own list is de-duplicated first, so a
 * probe that issued the same query twice still counts as a single hit.
 */
export function aggregateHarvestedQueries(
  // `searchQueries` is typed `unknown[]` on purpose: it originates from a
  // provider extractor over raw JSON, so a corrupted element must not crash us.
  probes: ReadonlyArray<{ searchQueries: readonly unknown[] }>,
): DiscoveryHarvestCandidate[] {
  const counts = new Map<string, DiscoveryHarvestCandidate>()
  for (const probe of probes) {
    const seenInProbe = new Set<string>()
    for (const raw of probe.searchQueries) {
      // The provider extractor seam is untrusted (a corrupted / hand-edited
      // raw_response could carry a non-string element); skip anything that is
      // not a string rather than throwing and 500-ing the whole harvest.
      if (typeof raw !== 'string') continue
      const norm = normalizeHarvestQuery(raw)
      if (!norm || seenInProbe.has(norm)) continue
      seenInProbe.add(norm)
      const existing = counts.get(norm)
      if (existing) existing.probeHits++
      else counts.set(norm, { query: norm, probeHits: 1 })
    }
  }
  return [...counts.values()]
}
