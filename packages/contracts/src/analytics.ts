import { z } from 'zod'
import { validationError } from './errors.js'
import { measurementExecutionIdentitySchema } from './measurement-plan.js'
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
  /** Query scope behind this number. `pooled` means the project had no usable identity for a split. */
  scope: z.enum(['non-brand', 'pooled']),
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
  /**
   * Which query-set version the runs in this bucket measured. `null` when the
   * bucket's runs predate basket versioning, were scoped to a subset, or span
   * more than one revision — in each case there is no single set to name, and
   * naming one anyway would be the guess this field exists to remove.
   */
  basketRevision: z.number().int().nullable().default(null),
})
export type TimeBucket = z.infer<typeof timeBucketSchema>

/**
 * A point where the measured query set actually changed, derived from recorded
 * basket revisions rather than from query row timestamps. Unlike
 * `queryChangeEvent` this survives a rename or a remove-then-re-add, because
 * membership is compared by normalized query text.
 */
export const basketChangeEventSchema = z.object({
  revision: z.number().int(),
  /** When the new revision was first recorded. A real instant, safe to render. */
  at: z.string(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
})
export type BasketChangeEvent = z.infer<typeof basketChangeEventSchema>

export const queryChangeEventSchema = z.object({
  date: z.string(),
  delta: z.number().int(),
  label: z.string(),
})
export type QueryChangeEvent = z.infer<typeof queryChangeEventSchema>

/**
 * A point where the engines or models actually measuring this project
 * changed, derived from the `measurementExecutionIdentity` checksum stamped
 * on each plan-aware run at queue time — never inferred from row timestamps.
 * A comparable series is one execution identity; this is where it broke and
 * a new one started, the execution-identity sibling of `basketChangeEvent`.
 * Planless runs carry no identity and never produce one of these.
 */
export const executionIdentityChangeEventSchema = z.object({
  /** When the new identity was first measured — the boundary itself. */
  at: z.string(),
  /** The identity now in effect, starting at `at`. */
  identity: measurementExecutionIdentitySchema,
})
export type ExecutionIdentityChangeEvent = z.infer<typeof executionIdentityChangeEventSchema>

export const brandMetricsDtoSchema = z.object({
  window: metricsWindowSchema,
  /** Scope that applies even when `buckets` is empty. `pooled` means classification was unavailable. */
  mentionShareScope: z.enum(['non-brand', 'pooled']),
  buckets: z.array(timeBucketSchema),
  overall: providerMetricSchema,
  byProvider: z.record(z.string(), providerMetricSchema),
  trend: trendDirectionSchema,
  mentionTrend: trendDirectionSchema,
  queryChanges: z.array(queryChangeEventSchema),
  /**
   * Recorded changes to the measured query set inside this window, newest last.
   * Empty for a project whose basket never moved, and for one that has not run
   * since versioning shipped.
   */
  basketChanges: z.array(basketChangeEventSchema).default([]),
  /**
   * Recorded engine/model swaps inside this window, oldest first. A plan run
   * stamps its execution identity at queue time (see `runDtoSchema`'s field
   * of the same name); this is the diffed, chart-ready trail of where that
   * identity actually changed — the "visible break" a comparable-series swap
   * promises. Empty for a project that has never swapped engines/models
   * under a plan, and for one with no plan-aware runs at all.
   */
  executionIdentityChanges: z.array(executionIdentityChangeEventSchema).default([]),
  /**
   * The query-set version the comparable trend line is measured against —
   * the project's current basket. Null when no basket has been recorded yet,
   * which is also when the buckets fall back to the older date heuristic.
   */
  referenceBasketRevision: z.number().int().nullable().default(null),
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
   * Providers where a model id the project RAN is one the provider can swap for
   * a different underlying model without saying so. Sibling of
   * `modelServiceMismatch`: same `.default({})` back-compat, and the same "this
   * is evidence about the measurement, not project configuration" role. A
   * mismatch is something we OBSERVED; this is something we could never observe
   * from the response, which is exactly why it has to be disclosed from a dated
   * record instead.
   *
   * A provider is present in BOTH exposed states — `known-change` (a dated
   * change landed while the project was running the id) and `no-known-change`
   * (it is on such an id and our hand-maintained list has nothing for its
   * period). The second one carries `knownGoodAsOf` so a surface can say how
   * fresh that knowledge is: a list that has fallen behind produces exactly
   * that state, and letting it read as silence is the failure this field
   * exists to prevent. Empty only for a project entirely on fixed model ids.
   */
  modelPointerChanges: z.record(z.string(), modelPointerChangeDisclosureSchema).default({}),
})
export type BrandMetricsDto = z.infer<typeof brandMetricsDtoSchema>

export interface GapQuery {
  query: string
  queryId: string
  category: GapCategory
  providers: string[]
  /** Tracked competitors whose domain appeared in the engine's SOURCE LIST for this query. */
  competitorsCiting: string[]
  /**
   * Tracked competitors whose brand appeared in the ANSWER TEXT for this query.
   * A different signal from `competitorsCiting` and never derived from it — the
   * mention lanes (`mentionedQueries` / `mentionGap` / `notMentioned`) are
   * classified by THIS field, the citation lanes by the one above.
   */
  competitorsMentioned: string[]
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

/**
 * Historical competitor landscape, calculated only from persisted answer and
 * source evidence. `shareOfVoice` is percentage points (0..100), never a
 * fractional ratio: `37.5` means 37.5% of the named competitive credits.
 */
export const competitorLandscapeSurfaceClassSchema = z.enum([
  'own',
  'direct-competitor',
  'ota-aggregator',
  'editorial-media',
  'other',
  'unknown',
])
export type CompetitorLandscapeSurfaceClass = z.infer<typeof competitorLandscapeSurfaceClassSchema>

export const competitorLandscapeScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project') }).strict(),
  z.object({ kind: z.literal('group'), groupKey: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('all-markets') }).strict(),
])
export type CompetitorLandscapeScope = z.infer<typeof competitorLandscapeScopeSchema>

export const competitorLandscapeQueryClassSchema = z.enum(['all', 'branded', 'non-brand'])
export type CompetitorLandscapeQueryClass = z.infer<typeof competitorLandscapeQueryClassSchema>

/** Explicitly selects the Advanced Measurement aggregate; it is never an implicit project fallback. */
export const competitorLandscapeModeSchema = z.enum(['project', 'all-markets'])
export type CompetitorLandscapeMode = z.infer<typeof competitorLandscapeModeSchema>

/** Route query filters. `groupKey` scopes an Advanced Measurement market. */
export const competitorLandscapeQuerySchema = z.object({
  window: metricsWindowSchema.optional(),
  groupKey: z.string().trim().min(1).optional(),
  scope: competitorLandscapeModeSchema.optional(),
  provider: z.string().trim().min(1).optional(),
  queryClass: competitorLandscapeQueryClassSchema.optional(),
  location: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.scope === 'all-markets' && value.groupKey !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['groupKey'],
      message: 'groupKey cannot be combined with scope=all-markets',
    })
  }
})
export type CompetitorLandscapeQuery = z.infer<typeof competitorLandscapeQuerySchema>

/** One project, pinned, observed, or non-competitive source identity. */
export const competitorLandscapeRowSchema = z.object({
  domain: z.string().trim().min(1),
  label: z.string().trim().min(1),
  surfaceClass: competitorLandscapeSurfaceClassSchema,
  pinned: z.boolean(),
  /** One answer-text match at most per result. */
  mentionCount: z.number().int().nonnegative(),
  /** Percentage points (0..100), null outside the competitive denominator. */
  shareOfVoice: z.number().min(0).max(100).nullable(),
  /** One source-list credit at most per result. Independent of mentions. */
  citationCount: z.number().int().nonnegative(),
  /** Answer-text result count behind the mention field. */
  answeredResults: z.number().int().nonnegative(),
  firstSeenAt: z.string().datetime().nullable(),
  lastSeenAt: z.string().datetime().nullable(),
  sampleUrls: z.array(z.string().url()).max(3),
}).strict()
export type CompetitorLandscapeRow = z.infer<typeof competitorLandscapeRowSchema>

export const competitorLandscapeResponseSchema = z.object({
  window: metricsWindowSchema,
  scope: competitorLandscapeScopeSchema,
  project: competitorLandscapeRowSchema,
  /** Explicit/custom competitors, preserved even with zero observations. */
  pinned: z.array(competitorLandscapeRowSchema),
  /** Stored-discovery direct competitors, ordered by historical mention SOV. */
  observed: z.array(competitorLandscapeRowSchema),
  /** Aggregators, editorial, unknown, and other cited sources; never SOV competitors. */
  otherSources: z.array(competitorLandscapeRowSchema),
  evidence: z.object({
    answeredResults: z.number().int().nonnegative(),
    sourceResults: z.number().int().nonnegative(),
    missingAnswerTextResults: z.number().int().nonnegative(),
    /** Project plus direct-competitor named credits behind SOV. */
    mentionCredits: z.number().int().nonnegative(),
    /** Citation captures that cannot prove a complete source list; never inferred as misses. */
    incompleteSourceResults: z.number().int().nonnegative(),
    /** Stored probe snapshots intentionally omitted from every landscape metric. */
    excludedProbeResults: z.number().int().nonnegative(),
    /** Stored snapshots from queued/running/failed/cancelled runs omitted from every metric. */
    excludedNonCompletedResults: z.number().int().nonnegative(),
  }).strict(),
  /** Present only for Advanced market reads; active metrics stay frozen while draft pins remain pending publish. */
  marketState: z.object({
    activeRevision: z.number().int().positive(),
    draft: z.object({
      etag: z.string().trim().min(1),
      /** Draft-only market identities included in `pinned` for this response. */
      pendingCompetitorDomains: z.array(z.string().trim().min(1)),
    }).strict().nullable(),
  }).strict().nullable(),
  /** Echoes all applied filters so a client never mistakes a scoped reading for a project-wide one. */
  filters: z.object({
    scope: competitorLandscapeModeSchema,
    groupKey: z.string().nullable(),
    provider: z.string().nullable(),
    queryClass: competitorLandscapeQueryClassSchema,
    location: z.string().nullable(),
    runId: z.string().nullable(),
  }).strict(),
  /** True when ranked observed/source lists exceed the server cap; pinned rows are never dropped. */
  truncated: z.boolean(),
}).strict()
export type CompetitorLandscapeResponse = z.infer<typeof competitorLandscapeResponseSchema>

/**
 * Resolve a caller-supplied window label. An absent (or empty) value means the
 * caller asked for no window at all and gets the full history.
 *
 * An UNRECOGNISED value is rejected. It used to fall back to `all`, which meant
 * `--window 60d` returned every row ever stored while the caller believed it
 * had a 60-day window: a wrong number with no signal attached to it. Failing
 * loudly is the only way the caller can tell.
 */
export function parseWindow(value?: string): MetricsWindow {
  if (value === undefined || value === '') return 'all'
  const parsed = metricsWindowSchema.safeParse(value)
  if (!parsed.success) {
    throw validationError(
      `Invalid window "${value}". Must be one of: ${metricsWindowSchema.options.join(', ')}.`,
    )
  }
  return parsed.data
}

export function windowCutoff(window: MetricsWindow): string | null {
  if (window === 'all') return null
  const days = window === '7d' ? 7 : window === '30d' ? 30 : 90
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

/** A `YYYY-MM-DD` calendar date. Anything else is not a date this API accepts. */
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Validate one range boundary. Both the shape and the date itself are checked:
 * a stored `date` column is compared as TEXT, so `2026-02-30` would not error,
 * it would silently define a range nobody asked for.
 */
function parseBoundaryDate(value: string | undefined, field: 'startDate' | 'endDate'): string | null {
  if (value === undefined || value === '') return null
  const trimmed = value.trim()
  const invalid = () => validationError(`Invalid ${field} "${value}". Expected a calendar date as YYYY-MM-DD.`)
  if (!CALENDAR_DATE_PATTERN.test(trimmed)) throw invalid()
  const parsed = new Date(`${trimmed}T00:00:00Z`)
  // `2026-02-30` parses by rolling over into March, so round-tripping is what
  // separates a real date from a well-shaped impossible one.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) throw invalid()
  return trimmed
}

export interface DateRangeInput {
  /** Inclusive lower bound as `YYYY-MM-DD`. Wins over `window`. */
  startDate?: string
  /** Inclusive upper bound as `YYYY-MM-DD`. */
  endDate?: string
  /** Rolling window label, applied only when no `startDate` was supplied. */
  window?: string
}

export interface ResolvedDateRange {
  /**
   * Inclusive lower bound as `YYYY-MM-DD`, or null for an open lower bound.
   * The explicit `startDate` when one was supplied, otherwise the window's
   * rolling cutoff.
   */
  startDate: string | null
  /** Inclusive upper bound as `YYYY-MM-DD`, or null for an open upper bound. */
  endDate: string | null
  /** The parsed window. Only reflected in `startDate` when no explicit `startDate` was given. */
  window: MetricsWindow
  /**
   * True when the caller named at least one boundary itself. Callers that keep
   * per-window precomputed rollups need this: such a rollup answers a rolling
   * window, never an arbitrary calendar range.
   */
  explicitDates: boolean
}

/**
 * Resolve `startDate` / `endDate` / `window` into one inclusive date range.
 *
 * Explicit dates win: `window` only computes a cutoff when no `startDate` was
 * supplied. A rolling window cannot name a calendar month, which is why every
 * monthly total previously had to be hand-filtered out of a wider pull.
 */
export function resolveDateRange(input: DateRangeInput): ResolvedDateRange {
  const window = parseWindow(input.window)
  const startDate = parseBoundaryDate(input.startDate, 'startDate')
  const endDate = parseBoundaryDate(input.endDate, 'endDate')
  if (startDate && endDate && startDate > endDate) {
    throw validationError(`Invalid date range: startDate "${startDate}" must be on or before endDate "${endDate}".`)
  }
  const cutoff = startDate ? null : windowCutoff(window)?.slice(0, 10) ?? null
  return {
    startDate: startDate ?? cutoff,
    endDate,
    window,
    explicitDates: startDate !== null || endDate !== null,
  }
}
