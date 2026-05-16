export interface Snapshot {
  query: string
  provider: string
  cited: boolean
  citationUrl?: string
  position?: number
  snippet?: string
  /**
   * Location label this snapshot was produced at, or `undefined`/`null` for
   * projects with no configured locations. Detectors that compute transitions
   * include this in their dedup key so two siblings of a multi-location
   * fan-out (Florida cited / Michigan not-cited) don't get treated as a
   * sequential before/after pair.
   */
  location?: string | null
  /**
   * All competitor domains observed in this snapshot's competitorOverlap.
   * Detectors that filter against the project's tracked-competitor set must
   * iterate this array — taking the first element drops every additional
   * tracked rival on the same (query, provider) pair.
   */
  competitorDomains?: readonly string[]
  /**
   * Every domain the engine actually cited for this (query, provider) —
   * tracked competitors + third-party sources (publishers, gov sites,
   * unrelated brands). Used by cause analysis to name a displacing source
   * even when no tracked competitor appears, turning "audit yourself" into
   * "audit who's winning."
   */
  citedDomains?: readonly string[]
}

export interface RunData {
  runId: string
  projectId: string
  completedAt: string
  /**
   * Location label this run targeted, or `null`/`undefined` for locationless
   * runs (projects without configured locations, or the explicit "no
   * location" flag). Snapshots in a RunData all share this location. The
   * intelligence service is responsible for picking previousRun with a
   * matching location; the detectors enforce the invariant via their key
   * composition as defense-in-depth.
   */
  location?: string | null
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

export type SuspectedCause =
  | 'competitor_gain'
  | 'competitor_loss'
  | 'indexing_loss'
  | 'content_change'
  /** Engine cites third-party sources (publishers, gov sites, unrelated
   * brands) but no tracked competitor — points the analyst at the actual
   * displacing domains rather than at an opaque self-audit. */
  | 'third_party_displacement'
  | 'unknown'

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
