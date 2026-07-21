import { and, desc, eq, gte, inArray, lt, lte, ne, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  aiReferralEventsHourly,
  aiUserFetchEventsHourly,
  bingCoverageSnapshots,
  competitors,
  crawlerEventsHourly,
  gaAiReferrals,
  gaSocialReferrals,
  gaTrafficSnapshots,
  gaTrafficSummaries,
  gaTrafficWindowSummaries,
  groupRunsByCreatedAt,
  gscCoverageSnapshots,
  gscSearchData,
  insights,
  pickGroupRepresentative,
  queries,
  querySnapshots,
  runs,
  trafficSources,
} from '@ainyc/canonry-db'
import {
  CitationStates,
  AiReferralTrafficClasses,
  aiReferralClassCounts,
  formatAiReferralClassSummary,
  RunKinds,
  RunStatuses,
  TrafficSourceStatuses,
  VerificationStatuses,
  deltaPercent,
  effectiveBrandNames,
  getProviderLocationHandling,
  parseReportPeriodDays,
  reportComparisonWindowDays,
  validationError,
  type CitationsTrendPoint,
  type CompetitorRow,
  type GscQueryRow,
  type LocationContext,
  type ProjectReportDto,
  type RecommendedNextStep,
  type ReportActionPlanItem,
  type ReportAudience,
  type ReportInsight,
  type ReportProviderLocationHandling,
  type ReportProviderMovement,
  type ReportRateDelta,
  type SocialReferralSection,
  type WhatsChangedSection,
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
  smoothedRunDelta,
} from '@ainyc/canonry-intelligence'
import { loadDismissedTargetRefs } from './content.js'
import { mergeGscDailyTotalsWithFallback, mergeGscQueryTotalsWithFallback, readGscDailyTotals, readGscQueryTotals } from './gsc-totals.js'
import { notProbeRun, resolveProject } from './helpers.js'
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
const SERVER_ACTIVITY_TOP_PATHS_LIMIT = 10
// GA4 precomputes deduplicated window summaries only for these keys; any other
// requested window falls back to summing per-page snapshots.
const GA_WINDOW_SUMMARY_KEYS: Record<number, string> = { 7: '7d', 30: '30d', 90: '90d' }

// Returns the inclusive start-date string (YYYY-MM-DD) for a window of
// `windowDays` ending on `endDate`. `endDate` must already be YYYY-MM-DD.
function windowStartDate(endDate: string, windowDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDate)
  if (!m) return endDate
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  d.setUTCDate(d.getUTCDate() - (windowDays - 1))
  return d.toISOString().slice(0, 10)
}

function safeNum(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function isPaidAiTrafficClass(value: string | null | undefined): boolean {
  return value === AiReferralTrafficClasses.paid
}

// Thin wrapper around the shared intelligence-package categorizer.
// Encapsulates brand-token construction so the existing buildGscSection
// call sites don't all need to thread brandTokens through. The display
// name plus aliases are preferred over the project slug because the slug
// is internal (e.g. "acme-corp") while the display name and aliases match
// what searchers actually type.
function categorizeQuery(query: string, projectBrandNames: readonly string[], canonicalDomain: string): GscQueryRow['category'] {
  return categorizeQueryByIntent(query, buildBrandTokens(canonicalDomain, projectBrandNames))
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
  return loadSnapshotsForRunIds(db, [runId])
}

/**
 * Batched version of `loadSnapshotsForRun` — single SQL query for multiple
 * run IDs. Used by the multi-location fan-out aggregation in the report
 * builder so an N-location sweep doesn't fan out into N DB round-trips.
 */
function loadSnapshotsForRunIds(db: DatabaseClient, runIds: readonly string[]): SnapshotRow[] {
  if (runIds.length === 0) return []
  const rows = db
    .select()
    .from(querySnapshots)
    .where(inArray(querySnapshots.runId, [...runIds]))
    .all()
  // Skip orphan snapshots (query_id NULL because the tracked query was
  // deleted post-v58). The report groups by query; an orphan can't be
  // slotted and would collide with every other orphan under a null key.
  // A future "deleted-query audit" view can opt in via `queryText`.
  return rows
    .filter(r => r.queryId !== null)
    .map(r => ({
      id: r.id,
      runId: r.runId,
      queryId: r.queryId as string,
      provider: r.provider,
      model: r.model,
      citationState: r.citationState,
      answerMentioned: r.answerMentioned,
      answerText: r.answerText,
      citedDomains: r.citedDomains,
      competitorOverlap: r.competitorOverlap,
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
  projectBrandNames: readonly string[],
  canonicalDomain: string,
  trackedQueries: string[],
  windowDays: number,
): ProjectReportDto['gsc'] {
  const allRows = db.select().from(gscSearchData).where(eq(gscSearchData.projectId, projectId)).all()
  const allDailyTotals = readGscDailyTotals(db, projectId, '', '9999-12-31')

  // Constrain to the most recent `windowDays` of data so the GSC section
  // aligns with the GA section. GSC retains up to 16 months, but the report
  // only ever shows the selected window. Anchor on the latest date in the
  // dataset rather than "today" — when GSC sync is a few days behind the
  // report should still cover a full window of real data.
  let maxDate = ''
  for (const r of allRows) if (r.date > maxDate) maxDate = r.date
  for (const r of allDailyTotals) if (r.date > maxDate) maxDate = r.date
  if (!maxDate) return null

  const startDate = windowStartDate(maxDate, windowDays)
  const rows = allRows.filter(r => r.date >= startDate && r.date <= maxDate)
  const dailyTotals = allDailyTotals.filter(r => r.date >= startDate && r.date <= maxDate)
  if (rows.length === 0 && dailyTotals.length === 0) return null

  // Per-query / per-page aggregation stays on the dimensioned rows — these
  // breakdowns are correct from `gsc_search_data`. The grand totals and daily
  // trend prefer property-level rows per date, falling back to dimensioned rows
  // for dates not yet covered by the new table.
  let dimensionedClicks = 0
  const queryAgg = new Map<string, { clicks: number; impressions: number; weightedPositionSum: number }>()
  const dimensionedTrendAgg = new Map<string, { clicks: number; impressions: number; weightedPositionSum: number }>()

  for (const r of rows) {
    dimensionedClicks += r.clicks
    const q = queryAgg.get(r.query) ?? { clicks: 0, impressions: 0, weightedPositionSum: 0 }
    q.clicks += r.clicks
    q.impressions += r.impressions
    q.weightedPositionSum += safeNum(r.position) * r.impressions
    queryAgg.set(r.query, q)

    const t = dimensionedTrendAgg.get(r.date) ?? { clicks: 0, impressions: 0, weightedPositionSum: 0 }
    t.clicks += r.clicks
    t.impressions += r.impressions
    t.weightedPositionSum += safeNum(r.position) * r.impressions
    dimensionedTrendAgg.set(r.date, t)
  }

  const dailySeries = mergeGscDailyTotalsWithFallback(
    dailyTotals,
    [...dimensionedTrendAgg.entries()].map(([date, agg]) => ({
      date,
      clicks: agg.clicks,
      impressions: agg.impressions,
      position: agg.impressions > 0 ? agg.weightedPositionSum / agg.impressions : 0,
    })),
  )

  let totalClicks = 0
  let totalImpressions = 0
  let weightedPositionSum = 0
  for (const d of dailySeries) {
    totalClicks += d.clicks
    totalImpressions += d.impressions
    weightedPositionSum += d.position * d.impressions
  }
  const trend = dailySeries.map(d => ({ date: d.date, clicks: d.clicks, impressions: d.impressions }))

  const ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0
  const avgPosition = totalImpressions > 0 ? weightedPositionSum / totalImpressions : 0

  // Per-query figures prefer Google's own un-dimensioned `['date','query']`
  // rows. Summing `gsc_search_data` by query fans one SERP into one row per
  // ranking page, which inflates impressions (~0% for a single-page query,
  // ~500% for brand+category terms where several pages rank together) and so
  // understates the derived CTR against real clicks. Clicks themselves are
  // additive across pages, which is why the click ordering below was already
  // right; impressions, CTR and position were not.
  const queryTotals = mergeGscQueryTotalsWithFallback(
    readGscQueryTotals(db, projectId, startDate, maxDate),
    [...queryAgg.entries()].map(([query, agg]) => ({
      query,
      clicks: agg.clicks,
      impressions: agg.impressions,
      position: agg.impressions > 0 ? agg.weightedPositionSum / agg.impressions : 0,
    })),
  )

  const topQueries: GscQueryRow[] = queryTotals
    .map((agg) => ({
      query: agg.query,
      clicks: agg.clicks,
      impressions: agg.impressions,
      ctr: agg.impressions > 0 ? agg.clicks / agg.impressions : 0,
      avgPosition: agg.position,
      category: categorizeQuery(agg.query, projectBrandNames, canonicalDomain),
    }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, TOP_QUERIES_LIMIT)

  // Built from the same per-query source as `topQueries` so the two agree.
  // Impressions here are a sum ACROSS queries, which is legitimate: distinct
  // queries are disjoint (one SERP belongs to one query), unlike the pages
  // within a query.
  const categoryAgg = new Map<GscQueryRow['category'], { clicks: number; impressions: number }>()
  for (const agg of queryTotals) {
    const cat = categorizeQuery(agg.query, projectBrandNames, canonicalDomain)
    const bucket = categoryAgg.get(cat) ?? { clicks: 0, impressions: 0 }
    bucket.clicks += agg.clicks
    bucket.impressions += agg.impressions
    categoryAgg.set(cat, bucket)
  }
  // Share is computed against the dimensioned click sum (the same source the
  // per-category clicks come from) so the category shares stay internally
  // consistent — the property total above is a different denominator.
  const categoryBreakdown = [...categoryAgg.entries()].map(([category, agg]) => ({
    category,
    clicks: agg.clicks,
    impressions: agg.impressions,
    sharePct: dimensionedClicks > 0 ? Math.round((agg.clicks / dimensionedClicks) * 100) : 0,
  })).sort((a, b) => b.clicks - a.clicks)

  const periodStart = trend[0]?.date ?? ''
  const periodEnd = trend.at(-1)?.date ?? ''

  const trackedSet = new Set(trackedQueries.map(q => q.toLowerCase()))
  const gscQuerySet = new Set([...queryAgg.keys()].map(q => q.toLowerCase()))
  const trackedButNoGsc = trackedQueries.filter(q => !gscQuerySet.has(q.toLowerCase())).sort()
  // Surface brand-free candidates only — brand queries already convert
  // regardless of AEO tracking, so they're not actionable additions to
  // the project query set.
  const gscButNotTracked = [...queryAgg.entries()]
    .filter(([q]) => !trackedSet.has(q.toLowerCase()))
    .filter(([q]) => categorizeQuery(q, projectBrandNames, canonicalDomain) !== 'brand')
    .sort((a, b) => b[1].impressions - a[1].impressions)
    .map(([q]) => q)
    .slice(0, TOP_QUERIES_LIMIT)

  return {
    periodStart,
    periodEnd,
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

function buildGaSection(db: DatabaseClient, projectId: string, windowDays: number): ProjectReportDto['ga'] {
  // Prefer the dedicated window summary whose key matches the requested window
  // so totalUsers reflects the deduplicated count from GA4 (summing per-page
  // snapshots overcounts users who landed on multiple pages — that's exactly
  // what this table fixes). GA4 precomputes 7d/30d/90d only; any other window
  // (e.g. 14d) has no summary and falls back to the snapshot sums below.
  const gaWindowKey = GA_WINDOW_SUMMARY_KEYS[windowDays]
  const windowSummary = gaWindowKey
    ? db
        .select()
        .from(gaTrafficWindowSummaries)
        .where(
          and(
            eq(gaTrafficWindowSummaries.projectId, projectId),
            eq(gaTrafficWindowSummaries.windowKey, gaWindowKey),
          ),
        )
        .limit(1)
        .get()
    : undefined

  // Fallback when window summaries haven't been backfilled yet — the older
  // gaTrafficSummaries table still holds aggregate totals.
  const fallbackSummary = windowSummary
    ? null
    : db
        .select()
        .from(gaTrafficSummaries)
        .where(eq(gaTrafficSummaries.projectId, projectId))
        .orderBy(desc(gaTrafficSummaries.syncedAt))
        .limit(1)
        .get()

  const allSnapshotRows = db
    .select()
    .from(gaTrafficSnapshots)
    .where(eq(gaTrafficSnapshots.projectId, projectId))
    .all()

  if (!windowSummary && !fallbackSummary && allSnapshotRows.length === 0) return null

  // Match the GSC section: filter per-page snapshots to the most recent
  // `windowDays` so the landing-page table and channel mix describe the same
  // window the headline totals do.
  let snapshotMaxDate = ''
  for (const r of allSnapshotRows) if (r.date > snapshotMaxDate) snapshotMaxDate = r.date
  const snapshotStartDate = snapshotMaxDate ? windowStartDate(snapshotMaxDate, windowDays) : ''
  const snapshotRows = snapshotStartDate
    ? allSnapshotRows.filter(r => r.date >= snapshotStartDate && r.date <= snapshotMaxDate)
    : allSnapshotRows

  const totalSessions = windowSummary?.totalSessions
    ?? fallbackSummary?.totalSessions
    ?? snapshotRows.reduce((s, r) => s + r.sessions, 0)
  const totalUsers = windowSummary?.totalUsers
    ?? fallbackSummary?.totalUsers
    ?? snapshotRows.reduce((s, r) => s + r.users, 0)
  const totalOrganicSessions = windowSummary?.totalOrganicSessions
    ?? fallbackSummary?.totalOrganicSessions
    ?? snapshotRows.reduce((s, r) => s + r.organicSessions, 0)

  const pageAgg = new Map<string, { sessions: number; users: number; organic: number }>()
  let directSessions = windowSummary?.totalDirectSessions ?? 0
  for (const r of snapshotRows) {
    const page = r.landingPageNormalized ?? r.landingPage
    const existing = pageAgg.get(page) ?? { sessions: 0, users: 0, organic: 0 }
    existing.sessions += r.sessions
    existing.users += r.users
    existing.organic += r.organicSessions
    pageAgg.set(page, existing)
    if (!windowSummary && r.directSessions != null) directSessions += r.directSessions
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

  const aiConditions = [
    eq(gaAiReferrals.projectId, projectId),
    eq(gaAiReferrals.sourceDimension, 'session'),
  ]
  if (snapshotStartDate && snapshotMaxDate) {
    aiConditions.push(gte(gaAiReferrals.date, snapshotStartDate))
    aiConditions.push(lte(gaAiReferrals.date, snapshotMaxDate))
  }
  const aiSessionRows = db
    .select({
      trafficClass: gaAiReferrals.trafficClass,
      channelGroup: gaAiReferrals.channelGroup,
      sessions: sql<number>`COALESCE(SUM(${gaAiReferrals.sessions}), 0)`,
    })
    .from(gaAiReferrals)
    .where(and(...aiConditions))
    .groupBy(gaAiReferrals.trafficClass, gaAiReferrals.channelGroup)
    .all()

  let paidAiSessions = 0
  let organicAiSessions = 0
  let aiOrganicOverlap = 0
  let aiDirectOverlap = 0
  for (const row of aiSessionRows) {
    const sessions = Number(row.sessions ?? 0)
    if (isPaidAiTrafficClass(row.trafficClass)) paidAiSessions += sessions
    else organicAiSessions += sessions
    if (row.channelGroup === 'Organic Search') aiOrganicOverlap += sessions
    if (row.channelGroup === 'Direct') aiDirectOverlap += sessions
  }

  const channelBreakdown: ProjectReportDto['ga'] extends infer T
    ? T extends { channelBreakdown: infer C } ? C : never : never = []
  if (totalSessions > 0) {
    const organic = Math.max(0, totalOrganicSessions - Math.min(totalOrganicSessions, aiOrganicOverlap))
    const direct = Math.max(0, directSessions - Math.min(directSessions, aiDirectOverlap))
    const other = Math.max(totalSessions - organic - direct - paidAiSessions - organicAiSessions, 0)
    const buckets: Array<{ channel: string; sessions: number }> = [
      { channel: 'Organic Search', sessions: organic },
      { channel: 'Direct', sessions: direct },
      { channel: 'Paid AI', sessions: paidAiSessions },
      { channel: 'Organic AI referrals', sessions: organicAiSessions },
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

  // Period reflects whichever totals source was used. The window summary is the
  // authoritative span for its key; otherwise we report the snapshot-derived
  // window (the same `windowDays`), with the legacy summary as a final fallback.
  const periodStart = windowSummary?.periodStart
    ?? (snapshotStartDate || fallbackSummary?.periodStart || '')
  const periodEnd = windowSummary?.periodEnd
    ?? (snapshotMaxDate || fallbackSummary?.periodEnd || '')

  return {
    totalSessions,
    totalUsers,
    totalOrganicSessions,
    periodStart,
    periodEnd,
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
  // largest and keep only rows from that winning dimension. Traffic class is
  // deliberately NOT part of the key: keying on it would let a visit counted
  // paid under one lens and organic under another survive twice and inflate
  // the total. The surviving winning-dimension rows are disjoint by class, so
  // the paid/organic split below still partitions the deduped total cleanly.
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
  let paidSessions = 0
  let paidUsers = 0
  let organicSessions = 0
  let organicUsers = 0
  const sourceAgg = new Map<string, {
    sessions: number
    users: number
    paidSessions: number
    organicSessions: number
  }>()
  const trendAgg = new Map<string, number>()
  const pageAgg = new Map<string, { sessions: number; users: number }>()

  for (const r of dedupedRows) {
    total += r.sessions
    totalUsers += r.users
    const paid = isPaidAiTrafficClass(r.trafficClass)
    if (paid) {
      paidSessions += r.sessions
      paidUsers += r.users
    } else {
      organicSessions += r.sessions
      organicUsers += r.users
    }
    const s = sourceAgg.get(r.source) ?? {
      sessions: 0,
      users: 0,
      paidSessions: 0,
      organicSessions: 0,
    }
    s.sessions += r.sessions
    s.users += r.users
    if (paid) s.paidSessions += r.sessions
    else s.organicSessions += r.sessions
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
      paidSessions: data.paidSessions,
      organicSessions: data.organicSessions,
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

  return {
    totalSessions: total,
    totalUsers,
    paidSessions,
    paidUsers,
    organicSessions,
    organicUsers,
    bySource,
    trend,
    topLandingPages,
  }
}

function nonSubresourceReferralPathCondition() {
  return sql`
    LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '/_next/static/%'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '/assets/%'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '/static/%'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '/favicon.%'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.avif'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.css'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.gif'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.ico'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.jpeg'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.jpg'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.js'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.map'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.mjs'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.otf'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.png'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.svg'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.webmanifest'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.woff'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.woff2'
  `
}

/**
 * Server-side AI Visibility section.
 *
 * Reads from the traffic-sync rollup tables (`crawler_events_hourly`,
 * `ai_referral_events_hourly`) and packages them into a renderer-friendly
 * shape. Returns null when the project has no non-archived traffic source
 * connected at all (different signal from "connected but no data yet" —
 * the latter returns a populated section with `hasData=false` and zeroed
 * counters so the UI can show a "we're collecting" empty state).
 *
 * Crawler trust is split: verified hits have a source IP inside the
 * operator's published range, while claimed-unverified hits are surfaced
 * separately so a real crawl burst still shows activity.
 */
function buildServerActivity(db: DatabaseClient, projectId: string, windowDays: number): ProjectReportDto['serverActivity'] {
  // 1. Bail if no traffic source is connected at all.
  // Treat archived sources as "not connected" — we don't want to surface
  // historical data for a host migration the user has moved past.
  const sourceRows = db
    .select({ id: trafficSources.id })
    .from(trafficSources)
    .where(
      and(
        eq(trafficSources.projectId, projectId),
        ne(trafficSources.status, TrafficSourceStatuses.archived),
      ),
    )
    .all()
  if (sourceRows.length === 0) return null

  const now = new Date()
  const headlineEnd = now.toISOString()
  // Uniform window: the headline + daily trend span the selected window, and
  // the prior comparison covers the equal-length window immediately before it.
  const headlineStartMs = now.getTime() - windowDays * 24 * 60 * 60_000
  const priorStartMs = headlineStartMs - windowDays * 24 * 60 * 60_000
  const trendStartMs = headlineStartMs

  const headlineStart = new Date(headlineStartMs).toISOString()
  const priorStart = new Date(priorStartMs).toISOString()
  const trendStart = new Date(trendStartMs).toISOString()

  // 2. Headline + prior totals (verified crawlers + referral sessions).
  // The headline upper bound uses `lte` (inclusive) so the current hour bucket
  // counts. The prior upper bound uses `lt` (strict) against `headlineStart` so a
  // row with `tsHour` exactly equal to the boundary lands in the headline window
  // only — never both. Latent double-count if `now` aligned to an hour exactly.
  const sumVerifiedCrawlers = (windowStartIso: string, windowEndIso: string, exclusiveEnd = false) =>
    Number(
      db
        .select({ total: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)` })
        .from(crawlerEventsHourly)
        .where(
          and(
            eq(crawlerEventsHourly.projectId, projectId),
            eq(crawlerEventsHourly.verificationStatus, VerificationStatuses.verified),
            gte(crawlerEventsHourly.tsHour, windowStartIso),
            exclusiveEnd
              ? lt(crawlerEventsHourly.tsHour, windowEndIso)
              : lte(crawlerEventsHourly.tsHour, windowEndIso),
          ),
        )
        .get()?.total ?? 0,
    )

  const sumUnverifiedCrawlers = (windowStartIso: string, windowEndIso: string, exclusiveEnd = false) =>
    Number(
      db
        .select({ total: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)` })
        .from(crawlerEventsHourly)
        .where(
          and(
            eq(crawlerEventsHourly.projectId, projectId),
            ne(crawlerEventsHourly.verificationStatus, VerificationStatuses.verified),
            gte(crawlerEventsHourly.tsHour, windowStartIso),
            exclusiveEnd
              ? lt(crawlerEventsHourly.tsHour, windowEndIso)
              : lte(crawlerEventsHourly.tsHour, windowEndIso),
          ),
        )
        .get()?.total ?? 0,
    )

  // Returns the window's referral sessions split by traffic class. `unknown` is
  // the residual for rows ingested before the classifier shipped; it must never
  // be folded into `organic`, which would report a client's ad clicks as earned
  // AI traffic.
  const sumReferrals = (windowStartIso: string, windowEndIso: string, exclusiveEnd = false) => {
    const row = db
      .select({
        total: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)`,
        paid: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.paidSessionsOrHits}), 0)`,
        organic: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.organicSessionsOrHits}), 0)`,
      })
      .from(aiReferralEventsHourly)
      .where(
        and(
          eq(aiReferralEventsHourly.projectId, projectId),
          nonSubresourceReferralPathCondition(),
          gte(aiReferralEventsHourly.tsHour, windowStartIso),
          exclusiveEnd
            ? lt(aiReferralEventsHourly.tsHour, windowEndIso)
            : lte(aiReferralEventsHourly.tsHour, windowEndIso),
        ),
      )
      .get()
    return aiReferralClassCounts(Number(row?.total ?? 0), Number(row?.paid ?? 0), Number(row?.organic ?? 0))
  }

  // User-fetch hits roll verified + unverified together. For crawlers we
  // split because IP-range confirmation is the trust signal; for user-fetch
  // the operational question is "is an AI surface reading this page on
  // behalf of a real user, yes or no?", so verification matters less.
  const sumUserFetches = (windowStartIso: string, windowEndIso: string, exclusiveEnd = false) =>
    Number(
      db
        .select({ total: sql<number>`COALESCE(SUM(${aiUserFetchEventsHourly.hits}), 0)` })
        .from(aiUserFetchEventsHourly)
        .where(
          and(
            eq(aiUserFetchEventsHourly.projectId, projectId),
            gte(aiUserFetchEventsHourly.tsHour, windowStartIso),
            exclusiveEnd
              ? lt(aiUserFetchEventsHourly.tsHour, windowEndIso)
              : lte(aiUserFetchEventsHourly.tsHour, windowEndIso),
          ),
        )
        .get()?.total ?? 0,
    )

  const verifiedCurrent = sumVerifiedCrawlers(headlineStart, headlineEnd)
  const verifiedPrior = sumVerifiedCrawlers(priorStart, headlineStart, true)
  const unverifiedCurrent = sumUnverifiedCrawlers(headlineStart, headlineEnd)
  const unverifiedPrior = sumUnverifiedCrawlers(priorStart, headlineStart, true)
  const userFetchCurrent = sumUserFetches(headlineStart, headlineEnd)
  const userFetchPrior = sumUserFetches(priorStart, headlineStart, true)
  const referralCurrent = sumReferrals(headlineStart, headlineEnd)
  const referralPrior = sumReferrals(priorStart, headlineStart, true)

  // 3. Per-operator: verified hits, unverified hits, referral sessions over headline window.
  const crawlerByOperatorRows = db
    .select({
      operator: crawlerEventsHourly.operator,
      verificationStatus: crawlerEventsHourly.verificationStatus,
      hits: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)`,
    })
    .from(crawlerEventsHourly)
    .where(
      and(
        eq(crawlerEventsHourly.projectId, projectId),
        gte(crawlerEventsHourly.tsHour, headlineStart),
        lte(crawlerEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(crawlerEventsHourly.operator, crawlerEventsHourly.verificationStatus)
    .all()

  const crawlerByOperatorPriorRows = db
    .select({
      operator: crawlerEventsHourly.operator,
      hits: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)`,
    })
    .from(crawlerEventsHourly)
    .where(
      and(
        eq(crawlerEventsHourly.projectId, projectId),
        eq(crawlerEventsHourly.verificationStatus, VerificationStatuses.verified),
        gte(crawlerEventsHourly.tsHour, priorStart),
        lt(crawlerEventsHourly.tsHour, headlineStart),
      ),
    )
    .groupBy(crawlerEventsHourly.operator)
    .all()

  const referralByOperatorRows = db
    .select({
      operator: aiReferralEventsHourly.operator,
      hits: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)`,
    })
    .from(aiReferralEventsHourly)
    .where(
      and(
        eq(aiReferralEventsHourly.projectId, projectId),
        nonSubresourceReferralPathCondition(),
        gte(aiReferralEventsHourly.tsHour, headlineStart),
        lte(aiReferralEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(aiReferralEventsHourly.operator)
    .all()

  const userFetchByOperatorRows = db
    .select({
      operator: aiUserFetchEventsHourly.operator,
      hits: sql<number>`COALESCE(SUM(${aiUserFetchEventsHourly.hits}), 0)`,
    })
    .from(aiUserFetchEventsHourly)
    .where(
      and(
        eq(aiUserFetchEventsHourly.projectId, projectId),
        gte(aiUserFetchEventsHourly.tsHour, headlineStart),
        lte(aiUserFetchEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(aiUserFetchEventsHourly.operator)
    .all()

  const operatorAgg = new Map<string, {
    verified: number; unverified: number; userFetch: number; referrals: number; prior: number
  }>()
  const ensureOp = (op: string) => {
    let entry = operatorAgg.get(op)
    if (!entry) {
      entry = { verified: 0, unverified: 0, userFetch: 0, referrals: 0, prior: 0 }
      operatorAgg.set(op, entry)
    }
    return entry
  }
  for (const r of crawlerByOperatorRows) {
    const entry = ensureOp(r.operator)
    if (r.verificationStatus === VerificationStatuses.verified) entry.verified += Number(r.hits)
    else entry.unverified += Number(r.hits)
  }
  for (const r of crawlerByOperatorPriorRows) {
    ensureOp(r.operator).prior += Number(r.hits)
  }
  for (const r of userFetchByOperatorRows) {
    ensureOp(r.operator).userFetch += Number(r.hits)
  }
  for (const r of referralByOperatorRows) {
    ensureOp(r.operator).referrals += Number(r.hits)
  }

  const byOperator = [...operatorAgg.entries()]
    .map(([operator, v]) => ({
      operator,
      verifiedHits: v.verified,
      unverifiedHits: v.unverified,
      userFetchHits: v.userFetch,
      referralArrivals: v.referrals,
      deltaPct: deltaPercent(v.verified, v.prior),
    }))
    // Sort by total signal: verified hits first, then user-fetch, then unverified and referrals.
    .sort((a, b) =>
      b.verifiedHits - a.verifiedHits ||
      b.userFetchHits - a.userFetchHits ||
      b.unverifiedHits - a.unverifiedHits ||
      b.referralArrivals - a.referralArrivals,
    )

  // 4. Top crawled paths (verified only).
  const topPathsRows = db
    .select({
      path: crawlerEventsHourly.pathNormalized,
      hits: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)`,
      operators: sql<number>`COUNT(DISTINCT ${crawlerEventsHourly.operator})`,
    })
    .from(crawlerEventsHourly)
    .where(
      and(
        eq(crawlerEventsHourly.projectId, projectId),
        eq(crawlerEventsHourly.verificationStatus, VerificationStatuses.verified),
        gte(crawlerEventsHourly.tsHour, headlineStart),
        lte(crawlerEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(crawlerEventsHourly.pathNormalized)
    .orderBy(desc(sql`SUM(${crawlerEventsHourly.hits})`))
    .limit(SERVER_ACTIVITY_TOP_PATHS_LIMIT)
    .all()
  const topCrawledPaths = topPathsRows.map(r => ({
    path: r.path,
    verifiedHits: Number(r.hits),
    distinctOperators: Number(r.operators),
  }))

  // 5. AI products that sent referrals + their distinct landing pages.
  const referralProductsRows = db
    .select({
      product: aiReferralEventsHourly.product,
      arrivals: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)`,
      landingPaths: sql<number>`COUNT(DISTINCT ${aiReferralEventsHourly.landingPathNormalized})`,
    })
    .from(aiReferralEventsHourly)
    .where(
      and(
        eq(aiReferralEventsHourly.projectId, projectId),
        nonSubresourceReferralPathCondition(),
        gte(aiReferralEventsHourly.tsHour, headlineStart),
        lte(aiReferralEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(aiReferralEventsHourly.product)
    .orderBy(desc(sql`SUM(${aiReferralEventsHourly.sessionsOrHits})`))
    .all()
  const referralProducts = referralProductsRows.map(r => ({
    product: r.product,
    arrivals: Number(r.arrivals),
    distinctLandingPaths: Number(r.landingPaths),
  }))

  // 6. Top referral landing paths (where humans actually land coming from AI products).
  const topReferralRows = db
    .select({
      path: aiReferralEventsHourly.landingPathNormalized,
      arrivals: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)`,
      products: sql<number>`COUNT(DISTINCT ${aiReferralEventsHourly.product})`,
    })
    .from(aiReferralEventsHourly)
    .where(
      and(
        eq(aiReferralEventsHourly.projectId, projectId),
        nonSubresourceReferralPathCondition(),
        gte(aiReferralEventsHourly.tsHour, headlineStart),
        lte(aiReferralEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(aiReferralEventsHourly.landingPathNormalized)
    .orderBy(desc(sql`SUM(${aiReferralEventsHourly.sessionsOrHits})`))
    .limit(SERVER_ACTIVITY_TOP_PATHS_LIMIT)
    .all()
  const topReferralLandingPaths = topReferralRows.map(r => ({
    path: r.path,
    arrivals: Number(r.arrivals),
    distinctProducts: Number(r.products),
  }))

  // 7. Daily trend (spans the selected window) — bucket tsHour to YYYY-MM-DD via SQLite SUBSTR.
  const crawlerTrendRows = db
    .select({
      date: sql<string>`SUBSTR(${crawlerEventsHourly.tsHour}, 1, 10)`,
      hits: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)`,
    })
    .from(crawlerEventsHourly)
    .where(
      and(
        eq(crawlerEventsHourly.projectId, projectId),
        eq(crawlerEventsHourly.verificationStatus, VerificationStatuses.verified),
        gte(crawlerEventsHourly.tsHour, trendStart),
        lte(crawlerEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(sql`SUBSTR(${crawlerEventsHourly.tsHour}, 1, 10)`)
    .all()
  const referralTrendRows = db
    .select({
      date: sql<string>`SUBSTR(${aiReferralEventsHourly.tsHour}, 1, 10)`,
      hits: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)`,
    })
    .from(aiReferralEventsHourly)
    .where(
      and(
        eq(aiReferralEventsHourly.projectId, projectId),
        nonSubresourceReferralPathCondition(),
        gte(aiReferralEventsHourly.tsHour, trendStart),
        lte(aiReferralEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(sql`SUBSTR(${aiReferralEventsHourly.tsHour}, 1, 10)`)
    .all()

  const userFetchTrendRows = db
    .select({
      date: sql<string>`SUBSTR(${aiUserFetchEventsHourly.tsHour}, 1, 10)`,
      hits: sql<number>`COALESCE(SUM(${aiUserFetchEventsHourly.hits}), 0)`,
    })
    .from(aiUserFetchEventsHourly)
    .where(
      and(
        eq(aiUserFetchEventsHourly.projectId, projectId),
        gte(aiUserFetchEventsHourly.tsHour, trendStart),
        lte(aiUserFetchEventsHourly.tsHour, headlineEnd),
      ),
    )
    .groupBy(sql`SUBSTR(${aiUserFetchEventsHourly.tsHour}, 1, 10)`)
    .all()

  const emptyTrendEntry = () => ({ verifiedCrawlerHits: 0, userFetchHits: 0, referralArrivals: 0 })
  const dailyTrendMap = new Map<string, ReturnType<typeof emptyTrendEntry>>()
  for (const r of crawlerTrendRows) {
    const e = dailyTrendMap.get(r.date) ?? emptyTrendEntry()
    e.verifiedCrawlerHits += Number(r.hits)
    dailyTrendMap.set(r.date, e)
  }
  for (const r of userFetchTrendRows) {
    const e = dailyTrendMap.get(r.date) ?? emptyTrendEntry()
    e.userFetchHits += Number(r.hits)
    dailyTrendMap.set(r.date, e)
  }
  for (const r of referralTrendRows) {
    const e = dailyTrendMap.get(r.date) ?? emptyTrendEntry()
    e.referralArrivals += Number(r.hits)
    dailyTrendMap.set(r.date, e)
  }
  const dailyTrend = [...dailyTrendMap.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    windowStart: headlineStart,
    windowEnd: headlineEnd,
    hasData: verifiedCurrent + unverifiedCurrent + userFetchCurrent + referralCurrent.total
      + verifiedPrior + unverifiedPrior + userFetchPrior + referralPrior.total > 0
      || byOperator.length > 0
      || topCrawledPaths.length > 0
      || referralProducts.length > 0,
    verifiedCrawlerHits: {
      current: verifiedCurrent,
      prior: verifiedPrior,
      deltaPct: deltaPercent(verifiedCurrent, verifiedPrior),
    },
    unverifiedCrawlerHits: {
      current: unverifiedCurrent,
      prior: unverifiedPrior,
      deltaPct: deltaPercent(unverifiedCurrent, unverifiedPrior),
    },
    aiUserFetchHits: {
      current: userFetchCurrent,
      prior: userFetchPrior,
      deltaPct: deltaPercent(userFetchCurrent, userFetchPrior),
    },
    referralArrivals: {
      current: referralCurrent.total,
      prior: referralPrior.total,
      deltaPct: deltaPercent(referralCurrent.total, referralPrior.total),
    },
    referralArrivalsByClass: {
      paid: {
        current: referralCurrent.paid,
        prior: referralPrior.paid,
        deltaPct: deltaPercent(referralCurrent.paid, referralPrior.paid),
      },
      organic: {
        current: referralCurrent.organic,
        prior: referralPrior.organic,
        deltaPct: deltaPercent(referralCurrent.organic, referralPrior.organic),
      },
      unclassified: {
        current: referralCurrent.unknown,
        prior: referralPrior.unknown,
        deltaPct: deltaPercent(referralCurrent.unknown, referralPrior.unknown),
      },
    },
    referralArrivalsClassSummary: formatAiReferralClassSummary(referralCurrent),
    byOperator,
    topCrawledPaths,
    referralProducts,
    dailyTrend,
    topReferralLandingPaths,
  }
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
  // Same tri-state semantics as content-data's `LocationScope`:
  //   `undefined` = unfiltered, `null` = locationless runs only, string = match label.
  locationFilter: string | null | undefined,
): CitationsTrendPoint[] {
  // Trend points must share a location with the latest run, otherwise a
  // florida sweep and a michigan sweep get plotted on the same line. Match
  // null-to-null so locationless projects still see a contiguous trend.
  const visibilityRuns = db
    .select()
    .from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.kind, RunKinds['answer-visibility']), notProbeRun()))
    .all()
    .filter(r => locationFilter === undefined || (r.location ?? null) === locationFilter)

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
    // mentionRate uses the same per-query denominator for symmetry.
    const citedQueryIds = new Set<string>()
    const mentionedQueryIds = new Set<string>()
    let considered = 0
    const providerCounts = new Map<string, { cited: number; mentioned: number; total: number }>()
    for (const snap of snaps) {
      if (!queryLookup.byId.has(snap.queryId)) continue
      considered++
      if (snap.citationState === CitationStates.cited) citedQueryIds.add(snap.queryId)
      if (snap.answerMentioned) mentionedQueryIds.add(snap.queryId)
      const counts = providerCounts.get(snap.provider) ?? { cited: 0, mentioned: 0, total: 0 }
      counts.total++
      if (snap.citationState === CitationStates.cited) counts.cited++
      if (snap.answerMentioned === true) counts.mentioned++
      providerCounts.set(snap.provider, counts)
    }
    if (considered === 0) continue
    const citedQueryCount = citedQueryIds.size
    const mentionedQueryCount = mentionedQueryIds.size
    const citationRate = totalQueries > 0
      ? Math.round((citedQueryCount / totalQueries) * 100)
      : 0
    const mentionRate = totalQueries > 0
      ? Math.round((mentionedQueryCount / totalQueries) * 100)
      : 0
    const providerRates = [...providerCounts.entries()]
      .map(([provider, counts]) => ({
        provider,
        citationRate: counts.total > 0 ? Math.round((counts.cited / counts.total) * 100) : 0,
        mentionRate: counts.total > 0 ? Math.round((counts.mentioned / counts.total) * 100) : 0,
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider))

    points.push({
      runId: run.id,
      date: run.finishedAt ?? run.createdAt,
      citationRate,
      citedQueryCount,
      totalQueryCount: totalQueries,
      mentionRate,
      mentionedQueryCount,
      providerRates,
    })
  }

  points.sort((a, b) => a.date.localeCompare(b.date))
  return points
}

function buildInsightList(
  db: DatabaseClient,
  projectId: string,
  // Same tri-state as buildCitationsTrend.
  locationFilter: string | null | undefined,
): ReportInsight[] {
  // Bound the report to the most recent N answer-visibility runs so stale,
  // long-undismissed insights from months ago don't pile up. Mirrors the
  // recurrence window used in intelligence-service for severity tiering.
  // Insights are scoped to runs at the same location as the latest run so
  // a florida regression isn't surfaced on a michigan-scoped report.
  const recentRunIds = db
    .select({ id: runs.id, location: runs.location })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(runs.kind, RunKinds['answer-visibility']),
        or(eq(runs.status, RunStatuses.completed), eq(runs.status, RunStatuses.partial)),
        notProbeRun(),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .all()
    .filter((r) => locationFilter === undefined || (r.location ?? null) === locationFilter)
    .slice(0, INSIGHT_LOOKBACK_RUNS)
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
      const recommendation = r.recommendation
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
      detail = `Building baseline (${trendsPoints.length} of ${MIN_TREND_POINTS} checks completed).`
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

function compactList(items: readonly string[], limit = 3): string {
  const visible = items.slice(0, limit)
  const extra = items.length - visible.length
  return extra > 0 ? `${visible.join(', ')}, +${extra} more` : visible.join(', ')
}

function contentActionVerb(action: ProjectReportDto['contentOpportunities'][number]['action']): string {
  switch (action) {
    case 'create': return 'Create'
    case 'expand': return 'Expand'
    case 'refresh': return 'Refresh'
    case 'add-schema': return 'Add schema to'
  }
}

function confidenceFromEvidence(count: number): ReportActionPlanItem['confidence'] {
  if (count >= 3) return 'high'
  if (count >= 1) return 'medium'
  return 'low'
}

function actionAudienceMatches(action: ReportActionPlanItem, audience: ReportAudience): boolean {
  return action.audience === 'both' || action.audience === audience
}

interface ReportActionPlanInput {
  canonicalDomain: string
  competitorDomains: string[]
  citationScorecard: ProjectReportDto['citationScorecard']
  aiSourceOrigin: ProjectReportDto['aiSourceOrigin']
  gsc: ProjectReportDto['gsc']
  indexingHealth: ProjectReportDto['indexingHealth']
  contentOpportunities: ProjectReportDto['contentOpportunities']
  contentGaps: ProjectReportDto['contentGaps']
  reportLocation: ProjectReportDto['meta']['location']
  providerLocationHandling: ProjectReportDto['meta']['providerLocationHandling']
}

function buildReportActionPlan(input: ReportActionPlanInput): ReportActionPlanItem[] {
  const actions: ReportActionPlanItem[] = []

  if (input.competitorDomains.length === 0 && input.aiSourceOrigin.topDomains.length > 0) {
    const topDomains = input.aiSourceOrigin.topDomains.slice(0, 5)
    actions.push({
      audience: 'both',
      priority: 10,
      horizon: 'immediate',
      category: 'competitors',
      title: 'Define the competitor set Canonry should benchmark against',
      action: 'Review the recurring external source domains and add the true competitors before the next check.',
      why: [
        'The report can identify repeated external sources, but it cannot separate competitors from publishers until competitors are configured.',
        'A clean competitor set makes future mention-share and content-gap reporting easier to explain to clients.',
      ],
      evidence: topDomains.map(d => `${d.domain} appeared in ${d.count} cited source${d.count === 1 ? '' : 's'}`),
      successMetric: 'Next report separates tracked competitors from independent source domains in the competitor landscape.',
      confidence: confidenceFromEvidence(topDomains.length),
    })
  }

  for (const [index, opportunity] of input.contentOpportunities.slice(0, 2).entries()) {
    const verb = contentActionVerb(opportunity.action)
    const bestPageUrl = opportunity.ourBestPage?.url
    // Treat "/" the same as "no best page" for action copy. Pointing the
    // operator at the homepage as the place to "Update" or "Create" reads
    // as nonsense ("Create / so it directly answers…"). The homepage is
    // the best slug match by default but is rarely the topical page the
    // analyst should edit. Keep the URL in the evidence so the analyst
    // still sees what canonry matched against — just don't bake it into
    // the sentence.
    const hasUsablePage = !!bestPageUrl && bestPageUrl !== '/' && bestPageUrl.trim() !== ''
    const evidence = [
      `Opportunity score ${Math.round(opportunity.score)} with ${opportunity.actionConfidence} confidence`,
      `Demand source: ${opportunity.demandSource}`,
    ]
    if (opportunity.winningCompetitor) {
      evidence.push(`${opportunity.winningCompetitor.domain} is the current winning cited source`)
    }
    if (opportunity.ourBestPage) {
      if (bestPageUrl === '/') {
        evidence.push('No topical page yet — homepage is the closest slug match')
      } else {
        evidence.push(`Best matching owned page: ${bestPageUrl}`)
      }
    } else {
      evidence.push('No matching owned page was found')
    }

    // `create` action means "this slot needs new dedicated content" even
    // when ourBestPage exists (a poor-ranking page IS the trigger for the
    // create classification — see content-classifier.ts). For create
    // actions, always say "a new page for …" rather than telling the
    // operator to edit the bad page. Other verbs (Expand, Refresh, Add
    // schema to) target the existing page.
    const targetIsExistingPage = opportunity.action !== 'create' && hasUsablePage
    actions.push({
      audience: 'both',
      priority: 20 + index,
      horizon: opportunity.actionConfidence === 'high' ? 'short-term' : 'medium-term',
      category: 'content',
      title: `${verb} content for "${opportunity.query}"`,
      action: targetIsExistingPage
        ? `${verb} the existing page so it directly answers the tracked query and cites the strongest supporting evidence.`
        : `${verb} a new page for "${opportunity.query}" that directly answers the query and earns citations from AI answer engines.`,
      why: opportunity.drivers.length > 0
        ? opportunity.drivers
        : ['Canonry ranked this as a content opportunity from search-demand and citation evidence.'],
      evidence,
      successMetric: `A future check cites ${input.canonicalDomain} for "${opportunity.query}" and the matching GSC query/page improves.`,
      confidence: opportunity.actionConfidence,
      // Carry the underlying recommendation ref through so the SPA can
      // attach a "Mark addressed" button. Dropping the dismissal removes
      // the row from `contentOpportunities` (see `buildProjectReport`),
      // which retro-drops this action on the next report load.
      targetRef: opportunity.targetRef,
    })
  }

  if (input.indexingHealth && input.indexingHealth.total > 0 && input.indexingHealth.indexedPct < 70) {
    const ih = input.indexingHealth
    const evidence = [
      `${ih.indexedPct}% indexed (${ih.indexed}/${ih.total})`,
      `${ih.notIndexed} not indexed${ih.deindexed > 0 ? `, ${ih.deindexed} deindexed` : ''}`,
    ]
    actions.push({
      audience: 'both',
      priority: 30,
      horizon: 'immediate',
      category: 'indexing',
      title: 'Fix indexing coverage before expanding the content plan',
      action: 'Audit the not-indexed tracked URLs, resolve crawl/index blockers, and resubmit priority pages.',
      why: [
        'Pages missing from the search index are less likely to be retrieved or cited by AI answer engines.',
        'Indexing issues can hide otherwise strong content from both search and AI systems.',
      ],
      evidence,
      successMetric: 'Indexed share moves above 80% for tracked URLs and priority pages are eligible for retrieval.',
      confidence: ih.total >= 5 ? 'high' : 'medium',
    })
  }

  const zeroCitationProviders = input.citationScorecard.providerRates
    .filter(p => p.totalCount > 0 && p.citedCount === 0)
  if (zeroCitationProviders.length > 0) {
    actions.push({
      audience: 'agency',
      priority: 40,
      horizon: 'short-term',
      category: 'provider',
      title: 'Diagnose providers with zero citations',
      action: 'Inspect zero-citation provider answers and compare their cited domains against the pages currently available on the client site.',
      why: [
        'Provider-level misses show where one model family is not retrieving the client even when others might.',
        'This points the agency toward provider-specific evidence gaps instead of a generic content recommendation.',
      ],
      evidence: zeroCitationProviders.map(p => `${p.provider}: 0/${p.totalCount} cited query-provider pairs`),
      successMetric: 'At least one zero-citation engine cites the client on a priority query in a later check.',
      confidence: 'high',
    })
  }

  if (input.gsc && (input.gsc.trackedButNoGsc.length > 0 || input.gsc.gscButNotTracked.length > 0)) {
    const evidence: string[] = []
    if (input.gsc.trackedButNoGsc.length > 0) {
      evidence.push(`Tracked with no GSC demand: ${compactList(input.gsc.trackedButNoGsc)}`)
    }
    if (input.gsc.gscButNotTracked.length > 0) {
      evidence.push(`Search demand not tracked in AEO: ${compactList(input.gsc.gscButNotTracked)}`)
    }
    actions.push({
      audience: 'agency',
      priority: 50,
      horizon: 'short-term',
      category: 'search-demand',
      title: 'Align tracked AEO queries with search demand',
      action: 'Prune or relabel tracked queries with no search demand and add high-impression non-brand GSC queries to the AEO tracking set.',
      why: [
        'The strongest report actions come from overlap between real search demand and AI citation gaps.',
        'Mismatch here can make the client report feel interesting but hard to act on.',
      ],
      evidence,
      successMetric: 'Next report has fewer no-demand tracked queries and includes the highest-impression non-brand GSC candidates.',
      confidence: evidence.length > 1 ? 'high' : 'medium',
    })
  }

  if (input.contentGaps.length > 0) {
    const topGap = input.contentGaps[0]!
    actions.push({
      audience: 'agency',
      priority: 60,
      horizon: 'medium-term',
      category: 'content',
      title: 'Close competitor-cited content gaps',
      action: 'Map the top missing queries to owned pages or new briefs, starting with the gaps where multiple competitors are already cited.',
      why: [
        'These are explicit places where AI engines found competitor sources but not the client.',
        'They are stronger evidence than a generic topic list because the model is already retrieving competing content.',
      ],
      evidence: [
        `"${topGap.query}" missed at ${Math.round(topGap.missRate * 100)}% with ${topGap.competitorCount} competitor${topGap.competitorCount === 1 ? '' : 's'} cited`,
        `Cited competitors: ${compactList(topGap.competitorDomains)}`,
      ],
      successMetric: 'The top content-gap query moves from missed to cited or mentioned after the recommended content work ships.',
      confidence: topGap.competitorCount >= 2 ? 'high' : 'medium',
    })
  }

  if (input.reportLocation && input.reportLocation.otherConfiguredLabels.length > 0) {
    const ignoredProviders = input.providerLocationHandling
      .filter(p => p.treatment === 'ignored' || p.treatment === 'browser-geo')
      .map(p => p.provider)
    const evidence = [
      `Current report location: ${input.reportLocation.label}`,
      `Other configured locations: ${compactList(input.reportLocation.otherConfiguredLabels)}`,
    ]
    if (ignoredProviders.length > 0) {
      evidence.push(`Providers with weak/indirect location handling: ${compactList(ignoredProviders)}`)
    }
    actions.push({
      audience: 'agency',
      priority: 70,
      horizon: 'medium-term',
      category: 'location',
      title: 'Keep location-scoped reporting separate by market',
      action: 'Run and compare separate checks for each configured location before making market-level recommendations.',
      why: [
        'A multi-location client can appear differently by market.',
        'Keeping each report location-scoped avoids mixing Florida and Michigan evidence in the same client story.',
      ],
      evidence,
      successMetric: 'Each configured market has its own current check and trend before cross-market decisions are made.',
      confidence: 'high',
    })
  }

  if (actions.length === 0) {
    actions.push({
      audience: 'both',
      priority: 90,
      horizon: 'short-term',
      category: 'monitoring',
      title: 'Keep monitoring citation and mention coverage',
      action: 'Run the next scheduled check and watch for citation gains, losses, and engine-specific misses.',
      why: [
        'No urgent corrective action surfaced from the current evidence.',
        'AEO performance is directional; repeated checks are needed before overreacting to a single sample.',
      ],
      evidence: ['No critical insights, content gaps, indexing blockers, or provider-zero issues were detected in this report.'],
      successMetric: 'Coverage stays stable or improves across the next trend window.',
      confidence: 'medium',
    })
  }

  return actions.sort((a, b) => a.priority - b.priority).slice(0, 10)
}

function mentionTrendSentence(delta: ReportRateDelta | null): string {
  if (!delta) return 'There is not enough comparable run history yet to call a mention trend.'
  if (delta.direction === 'up') return 'Mention coverage improved versus the prior comparable checks.'
  if (delta.direction === 'down') return 'Mention coverage declined versus the prior comparable checks.'
  return 'Mention coverage is flat versus the prior comparable checks.'
}

function buildClientSummary(
  reportLike: {
    canonicalDomain: string
    reportLocation: ProjectReportDto['meta']['location']
    executiveSummary: ProjectReportDto['executiveSummary']
    citationsTrend: ProjectReportDto['citationsTrend']
    whatsChanged: ProjectReportDto['whatsChanged']
    gsc: ProjectReportDto['gsc']
    actionPlan: ProjectReportDto['actionPlan']
  },
): ProjectReportDto['clientSummary'] {
  const s = reportLike.executiveSummary
  const queryNoun = s.totalQueryCount === 1 ? 'query' : 'queries'
  const headline = s.totalQueryCount > 0
    ? `${s.mentionedQueryCount} of ${s.totalQueryCount} tracked ${queryNoun} mention the brand in AI answers`
    : 'No tracked queries have completed a check yet'
  const overview = s.totalQueryCount > 0
    ? `${reportLike.canonicalDomain} is mentioned on ${s.mentionRate}% of tracked queries and cited on ${s.citationRate}% of tracked queries. ${mentionTrendSentence(reportLike.whatsChanged.mentionRate)}`
    : 'At least one completed check is needed before this can summarize how the brand appears in AI answers.'

  const confidenceNotes: string[] = []
  if (s.totalQueryCount === 0) {
    confidenceNotes.push('Confidence is low until the first tracked query check completes.')
  } else if (s.totalQueryCount < 5) {
    confidenceNotes.push('Directional read: the tracked query set is still small, so each query has outsized impact on the percentage.')
  }
  if (isTrendBaseline(reportLike.citationsTrend)) {
    confidenceNotes.push(`Trend confidence is still developing; ${MIN_TREND_POINTS} comparable checks are needed for a stable trend.`)
  }
  if (!reportLike.gsc) {
    confidenceNotes.push('Search Console is not connected, so content recommendations lean more heavily on citation and competitor evidence.')
  }
  if (reportLike.reportLocation) {
    confidenceNotes.push(`This summary is scoped to the ${reportLike.reportLocation.label} run location.`)
  }

  return {
    headline,
    overview,
    actionItems: reportLike.actionPlan.filter(a => actionAudienceMatches(a, 'client')).slice(0, 3),
    confidenceNotes,
  }
}

function buildAgencyDiagnostics(input: ReportActionPlanInput & {
  actionPlan: ProjectReportDto['actionPlan']
}): ProjectReportDto['agencyDiagnostics'] {
  const diagnostics: ProjectReportDto['agencyDiagnostics']['diagnostics'] = []

  const zeroCitationProviders = input.citationScorecard.providerRates
    .filter(p => p.totalCount > 0 && p.citedCount === 0)
  diagnostics.push({
    title: 'Provider citation coverage',
    detail: zeroCitationProviders.length > 0
      ? `${zeroCitationProviders.length} engine${zeroCitationProviders.length === 1 ? '' : 's'} returned zero client citations in the latest check.`
      : 'Every provider with completed snapshots produced at least one client citation or no provider data is available yet.',
    severity: zeroCitationProviders.length > 0 ? 'negative' : 'positive',
    evidence: zeroCitationProviders.length > 0
      ? zeroCitationProviders.map(p => `${p.provider}: 0/${p.totalCount}`)
      : input.citationScorecard.providerRates.map(p => `${p.provider}: ${p.citedCount}/${p.totalCount}`),
  })

  diagnostics.push({
    title: 'AI source domains',
    detail: input.aiSourceOrigin.topDomains.length > 0
      ? 'Repeated external source domains show what AI engines are currently trusting for this topic set.'
      : 'No external source-domain evidence is available from the latest check yet.',
    severity: input.aiSourceOrigin.topDomains.length > 0 ? 'neutral' : 'caution',
    evidence: input.aiSourceOrigin.topDomains.slice(0, 5).map(d => `${d.domain}: ${d.count}`),
  })

  if (input.gsc) {
    diagnostics.push({
      title: 'GSC query mismatch',
      detail: input.gsc.trackedButNoGsc.length > 0 || input.gsc.gscButNotTracked.length > 0
        ? 'The tracked AEO query set and real search demand are not fully aligned.'
        : 'Tracked AEO queries and high-impression non-brand GSC queries are aligned for the current window.',
      severity: input.gsc.trackedButNoGsc.length > 0 || input.gsc.gscButNotTracked.length > 0 ? 'caution' : 'positive',
      evidence: [
        ...(input.gsc.trackedButNoGsc.length > 0 ? [`Tracked with no GSC demand: ${compactList(input.gsc.trackedButNoGsc)}`] : []),
        ...(input.gsc.gscButNotTracked.length > 0 ? [`GSC queries not tracked in AEO: ${compactList(input.gsc.gscButNotTracked)}`] : []),
      ],
    })
  }

  if (input.indexingHealth) {
    diagnostics.push({
      title: 'Indexing health',
      detail: `${input.indexingHealth.indexedPct}% of inspected URLs are indexed in ${input.indexingHealth.provider ?? 'the connected provider'}.`,
      severity: input.indexingHealth.indexedPct >= 90 ? 'positive' : input.indexingHealth.indexedPct >= 70 ? 'caution' : 'negative',
      evidence: [
        `${input.indexingHealth.indexed}/${input.indexingHealth.total} indexed`,
        `${input.indexingHealth.notIndexed} not indexed`,
      ],
    })
  }

  diagnostics.push({
    title: 'Content opportunity pipeline',
    detail: input.contentOpportunities.length > 0
      ? `${input.contentOpportunities.length} ranked content opportunit${input.contentOpportunities.length === 1 ? 'y' : 'ies'} and ${input.contentGaps.length} content gap${input.contentGaps.length === 1 ? '' : 's'} are available.`
      : 'No ranked content opportunities are available from the current evidence.',
    severity: input.contentOpportunities.length > 0 ? 'caution' : 'neutral',
    evidence: input.contentOpportunities.slice(0, 3).map(o => `${o.query}: ${o.action} (${Math.round(o.score)})`),
  })

  return {
    priorities: input.actionPlan.filter(a => actionAudienceMatches(a, 'agency')).slice(0, 6),
    diagnostics,
  }
}

// Real-movement thresholds for the per-run rate deltas. Tighter values
// (and the point-to-point comparison they replaced) flipped tone arrows
// on every run because a single query bouncing in/out of cited on a
// 20-query basket is a 5pp swing — meaningless, but the old code treated
// any |delta| > 0.5pp as up/down. 3pp on smoothed averages is the noise
// floor for a 20-query basket; bigger baskets get more conservative
// up/down marking, which is the right tradeoff.
const RATE_REAL_MOVEMENT_THRESHOLD_PP = 3
const COUNT_REAL_MOVEMENT_THRESHOLD = 0.5

const WIN_REGRESSION_LIMIT = 5

function rateDirection(delta: number, threshold = 0.5): 'up' | 'down' | 'flat' {
  if (delta > threshold) return 'up'
  if (delta < -threshold) return 'down'
  return 'flat'
}

// Period-over-period traffic delta: the most recent `halfWindow` days of the
// trend vs the `halfWindow` days before that. `halfWindow` is the report
// window split in two, so the comparison always covers the full selected
// window. Anchored on the trend tail so a stale sync still produces a
// meaningful comparison; below `halfWindow * 2` points we return null instead
// of inventing motion on a partial prior window.
function periodOverPeriodDelta(
  trend: ReadonlyArray<{ date: string; value: number }>,
  halfWindow: number,
): ReportRateDelta | null {
  if (trend.length < halfWindow * 2) return null
  const tail = trend.slice(-halfWindow)
  const prior = trend.slice(-halfWindow * 2, -halfWindow)
  const current = tail.reduce((s, p) => s + p.value, 0)
  const priorTotal = prior.reduce((s, p) => s + p.value, 0)
  const deltaAbs = current - priorTotal
  return {
    current,
    prior: priorTotal,
    deltaAbs,
    deltaPct: deltaPercent(current, priorTotal),
    direction: rateDirection(deltaAbs, 0),
  }
}

function buildWhatsChangedHeadline(
  citation: ReportRateDelta | null,
  gscClicks: ReportRateDelta | null,
  aiReferrals: ReportRateDelta | null,
  enoughHistory: boolean,
  trendLength: number,
  comparisonWindowDays: number,
): string {
  if (!enoughHistory) {
    return `Building baseline (${trendLength} of ${MIN_TREND_POINTS} checks completed). Trends appear after a few more checks.`
  }
  const parts: string[] = []
  if (citation) {
    const arrow = citation.direction === 'up' ? '↑' : citation.direction === 'down' ? '↓' : '→'
    const verb = citation.direction === 'up' ? 'rose' : citation.direction === 'down' ? 'fell' : 'held'
    // Window=1 → "rose 50% ↑ 60%" (point-to-point legacy phrasing);
    // window≥2 → "rose 50% ↑ 60% (avg of last 3 checks)" so readers know
    // the number isn't a single-run snapshot.
    const smoothingHint = citation.window && citation.window >= 2
      ? ` (avg of last ${citation.window} checks)`
      : ''
    parts.push(`Citation rate ${verb} ${citation.prior}% ${arrow} ${citation.current}%${smoothingHint}`)
  }
  if (aiReferrals && aiReferrals.direction !== 'flat') {
    const arrow = aiReferrals.direction === 'up' ? '↑' : '↓'
    parts.push(`AI referrals ${arrow}${Math.abs(aiReferrals.deltaAbs)} sessions vs prior ${comparisonWindowDays} days`)
  } else if (gscClicks && gscClicks.direction !== 'flat') {
    const arrow = gscClicks.direction === 'up' ? '↑' : '↓'
    parts.push(`GSC clicks ${arrow}${Math.abs(gscClicks.deltaAbs)} vs prior ${comparisonWindowDays} days`)
  }
  return parts.length > 0 ? `${parts.join(' · ')}.` : 'No meaningful movement vs the prior period.'
}

function buildWhatsChanged(input: {
  citationsTrend: CitationsTrendPoint[]
  gsc: ProjectReportDto['gsc']
  aiReferrals: ProjectReportDto['aiReferrals']
  insights: ReportInsight[]
  comparisonWindowDays: number
}): WhatsChangedSection {
  const { citationsTrend, gsc, aiReferrals, insights: insightList, comparisonWindowDays } = input
  const baseline = isTrendBaseline(citationsTrend)
  const latest = citationsTrend.at(-1)
  const prior = citationsTrend.length >= 2 ? citationsTrend.at(-2) : null
  const enoughHistory = !baseline && latest !== undefined && prior !== undefined

  // Rolling-average comparison instead of point-to-point — `smoothedRunDelta`
  // grows the window up to 3 runs as history accumulates, falling back to
  // window=1 (legacy behavior) at 2–3 runs total. Direction uses a
  // real-movement threshold so a single-query bounce on a small basket
  // doesn't flip the tone arrow.
  const citationRateSmoothed = smoothedRunDelta(citationsTrend, p => p.citationRate)
  const citationRate: ReportRateDelta | null = enoughHistory && citationRateSmoothed
    ? {
        ...citationRateSmoothed,
        direction: rateDirection(citationRateSmoothed.deltaAbs, RATE_REAL_MOVEMENT_THRESHOLD_PP),
      }
    : null

  const mentionRateSmoothed = smoothedRunDelta(citationsTrend, p => p.mentionRate)
  const mentionRate: ReportRateDelta | null = enoughHistory && mentionRateSmoothed
    ? {
        ...mentionRateSmoothed,
        direction: rateDirection(mentionRateSmoothed.deltaAbs, RATE_REAL_MOVEMENT_THRESHOLD_PP),
      }
    : null

  const citedQueryCountSmoothed = smoothedRunDelta(citationsTrend, p => p.citedQueryCount)
  const citedQueryCount: ReportRateDelta | null = enoughHistory && citedQueryCountSmoothed
    ? {
        ...citedQueryCountSmoothed,
        direction: rateDirection(citedQueryCountSmoothed.deltaAbs, COUNT_REAL_MOVEMENT_THRESHOLD),
      }
    : null

  const mentionedQueryCountSmoothed = smoothedRunDelta(citationsTrend, p => p.mentionedQueryCount)
  const mentionedQueryCount: ReportRateDelta | null = enoughHistory && mentionedQueryCountSmoothed
    ? {
        ...mentionedQueryCountSmoothed,
        direction: rateDirection(mentionedQueryCountSmoothed.deltaAbs, COUNT_REAL_MOVEMENT_THRESHOLD),
      }
    : null

  const providerMovements: ReportProviderMovement[] = []
  if (enoughHistory) {
    const priorByProvider = new Map(prior!.providerRates.map(p => [p.provider, p.citationRate]))
    for (const cur of latest!.providerRates) {
      const priorRate = priorByProvider.get(cur.provider)
      if (priorRate === undefined) continue
      const deltaAbs = cur.citationRate - priorRate
      providerMovements.push({
        provider: cur.provider,
        current: cur.citationRate,
        prior: priorRate,
        deltaAbs,
        direction: rateDirection(deltaAbs),
      })
    }
    providerMovements.sort((a, b) => Math.abs(b.deltaAbs) - Math.abs(a.deltaAbs))
  }

  const gscClicksDelta = gsc
    ? periodOverPeriodDelta(gsc.trend.map(t => ({ date: t.date, value: t.clicks })), comparisonWindowDays)
    : null
  const aiReferralsDelta = aiReferrals
    ? periodOverPeriodDelta(aiReferrals.trend.map(t => ({ date: t.date, value: t.sessions })), comparisonWindowDays)
    : null

  const wins = insightList
    .filter(i => i.type === 'gain')
    .slice(0, WIN_REGRESSION_LIMIT)
  const regressions = insightList
    .filter(i => i.type === 'regression')
    .slice(0, WIN_REGRESSION_LIMIT)

  const headline = buildWhatsChangedHeadline(
    citationRate,
    gscClicksDelta,
    aiReferralsDelta,
    enoughHistory,
    citationsTrend.length,
    comparisonWindowDays,
  )

  return {
    enoughHistory,
    headline,
    citationRate,
    mentionRate,
    citedQueryCount,
    mentionedQueryCount,
    gscClicksDelta,
    aiReferralsDelta,
    comparisonWindowDays,
    providerMovements,
    wins,
    regressions,
  }
}

function buildProjectReport(db: DatabaseClient, projectName: string, periodDays: number): ProjectReportDto {
  const project = resolveProject(db, projectName)
  const queryLookup = loadQueryLookup(db, project.id)
  const comparisonWindowDays = reportComparisonWindowDays(periodDays)

  const allRuns = db
    .select()
    .from(runs)
    .where(and(eq(runs.projectId, project.id), notProbeRun()))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .all()

  const visibilityRuns = allRuns.filter(r => r.kind === RunKinds['answer-visibility'])
  // Multi-location `--all-locations` sweeps fan out into N runs sharing the
  // same `createdAt`. Group the visibility runs, pick the latest completed
  // group, and aggregate snapshots across the group so the report's per-query
  // sections (citationScorecard, competitorLandscape, mentionLandscape,
  // aiSourceOrigin) reflect both florida AND michigan instead of whichever
  // sibling won an arbitrary tiebreak. See #480.
  const completedVisRunGroups = groupRunsByCreatedAt(
    visibilityRuns.filter(r => r.status === RunStatuses.completed || r.status === RunStatuses.partial),
  )
  const latestVisRunGroup = completedVisRunGroups[0] ?? []
  // Representative is used as the "primary" run id/location for the report
  // header and for the *history-scoped* sections below — those still scope
  // per-location to keep the trend line and orchestrator inputs single-series
  // (see review thread on PR #423; mixing locations on one trend line was the
  // bug that scoping originally fixed). The representative is deterministic
  // (id DESC tiebreak) so the same project always renders the same report.
  const representativeLatestRun = pickGroupRepresentative(latestVisRunGroup)
    ?? visibilityRuns[0]
    ?? null
  const latestSnapshots = loadSnapshotsForRunIds(db, latestVisRunGroup.map(r => r.id))
  const latestRunLocation: string | null = representativeLatestRun?.location ?? null

  const competitorRows = db.select().from(competitors).where(eq(competitors.projectId, project.id)).all()
  const competitorDomains = competitorRows.map(c => c.domain)

  // Treat ownedDomains the same way determineCitationState does — anything
  // matching the canonical domain or an owned subdomain counts as "ours".
  const ownedDomains = project.ownedDomains
  const projectDomains = [project.canonicalDomain, ...ownedDomains]
  const projectAliases = project.aliases
  const projectBrandNames = effectiveBrandNames({
    displayName: project.displayName,
    aliases: projectAliases,
  })

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
    projectBrandNames,
    projectDomains,
    queryLookup,
  )
  const aiSourceOrigin = buildAiSourceOrigin(latestSnapshots, projectDomains, competitorDomains)
  const trackedQueries = [...queryLookup.byId.values()]
  const gscSection = buildGscSection(
    db,
    project.id,
    projectBrandNames,
    project.canonicalDomain,
    trackedQueries,
    periodDays,
  )
  const gaSection = buildGaSection(db, project.id, periodDays)
  const socialSection = buildSocialReferrals(db, project.id)
  const aiReferralsSection = buildAiReferrals(db, project.id)
  const serverActivitySection = buildServerActivity(db, project.id, periodDays)
  const indexingHealthSection = buildIndexingHealth(db, project.id)
  const citationsTrend = buildCitationsTrend(db, project.id, queryLookup, latestRunLocation)
  const insightList = buildInsightList(db, project.id, latestRunLocation)

  const orchestratorInput = loadOrchestratorInput(db, project, latestRunLocation)
  // Filter persistently-dismissed recommendations so SPA report, HTML report,
  // and `/content/targets` all consume the same filtered set. Dismissals
  // persist in `content_target_dismissals` keyed by `(projectId, targetRef)`
  // — the user clicks "Mark addressed" in the SPA and the row drops off here
  // on the next report load. `contentGaps` is intentionally not filtered:
  // gaps reflect raw competitive presence and dismissal is a per-opportunity
  // (not per-query) signal.
  const dismissedTargetRefs = loadDismissedTargetRefs(db, project.id)
  const rawContentOpportunities = buildContentTargetRows(orchestratorInput)
  const contentOpportunities = dismissedTargetRefs.size > 0
    ? rawContentOpportunities.filter(r => !dismissedTargetRefs.has(r.targetRef))
    : rawContentOpportunities
  const contentGaps = buildContentGapRows(orchestratorInput)
  const groundingSources = buildContentSourceRows(orchestratorInput)

  const insightDerivedSteps = buildRecommendedNextSteps(insightList)
  const recommendedNextSteps = mapOpportunitiesToNextSteps(
    contentOpportunities,
    insightDerivedSteps,
  )

  const whatsChanged = buildWhatsChanged({
    citationsTrend,
    gsc: gscSection,
    aiReferrals: aiReferralsSection,
    insights: insightList,
    comparisonWindowDays,
  })

  // Headline rate is per-query — see buildCitationsTrend for the rationale.
  // Same definition both places so the trend chart and the executive summary
  // KPI move together; using different denominators in the two surfaces is
  // how issue #422 originally manifested.
  //
  // Citation rate and mention rate are independent signals (per the canonry
  // vocabulary rules in AGENTS.md): a query can be cited without being
  // mentioned, mentioned without being cited, or both. We compute both
  // here and surface them side-by-side in the executive summary.
  const totalQueryCount = queryLookup.byId.size
  const citedQueryIds = new Set<string>()
  const mentionedQueryIds = new Set<string>()
  for (const snap of latestSnapshots) {
    if (!queryLookup.byId.has(snap.queryId)) continue
    if (snap.citationState === CitationStates.cited) citedQueryIds.add(snap.queryId)
    if (snap.answerMentioned) mentionedQueryIds.add(snap.queryId)
  }
  const citedQueryCount = citedQueryIds.size
  const mentionedQueryCount = mentionedQueryIds.size
  const citationRate = totalQueryCount > 0
    ? Math.round((citedQueryCount / totalQueryCount) * 100)
    : 0
  const mentionRate = totalQueryCount > 0
    ? Math.round((mentionedQueryCount / totalQueryCount) * 100)
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
    const latestRunOnTrend = representativeLatestRun?.id === latestPoint.runId
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

  const configuredLocations = project.locations
  const reportLocation = buildLocationMeta(representativeLatestRun?.location ?? null, configuredLocations)
  // Per-provider handling only makes sense relative to an actual run location.
  // For locationless runs, surfacing rows that say "Location appended to the
  // prompt" or "Sent as user_location" contradicts the headline ("none — the
  // queries went out verbatim"); leave the array empty so the renderer hides
  // the breakdown table.
  const providerLocationHandling = reportLocation
    ? buildProviderLocationHandling(citationScorecard.providers)
    : []

  const executiveSummary: ProjectReportDto['executiveSummary'] = {
    citationRate,
    citedQueryCount,
    totalQueryCount,
    mentionRate,
    mentionedQueryCount,
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
          periodStart: gscSection.periodStart,
          periodEnd: gscSection.periodEnd,
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
  }

  const actionPlan = buildReportActionPlan({
    canonicalDomain: project.canonicalDomain,
    competitorDomains,
    citationScorecard,
    aiSourceOrigin,
    gsc: gscSection,
    indexingHealth: indexingHealthSection,
    contentOpportunities,
    contentGaps,
    reportLocation,
    providerLocationHandling,
  })
  const clientSummary = buildClientSummary({
    canonicalDomain: project.canonicalDomain,
    reportLocation,
    executiveSummary,
    citationsTrend,
    whatsChanged,
    gsc: gscSection,
    actionPlan,
  })
  const agencyDiagnostics = buildAgencyDiagnostics({
    canonicalDomain: project.canonicalDomain,
    competitorDomains,
    citationScorecard,
    aiSourceOrigin,
    gsc: gscSection,
    indexingHealth: indexingHealthSection,
    contentOpportunities,
    contentGaps,
    reportLocation,
    providerLocationHandling,
    actionPlan,
  })

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
      periodDays,
    },
    executiveSummary,
    citationScorecard,
    competitorLandscape,
    mentionLandscape,
    aiSourceOrigin,
    gsc: gscSection,
    ga: gaSection,
    socialReferrals: socialSection,
    aiReferrals: aiReferralsSection,
    serverActivity: serverActivitySection,
    indexingHealth: indexingHealthSection,
    citationsTrend,
    whatsChanged,
    insights: insightList,
    recommendedNextSteps,
    actionPlan,
    clientSummary,
    agencyDiagnostics,
    contentOpportunities,
    contentGaps,
    groundingSources,
  }
}

function parseReportAudience(value: string | undefined): ReportAudience {
  if (value === undefined || value === 'agency') return 'agency'
  if (value === 'client') return 'client'
  throw validationError('"audience" must be "agency" or "client"')
}

function reportFilenameFor(
  project: ProjectReportDto['meta']['project'],
  generatedAt: string,
  audience: ReportAudience,
): string {
  const date = generatedAt.slice(0, 10)
  return `canonry-report-${project.name}-${audience}-${date}.html`
}

export async function reportRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string }; Querystring: { period?: string } }>('/projects/:name/report', async (request, reply) => {
    const periodDays = parseReportPeriodDays(request.query.period)
    const dto = buildProjectReport(app.db, request.params.name, periodDays)
    return reply.send(dto)
  })

  app.get<{ Params: { name: string }; Querystring: { audience?: string; period?: string } }>('/projects/:name/report.html', async (request, reply) => {
    const audience = parseReportAudience(request.query.audience)
    const periodDays = parseReportPeriodDays(request.query.period)
    const dto = buildProjectReport(app.db, request.params.name, periodDays)
    const html = renderReportHtml(dto, { audience })
    const filename = reportFilenameFor(dto.meta.project, dto.meta.generatedAt, audience)
    reply.header('Content-Type', 'text/html; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(html)
  })
}
