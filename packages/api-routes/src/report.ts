import { and, desc, eq } from 'drizzle-orm'
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
  keywords,
  parseJsonColumn,
  querySnapshots,
  runs,
} from '@ainyc/canonry-db'
import {
  categorizeSource,
  normalizeProjectDomain,
  RunKinds,
  RunStatuses,
  type AiSourceCategoryBucket,
  type CitationCell,
  type CitationsTrendPoint,
  type CompetitorRow,
  type GscQueryRow,
  type ProjectReportDto,
  type RecommendedNextStep,
  type ReportInsight,
  type SocialReferralSection,
} from '@ainyc/canonry-contracts'
import { resolveProject } from './helpers.js'
import type { DatabaseClient } from '@ainyc/canonry-db'

const TOP_QUERIES_LIMIT = 20
const TOP_LANDING_PAGES_LIMIT = 20
const TOP_AI_REFERRAL_PAGES_LIMIT = 10
const TOP_SOURCE_DOMAINS_LIMIT = 20
const TOP_CAMPAIGN_LIMIT = 10

function safeNum(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function rootDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '')
}

// Mirrors `domainMatches` in packages/canonry/src/citation-utils.ts (which
// determineCitationState uses) — kept duplicated to respect the api-routes →
// canonry dependency boundary. Whenever determineCitationState's matching
// rules change, update this in lockstep.
function citedDomainBelongsToProject(citedDomain: string, projectDomains: string[]): boolean {
  const candidate = normalizeProjectDomain(citedDomain)
  for (const domain of projectDomains) {
    const normalized = normalizeProjectDomain(domain)
    if (candidate === normalized || candidate.endsWith(`.${normalized}`)) return true
  }
  return false
}

function categorizeQuery(query: string, projectName: string, canonicalDomain: string): GscQueryRow['category'] {
  const lower = query.toLowerCase()
  const projectTokens = [
    projectName.toLowerCase(),
    canonicalDomain.toLowerCase().replace(/\.[^.]+$/, ''),
  ].filter(t => t.length >= 3)
  if (projectTokens.some(token => lower.includes(token))) return 'brand'
  if (/\b(buy|price|pricing|cost|hire|near me|services?|agency|consultant|company)\b/.test(lower)) {
    return 'lead-gen'
  }
  if (/\b(what|how|why|when|guide|tutorial|vs|versus|alternatives?|examples?|definition)\b/.test(lower)) {
    return 'industry'
  }
  return 'other'
}

interface SnapshotRow {
  id: string
  runId: string
  keywordId: string
  provider: string
  model: string | null
  citationState: string
  answerMentioned: boolean | null
  answerText: string | null
  citedDomains: string[]
  competitorOverlap: string[]
  createdAt: string
}

function loadSnapshotsForRun(db: DatabaseClient, runId: string): SnapshotRow[] {
  const rows = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
  return rows.map(r => ({
    id: r.id,
    runId: r.runId,
    keywordId: r.keywordId,
    provider: r.provider,
    model: r.model,
    citationState: r.citationState,
    answerMentioned: r.answerMentioned,
    answerText: r.answerText,
    citedDomains: parseJsonColumn<string[]>(r.citedDomains, []),
    competitorOverlap: parseJsonColumn<string[]>(r.competitorOverlap, []),
    createdAt: r.createdAt,
  }))
}

interface KeywordLookup {
  byId: Map<string, string>
}

function loadKeywordLookup(db: DatabaseClient, projectId: string): KeywordLookup {
  const rows = db.select().from(keywords).where(eq(keywords.projectId, projectId)).all()
  const byId = new Map<string, string>()
  for (const row of rows) byId.set(row.id, row.keyword)
  return { byId }
}

function buildCitationScorecard(
  snapshots: SnapshotRow[],
  keywordLookup: KeywordLookup,
): ProjectReportDto['citationScorecard'] {
  if (snapshots.length === 0) {
    return { keywords: [], providers: [], matrix: [], providerRates: [] }
  }

  const keywordSet = new Set<string>()
  const providerSet = new Set<string>()
  for (const snap of snapshots) {
    const kw = keywordLookup.byId.get(snap.keywordId)
    if (!kw) continue
    keywordSet.add(kw)
    providerSet.add(snap.provider)
  }
  const keywordList = [...keywordSet].sort()
  const providerList = [...providerSet].sort()

  const matrix: Array<Array<CitationCell | null>> = keywordList.map(() =>
    providerList.map(() => null),
  )
  const providerCounts = new Map<string, { cited: number; total: number }>()

  for (const snap of snapshots) {
    const kw = keywordLookup.byId.get(snap.keywordId)
    if (!kw) continue
    const ki = keywordList.indexOf(kw)
    const pi = providerList.indexOf(snap.provider)
    if (ki < 0 || pi < 0) continue
    matrix[ki]![pi] = {
      citationState: snap.citationState === 'cited' ? 'cited' : 'not-cited',
      answerMentioned: snap.answerMentioned ?? null,
      model: snap.model,
    }
    const counts = providerCounts.get(snap.provider) ?? { cited: 0, total: 0 }
    counts.total++
    if (snap.citationState === 'cited') counts.cited++
    providerCounts.set(snap.provider, counts)
  }

  const providerRates = providerList.map(provider => {
    const counts = providerCounts.get(provider) ?? { cited: 0, total: 0 }
    const citationRate = counts.total > 0 ? Math.round((counts.cited / counts.total) * 100) : 0
    return {
      provider,
      citedCount: counts.cited,
      totalCount: counts.total,
      citationRate,
    }
  })

  return { keywords: keywordList, providers: providerList, matrix, providerRates }
}

function buildCompetitorLandscape(
  snapshots: SnapshotRow[],
  competitorDomains: string[],
  projectDomains: string[],
  keywordLookup: KeywordLookup,
): ProjectReportDto['competitorLandscape'] {
  let projectCitationCount = 0
  const competitorMap = new Map<string, { count: number; keywords: Set<string> }>()
  for (const c of competitorDomains) competitorMap.set(c, { count: 0, keywords: new Set() })

  for (const snap of snapshots) {
    const kw = keywordLookup.byId.get(snap.keywordId)
    const allDomains = [...snap.citedDomains, ...snap.competitorOverlap]
    if (allDomains.some(d => citedDomainBelongsToProject(d, projectDomains))) {
      projectCitationCount++
    }

    for (const competitor of competitorDomains) {
      if (allDomains.some(d => citedDomainBelongsToProject(d, [competitor]))) {
        const entry = competitorMap.get(competitor)!
        entry.count++
        if (kw) entry.keywords.add(kw)
      }
    }
  }

  const competitorRows: CompetitorRow[] = [...competitorMap.entries()].map(([domain, data]) => {
    const total = snapshots.length
    const ratio = total > 0 ? data.count / total : 0
    let pressureLabel: CompetitorRow['pressureLabel'] = 'None'
    if (data.count > 0) {
      if (ratio >= 0.5) pressureLabel = 'High'
      else if (ratio >= 0.2) pressureLabel = 'Moderate'
      else pressureLabel = 'Low'
    }
    return {
      domain,
      citationCount: data.count,
      totalCount: total,
      pressureLabel,
      citedKeywords: [...data.keywords].sort(),
    }
  })

  competitorRows.sort((a, b) => b.citationCount - a.citationCount)

  return { projectCitationCount, competitors: competitorRows }
}

function buildAiSourceOrigin(
  snapshots: SnapshotRow[],
  projectDomains: string[],
  competitorDomains: string[],
): ProjectReportDto['aiSourceOrigin'] {
  const competitorRoots = new Set(competitorDomains.map(rootDomain))
  const categoryCounts = new Map<string, { label: string; count: number }>()
  const domainCounts = new Map<string, number>()
  let totalCitations = 0

  for (const snap of snapshots) {
    for (const raw of snap.citedDomains) {
      if (citedDomainBelongsToProject(raw, projectDomains)) continue
      const { category, label, domain } = categorizeSource(raw)
      const cat = categoryCounts.get(category) ?? { label, count: 0 }
      cat.count++
      categoryCounts.set(category, cat)
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1)
      totalCitations++
    }
  }

  const categories: AiSourceCategoryBucket[] = [...categoryCounts.entries()]
    .map(([category, { label, count }]) => ({
      category,
      label,
      count,
      sharePct: totalCitations > 0 ? Math.round((count / totalCitations) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count)

  const topDomains = [...domainCounts.entries()]
    .map(([domain, count]) => ({
      domain,
      count,
      isCompetitor: competitorRoots.has(rootDomain(domain)),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_SOURCE_DOMAINS_LIMIT)

  return { categories, topDomains }
}

function buildGscSection(
  db: DatabaseClient,
  projectId: string,
  projectName: string,
  canonicalDomain: string,
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
      category: categorizeQuery(query, projectName, canonicalDomain),
    }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, TOP_QUERIES_LIMIT)

  const categoryAgg = new Map<GscQueryRow['category'], { clicks: number; impressions: number }>()
  for (const [query, agg] of queryAgg) {
    const cat = categorizeQuery(query, projectName, canonicalDomain)
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

  return {
    totalClicks,
    totalImpressions,
    ctr,
    avgPosition,
    topQueries,
    categoryBreakdown,
    trend,
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
  keywordLookup: KeywordLookup,
): CitationsTrendPoint[] {
  const visibilityRuns = db
    .select()
    .from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.kind, RunKinds['answer-visibility'])))
    .all()

  const points: CitationsTrendPoint[] = []
  for (const run of visibilityRuns) {
    if (run.status !== RunStatuses.completed) continue
    const snaps = loadSnapshotsForRun(db, run.id)
    if (snaps.length === 0) continue

    let cited = 0
    let considered = 0
    const providerCounts = new Map<string, { cited: number; total: number }>()
    for (const snap of snaps) {
      if (!keywordLookup.byId.has(snap.keywordId)) continue
      considered++
      if (snap.citationState === 'cited') cited++
      const counts = providerCounts.get(snap.provider) ?? { cited: 0, total: 0 }
      counts.total++
      if (snap.citationState === 'cited') counts.cited++
      providerCounts.set(snap.provider, counts)
    }
    if (considered === 0) continue
    const citationRate = Math.round((cited / considered) * 100)
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
      providerRates,
    })
  }

  points.sort((a, b) => a.date.localeCompare(b.date))
  return points
}

function buildInsightList(db: DatabaseClient, projectId: string): ReportInsight[] {
  const rows = db
    .select()
    .from(insights)
    .where(eq(insights.projectId, projectId))
    .orderBy(desc(insights.createdAt))
    .all()

  const severityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
  return rows
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
        keyword: r.keyword,
        provider: r.provider,
        recommendation: recText,
        createdAt: r.createdAt,
      }
    })
    .sort((a, b) => severityRank[a.severity]! - severityRank[b.severity]!)
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
  trend: ProjectReportDto['executiveSummary']['trend'],
  trendsPoints: CitationsTrendPoint[],
  insightList: ReportInsight[],
  competitorRows: CompetitorRow[],
): ProjectReportDto['executiveSummary']['findings'] {
  const findings: ProjectReportDto['executiveSummary']['findings'] = []

  if (trendsPoints.length > 0) {
    const tone = trend === 'up' ? 'positive' : trend === 'down' ? 'negative' : 'neutral'
    let detail: string
    switch (trend) {
      case 'up': detail = 'Up from the previous run.'; break
      case 'down': detail = 'Down from the previous run.'; break
      case 'flat': detail = 'Flat compared to the previous run.'; break
      case 'unknown': detail = 'No prior run to compare against.'; break
    }
    findings.push({
      title: `Citation rate at ${citationRate}%`,
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

export async function reportRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string } }>('/projects/:name/report', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const keywordLookup = loadKeywordLookup(app.db, project.id)

    const allRuns = app.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, project.id))
      .orderBy(desc(runs.createdAt))
      .all()

    const visibilityRuns = allRuns.filter(r => r.kind === RunKinds['answer-visibility'])
    const latestRun = visibilityRuns.find(
      r => r.status === RunStatuses.completed || r.status === RunStatuses.partial,
    ) ?? visibilityRuns[0]
    const latestSnapshots = latestRun ? loadSnapshotsForRun(app.db, latestRun.id) : []

    const competitorRows = app.db.select().from(competitors).where(eq(competitors.projectId, project.id)).all()
    const competitorDomains = competitorRows.map(c => c.domain)

    // Treat ownedDomains the same way determineCitationState does — anything
    // matching the canonical domain or an owned subdomain counts as "ours".
    const ownedDomains = parseJsonColumn<string[]>(project.ownedDomains, [])
    const projectDomains = [project.canonicalDomain, ...ownedDomains]

    const citationScorecard = buildCitationScorecard(latestSnapshots, keywordLookup)
    const competitorLandscape = buildCompetitorLandscape(
      latestSnapshots,
      competitorDomains,
      projectDomains,
      keywordLookup,
    )
    const aiSourceOrigin = buildAiSourceOrigin(latestSnapshots, projectDomains, competitorDomains)
    const gscSection = buildGscSection(app.db, project.id, project.name, project.canonicalDomain)
    const gaSection = buildGaSection(app.db, project.id)
    const socialSection = buildSocialReferrals(app.db, project.id)
    const aiReferralsSection = buildAiReferrals(app.db, project.id)
    const indexingHealthSection = buildIndexingHealth(app.db, project.id)
    const citationsTrend = buildCitationsTrend(app.db, project.id, keywordLookup)
    const insightList = buildInsightList(app.db, project.id)
    const recommendedNextSteps = buildRecommendedNextSteps(insightList)

    let latestCited = 0
    let latestConsidered = 0
    for (const snap of latestSnapshots) {
      if (!keywordLookup.byId.has(snap.keywordId)) continue
      latestConsidered++
      if (snap.citationState === 'cited') latestCited++
    }
    const citationRate = latestConsidered > 0
      ? Math.round((latestCited / latestConsidered) * 100)
      : 0

    const latestPoint = citationsTrend.at(-1)
    const previousPoint = citationsTrend.length >= 2 ? citationsTrend.at(-2) : null
    let trend: ProjectReportDto['executiveSummary']['trend'] = 'unknown'
    if (latestPoint && previousPoint) {
      if (latestPoint.citationRate > previousPoint.citationRate) trend = 'up'
      else if (latestPoint.citationRate < previousPoint.citationRate) trend = 'down'
      else trend = 'flat'
    }

    const findings = buildExecutiveFindings(
      citationRate,
      trend,
      citationsTrend,
      insightList,
      competitorLandscape.competitors,
    )

    const periodStart = citationsTrend[0]?.date ?? null
    const periodEnd = citationsTrend.at(-1)?.date ?? null

    const dto: ProjectReportDto = {
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
        periodStart,
        periodEnd,
      },
      executiveSummary: {
        citationRate,
        trend,
        keywordCount: keywordLookup.byId.size,
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
      aiSourceOrigin,
      gsc: gscSection,
      ga: gaSection,
      socialReferrals: socialSection,
      aiReferrals: aiReferralsSection,
      indexingHealth: indexingHealthSection,
      citationsTrend,
      insights: insightList,
      recommendedNextSteps,
    }

    return reply.send(dto)
  })
}
