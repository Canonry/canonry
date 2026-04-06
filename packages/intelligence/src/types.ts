export interface Snapshot {
  keyword: string
  provider: string
  cited: boolean
  citationUrl?: string
  position?: number
  snippet?: string
  competitorDomain?: string
}

export interface RunData {
  runId: string
  projectId: string
  completedAt: string
  snapshots: Snapshot[]
}

export interface Regression {
  keyword: string
  provider: string
  previousCitationUrl?: string
  previousPosition?: number
  currentRunId: string
  previousRunId: string
}

export interface Gain {
  keyword: string
  provider: string
  citationUrl?: string
  position?: number
  snippet?: string
  runId: string
}

export interface HealthScore {
  overallCitedRate: number
  totalPairs: number
  citedPairs: number
  providerBreakdown: Record<string, { citedRate: number; cited: number; total: number }>
}

export interface HealthTrend {
  current: number
  previous: number
  delta: number
}

export type SuspectedCause = 'competitor_gain' | 'indexing_loss' | 'content_change' | 'unknown'

export interface CauseAnalysis {
  cause: SuspectedCause
  competitorDomain?: string
  details?: string
}

export type InsightSeverity = 'critical' | 'high' | 'medium' | 'low'

export interface Insight {
  id: string
  type: 'regression' | 'gain' | 'opportunity'
  severity: InsightSeverity
  title: string
  keyword: string
  provider: string
  recommendation?: {
    action: string
    target?: string
    reason: string
  }
  cause?: CauseAnalysis
  createdAt: string
}

export interface AnalysisResult {
  regressions: Regression[]
  gains: Gain[]
  health: HealthScore
  trend?: HealthTrend
  insights: Insight[]
}
