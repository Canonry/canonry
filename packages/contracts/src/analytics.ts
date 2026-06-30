import { z } from 'zod'
import { sourceCategorySchema } from './source-categories.js'
import { surfaceClassSchema } from './surface-class.js'

export const metricsWindowSchema = z.enum(['7d', '30d', '90d', 'all'])
export type MetricsWindow = z.infer<typeof metricsWindowSchema>
export const trendDirectionSchema = z.enum(['improving', 'declining', 'stable'])
export type TrendDirection = z.infer<typeof trendDirectionSchema>
export type GapCategory = 'cited' | 'gap' | 'uncited'

// Mode toggle for analytics views — `mentioned` = brand appears in the answer
// prose; `cited` = domain appears in the source/grounding list. See AGENTS.md
// "Vocabulary (Critical)" for the full distinction.
export const visibilityMetricModeSchema = z.enum(['mentioned', 'cited'])
export type VisibilityMetricMode = z.infer<typeof visibilityMetricModeSchema>
export const VisibilityMetricModes = visibilityMetricModeSchema.enum

/** byLocation bucket key for snapshots from runs with no configured location. */
export const MentionShareNoLocationBucket = '__canonry_no_location__'

/** Citation + mention rates for one provider (or the overall roll-up) within a window or bucket. */
export const providerMetricSchema = z.object({
  citationRate: z.number(),
  cited: z.number().int(),
  total: z.number().int(),
  mentionRate: z.number(),
  mentionedCount: z.number().int(),
})
export type ProviderMetric = z.infer<typeof providerMetricSchema>

/** Mention-share observation counts for one scope within a time bucket. Null
 *  rate means the competitive frame had no brand mentions in that scope, so
 *  the share is undefined. */
export const mentionShareObservationMetricSchema = z.object({
  rate: z.number().nullable(),
  projectMentionEvents: z.number().int().nonnegative(),
  competitorMentionEvents: z.number().int().nonnegative(),
  /** Deprecated alias kept for one release for clients pinned to the old analytics DTO shape. */
  projectMentionSnapshots: z.number().int().nonnegative(),
  /** Deprecated alias kept for one release for clients pinned to the old analytics DTO shape. */
  competitorMentionSnapshots: z.number().int().nonnegative(),
  /** Denominator for `rate`: project + tracked-competitor brand mention events. */
  brandMentionEvents: z.number().int().nonnegative(),
  answerObservations: z.number().int().nonnegative(),
  totalObservations: z.number().int().nonnegative(),
})

/** Mention-share metric for one time bucket, including provider/location
 *  distributions so clients can render this as repeated observations rather
 *  than a standalone score. */
export const mentionShareBucketMetricSchema = mentionShareObservationMetricSchema.extend({
  byProvider: z.record(z.string(), mentionShareObservationMetricSchema),
  /** `MentionShareNoLocationBucket` groups snapshots from runs with no configured location. */
  byLocation: z.record(z.string(), mentionShareObservationMetricSchema),
})
export type MentionShareBucketMetric = z.infer<typeof mentionShareBucketMetricSchema>

/**
 * One time bucket of the citation/mention trend. `byProvider` carries the
 * same metrics computed per provider over the bucket's normalized snapshot
 * set, so the dashboard can plot a line per provider over time.
 */
export const timeBucketSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  citationRate: z.number(),
  cited: z.number().int(),
  total: z.number().int(),
  queryCount: z.number().int(),
  mentionRate: z.number(),
  mentionedCount: z.number().int(),
  mentionShare: mentionShareBucketMetricSchema,
  byProvider: z.record(z.string(), providerMetricSchema),
})
export type TimeBucket = z.infer<typeof timeBucketSchema>

export const queryChangeEventSchema = z.object({
  date: z.string(),
  delta: z.number().int(),
  label: z.string(),
})
export type QueryChangeEvent = z.infer<typeof queryChangeEventSchema>

export const brandMetricsDtoSchema = z.object({
  window: metricsWindowSchema,
  buckets: z.array(timeBucketSchema),
  overall: providerMetricSchema,
  byProvider: z.record(z.string(), providerMetricSchema),
  trend: trendDirectionSchema,
  mentionTrend: trendDirectionSchema,
  queryChanges: z.array(queryChangeEventSchema),
})
export type BrandMetricsDto = z.infer<typeof brandMetricsDtoSchema>

export interface GapQuery {
  query: string
  queryId: string
  category: GapCategory
  providers: string[]
  competitorsCiting: string[]
  consistency: { citedRuns: number; totalRuns: number; mentionedRuns: number }
}

export interface GapAnalysisDto {
  cited: GapQuery[]
  gap: GapQuery[]
  uncited: GapQuery[]
  mentionedQueries: GapQuery[]
  mentionGap: GapQuery[]
  notMentioned: GapQuery[]
  runId: string
  window: MetricsWindow
}

/**
 * Per-category source breakdown. `topDomains` stays capped at the top 5 for
 * back-compat with existing consumers; the full ranked, classified list lives
 * on `SourceBreakdownDto.ranked` (see #675).
 */
export const sourceCategoryCountSchema = z.object({
  category: sourceCategorySchema,
  label: z.string(),
  count: z.number().int(),
  /** Share of all cited slots in scope, 0..1 (4dp). */
  percentage: z.number(),
  topDomains: z.array(z.object({ domain: z.string(), count: z.number().int() })),
})
export type SourceCategoryCount = z.infer<typeof sourceCategoryCountSchema>

/** One cited domain in a ranked list, tagged with its category + surface class. */
export const sourceRankEntrySchema = z.object({
  domain: z.string(),
  count: z.number().int(),
  /** Share of the list's `totalCitedSlots`, 0..1 (4dp). */
  percentage: z.number(),
  category: sourceCategorySchema,
  label: z.string(),
  surfaceClass: surfaceClassSchema,
})
export type SourceRankEntry = z.infer<typeof sourceRankEntrySchema>

/** Roll-up of cited slots by actionable surface class (own / competitor / OTA / editorial / other). */
export const surfaceClassCountSchema = z.object({
  surfaceClass: surfaceClassSchema,
  label: z.string(),
  count: z.number().int(),
  /** Share of the list's `totalCitedSlots`, 0..1 (4dp). */
  percentage: z.number(),
  domainCount: z.number().int(),
})
export type SurfaceClassCount = z.infer<typeof surfaceClassCountSchema>

/**
 * A ranked list of cited domains over a scope (overall or a single provider),
 * with an explicit long-tail rollup so a `limit` never hides totals:
 *   `entries.length + truncatedDomainCount === domainTotal`
 *   `sum(entries.count) + truncatedCitedSlots === totalCitedSlots`
 *   `sum(bySurfaceClass.count) === totalCitedSlots`  (rollup spans the FULL scope)
 */
export const rankedSourceListSchema = z.object({
  /** Total cited slots (grounding citations) counted in this scope. */
  totalCitedSlots: z.number().int(),
  /** Distinct domains in this scope. */
  domainTotal: z.number().int(),
  /** Ranked domains, desc by count; truncated to the applied limit if any. */
  entries: z.array(sourceRankEntrySchema),
  /** Distinct domains beyond the limit (0 when full). */
  truncatedDomainCount: z.number().int(),
  /** Cited slots beyond the limit (0 when full). */
  truncatedCitedSlots: z.number().int(),
  /** Surface-class roll-up over the FULL scope (not just `entries`). */
  bySurfaceClass: z.array(surfaceClassCountSchema),
})
export type RankedSourceList = z.infer<typeof rankedSourceListSchema>

export const sourceBreakdownDtoSchema = z.object({
  overall: z.array(sourceCategoryCountSchema),
  byQuery: z.record(z.string(), z.array(sourceCategoryCountSchema)),
  /** Full ranked + classified cited-domain list across all providers (#675). */
  ranked: rankedSourceListSchema,
  /** Per-provider ranked + classified breakdown, keyed by provider name (#675). */
  byProvider: z.record(z.string(), rankedSourceListSchema),
  runId: z.string(),
  window: metricsWindowSchema,
  /** Applied ranked-list limit; null when the full list is returned. */
  limit: z.number().int().nullable(),
})
export type SourceBreakdownDto = z.infer<typeof sourceBreakdownDtoSchema>

export function parseWindow(value?: string): MetricsWindow {
  if (value === '7d' || value === '30d' || value === '90d' || value === 'all') return value
  return 'all'
}

export function windowCutoff(window: MetricsWindow): string | null {
  if (window === 'all') return null
  const days = window === '7d' ? 7 : window === '30d' ? 30 : 90
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}
