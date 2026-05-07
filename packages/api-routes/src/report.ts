import { and, desc, eq, inArray, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  bingCoverageSnapshots,
  competitors,
  gaAiReferrals,
  gaSocialReferrals,
  gaTrafficSnapshots,
  gaTrafficSummaries,
  gscCoverageSnapshots,
  gscSearchData,
  insights,
  queries,
  parseJsonColumn,
  querySnapshots,
  runs,
} from '@ainyc/canonry-db'
import {
  CitationStates,
  RunKinds,
  RunStatuses,
  getProviderLocationHandling,
  type CitationsTrendPoint,
  type CompetitorRow,
  type GscQueryRow,
  type LocationContext,
  type ProjectReportDto,
  type RecommendedNextStep,
  type ReportInsight,
  type ReportProviderLocationHandling,
  type SocialReferralSection,
} from '@ainyc/canonry-contracts'
import {
  buildAiSourceOrigin,
  buildBrandTokens,
  buildCitationScorecard,
  buildCompetitorLandscape,
  buildMentionLandscape,
  buildContentTargetRows,
  buildContentSourceRows,
  buildContentGapRows,
  categorizeQueryByIntent,
  groupInsights,
  isTrendBaseline,
  MIN_TREND_POINTS,
  mapOpportunitiesToNextSteps,
} from '@ainyc/canonry-intelligence'
import { resolveProject } from './helpers.js'
import { renderReportHtml } from './report-renderer.js'
import {
  extractGroundingSources,
  loadOrchestratorInput,
} from './content-data.js'
import type { GroundingSource } from '@ainyc/canonry-contracts'
import type { DatabaseClient } from '@ainyc/canonry-db'

const TOP_QUERIES_LIMIT = 20
const TOP_LANDING_PAGES_LIMIT = 20
const TOP_AI_REFERRAL_PAGES_LIMIT = 10
const TOP_CAMPAIGN_LIMIT = 10
// Cap insight history at the same window the intelligence layer uses
// for recurrence (RECURRENCE_LOOKBACK_RUNS in intelligence-service.ts).
// Keeps a months-old undismissed regression from cluttering today's
// report while still surfacing alerts that recur within recent history.
const INSIGHT_LOOKBACK_RUNS = 5

function safeNum(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

// Thin wrapper around the shared intelligence-package categorizer.
// Encapsulates brand-token construction so the existing buildGscSection
// call sites don't all need to thread brandTokens through. The display
// name is preferred over the project slug because the slug is internal
// (e.g. "acme-corp") while the display name matches what searchers type.
function categorizeQuery(query: string, projectDisplayName: string, canonicalDomain: string): GscQueryRow['category'] {
  return categorizeQueryByIntent(query, buildBrandTokens(canonicalDomain, projectDisplayName))
}

interface SnapshotRow {
  id: string
  runId: string
  queryId: string
  provider: string
  model: string | null
  citationState: string
  answerMentioned: boolean | null
  answerText: string | null
  citedDomains: string[]
  competitorOverlap: string[]
  groundingSources: GroundingSource[]
  createdAt: string
}

function loadSnapshotsForRun(db: DatabaseClient, runId: string): SnapshotRow[] {
  const rows = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
  return rows.map(r => ({
    id: r.id,
    runId: r.runId,
    queryId: r.queryId,
    provider: r.provider,
    model: r.model,
    citationState: r.citationState,
    answerMentioned: r.answerMentioned,
    answerText: r.answerText,
    citedDomains: parseJsonColumn<string[]>(r.citedDomains, []),
    competitorOverlap: parseJsonColumn<string[]>(r.competitorOverlap, []),
    groundingSources: extractGroundingSources(r.rawResponse),
    createdAt: r.createdAt,
  }))
}

interface QueryLookup {
  byId: Map<string, string>
}

function loadQueryLookup(db: DatabaseClient, projectId: string): QueryLookup {
  const rows = db.select().from(queries).where(eq(queries.projectId, projectId)).all()
  const byId = new Map<string, string>()
  for (const row of rows) byId.set(row.id, row.query)
  return { byId }
}

function buildGscSection(
  db: DatabaseClient,
  projectId: string,
  projectDisplayName: string,
  canonicalDomain: string,
  trackedQueries: string[],
): ProjectReportDto['gsc'] {
  const rows = db.select().from(gscSearchData).where(eq(gscSearchData.projectId, projectId)).all()
  if (rows.length === 0) return null

  let totalClicks = 0
  let totalImpressions = 0
  let weightedPositionSum = 0
  const queryAgg = new Map<string, { clicks: number; impressions: number; weightedPositionSum: number }>()
  const trendAgg = new Map<string, { clicks: number; impressions: number }>()

  for (const r of rows) {
    totalClicks += r.clicks
    totalImpressions += r.impressions
    weightedPositionSum += safeNum(r.position) * r.impressions
    const q = queryAgg.get(r.query) ?? { clicks: 0, impressions: 0, weightedPositionSum: 0 }
    q.clicks += r.clicks
    q.impressions += r.impressions
    q.weightedPositionSum += safeNum(r.position) * r.impressions
    queryAgg.set(r.query, q)

    const t = trendAgg.get(r.date) ?? { clicks: 0, impressions: 0 }
    t.clicks += r.clicks
    t.impressions += r.impressions
    trendAgg.set(r.date, t)
  }

  const ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0
  const avgPosition = totalImpressions > 0 ? weightedPositionSum / totalImpressions : 0

  const topQueries: GscQueryRow[] = [...queryAgg.entries()]
    .map(([query, agg]) => ({
      query,
      clicks: agg.clicks,
      impressions: agg.impressions,
      ctr: agg.impressions > 0 ? agg.clicks / agg.impressions : 0,
      avgPosition: agg.impressions > 0 ? agg.weightedPositionSum / agg.impressions : 0,
      category: categorizeQuery(query, projectDisplayName, canonicalDomain),
    }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, TOP_QUERIES_LIMIT)

  const categoryAgg = new Map<GscQueryRow['category'], { clicks: number; impressions: number }>()
  for (const [query, agg] of queryAgg) {
    const cat = categorizeQuery(query, projectDisplayName, canonicalDomain)
    const bucket = categoryAgg.get(cat) ?? { clicks: 0, impressions: 0 }
    bucket.clicks += agg.clicks
    bucket.impressions += agg.impressions
    categoryAgg.set(cat, bucket)
  }
  const categoryBreakdown = [...categoryAgg.entries()].map(([category, agg]) => ({
    category,
    clicks: agg.clicks,
    impressions: agg.impressions,
    sharePct: totalClicks > 0 ? Math.round((agg.clicks / totalClicks) * 100) : 0,
  })).sort((a, b) => b.clicks - a.clicks)

  const trend = [...trendAgg.entries()]
    .map(([date, agg]) => ({ date, clicks: agg.clicks, impressions: agg.impressions }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const trackedSet = new Set(trackedQueries.map(q => q.toLowerCase()))
  const gscQuerySet = new Set([...queryAgg.keys()].map(q => q.toLowerCase()))
  const trackedButNoGsc = trackedQueries.filter(q => !gscQuerySet.has(q.toLowerCase())).sort()
  // Surface brand-free candidates only — brand queries already convert
  // regardless of AEO tracking, so they're not actionable additions to
  // the project query set.
  const gscButNotTracked = [...queryAgg.entries()]
    .filter(([q]) => !trackedSet.has(q.toLowerCase()))
    .filter(([q]) => categorizeQuery(q, projectDisplayName, canonicalDomain) !== 'brand')
    .sort((a, b) => b[1].impressions - a[1].impressions)
    .map(([q]) => q)
    .slice(0, TOP_QUERIES_LIMIT)

  return {
    totalClicks,
    totalImpressions,
    ctr,
    avgPosition,
    topQueries,
    categoryBreakdown,
    trend,
    trackedButNoGsc,
    gscButNotTracked,
  }
}

function buildGaSection(db: DatabaseClient, projectId: string): ProjectReportDto['ga'] {
  const summaryRow = db
    .select()
    .from(gaTrafficSummaries)
    .where(eq(gaTrafficSummaries.projectId, projectId))
    .orderBy(desc(gaTrafficSummaries.syncedAt))
    .limit(1)
    .get()

  const snapshotRows = db
    .select()
    .from(gaTrafficSnapshots)
    .where(eq(gaTrafficSnapshots.projectId, projectId))
    .all()

  if (!summaryRow && snapshotRows.length === 0) return null

  const totalSessions = summaryRow?.totalSessions ?? snapshotRows.reduce((s, r) => s + r.sessions, 0)
  const totalUsers = summaryRow?.totalUsers ?? snapshotRows.reduce((s, r) => s + r.users, 0)
  const totalOrganicSessions = summaryRow?.totalOrganicSessions
    ?? snapshotRows.reduce((s, r) => s + r.organicSessions, 0)

  const pageAgg = new Map<string, { sessions: number; users: number; organic: number }>()
  let directSessions = 0
  for (const r of snapshotRows) {
    const page = r.landingPageNormalized ?? r.landingPage
    const existing = pageAgg.get(page) ?? { sessions: 0, users: 0, organic: 0 }
    existing.sessions += r.sessions
    existing.users += r.users
    existing.organic += r.organicSessions
    pageAgg.set(page, existing)
    if (r.directSessions != null) directSessions += r.directSessions
  }

  const topLandingPages = [...pageAgg.entries()]
    .map(([page, data]) => ({
      page,
      sessions: data.sessions,
      users: data.users,
      organicSessions: data.organic,
    }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, TOP_LANDING_PAGES_LIMIT)

  const channelBreakdown: ProjectReportDto['ga'] extends infer T
    ? T extends { channelBreakdown: infer C } ? C : never : never = []
  if (totalSessions > 0) {
    const organic = totalOrganicSessions
    const direct = directSessions
    const other = Math.max(totalSessions - organic - direct, 0)
    const buckets: Array<{ channel: string; sessions: number }> = [
      { channel: 'Organic Search', sessions: organic },
      { channel: 'Direct', sessions: direct },
      { channel: 'Other', sessions: other },
    ]
    for (const b of buckets) {
      if (b.sessions > 0) {
        channelBreakdown.push({
          channel: b.channel,
          sessions: b.sessions,
          sharePct: Math.round((b.sessions / totalSessions) * 100),
        })
      }
    }
  }

  return {
    totalSessions,
    totalUsers,
    totalOrganicSessions,
    periodStart: summaryRow?.periodStart ?? '',
    periodEnd: summaryRow?.periodEnd ?? '',
    topLandingPages,
    channelBreakdown,
  }
}

function buildSocialReferrals(db: DatabaseClient, projectId: string): SocialReferralSection | null {
  const rows = db
    .select()
    .from(gaSocialReferrals)
    .where(eq(gaSocialReferrals.projectId, projectId))
    .all()
  if (rows.length === 0) return null

  let total = 0
  let organic = 0
  let paid = 0
  const channelAgg = new Map<string, number>()
  const campaignAgg = new Map<string, { source: string; medium: string; sessions: number }>()

  for (const r of rows) {
    total += r.sessions
    if (r.channelGroup === 'Paid Social') paid += r.sessions
    else organic += r.sessions
    channelAgg.set(r.channelGroup, (channelAgg.get(r.channelGroup) ?? 0) + r.sessions)
    const key = `${r.source}::${r.medium}`
    const existing = campaignAgg.get(key) ?? { source: r.source, medium: r.medium, sessions: 0 }
    existing.sessions += r.sessions
    campaignAgg.set(key, existing)
  }

  const channels = [...channelAgg.entries()]
    .map(([channelGroup, sessions]) => ({
      channelGroup,
      sessions,
      sharePct: total > 0 ? Math.round((sessions / total) * 100) : 0,
    }))
    .sort((a, b) => b.sessions - a.sessions)

  const topCampaigns = [...campaignAgg.values()]
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, TOP_CAMPAIGN_LIMIT)

  return {
    totalSessions: total,
    organicSessions: organic,
    paidSessions: paid,
    channels,
    topCampaigns,
  }
}

function buildAiReferrals(db: DatabaseClient, projectId: string): ProjectReportDto['aiReferrals'] {
  const rows = db
    .select()
    .from(gaAiReferrals)
    .where(eq(gaAiReferrals.projectId, projectId))
    .all()
  if (rows.length === 0) return null

  // Dedupe overlapping attribution dimensions ('session', 'first_user',
  // 'manual_utm') the same way GET /projects/:name/ga/traffic in ga.ts does:
  // they're alternate lenses on the same visit, not disjoint events. For each
  // (date, source, medium) tuple, pick the dimension whose total sessions are
  // largest and keep only rows from that winning dimension.
  const dimSessionsByTuple = new Map<string, Map<string, number>>()
  for (const r of rows) {
    const tupleKey = `${r.date}::${r.source}::${r.medium}`
    let dimMap = dimSessionsByTuple.get(tupleKey)
    if (!dimMap) {
      dimMap = new Map<string, number>()
      dimSessionsByTuple.set(tupleKey, dimMap)
    }
    dimMap.set(r.sourceDimension, (dimMap.get(r.sourceDimension) ?? 0) + r.sessions)
  }
  const winningDimension = new Map<string, string>()
  for (const [tupleKey, dimMap] of dimSessionsByTuple) {
    let bestDim: string | undefined
    let bestSessions = -1
    for (const [dim, sessions] of dimMap) {
      if (sessions > bestSessions) {
        bestSessions = sessions
        bestDim = dim
      }
    }
    if (bestDim) winningDimension.set(tupleKey, bestDim)
  }
  const dedupedRows = rows.filter(r =>
    winningDimension.get(`${r.date}::${r.source}::${r.medium}`) === r.sourceDimension,
  )

  let total = 0
  let totalUsers = 0
  const sourceAgg = new Map<string, { sessions: number; users: number }>()
  const trendAgg = new Map<string, number>()
  const pageAgg = new Map<string, { sessions: number; users: number }>()

  for (const r of dedupedRows) {
    total += r.sessions
    totalUsers += r.users
    const s = sourceAgg.get(r.source) ?? { sessions: 0, users: 0 }
    s.sessions += r.sessions
    s.users += r.users
    sourceAgg.set(r.source, s)
    trendAgg.set(r.date, (trendAgg.get(r.date) ?? 0) + r.sessions)
    const page = r.landingPageNormalized ?? r.landingPage
    const p = pageAgg.get(page) ?? { sessions: 0, users: 0 }
    p.sessions += r.sessions
    p.users += r.users
    pageAgg.set(page, p)
  }

  const bySource = [...sourceAgg.entries()]
    .map(([source, data]) => ({
      source,
      sessions: data.sessions,
      users: data.users,
      sharePct: total > 0 ? Math.round((data.sessions / total) * 100) : 0,
    }))
    .sort((a, b) => b.sessions - a.sessions)

  const trend = [...trendAgg.entries()]
    .map(([date, sessions]) => ({ date, sessions }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const topLandingPages = [...pageAgg.entries()]
    .map(([page, data]) => ({ page, sessions: data.sessions, users: data.users }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, TOP_AI_REFERRAL_PAGES_LIMIT)

  return { totalSessions: total, totalUsers, bySource, trend, topLandingPages }
}

function buildIndexingHealth(db: DatabaseClient, projectId: string): ProjectReportDto['indexingHealth'] {
  const gsc = db
    .select()
    .from(gscCoverageSnapshots)
    .where(eq(gscCoverageSnapshots.projectId, projectId))
    .orderBy(desc(gscCoverageSnapshots.date))
    .limit(1)
    .get()
  if (gsc) {
    const total = gsc.indexed + gsc.notIndexed
    return {
      provider: 'google',
      total,
      indexed: gsc.indexed,
      notIndexed: gsc.notIndexed,
      deindexed: 0,
      unknown: 0,
      indexedPct: total > 0 ? Math.round((gsc.indexed / total) * 100) : 0,
    }
  }

  const bing = db
    .select()
    .from(bingCoverageSnapshots)
    .where(eq(bingCoverageSnapshots.projectId, projectId))
    .orderBy(desc(bingCoverageSnapshots.date))
    .limit(1)
    .get()
  if (bing) {
    const total = bing.indexed + bing.notIndexed + bing.unknown
    return {
      provider: 'bing',
      total,
      indexed: bing.indexed,
      notIndexed: bing.notIndexed,
      deindexed: 0,
      unknown: bing.unknown,
      indexedPct: total > 0 ? Math.round((bing.indexed / total) * 100) : 0,
    }
  }

  return null
}

function buildCitationsTrend(
  db: DatabaseClient,
  projectId: string,
  queryLookup: QueryLookup,
): CitationsTrendPoint[] {
  const visibilityRuns = db
    .select()
    .from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.kind, RunKinds['answer-visibility'])))
    .all()

  const totalQueries = queryLookup.byId.size
  const points: CitationsTrendPoint[] = []
  for (const run of visibilityRuns) {
    if (run.status !== RunStatuses.completed) continue
    const snaps = loadSnapshotsForRun(db, run.id)
    if (snaps.length === 0) continue

    // Headline rate is per-query (unique queries cited by ≥1 provider divided
    // by total tracked queries) — invariant to provider count so a partial
    // gemini-only run and a full 4-provider run can be compared honestly. See
    // issue #422: per-(query × provider) ballooned the denominator and made
    // real improvements look like declines whenever the provider mix shifted.
    const citedQueryIds = new Set<string>()
    let considered = 0
    const providerCounts = new Map<string, { cited: number; total: number }>()
    for (const snap of snaps) {
      if (!queryLookup.byId.has(snap.queryId)) continue
      considered++
      if (snap.citationState === CitationStates.cited) citedQueryIds.add(snap.queryId)
      const counts = providerCounts.get(snap.provider) ?? { cited: 0, total: 0 }
      counts.total++
      if (snap.citationState === CitationStates.cited) counts.cited++
      providerCounts.set(snap.provider, counts)
    }
    if (considered === 0) continue
    const citedQueryCount = citedQueryIds.size
    const citationRate = totalQueries > 0
      ? Math.round((citedQueryCount / totalQueries) * 100)
      : 0
    const providerRates = [...providerCounts.entries()]
      .map(([provider, counts]) => ({
        provider,
        citationRate: counts.total > 0 ? Math.round((counts.cited / counts.total) * 100) : 0,
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider))

    points.push({
      runId: run.id,
      date: run.finishedAt ?? run.createdAt,
      citationRate,
      citedQueryCount,
      totalQueryCount: totalQueries,
      providerRates,
    })
  }

  points.sort((a, b) => a.date.localeCompare(b.date))
  return points
}

function buildInsightList(db: DatabaseClient, projectId: string): ReportInsight[] {
  // Bound the report to the most recent N answer-visibility runs so stale,
  // long-undismissed insights from months ago don't pile up. Mirrors the
  // recurrence window used in intelligence-service for severity tiering.
  const recentRunIds = db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(runs.kind, RunKinds['answer-visibility']),
        or(eq(runs.status, RunStatuses.completed), eq(runs.status, RunStatuses.partial)),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(INSIGHT_LOOKBACK_RUNS)
    .all()
    .map((r) => r.id)

  if (recentRunIds.length === 0) return []

  const rows = db
    .select()
    .from(insights)
    .where(and(eq(insights.projectId, projectId), inArray(insights.runId, recentRunIds)))
    .orderBy(desc(insights.createdAt))
    .all()

  const severityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
  const flat: Array<ReportInsight & { _sortRank: number }> = rows
    .filter(r => !r.dismissed)
    .map(r => {
      const recommendation = parseJsonColumn<{ action?: string; target?: string; reason?: string } | null>(r.recommendation, null)
      let recText: string | null = null
      if (recommendation) {
        const parts: string[] = []
        if (recommendation.action) parts.push(recommendation.action)
        if (recommendation.target) parts.push(recommendation.target)
        if (recommendation.reason) parts.push(recommendation.reason)
        if (parts.length > 0) recText = parts.join(' — ')
      }
      return {
        id: r.id,
        type: r.type as ReportInsight['type'],
        severity: r.severity as ReportInsight['severity'],
        title: r.title,
        query: r.query,
        provider: r.provider,
        recommendation: recText,
        createdAt: r.createdAt,
        instanceCount: 1,
        _sortRank: severityRank[r.severity] ?? 99,
      }
    })

  // Dedup at the API layer so all consumers — DTO, executive findings, next
  // steps, renderer — see one row per (query, provider, type) tuple.
  // Without this, a regression that fired in three runs would inflate counts
  // in `buildExecutiveFindings` (e.g. "3 critical regressions" when there is
  // really one) and "Resolve 3 critical regressions" in next-steps.
  const groups = groupInsights(flat)
  return groups
    .map((g) => {
      const rep = g.representative
      const rest: ReportInsight = {
        id: rep.id,
        type: rep.type,
        severity: rep.severity,
        title: rep.title,
        query: rep.query,
        provider: rep.provider,
        recommendation: rep.recommendation,
        createdAt: rep.createdAt,
        instanceCount: g.count,
      }
      return { ...rest, _sortRank: rep._sortRank }
    })
    .sort((a, b) => a._sortRank - b._sortRank)
    .map(({ _sortRank: _drop, ...rest }) => rest)
}

function buildRecommendedNextSteps(insightList: ReportInsight[]): RecommendedNextStep[] {
  const steps: RecommendedNextStep[] = []
  const critical = insightList.filter(i => i.severity === 'critical')
  const high = insightList.filter(i => i.severity === 'high')
  const medium = insightList.filter(i => i.severity === 'medium')

  if (critical.length > 0) {
    steps.push({
      horizon: 'immediate',
      title: `Resolve ${critical.length} critical regression${critical.length > 1 ? 's' : ''}`,
      rationale: critical[0]!.title + (critical.length > 1 ? `, plus ${critical.length - 1} more.` : '.'),
    })
  }
  if (high.length > 0) {
    steps.push({
      horizon: 'short-term',
      title: `Address ${high.length} high-severity issue${high.length > 1 ? 's' : ''}`,
      rationale: high[0]!.title + (high.length > 1 ? `, plus ${high.length - 1} more.` : '.'),
    })
  }
  if (medium.length > 0) {
    steps.push({
      horizon: 'medium-term',
      title: `Capture ${medium.length} opportunit${medium.length > 1 ? 'ies' : 'y'}`,
      rationale: medium[0]!.title + (medium.length > 1 ? `, plus ${medium.length - 1} more.` : '.'),
    })
  }
  return steps
}

function buildExecutiveFindings(
  citationRate: number,
  citedQueryCount: number,
  totalQueryCount: number,
  trend: ProjectReportDto['executiveSummary']['trend'],
  trendsPoints: CitationsTrendPoint[],
  trendBaseline: boolean,
  insightList: ReportInsight[],
  competitorRows: CompetitorRow[],
): ProjectReportDto['executiveSummary']['findings'] {
  const findings: ProjectReportDto['executiveSummary']['findings'] = []

  if (trendsPoints.length > 0) {
    const tone = trendBaseline
      ? 'neutral'
      : trend === 'up' ? 'positive' : trend === 'down' ? 'negative' : 'neutral'
    let detail: string
    if (trendBaseline) {
      detail = `Establishing baseline (${trendsPoints.length} of ${MIN_TREND_POINTS} runs collected).`
    } else {
      switch (trend) {
        case 'up': detail = 'Up from the previous run.'; break
        case 'down': detail = 'Down from the previous run.'; break
        case 'flat': detail = 'Flat compared to the previous run.'; break
        case 'unknown': detail = 'No prior run to compare against.'; break
      }
    }
    const queryNoun = totalQueryCount === 1 ? 'query' : 'queries'
    const ratioFragment = totalQueryCount > 0
      ? ` (${citedQueryCount} of ${totalQueryCount} ${queryNoun} cited)`
      : ''
    findings.push({
      title: `Citation rate at ${citationRate}%${ratioFragment}`,
      detail,
      tone,
    })
  }

  const critical = insightList.filter(i => i.severity === 'critical')
  if (critical.length > 0) {
    findings.push({
      title: `${critical.length} critical regression${critical.length > 1 ? 's' : ''}`,
      detail: critical[0]!.title,
      tone: 'negative',
    })
  }

  const highPressure = competitorRows.filter(c => c.pressureLabel === 'High')
  if (highPressure.length > 0) {
    findings.push({
      title: `${highPressure.length} competitor${highPressure.length > 1 ? 's' : ''} cited often`,
      detail: highPressure.map(c => c.domain).slice(0, 3).join(', '),
      tone: 'caution',
    })
  }

  return findings.slice(0, 5)
}

function buildLocationMeta(
  runLocationLabel: string | null | undefined,
  configuredLocations: LocationContext[],
): ProjectReportDto['meta']['location'] {
  if (!runLocationLabel) return null
  // The run carries the label string only; resolve it to the full
  // LocationContext so the report can name the city/region. If the label is
  // unknown (e.g. config was edited after the run) fall back to the label
  // alone — better to show the user what we have than to drop it silently.
  const match = configuredLocations.find(loc => loc.label === runLocationLabel)
  const others = configuredLocations
    .map(loc => loc.label)
    .filter(label => label !== runLocationLabel)
  return {
    label: runLocationLabel,
    city: match?.city ?? '',
    region: match?.region ?? '',
    country: match?.country ?? '',
    otherConfiguredLabels: others,
  }
}

function buildProviderLocationHandling(
  providersInRun: readonly string[],
): ReportProviderLocationHandling[] {
  // Sort alphabetically so the table layout stays stable across runs.
  return [...providersInRun].sort().map(provider => {
    const handling = getProviderLocationHandling(provider)
    return {
      provider,
      treatment: handling.treatment,
      description: handling.description,
    }
  })
}

function buildProjectReport(db: DatabaseClient, projectName: string): ProjectReportDto {
  const project = resolveProject(db, projectName)
  const queryLookup = loadQueryLookup(db, project.id)

  const allRuns = db
    .select()
    .from(runs)
    .where(eq(runs.projectId, project.id))
    .orderBy(desc(runs.createdAt))
    .all()

  const visibilityRuns = allRuns.filter(r => r.kind === RunKinds['answer-visibility'])
  const latestRun = visibilityRuns.find(
    r => r.status === RunStatuses.completed || r.status === RunStatuses.partial,
  ) ?? visibilityRuns[0]
  const latestSnapshots = latestRun ? loadSnapshotsForRun(db, latestRun.id) : []

  const competitorRows = db.select().from(competitors).where(eq(competitors.projectId, project.id)).all()
  const competitorDomains = competitorRows.map(c => c.domain)

  // Treat ownedDomains the same way determineCitationState does — anything
  // matching the canonical domain or an owned subdomain counts as "ours".
  const ownedDomains = parseJsonColumn<string[]>(project.ownedDomains, [])
  const projectDomains = [project.canonicalDomain, ...ownedDomains]

  const citationScorecard = buildCitationScorecard(latestSnapshots, queryLookup)
  const competitorLandscape = buildCompetitorLandscape(
    latestSnapshots,
    competitorDomains,
    projectDomains,
    queryLookup,
  )
  const mentionLandscape = buildMentionLandscape(
    latestSnapshots,
    competitorDomains,
    project.displayName,
    projectDomains,
    queryLookup,
  )
  const aiSourceOrigin = buildAiSourceOrigin(latestSnapshots, projectDomains, competitorDomains)
  const trackedQueries = [...queryLookup.byId.values()]
  const gscSection = buildGscSection(
    db,
    project.id,
    project.displayName,
    project.canonicalDomain,
    trackedQueries,
  )
  const gaSection = buildGaSection(db, project.id)
  const socialSection = buildSocialReferrals(db, project.id)
  const aiReferralsSection = buildAiReferrals(db, project.id)
  const indexingHealthSection = buildIndexingHealth(db, project.id)
  const citationsTrend = buildCitationsTrend(db, project.id, queryLookup)
  const insightList = buildInsightList(db, project.id)

  const orchestratorInput = loadOrchestratorInput(db, project)
  const contentOpportunities = buildContentTargetRows(orchestratorInput)
  const contentGaps = buildContentGapRows(orchestratorInput)
  const groundingSources = buildContentSourceRows(orchestratorInput)

  const insightDerivedSteps = buildRecommendedNextSteps(insightList)
  const recommendedNextSteps = mapOpportunitiesToNextSteps(
    contentOpportunities,
    insightDerivedSteps,
  )

  // Headline rate is per-query — see buildCitationsTrend for the rationale.
  // Same definition both places so the trend chart and the executive summary
  // KPI move together; using different denominators in the two surfaces is
  // how issue #422 originally manifested.
  const totalQueryCount = queryLookup.byId.size
  const citedQueryIds = new Set<string>()
  for (const snap of latestSnapshots) {
    if (!queryLookup.byId.has(snap.queryId)) continue
    if (snap.citationState === CitationStates.cited) citedQueryIds.add(snap.queryId)
  }
  const citedQueryCount = citedQueryIds.size
  const citationRate = totalQueryCount > 0
    ? Math.round((citedQueryCount / totalQueryCount) * 100)
    : 0

  // Suppress trend computation until enough runs exist — a 5%→1% delta on
  // N=2 reads as a crisis to a non-analyst reader but is pure noise on a
  // sample of two. Same gate the renderer uses on the line chart so every
  // surface (CLI, Aero, dashboard) stays consistent.
  const trendBaseline = isTrendBaseline(citationsTrend)
  const latestPoint = citationsTrend.at(-1)
  const previousPoint = citationsTrend.length >= 2 ? citationsTrend.at(-2) : null
  // When latestRun is `partial`, it's excluded from citationsTrend
  // (buildCitationsTrend filters to completed runs only) but its rate
  // still drives `citationRate` above. Compare the headline number
  // against the most recent completed point so the trend label tracks
  // the user-visible direction; otherwise fall back to the standard
  // last-vs-prior comparison between two trend points.
  let trend: ProjectReportDto['executiveSummary']['trend'] = 'unknown'
  if (!trendBaseline && latestPoint) {
    const latestRunOnTrend = latestRun?.id === latestPoint.runId
    const currentRate = latestRunOnTrend ? latestPoint.citationRate : citationRate
    const priorRate = latestRunOnTrend ? previousPoint?.citationRate : latestPoint.citationRate
    if (priorRate !== undefined) {
      if (currentRate > priorRate) trend = 'up'
      else if (currentRate < priorRate) trend = 'down'
      else trend = 'flat'
    }
  }

  const findings = buildExecutiveFindings(
    citationRate,
    citedQueryCount,
    totalQueryCount,
    trend,
    citationsTrend,
    trendBaseline,
    insightList,
    competitorLandscape.competitors,
  )

  const periodStart = citationsTrend[0]?.date ?? null
  const periodEnd = citationsTrend.at(-1)?.date ?? null

  const configuredLocations = parseJsonColumn<LocationContext[]>(project.locations, [])
  const reportLocation = buildLocationMeta(latestRun?.location ?? null, configuredLocations)
  const providerLocationHandling = buildProviderLocationHandling(citationScorecard.providers)

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      project: {
        id: project.id,
        name: project.name,
        displayName: project.displayName,
        canonicalDomain: project.canonicalDomain,
        country: project.country,
        language: project.language,
      },
      location: reportLocation,
      providerLocationHandling,
      periodStart,
      periodEnd,
    },
    executiveSummary: {
      citationRate,
      citedQueryCount,
      totalQueryCount,
      trend,
      queryCount: queryLookup.byId.size,
      competitorCount: competitorDomains.length,
      providerCount: citationScorecard.providers.length,
      gsc: gscSection
        ? {
            clicks: gscSection.totalClicks,
            impressions: gscSection.totalImpressions,
            ctr: gscSection.ctr,
            avgPosition: gscSection.avgPosition,
          }
        : null,
      ga: gaSection
        ? {
            sessions: gaSection.totalSessions,
            users: gaSection.totalUsers,
            periodStart: gaSection.periodStart,
            periodEnd: gaSection.periodEnd,
          }
        : null,
      findings,
    },
    citationScorecard,
    competitorLandscape,
    mentionLandscape,
    aiSourceOrigin,
    gsc: gscSection,
    ga: gaSection,
    socialReferrals: socialSection,
    aiReferrals: aiReferralsSection,
    indexingHealth: indexingHealthSection,
    citationsTrend,
    insights: insightList,
    recommendedNextSteps,
    contentOpportunities,
    contentGaps,
    groundingSources,
  }
}

function reportFilenameFor(project: ProjectReportDto['meta']['project'], generatedAt: string): string {
  const date = generatedAt.slice(0, 10)
  return `canonry-report-${project.name}-${date}.html`
}

export async function reportRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string } }>('/projects/:name/report', async (request, reply) => {
    const dto = buildProjectReport(app.db, request.params.name)
    return reply.send(dto)
  })

  app.get<{ Params: { name: string } }>('/projects/:name/report.html', async (request, reply) => {
    const dto = buildProjectReport(app.db, request.params.name)
    const html = renderReportHtml(dto)
    const filename = reportFilenameFor(dto.meta.project, dto.meta.generatedAt)
    reply.header('Content-Type', 'text/html; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(html)
  })
}
