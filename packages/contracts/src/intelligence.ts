export type InsightType =
  | 'regression'
  | 'gain'
  | 'opportunity'
  | 'first-citation'
  | 'provider-pickup'
  | 'persistent-gap'
  | 'competitor-gained'
  | 'competitor-lost'
  // Google Business Profile (local-AEO) insights — produced after a gbp-sync
  // run, scoped to a location rather than a (query, provider) pair.
  | 'gbp-lodging-gap'
  | 'gbp-listing-discrepancy'
  | 'gbp-cta-gap'
  | 'gbp-description-missing'
  | 'gbp-metric-drop'
  | 'gbp-keyword-drop'

export interface InsightDto {
  id: string
  projectId: string
  runId: string | null
  type: InsightType
  severity: 'critical' | 'high' | 'medium' | 'low'
  title: string
  query: string
  provider: string
  recommendation?: {
    action: string
    target?: string
    reason: string
  }
  cause?: {
    cause: string
    competitorDomain?: string
    details?: string
  }
  dismissed: boolean
  createdAt: string
}

export interface HealthSnapshotDto {
  id: string
  projectId: string
  runId: string | null
  overallCitedRate: number
  /**
   * Share of (query × provider) pairs where the project was MENTIONED in the
   * answer text. Independent of `overallCitedRate` — never derived from it.
   * Legacy snapshots persisted before the mention columns existed read back
   * as 0 (the API coalesces NULL→0).
   */
  overallMentionRate: number
  totalPairs: number
  citedPairs: number
  /** Count of pairs mentioned in the answer text. Legacy rows read back as 0. */
  mentionedPairs: number
  providerBreakdown: Record<string, { citedRate: number; mentionRate: number; cited: number; mentioned: number; total: number }>
  createdAt: string
  /**
   * `'ready'` when the snapshot reflects real data; `'no-data'` for the
   * sentinel returned by `/health/latest` when a project has no health
   * snapshots yet (newly created, or only failed runs). Numeric fields are
   * zero and `providerBreakdown` is `{}` in the no-data case.
   */
  status: 'ready' | 'no-data'
  /** Reason for `status === 'no-data'`. Absent when `status === 'ready'`. */
  reason?: 'no-runs-yet'
}
