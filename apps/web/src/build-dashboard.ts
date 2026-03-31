import type { ProjectDto } from '@ainyc/canonry-contracts'
import type {
  ApiCompetitor,
  ApiBingCoverageSummary,
  ApiKeyword,
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
    location: run.location ?? null,
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

function gapTone(gapCount: number, totalCount: number): MetricTone {
  if (gapCount === 0) return 'positive'
  const ratio = totalCount > 0 ? gapCount / totalCount : 0
  if (ratio >= 0.3) return 'negative'
  return 'caution'
}

function buildGapKeyPhraseSummary(
  snapshots: ApiRunDetail['snapshots'],
): ScoreSummaryVm {
  if (snapshots.length === 0) {
    return {
      label: 'Gap Key Phrases',
      value: 'No data',
      delta: 'Run a sweep first',
      tone: 'neutral',
      description: 'Run a visibility sweep to identify key phrases where competitors are cited and your domain is not.',
      tooltip: 'Tracked key phrases where a competitor is cited in the latest run but your domain is not.',
      trend: [],
    }
  }

  const byKeyword = new Map<string, { cited: boolean; competitorOverlap: Set<string> }>()

  for (const snap of snapshots) {
    const key = snap.keywordId
    const current = byKeyword.get(key) ?? { cited: false, competitorOverlap: new Set<string>() }
    if (snap.citationState === 'cited') current.cited = true
    for (const domain of snap.competitorOverlap) current.competitorOverlap.add(domain)
    byKeyword.set(key, current)
  }

  const totalCount = byKeyword.size
  const gapCount = [...byKeyword.values()].filter(entry => !entry.cited && entry.competitorOverlap.size > 0).length
  const gapPhraseLabel = gapCount === 1 ? 'key phrase' : 'key phrases'

  return {
    label: 'Gap Key Phrases',
    value: `${gapCount}`,
    delta: `${gapCount} of ${totalCount} key phrases at risk`,
    tone: gapTone(gapCount, totalCount),
    description: gapCount > 0
      ? `${gapCount} tracked ${gapPhraseLabel} currently cite competitors without citing your domain.`
      : 'No competitive key phrase gaps detected in the latest visibility run.',
    tooltip: 'Tracked key phrases where a competitor is cited in the latest run but your domain is not.',
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
      seenKeywords.add(entry.keyword)
      const latestRun = entry.runs.at(-1)
      const transition = latestRun?.transition ?? 'not-cited'
      for (const provider of providers) {
        const snap = snapshotsByKey.get(`${entry.keyword}::${provider}`)
        // Only skip if provider has zero history for this phrase AND no snapshot in latest run
        const hasHistory = (entry.providerRuns?.[provider]?.length ?? 0) > 0
        if (!snap && !hasHistory) continue

        // Prefer provider-level history for continuity across model changes; fall back to model-scoped then keyword-level
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
            : 'keyword'

        const effectiveTransition = effectiveHistory
          ? effectiveHistory.at(-1)!.transition
          : transition
        const effectiveVisibilityTransition = effectiveHistory
          ? (effectiveHistory.at(-1)!.visibilityTransition ?? (effectiveHistory.at(-1)!.visibilityState === 'visible' ? 'visible' : 'not-visible'))
          : (latestRun?.visibilityTransition ?? (latestRun?.visibilityState === 'visible' ? 'visible' : 'not-visible'))

        // When a provider is missing from the latest run, keep showing its last
        // observed provider-level state instead of leaking the keyword-level
        // transition from another provider into this synthetic badge row.
        const latestProviderState = effectiveHistory?.at(-1)?.citationState
        const latestProviderVisibilityState = effectiveHistory?.at(-1)?.visibilityState
        const snapState: CitationState = snap
          ? effectiveTransition === 'lost' ? 'lost'
            : effectiveTransition === 'emerging' ? 'emerging'
            : snap.citationState === 'cited' ? 'cited' : 'not-cited'
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
          keyword: entry.keyword,
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
          relatedTechnicalSignals: [],
          groundingSources: snap?.groundingSources ?? [],
          summary: visibilityEvidenceSummary(snapVisibilityState, effectiveVisibilityTransition, entry.keyword),
          runHistory,
          historyScope,
          modelsSeen,
          modelTransitions,
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
      relatedTechnicalSignals: [],
      groundingSources: [],
      summary: `"${kw.keyword}" has been added but no visibility run has been triggered yet.`,
      runHistory: [],
      historyScope: 'keyword',
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
  keyword: string,
): string {
  switch (visibilityTransition) {
    case 'lost':
      return `Visibility was lost for "${keyword}". Your brand no longer appeared in the latest answer.`
    case 'emerging':
      return `Your brand started appearing in AI answers for "${keyword}".`
  }

  switch (visibilityState) {
    case 'visible':
      return `Your brand or domain is visible in AI answers for "${keyword}".`
    case 'pending':
      return `"${keyword}" has been added but no visibility run has been triggered yet.`
    case 'not-visible':
    default:
      return `Your brand or domain was not mentioned in AI answers for "${keyword}".`
  }
}

export interface InsightInput {
  evidence: CitationInsightVm[]
  timeline: ApiTimelineEntry[]
  latestSnapshots: ApiRunDetail['snapshots']
  previousSnapshots: ApiRunDetail['snapshots']
  trackedCompetitors: string[]
}

function buildCompetitorKeywordMap(
  snapshots: ApiRunDetail['snapshots'],
  trackedCompetitors: string[],
): Map<string, Set<string>> {
  const competitorSet = new Set(trackedCompetitors)
  const result = new Map<string, Set<string>>()
  for (const snap of snapshots) {
    if (!snap.keyword) continue
    for (const domain of snap.competitorOverlap) {
      if (!competitorSet.has(domain)) continue
      const existing = result.get(domain) ?? new Set()
      existing.add(snap.keyword)
      result.set(domain, existing)
    }
  }
  return result
}

const GAP_THRESHOLD = 3

export function buildInsights(input: InsightInput): ProjectInsightVm[] {
  const { evidence, timeline, latestSnapshots, previousSnapshots, trackedCompetitors } = input
  const insights: ProjectInsightVm[] = []

  // --- 1. Lost citation (one entry per keyword, representative provider) ---
  const lostPhrases: AffectedPhrase[] = []
  const seenLostKeywords = new Set<string>()
  for (const e of evidence) {
    if (e.citationState !== 'lost') continue
    if (seenLostKeywords.has(e.keyword)) continue
    seenLostKeywords.add(e.keyword)
    lostPhrases.push({ keyword: e.keyword, evidenceId: e.id, provider: e.provider, citationState: 'lost' as CitationState })
  }

  if (lostPhrases.length > 0) {
    insights.push({
      id: 'insight_lost',
      tone: 'negative',
      title: `Lost citation on ${lostPhrases.length} key phrase${lostPhrases.length > 1 ? 's' : ''}`,
      detail: 'Citations dropped since the last run.',
      actionLabel: 'Lost',
      affectedPhrases: lostPhrases,
    })
  }

  // --- 2. Competitor gained ---
  const latestCompMap = buildCompetitorKeywordMap(latestSnapshots, trackedCompetitors)
  const prevCompMap = buildCompetitorKeywordMap(previousSnapshots, trackedCompetitors)

  for (const comp of trackedCompetitors) {
    const latestKws = latestCompMap.get(comp) ?? new Set()
    const prevKws = prevCompMap.get(comp) ?? new Set()
    const gained = [...latestKws].filter(kw => !prevKws.has(kw))
    if (gained.length > 0) {
      insights.push({
        id: `insight_comp_gained_${comp}`,
        tone: 'negative',
        title: `${comp} appeared on ${gained.length} key phrase${gained.length > 1 ? 's' : ''}`,
        detail: 'A tracked competitor gained new citations.',
        actionLabel: 'Competitor',
        affectedPhrases: gained.map(kw => {
          const ev = evidence.find(e => e.keyword === kw)
          return { keyword: kw, evidenceId: ev?.id ?? '', citationState: 'cited' as CitationState }
        }),
      })
    }
  }

  // --- 3 & 4. New provider pickup vs First citation ---
  // Use the deduped keyword timeline to decide: if the keyword itself just became cited
  // (transition = 'emerging' or 'new' + cited), it's a "first citation" (keyword-level).
  // If the keyword was already cited but a specific provider just started citing it
  // (provider transition = 'emerging'), it's a "new provider pickup".
  const keywordTransition = new Map<string, { transition: string; citationState: string }>()
  for (const entry of timeline) {
    const latest = entry.runs.at(-1)
    if (latest) keywordTransition.set(entry.keyword, { transition: latest.transition, citationState: latest.citationState })
  }

  const firstCitationPhrases: AffectedPhrase[] = []
  const newProviderPhrases: AffectedPhrase[] = []
  const firstCitationKeywords = new Set<string>()

  // First citation: keyword-level
  for (const [keyword, { transition, citationState }] of keywordTransition) {
    const isFirst = transition === 'emerging' || (transition === 'new' && citationState === 'cited')
    if (!isFirst) continue
    firstCitationKeywords.add(keyword)
    const ev = evidence.find(e => e.keyword === keyword && (e.citationState === 'emerging' || e.citationState === 'cited'))
    firstCitationPhrases.push({
      keyword, evidenceId: ev?.id ?? '', provider: ev?.provider, citationState: 'emerging',
    })
  }

  // New provider pickup: per-provider emerging where keyword was already cited
  for (const e of evidence) {
    if (e.citationState !== 'emerging') continue
    if (firstCitationKeywords.has(e.keyword)) continue
    newProviderPhrases.push({
      keyword: e.keyword, evidenceId: e.id, provider: e.provider, citationState: 'emerging',
    })
  }

  if (newProviderPhrases.length > 0) {
    const kwCount = new Set(newProviderPhrases.map(p => p.keyword)).size
    insights.push({
      id: 'insight_provider_pickup',
      tone: 'positive',
      title: `Picked up by new provider on ${kwCount} key phrase${kwCount > 1 ? 's' : ''}`,
      detail: 'Your domain started appearing on additional providers.',
      actionLabel: 'Pickup',
      affectedPhrases: newProviderPhrases,
    })
  }

  if (firstCitationPhrases.length > 0) {
    insights.push({
      id: 'insight_first_citation',
      tone: 'positive',
      title: `First citation on ${firstCitationKeywords.size} key phrase${firstCitationKeywords.size > 1 ? 's' : ''}`,
      detail: 'Your domain appeared in AI answers for the first time.',
      actionLabel: 'New',
      affectedPhrases: firstCitationPhrases,
    })
  }

  // --- 5. Persistent gap (keyword-level, deduped timeline) ---
  const evidenceKeywords = new Set(evidence.map(e => e.keyword))
  const gapPhrases: AffectedPhrase[] = []

  for (const entry of timeline) {
    if (!evidenceKeywords.has(entry.keyword)) continue
    if (entry.runs.length < GAP_THRESHOLD) continue
    const latestRun = entry.runs.at(-1)
    if (latestRun?.citationState !== 'not-cited') continue
    const streak = computeStreak(entry.runs)
    if (streak >= GAP_THRESHOLD) {
      const ev = evidence.find(e => e.keyword === entry.keyword)
      gapPhrases.push({ keyword: entry.keyword, evidenceId: ev?.id ?? '', citationState: 'not-cited' })
    }
  }

  if (gapPhrases.length > 0) {
    insights.push({
      id: 'insight_persistent_gap',
      tone: 'caution',
      title: `${gapPhrases.length} key phrase${gapPhrases.length > 1 ? 's' : ''} uncited for ${GAP_THRESHOLD}+ runs`,
      detail: 'These key phrases have not been cited by any provider across multiple consecutive runs.',
      actionLabel: 'Gap',
      affectedPhrases: gapPhrases,
    })
  }

  // --- 6. Competitor lost ---
  for (const comp of trackedCompetitors) {
    const latestKws = latestCompMap.get(comp) ?? new Set()
    const prevKws = prevCompMap.get(comp) ?? new Set()
    const lost = [...prevKws].filter(kw => !latestKws.has(kw))
    if (lost.length > 0) {
      insights.push({
        id: `insight_comp_lost_${comp}`,
        tone: 'neutral',
        title: `${comp} dropped from ${lost.length} key phrase${lost.length > 1 ? 's' : ''}`,
        detail: 'A tracked competitor lost citations.',
        actionLabel: 'Competitor',
        affectedPhrases: lost.map(kw => {
          const ev = evidence.find(e => e.keyword === kw)
          return { keyword: kw, evidenceId: ev?.id ?? '', citationState: 'not-cited' as CitationState }
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
      detail: 'Citation state is stable across all tracked key phrases.',
      actionLabel: 'Stable',
      affectedPhrases: [],
    })
  }

  return insights
}

/** Compare latest vs previous run to count keyword-level gains and losses. */
function computeMovement(
  latestSnapshots: ApiRunDetail['snapshots'],
  previousSnapshots: ApiRunDetail['snapshots'],
): MovementSummaryVm {
  if (previousSnapshots.length === 0) {
    // No previous run to compare against
    const citedCount = new Set(
      latestSnapshots.filter(s => s.citationState === 'cited').map(s => s.keyword),
    ).size
    return { gained: citedCount, lost: 0, tone: citedCount > 0 ? 'positive' : 'neutral', hasPreviousRun: false }
  }

  // Build keyword-level cited sets (cited if ANY provider cited it)
  const buildCitedSet = (snaps: ApiRunDetail['snapshots']): Set<string> => {
    const cited = new Set<string>()
    for (const s of snaps) {
      if (s.citationState === 'cited' && s.keyword) cited.add(s.keyword)
    }
    return cited
  }

  const latestCited = buildCitedSet(latestSnapshots)
  const previousCited = buildCitedSet(previousSnapshots)

  let gained = 0
  let lost = 0
  for (const kw of latestCited) {
    if (!previousCited.has(kw)) gained++
  }
  for (const kw of previousCited) {
    if (!latestCited.has(kw)) lost++
  }

  const tone: MetricTone = lost > gained ? 'negative' : gained > lost ? 'positive' : 'neutral'
  return { gained, lost, tone, hasPreviousRun: true }
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
  previousRunDetail: ApiRunDetail | null
  gscCoverage?: ApiGscCoverageSummary | null
  bingCoverage?: ApiBingCoverageSummary | null
}

export function buildProjectCommandCenter(data: ProjectData): ProjectCommandCenterVm {
  const dto = toProjectDto(data.project)
  const evidence = buildEvidenceFromTimeline(dto.name, data.timeline, data.latestRunDetail, data.keywords)
  const snapshots = data.latestRunDetail?.snapshots ?? []
  const kwVis = computeKeywordVisibility(snapshots)
  const gapKeyPhrases = buildGapKeyPhraseSummary(snapshots)
  const indexCoverage = buildIndexCoverageSummary(data.gscCoverage, data.bingCoverage)
  const pressure = computeCompetitorPressure(snapshots, data.competitors.map(c => c.domain))
  const insights = buildInsights({
    evidence,
    timeline: data.timeline,
    latestSnapshots: data.latestRunDetail?.snapshots ?? [],
    previousSnapshots: data.previousRunDetail?.snapshots ?? [],
    trackedCompetitors: data.competitors.map(c => c.domain),
  })

  const sortedRuns = [...data.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const runItems = sortedRuns.map(r => toRunListItem(r, data.project.displayName || data.project.name))

  // Compute per-model scores (grouped by provider+model)
  const modelGroups = new Map<string, { provider: string; model: string | null; cited: number; total: number }>()
  for (const snap of snapshots) {
    const p = snap.provider || 'gemini'
    const m = snap.model ?? null
    const key = `${p}::${m ?? 'unknown'}`
    const group = modelGroups.get(key) ?? { provider: p, model: m, cited: 0, total: 0 }
    group.total++
    if (snap.citationState === 'cited') group.cited++
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
    keywordCounts: { cited: kwVis.citedCount, total: kwVis.totalCount },
    gapKeyPhrases,
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
      tooltip: 'How often competitor domains appear alongside yours in AI answers. High pressure means competitors are frequently cited for the same key phrases.',
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
