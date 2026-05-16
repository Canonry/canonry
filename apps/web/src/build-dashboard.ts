import type { ProjectDto, InsightDto, ProjectOverviewDto, RunErrorDto, RunKind, RunStatus } from '@ainyc/canonry-contracts'
import { RunKinds, RunStatuses, RunTriggers, CitationStates, ComputedTransitions, formatRunErrorOneLine } from '@ainyc/canonry-contracts'
import type {
  ApiCompetitor,
  ApiBingCoverageSummary,
  ApiQuery,
  ApiProject,
  ApiGscCoverageSummary,
  ApiRun,
  ApiRunDetail,
  ApiSettings,
  ApiTimelineEntry,
} from './api.js'
import type {
  AffectedPhrase,
  CitationInsightVm,
  CitationState,
  EvidenceHistoryScope,
  ModelTransitionVm,
  CompetitorVm,
  DashboardVm,
  MetricTone,
  MovementSummaryVm,
  PortfolioProjectVm,
  ProjectCommandCenterVm,
  ProjectInsightVm,
  RunHistoryPoint,
  RunListItemVm,
  ScoreSummaryVm,
} from './view-models.js'
import { mapInsightDtosToVms } from './mappers/insight-mapper.js'

function toProjectDto(p: ApiProject): ProjectDto {
  return {
    id: p.id,
    name: p.name,
    displayName: p.displayName,
    canonicalDomain: p.canonicalDomain,
    ownedDomains: p.ownedDomains ?? [],
    aliases: p.aliases ?? [],
    country: p.country,
    language: p.language,
    tags: p.tags,
    labels: p.labels,
    locations: p.locations ?? [],
    defaultLocation: p.defaultLocation ?? null,
    autoExtractBacklinks: p.autoExtractBacklinks ?? false,
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

function kindLabel(kind: RunKind): string {
  switch (kind) {
    case RunKinds['answer-visibility']: return 'Answer visibility sweep'
    case RunKinds['gsc-sync']: return 'GSC sync'
    case RunKinds['inspect-sitemap']: return 'Sitemap inspection'
    case RunKinds['ga-sync']: return 'GA sync'
    case RunKinds['traffic-sync']: return 'Traffic sync'
    case RunKinds['bing-inspect']: return 'Bing URL inspection'
    case RunKinds['bing-inspect-sitemap']: return 'Bing sitemap inspection'
    case RunKinds['site-audit']: return 'Site audit'
    case RunKinds['backlink-extract']: return 'Backlink extract'
    case RunKinds['aeo-discover-seed']: return 'Discovery (seed phase)'
    case RunKinds['aeo-discover-probe']: return 'Discovery (probe phase)'
  }
}

function triggerLabel(trigger: string): string {
  return trigger === RunTriggers.manual ? 'Manual' : trigger === RunTriggers.scheduled ? 'Scheduled' : trigger === RunTriggers['config-apply'] ? 'Config apply' : trigger
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
    location: run.location ?? null,
    createdAt: run.createdAt,
    startedAt: run.startedAt ? formatDate(run.startedAt) : formatDate(run.createdAt),
    duration: formatDuration(run.startedAt, run.finishedAt),
    statusDetail: run.error ? formatRunError(run.error) : statusDetailFromRun(run),
    summary: summaryFromRun(run),
    triggerLabel: triggerLabel(run.trigger),
  }
}

function formatRunError(error: RunErrorDto): string {
  const summary = formatRunErrorOneLine(error)
  return summary.length > 200 ? summary.slice(0, 200) + '…' : summary
}

function statusDetailFromRun(run: ApiRun): string {
  switch (run.status) {
    case RunStatuses.queued: return 'Waiting for execution slot.'
    case RunStatuses.running: return 'Provider queries in progress.'
    case RunStatuses.completed: return 'All queries checked.'
    case RunStatuses.partial: return 'Run completed with some queries skipped.'
    case RunStatuses.failed: return run.error ? formatRunError(run.error) : 'Run failed.'
    case RunStatuses.cancelled: return 'Run was cancelled.'
    default: return ''
  }
}

function summaryFromRun(run: ApiRun): string {
  const label = kindLabel(run.kind)
  switch (run.status) {
    case RunStatuses.queued: return `${label} queued`
    case RunStatuses.running: return `${label} in progress`
    case RunStatuses.completed: return `${label} completed`
    case RunStatuses.partial: return `${label} partially completed`
    case RunStatuses.failed: return `${label} failed`
    case RunStatuses.cancelled: return `${label} cancelled`
    default: return run.status
  }
}

/** Count unique queries that are cited by at least one provider. */
function buildEvidenceFromTimeline(
  projectName: string,
  timeline: ApiTimelineEntry[],
  latestRunDetails: ApiRunDetail[],
  savedQueries: ApiQuery[],
): CitationInsightVm[] {
  const results: CitationInsightVm[] = []
  let idx = 0
  const seenQueries = new Set<string>()

  if (latestRunDetails.length > 0) {
    // Multi-location runs fan out as one ApiRunDetail per location, all with the
    // same `createdAt`. Bucket snapshots by (query × provider × location) so each
    // location's evidence row survives the aggregate instead of being clobbered.
    const allSnapshots = latestRunDetails.flatMap(r => r.snapshots)
    const snapshotsByKey = new Map<string, ApiRunDetail['snapshots'][number]>()
    for (const snap of allSnapshots) {
      if (snap.query) {
        const key = `${snap.query}::${snap.provider}::${snap.location ?? ''}`
        snapshotsByKey.set(key, snap)
      }
    }

    // Locations seen across the latest-run group (one entry per fan-out location).
    // When a project runs without any location, the set contains a single null entry
    // so the (query × provider) loop still emits a row.
    const locationsInLatestRun = new Set<string | null>(allSnapshots.map(s => s.location ?? null))
    if (locationsInLatestRun.size === 0) locationsInLatestRun.add(null)

    // Collect unique providers from the full timeline history (not just the latest run)
    // so that providers that errored or were absent in the latest run still show badges.
    const providersFromLatestRun = new Set(allSnapshots.map(s => s.provider))
    const providersFromHistory = new Set(
      timeline.flatMap(entry =>
        Object.keys(entry.providerRuns ?? {})
      )
    )
    const allProviders = [...new Set([...providersFromLatestRun, ...providersFromHistory])].sort()
    const providers = allProviders.length > 0 ? allProviders : ['gemini']

    for (const entry of timeline) {
      if (entry.runs.length === 0) continue // never run yet; pending fallback handles it
      seenQueries.add(entry.query)
      const latestRun = entry.runs.at(-1)
      const transition = latestRun?.transition ?? 'not-cited'
      for (const provider of providers) {
        // Determine which locations actually have a snapshot for this
        // (query × provider). When at least one does, emit a row per
        // snap-carrying location. When none do but the provider has
        // history, emit a single synthetic fallback row so the badge
        // still appears without multiplying it N× across locations.
        const locationsWithSnap = [...locationsInLatestRun]
          .filter(loc => snapshotsByKey.has(`${entry.query}::${provider}::${loc ?? ''}`))
        const hasHistory = (entry.providerRuns?.[provider]?.length ?? 0) > 0
        const rowLocations: (string | null)[] = locationsWithSnap.length > 0
          ? locationsWithSnap
          : (hasHistory ? [null] : [])
        for (const location of rowLocations) {
          const locKey = location ?? ''
          const snap = snapshotsByKey.get(`${entry.query}::${provider}::${locKey}`)

          // Prefer provider-level history for continuity across model changes;
          // fall back to model-scoped then query-level. Filter to this loop's
          // location so transition/streak labels reflect the actual location
          // being rendered — otherwise the most recent cross-location snapshot
          // would leak into every per-location row.
          const model = snap?.model ?? null
          const modelKey = model ? `${provider}:${model}` : null
          const rawProviderHistory = entry.providerRuns?.[provider]
          const rawModelHistory = modelKey ? entry.modelRuns?.[modelKey] : undefined
          const filterByLocation = <T extends { location?: string | null }>(rows: T[] | undefined): T[] | undefined =>
            rows?.filter(r => (r.location ?? null) === location)
          // History-only synthetic rows (location === null, snap missing)
          // legitimately summarize cross-location continuity, so keep the
          // unfiltered series in that case.
          const providerHistory = locationsWithSnap.length > 0
            ? filterByLocation(rawProviderHistory)
            : rawProviderHistory
          const modelHistory = locationsWithSnap.length > 0
            ? filterByLocation(rawModelHistory)
            : rawModelHistory
          const effectiveHistory = (providerHistory?.length ? providerHistory : null)
            ?? (modelHistory?.length ? modelHistory : null)
          const baseHistoryScope: EvidenceHistoryScope = providerHistory?.length
            ? 'provider'
            : modelHistory?.length
              ? 'model'
              : 'query'

          const effectiveTransition = effectiveHistory
            ? effectiveHistory.at(-1)!.transition
            : transition
          const effectiveVisibilityTransition = effectiveHistory
            ? (effectiveHistory.at(-1)!.visibilityTransition ?? (effectiveHistory.at(-1)!.visibilityState === 'visible' ? 'visible' : 'not-visible'))
            : (latestRun?.visibilityTransition ?? (latestRun?.visibilityState === 'visible' ? 'visible' : 'not-visible'))

          // When a provider is missing from the latest run, keep showing its last
          // observed provider-level state instead of leaking the query-level
          // transition from another provider into this synthetic badge row.
          const latestProviderState = effectiveHistory?.at(-1)?.citationState
          const latestProviderVisibilityState = effectiveHistory?.at(-1)?.visibilityState
          const snapState: CitationState = snap
            ? effectiveTransition === 'lost' ? 'lost'
              : effectiveTransition === 'emerging' ? 'emerging'
              : snap.citationState === CitationStates.cited ? 'cited' : 'not-cited'
            : latestProviderState === CitationStates.cited ? 'cited' : 'not-cited'
          const snapVisibilityState = (snap?.visibilityState as CitationInsightVm['visibilityState'] | undefined)
            ?? (latestProviderVisibilityState === 'visible' ? 'visible' : latestProviderVisibilityState === 'pending' ? 'pending' : 'not-visible')

          const streak = effectiveHistory
            ? computeStreak(effectiveHistory)
            : computeStreak(entry.runs)
          const visibilityStreak = effectiveHistory
            ? computeVisibilityStreak(effectiveHistory)
            : computeVisibilityStreak(entry.runs)

          const runModels = buildRunModelMap(entry, provider)
          const runHistory = (effectiveHistory ?? entry.runs)
            .map(r => ({
              runId: r.runId,
              citationState: r.citationState,
              createdAt: r.createdAt,
              model: runModels.get(r.runId) ?? null,
              answerMentioned: r.answerMentioned,
              visibilityState: r.visibilityState as RunHistoryPoint['visibilityState'] | undefined,
              visibilityTransition: r.visibilityTransition,
              mentionState: r.mentionState as RunHistoryPoint['mentionState'] | undefined,
              mentionTransition: r.mentionTransition,
            }))
          const modelsSeen = collectModels(runHistory)
          const historyScope: EvidenceHistoryScope = baseHistoryScope === 'provider' && modelsSeen.length <= 1
            ? 'model'
            : baseHistoryScope
          const modelTransitions = computeModelTransitions(runHistory)

          results.push({
            id: `evidence_${projectName}_${idx++}`,
            query: entry.query,
            provider: snap?.provider ?? provider,
            model: snap?.model ?? null,
            location: snap?.location ?? location,
            citationState: snapState,
            answerMentioned: snap?.answerMentioned,
            visibilityState: snapVisibilityState,
            visibilityChangeLabel: changeLabel(effectiveVisibilityTransition, visibilityStreak, {
              positive: 'visible',
              negative: 'not visible',
              first: 'first visibility',
            }),
            changeLabel: changeLabel(effectiveTransition, streak),
            answerSnippet: snap?.answerText ?? '',
            citedDomains: snap?.citedDomains ?? [],
            evidenceUrls: [],
            competitorDomains: snap?.competitorOverlap ?? [],
            recommendedCompetitors: snap?.recommendedCompetitors ?? [],
            matchedTerms: snap?.matchedTerms ?? [],
            relatedTechnicalSignals: [],
            groundingSources: snap?.groundingSources ?? [],
            summary: visibilityEvidenceSummary(snapVisibilityState, effectiveVisibilityTransition, entry.query),
            runHistory,
            historyScope,
            modelsSeen,
            modelTransitions,
          })
        }
      }
    }
  }

  // Show saved queries that haven't been run yet
  for (const q of savedQueries) {
    if (seenQueries.has(q.query)) continue
    results.push({
      id: `evidence_${projectName}_${idx++}`,
      query: q.query,
      provider: '',
      model: null,
      location: null,
      citationState: 'pending',
      visibilityState: 'pending',
      visibilityChangeLabel: 'Awaiting first run',
      changeLabel: 'Awaiting first run',
      answerSnippet: '',
      citedDomains: [],
      evidenceUrls: [],
      competitorDomains: [],
      recommendedCompetitors: [],
      matchedTerms: [],
      relatedTechnicalSignals: [],
      groundingSources: [],
      summary: `"${q.query}" has been added but no visibility run has been triggered yet.`,
      runHistory: [],
      historyScope: 'query',
      modelsSeen: [],
      modelTransitions: [],
    })
  }

  return results
}

function buildRunModelMap(entry: ApiTimelineEntry, provider: string): Map<string, string | null> {
  const modelsByRunId = new Map<string, string | null>()
  const prefix = `${provider}:`

  for (const [modelKey, runs] of Object.entries(entry.modelRuns ?? {})) {
    if (!modelKey.startsWith(prefix)) continue
    const modelName = modelKey.slice(prefix.length)
    const normalizedModel = modelName === 'unknown' ? null : modelName
    for (const run of runs) {
      modelsByRunId.set(run.runId, normalizedModel)
    }
  }

  return modelsByRunId
}

function collectModels(history: RunHistoryPoint[]): string[] {
  const models = new Set<string>()
  for (const point of history) {
    if (point.model) models.add(point.model)
  }
  return [...models]
}

function computeModelTransitions(history: RunHistoryPoint[]): ModelTransitionVm[] {
  const transitions: ModelTransitionVm[] = []
  let previousModel: string | null = null

  for (const point of history) {
    const currentModel = point.model ?? null
    if (currentModel !== previousModel && previousModel !== null) {
      transitions.push({
        runId: point.runId,
        createdAt: point.createdAt,
        fromModel: previousModel,
        toModel: currentModel,
      })
    }
    previousModel = currentModel
  }

  return transitions
}

/** Count consecutive runs from the end that share the same citationState as the latest run. */
function computeStreak(runs: { citationState: string }[]): number {
  if (runs.length === 0) return 0
  const latest = runs[runs.length - 1]!.citationState
  let streak = 0
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i]!.citationState === latest) streak++
    else break
  }
  return streak
}

function computeVisibilityStreak(runs: { visibilityState?: string }[]): number {
  if (runs.length === 0) return 0
  const latest = runs[runs.length - 1]!.visibilityState ?? 'not-visible'
  let streak = 0
  for (let i = runs.length - 1; i >= 0; i--) {
    if ((runs[i]!.visibilityState ?? 'not-visible') === latest) streak++
    else break
  }
  return streak
}

function changeLabel(
  transition: string,
  streak: number,
  labels?: { positive: string; negative: string; first: string },
): string {
  const resolved = {
    positive: labels?.positive ?? 'cited',
    negative: labels?.negative ?? 'not cited',
    first: labels?.first ?? 'first citation',
  }
  switch (transition) {
    case 'new': return 'First observation'
    case 'cited':
    case 'visible':
      return streak <= 1 ? `${capitalizeLabel(resolved.positive)} in latest run` : `${capitalizeLabel(resolved.positive)} for ${streak} runs`
    case 'lost': return 'Lost since last run'
    case 'emerging': return capitalizeLabel(resolved.first)
    case 'not-cited':
    case 'not-visible':
      return streak <= 1 ? `${capitalizeLabel(resolved.negative)} in latest run` : `${capitalizeLabel(resolved.negative)} across ${streak} runs`
    default: return transition
  }
}

function capitalizeLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function visibilityEvidenceSummary(
  visibilityState: CitationInsightVm['visibilityState'],
  visibilityTransition: string,
  query: string,
): string {
  switch (visibilityTransition) {
    case 'lost':
      return `Mention was lost for "${query}". Your brand no longer appeared in the latest answer.`
    case 'emerging':
      return `Your brand started appearing in AI answers for "${query}".`
  }

  switch (visibilityState) {
    case 'visible':
      return `Your brand or domain is mentioned in AI answers for "${query}".`
    case 'pending':
      return `"${query}" has been added but no run has been triggered yet.`
    case 'not-visible':
    default:
      return `Your brand or domain was not mentioned in AI answers for "${query}".`
  }
}


export interface ProjectData {
  project: ApiProject
  runs: ApiRun[]
  queries: ApiQuery[]
  competitors: ApiCompetitor[]
  timeline: ApiTimelineEntry[]
  /** All runs in the latest fan-out group (same `createdAt`). Each entry is one
   * location for a multi-location sweep, or a single-element array for a
   * single-location / project-wide run. Empty when the project has never run. */
  latestRunDetails: ApiRunDetail[]
  /** All runs in the previous fan-out group (same `createdAt`). Mirrors
   * `latestRunDetails` so snapshot-diff and other consumers see every
   * location, not just an arbitrary one. */
  previousRunDetails: ApiRunDetail[]
  gscCoverage?: ApiGscCoverageSummary | null
  bingCoverage?: ApiBingCoverageSummary | null
  dbInsights?: InsightDto[] | null
  /** Server-rendered project overview. When present, drives all score gauges,
   * movement, competitor pressure, attention items, and provider scores —
   * this layer no longer recomputes them client-side. */
  overview?: ProjectOverviewDto | null
}

export function buildProjectCommandCenter(data: ProjectData): ProjectCommandCenterVm {
  const dto = toProjectDto(data.project)
  // Evidence cards stay client-side for now: per Q8 of the deepening plan, the
  // /timeline endpoint is the source for per-query history. Eventually a
  // dedicated /evidence endpoint replaces this client-side derivation.
  const evidence = buildEvidenceFromTimeline(dto.name, data.timeline, data.latestRunDetails, data.queries)

  const sortedRuns = [...data.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const runItems = sortedRuns.map(r => toRunListItem(r, data.project.displayName || data.project.name))

  if (data.overview) {
    return adaptOverviewToCommandCenter(dto, data.overview, evidence, runItems)
  }
  return emptyCommandCenter(dto, evidence, runItems)
}

function adaptOverviewToCommandCenter(
  project: ProjectDto,
  overview: ProjectOverviewDto,
  evidence: CitationInsightVm[],
  runItems: RunListItemVm[],
): ProjectCommandCenterVm {
  const insights = mapInsightDtosToVms(overview.topInsights)
  // Server-synthesized attention items (e.g. stale_visibility) live in
  // overview.attentionItems alongside DB-backed insight echoes (id prefix
  // `insight_`). Append the synthesized ones so warnings like the stale
  // visibility hint render in the project's insights list.
  for (const item of overview.attentionItems) {
    if (item.id.startsWith('insight_')) continue
    insights.push({
      id: item.id,
      tone: item.tone,
      title: item.title,
      detail: item.detail,
      actionLabel: item.actionLabel,
      // Server-synthesized attention items (e.g. stale_visibility) are
      // diagnostic by nature — they tell the operator something needs
      // attention. Group as investigate.
      actionGroup: 'investigate',
      affectedPhrases: [],
    })
  }

  return {
    project,
    dateRangeLabel: overview.dateRangeLabel,
    contextLabel: overview.contextLabel,
    mentionSummary: overview.scores.mention as ScoreSummaryVm,
    visibilitySummary: overview.scores.visibility as ScoreSummaryVm,
    mentionShareSummary: overview.scores.mentionShare,
    queryCounts: { cited: overview.queryCounts.citedQueries, total: overview.queryCounts.totalQueries },
    gapQueries: overview.scores.gapQueries as ScoreSummaryVm,
    mentionGaps: overview.scores.mentionGaps as ScoreSummaryVm,
    indexCoverage: overview.scores.indexCoverage as ScoreSummaryVm,
    providerScores: overview.providerScores,
    competitorPressure: overview.scores.competitorPressure as ScoreSummaryVm,
    runStatus: overview.scores.runStatus as ScoreSummaryVm,
    movementSummary: overview.movementSummary as MovementSummaryVm,
    insights,
    visibilityEvidence: evidence,
    competitors: overview.competitors.map((row): CompetitorVm => ({
      id: row.id,
      domain: row.domain,
      citationCount: row.citationCount,
      totalQueries: row.totalQueries,
      pressureLabel: row.pressureLabel,
      citedQueries: row.citedQueries,
      movement: '',
      notes: '',
    })),
    recentRuns: runItems.slice(0, 5),
  }
}

function emptyCommandCenter(
  project: ProjectDto,
  evidence: CitationInsightVm[],
  runItems: RunListItemVm[],
): ProjectCommandCenterVm {
  // Reached only when the /overview fetch failed. Renders a neutral, "no data"
  // shell so the page doesn't crash — fresh data lands on the next refresh.
  const placeholder: ScoreSummaryVm = {
    label: '',
    value: 'No data',
    delta: 'Loading…',
    tone: 'neutral',
    description: '',
    tooltip: '',
    trend: [],
  }
  return {
    project,
    dateRangeLabel: 'All time',
    contextLabel: `${project.country} / ${project.language.toUpperCase()}`,
    mentionSummary: { ...placeholder, label: 'Mention Coverage' },
    visibilitySummary: { ...placeholder, label: 'Citation Coverage' },
    mentionShareSummary: {
      ...placeholder,
      label: 'Mention Share',
      breakdown: {
        projectMentionSnapshots: 0,
        competitorMentionSnapshots: 0,
        perCompetitor: [],
        snapshotsWithAnswerText: 0,
        snapshotsTotal: 0,
      },
    },
    queryCounts: { cited: 0, total: 0 },
    gapQueries: { ...placeholder, label: 'Citation Gaps' },
    mentionGaps: { ...placeholder, label: 'Mention Gaps' },
    indexCoverage: { ...placeholder, label: 'Index Coverage' },
    providerScores: [],
    competitorPressure: { ...placeholder, label: 'Competitor Pressure' },
    runStatus: { ...placeholder, label: 'Run Status' },
    movementSummary: { gained: 0, lost: 0, tone: 'neutral', hasPreviousRun: false },
    insights: [],
    visibilityEvidence: evidence,
    competitors: [],
    recentRuns: runItems.slice(0, 5),
  }
}

export function buildPortfolioProject(data: ProjectData): PortfolioProjectVm {
  const dto = toProjectDto(data.project)
  const sortedRuns = [...data.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const latestRun = sortedRuns.find(r => r.kind === RunKinds['answer-visibility']) ?? sortedRuns[0]
  const projectLabel = data.project.displayName || data.project.name
  const runItem = latestRun
    ? toRunListItem(latestRun, projectLabel)
    : emptyRunListItem(data.project.id, projectLabel)

  const overview = data.overview
  if (!overview) {
    return {
      project: dto,
      visibilityScore: 0,
      visibilityDelta: 'No data',
      visibilityTone: 'neutral',
      lastRun: runItem,
      insight: 'No runs completed yet.',
      trend: [],
      competitorPressureLabel: 'None',
    }
  }

  const visibility = overview.scores.visibility
  // The visibility gauge's `value` is presentational ("67" or "No data");
  // `progress` is the same number as 0–100, so we read that for the score.
  const visibilityScore = visibility.progress ?? 0
  const cited = overview.queryCounts.citedQueries
  const total = overview.queryCounts.totalQueries
  const providerCount = overview.providers.length

  return {
    project: dto,
    visibilityScore,
    visibilityDelta: total > 0 ? `${cited} of ${total} queries` : 'No data',
    visibilityTone: visibility.tone as MetricTone,
    providerCoverage: visibility.providerCoverage,
    lastRun: runItem,
    insight: total > 0
      ? `${cited} of ${total} queries mentioned across ${providerCount} provider${providerCount === 1 ? '' : 's'}.`
      : 'No runs completed yet.',
    trend: [],
    competitorPressureLabel: overview.scores.competitorPressure.value,
  }
}

function emptyRunListItem(projectId: string, projectName: string): RunListItemVm {
  return {
    id: 'none',
    projectId,
    projectName,
    kind: RunKinds['answer-visibility'],
    kindLabel: 'No runs yet',
    status: RunStatuses.queued,
    trigger: RunTriggers.manual,
    createdAt: '',
    startedAt: '',
    duration: '',
    statusDetail: '',
    summary: 'No runs yet',
    triggerLabel: '',
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
          detail: 'Canonry becomes useful after one project, a small query set, and one competitor list are in place.',
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
      queryImportState: { mode: 'paste', queryCount: 0, preview: [] },
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
        displayName: p.displayName,
        keyUrl: p.keyUrl,
        modelHint: p.modelHint,
        model: p.model,
        state: (p.configured ? 'ready' : 'needs-config') as 'ready' | 'needs-config',
        detail: p.configured ? 'Provider is configured.' : 'API key is missing.',
        quota: p.quota,
      })),
      google: {
        state: apiSettings?.google?.configured ? 'ready' : 'needs-config',
        detail: apiSettings?.google?.configured
          ? 'Google OAuth app credentials are configured. Project-level GSC connections can be created from the dashboard.'
          : 'Google OAuth client ID and client secret are not configured yet.',
      },
      bing: {
        state: apiSettings?.bing?.configured ? 'ready' : 'needs-config',
        detail: apiSettings?.bing?.configured
          ? 'Bing Webmaster Tools API key is configured. Project-level Bing connections can be created from the dashboard.'
          : 'Bing Webmaster Tools API key is not configured yet.',
      },
      selfHostNotes: [
        'Configuration is stored in ~/.canonry/config.yaml.',
        'The local config file is the source of truth for authentication credentials.',
        'Google OAuth app credentials and per-domain Google tokens are stored in local config, not the database.',
        'Database is SQLite at ~/.canonry/data.db.',
        'API key was auto-generated during canonry init.',
      ],
      bootstrapNote: 'Use the UI, CLI, or ~/.canonry/config.yaml to manage settings. Authentication credentials persist to local config.',
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
        detail: `${lostEvidence.length} quer${lostEvidence.length > 1 ? 'ies' : 'y'} lost citation.`,
        actionLabel: 'Open project',
        href: `/projects/${pc.project.id}`,
      })
    }

    const activeRuns = pc.recentRuns.filter(r => r.status === RunStatuses.running || r.status === RunStatuses.queued)
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
