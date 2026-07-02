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
