import type { ProjectDto } from '@ainyc/canonry-contracts'
import type {
  ApiCompetitor,
  ApiKeyword,
  ApiProject,
  ApiRun,
  ApiRunDetail,
  ApiSettings,
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
    statusDetail: run.error ? formatErrorDetail(run.error) : statusDetailFromRun(run),
    summary: summaryFromRun(run),
    triggerLabel: triggerLabel(run.trigger),
  }
}

function formatErrorDetail(error: string): string {
  // Extract a human-readable message from raw API error JSON/strings
  // Try to pull the "message" field from JSON error objects
  try {
    const parsed = JSON.parse(error)
    if (typeof parsed === 'object' && parsed !== null) {
      // Google API errors often nest: [{error: {message: "..."}}] or {message: "..."}
      const msg = parsed.message ?? parsed.error?.message ?? parsed[0]?.error?.message
      if (typeof msg === 'string' && msg.length > 0) {
        return msg.length > 200 ? msg.slice(0, 200) + '…' : msg
      }
    }
  } catch {
    // Not JSON, use as-is
  }

  // For bracket-wrapped errors like [GoogleGenerativeAI Error]: ...
  const bracketMatch = error.match(/\[.*?\]\s*(.+)/)
  if (bracketMatch) {
    const msg = bracketMatch[1]
    return msg.length > 200 ? msg.slice(0, 200) + '…' : msg
  }

  return error.length > 200 ? error.slice(0, 200) + '…' : error
}

function statusDetailFromRun(run: ApiRun): string {
  switch (run.status) {
    case 'queued': return 'Waiting for execution slot.'
    case 'running': return 'Provider queries in progress.'
    case 'completed': return 'All key phrases checked.'
    case 'partial': return 'Run completed with some key phrases skipped.'
    case 'failed': return run.error ? formatErrorDetail(run.error) : 'Run failed.'
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

/** Count unique keywords that are cited by at least one provider. */
function computeKeywordVisibility(snapshots: ApiRunDetail['snapshots']): { score: number; citedCount: number; totalCount: number } {
  if (snapshots.length === 0) return { score: 0, citedCount: 0, totalCount: 0 }
  const keywordCited = new Map<string, boolean>()
  for (const snap of snapshots) {
    const kw = snap.keyword ?? snap.id
    if (!keywordCited.has(kw)) keywordCited.set(kw, false)
    if (snap.citationState === 'cited') keywordCited.set(kw, true)
  }
  const totalCount = keywordCited.size
  const citedCount = [...keywordCited.values()].filter(Boolean).length
  const score = totalCount > 0 ? Math.round((citedCount / totalCount) * 100) : 0
  return { score, citedCount, totalCount }
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
  // Use competitorOverlap (root-domain-collapsed by the job runner) so subdomain
  // citations are counted the same way as the per-competitor table below.
  const competitorSet = new Set(competitorDomains)
  let overlapCount = 0
  for (const snap of snapshots) {
    if (snap.competitorOverlap.some(d => competitorSet.has(d))) {
      overlapCount++
    }
  }
  const ratio = overlapCount / snapshots.length
  if (ratio >= 0.5) return { label: 'High', count: overlapCount }
  if (ratio >= 0.2) return { label: 'Moderate', count: overlapCount }
  return { label: 'Low', count: overlapCount }
}

function buildEvidenceFromTimeline(
  projectName: string,
  timeline: ApiTimelineEntry[],
  latestRunDetail: ApiRunDetail | null,
  savedKeywords: ApiKeyword[],
): CitationInsightVm[] {
  const results: CitationInsightVm[] = []
  let idx = 0
  const seenKeywords = new Set<string>()

  if (latestRunDetail) {
    // Group snapshots by keyword+provider for multi-provider support
    const snapshotsByKey = new Map<string, ApiRunDetail['snapshots'][number]>()
    for (const snap of latestRunDetail.snapshots) {
      if (snap.keyword) {
        const key = `${snap.keyword}::${snap.provider}`
        snapshotsByKey.set(key, snap)
      }
    }

    // Collect unique providers from snapshots
    const providers = [...new Set(latestRunDetail.snapshots.map(s => s.provider))].sort()
    if (providers.length === 0) providers.push('gemini')

    for (const entry of timeline) {
      if (entry.runs.length === 0) continue // never run yet; pending fallback handles it
      seenKeywords.add(entry.keyword)
      const latestRun = entry.runs.at(-1)
      const transition = latestRun?.transition ?? 'not-cited'
      const citationState: CitationState = transition === 'lost' ? 'lost'
        : transition === 'emerging' ? 'emerging'
        : transition === 'cited' ? 'cited'
        : 'not-cited'

      for (const provider of providers) {
        const snap = snapshotsByKey.get(`${entry.keyword}::${provider}`)
        if (!snap && providers.length > 1) continue

        const snapState: CitationState = snap
          ? (snap.citationState === 'cited' ? 'cited' : 'not-cited')
          : citationState

        // For multi-provider runs, the aggregated timeline transition may contradict this
        // provider's own citation state (e.g. "emerging" but snapState is 'not-cited').
        // Use the provider's own state as the basis for the label when providers > 1.
        const effectiveTransition = providers.length > 1
          ? (snapState === 'cited' ? 'cited' : 'not-cited')
          : transition

        results.push({
          id: `evidence_${projectName}_${idx++}`,
          keyword: entry.keyword,
          provider: snap?.provider ?? provider,
          citationState: snapState,
          changeLabel: changeLabel(effectiveTransition, entry.runs.length),
          answerSnippet: snap?.answerText ?? '',
          citedDomains: snap?.citedDomains ?? [],
          evidenceUrls: [],
          competitorDomains: snap?.competitorOverlap ?? [],
          relatedTechnicalSignals: [],
          groundingSources: snap?.groundingSources ?? [],
          summary: evidenceSummary(snapState, entry.keyword),
        })
      }
    }
  }

  // Show saved keywords that haven't been run yet
  for (const kw of savedKeywords) {
    if (seenKeywords.has(kw.keyword)) continue
    results.push({
      id: `evidence_${projectName}_${idx++}`,
      keyword: kw.keyword,
      provider: '',
      citationState: 'pending',
      changeLabel: 'Awaiting first run',
      answerSnippet: '',
      citedDomains: [],
      evidenceUrls: [],
      competitorDomains: [],
      relatedTechnicalSignals: [],
      groundingSources: [],
      summary: `"${kw.keyword}" has been added but no visibility run has been triggered yet.`,
    })
  }

  return results
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
    case 'pending': return `"${keyword}" has been added but no visibility run has been triggered yet.`
  }
}

function aggregatePhraseState(items: CitationInsightVm[]): CitationInsightVm['citationState'] {
  const states = items.map(i => i.citationState)
  if (states.includes('cited')) return 'cited'
  if (states.includes('emerging')) return 'emerging'
  if (states.includes('lost')) return 'lost'
  if (states.includes('pending')) return 'pending'
  return 'not-cited'
}

function buildInsights(evidence: CitationInsightVm[]): ProjectInsightVm[] {
  const insights: ProjectInsightVm[] = []

  // Group by key phrase and compute aggregate citation state per phrase
  const phraseMap = new Map<string, CitationInsightVm[]>()
  for (const e of evidence) {
    const existing = phraseMap.get(e.keyword) ?? []
    phraseMap.set(e.keyword, [...existing, e])
  }

  const lostPhrases: { phrase: string; id: string }[] = []
  const emergingPhrases: { phrase: string; id: string }[] = []
  const notCitedPhrases: { phrase: string; id: string }[] = []

  for (const [phrase, items] of phraseMap) {
    const agg = aggregatePhraseState(items)
    const firstId = items[0]!.id
    if (agg === 'lost') lostPhrases.push({ phrase, id: items.find(i => i.citationState === 'lost')?.id ?? firstId })
    else if (agg === 'emerging') emergingPhrases.push({ phrase, id: items.find(i => i.citationState === 'emerging')?.id ?? firstId })
    else if (agg === 'not-cited') notCitedPhrases.push({ phrase, id: firstId })
  }

  if (lostPhrases.length > 0) {
    insights.push({
      id: 'insight_lost',
      tone: 'negative',
      title: `Lost citation on ${lostPhrases.length} key phrase${lostPhrases.length > 1 ? 's' : ''}`,
      detail: `Key phrases: ${lostPhrases.map(p => p.phrase).join(', ')}`,
      actionLabel: 'Open evidence',
      evidenceId: lostPhrases[0]!.id,
    })
  }

  if (emergingPhrases.length > 0) {
    insights.push({
      id: 'insight_emerging',
      tone: 'positive',
      title: `New citation on ${emergingPhrases.length} key phrase${emergingPhrases.length > 1 ? 's' : ''}`,
      detail: `Key phrases: ${emergingPhrases.map(p => p.phrase).join(', ')}`,
      actionLabel: 'Review evidence',
      evidenceId: emergingPhrases[0]!.id,
    })
  }

  if (notCitedPhrases.length > 0) {
    insights.push({
      id: 'insight_gap',
      tone: 'caution',
      title: `${notCitedPhrases.length} key phrase${notCitedPhrases.length > 1 ? 's' : ''} not cited by any provider`,
      detail: 'These key phrases have not been cited in any AI answer across all providers.',
      actionLabel: 'Inspect gap',
      evidenceId: notCitedPhrases[0]!.id,
    })
  }

  if (insights.length === 0) {
    insights.push({
      id: 'insight_stable',
      tone: 'neutral',
      title: 'No significant changes',
      detail: 'Citation state is stable across all tracked key phrases.',
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
      tooltip: 'Current execution state of visibility sweeps. Shows the status of the most recent run and total run count.',
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
    tooltip: 'Current execution state of visibility sweeps. Shows the status of the most recent run and total run count.',
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
  const evidence = buildEvidenceFromTimeline(dto.name, data.timeline, data.latestRunDetail, data.keywords)
  const snapshots = data.latestRunDetail?.snapshots ?? []
  const kwVis = computeKeywordVisibility(snapshots)
  const pressure = computeCompetitorPressure(snapshots, data.competitors.map(c => c.domain))
  const insights = buildInsights(evidence)

  const sortedRuns = [...data.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const runItems = sortedRuns.map(r => toRunListItem(r, data.project.displayName || data.project.name))

  // Compute per-provider scores
  const providerGroups = new Map<string, { cited: number; total: number }>()
  for (const snap of snapshots) {
    const p = snap.provider || 'gemini'
    const group = providerGroups.get(p) ?? { cited: 0, total: 0 }
    group.total++
    if (snap.citationState === 'cited') group.cited++
    providerGroups.set(p, group)
  }
  const providerScores = [...providerGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, { cited, total }]) => ({
      provider,
      score: total > 0 ? Math.round((cited / total) * 100) : 0,
      cited,
      total,
    }))

  return {
    project: dto,
    dateRangeLabel: 'All time',
    contextLabel: `${dto.country} / ${dto.language.toUpperCase()}`,
    visibilitySummary: {
      label: 'Answer Visibility',
      value: snapshots.length > 0 ? `${kwVis.score}` : 'No data',
      delta: snapshots.length > 0 ? `${kwVis.citedCount} of ${kwVis.totalCount} key phrases visible` : 'Run a sweep first',
      tone: snapshots.length > 0 ? scoreTone(kwVis.score) : 'neutral',
      description: snapshots.length > 0
        ? `${kwVis.citedCount} of ${kwVis.totalCount} tracked key phrases found your domain in at least one AI answer engine.`
        : 'No visibility data yet. Trigger a run to start tracking.',
      tooltip: 'Percentage of tracked key phrases where your domain is cited by at least one AI answer engine. A key phrase is "visible" if any configured provider includes your site in its response.',
      trend: [],
    },
    providerScores,
    readinessSummary: undefined,
    competitorPressure: {
      label: 'Competitor Pressure',
      value: pressure.label,
      delta: pressure.count > 0 ? `${pressure.count} overlapping citations` : 'No overlap detected',
      tone: pressureTone(pressure.label),
      description: data.competitors.length > 0
        ? `${data.competitors.length} competitor${data.competitors.length > 1 ? 's' : ''} tracked.`
        : 'No competitors configured.',
      tooltip: 'How often competitor domains appear alongside yours in AI answers. High pressure means competitors are frequently cited for the same key phrases.',
      trend: [],
    },
    runStatus: runStatusSummary(sortedRuns),
    insights,
    visibilityEvidence: evidence,
    technicalFindings: undefined,
    competitors: data.competitors.map((c, i) => {
      const citedKeywordSet = new Set<string>()
      for (const snap of snapshots) {
        if (
          snap.competitorOverlap.includes(c.domain) ||
          snap.citedDomains.includes(c.domain)
        ) {
          if (snap.keyword) citedKeywordSet.add(snap.keyword)
        }
      }
      const citedKeywords = [...citedKeywordSet]
      const uniqueKeywords = new Set(snapshots.map(s => s.keyword).filter(Boolean))
      const ratio = uniqueKeywords.size > 0 ? citedKeywords.length / uniqueKeywords.size : 0
      const pressureLabel = ratio >= 0.5 ? 'High' : ratio >= 0.2 ? 'Moderate' : citedKeywords.length > 0 ? 'Low' : 'None'
      return {
        id: c.id || `comp_${i}`,
        domain: c.domain,
        citationCount: citedKeywords.length,
        totalKeywords: uniqueKeywords.size,
        pressureLabel,
        citedKeywords,
        movement: '',
        notes: '',
      }
    }),
    recentRuns: runItems.slice(0, 5),
  }
}

export function buildPortfolioProject(data: ProjectData): PortfolioProjectVm {
  const dto = toProjectDto(data.project)
  const snapshots = data.latestRunDetail?.snapshots ?? []
  const kwVis = computeKeywordVisibility(snapshots)
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

  return {
    project: dto,
    visibilityScore: kwVis.score,
    visibilityDelta: snapshots.length > 0 ? `${kwVis.citedCount} of ${kwVis.totalCount} key phrases` : 'No data',
    readinessScore: undefined,
    readinessDelta: undefined,
    lastRun: runItem,
    insight: snapshots.length > 0
      ? `${kwVis.citedCount} of ${kwVis.totalCount} key phrases visible across ${new Set(snapshots.map(s => s.provider)).size} provider${new Set(snapshots.map(s => s.provider)).size > 1 ? 's' : ''}.`
      : 'No runs completed yet.',
    trend: [],
    competitorPressureLabel: pressure.label,
  }
}

export function buildDashboard(projectDataList: ProjectData[], apiSettings?: ApiSettings | null): DashboardVm {
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
          detail: 'Canonry becomes useful after one project, a small key phrase set, and one competitor list are in place.',
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
      providerStatuses: (apiSettings?.providers ?? []).map(p => ({
        name: p.name,
        model: p.model,
        state: (p.configured ? 'ready' : 'needs-config') as 'ready' | 'needs-config',
        detail: p.configured ? 'Provider is configured.' : 'API key is missing.',
        quota: p.quota,
      })),
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
        detail: `${lostEvidence.length} key phrase${lostEvidence.length > 1 ? 's' : ''} lost citation.`,
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
