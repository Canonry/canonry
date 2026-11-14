import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import { currentSeoTasks, runs, seoJobs, seoTasks, type DatabaseClient, type SeoJobRow, type SeoTaskRow } from '@canonry/canonry-db'
import {
  SEO_MARKET_PAGE_ONE_LAST_RANK, SEO_TREND_DEFAULT_DAYS, SeoAdapterOutcomes, SeoCapabilities, SeoMarketRankingOutcomes,
  SeoMarketRankingSearchStatuses, SeoRunStatuses, SeoTrendKinds, TrendBetter, TrendUnits,
  buildLevelTrendFigure, compareText, countMarketRankings, marketRankingRow, normalizeQueryText, queryClassSchema, seoTrendKeywordSchema, shiftIsoCalendarDate,
  type SeoDomainIntelligence, type SeoMarketRanking, type SeoMarketRankingRow, type SeoProfile, type SeoProfileInput, type SeoProvenance,
  type SeoTarget, type SeoTrendDays, type SeoTrendKind, type SeoTrendPoint, type SeoTrends, type SeoTrendsQuery,
} from '@canonry/canonry-contracts'
import { notProbeRun } from './helpers.js'

const EMPTY_POINT = { organicKeywords: null, inTop10: null, estimatedOrganicTraffic: null, page1: null }
const NON_BRAND = queryClassSchema.enum['non-brand']
const RANKED_KEYWORD_SUGGESTIONS = 100
const CAPABILITY = {
  [SeoTrendKinds.market]: SeoCapabilities['market-rankings'],
  [SeoTrendKinds.domain]: SeoCapabilities['domain-intelligence'],
  [SeoTrendKinds.ranked]: SeoCapabilities['ranked-keywords'],
} as const

const trendJobFields = {
  id: seoJobs.id, profile: seoJobs.profile, profileRevision: seoJobs.profileRevision,
  accountKey: seoJobs.accountKey, connectionId: seoJobs.connectionId,
  createdAt: seoJobs.createdAt, finishedAt: seoJobs.finishedAt,
  mode: sql<string | null>`json_extract(${seoJobs.scopeSnapshot}, '$.mode')`,
  planVersionId: sql<string | null>`json_extract(${seoJobs.scopeSnapshot}, '$.planVersionId')`,
  planRevision: sql<number | null>`json_extract(${seoJobs.scopeSnapshot}, '$.planRevision')`,
}
type TrendJob = Pick<SeoJobRow, 'id' | 'profile' | 'profileRevision' | 'accountKey' | 'connectionId' | 'createdAt' | 'finishedAt'> & {
  mode: string | null
  planVersionId: string | null
  planRevision: number | null
}
type TrendSpan = { startDate: string; endDate: string }

function sameTarget(left: SeoTarget | null | undefined, right: SeoTarget): boolean {
  return left?.value === right.value && left.kind === right.kind && left.includeSubdomains === right.includeSubdomains
}

export function primaryDomainIntelligence(rows: readonly SeoDomainIntelligence[], target: SeoTarget | undefined): SeoDomainIntelligence | undefined {
  return target ? rows.find(row => sameTarget(row.target, target)) : undefined
}

export function domainTop10(row: SeoDomainIntelligence): number | null {
  const { top1, top2To3, top4To10 } = row
  return top1 === null || top2To3 === null || top4To10 === null ? null : top1 + top2To3 + top4To10
}

function trendKind(profile: SeoProfileInput): SeoTrendKind | null {
  if (profile.capabilities.includes(CAPABILITY.market)) return SeoTrendKinds.market
  if (profile.capabilities.includes(CAPABILITY.domain)) return SeoTrendKinds.domain
  return profile.capabilities.includes(CAPABILITY.ranked) ? SeoTrendKinds.ranked : null
}

/** Use measured settings instead of the revision, which also changes after a profile rename. */
function sameJobCohort(job: TrendJob, anchor: TrendJob, target: SeoTarget, kind: SeoTrendKind): boolean {
  const scope = job.profile.scope
  const frozenScope = anchor.profile.scope
  return job.connectionId === anchor.connectionId && job.accountKey === anchor.accountKey
    && job.profile.languageCode === anchor.profile.languageCode && job.profile.locationCode === anchor.profile.locationCode
    && sameTarget(job.profile.targets[0], target)
    && scope.kind === frozenScope.kind && scope.key === frozenScope.key && scope.expectedPlanRevision === frozenScope.expectedPlanRevision
    && job.mode === anchor.mode && job.planVersionId === anchor.planVersionId && job.planRevision === anchor.planRevision
    && job.profile.capabilities.includes(CAPABILITY[kind])
    && (kind !== SeoTrendKinds.ranked || job.profile.limit === anchor.profile.limit)
}

function normalizeInstant(value: string | null | undefined): string | null {
  const time = value ? Date.parse(value) : NaN
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

interface KeywordReading {
  keyword: string
  observedAt: string
  rankOrganic: number
}

interface Observation {
  point: SeoTrendPoint
  source: string | null
  basket: string | null
  marketQueryCount: number | null
  keywords?: Map<string, KeywordReading>
}

function observation(job: TrendJob): Observation {
  return {
    point: { runId: job.id, observedAt: normalizeInstant(job.finishedAt) ?? job.createdAt, ...EMPTY_POINT },
    source: null, basket: null, marketQueryCount: null,
  }
}

function sourceIdentity(source: SeoProvenance): string {
  return JSON.stringify([source.provider, source.dataset, source.engine, source.languageCode, source.device])
}

function settledTask(task: SeoTaskRow): boolean {
  return task.reconciliation?.outcome !== SeoAdapterOutcomes.failed
    && (task.status === SeoRunStatuses.completed || task.status === SeoRunStatuses.partial)
}

function domainObservation(job: TrendJob, tasks: SeoTaskRow[], target: SeoTarget): Observation {
  const reading = observation(job)
  const rows = tasks.filter(settledTask).flatMap(task => task.results.domainIntelligence)
  const evidence = primaryDomainIntelligence(rows, target)
  if (!evidence) return reading
  const { provenance } = evidence
  const observedAt = normalizeInstant(provenance.collectedAt)
  if (!observedAt || provenance.locationCode !== job.profile.locationCode || provenance.languageCode !== job.profile.languageCode) return reading
  reading.source = JSON.stringify([sourceIdentity(provenance), provenance.locationCode])
  reading.point = { ...reading.point, observedAt, organicKeywords: evidence.organicKeywords, inTop10: domainTop10(evidence), estimatedOrganicTraffic: evidence.estimatedOrganicTraffic }
  return reading
}

function rankedObservation(job: TrendJob, tasks: SeoTaskRow[], target: SeoTarget): Observation {
  const reading = observation(job)
  const keywords = new Map<string, KeywordReading>()
  const sources = new Set<string>()
  let newest: string | null = null
  for (const task of tasks) {
    const { request } = task
    if (!settledTask(task) || !sameTarget(request.target, target)) continue
    for (const row of task.results.rankedKeywords) {
      const { provenance, rankOrganic } = row
      if (!sameTarget(row.target, target) || provenance.locationCode !== job.profile.locationCode || provenance.languageCode !== job.profile.languageCode) continue
      const observedAt = normalizeInstant(provenance.collectedAt)
      if (!observedAt) continue
      sources.add(sourceIdentity(provenance))
      if (!newest || observedAt > newest) newest = observedAt
      if (rankOrganic === null) continue
      const keyword = seoTrendKeywordSchema.safeParse(row.keyword)
      if (!keyword.success) continue
      const key = normalizeQueryText(keyword.data)
      const prior = keywords.get(key)
      // URLs can repeat a keyword for the same target. Use its best observed organic rank.
      if (!prior || rankOrganic < prior.rankOrganic) keywords.set(key, { keyword: keyword.data, observedAt, rankOrganic })
    }
  }
  if (sources.size === 1 && newest) {
    reading.source = [...sources][0]!
    reading.point.observedAt = newest
    reading.keywords = keywords
  }
  return reading
}

type BasketContext = Pick<SeoMarketRanking, 'marketKey' | 'regionKey' | 'queryId' | 'queryText' | 'queryClass'>
function marketSlot(context: BasketContext, searchText: string): string {
  return JSON.stringify([context.marketKey, context.regionKey, context.queryId, context.queryText, context.queryClass, searchText])
}

/** The planned cohort comes from frozen requests, even if the refresh returned no readings. */
function marketObservation(job: TrendJob, tasks: SeoTaskRow[], target: SeoTarget, rowsForTask: (task: SeoTaskRow) => SeoMarketRanking[]): Observation {
  const reading = observation(job)
  const planned: string[] = []
  const rows: SeoMarketRankingRow[] = []
  let complete = true
  for (const task of tasks) {
    const { search, keywords, locationCode, languageCode } = task.request
    const searchText = keywords[0]
    if (!search || !searchText || !sameTarget(task.request.target, target)) return reading
    const expected = new Set(search.markets.filter(market => market.context.queryClass === NON_BRAND).map(market => marketSlot(market.context, searchText)))
    for (const entry of expected) planned.push(JSON.stringify([entry, locationCode, languageCode, search.device, search.depth]))
    for (const item of settledTask(task) ? rowsForTask(task) : []) {
      if (item.queryClass !== NON_BRAND) continue
      const row = marketRankingRow(item)
      const source = row.provenance
      // A partial search confirms page-one membership when it finds the target there, or checks the whole page.
      const checked = row.searchStatus === SeoMarketRankingSearchStatuses.completed || (row.searchStatus === SeoMarketRankingSearchStatuses.partial
        && (row.outcome === SeoMarketRankingOutcomes['page-1'] || row.depth >= SEO_MARKET_PAGE_ONE_LAST_RANK))
      complete = expected.delete(marketSlot(row, row.searchText)) && sameTarget(row.target, target) && checked
        && source?.locationCode === locationCode && source.languageCode === languageCode && source.device === search.device && complete
      rows.push(row)
    }
    if (expected.size > 0) complete = false
  }
  if (planned.length === 0 || new Set(planned).size !== planned.length) return reading
  reading.basket = JSON.stringify(planned.sort())
  reading.marketQueryCount = planned.length
  const sources = new Set(rows.flatMap(row => row.provenance ? [sourceIdentity(row.provenance)] : []))
  if (sources.size === 1) reading.source = [...sources][0] ?? null
  if (!complete || rows.length !== planned.length || !reading.source) return reading
  const timestamps = rows.map(row => normalizeInstant(row.provenance?.collectedAt))
  if (timestamps.some(time => time === null)) return reading
  reading.point = {
    ...reading.point, observedAt: timestamps.sort().at(-1) ?? reading.point.observedAt,
    page1: countMarketRankings(rows).page1,
  }
  return reading
}

function trendChanges(points: SeoTrendPoint[], span: TrendSpan | null, kind: SeoTrendKind | null): SeoTrends['changes'] {
  const changeOf = (key: keyof typeof EMPTY_POINT | 'rankOrganic') => buildLevelTrendFigure({
    key, label: key, unit: TrendUnits.count, better: key === 'rankOrganic' ? TrendBetter.lower : TrendBetter.higher, span,
    readings: points.map(point => ({ date: point.observedAt.slice(0, 10), observedAt: point.observedAt, value: point[key] ?? null })),
  }).change
  return {
    organicKeywords: changeOf('organicKeywords'), inTop10: changeOf('inTop10'), estimatedOrganicTraffic: changeOf('estimatedOrganicTraffic'), page1: changeOf('page1'),
    ...(kind === SeoTrendKinds.ranked ? { rankOrganic: changeOf('rankOrganic') } : {}),
  }
}

function trendWindow(endDate: string, days: SeoTrendDays): TrendSpan {
  return { startDate: shiftIsoCalendarDate(endDate, -(days - 1)), endDate }
}

function rankedKeywords(observations: Observation[], requested?: string): { rankedKeywords: string[]; keyword: string | null } {
  const options = new Map<string, { keyword: string; instants: Set<string> }>()
  for (const reading of observations) {
    for (const [key, { keyword, observedAt }] of reading.keywords ?? []) {
      const option = options.get(key)
      if (option) option.instants.add(observedAt)
      else options.set(key, { keyword, instants: new Set([observedAt]) })
    }
  }
  // Stable sort makes newer saved refreshes and the provider's row order the tie-breakers.
  const rankedKeywords = [...options.values()].sort((a, b) => b.instants.size - a.instants.size)
    .slice(0, RANKED_KEYWORD_SUGGESTIONS).map(option => option.keyword)
  const keyword = requested === undefined ? rankedKeywords[0] ?? null : options.get(normalizeQueryText(requested))?.keyword ?? requested
  return { rankedKeywords, keyword }
}

function loadTrendCohort(db: DatabaseClient, anchor: TrendJob, projectId: string, profileId: string, target: SeoTarget, kind: SeoTrendKind, rowsForTask: (task: SeoTaskRow) => SeoMarketRanking[]) {
  const read = (job: TrendJob): Observation => {
    const tasks = currentSeoTasks(db.select().from(seoTasks)
      .where(and(eq(seoTasks.jobId, job.id), sql`json_extract(${seoTasks.request}, '$.capability') = ${CAPABILITY[kind]}`))
      .orderBy(seoTasks.id).all())
    switch (kind) {
      case SeoTrendKinds.market: return marketObservation(job, tasks, target, rowsForTask)
      case SeoTrendKinds.domain: return domainObservation(job, tasks, target)
      case SeoTrendKinds.ranked: return rankedObservation(job, tasks, target)
    }
  }
  const anchorReading = read(anchor)
  let { basket, source, marketQueryCount } = anchorReading
  const observations: Observation[] = []
  let endDate = kind !== SeoTrendKinds.market || basket ? anchorReading.point.observedAt.slice(0, 10) : null
  const scanFrom = endDate ? trendWindow(endDate, SEO_TREND_DEFAULT_DAYS).startDate : null
  const jobs = db.select(trendJobFields).from(seoJobs).innerJoin(runs, eq(seoJobs.runId, runs.id))
    .where(and(eq(seoJobs.projectId, projectId), eq(seoJobs.profileId, profileId), notProbeRun(),
      scanFrom ? gte(seoJobs.finishedAt, scanFrom) : isNotNull(seoJobs.finishedAt)))
    .orderBy(desc(seoJobs.createdAt), sql`seo_jobs.rowid DESC`).all()
  let reachedAnchor = false
  for (const job of jobs) {
    reachedAnchor ||= job.id === anchor.id
    if (!sameJobCohort(job, anchor, target, kind)) {
      if (!reachedAnchor) continue
      break
    }
    const reading = job.id === anchor.id ? anchorReading : read(job)
    if ((basket && reading.basket && basket !== reading.basket) || (source && reading.source && source !== reading.source)) {
      if (!reachedAnchor) continue
      break
    }
    // An unplanned market refresh cannot establish which query basket it measured.
    if (kind === SeoTrendKinds.market && (!reading.basket || (!reachedAnchor && !basket))) continue
    basket ??= reading.basket
    source ??= reading.source
    marketQueryCount ??= reading.marketQueryCount
    const date = reading.point.observedAt.slice(0, 10)
    if (!endDate || date > endDate) endDate = date
    observations.push(reading)
  }
  const earliest = endDate ? trendWindow(endDate, SEO_TREND_DEFAULT_DAYS).startDate : null
  return { observations: observations.filter(reading => earliest !== null && reading.point.observedAt.slice(0, 10) >= earliest), marketQueryCount, endDate }
}

function hasRankingReading(reading: Observation): boolean {
  const { organicKeywords, inTop10, estimatedOrganicTraffic, page1 } = reading.point
  return organicKeywords !== null || inTop10 !== null || estimatedOrganicTraffic !== null || page1 !== null || Boolean(reading.keywords?.size)
}

function trendSeries(observations: Observation[], window: TrendSpan | null, ranked?: { keyword: string | null }): SeoTrendPoint[] {
  if (!window) return []
  const key = ranked?.keyword ? normalizeQueryText(ranked.keyword) : null
  const instants = new Map<string, SeoTrendPoint>()
  for (const reading of observations) {
    const rank = key === null ? undefined : reading.keywords?.get(key)
    const point = ranked
      ? { ...reading.point, observedAt: rank?.observedAt ?? reading.point.observedAt, rankOrganic: rank?.rankOrganic ?? null }
      : reading.point
    const date = point.observedAt.slice(0, 10)
    if (date < window.startDate || date > window.endDate) continue
    const prior = instants.get(point.observedAt)
    if (!prior || (ranked && prior.rankOrganic === null && rank)) instants.set(point.observedAt, point)
  }
  return [...instants.values()].sort((a, b) => compareText(a.observedAt, b.observedAt))
}

export function readSeoTrends(db: DatabaseClient, projectId: string, saved: SeoProfile, query: SeoTrendsQuery, rowsForTask: (task: SeoTaskRow) => SeoMarketRanking[]): SeoTrends {
  const days = query.days ?? SEO_TREND_DEFAULT_DAYS
  const anchor = db.select(trendJobFields).from(seoJobs).innerJoin(runs, eq(seoJobs.runId, runs.id))
    .where(and(eq(seoJobs.projectId, projectId), eq(seoJobs.profileId, saved.id), notProbeRun(),
      isNotNull(seoJobs.finishedAt), inArray(seoJobs.status, [SeoRunStatuses.completed, SeoRunStatuses.partial])))
    .orderBy(desc(seoJobs.createdAt), sql`seo_jobs.rowid DESC`).get()
  const profile = anchor?.profile ?? saved
  const target = profile.targets[0]
  let kind = trendKind(profile)
  if (kind === SeoTrendKinds.domain && query.keyword && profile.capabilities.includes(CAPABILITY.ranked)) kind = SeoTrendKinds.ranked
  let history = kind && target && anchor ? loadTrendCohort(db, anchor, projectId, saved.id, target, kind, rowsForTask) : null
  let hasRankingReadings = history?.observations.some(hasRankingReading) ?? false
  if (kind === SeoTrendKinds.domain && !hasRankingReadings && profile.capabilities.includes(CAPABILITY.ranked) && target && anchor) {
    const rankedHistory = loadTrendCohort(db, anchor, projectId, saved.id, target, SeoTrendKinds.ranked, rowsForTask)
    if (rankedHistory.observations.some(hasRankingReading)) {
      kind = SeoTrendKinds.ranked
      history = rankedHistory
      hasRankingReadings = true
    }
  }
  const observations = history?.observations ?? []
  const window = history?.endDate ? trendWindow(history.endDate, days) : null
  const ranked = kind === SeoTrendKinds.ranked ? rankedKeywords(observations, query.keyword) : undefined
  const series = trendSeries(observations, window, ranked)
  return {
    kind, profileId: saved.id, profileRevision: anchor?.profileRevision ?? null, target: target ?? null, scope: profile.scope,
    languageCode: profile.languageCode, locationCode: kind === SeoTrendKinds.market ? null : profile.locationCode,
    days, marketQueryCount: history?.marketQueryCount ?? null, hasRankingReadings,
    points: series, changes: trendChanges(series, window, kind), ...ranked,
  }
}
