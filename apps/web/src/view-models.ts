import type { McpHealth, ProjectDto, QueryClass, RunDto, RunStatus, GroundingSource, MentionShareDto, MovementComparisonDto, ProjectOverviewProviderScoreDto, SuggestedQueriesSummaryDto, SentimentOverview } from '@ainyc/canonry-contracts'

export type MetricTone = 'positive' | 'caution' | 'negative' | 'neutral'
/** `disabled` is a service switched off on purpose, such as the public demo's worker. */
export type HealthState = 'checking' | 'ok' | 'disabled' | 'error'
export type CitationState = 'cited' | 'lost' | 'emerging' | 'not-cited' | 'pending'
export type VisibilityState = 'visible' | 'not-visible' | 'pending'
/** Canonical-vocabulary equivalent of `VisibilityState`. New consumers prefer this. */
export type MentionState = 'mentioned' | 'not-mentioned' | 'pending'

export interface ServiceStatus {
  label: string
  state: HealthState
  detail: string
  version?: string
  databaseConfigured?: boolean
  lastHeartbeatAt?: string
  statusCode?: number
  hint?: string
  updateAvailable?: UpdateAvailable
  mcp?: McpHealth
}

export interface UpdateAvailable {
  current: string
  latest: string
  url: string
  upgradeCommand: string
}

export interface HealthSnapshot {
  apiStatus: ServiceStatus
  workerStatus: ServiceStatus
}

export interface ScoreSummaryVm {
  label: string
  value: string
  delta: string
  tone: MetricTone
  description: string
  tooltip?: string
  trend: number[]
  progress?: number
  providerCoverage?: string
}

export interface AttentionItemVm {
  id: string
  tone: MetricTone
  title: string
  detail: string
  /** Omitted for non-actionable status items (e.g. "All projects stable") —
   *  the renderer shows those as a static row instead of a dead link. */
  actionLabel?: string
  href?: string
}

export interface SystemHealthCardVm {
  id: string
  label: string
  tone: MetricTone
  detail: string
  meta: string
}

export interface RunListItemVm extends RunDto {
  projectName: string
  kindLabel: string
  startedAt: string
  duration: string
  statusDetail: string
  summary: string
  triggerLabel: string
}

export interface PortfolioProjectVm {
  sentiment?: SentimentOverview
  project: ProjectDto
  /** False when saved mention evidence is unavailable; zero is a measured result. */
  hasMeasurement?: boolean
  /** Headline metric — Mention Coverage (% of tracked queries whose AI answer
   *  text mentioned the brand). This is the key portfolio metric, not cited. */
  mentionScore: number
  mentionDelta: string
  mentionTone: MetricTone
  providerCoverage?: string
  lastRun: RunListItemVm
  insight: string
  trend: number[]
  competitorPressureLabel: string
}

export interface PortfolioOverviewVm {
  projects: PortfolioProjectVm[]
  attentionItems: AttentionItemVm[]
  recentRuns: RunListItemVm[]
  systemHealth: SystemHealthCardVm[]
  emptyState?: {
    title: string
    detail: string
    ctaLabel: string
    ctaHref: string
  }
}

export interface RunHistoryPoint {
  runId: string
  citationState: string
  createdAt: string
  model?: string | null
  answerMentioned?: boolean
  /** @deprecated legacy alias for `mentionState`. */
  visibilityState?: VisibilityState
  /** @deprecated legacy alias for `mentionTransition`. */
  visibilityTransition?: string
  mentionState?: MentionState
  mentionTransition?: string
}

export type EvidenceHistoryScope = 'query' | 'model' | 'provider'

export interface ModelTransitionVm {
  runId: string
  createdAt: string
  fromModel: string | null
  toModel: string | null
}

export interface CitationInsightVm {
  queryId?: string | null
  sourceSnapshotId?: string | null
  sourceRunId?: string | null
  id: string
  query: string
  /** Project-wide read-time class; unavailable without usable brand identities. */
  queryClass?: QueryClass | null
  provider: string
  model: string | null
  location: string | null
  citationState: CitationState
  answerMentioned?: boolean
  visibilityState?: VisibilityState
  visibilityChangeLabel?: string
  changeLabel: string
  answerSnippet: string
  citedDomains: string[]
  evidenceUrls: string[]
  /** Tracked competitors present in grounding/source URLs. Source-side only. */
  citedCompetitorDomains?: string[]
  /** Tracked competitors whose brand appears in the answer prose. Answer-side only. */
  mentionedCompetitorDomains?: string[]
  /** The names and written hosts the server matched for `mentionedCompetitorDomains` (curated aliases included). */
  mentionedCompetitorTerms?: string[]
  /** Neutral union for filtering/navigation only. Never label this as an answer mention or citation. */
  competitorDomains: string[]
  recommendedCompetitors?: string[]
  matchedTerms?: string[]
  relatedTechnicalSignals: string[]
  groundingSources: GroundingSource[]
  /** Web search queries this AI model issued while researching the prompt (Gemini grounding queries, the CDP-submitted query, etc.). */
  searchQueries?: string[]
  summary: string
  runHistory: RunHistoryPoint[]
  historyScope?: EvidenceHistoryScope
  modelsSeen?: string[]
  modelTransitions?: ModelTransitionVm[]
}

export interface AffectedPhrase {
  query: string
  evidenceId: string
  provider?: string
  citationState: CitationState
  /**
   * False when `citationState` stands for something other than the project's
   * own site-wide citation (a competitor's or a Business Profile signal), so
   * it must not be labelled as the project's domain being cited.
   */
  siteCitation?: boolean
}

/** What kind of operator action this insight calls for. Used to group the
 *  Opportunities panel as Write / Investigate / Monitor / Track cards. The
 *  `track` group is GSC-derived (suggested queries to add to the basket), not
 *  insight-derived — it doesn't actually appear on `ProjectInsightVm`. */
export type InsightActionGroup = 'write' | 'investigate' | 'monitor'

export interface ProjectInsightVm {
  id: string
  tone: MetricTone
  title: string
  detail: string
  actionLabel: string
  actionGroup: InsightActionGroup
  evidenceId?: string
  affectedPhrases: AffectedPhrase[]
}

export interface CompetitorVm {
  id: string
  domain: string
  /** Operator-curated names this competitor goes by in answer text. */
  aliases?: string[]
  /** Names detected automatically from the project's stored answers (labelled "auto"). */
  autoAliases?: string[]
  citationCount: number
  totalQueries: number
  pressureLabel: string
  citedQueries: string[]
  movement: string
  notes: string
}

export type MovementComparisonVm = MovementComparisonDto

export interface QueryCountsVm {
  cited: number
  total: number
}

export interface ProjectCommandCenterVm {
  project: ProjectDto
  contextLabel: string
  /** Primary headline gauge — Mention Coverage. The dashboard renders this as the big radial gauge. */
  mentionSummary: ScoreSummaryVm
  /** Secondary tile — Citation Coverage (legacy "Answer Visibility"). */
  visibilitySummary: ScoreSummaryVm
  /** Mention Share — head-to-head competitive metric. Carries breakdown so
   *  the hero drilldown can render the per-competitor table without re-fetching. */
  /** `unavailable` marks the client-side placeholder built when the /overview
   *  fetch failed. Its counters are all zero, which is indistinguishable from a
   *  project that has never swept, so the distinction has to be carried
   *  explicitly rather than inferred. */
  mentionShareSummary: MentionShareDto & { unavailable?: boolean }
  queryCounts: QueryCountsVm
  /** The latest sweep's citation gaps over all queries together (`overview.scores.gapQueries`). */
  gapQueries: ScoreSummaryVm
  /** The latest sweep's mention gaps over all queries together (`overview.scores.mentionGaps`). */
  mentionGaps: ScoreSummaryVm
  indexCoverage: ScoreSummaryVm
  /** The latest sweep's citation rate per engine and model, over all queries (`overview.providerScores`). */
  providerScores: ProjectOverviewProviderScoreDto[]
  competitorPressure: ScoreSummaryVm
  runStatus: ScoreSummaryVm
  movementComparison: MovementComparisonVm
  insights: ProjectInsightVm[]
  visibilityEvidence: CitationInsightVm[]
  competitors: CompetitorVm[]
  /** The newest five runs of any status: a presentation slice for Past sweeps and the running state. */
  recentRuns: RunListItemVm[]
  /**
   * Completed and partial AI Visibility sweeps, newest first, probes left out,
   * from the whole run list. Anything that names the latest or an earlier
   * sweep reads these, never `recentRuns`, which newer failures can fill.
   */
  visibilitySweeps: RunListItemVm[]
  /** Suggested queries to add to tracking — high-impression GSC queries that
   *  aren't yet in the basket. Renders as the fourth Opportunities card. */
  suggestedQueries: SuggestedQueriesSummaryDto
}

export interface SetupHealthCheckVm {
  id: string
  label: string
  detail: string
  state: 'ready' | 'attention'
  guidance: string
}

export interface SetupWizardVm {
  healthChecks: SetupHealthCheckVm[]
  projectDraft: {
    name: string
    canonicalDomain: string
    country: string
    language: string
  }
  queryImportState: {
    mode: 'paste' | 'csv'
    queryCount: number
    preview: string[]
  }
  competitorDraft: {
    domains: string[]
    notes: string
  }
  launchState: {
    enabled: boolean
    ctaLabel: string
    blockedReason?: string
    summary: string
  }
}

export interface ProviderStatusVm {
  name: string
  displayName?: string
  keyUrl?: string
  modelHint?: string
  model?: string
  defaultModel?: string
  state: 'ready' | 'needs-config'
  detail: string
  quota?: {
    maxConcurrency: number
    maxRequestsPerMinute: number
    maxRequestsPerDay: number
  }
}

export interface GoogleSettingsVm {
  state: 'ready' | 'needs-config'
  detail: string
}

export interface BingSettingsVm {
  state: 'ready' | 'needs-config'
  detail: string
}

export interface SettingsVm {
  providerStatuses: ProviderStatusVm[]
  google: GoogleSettingsVm
  bing: BingSettingsVm
  selfHostNotes: string[]
  bootstrapNote: string
}

export interface DashboardVm {
  portfolioOverview: PortfolioOverviewVm
  projects: ProjectCommandCenterVm[]
  runs: RunListItemVm[]
  setup: SetupWizardVm
  settings: SettingsVm
}

export type RunFilter = 'all' | RunStatus
