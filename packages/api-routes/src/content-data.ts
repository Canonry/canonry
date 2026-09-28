/**
 * Data layer for the content recommendation engine.
 *
 * Drizzle queries that hydrate the pure orchestrator (intelligence/content-targets.ts)
 * with everything it needs in one place. Returns plain objects (no Drizzle row
 * types leak through). Fully synchronous — better-sqlite3 .all()/.get() are sync.
 *
 * v1: schema audit data is always empty (no WP audit-persistence layer yet).
 * `add-schema` action is supported in types but never fires until that lands.
 */

import { and, eq, desc, gte, inArray, lte } from 'drizzle-orm'
import {
  mergeGscQueryTotalsWithFallback,
  readGscQueryDailyRows,
  readLatestGscDataDate,
  type GscQueryDayRow,
} from './gsc-totals.js'
import {
  filterTrackedSnapshots,
  queries,
  competitors as competitorsTable,
  querySnapshots,
  runs,
  gscSearchData,
  gaTrafficSnapshots,
  gaAiReferrals,
  domainClassifications,
} from '@ainyc/canonry-db'
import type { DatabaseClient } from '@ainyc/canonry-db'
import {
  buildInventory,
  type CandidateQuery,
  type GroundingUrlEvidence,
  type ExistingActionRef,
  type OrchestratorInput,
  type SitePage,
  isBlogShapedQuery,
  compileCompetitiveSignalResolver,
} from '@ainyc/canonry-intelligence'
import {
  CitationStates,
  hostMatchesDomain,
  hostOf,
  RunKinds,
  RunStatuses,
  type GroundingSource,
  type LocationContext,
  type ProviderName,
  type DiscoveryCompetitorType,
} from '@ainyc/canonry-contracts'
import { notProbeRun } from './helpers.js'

const RECENT_RUNS_WINDOW = 5

interface ProjectRow {
  id: string
  canonicalDomain: string
  ownedDomains?: string[] | null
  locations?: LocationContext[] | null
}

/**
 * Optional location scope for the orchestrator window.
 *
 * - `undefined` — no filter; include runs at every location (default for
 *   non-report callers like the standalone /content endpoints, which have
 *   no "latest run" anchor to scope against).
 * - `null` — match locationless runs only (the latest run had no location
 *   set, so the trend should compare against other locationless runs).
 * - string — match that exact location label.
 */
export type LocationScope = string | null | undefined

export function loadOrchestratorInput(
  db: DatabaseClient,
  project: ProjectRow,
  locationFilter: LocationScope = undefined,
  gscWindowDays: number = DEFAULT_CONTENT_GSC_WINDOW_DAYS,
): OrchestratorInput {
  const projectId = project.id
  const ownDomain = hostOf(project.canonicalDomain) ?? ''
  const ownedDomains = project.ownedDomains ?? []
  const ourDomains = new Set([ownDomain, ...ownedDomains.map(domain => hostOf(domain) ?? '')])

  const trackedQueries = listQueries(db, projectId)
  const candidateQueryStrings = trackedQueries.filter(isBlogShapedQuery)

  const trackedCompetitors = listCompetitorDomains(db, projectId).map(domain => hostOf(domain) ?? '')
  const competitorSet = new Set(trackedCompetitors)

  // Limit the orchestrator window to runs at the latest run's location so
  // content opportunities and gaps reflect the same geographic context as
  // the rest of the report. Without this, a report scoped to "michigan"
  // would surface gaps that live in florida runs and vice versa.
  const recentRunIds = listRecentAnswerVisibilityRunIds(db, projectId, RECENT_RUNS_WINDOW, locationFilter)
  const latestRunId = recentRunIds[0] ?? ''
  const latestRunTimestamp = latestRunId ? lookupRunTimestamp(db, latestRunId) : ''

  const candidateQueries = buildCandidateQueries({
    db,
    projectId,
    candidateQueryStrings,
    recentRunIds,
    latestRunId,
    ourDomains,
    competitorSet,
    gscWindowDays,
  })

  const inventory = buildInventory({
    gscPages: listGscPagesForProject(db, projectId),
    ga4LandingPages: listGa4LandingPagesForProject(db, projectId),
    sitemapUrls: [],
    wpPosts: [],
  })

  const gaWindow = resolveContentGaWindow(db, projectId, gscWindowDays)
  const gaTrafficByPage = buildGaTrafficByPage(db, projectId, gaWindow)
  const totalAiReferralSessions = sumAiReferralSessions(db, projectId, gaWindow)
  const domainClasses = loadDomainClasses(db, projectId)

  return {
    projectId,
    ownDomain,
    competitors: trackedCompetitors,
    candidateQueries,
    queryIntentModifiers: buildQueryIntentModifiers(project, locationFilter),
    inventory,
    wpSchemaAudit: new Map(),
    gaTrafficByPage,
    totalAiReferralSessions,
    latestRunId,
    latestRunTimestamp,
    inProgressActions: new Map<string, ExistingActionRef>(),
    domainClasses,
  }
}

/**
 * Load every cited-surface domain classification discovery has produced for the
 * project, keyed by normalized domain. Powers the winnabilityClass winnability gate
 * without re-running discovery. Returns an empty map when discovery has never
 * run — the gate then fails open to `ownable` everywhere.
 */
function loadDomainClasses(db: DatabaseClient, projectId: string): Map<string, DiscoveryCompetitorType> {
  const rows = db
    .select({ domain: domainClassifications.domain, competitorType: domainClassifications.competitorType })
    .from(domainClassifications)
    .where(eq(domainClassifications.projectId, projectId))
    .all()
  return new Map(rows.map((r) => [hostOf(r.domain) ?? '', r.competitorType]))
}

function buildQueryIntentModifiers(project: ProjectRow, locationFilter: LocationScope): string[] {
  if (locationFilter === undefined || locationFilter === null) return []
  const locations = project.locations ?? []
  const currentLocation = locations.find(location => location.label === locationFilter)
  const raw = currentLocation
    ? [
        currentLocation.label,
        currentLocation.city,
        currentLocation.region,
        regionAbbreviation(currentLocation.region),
        currentLocation.country,
      ]
    : [locationFilter]
  return [...new Set(raw.map(value => value.trim().toLowerCase()).filter(Boolean))]
}

function regionAbbreviation(region: string): string {
  return US_REGION_ABBREVIATIONS[region.trim().toLowerCase()] ?? ''
}

const US_REGION_ABBREVIATIONS: Record<string, string> = {
  alabama: 'al',
  alaska: 'ak',
  arizona: 'az',
  arkansas: 'ar',
  california: 'ca',
  colorado: 'co',
  connecticut: 'ct',
  delaware: 'de',
  florida: 'fl',
  georgia: 'ga',
  hawaii: 'hi',
  idaho: 'id',
  illinois: 'il',
  indiana: 'in',
  iowa: 'ia',
  kansas: 'ks',
  kentucky: 'ky',
  louisiana: 'la',
  maine: 'me',
  maryland: 'md',
  massachusetts: 'ma',
  michigan: 'mi',
  minnesota: 'mn',
  mississippi: 'ms',
  missouri: 'mo',
  montana: 'mt',
  nebraska: 'ne',
  nevada: 'nv',
  'new hampshire': 'nh',
  'new jersey': 'nj',
  'new mexico': 'nm',
  'new york': 'ny',
  'north carolina': 'nc',
  'north dakota': 'nd',
  ohio: 'oh',
  oklahoma: 'ok',
  oregon: 'or',
  pennsylvania: 'pa',
  'rhode island': 'ri',
  'south carolina': 'sc',
  'south dakota': 'sd',
  tennessee: 'tn',
  texas: 'tx',
  utah: 'ut',
  vermont: 'vt',
  virginia: 'va',
  washington: 'wa',
  'west virginia': 'wv',
  wisconsin: 'wi',
  wyoming: 'wy',
}

// ─── Per-domain helpers (each is a tiny focused query) ──────────────────────

function listQueries(db: DatabaseClient, projectId: string): string[] {
  const rows = db
    .select({ text: queries.query })
    .from(queries)
    .where(eq(queries.projectId, projectId))
    .all()
  return rows.map((r) => r.text)
}

function listCompetitorDomains(db: DatabaseClient, projectId: string): string[] {
  const rows = db
    .select({ domain: competitorsTable.domain })
    .from(competitorsTable)
    .where(eq(competitorsTable.projectId, projectId))
    .all()
  return rows.map((r) => r.domain)
}

function listRecentAnswerVisibilityRunIds(
  db: DatabaseClient,
  projectId: string,
  limit: number,
  locationFilter: LocationScope,
): string[] {
  // Filtering by location at the application layer (not in SQL) keeps the
  // null-matches-null semantics consistent across all callers — Drizzle's
  // `eq()` would treat `null` as "always false", so a no-location project
  // would match nothing. `undefined` means "no filter".
  const rows = db
    .select({ id: runs.id, location: runs.location })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(runs.kind, RunKinds['answer-visibility']),
        // Queued/running/failed/cancelled runs may have partial or no
        // snapshots; including them risks pointing latestRunId at a run with
        // no usable evidence.
        inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]),
        // Probe runs are operator/agent test runs; they must not poison the
        // recent-runs window the content engine uses to recommend actions.
        notProbeRun(),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .all()
  const filtered = locationFilter === undefined
    ? rows
    : rows.filter((r) => (r.location ?? null) === locationFilter)
  return filtered.slice(0, limit).map((r) => r.id)
}

function lookupRunTimestamp(db: DatabaseClient, runId: string): string {
  const row = db.select({ createdAt: runs.createdAt }).from(runs).where(eq(runs.id, runId)).get()
  return row?.createdAt ?? ''
}

function listGscPagesForProject(db: DatabaseClient, projectId: string): string[] {
  const rows = db
    .selectDistinct({ page: gscSearchData.page })
    .from(gscSearchData)
    .where(eq(gscSearchData.projectId, projectId))
    .all()
  return rows.map((r) => r.page)
}

function listGa4LandingPagesForProject(db: DatabaseClient, projectId: string): string[] {
  const rows = db
    .selectDistinct({ landingPage: gaTrafficSnapshots.landingPage })
    .from(gaTrafficSnapshots)
    .where(eq(gaTrafficSnapshots.projectId, projectId))
    .all()
  return rows.map((r) => r.landingPage)
}

/**
 * Organic sessions per landing page, over the analytics window.
 *
 * Two things this must not do. It must not read every retained row: the figure
 * is printed as `ourBestPage.organicSessions` under the report's window
 * heading, and unbounded it summed a project's whole history (one property:
 * 142 days into a number labelled 30). And it must sum `organicSessions`, not
 * `sessions`, because the field it feeds is the organic one; summing total
 * sessions produced a per-page figure larger than the property's own total.
 */
function buildGaTrafficByPage(
  db: DatabaseClient,
  projectId: string,
  window: { startDate: string, endDate: string } | null,
): Map<string, number> {
  if (!window) return new Map()
  const rows = db
    .select({
      landingPage: gaTrafficSnapshots.landingPage,
      organicSessions: gaTrafficSnapshots.organicSessions,
    })
    .from(gaTrafficSnapshots)
    .where(and(
      eq(gaTrafficSnapshots.projectId, projectId),
      gte(gaTrafficSnapshots.date, window.startDate),
      lte(gaTrafficSnapshots.date, window.endDate),
    ))
    .all()

  const map = new Map<string, number>()
  for (const row of rows) {
    const path = extractPath(row.landingPage)
    if (!path) continue
    map.set(path, (map.get(path) ?? 0) + (row.organicSessions ?? 0))
  }
  return map
}

/**
 * Analytics window for the content engine, anchored on the newest day GA has
 * data for rather than the wall clock, so a sync that is a day or two behind
 * does not silently shorten the span. Null when the project has no GA data.
 */
function resolveContentGaWindow(
  db: DatabaseClient,
  projectId: string,
  windowDays: number,
): { startDate: string, endDate: string } | null {
  const latest = db
    .select({ date: gaTrafficSnapshots.date })
    .from(gaTrafficSnapshots)
    .where(eq(gaTrafficSnapshots.projectId, projectId))
    .orderBy(desc(gaTrafficSnapshots.date))
    .limit(1)
    .get()
  if (!latest?.date) return null
  const end = new Date(`${latest.date}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() - (Math.max(1, windowDays) - 1))
  return { startDate: end.toISOString().slice(0, 10), endDate: latest.date }
}

/**
 * Total AI-referral sessions for the project.
 *
 * Pinned to the `session` attribution lens. `ga_ai_referrals` holds one row per
 * `sourceDimension` — `session`, `first_user` and `manual_utm` are three
 * OVERLAPPING views of the same visits, fetched as three separate GA4 reports,
 * not three disjoint groups of traffic. Summing across them multiplies the
 * total by roughly the number of lenses (measured 800 vs 264, a 3.0x inflation,
 * on a live project).
 *
 * Every other consumer already guards this: `report.ts` pins `session` and
 * `ga.ts` takes the winning lens per tuple via `pickWinningDimension`. Pinning
 * the same lens here keeps the content engine's denominator consistent with the
 * report's numerator.
 */
function sumAiReferralSessions(
  db: DatabaseClient,
  projectId: string,
  window: { startDate: string, endDate: string } | null,
): number {
  if (!window) return 0
  const rows = db
    .select({ sessions: gaAiReferrals.sessions })
    .from(gaAiReferrals)
    .where(
      and(
        eq(gaAiReferrals.projectId, projectId),
        eq(gaAiReferrals.sourceDimension, 'session'),
        // Bounded for the same reason the per-page read is: this scales every
        // opportunity score, so a lifetime total quietly weights the ranking
        // toward whatever was true months ago.
        gte(gaAiReferrals.date, window.startDate),
        lte(gaAiReferrals.date, window.endDate),
      ),
    )
    .all()
  return rows.reduce((acc, r) => acc + (r.sessions ?? 0), 0)
}

// ─── Candidate-query aggregation ────────────────────────────────────────────

interface BuildCandidateQueriesOpts {
  db: DatabaseClient
  projectId: string
  candidateQueryStrings: string[]
  recentRunIds: string[]
  latestRunId: string
  ourDomains: Set<string>
  competitorSet: Set<string>
  /** Days of GSC history to score demand over. See resolveContentGscWindow. */
  gscWindowDays: number
}

function buildCandidateQueries(opts: BuildCandidateQueriesOpts): CandidateQuery[] {
  if (opts.candidateQueryStrings.length === 0 || opts.recentRunIds.length === 0) {
    return opts.candidateQueryStrings.map((query) => emptyCandidate(query))
  }

  const queryRows = opts.db
    .select({ id: queries.id, text: queries.query })
    .from(queries)
    .where(eq(queries.projectId, opts.projectId))
    .all()

  const queryIdByText = new Map(queryRows.map((r) => [r.text, r.id]))
  const candidateQueryIds = opts.candidateQueryStrings
    .map((q) => queryIdByText.get(q))
    .filter((id): id is string => Boolean(id))

  // Drop orphan snapshots (queryId NULL post-v58) before the candidate
  // filter — `.includes()` typed `string[]` won't accept `string | null`.
  const snapshotRows = filterTrackedSnapshots(opts.db
    .select()
    .from(querySnapshots)
    .where(inArray(querySnapshots.runId, opts.recentRunIds))
    .all())
    .filter((r) => candidateQueryIds.includes(r.queryId))

  const snapshotsByQuery = new Map<string, typeof snapshotRows>()
  for (const row of snapshotRows) {
    const list = snapshotsByQuery.get(row.queryId) ?? []
    list.push(row)
    snapshotsByQuery.set(row.queryId, list)
  }

  // Two separate reads, because the two tables answer different questions.
  //
  // Impressions, clicks, CTR and position come from gsc_query_daily_totals,
  // which is keyed (date, query). gsc_search_data is keyed
  // (date, query, page, country, device), so one SERP impression fans out into
  // a row per ranking page and summing it over-counts badly. On a live property
  // one query summed to several times its true all-time impressions, far above
  // its 30-day window (illustrative figures: 120,400 summed, 21,300 true
  // all-time, 1,240 in the reported 30-day window). Both
  // errors were compounding, since this read also had no date bound at all and
  // presented lifetime demand under the report's window heading.
  //
  // gsc_search_data is still the right source for `bestPage`: attributing a
  // query to a landing page genuinely needs the page dimension. It is now
  // windowed to match.
  const gscWindow = resolveContentGscWindow(opts.db, opts.projectId, opts.gscWindowDays)
  const pageRows = gscWindow
    ? opts.db
        .select()
        .from(gscSearchData)
        .where(and(
          eq(gscSearchData.projectId, opts.projectId),
          gte(gscSearchData.date, gscWindow.startDate),
          lte(gscSearchData.date, gscWindow.endDate),
        ))
        .all()
    : []
  const gscByQuery = aggregateGscByQuery(
    pageRows,
    gscWindow
      ? mergeGscQueryTotalsWithFallback(
          readGscQueryDailyRows(opts.db, opts.projectId, gscWindow.startDate, gscWindow.endDate),
          pageDayFallback(pageRows),
        )
      : [],
  )

  return opts.candidateQueryStrings.map((query) => {
    const queryId = queryIdByText.get(query)
    const snaps = queryId ? snapshotsByQuery.get(queryId) ?? [] : []
    const gsc = gscByQuery.get(query) ?? null
    return aggregateCandidate({
      query,
      snapshots: snaps,
      gsc,
      ourDomains: opts.ourDomains,
      competitorSet: opts.competitorSet,
      latestRunId: opts.latestRunId,
    })
  })
}

interface AggregateGscEntry {
  page: string
  position: number
  impressions: number
  clicks: number
  ctr: number
}

interface QueryAccumulator {
  // GSC stores `page` as a full URL for url-prefix properties; normalize to
  // a path so it can be joined against `gaTrafficByPage` (which is keyed by
  // path) and so `ourBestPage.url` / `targetRef` stay consistent regardless
  // of whether the page is sourced from GSC or from inventory.
  bestPage: string
  bestPageImpressions: number
  totalClicks: number
  totalImpressions: number
  weightedPositionSum: number
}

/**
 * Days of GSC history the content engine scores demand over when the caller
 * does not say. Matches the report's default period so an opportunity's
 * "impressions" means the same span as the rest of the page it is printed on.
 */
export const DEFAULT_CONTENT_GSC_WINDOW_DAYS = 30

/**
 * Anchor the window on the newest day GSC has actually published for this
 * project, not on the wall clock. Google finalises a day two to three days
 * late, so a clock-anchored window silently ends in a partial or empty span.
 * Returns null when the project has no GSC data at all.
 */
export function windowEndingOn(endDate: string, windowDays: number): { startDate: string, endDate: string } {
  const end = new Date(`${endDate}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() - (Math.max(1, windowDays) - 1))
  return { startDate: end.toISOString().slice(0, 10), endDate }
}

function resolveContentGscWindow(
  db: DatabaseClient,
  projectId: string,
  windowDays: number,
): { startDate: string, endDate: string } | null {
  const endDate = readLatestGscDataDate(db, projectId)
  return endDate ? windowEndingOn(endDate, windowDays) : null
}

/**
 * Collapse page rows to one row per (date, query) so they can stand in for
 * gsc_query_daily_totals on days that table has not been backfilled. Clicks are
 * additive across pages; impressions are not, so this remains an over-count and
 * is only ever a fallback for days with no accurate row.
 */
function pageDayFallback(
  rows: Array<{ date: string, query: string, impressions: number, clicks: number, position: string }>,
): GscQueryDayRow[] {
  const byDay = new Map<string, { date: string, query: string, clicks: number, impressions: number, weighted: number }>()
  for (const r of rows) {
    if (!r.query) continue
    const key = `${r.date}\u0000${r.query}`
    const acc = byDay.get(key) ?? { date: r.date, query: r.query, clicks: 0, impressions: 0, weighted: 0 }
    acc.clicks += r.clicks
    acc.impressions += r.impressions
    acc.weighted += (Number(r.position) || 0) * r.impressions
    byDay.set(key, acc)
  }
  return [...byDay.values()].map(a => ({
    date: a.date,
    query: a.query,
    clicks: a.clicks,
    impressions: a.impressions,
    position: a.impressions > 0 ? a.weighted / a.impressions : 0,
  }))
}

export function aggregateGscByQuery(
  rows: Array<{
    query: string
    page: string
    impressions: number
    clicks: number
    ctr: string
    position: string
  }>,
  /**
   * Per-query totals from gsc_query_daily_totals. When a query appears here its
   * impressions, clicks, CTR and position are taken from this aggregate; the
   * page rows only choose `bestPage`. Pass an empty array to fall back to the
   * page-summed figures, which is the legacy behaviour and is wrong for any
   * query that ranks on more than one page.
   */
  queryTotals: readonly { query: string, impressions: number, clicks: number, position: number }[] = [],
): Map<string, AggregateGscEntry> {
  const accurateByQuery = new Map(queryTotals.map(t => [t.query, t]))
  const accumulators = new Map<string, QueryAccumulator>()
  for (const r of rows) {
    const page = extractPath(r.page)
    const position = Number(r.position) || 0
    const existing = accumulators.get(r.query)
    if (!existing) {
      accumulators.set(r.query, {
        bestPage: page,
        bestPageImpressions: r.impressions,
        totalClicks: r.clicks,
        totalImpressions: r.impressions,
        weightedPositionSum: position * r.impressions,
      })
      continue
    }
    existing.totalClicks += r.clicks
    existing.totalImpressions += r.impressions
    existing.weightedPositionSum += position * r.impressions
    if (r.impressions > existing.bestPageImpressions) {
      existing.bestPage = page
      existing.bestPageImpressions = r.impressions
    }
  }

  const byQuery = new Map<string, AggregateGscEntry>()
  for (const [query, acc] of accumulators) {
    // CTR and average position must come from the aggregates, not from any
    // single row. GSC splits a query across many dimension rows (page,
    // country, device, date); a single click usually lands on one row with
    // ctr=1.0 while the bulk of impressions sit on separate ctr=0 rows. The
    // old "pick the row with the most impressions" logic almost always
    // selected a row with no clicks, so per-query CTR rendered as 0%.
    const accurate = accurateByQuery.get(query)
    const impressions = accurate ? accurate.impressions : acc.totalImpressions
    const clicks = accurate ? accurate.clicks : acc.totalClicks
    const position = accurate
      ? accurate.position
      : (acc.totalImpressions > 0 ? acc.weightedPositionSum / acc.totalImpressions : 0)
    byQuery.set(query, {
      page: acc.bestPage,
      position,
      impressions,
      clicks,
      ctr: impressions > 0 ? clicks / impressions : 0,
    })
  }
  return byQuery
}

interface AggregateCandidateOpts {
  query: string
  snapshots: Array<typeof querySnapshots.$inferSelect>
  gsc: AggregateGscEntry | null
  ourDomains: Set<string>
  competitorSet: Set<string>
  latestRunId: string
}

function aggregateCandidate(opts: AggregateCandidateOpts): CandidateQuery {
  const totalSnaps = opts.snapshots.length
  if (totalSnaps === 0) {
    return {
      ...emptyCandidate(opts.query),
      gscPage: opts.gsc?.page ?? null,
      gscPosition: opts.gsc ? opts.gsc.position : null,
      gscImpressions: opts.gsc?.impressions ?? 0,
      gscClicks: opts.gsc?.clicks ?? 0,
      gscCtr: opts.gsc?.ctr ?? 0,
    }
  }

  const citedCount = opts.snapshots.filter((s) => s.citationState === CitationStates.cited).length
  const ourCitedRate = citedCount / totalSnaps
  const recentMissRate = 1 - ourCitedRate

  // TWO tallies, because a competitor can be cited, named in the prose, or
  // both, and the two observations must remain independent.
  const competitorTally = new Map<string, number>()
  const competitorMentionTally = new Map<string, number>()
  const competitiveSignalResolver = compileCompetitiveSignalResolver([...opts.competitorSet])
  const competitorGroundingTally = new Map<string, GroundingUrlEvidence>()
  const ourGroundingTally = new Map<string, GroundingUrlEvidence>()
  // Full cited surface: every non-own cited domain → citation count, NOT
  // filtered to tracked competitors. Aggregators/editorial are usually not
  // tracked competitors, so the winnabilityClass gate must read this, not the
  // tracked-only `competitorGroundingTally`.
  const citedSurfaceTally = new Map<string, number>()
  let ourCitedInLatestRun = false

  for (const snap of opts.snapshots) {
    const isLatestRun = snap.runId === opts.latestRunId
    const grounding = extractGroundingSources(snap.rawResponse)
    const competitiveSignals = competitiveSignalResolver.resolve({
      citedDomains: snap.citedDomains,
      groundingSources: grounding,
      answerText: snap.answerText,
    })
    // `competitorCitationCount` is a CITATION count, so it reads the engine's
    // source material — `citedDomains` and the grounding sources, which is what
    // `determineCitationState` also treats as cited. It does NOT read
    // `competitor_overlap`: that column additionally unions answer-text brand
    // matches, and a mention counted under a citation name is the exact
    // conflation the vocabulary rules forbid.
    //
    // Deduped per snapshot, so a competitor cited three times in one answer
    // counts once — matching the per-snapshot semantics of every other
    // competitor figure.
    const citedCompetitorsHere = new Set<string>()
    for (const competitor of competitiveSignals.citedCompetitorDomains) {
      citedCompetitorsHere.add(competitor)
    }
    for (const competitor of competitiveSignals.mentionedCompetitorDomains) {
      competitorMentionTally.set(competitor, (competitorMentionTally.get(competitor) ?? 0) + 1)
    }

    for (const g of grounding) {
      const domain = hostOf(g.uri) ?? ''
      if (!domain) continue
      if (findMatchingDomain(domain, opts.ourDomains)) {
        if (isLatestRun) ourCitedInLatestRun = true
        recordGroundingHit(ourGroundingTally, g, domain, snap.provider)
        continue
      }
      // Count toward the full cited surface before the tracked-competitor gate.
      citedSurfaceTally.set(domain, (citedSurfaceTally.get(domain) ?? 0) + 1)
      const competitor = findMatchingDomain(domain, opts.competitorSet)
      if (!competitor) continue
      citedCompetitorsHere.add(competitor)
      recordGroundingHit(competitorGroundingTally, g, domain, snap.provider)
    }
    for (const competitor of citedCompetitorsHere) {
      competitorTally.set(competitor, (competitorTally.get(competitor) ?? 0) + 1)
    }
  }

  return {
    query: opts.query,
    gscPage: opts.gsc?.page ?? null,
    gscPosition: opts.gsc ? opts.gsc.position : null,
    gscImpressions: opts.gsc?.impressions ?? 0,
    gscClicks: opts.gsc?.clicks ?? 0,
    gscCtr: opts.gsc?.ctr ?? 0,
    ourCitedRate,
    ourCitedInLatestRun,
    competitorCitedDomains: Array.from(competitorTally.keys()),
    competitorMentionedDomains: Array.from(competitorMentionTally.keys()),
    competitorCitationCount: Array.from(competitorTally.values()).reduce((a, b) => a + b, 0),
    competitorMentionCount: Array.from(competitorMentionTally.values()).reduce((a, b) => a + b, 0),
    recentMissRate,
    ourGroundingUrls: Array.from(ourGroundingTally.values()),
    competitorGroundingUrls: Array.from(competitorGroundingTally.values()),
    citedSurfaceDomains: Array.from(citedSurfaceTally.entries()).map(([domain, citationCount]) => ({ domain, citationCount })),
    runsOfHistory: new Set(opts.snapshots.map((s) => s.runId)).size,
  }
}

function findMatchingDomain(candidate: string, domains: ReadonlySet<string>): string | undefined {
  return [...domains].find(domain => hostMatchesDomain(candidate, domain))
}

function recordGroundingHit(
  tally: Map<string, GroundingUrlEvidence>,
  g: GroundingSource,
  domain: string,
  provider: string | null,
): void {
  const existing = tally.get(g.uri)
  if (existing) {
    existing.citationCount += 1
    if (provider && !existing.providers.includes(provider as ProviderName)) {
      existing.providers.push(provider as ProviderName)
    }
    return
  }
  tally.set(g.uri, {
    uri: g.uri,
    title: g.title,
    domain,
    citationCount: 1,
    providers: provider ? [provider as ProviderName] : [],
  })
}

function emptyCandidate(query: string): CandidateQuery {
  return {
    query,
    gscPage: null,
    gscPosition: null,
    gscImpressions: 0,
    gscClicks: 0,
    gscCtr: 0,
    ourCitedRate: 0,
    ourCitedInLatestRun: false,
    competitorCitedDomains: [],
    competitorMentionedDomains: [],
    competitorCitationCount: 0,
    competitorMentionCount: 0,
    recentMissRate: 0,
    ourGroundingUrls: [],
    competitorGroundingUrls: [],
    citedSurfaceDomains: [],
    runsOfHistory: 0,
  }
}

export function extractGroundingSources(rawResponse: string | null): GroundingSource[] {
  if (!rawResponse) return []
  try {
    const parsed = JSON.parse(rawResponse) as unknown
    if (parsed && typeof parsed === 'object' && 'groundingSources' in parsed) {
      const grounding = (parsed as { groundingSources?: unknown }).groundingSources
      if (Array.isArray(grounding)) {
        return grounding
          .filter(
            (g): g is { uri: string; title?: string } =>
              typeof g === 'object' && g !== null && typeof (g as { uri?: unknown }).uri === 'string',
          )
          .map((g) => ({ uri: g.uri, title: g.title ?? '' }))
      }
    }
  } catch {
    // ignore — malformed rawResponse just yields no grounding sources
  }
  return []
}

function extractPath(url: string): string {
  if (!url) return ''
  const trimmed = url.trim()
  let path: string
  try {
    path = new URL(trimmed).pathname
  } catch {
    path = trimmed
  }
  const stripped = path.replace(/\/+$/, '')
  return stripped || '/'
}

export type { SitePage, OrchestratorInput, CandidateQuery, ExistingActionRef }
