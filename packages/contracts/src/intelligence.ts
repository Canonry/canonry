export interface InsightDto {
  id: string
  projectId: string
  runId: string | null
  type: 'regression' | 'gain' | 'opportunity'
  severity: 'critical' | 'high' | 'medium' | 'low'
  title: string
  keyword: string
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
  totalPairs: number
  citedPairs: number
  providerBreakdown: Record<string, { citedRate: number; cited: number; total: number }>
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
