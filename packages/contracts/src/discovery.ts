import { z } from 'zod'
import { citationStateSchema } from './run.js'

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
 * vaporize it. When the canonical count falls below this fraction of the raw
 * candidate count, the clustering almost certainly chained distinct intents
 * together and the session's coverage is misleading.
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
  if (canonicalCount / seedCountRaw >= DISCOVERY_SEED_COLLAPSE_RATIO) return null
  const noun = canonicalCount === 1 ? 'query' : 'queries'
  return (
    `Seed dedup collapsed ${seedCountRaw} raw candidates into ${canonicalCount} canonical ${noun} ` +
    `at threshold ${dedupThreshold}. Distinct intents were likely merged into one cluster; ` +
    `re-run with a higher --dedup-threshold.`
  )
}

export const discoveryRunRequestSchema = z.object({
  icpDescription: z.string().min(1).optional(),
  dedupThreshold: z.number().min(0).max(1).optional(),
  maxProbes: z.number().int().positive().max(DISCOVERY_MAX_PROBES_CAP).optional(),
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
