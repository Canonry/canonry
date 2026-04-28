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
  keywords,
  competitors as competitorsTable,
  querySnapshots,
  runs,
  gscSearchData,
  gaTrafficSnapshots,
  gaAiReferrals,
  parseJsonColumn,
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
  type ProviderName,
} from '@ainyc/canonry-contracts'

const RECENT_RUNS_WINDOW = 5

interface ProjectRow {
  id: string
  canonicalDomain: string
  ownedDomains?: string | null
}

export function loadOrchestratorInput(db: DatabaseClient, project: ProjectRow): OrchestratorInput {
  const projectId = project.id
  const ownDomain = normalizeDomain(project.canonicalDomain)
  const ownedDomains = parseJsonColumn<string[]>(project.ownedDomains, [])
  const ourDomains = new Set([ownDomain, ...ownedDomains.map(normalizeDomain)])

  const trackedKeywords = listKeywords(db, projectId)
  const candidateQueryStrings = trackedKeywords.filter(isBlogShapedQuery)

  const trackedCompetitors = listCompetitorDomains(db, projectId).map(normalizeDomain)
  const competitorSet = new Set(trackedCompetitors)

  const recentRunIds = listRecentAnswerVisibilityRunIds(db, projectId, RECENT_RUNS_WINDOW)
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

  return {
    projectId,
    ownDomain,
    competitors: trackedCompetitors,
    candidateQueries,
    inventory,
    wpSchemaAudit: new Map(),
    gaTrafficByPage,
    totalAiReferralSessions,
    latestRunId,
    latestRunTimestamp,
    inProgressActions: new Map<string, ExistingActionRef>(),
  }
}

// ─── Per-domain helpers (each is a tiny focused query) ──────────────────────

function listKeywords(db: DatabaseClient, projectId: string): string[] {
  const rows = db
    .select({ text: keywords.keyword })
    .from(keywords)
    .where(eq(keywords.projectId, projectId))
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
): string[] {
  const rows = db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(runs.kind, RunKinds['answer-visibility']),
        // Queued/running/failed/cancelled runs may have partial or no
        // snapshots; including them risks pointing latestRunId at a run with
        // no usable evidence.
        inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(limit)
    .all()
  return rows.map((r) => r.id)
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

function sumAiReferralSessions(db: DatabaseClient, projectId: string): number {
  const rows = db
    .select({ sessions: gaAiReferrals.sessions })
    .from(gaAiReferrals)
    .where(eq(gaAiReferrals.projectId, projectId))
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

  const keywordRows = opts.db
    .select({ id: keywords.id, text: keywords.keyword })
    .from(keywords)
    .where(eq(keywords.projectId, opts.projectId))
    .all()

  const keywordIdByText = new Map(keywordRows.map((r) => [r.text, r.id]))
  const candidateKeywordIds = opts.candidateQueryStrings
    .map((q) => keywordIdByText.get(q))
    .filter((id): id is string => Boolean(id))

  const snapshotRows = opts.db
    .select()
    .from(querySnapshots)
    .where(inArray(querySnapshots.runId, opts.recentRunIds))
    .all()
    .filter((r) => candidateKeywordIds.includes(r.keywordId))

  const snapshotsByKeyword = new Map<string, typeof snapshotRows>()
  for (const row of snapshotRows) {
    const list = snapshotsByKeyword.get(row.keywordId) ?? []
    list.push(row)
    snapshotsByKeyword.set(row.keywordId, list)
  }

  const gscRows = opts.db
    .select()
    .from(gscSearchData)
    .where(eq(gscSearchData.projectId, opts.projectId))
    .all()
  const gscByQuery = aggregateGscByQuery(gscRows)

  return opts.candidateQueryStrings.map((query) => {
    const keywordId = keywordIdByText.get(query)
    const snaps = keywordId ? snapshotsByKeyword.get(keywordId) ?? [] : []
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

function aggregateGscByQuery(
  rows: Array<{
    query: string
    page: string
    impressions: number
    clicks: number
    ctr: string
    position: string
  }>,
): Map<string, AggregateGscEntry> {
  const byQuery = new Map<string, AggregateGscEntry>()
  for (const r of rows) {
    const existing = byQuery.get(r.query)
    const candidate: AggregateGscEntry = {
      // GSC stores `page` as a full URL for url-prefix properties; normalize to
      // a path so it can be joined against `gaTrafficByPage` (which is keyed by
      // path) and so `ourBestPage.url` / `targetRef` stay consistent regardless
      // of whether the page is sourced from GSC or from inventory.
      page: extractPath(r.page),
      position: Number(r.position) || 0,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: Number(r.ctr) || 0,
    }
    if (!existing) {
      byQuery.set(r.query, candidate)
      continue
    }
    if (candidate.impressions > existing.impressions) {
      byQuery.set(r.query, candidate)
    }
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
  let ourCitedInLatestRun = false

  for (const snap of opts.snapshots) {
    const isLatestRun = snap.runId === opts.latestRunId
    const competitorOverlap = parseJsonColumn<string[]>(snap.competitorOverlap, [])
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
    runsOfHistory: 0,
  }
}

function extractGroundingSources(rawResponse: string | null): GroundingSource[] {
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

function extractHostFromUri(uri: string): string {
  try {
    return new URL(uri).hostname
  } catch {
    return ''
  }
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
}

function extractPath(url: string): string {
  if (!url) return ''
  const match = /^https?:\/\/[^/]+(.*)$/.exec(url.trim())
  const path = match ? match[1] : url.trim()
  const stripped = path.replace(/\/+$/, '')
  return stripped || '/'
}

export type { SitePage, OrchestratorInput, CandidateQuery, ExistingActionRef }
