import type { ProjectDto, RunDto, RunStatus, GroundingSource } from '@ainyc/canonry-contracts'

export type MetricTone = 'positive' | 'caution' | 'negative' | 'neutral'
export type HealthState = 'checking' | 'ok' | 'error'
export type CitationState = 'cited' | 'lost' | 'emerging' | 'not-cited' | 'pending'

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

export interface SocialSparklineVm {
  /** 7-day daily mention counts (oldest to newest). */
  counts: number[]
  /** Net change from first to last day in the window. */
  delta: number
  /** Overall sentiment distribution across the 7d window. */
  sentimentSummary: { positive: number; neutral: number; negative: number }
}

export interface BrandHealthVm {
  /** AI citation rate — existing keyword visibility score (0-100). */
  aiVisibilityScore: number
  aiVisibilityTone: MetricTone
  /** Total engagement (likes + shares + comments) across monitored platforms. */
  socialReach: number
  /** Percentage of mentions with positive sentiment (0-100). */
  sentimentScore: number
  sentimentTone: MetricTone
  /** Percentage of social mentions that link to the canonical domain (0-100). */
  domainLinkRate: number
  domainLinkTone: MetricTone
  /** Composite brand visibility combining AI + social signals (0-100). */
  compositeScore: number
  compositeTone: MetricTone
}

export interface CrossSignalInsightVm {
  id: string
  tone: MetricTone
  title: string
  detail: string
  // TODO: populate when per-keyword cross-signal insights are implemented.
  keyword?: string
  // TODO: populate when per-platform cross-signal insights are implemented.
  platform?: string
}

export interface PortfolioProjectVm {
  project: ProjectDto
  visibilityScore: number
  visibilityDelta: string
  lastRun: RunListItemVm
  insight: string
  trend: number[]
  competitorPressureLabel: string
  /** 7-day social mention sparkline. Null when no social data is available. */
  socialSparkline: SocialSparklineVm | null
  /** Composite brand visibility score combining AI + social (null if no data). */
  brandVisibilityScore: number | null
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
  changeLabel: string
  answerSnippet: string
  citedDomains: string[]
  evidenceUrls: string[]
  competitorDomains: string[]
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

export interface ProjectCommandCenterVm {
  project: ProjectDto
  dateRangeLabel: string
  contextLabel: string
  visibilitySummary: ScoreSummaryVm
  providerScores: { provider: string; model: string | null; score: number; cited: number; total: number }[]
  competitorPressure: ScoreSummaryVm
  runStatus: ScoreSummaryVm
  insights: ProjectInsightVm[]
  visibilityEvidence: CitationInsightVm[]
  competitors: CompetitorVm[]
  recentRuns: RunListItemVm[]
  /** Combined brand health section (AI + social). Null when no social data available. */
  brandHealth: BrandHealthVm | null
  /** Cross-signal insights comparing AI visibility against social discussion trends. */
  crossSignalInsights: CrossSignalInsightVm[]
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

export interface SettingsVm {
  providerStatuses: ProviderStatusVm[]
  google: GoogleSettingsVm
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
