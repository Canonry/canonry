import type { ProjectDto } from '@ainyc/aeo-platform-contracts'
import type {
  ApiCompetitor,
  ApiKeyword,
  ApiProject,
  ApiRun,
  ApiRunDetail,
  ApiTimelineEntry,
} from './api.js'
import type {
  CitationInsightVm,
  CitationState,
  CompetitorVm,
  DashboardVm,
  MetricTone,
  PortfolioProjectVm,
  ProjectCommandCenterVm,
  ProjectInsightVm,
  RunListItemVm,
  ScoreSummaryVm,
} from './view-models.js'

function toProjectDto(p: ApiProject): ProjectDto {
  return {
    id: p.id,
    name: p.name,
    displayName: p.displayName,
    canonicalDomain: p.canonicalDomain,
    country: p.country,
    language: p.language,
    tags: p.tags,
    labels: p.labels,
    configSource: p.configSource as ProjectDto['configSource'],
    configRevision: p.configRevision,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch {
    return iso
  }
}

function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return 'Waiting'
  if (!finishedAt) return 'Running'
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 1000) return '<1s'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${minutes}m ${secs}s`
}

function kindLabel(kind: string): string {
  return kind === 'answer-visibility' ? 'Answer visibility sweep' : kind
}

function triggerLabel(trigger: string): string {
  return trigger === 'manual' ? 'Manual' : trigger === 'scheduled' ? 'Scheduled' : trigger === 'config-apply' ? 'Config apply' : trigger
}

function toRunListItem(run: ApiRun, projectName: string): RunListItemVm {
  return {
    id: run.id,
    projectId: run.projectId,
    projectName,
    kind: run.kind as RunListItemVm['kind'],
    kindLabel: kindLabel(run.kind),
    status: run.status as RunListItemVm['status'],
    trigger: (run.trigger ?? 'manual') as RunListItemVm['trigger'],
    createdAt: run.createdAt,
    startedAt: run.startedAt ? formatDate(run.startedAt) : formatDate(run.createdAt),
    duration: formatDuration(run.startedAt, run.finishedAt),
    statusDetail: run.error ?? statusDetailFromRun(run),
    summary: summaryFromRun(run),
    triggerLabel: triggerLabel(run.trigger),
  }
}

function statusDetailFromRun(run: ApiRun): string {
  switch (run.status) {
    case 'queued': return 'Waiting for execution slot.'
    case 'running': return 'Provider queries in progress.'
    case 'completed': return 'All keywords checked.'
    case 'partial': return 'Run completed with some keywords skipped.'
    case 'failed': return run.error ?? 'Run failed.'
    default: return ''
  }
}

function summaryFromRun(run: ApiRun): string {
  switch (run.status) {
    case 'queued': return 'Queued for execution'
    case 'running': return 'In progress'
    case 'completed': return 'Visibility sweep completed'
    case 'partial': return 'Partial completion'
    case 'failed': return 'Run failed'
    default: return run.status
  }
}

function computeVisibilityScore(snapshots: ApiRunDetail['snapshots']): number {
  if (snapshots.length === 0) return 0
  const cited = snapshots.filter(s => s.citationState === 'cited').length
  return Math.round((cited / snapshots.length) * 100)
}

function scoreTone(score: number): MetricTone {
  if (score >= 70) return 'positive'
  if (score >= 40) return 'caution'
  return 'negative'
}

function pressureTone(label: string): MetricTone {
  if (label === 'High') return 'negative'
  if (label === 'Moderate') return 'caution'
  return 'neutral'
}

function computeCompetitorPressure(snapshots: ApiRunDetail['snapshots'], competitorDomains: string[]): { label: string; count: number } {
  if (snapshots.length === 0 || competitorDomains.length === 0) {
    return { label: 'None', count: 0 }
  }
  const competitorSet = new Set(competitorDomains)
  let overlapCount = 0
  for (const snap of snapshots) {
    if (snap.citedDomains.some(d => competitorSet.has(d))) {
      overlapCount++
    }
  }
  const ratio = overlapCount / snapshots.length
  if (ratio >= 0.5) return { label: 'High', count: overlapCount }
  if (ratio >= 0.2) return { label: 'Moderate', count: overlapCount }
  return { label: 'Low', count: overlapCount }
}

function buildEvidenceFromTimeline(
  timeline: ApiTimelineEntry[],
  latestRunDetail: ApiRunDetail | null,
): CitationInsightVm[] {
  if (!latestRunDetail) return []

  const snapshotsByKeyword = new Map<string, ApiRunDetail['snapshots'][number]>()
  for (const snap of latestRunDetail.snapshots) {
    if (snap.keyword) {
      snapshotsByKeyword.set(snap.keyword, snap)
    }
  }

  return timeline.map((entry, idx) => {
    const latestRun = entry.runs.at(-1)
    const snap = snapshotsByKeyword.get(entry.keyword)
    const transition = latestRun?.transition ?? 'not-cited'
    const citationState: CitationState = transition === 'lost' ? 'lost'
      : transition === 'emerging' ? 'emerging'
      : transition === 'cited' ? 'cited'
      : 'not-cited'

    return {
      id: `evidence_${idx}`,
      keyword: entry.keyword,
      citationState,
      changeLabel: changeLabel(transition, entry.runs.length),
      answerSnippet: snap?.answerText ?? '',
      citedDomains: snap?.citedDomains ?? [],
      evidenceUrls: [],
      competitorDomains: snap?.competitorOverlap ?? [],
      relatedTechnicalSignals: [],
      summary: evidenceSummary(citationState, entry.keyword),
    }
  })
}

function changeLabel(transition: string, runCount: number): string {
  switch (transition) {
    case 'new': return 'First observation'
    case 'cited': return `Cited for ${runCount} runs`
    case 'lost': return 'Lost since last run'
    case 'emerging': return 'First citation'
    case 'not-cited': return `Not cited across ${runCount} runs`
    default: return transition
  }
}

function evidenceSummary(state: CitationState, keyword: string): string {
  switch (state) {
    case 'cited': return `Your domain is cited in AI answers for "${keyword}".`
    case 'lost': return `Citation was lost for "${keyword}". Competitors may have gained ground.`
    case 'emerging': return `Your domain is starting to appear in answers for "${keyword}".`
    case 'not-cited': return `No citation detected for "${keyword}".`
  }
}

function buildInsights(evidence: CitationInsightVm[]): ProjectInsightVm[] {
  const insights: ProjectInsightVm[] = []
  const lost = evidence.filter(e => e.citationState === 'lost')
  const emerging = evidence.filter(e => e.citationState === 'emerging')
  const notCited = evidence.filter(e => e.citationState === 'not-cited')

  if (lost.length > 0) {
    insights.push({
      id: 'insight_lost',
      tone: 'negative',
      title: `Lost citation on ${lost.length} keyword${lost.length > 1 ? 's' : ''}`,
      detail: `Keywords: ${lost.map(e => e.keyword).join(', ')}`,
      actionLabel: 'Open evidence',
      evidenceId: lost[0]!.id,
    })
  }

  if (emerging.length > 0) {
    insights.push({
      id: 'insight_emerging',
      tone: 'positive',
      title: `New citation on ${emerging.length} keyword${emerging.length > 1 ? 's' : ''}`,
      detail: `Keywords: ${emerging.map(e => e.keyword).join(', ')}`,
      actionLabel: 'Review evidence',
      evidenceId: emerging[0]!.id,
    })
  }

  if (notCited.length > 0) {
    insights.push({
      id: 'insight_gap',
      tone: 'caution',
      title: `${notCited.length} keyword${notCited.length > 1 ? 's' : ''} still uncited`,
      detail: 'These keywords have not been cited in any AI answer.',
      actionLabel: 'Inspect gap',
      evidenceId: notCited[0]!.id,
    })
  }

  if (insights.length === 0) {
    insights.push({
      id: 'insight_stable',
      tone: 'neutral',
      title: 'No significant changes',
      detail: 'Citation state is stable across all tracked keywords.',
      actionLabel: 'Monitor',
    })
  }

  return insights
}

function runStatusSummary(projectRuns: ApiRun[]): ScoreSummaryVm {
  const latest = projectRuns[0]
  if (!latest) {
    return {
      label: 'Run Status',
      value: 'None',
      delta: 'No runs yet',
      tone: 'neutral',
      description: 'Trigger a visibility sweep to start tracking.',
      trend: [],
    }
  }

  const value = latest.status === 'completed' ? 'Healthy'
    : latest.status === 'running' ? 'Running'
    : latest.status === 'queued' ? 'Queued'
    : latest.status === 'partial' ? 'Partial'
    : 'Failed'

  const tone: MetricTone = latest.status === 'completed' ? 'positive'
    : latest.status === 'failed' ? 'negative'
    : latest.status === 'partial' ? 'caution'
    : 'neutral'

  return {
    label: 'Run Status',
    value,
    delta: `${projectRuns.length} total runs`,
    tone,
    description: `Latest: ${kindLabel(latest.kind)} — ${latest.status}`,
    trend: [],
  }
}

export interface ProjectData {
  project: ApiProject
  runs: ApiRun[]
  keywords: ApiKeyword[]
  competitors: ApiCompetitor[]
  timeline: ApiTimelineEntry[]
  latestRunDetail: ApiRunDetail | null
}

export function buildProjectCommandCenter(data: ProjectData): ProjectCommandCenterVm {
  const dto = toProjectDto(data.project)
  const evidence = buildEvidenceFromTimeline(data.timeline, data.latestRunDetail)
  const snapshots = data.latestRunDetail?.snapshots ?? []
  const visScore = computeVisibilityScore(snapshots)
  const pressure = computeCompetitorPressure(snapshots, data.competitors.map(c => c.domain))
  const insights = buildInsights(evidence)

  const sortedRuns = [...data.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const runItems = sortedRuns.map(r => toRunListItem(r, data.project.displayName || data.project.name))

  return {
    project: dto,
    dateRangeLabel: 'All time',
    contextLabel: `${dto.country} / ${dto.language.toUpperCase()}`,
    visibilitySummary: {
      label: 'Answer Visibility',
      value: snapshots.length > 0 ? `${visScore} / 100` : 'No data',
      delta: snapshots.length > 0 ? `${snapshots.filter(s => s.citationState === 'cited').length} of ${snapshots.length} cited` : 'Run a sweep first',
      tone: snapshots.length > 0 ? scoreTone(visScore) : 'neutral',
      description: snapshots.length > 0
        ? `${visScore}% of tracked keywords cite your domain in AI answers.`
        : 'No visibility data yet. Trigger a run to start tracking.',
      trend: [],
    },
    readinessSummary: undefined,
    competitorPressure: {
      label: 'Competitor Pressure',
      value: pressure.label,
      delta: pressure.count > 0 ? `${pressure.count} overlapping citations` : 'No overlap detected',
      tone: pressureTone(pressure.label),
      description: data.competitors.length > 0
        ? `${data.competitors.length} competitor${data.competitors.length > 1 ? 's' : ''} tracked.`
        : 'No competitors configured.',
      trend: [],
    },
    runStatus: runStatusSummary(sortedRuns),
    insights,
    visibilityEvidence: evidence,
    technicalFindings: undefined,
    competitors: data.competitors.map((c, i) => ({
      id: c.id || `comp_${i}`,
      domain: c.domain,
      pressureLabel: 'Tracked',
      movement: '',
      notes: '',
    })),
    recentRuns: runItems.slice(0, 5),
  }
}

export function buildPortfolioProject(data: ProjectData): PortfolioProjectVm {
  const dto = toProjectDto(data.project)
  const snapshots = data.latestRunDetail?.snapshots ?? []
  const visScore = computeVisibilityScore(snapshots)
  const pressure = computeCompetitorPressure(snapshots, data.competitors.map(c => c.domain))
  const sortedRuns = [...data.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const latestRun = sortedRuns[0]
  const runItem = latestRun
    ? toRunListItem(latestRun, data.project.displayName || data.project.name)
    : {
        id: 'none',
        projectId: data.project.id,
        projectName: data.project.displayName || data.project.name,
        kind: 'answer-visibility' as const,
        kindLabel: 'No runs yet',
        status: 'queued' as const,
        trigger: 'manual' as const,
        createdAt: '',
        startedAt: '',
        duration: '',
        statusDetail: '',
        summary: 'No runs yet',
        triggerLabel: '',
      }

  const cited = snapshots.filter(s => s.citationState === 'cited').length

  return {
    project: dto,
    visibilityScore: visScore,
    visibilityDelta: snapshots.length > 0 ? `${cited} of ${snapshots.length} cited` : 'No data',
    readinessScore: undefined,
    readinessDelta: undefined,
    lastRun: runItem,
    insight: snapshots.length > 0
      ? `${visScore}% visibility across ${snapshots.length} keywords.`
      : 'No runs completed yet.',
    trend: [],
    competitorPressureLabel: pressure.label,
  }
}

export function buildDashboard(projectDataList: ProjectData[]): DashboardVm {
  const allRuns: RunListItemVm[] = []
  const projectCenters: ProjectCommandCenterVm[] = []
  const portfolioProjects: PortfolioProjectVm[] = []

  for (const data of projectDataList) {
    projectCenters.push(buildProjectCommandCenter(data))
    portfolioProjects.push(buildPortfolioProject(data))
    const sortedRuns = [...data.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    for (const run of sortedRuns) {
      allRuns.push(toRunListItem(run, data.project.displayName || data.project.name))
    }
  }

  // Sort all runs by createdAt desc
  allRuns.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const hasProjects = projectDataList.length > 0

  return {
    portfolioOverview: {
      projects: portfolioProjects,
      attentionItems: hasProjects
        ? buildAttentionItems(projectCenters)
        : [{
            id: 'attention_setup',
            tone: 'neutral',
            title: 'No projects yet',
            detail: 'Create your first project using the setup wizard, CLI, or API.',
            actionLabel: 'Open setup',
            href: '/setup',
          }],
      recentRuns: allRuns.slice(0, 5),
      systemHealth: [
        { id: 'api', label: 'API', tone: 'positive', detail: 'Connected', meta: 'Real-time data' },
        { id: 'provider', label: 'Gemini', tone: 'positive', detail: 'Configured', meta: 'Provider active' },
      ],
      lastUpdatedAt: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
      ...(!hasProjects ? {
        emptyState: {
          title: 'No projects yet',
          detail: 'Canonry becomes useful after one project, a small keyword set, and one competitor list are in place.',
          ctaLabel: 'Launch setup',
          ctaHref: '/setup',
        },
      } : {}),
    },
    projects: projectCenters,
    runs: allRuns,
    setup: {
      healthChecks: [
        { id: 'api', label: 'API reachable', detail: 'API is responding.', state: 'ready', guidance: 'Required for project creation and run history.' },
        { id: 'provider', label: 'Provider configured', detail: 'Gemini key is configured.', state: 'ready', guidance: 'Required for answer-visibility sweeps.' },
      ],
      projectDraft: { name: '', canonicalDomain: '', country: 'US', language: 'en' },
      keywordImportState: { mode: 'paste', keywordCount: 0, preview: [] },
      competitorDraft: { domains: [], notes: 'Use the CLI to add competitors.' },
      launchState: {
        enabled: hasProjects,
        ctaLabel: hasProjects ? 'Trigger run' : 'Create a project first',
        summary: hasProjects ? 'Ready to run.' : 'Create a project first to launch a run.',
      },
    },
    settings: {
      providerStatus: { name: 'Gemini', state: 'ready', detail: 'Provider is configured via canonry init.' },
      quotaSummary: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
      selfHostNotes: [
        'Configuration is stored in ~/.canonry/config.yaml.',
        'Database is SQLite at ~/.canonry/data.db.',
        'API key was auto-generated during canonry init.',
      ],
      bootstrapNote: 'Manage settings via ~/.canonry/config.yaml and restart the server.',
    },
  }
}

function buildAttentionItems(projectCenters: ProjectCommandCenterVm[]) {
  const items: DashboardVm['portfolioOverview']['attentionItems'] = []

  for (const pc of projectCenters) {
    const lostEvidence = pc.visibilityEvidence.filter(e => e.citationState === 'lost')
    if (lostEvidence.length > 0) {
      items.push({
        id: `attention_${pc.project.id}_lost`,
        tone: 'negative',
        title: `${pc.project.displayName || pc.project.name} lost citations`,
        detail: `${lostEvidence.length} keyword${lostEvidence.length > 1 ? 's' : ''} lost citation.`,
        actionLabel: 'Open project',
        href: `/projects/${pc.project.id}`,
      })
    }

    const activeRuns = pc.recentRuns.filter(r => r.status === 'running' || r.status === 'queued')
    if (activeRuns.length > 0) {
      items.push({
        id: `attention_${pc.project.id}_active`,
        tone: 'neutral',
        title: `${pc.project.displayName || pc.project.name} has active runs`,
        detail: `${activeRuns.length} run${activeRuns.length > 1 ? 's' : ''} in progress.`,
        actionLabel: 'View runs',
        href: '/runs',
      })
    }
  }

  if (items.length === 0) {
    items.push({
      id: 'attention_stable',
      tone: 'positive',
      title: 'All projects stable',
      detail: 'No citation losses or active runs to flag.',
      actionLabel: 'View portfolio',
      href: '/',
    })
  }

  return items
}
