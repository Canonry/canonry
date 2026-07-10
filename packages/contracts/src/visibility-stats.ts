import { z } from 'zod'

/**
 * Aggregated answer-visibility stats — per-query mention / citation counts
 * with a sample size, pooled across many runs, with an optional per-provider
 * breakdown.
 *
 * The two signals stay independent and tri-state-correct (see AGENTS.md
 * "Vocabulary (Critical)"):
 *
 *   - **mentioned** = the brand appears in the answer TEXT
 *     (`query_snapshots.answer_mentioned === true`). It is tri-state: `null`
 *     means "not checked" (legacy row / never computed) and is EXCLUDED from
 *     `checked` — never counted as not-mentioned. `checked` is therefore the
 *     correct denominator (sample size `n`) for a mention proportion.
 *   - **cited** = the domain appears in the source/grounding list
 *     (`query_snapshots.citation_state === 'cited'`). `citation_state` is
 *     always populated, so every snapshot is "checked" for citation and the
 *     citation denominator is `total`.
 *
 * The endpoint returns raw COUNTS so a consumer can compute a confidence
 * interval (e.g. Wilson) over the right `n`, plus the convenience rates the
 * CLI / dashboard render directly (no client-side recomputation).
 */
export const visibilityStatsCountsSchema = z.object({
  /** Total (query × provider) snapshots observed in the window. Denominator for `citedRate`. */
  total: z.number().int(),
  /**
   * Snapshots where `answerMentioned !== null` — the sample size (`n`) for the
   * mention proportion. Tri-state `null` ("not checked") is excluded.
   */
  checked: z.number().int(),
  /** Snapshots where `answerMentioned === true` (brand named in the answer text). */
  mentioned: z.number().int(),
  /** Snapshots where `citationState === 'cited'` (domain in the grounding / source list). */
  cited: z.number().int(),
  /** `mentioned / checked`, rounded to 4 dp; `null` when `checked === 0` (rate undefined over no samples). */
  mentionRate: z.number().nullable(),
  /** `cited / total`, rounded to 4 dp; `null` when `total === 0`. */
  citedRate: z.number().nullable(),
})
export type VisibilityStatsCounts = z.infer<typeof visibilityStatsCountsSchema>

/** Per-provider counts for one query (or the pooled roll-up across all queries). */
export const visibilityStatsProviderEntrySchema = visibilityStatsCountsSchema.extend({
  provider: z.string(),
  /** Earliest snapshot `createdAt` (ISO 8601) contributing to these counts. */
  firstObserved: z.string(),
  /** Latest snapshot `createdAt` (ISO 8601) contributing to these counts. */
  lastObserved: z.string(),
})
export type VisibilityStatsProviderEntry = z.infer<typeof visibilityStatsProviderEntrySchema>

/** Pooled (across providers) counts for one tracked query, plus an optional per-provider breakdown. */
export const visibilityStatsQueryEntrySchema = visibilityStatsCountsSchema.extend({
  /** The tracked query's id. */
  queryId: z.string().nullable(),
  /** The query text. */
  query: z.string(),
  firstObserved: z.string(),
  lastObserved: z.string(),
  /**
   * Per-provider breakdown — present only when `groupBy=provider`. Each
   * entry's counts sum to this query's pooled counts.
   */
  providers: z.array(visibilityStatsProviderEntrySchema).optional(),
})
export type VisibilityStatsQueryEntry = z.infer<typeof visibilityStatsQueryEntrySchema>

/** Echoes the window the aggregation actually used. */
export const visibilityStatsWindowSchema = z.object({
  /** Inclusive lower bound on `runs.createdAt` (ISO 8601; a date-only value is that UTC day's start), or `null` for unbounded. Echoes the raw value the caller passed. */
  since: z.string().nullable(),
  /** Inclusive upper bound on `runs.createdAt` (ISO 8601; a date-only value covers the whole UTC day), or `null` for unbounded. Echoes the raw value the caller passed. */
  until: z.string().nullable(),
  /** When set, the aggregation used the most recent N answer-visibility runs instead of a date window. */
  lastRuns: z.number().int().nullable(),
  /** Number of (completed / partial, non-probe) answer-visibility runs included. */
  runCount: z.number().int(),
})
export type VisibilityStatsWindow = z.infer<typeof visibilityStatsWindowSchema>

export const visibilityStatsGroupBySchema = z.enum(['provider'])
export type VisibilityStatsGroupBy = z.infer<typeof visibilityStatsGroupBySchema>

/** One competitor's pooled brand-mention count within the window. */
export const visibilityStatsShareCompetitorSchema = z.object({
  domain: z.string(),
  /** Snapshots (with answer text) in the window where this competitor's brand appeared. */
  mentions: z.number().int(),
})
export type VisibilityStatsShareCompetitor = z.infer<typeof visibilityStatsShareCompetitorSchema>

/**
 * Pooled **share of voice** across the window — how often the project's brand is
 * named in answer TEXT vs tracked competitors:
 *   `share = projectMentions / (projectMentions + competitorMentions)`.
 * Per-snapshot (binary), mirroring `answerMentioned` — matches `buildMentionShare`.
 * Present only when the caller passes `shareOfVoice=1`.
 *
 * `percent` is `null` when no competitors are configured (the head-to-head metric
 * is undefined without a competitive frame — reporting 100% would mislead).
 */
export const visibilityStatsShareOfVoiceSchema = z.object({
  /** `projectMentions / (projectMentions + competitorMentions)` as 0-100; `null` when no competitors configured. */
  percent: z.number().nullable(),
  /** Snapshots (with answer text) where the project's brand appeared in the answer. */
  projectMentions: z.number().int(),
  /** Snapshots (with answer text) where any tracked competitor's brand appeared. */
  competitorMentions: z.number().int(),
  /** Snapshots that carried answer text — the universe the mentions were counted over. */
  snapshotsWithAnswerText: z.number().int(),
  /** Per-competitor mention counts, descending; only competitors with ≥1 mention appear. */
  perCompetitor: z.array(visibilityStatsShareCompetitorSchema),
})
export type VisibilityStatsShareOfVoice = z.infer<typeof visibilityStatsShareOfVoiceSchema>

export const visibilityStatsDtoSchema = z.object({
  project: z.string(),
  /**
   * `'provider'` when a per-provider breakdown was requested; OMITTED otherwise
   * (absent = no breakdown). Optional rather than nullable so the generated SDK
   * types it `groupBy?: 'provider'` — hey-api drops `null` on a single-value
   * nullable enum, which would mistype the no-breakdown (common) case.
   */
  groupBy: visibilityStatsGroupBySchema.optional(),
  window: visibilityStatsWindowSchema,
  /** Pooled counts across every tracked query in the window. */
  totals: visibilityStatsCountsSchema,
  /**
   * Pooled per-provider counts across every tracked query — present only when
   * `groupBy=provider`. Each entry's counts sum to `totals`.
   */
  byProvider: z.array(visibilityStatsProviderEntrySchema).optional(),
  /** Per-query stats, sorted by query text. Only queries with ≥1 snapshot in the window appear. */
  queries: z.array(visibilityStatsQueryEntrySchema),
  /** Pooled share of voice vs tracked competitors — present only when `shareOfVoice=1` was requested. */
  shareOfVoice: visibilityStatsShareOfVoiceSchema.optional(),
})
export type VisibilityStatsDto = z.infer<typeof visibilityStatsDtoSchema>

// ────────────────────────────────────────────────────────────────────────────
// Month-over-month comparison (`GET /projects/:name/visibility-compare`).
//
// A statistically honest m/m primitive so report builders never hand-roll AEO
// deltas. Method, per the statistician panel that scoped it:
//   - Primary metric = SHARE OF VOICE (brand vs competitor mentions in the SAME
//     answers). It cancels engine drift — when a provider's model updates it
//     names fewer/more brands overall, a shared factor that divides out of a
//     ratio but corrupts an absolute rate. So SoV carries the directional call;
//     the mention/cited RATE is context ("level"), `driftRobust: false`.
//   - Every rate is pooled per-snapshot over the whole month (K-invariant — a
//     mean of per-sweep rates, NOT `1-(1-p)^K` union which climbs with sweep
//     count, NOR an OR-over-providers per-query rate which climbs with provider
//     count; both were rejected precisely because they fabricate m/m moves).
//   - Comparison is restricted to common query/provider PAIRS present in BOTH
//     months so query/provider coverage churn can't leak in.
//   - Every figure carries a Wilson interval; the verdict is `within-noise` when
//     the two periods' CIs overlap, so a move on a handful of mentions is never
//     called a decline.
// ────────────────────────────────────────────────────────────────────────────

/** `within-noise`: the periods' CIs overlap (do not call it a change). `moved`: disjoint CIs. `insufficient-data`: a period has no denominator. */
export const visibilityCompareVerdictSchema = z.enum(['within-noise', 'moved', 'insufficient-data'])
export type VisibilityCompareVerdict = z.infer<typeof visibilityCompareVerdictSchema>

/** Sign of the point move — display only; never overrides the statistical `verdict`. */
export const visibilityCompareDirectionSchema = z.enum(['up', 'down', 'flat'])
export type VisibilityCompareDirection = z.infer<typeof visibilityCompareDirectionSchema>

/** One period's value for one metric: a proportion `[0,1]` with its Wilson interval and the raw counts it came from. */
export const visibilityCompareMetricPeriodSchema = z.object({
  /** The proportion in `[0,1]`, rounded to 4 dp; `null` when `denominator === 0` (undefined over no data). */
  point: z.number().nullable(),
  /** Wilson 95% lower bound `[0,1]`; `null` when `denominator === 0`. */
  ciLow: z.number().nullable(),
  /** Wilson 95% upper bound `[0,1]`; `null` when `denominator === 0`. */
  ciHigh: z.number().nullable(),
  /** Successes (mentions / citations / project-brand mentions). */
  numerator: z.number().int(),
  /** Sample size the proportion is over (checked snapshots / total / project+competitor brand mentions). */
  denominator: z.number().int(),
})
export type VisibilityCompareMetricPeriod = z.infer<typeof visibilityCompareMetricPeriodSchema>

export const visibilityCompareMetricKeySchema = z.enum([
  'mention-share-of-voice',
  'cited-share-of-voice',
  'mention-rate',
  'cited-rate',
])
export type VisibilityCompareMetricKey = z.infer<typeof visibilityCompareMetricKeySchema>

/** One metric compared across the two periods. */
export const visibilityCompareMetricSchema = z.object({
  key: visibilityCompareMetricKeySchema,
  /** Human label ("Named share of voice", "Cited rate", …). */
  label: z.string(),
  /**
   * `true` for the share-of-voice metrics, which cancel engine drift and so
   * carry the directional m/m call. `false` for the absolute rate metrics: when
   * `modelChanges` is non-empty a rate move may be the model, not the brand —
   * trust only `driftRobust` metrics for direction in that case.
   */
  driftRobust: z.boolean(),
  from: visibilityCompareMetricPeriodSchema,
  to: visibilityCompareMetricPeriodSchema,
  /** `to.point / from.point`; `null` when `from.point` is `0` or `null` (ratio undefined). */
  rateRatio: z.number().nullable(),
  /** Sign of `to.point - from.point`; `null` when either point is `null`. */
  direction: z.union([visibilityCompareDirectionSchema, z.null()]),
  verdict: visibilityCompareVerdictSchema,
})
export type VisibilityCompareMetric = z.infer<typeof visibilityCompareMetricSchema>

/** One compared period's run window. */
export const visibilityComparePeriodWindowSchema = z.object({
  /** The `YYYY-MM` requested. */
  month: z.string(),
  /** Resolved inclusive ISO bounds the month expanded to. */
  since: z.string(),
  until: z.string(),
  /** Completed/partial, non-probe answer-visibility runs in the month. */
  runCount: z.number().int(),
  /**
   * `true` when `runCount` is below the reliability floor (`< 5` sweeps): the
   * intervals are wide and a `moved` verdict is unlikely to be reachable. A
   * signal to raise the sweep schedule, surfaced so the report can caveat.
   */
  lowRunCount: z.boolean(),
})
export type VisibilityComparePeriodWindow = z.infer<typeof visibilityComparePeriodWindowSchema>

/**
 * The comparability frame: only query/provider pairs present in BOTH periods
 * are compared, so a query added/removed or different provider coverage between
 * months never masquerades as an AEO change. Exclusions are surfaced, not hidden.
 */
export const visibilityCompareBasketSchema = z.object({
  /** Distinct tracked queries with at least one common provider pair — the compared universe. */
  queryCount: z.number().int(),
  /** Queries observed only in `from` (dropped from the comparison). */
  excludedFromOnly: z.number().int(),
  /** Queries observed only in `to`. */
  excludedToOnly: z.number().int(),
  /**
   * The compared engine set: providers with ≥1 common query/provider pair.
   */
  providers: z.array(z.string()),
  /** Providers observed in either period that did not make the basket (dropped from the comparison). */
  excludedProviders: z.array(z.string()),
})
export type VisibilityCompareBasket = z.infer<typeof visibilityCompareBasketSchema>

/**
 * A provider whose stored `model` id set differs between the two periods (an
 * operator config change is visible here; a SILENT upstream version bump under
 * an unchanged id is NOT — the stored `model` is the configured id, so absence
 * of a change here does not prove the model was stable). Reported only when
 * BOTH periods observed at least one model id for the provider: an empty side
 * means "no model recorded" (legacy null-model rows), not a change. When
 * non-empty, the absolute rate metrics' moves are not cleanly attributable to
 * the brand.
 */
export const visibilityCompareModelChangeSchema = z.object({
  provider: z.string(),
  fromModels: z.array(z.string()),
  toModels: z.array(z.string()),
})
export type VisibilityCompareModelChange = z.infer<typeof visibilityCompareModelChangeSchema>

/** Per-provider raw counts for both periods — feeds the engines×months coverage matrix a report renders. */
export const visibilityCompareProviderRowSchema = z.object({
  provider: z.string(),
  from: z.object({ checked: z.number().int(), mentioned: z.number().int(), cited: z.number().int() }),
  to: z.object({ checked: z.number().int(), mentioned: z.number().int(), cited: z.number().int() }),
})
export type VisibilityCompareProviderRow = z.infer<typeof visibilityCompareProviderRowSchema>

/**
 * Per-query mention COUNT for both periods (a query counts if ≥1 provider named
 * it — the same per-query framing the dashboard overview hero uses). Reported as
 * a count, never a rate: the pooled "any sweep" per-query rate is K-inflated.
 */
export const visibilityCompareQueriesMentionedSchema = z.object({
  from: z.object({ count: z.number().int(), of: z.number().int() }),
  to: z.object({ count: z.number().int(), of: z.number().int() }),
})
export type VisibilityCompareQueriesMentioned = z.infer<typeof visibilityCompareQueriesMentionedSchema>

export const visibilityCompareDtoSchema = z.object({
  project: z.string(),
  from: visibilityComparePeriodWindowSchema,
  to: visibilityComparePeriodWindowSchema,
  basket: visibilityCompareBasketSchema,
  /** Ordered: mention SoV (primary), cited SoV, mention rate (level), cited rate. */
  metrics: z.array(visibilityCompareMetricSchema),
  queriesMentioned: visibilityCompareQueriesMentionedSchema,
  byProvider: z.array(visibilityCompareProviderRowSchema),
  /** Providers whose configured model id changed between the periods (empty = none detected). */
  modelChanges: z.array(visibilityCompareModelChangeSchema),
  /** Per-competitor mention counts within each period's basket (for the SoV detail). */
  competitors: z.object({
    from: z.array(visibilityStatsShareCompetitorSchema),
    to: z.array(visibilityStatsShareCompetitorSchema),
  }),
})
export type VisibilityCompareDto = z.infer<typeof visibilityCompareDtoSchema>

/**
 * Calendar-month window for a `YYYY-MM` string as inclusive ISO 8601 UTC bounds:
 * `since` = the first instant of the month, `until` = its last millisecond. Pure —
 * never reads the clock (a future-month guard, which needs "now", belongs in the
 * route). Throws `RangeError` on a malformed or out-of-range month so the caller
 * can map it to a `validationError`.
 */
export function calendarMonthBounds(month: string): { since: string; until: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) throw new RangeError('month must be in YYYY-MM format')
  const year = Number(match[1])
  const mon = Number(match[2])
  if (mon < 1 || mon > 12) throw new RangeError('month must be between 01 and 12')
  return {
    since: new Date(Date.UTC(year, mon - 1, 1)).toISOString(),
    until: new Date(Date.UTC(year, mon, 1) - 1).toISOString(),
  }
}
