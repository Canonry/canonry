import { z } from 'zod'
import { modelPointerChangeDisclosureSchema } from './model-pointers.js'
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

/** Citation + mention rates for one provider (or the overall roll-up) within a window or bucket. */
export const providerMetricSchema = z.object({
  citationRate: z.number(),
  cited: z.number().int(),
  total: z.number().int(),
  mentionRate: z.number(),
  mentionedCount: z.number().int(),
})
export type ProviderMetric = z.infer<typeof providerMetricSchema>

const modelIdSchema = z.string().trim().min(1)
const canonicalModelIdsSchema = z.array(modelIdSchema).min(1).superRefine((models, ctx) => {
  for (let index = 1; index < models.length; index += 1) {
    if (models[index - 1]! >= models[index]!) {
      ctx.addIssue({
        code: 'custom',
        message: 'mixed model IDs must be sorted and unique',
        path: [index],
      })
    }
  }
})

/**
 * Model evidence from the snapshots contributing to an observation. `unknown`
 * means every contributing snapshot lacked a model; it is distinct from an
 * absent provider observation. `mixed` preserves contradictory or partially
 * legacy evidence instead of choosing an arbitrary model.
 */
export const modelEvidenceStateSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('known'),
    model: modelIdSchema,
  }),
  z.object({
    status: z.literal('unknown'),
  }),
  z.object({
    status: z.literal('mixed'),
    models: canonicalModelIdsSchema,
    includesUnknown: z.boolean(),
  }),
])
export type ModelEvidenceState = z.infer<typeof modelEvidenceStateSchema>

export const modelAttributionEventSchema = z.object({
  /** First logical sweep where the `to` evidence state was observed. */
  observedAt: z.string(),
  /** Existing categorical trend bucket key, not a claimed transition time. */
  bucketStartDate: z.string(),
  from: modelEvidenceStateSchema,
  to: modelEvidenceStateSchema,
  /**
   * True when `from` is the pre-window anchor rather than an in-window sweep,
   * so the change happened at some point between the last pre-window sweep and
   * `observedAt` — not necessarily inside the window. Omitted when false.
   * Consumers should date these "on or before", never as an in-window event.
   */
  fromPreWindowAnchor: z.boolean().optional(),
  /**
   * Observation time of the pre-window anchor sweep `from` came from. Present
   * only alongside `fromPreWindowAnchor`, and it closes the date range: the
   * change happened after `anchorObservedAt` and on or before `observedAt`.
   * Without it a consumer can only say "on or before".
   */
  anchorObservedAt: z.string().optional(),
})
export type ModelAttributionEvent = z.infer<typeof modelAttributionEventSchema>

/**
 * Cap on the transitions returned per provider. A provider that oscillates
 * between two model ids sweep after sweep would otherwise emit an unbounded
 * list; `eventTotal` keeps the real count visible so a consumer can say how
 * many of how many it is showing.
 */
export const MODEL_ATTRIBUTION_EVENT_LIMIT = 50

export const providerModelAttributionSchema = z.object({
  /** Most recent logical sweep in the selected analytics window for this provider. */
  latestObservation: z.object({
    observedAt: z.string(),
    state: modelEvidenceStateSchema,
  }),
  /** At most the most recent `MODEL_ATTRIBUTION_EVENT_LIMIT` transitions, oldest first. */
  events: z.array(modelAttributionEventSchema),
  /**
   * Every transition observed in the window, including any the cap dropped.
   * `eventTotal > events.length` means the list is truncated. Optional so a
   * newer client can still read an older server's response.
   */
  eventTotal: z.number().int().nonnegative().optional(),
  /**
   * True when the pre-window anchor search hit its scan bound before finding a
   * sweep that observed this provider, so there may be an earlier change this
   * response cannot see. Lets a consumer distinguish "no model change" from
   * "we did not look far enough back". Omitted when the search was conclusive,
   * including when the provider genuinely has no history before the window.
   */
  anchorUnavailable: z.boolean().optional(),
})
export type ProviderModelAttribution = z.infer<typeof providerModelAttributionSchema>

/** Historical observed model evidence keyed by provider. This is not project configuration. */
export const modelAttributionSchema = z.record(z.string(), providerModelAttributionSchema)
export type ModelAttribution = z.infer<typeof modelAttributionSchema>

/**
 * A trailing dated-snapshot suffix — `-2026-03-05` or the compact `-20260305`.
 *
 * Providers pin a release date onto the SAME model (`gpt-5.4` is served as
 * `gpt-5.4-2026-03-05`, `gpt-4o` as `gpt-4o-2024-08-06`), so the suffix names
 * WHEN, not WHAT. A capability tier (`gpt-5.6-sol`) is a different model at a
 * different price and must survive normalization untouched.
 *
 * The rule is therefore derived from the date SHAPE, never from a list of known
 * tier names: an unknown future tier (`-nova`, `-3`, `-2026`) is preserved
 * rather than silently swallowed, which is the safe direction to fail — a
 * preserved tier shows up as a real change the operator can dismiss, a
 * swallowed one is a price change nobody ever sees.
 */
// `-YYYY<sep>MM<sep>DD` where the backreference forces ONE consistent
// separator, so `-2026-0305` / `-202603-05` are not mistaken for stamps.
const DATED_SNAPSHOT_SUFFIX = /-\d{4}(-?)(\d{2})\1(\d{2})$/

/**
 * Collapse a served model id to its top-level identity. A dated snapshot of a
 * model IS that model for attribution purposes, so comparing normalized ids is
 * what stops every provider-side redeploy reading as a model change.
 * Comparison-only: the full served string is what gets stored and displayed.
 */
export function normalizeModelId(model: string): string {
  const trimmed = model.trim()
  const match = DATED_SNAPSHOT_SUFFIX.exec(trimmed)
  if (!match) return trimmed
  const month = Number(match[2])
  const day = Number(match[3])
  // A date-SHAPED suffix still has to be a plausible date. `-9999-99-99` is not
  // a snapshot stamp, so it stays part of the identity.
  if (month < 1 || month > 12 || day < 1 || day > 31) return trimmed
  const base = trimmed.slice(0, match.index)
  // Never normalize a model id away to nothing (`-2026-03-05` alone).
  return base.length > 0 ? base : trimmed
}

/** True when two model ids name the same model, ignoring a dated-snapshot suffix. */
export function modelIdsEquivalent(a: string, b: string): boolean {
  return normalizeModelId(a) === normalizeModelId(b)
}

/**
 * Evidence for what a provider ACTUALLY served, as opposed to what the project
 * configured. Same shape as the configured series so both render through one
 * code path, plus the full un-normalized ids behind the latest observation:
 * change detection runs on normalized ids, forensics needs the raw ones.
 */
export const servedProviderModelAttributionSchema = providerModelAttributionSchema.extend({
  /** Every distinct raw served id behind `latestObservation`, sorted. */
  latestServedModelIds: z.array(modelIdSchema).default([]),
})
export type ServedProviderModelAttribution = z.infer<typeof servedProviderModelAttributionSchema>

export const servedModelAttributionSchema = z.record(z.string(), servedProviderModelAttributionSchema)
export type ServedModelAttribution = z.infer<typeof servedModelAttributionSchema>

/**
 * A provider whose latest configured and served evidence are both known and
 * name DIFFERENT top-level models. A dated snapshot of the configured model is
 * agreement, not a mismatch, so this only fires on a genuine substitution.
 */
export const modelServiceMismatchSchema = z.object({
  observedAt: z.string(),
  configured: modelEvidenceStateSchema,
  served: modelEvidenceStateSchema,
})
export type ModelServiceMismatch = z.infer<typeof modelServiceMismatchSchema>

/** Mention-share metric for one time bucket. Null rate means the competitive
 *  frame had no brand mentions in that bucket, so the share is undefined. */
export const mentionShareBucketMetricSchema = z.object({
  rate: z.number().nullable(),
  projectMentionSnapshots: z.number().int().nonnegative(),
  competitorMentionSnapshots: z.number().int().nonnegative(),
})
export type MentionShareBucketMetric = z.infer<typeof mentionShareBucketMetricSchema>

/**
 * One time bucket of the citation/mention trend. `byProvider` carries the
 * same metrics computed per provider over the bucket's normalized snapshot
 * set, so the dashboard can plot a line per provider over time.
 */
export const timeBucketSchema = z.object({
  /**
   * SYNTHETIC bucket boundary — the grouping key and the chart's x-axis key.
   * Nothing happened at this instant: it is an internal boundary derived from
   * the window's earliest run, so it is not calendar-aligned and is usually
   * days away from the sweeps it contains. It is monotonic and stable, which
   * is all a key needs to be. NEVER render it as a date to a reader; use
   * `dataStartDate` / `dataEndDate`, which are real observation times.
   */
  startDate: z.string(),
  /** The exclusive end of the same synthetic boundary. Also never a date to render. */
  endDate: z.string(),
  /**
   * Earliest REAL sweep timestamp among the snapshots this bucket aggregates.
   * A moment something actually happened, so it is safe to localize for a
   * viewer — and it is what any date label about this bucket must come from.
   */
  dataStartDate: z.string(),
  /** Latest real sweep timestamp in the bucket. Equals `dataStartDate` when the bucket holds one sweep. */
  dataEndDate: z.string(),
  /**
   * How many distinct sweeps this bucket pools. `> 1` means the plotted point
   * is an aggregate of several runs spread over `dataStartDate`..`dataEndDate`
   * — surface that rather than implying a single reading.
   */
  sweepCount: z.number().int().nonnegative(),
  citationRate: z.number(),
  cited: z.number().int(),
  total: z.number().int(),
  queryCount: z.number().int(),
  mentionRate: z.number(),
  mentionedCount: z.number().int(),
  mentionShare: mentionShareBucketMetricSchema,
  byProvider: z.record(z.string(), providerMetricSchema),
  /** Evidence from the exact normalized snapshots that produced each provider rate. */
  modelEvidenceByProvider: z.record(z.string(), modelEvidenceStateSchema).default({}),
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
  /** Window-scoped historical evidence, distinct from any configured provider model. */
  modelAttribution: modelAttributionSchema.default({}),
  /**
   * The PARALLEL series built from what the provider reported serving. It is
   * deliberately not merged into `modelAttribution`: served capture starts at a
   * deploy boundary, so coalescing the two would fabricate a model change on
   * that date for every project. A snapshot with no served id is no observation
   * at all here — same rule as an absent provider — so a window that predates
   * capture is simply empty and `modelAttribution` is untouched.
   */
  servedModelAttribution: servedModelAttributionSchema.default({}),
  /** Providers currently serving a different top-level model than the one configured. */
  modelServiceMismatch: z.record(z.string(), modelServiceMismatchSchema).default({}),
  /**
   * Providers where a model id the project RAN is one the provider re-points at
   * a different underlying model, and a known re-point landed inside the span
   * of sweeps these numbers come from. Sibling of `modelServiceMismatch`: same
   * `.default({})` back-compat, and the same "this is evidence about the
   * measurement, not project configuration" role. A mismatch is something we
   * OBSERVED; this is something we could never observe from the response, which
   * is exactly why it has to be disclosed from a dated record instead.
   * Empty for every project on pinned model ids.
   */
  modelPointerChanges: z.record(z.string(), modelPointerChangeDisclosureSchema).default({}),
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
