export interface Snapshot {
  query: string
  provider: string
  /**
   * Whether the project's domain is in the answer's source links. TRI-STATE:
   * `true` cited, `false` the sources were checked and none is the project's,
   * `null` not measured (the engine returns no sources, so nothing was
   * observed about citation). A null is never a miss: every citation detector
   * reads `=== true` / `=== false`, and `observedKeys` leaves it out.
   */
  cited: boolean | null
  /**
   * Did the project's brand/domain appear in the actual LLM answer TEXT
   * (the prose the model returns)? Independent of `cited` (source-list
   * presence) — a model can do either, both, or neither. TRI-STATE:
   * `true` mentioned, `false` not mentioned, `null`/`undefined` "not
   * checked" (legacy rows written before the signal existed, or providers
   * that don't emit it). Health counts a pair as mentioned ONLY when this
   * is exactly `true`; null is never coerced to false.
   */
  answerMentioned?: boolean | null
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
   * Tracked competitor domains present in source-list citation evidence.
   * Answer-text mentions are deliberately excluded: every detector consuming
   * this field emits a citation-specific cause or gained/lost-citation alert.
   */
  citedCompetitorDomains?: readonly string[]
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

/** One provider's health counts. `citedRate` is over its measured pairs, null when it has none. */
export interface HealthProviderBreakdown {
  citedRate: number | null
  mentionRate: number
  cited: number
  mentioned: number
  total: number
  /** Pairs whose engine returns no sources; out of `citedRate` entirely. */
  citationNotMeasured: number
}

export interface HealthScore {
  /**
   * `citedPairs` over the pairs whose sources were checked (`totalPairs -
   * citationNotMeasuredPairs`). Null when no pair was: the engines return no
   * sources, so citation was not measured. Never 0 for that case.
   */
  overallCitedRate: number | null
  /**
   * Share of (query × provider) pairs where the project was MENTIONED in the
   * answer text. Independent of `overallCitedRate` — never derived from it.
   * `mentionedPairs / totalPairs`, or 0 when there are no pairs. Pairs with a
   * null `answerMentioned` ("not checked") count toward the denominator but
   * never the numerator.
   */
  overallMentionRate: number
  totalPairs: number
  citedPairs: number
  /** Pairs whose engine returns no sources (`Snapshot.cited === null`). */
  citationNotMeasuredPairs: number
  mentionedPairs: number
  providerBreakdown: Record<string, HealthProviderBreakdown>
}

/** Cited-rate movement between the latest two runs; a side with no measured pair is null. */
export interface HealthTrend {
  current: number | null
  previous: number | null
  /** Null unless both sides were measured. */
  delta: number | null
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
  // Google Business Profile (local-AEO) insights — produced after a gbp-sync
  // run, scoped to a location rather than a (query, provider) pair.
  | 'gbp-lodging-gap'
  | 'gbp-listing-discrepancy'
  | 'gbp-cta-gap'
  | 'gbp-description-missing'
  | 'gbp-metric-drop'
  | 'gbp-keyword-drop'

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
