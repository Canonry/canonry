import type { ProjectDto, InsightDto, RunErrorDto, RunKind, RunStatus } from '@ainyc/canonry-contracts'
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
    case RunKinds['bing-inspect']: return 'Bing URL inspection'
    case RunKinds['bing-inspect-sitemap']: return 'Bing sitemap inspection'
    case RunKinds['site-audit']: return 'Site audit'
    case RunKinds['backlink-extract']: return 'Backlink extract'
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
function computeQueryVisibility(snapshots: ApiRunDetail['snapshots']): { score: number; citedCount: number; totalCount: number } {
  if (snapshots.length === 0) return { score: 0, citedCount: 0, totalCount: 0 }
  const queryCited = new Map<string, boolean>()
  for (const snap of snapshots) {
    const q = snap.query ?? snap.id
    if (!queryCited.has(q)) queryCited.set(q, false)
    if (snap.citationState === CitationStates.cited) queryCited.set(q, true)
  }
  const totalCount = queryCited.size
  const citedCount = [...queryCited.values()].filter(Boolean).length
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

function gapTone(gapCount: number, totalCount: number): MetricTone {
  if (gapCount === 0) return 'positive'
  const ratio = totalCount > 0 ? gapCount / totalCount : 0
  if (ratio >= 0.3) return 'negative'
  return 'caution'
}

function buildGapQuerySummary(
  snapshots: ApiRunDetail['snapshots'],
): ScoreSummaryVm {
  if (snapshots.length === 0) {
    return {
      label: 'Gap Queries',
      value: 'No data',
      delta: 'Run a sweep first',
      tone: 'neutral',
      description: 'Run a visibility sweep to identify queries where competitors are cited and your domain is not.',
      tooltip: 'Tracked queries where a competitor is cited in the latest run but your domain is not.',
      trend: [],
    }
  }

  const byQuery = new Map<string, { cited: boolean; competitorOverlap: Set<string> }>()

  for (const snap of snapshots) {
    const key = snap.queryId
    const current = byQuery.get(key) ?? { cited: false, competitorOverlap: new Set<string>() }
    if (snap.citationState === CitationStates.cited) current.cited = true
    for (const domain of snap.competitorOverlap) current.competitorOverlap.add(domain)
    byQuery.set(key, current)
  }

  const totalCount = byQuery.size
  const gapCount = [...byQuery.values()].filter(entry => !entry.cited && entry.competitorOverlap.size > 0).length
  const gapQueryLabel = gapCount === 1 ? 'query' : 'queries'

  return {
    label: 'Gap Queries',
    value: `${gapCount}`,
    delta: `${gapCount} of ${totalCount} queries at risk`,
    tone: gapTone(gapCount, totalCount),
    description: gapCount > 0
      ? `${gapCount} tracked ${gapQueryLabel} currently cite competitors without citing your domain.`
      : 'No competitive query gaps detected in the latest visibility run.',
    tooltip: 'Tracked queries where a competitor is cited in the latest run but your domain is not.',
    trend: [],
    progress: totalCount > 0 ? gapCount / totalCount : 0,
  }
}

type CoverageSummarySource =
  | ({ provider: 'Google' } & ApiGscCoverageSummary['summary'])
  | ({ provider: 'Bing'; deindexed: 0 } & ApiBingCoverageSummary['summary'])

function chooseIndexCoverageSummary(
  gscCoverage?: ApiGscCoverageSummary | null,
  bingCoverage?: ApiBingCoverageSummary | null,
): CoverageSummarySource | null {
  if (gscCoverage && gscCoverage.summary.total > 0) {
    return {
      provider: 'Google',
      ...gscCoverage.summary,
    }
  }

  if (bingCoverage && bingCoverage.summary.total > 0) {
    return {
      provider: 'Bing',
      ...bingCoverage.summary,
      deindexed: 0,
    }
  }

  if (gscCoverage) {
    return {
      provider: 'Google',
      ...gscCoverage.summary,
    }
  }

  if (bingCoverage) {
    return {
      provider: 'Bing',
      ...bingCoverage.summary,
      deindexed: 0,
    }
  }

  return null
}

function indexCoverageTone(summary: CoverageSummarySource): MetricTone {
  if (summary.provider === 'Google' && summary.deindexed > 0) return 'negative'
  if (summary.percentage >= 90) return 'positive'
  if (summary.percentage >= 70) return 'caution'
  return 'negative'
}

function buildIndexCoverageSummary(
  gscCoverage?: ApiGscCoverageSummary | null,
  bingCoverage?: ApiBingCoverageSummary | null,
): ScoreSummaryVm {
  const coverage = chooseIndexCoverageSummary(gscCoverage, bingCoverage)

  if (!coverage || coverage.total === 0) {
    return {
      label: 'Index Coverage',
      value: 'No data',
      delta: 'Connect GSC or Bing',
      tone: 'neutral',
      description: 'Connect Google Search Console or Bing Webmaster Tools and inspect your sitemap to populate coverage.',
      tooltip: 'Percentage of inspected URLs currently indexed. Google Search Console is preferred when available, otherwise Bing Webmaster Tools is used.',
      trend: [],
    }
  }

  const notIndexedLabel = coverage.notIndexed === 1 ? 'URL is' : 'URLs are'
  const deindexedLabel = coverage.deindexed === 1 ? 'URL' : 'URLs'

  return {
    label: 'Index Coverage',
    value: `${Math.round(coverage.percentage)}`,
    delta: `${coverage.provider} · ${coverage.indexed} of ${coverage.total} indexed`,
    tone: indexCoverageTone(coverage),
    description: coverage.provider === 'Google' && coverage.deindexed > 0
      ? `${coverage.deindexed} deindexed ${deindexedLabel} detected in the latest Google Search Console inspection.`
      : `${coverage.notIndexed} ${notIndexedLabel} not indexed in ${coverage.provider === 'Google' ? 'Google Search Console' : 'Bing Webmaster Tools'}.`,
    tooltip: 'Percentage of inspected URLs currently indexed. Google Search Console is preferred when available, otherwise Bing Webmaster Tools is used.',
    trend: [],
  }
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
  savedQueries: ApiQuery[],
): CitationInsightVm[] {
  const results: CitationInsightVm[] = []
  let idx = 0
  const seenQueries = new Set<string>()

  if (latestRunDetail) {
    // Group snapshots by query+provider for multi-provider support
    const snapshotsByKey = new Map<string, ApiRunDetail['snapshots'][number]>()
    for (const snap of latestRunDetail.snapshots) {
      if (snap.query) {
        const key = `${snap.query}::${snap.provider}`
        snapshotsByKey.set(key, snap)
      }
    }

    // Collect unique providers from the full timeline history (not just the latest run)
    // so that providers that errored or were absent in the latest run still show badges.
    const providersFromLatestRun = new Set(latestRunDetail.snapshots.map(s => s.provider))
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
        const snap = snapshotsByKey.get(`${entry.query}::${provider}`)
        // Only skip if provider has zero history for this query AND no snapshot in latest run
        const hasHistory = (entry.providerRuns?.[provider]?.length ?? 0) > 0
        if (!snap && !hasHistory) continue

        // Prefer provider-level history for continuity across model changes; fall back to model-scoped then query-level
        const model = snap?.model ?? null
        const modelKey = model ? `${provider}:${model}` : null
        const modelHistory = modelKey ? entry.modelRuns?.[modelKey] : undefined
        const providerHistory = entry.providerRuns?.[provider]
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
          : latestProviderState === 'cited' ? 'cited' : 'not-cited'
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
          location: snap?.location ?? null,
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
      return `Visibility was lost for "${query}". Your brand no longer appeared in the latest answer.`
    case 'emerging':
      return `Your brand started appearing in AI answers for "${query}".`
  }

  switch (visibilityState) {
    case 'visible':
      return `Your brand or domain is visible in AI answers for "${query}".`
    case 'pending':
      return `"${query}" has been added but no visibility run has been triggered yet.`
    case 'not-visible':
    default:
      return `Your brand or domain was not mentioned in AI answers for "${query}".`
  }
}

export interface InsightInput {
  evidence: CitationInsightVm[]
  timeline: ApiTimelineEntry[]
  latestSnapshots: ApiRunDetail['snapshots']
  previousSnapshots: ApiRunDetail['snapshots']
  trackedCompetitors: string[]
}

function buildCompetitorQueryMap(
  snapshots: ApiRunDetail['snapshots'],
  trackedCompetitors: string[],
): Map<string, Set<string>> {
  const competitorSet = new Set(trackedCompetitors)
  const result = new Map<string, Set<string>>()
  for (const snap of snapshots) {
    if (!snap.query) continue
    for (const domain of snap.competitorOverlap) {
      if (!competitorSet.has(domain)) continue
      const existing = result.get(domain) ?? new Set()
      existing.add(snap.query)
      result.set(domain, existing)
    }
  }
  return result
}

const GAP_THRESHOLD = 3

export function buildInsights(input: InsightInput): ProjectInsightVm[] {
  const { evidence, timeline, latestSnapshots, previousSnapshots, trackedCompetitors } = input
  const insights: ProjectInsightVm[] = []

  // --- 1. Lost citation (one entry per query, representative provider) ---
  const lostPhrases: AffectedPhrase[] = []
  const seenLostQueries = new Set<string>()
  for (const e of evidence) {
    if (e.citationState !== 'lost') continue
    if (seenLostQueries.has(e.query)) continue
    seenLostQueries.add(e.query)
    lostPhrases.push({ query: e.query, evidenceId: e.id, provider: e.provider, citationState: 'lost' as CitationState })
  }

  if (lostPhrases.length > 0) {
    insights.push({
      id: 'insight_lost',
      tone: 'negative',
      title: `Lost citation on ${lostPhrases.length} quer${lostPhrases.length > 1 ? 'ies' : 'y'}`,
      detail: 'Citations dropped since the last run.',
      actionLabel: 'Lost',
      affectedPhrases: lostPhrases,
    })
  }

  // --- 2. Competitor gained ---
  const latestCompMap = buildCompetitorQueryMap(latestSnapshots, trackedCompetitors)
  const prevCompMap = buildCompetitorQueryMap(previousSnapshots, trackedCompetitors)

  for (const comp of trackedCompetitors) {
    const latestQs = latestCompMap.get(comp) ?? new Set()
    const prevQs = prevCompMap.get(comp) ?? new Set()
    const gained = [...latestQs].filter(q => !prevQs.has(q))
    if (gained.length > 0) {
      insights.push({
        id: `insight_comp_gained_${comp}`,
        tone: 'negative',
        title: `${comp} appeared on ${gained.length} quer${gained.length > 1 ? 'ies' : 'y'}`,
        detail: 'A tracked competitor gained new citations.',
        actionLabel: 'Competitor',
        affectedPhrases: gained.map(q => {
          const ev = evidence.find(e => e.query === q)
          return { query: q, evidenceId: ev?.id ?? '', citationState: 'cited' as CitationState }
        }),
      })
    }
  }

  // --- 3 & 4. New provider pickup vs First citation ---
  // Use the deduped query timeline to decide: if the query itself just became cited
  // (transition = 'emerging' or 'new' + cited), it's a "first citation" (query-level).
  // If the query was already cited but a specific provider just started citing it
  // (provider transition = 'emerging'), it's a "new provider pickup".
  const queryTransition = new Map<string, { transition: string; citationState: string }>()
  for (const entry of timeline) {
    const latest = entry.runs.at(-1)
    if (latest) queryTransition.set(entry.query, { transition: latest.transition, citationState: latest.citationState })
  }

  const firstCitationPhrases: AffectedPhrase[] = []
  const newProviderPhrases: AffectedPhrase[] = []
  const firstCitationQueries = new Set<string>()

  // First citation: query-level
  for (const [query, { transition, citationState }] of queryTransition) {
    const isFirst = transition === 'emerging' || (transition === 'new' && citationState === CitationStates.cited)
    if (!isFirst) continue
    firstCitationQueries.add(query)
    const ev = evidence.find(e => e.query === query && (e.citationState === 'emerging' || e.citationState === CitationStates.cited))
    firstCitationPhrases.push({
      query, evidenceId: ev?.id ?? '', provider: ev?.provider, citationState: 'emerging',
    })
  }

  // New provider pickup: per-provider emerging where query was already cited
  for (const e of evidence) {
    if (e.citationState !== 'emerging') continue
    if (firstCitationQueries.has(e.query)) continue
    newProviderPhrases.push({
      query: e.query, evidenceId: e.id, provider: e.provider, citationState: 'emerging',
    })
  }

  if (newProviderPhrases.length > 0) {
    const qCount = new Set(newProviderPhrases.map(p => p.query)).size
    insights.push({
      id: 'insight_provider_pickup',
      tone: 'positive',
      title: `Picked up by new provider on ${qCount} quer${qCount > 1 ? 'ies' : 'y'}`,
      detail: 'Your domain started appearing on additional providers.',
      actionLabel: 'Pickup',
      affectedPhrases: newProviderPhrases,
    })
  }

  if (firstCitationPhrases.length > 0) {
    insights.push({
      id: 'insight_first_citation',
      tone: 'positive',
      title: `First citation on ${firstCitationQueries.size} quer${firstCitationQueries.size > 1 ? 'ies' : 'y'}`,
      detail: 'Your domain appeared in AI answers for the first time.',
      actionLabel: 'New',
      affectedPhrases: firstCitationPhrases,
    })
  }

  // --- 5. Persistent gap (query-level, deduped timeline) ---
  const evidenceQueries = new Set(evidence.map(e => e.query))
  const gapPhrases: AffectedPhrase[] = []

  for (const entry of timeline) {
    if (!evidenceQueries.has(entry.query)) continue
    if (entry.runs.length < GAP_THRESHOLD) continue
    const latestRun = entry.runs.at(-1)
    if (latestRun?.citationState !== CitationStates['not-cited']) continue
    const streak = computeStreak(entry.runs)
    if (streak >= GAP_THRESHOLD) {
      const ev = evidence.find(e => e.query === entry.query)
      gapPhrases.push({ query: entry.query, evidenceId: ev?.id ?? '', citationState: 'not-cited' })
    }
  }

  if (gapPhrases.length > 0) {
    insights.push({
      id: 'insight_persistent_gap',
      tone: 'caution',
      title: `${gapPhrases.length} quer${gapPhrases.length > 1 ? 'ies' : 'y'} uncited for ${GAP_THRESHOLD}+ runs`,
      detail: 'These queries have not been cited by any provider across multiple consecutive runs.',
      actionLabel: 'Gap',
      affectedPhrases: gapPhrases,
    })
  }

  // --- 6. Competitor lost ---
  for (const comp of trackedCompetitors) {
    const latestQs = latestCompMap.get(comp) ?? new Set()
    const prevQs = prevCompMap.get(comp) ?? new Set()
    const lost = [...prevQs].filter(q => !latestQs.has(q))
    if (lost.length > 0) {
      insights.push({
        id: `insight_comp_lost_${comp}`,
        tone: 'neutral',
        title: `${comp} dropped from ${lost.length} quer${lost.length > 1 ? 'ies' : 'y'}`,
        detail: 'A tracked competitor lost citations.',
        actionLabel: 'Competitor',
        affectedPhrases: lost.map(q => {
          const ev = evidence.find(e => e.query === q)
          return { query: q, evidenceId: ev?.id ?? '', citationState: 'not-cited' as CitationState }
        }),
      })
    }
  }

  // Stable fallback
  if (insights.length === 0) {
    insights.push({
      id: 'insight_stable',
      tone: 'neutral',
      title: 'No significant changes',
      detail: 'Citation state is stable across all tracked queries.',
      actionLabel: 'Stable',
      affectedPhrases: [],
    })
  }

  return insights
}

/**
 * Merge DB-backed insights with in-memory signals.
 * DB covers regression/gain; in-memory covers first-citation, provider-pickup,
 * persistent-gap, competitor signals, and stable fallback.
 * DB regressions replace in-memory insight_lost (richer cause/recommendation data).
 */
function mergeInsights(inMemory: ProjectInsightVm[], db: ProjectInsightVm[]): ProjectInsightVm[] {
  // Remove in-memory lost-citation signals; DB regressions are more detailed
  const supplemental = inMemory.filter(i => i.id !== 'insight_lost' && i.id !== 'insight_stable')
  const merged = [...db, ...supplemental]
  if (merged.length === 0) {
    return [{
      id: 'insight_stable',
      tone: 'neutral',
      title: 'No significant changes',
      detail: 'Citation state is stable across all tracked queries.',
      actionLabel: 'Stable',
      affectedPhrases: [],
    }]
  }
  return merged
}

/** Compare latest vs previous run to count query-level gains and losses. */
function computeMovement(
  latestSnapshots: ApiRunDetail['snapshots'],
  previousSnapshots: ApiRunDetail['snapshots'],
): MovementSummaryVm {
  if (previousSnapshots.length === 0) {
    // No previous run to compare against
    const citedCount = new Set(
      latestSnapshots.filter(s => s.citationState === CitationStates.cited).map(s => s.query),
    ).size
    return { gained: citedCount, lost: 0, tone: citedCount > 0 ? 'positive' : 'neutral', hasPreviousRun: false }
  }

  // Build query-level cited sets (cited if ANY provider cited it)
  const buildCitedSet = (snaps: ApiRunDetail['snapshots']): Set<string> => {
    const cited = new Set<string>()
    for (const s of snaps) {
      if (s.citationState === CitationStates.cited && s.query) cited.add(s.query)
    }
    return cited
  }

  const latestCited = buildCitedSet(latestSnapshots)
  const previousCited = buildCitedSet(previousSnapshots)

  let gained = 0
  let lost = 0
  for (const q of latestCited) {
    if (!previousCited.has(q)) gained++
  }
  for (const q of previousCited) {
    if (!latestCited.has(q)) lost++
  }

  const tone: MetricTone = lost > gained ? 'negative' : gained > lost ? 'positive' : 'neutral'
  return { gained, lost, tone, hasPreviousRun: true }
}

function runStatusSummary(projectRuns: ApiRun[]): ScoreSummaryVm {
  if (projectRuns.length === 0) {
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

  // Pin Run Status to the latest answer-visibility run; fall back to the absolute latest
  const latestVisibility = projectRuns.find(r => r.kind === RunKinds['answer-visibility'])
  const latest = latestVisibility ?? projectRuns[0]!

  const value = latest.status === RunStatuses.completed ? 'Healthy'
    : latest.status === RunStatuses.running ? 'Running'
    : latest.status === RunStatuses.queued ? 'Queued'
    : latest.status === RunStatuses.partial ? 'Partial'
    : 'Failed'

  const tone: MetricTone = latest.status === RunStatuses.completed ? 'positive'
    : latest.status === RunStatuses.failed ? 'negative'
    : latest.status === RunStatuses.partial ? 'caution'
    : 'neutral'

  const visibilityRunCount = projectRuns.filter(r => r.kind === RunKinds['answer-visibility']).length
  const syncRunCount = projectRuns.length - visibilityRunCount
  const delta = syncRunCount > 0
    ? `${visibilityRunCount} ${visibilityRunCount === 1 ? 'sweep' : 'sweeps'} · ${syncRunCount} ${syncRunCount === 1 ? 'sync' : 'syncs'}`
    : `${projectRuns.length} total runs`

  return {
    label: 'Run Status',
    value,
    delta,
    tone,
    description: `Latest: ${kindLabel(latest.kind)} — ${latest.status}`,
    tooltip: 'Current execution state of visibility sweeps. Shows the status of the most recent run and total run count.',
    trend: [],
  }
}

export interface ProjectData {
  project: ApiProject
  runs: ApiRun[]
  queries: ApiQuery[]
  competitors: ApiCompetitor[]
  timeline: ApiTimelineEntry[]
  latestRunDetail: ApiRunDetail | null
  previousRunDetail: ApiRunDetail | null
  gscCoverage?: ApiGscCoverageSummary | null
  bingCoverage?: ApiBingCoverageSummary | null
  dbInsights?: InsightDto[] | null
}

export function buildProjectCommandCenter(data: ProjectData): ProjectCommandCenterVm {
  const dto = toProjectDto(data.project)
  const evidence = buildEvidenceFromTimeline(dto.name, data.timeline, data.latestRunDetail, data.queries)
  // Match latestRunDetail (which is fetched for the most recent completed/partial run)
  // — using all runs would leave snapshots empty whenever a newer run is queued/running.
  const latestVisibilityRunMetrics = data.runs
    .filter(r => r.kind === RunKinds['answer-visibility'] && (r.status === RunStatuses.completed || r.status === RunStatuses.partial))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const snapshots = (latestVisibilityRunMetrics && data.latestRunDetail?.id === latestVisibilityRunMetrics.id) ? data.latestRunDetail.snapshots : []
  const qVis = computeQueryVisibility(snapshots)
  const gapQueries = buildGapQuerySummary(snapshots)
  const indexCoverage = buildIndexCoverageSummary(data.gscCoverage, data.bingCoverage)
  const pressure = computeCompetitorPressure(snapshots, data.competitors.map(c => c.domain))
  const inMemoryInsights = buildInsights({
    evidence,
    timeline: data.timeline,
    latestSnapshots: data.latestRunDetail?.snapshots ?? [],
    previousSnapshots: data.previousRunDetail?.snapshots ?? [],
    trackedCompetitors: data.competitors.map(c => c.domain),
  })
  // DB insights (regression/gain) are richer than in-memory lost detection.
  // Merge: DB insights replace insight_lost, all other in-memory signals preserved.
  const dbMapped = data.dbInsights != null ? mapInsightDtosToVms(data.dbInsights) : null
  const insights = dbMapped != null
    ? mergeInsights(inMemoryInsights, dbMapped)
    : inMemoryInsights

  // Surface stale-visibility warning when integration syncs are more recent than the latest visibility run
  const sortedRuns = [...data.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const latestVisibilityRunStale = sortedRuns.find(r => r.kind === RunKinds['answer-visibility'])
  const latestSyncRun = sortedRuns.find(r => r.kind !== RunKinds['answer-visibility'])
  if (latestVisibilityRunStale && latestSyncRun) {
    const visibilityAge = new Date(latestSyncRun.createdAt).getTime() - new Date(latestVisibilityRunStale.createdAt).getTime()
    const ONE_DAY = 24 * 60 * 60 * 1000
    if (visibilityAge > ONE_DAY) {
      insights.push({
        id: 'insight_stale_visibility',
        tone: 'caution',
        title: 'Stale visibility data',
        detail: `Last visibility sweep was ${formatDate(latestVisibilityRunStale.createdAt)}, but integration syncs have run since. Run a new sweep for current metrics.`,
        actionLabel: 'Stale',
        affectedPhrases: [],
      })
    }
  }

  const runItems = sortedRuns.map(r => toRunListItem(r, data.project.displayName || data.project.name))

  // Compute per-model scores (grouped by provider+model)
  const modelGroups = new Map<string, { provider: string; model: string | null; cited: number; total: number }>()
  for (const snap of snapshots) {
    const p = snap.provider || 'gemini'
    const m = snap.model ?? null
    const key = `${p}::${m ?? 'unknown'}`
    const group = modelGroups.get(key) ?? { provider: p, model: m, cited: 0, total: 0 }
    group.total++
    if (snap.citationState === CitationStates.cited) group.cited++
    modelGroups.set(key, group)
  }
  const providerScores = [...modelGroups.values()]
    .sort((a, b) => a.provider.localeCompare(b.provider) || (a.model ?? '').localeCompare(b.model ?? ''))
    .map(({ provider, model, cited, total }) => ({
      provider,
      model,
      score: total > 0 ? Math.round((cited / total) * 100) : 0,
      cited,
      total,
    }))

  // Compute provider coverage: how many configured API providers were in the latest visibility run
  const configuredApiProviders = data.project.providers.filter(p => !p.startsWith('cdp:'))
  const runProviders = new Set(snapshots.map(s => s.provider))
  const runApiProviderCount = configuredApiProviders.filter(p => runProviders.has(p)).length
  const isPartialProviderRun = snapshots.length > 0 && configuredApiProviders.length > 1 && runApiProviderCount < configuredApiProviders.length
  const providerCoverageLabel = isPartialProviderRun
    ? `${runApiProviderCount} of ${configuredApiProviders.length} providers`
    : undefined

  return {
    project: dto,
    dateRangeLabel: 'All time',
    contextLabel: `${dto.country} / ${dto.language.toUpperCase()}`,
    visibilitySummary: {
      label: 'Answer Visibility',
      value: snapshots.length > 0 ? `${qVis.score}` : 'No data',
      delta: snapshots.length > 0 ? `${qVis.citedCount} of ${qVis.totalCount} queries visible` : 'Run a sweep first',
      tone: snapshots.length > 0
        ? isPartialProviderRun ? 'caution' : scoreTone(qVis.score)
        : 'neutral',
      description: snapshots.length > 0
        ? `${qVis.citedCount} of ${qVis.totalCount} tracked queries found your domain in at least one AI answer engine.`
        : 'No visibility data yet. Trigger a run to start tracking.',
      tooltip: 'Percentage of tracked queries where your domain is cited by at least one AI answer engine. A query is "visible" if any configured provider includes your site in its response.',
      trend: [],
      providerCoverage: providerCoverageLabel,
    },
    queryCounts: { cited: qVis.citedCount, total: qVis.totalCount },
    gapQueries,
    indexCoverage,
    providerScores,
    competitorPressure: {
      label: 'Competitor Pressure',
      value: pressure.label,
      delta: pressure.count > 0 ? `${pressure.count} overlapping citations` : 'No overlap detected',
      tone: pressureTone(pressure.label),
      description: data.competitors.length > 0
        ? `${data.competitors.length} competitor${data.competitors.length > 1 ? 's' : ''} tracked.`
        : 'No competitors configured.',
      tooltip: 'How often competitor domains appear alongside yours in AI answers. High pressure means competitors are frequently cited for the same queries.',
      trend: [],
    },
    runStatus: runStatusSummary(sortedRuns),
    movementSummary: computeMovement(
      data.latestRunDetail?.snapshots ?? [],
      data.previousRunDetail?.snapshots ?? [],
    ),
    insights,
    visibilityEvidence: evidence,
    competitors: data.competitors.map((c, i) => {
      const citedQuerySet = new Set<string>()
      for (const snap of snapshots) {
        if (
          snap.competitorOverlap.includes(c.domain) ||
          snap.citedDomains.includes(c.domain)
        ) {
          if (snap.query) citedQuerySet.add(snap.query)
        }
      }
      const citedQueries = [...citedQuerySet]
      const uniqueQueries = new Set(snapshots.map(s => s.query).filter(Boolean))
      const ratio = uniqueQueries.size > 0 ? citedQueries.length / uniqueQueries.size : 0
      const pressureLabel = ratio >= 0.5 ? 'High' : ratio >= 0.2 ? 'Moderate' : citedQueries.length > 0 ? 'Low' : 'None'
      return {
        id: c.id || `comp_${i}`,
        domain: c.domain,
        citationCount: citedQueries.length,
        totalQueries: uniqueQueries.size,
        pressureLabel,
        citedQueries,
        movement: '',
        notes: '',
      }
    }),
    recentRuns: runItems.slice(0, 5),
  }
}

export function buildPortfolioProject(data: ProjectData): PortfolioProjectVm {
  const dto = toProjectDto(data.project)
  const latestVisibilityRun = data.runs
    .filter(r => r.kind === RunKinds['answer-visibility'] && (r.status === RunStatuses.completed || r.status === RunStatuses.partial))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const snapshots = (latestVisibilityRun && data.latestRunDetail?.id === latestVisibilityRun.id) ? data.latestRunDetail.snapshots : []
  const qVis = computeQueryVisibility(snapshots)
  const pressure = computeCompetitorPressure(snapshots, data.competitors.map(c => c.domain))
  const sortedRuns = [...data.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  // Prefer the latest visibility run for the portfolio card
  const latestRun = sortedRuns.find(r => r.kind === RunKinds['answer-visibility']) ?? sortedRuns[0]
  const projectLabel = data.project.displayName || data.project.name
  const runItem = latestRun
    ? toRunListItem(latestRun, projectLabel)
    : {
        id: 'none',
        projectId: data.project.id,
        projectName: projectLabel,
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

  // Compute provider coverage for portfolio card
  const pfConfiguredApi = data.project.providers.filter(p => !p.startsWith('cdp:'))
  const pfRunProviders = new Set(snapshots.map(s => s.provider))
  const pfRunApiCount = pfConfiguredApi.filter(p => pfRunProviders.has(p)).length
  const pfIsPartial = snapshots.length > 0 && pfConfiguredApi.length > 1 && pfRunApiCount < pfConfiguredApi.length

  return {
    project: dto,
    visibilityScore: qVis.score,
    visibilityDelta: snapshots.length > 0 ? `${qVis.citedCount} of ${qVis.totalCount} queries` : 'No data',
    visibilityTone: snapshots.length > 0
      ? pfIsPartial ? 'caution' : scoreTone(qVis.score)
      : 'neutral',
    providerCoverage: pfIsPartial ? `${pfRunApiCount} of ${pfConfiguredApi.length} providers` : undefined,
    lastRun: runItem,
    insight: snapshots.length > 0
      ? `${qVis.citedCount} of ${qVis.totalCount} queries visible across ${new Set(snapshots.map(s => s.provider)).size} provider${new Set(snapshots.map(s => s.provider)).size > 1 ? 's' : ''}.`
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
