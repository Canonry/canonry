/**
 * Surfaces high-impression GSC queries that aren't in the project's tracked
 * basket yet. Operator-facing recommendation: "these queries already bring
 * you Google traffic — add them to see how LLMs answer them too." Cheap
 * win, drives basket growth from real demand signal rather than guesswork.
 *
 * Pure function. The caller (composites layer) pre-aggregates per-query GSC
 * impressions/clicks/position in SQL so this helper just ranks and explains.
 */

export interface SuggestedQueryGscRow {
  query: string
  impressions: number
  clicks: number
  /** Impressions-weighted average rank across the window. Lower = better. */
  avgPosition: number
}

export interface SuggestedQueryRow {
  query: string
  impressions: number
  clicks: number
  avgPosition: number
  /** One-line operator-facing rationale for the suggestion. */
  reason: string
}

export interface BuildSuggestedQueriesOptions {
  /** Project's currently-tracked queries (raw strings, any case). */
  trackedQueries: readonly string[]
  /** Skip GSC queries below this impression floor. Default 10 — filters
   *  long-tail noise that would crowd out real opportunities. */
  minImpressions?: number
  /** Cap the returned suggestions. Default 10 — keeps the UI focused. */
  limit?: number
}

export interface SuggestedQueriesResult {
  rows: SuggestedQueryRow[]
  /** Eligible (above floor, not already tracked) candidates before `limit`
   *  truncation. Lets the UI say "showing 10 of 47" when relevant. */
  totalCandidates: number
  /** GSC queries that were dropped because the basket already covers them.
   *  Useful for the explanatory copy underneath the panel. */
  skippedAlreadyTracked: number
}

const DEFAULT_MIN_IMPRESSIONS = 10
const DEFAULT_LIMIT = 10

export function buildSuggestedQueries(
  gscRows: readonly SuggestedQueryGscRow[],
  options: BuildSuggestedQueriesOptions,
): SuggestedQueriesResult {
  const minImpressions = options.minImpressions ?? DEFAULT_MIN_IMPRESSIONS
  const limit = options.limit ?? DEFAULT_LIMIT

  // Normalize tracked queries once. Match is case-insensitive + trim so
  // operator-entered "Best CRM" doesn't get re-suggested as gsc's "best crm".
  const trackedSet = new Set(options.trackedQueries.map(normalizeQuery))

  let skippedAlreadyTracked = 0
  const candidates: SuggestedQueryRow[] = []

  for (const row of gscRows) {
    if (row.impressions < minImpressions) continue
    const normalized = normalizeQuery(row.query)
    if (normalized.length === 0) continue
    if (trackedSet.has(normalized)) {
      skippedAlreadyTracked++
      continue
    }
    candidates.push({
      query: row.query,
      impressions: row.impressions,
      clicks: row.clicks,
      avgPosition: row.avgPosition,
      reason: buildReason(row),
    })
  }

  candidates.sort((a, b) => b.impressions - a.impressions)
  const rows = candidates.slice(0, limit)

  return {
    rows,
    totalCandidates: candidates.length,
    skippedAlreadyTracked,
  }
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase()
}

function buildReason(row: SuggestedQueryGscRow): string {
  const impressionsLabel = formatImpressions(row.impressions)
  if (row.avgPosition <= 10) {
    return `${impressionsLabel} impressions · ranks #${Math.round(row.avgPosition)} on Google`
  }
  if (row.avgPosition <= 20) {
    return `${impressionsLabel} impressions · ranks #${Math.round(row.avgPosition)} — close to top 10`
  }
  return `${impressionsLabel} impressions · ranks #${Math.round(row.avgPosition)}`
}

function formatImpressions(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toString()
}
