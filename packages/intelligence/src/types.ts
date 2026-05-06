export interface Snapshot {
  query: string
  provider: string
  cited: boolean
  citationUrl?: string
  position?: number
  snippet?: string
  /**
   * All competitor domains observed in this snapshot's competitorOverlap.
   * Detectors that filter against the project's tracked-competitor set must
   * iterate this array — taking the first element drops every additional
   * tracked rival on the same (query, provider) pair.
   */
  competitorDomains?: readonly string[]
}

export interface RunData {
  runId: string
  projectId: string
  completedAt: string
  snapshots: Snapshot[]
}

export interface Regression {
  query: string
  provider: string
  previousCitationUrl?: string
  previousPosition?: number
  currentRunId: string
  previousRunId: string
}

export interface Gain {
  query: string
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

export type SuspectedCause = 'competitor_gain' | 'competitor_loss' | 'indexing_loss' | 'content_change' | 'unknown'

export interface CauseAnalysis {
  cause: SuspectedCause
  competitorDomain?: string
  details?: string
}

export type InsightSeverity = 'critical' | 'high' | 'medium' | 'low'

export type InsightType =
  | 'regression'
  | 'gain'
  | 'opportunity'
  | 'first-citation'
  | 'provider-pickup'
  | 'persistent-gap'
  | 'competitor-gained'
  | 'competitor-lost'

export interface Insight {
  id: string
  type: InsightType
  severity: InsightSeverity
  title: string
  query: string
  provider: string
  recommendation?: {
    action: string
    target?: string
    reason: string
  }
  cause?: CauseAnalysis
  createdAt: string
}

export interface FirstCitation {
  query: string
  provider: string
  citationUrl?: string
  position?: number
  runId: string
}

export interface ProviderPickup {
  query: string
  provider: string
  citationUrl?: string
  position?: number
  runId: string
}

export interface PersistentGap {
  query: string
  streak: number
  threshold: number
}

export interface CompetitorChange {
  query: string
  competitorDomain: string
}

export interface AnalysisResult {
  regressions: Regression[]
  gains: Gain[]
  firstCitations: FirstCitation[]
  providerPickups: ProviderPickup[]
  persistentGaps: PersistentGap[]
  competitorGains: CompetitorChange[]
  competitorLosses: CompetitorChange[]
  health: HealthScore
  trend?: HealthTrend
  insights: Insight[]
}
