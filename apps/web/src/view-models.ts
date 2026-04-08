import type { ProjectDto, RunDto, RunStatus, GroundingSource } from '@ainyc/canonry-contracts'

export type MetricTone = 'positive' | 'caution' | 'negative' | 'neutral'
export type HealthState = 'checking' | 'ok' | 'error'
export type CitationState = 'cited' | 'lost' | 'emerging' | 'not-cited' | 'pending'
export type VisibilityState = 'visible' | 'not-visible' | 'pending'

export interface ServiceStatus {
  label: string
  state: HealthState
  detail: string
  version?: string
  databaseConfigured?: boolean
  lastHeartbeatAt?: string
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
  actionLabel: string
  href: string
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
  project: ProjectDto
  visibilityScore: number
  visibilityDelta: string
  visibilityTone: MetricTone
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
  lastUpdatedAt: string
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
  visibilityState?: VisibilityState
  visibilityTransition?: string
}

export type EvidenceHistoryScope = 'keyword' | 'model' | 'provider'

export interface ModelTransitionVm {
  runId: string
  createdAt: string
  fromModel: string | null
  toModel: string | null
}

export interface CitationInsightVm {
  id: string
  keyword: string
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
  competitorDomains: string[]
  recommendedCompetitors?: string[]
  matchedTerms?: string[]
  relatedTechnicalSignals: string[]
  groundingSources: GroundingSource[]
  summary: string
  runHistory: RunHistoryPoint[]
  historyScope?: EvidenceHistoryScope
  modelsSeen?: string[]
  modelTransitions?: ModelTransitionVm[]
}

export interface AffectedPhrase {
  keyword: string
  evidenceId: string
  provider?: string
  citationState: CitationState
}

export interface ProjectInsightVm {
  id: string
  tone: MetricTone
  title: string
  detail: string
  actionLabel: string
  evidenceId?: string
  affectedPhrases: AffectedPhrase[]
}

export interface CompetitorVm {
  id: string
  domain: string
  citationCount: number
  totalKeywords: number
  pressureLabel: string
  citedKeywords: string[]
  movement: string
  notes: string
}

export interface MovementSummaryVm {
  gained: number
  lost: number
  tone: MetricTone
  hasPreviousRun: boolean
}

export interface KeywordCountsVm {
  cited: number
  total: number
}

export interface ProjectCommandCenterVm {
  project: ProjectDto
  dateRangeLabel: string
  contextLabel: string
  visibilitySummary: ScoreSummaryVm
  keywordCounts: KeywordCountsVm
  gapKeyPhrases: ScoreSummaryVm
  indexCoverage: ScoreSummaryVm
  providerScores: { provider: string; model: string | null; score: number; cited: number; total: number }[]
  competitorPressure: ScoreSummaryVm
  runStatus: ScoreSummaryVm
  movementSummary: MovementSummaryVm
  insights: ProjectInsightVm[]
  visibilityEvidence: CitationInsightVm[]
  competitors: CompetitorVm[]
  recentRuns: RunListItemVm[]
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
  keywordImportState: {
    mode: 'paste' | 'csv'
    keywordCount: number
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
