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

import { and, eq, desc, inArray } from 'drizzle-orm'
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
} from '@ainyc/canonry-intelligence'
import {
  CitationStates,
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
): OrchestratorInput {
  const projectId = project.id
  const ownDomain = normalizeDomain(project.canonicalDomain)
  const ownedDomains = project.ownedDomains ?? []
  const ourDomains = new Set([ownDomain, ...ownedDomains.map(normalizeDomain)])

  const trackedQueries = listQueries(db, projectId)
  const candidateQueryStrings = trackedQueries.filter(isBlogShapedQuery)

  const trackedCompetitors = listCompetitorDomains(db, projectId).map(normalizeDomain)
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
  })

  const inventory = buildInventory({
    gscPages: listGscPagesForProject(db, projectId),
    ga4LandingPages: listGa4LandingPagesForProject(db, projectId),
    sitemapUrls: [],
    wpPosts: [],
  })

  const gaTrafficByPage = buildGaTrafficByPage(db, projectId)
  const totalAiReferralSessions = sumAiReferralSessions(db, projectId)
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
  return new Map(rows.map((r) => [normalizeDomain(r.domain), r.competitorType]))
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

function buildGaTrafficByPage(db: DatabaseClient, projectId: string): Map<string, number> {
  const rows = db
    .select({
      landingPage: gaTrafficSnapshots.landingPage,
      sessions: gaTrafficSnapshots.sessions,
    })
    .from(gaTrafficSnapshots)
    .where(eq(gaTrafficSnapshots.projectId, projectId))
    .all()

  const map = new Map<string, number>()
  for (const row of rows) {
    const path = extractPath(row.landingPage)
    if (!path) continue
    map.set(path, (map.get(path) ?? 0) + (row.sessions ?? 0))
  }
  return map
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
function sumAiReferralSessions(db: DatabaseClient, projectId: string): number {
  const rows = db
    .select({ sessions: gaAiReferrals.sessions })
    .from(gaAiReferrals)
    .where(
      and(
        eq(gaAiReferrals.projectId, projectId),
        eq(gaAiReferrals.sourceDimension, 'session'),
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

  const gscRows = opts.db
    .select()
    .from(gscSearchData)
    .where(eq(gscSearchData.projectId, opts.projectId))
    .all()
  const gscByQuery = aggregateGscByQuery(gscRows)

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

export function aggregateGscByQuery(
  rows: Array<{
    query: string
    page: string
    impressions: number
    clicks: number
    ctr: string
    position: string
  }>,
): Map<string, AggregateGscEntry> {
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
    byQuery.set(query, {
      page: acc.bestPage,
      position: acc.totalImpressions > 0 ? acc.weightedPositionSum / acc.totalImpressions : 0,
      impressions: acc.totalImpressions,
      clicks: acc.totalClicks,
      ctr: acc.totalImpressions > 0 ? acc.totalClicks / acc.totalImpressions : 0,
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

  const competitorTally = new Map<string, number>()
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
    const competitorOverlap = snap.competitorOverlap
    for (const domain of competitorOverlap) {
      const normalized = normalizeDomain(domain)
      if (!opts.competitorSet.has(normalized)) continue
      competitorTally.set(normalized, (competitorTally.get(normalized) ?? 0) + 1)
    }

    const grounding = extractGroundingSources(snap.rawResponse)
    for (const g of grounding) {
      const domain = normalizeDomain(extractHostFromUri(g.uri))
      if (!domain) continue
      if (opts.ourDomains.has(domain)) {
        if (isLatestRun) ourCitedInLatestRun = true
        recordGroundingHit(ourGroundingTally, g, domain, snap.provider)
        continue
      }
      // Count toward the full cited surface before the tracked-competitor gate.
      citedSurfaceTally.set(domain, (citedSurfaceTally.get(domain) ?? 0) + 1)
      if (!opts.competitorSet.has(domain)) continue
      recordGroundingHit(competitorGroundingTally, g, domain, snap.provider)
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
    competitorDomains: Array.from(competitorTally.keys()),
    competitorCitationCount: Array.from(competitorTally.values()).reduce((a, b) => a + b, 0),
    recentMissRate,
    ourGroundingUrls: Array.from(ourGroundingTally.values()),
    competitorGroundingUrls: Array.from(competitorGroundingTally.values()),
    citedSurfaceDomains: Array.from(citedSurfaceTally.entries()).map(([domain, citationCount]) => ({ domain, citationCount })),
    runsOfHistory: new Set(opts.snapshots.map((s) => s.runId)).size,
  }
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
    competitorDomains: [],
    competitorCitationCount: 0,
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

export function extractHostFromUri(uri: string): string {
  try {
    return new URL(uri).hostname
  } catch {
    return ''
  }
}

export function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
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
