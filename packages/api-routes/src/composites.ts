import { eq, and, desc, sql, like, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  insights,
  healthSnapshots,
  queries,
  parseJsonColumn,
  projects,
  querySnapshots,
  runs,
} from '@ainyc/canonry-db'
import {
  parseRunError,
  type CitationState,
  type HealthSnapshotDto,
  type InsightDto,
  type LatestProjectRunDto,
  type LocationContext,
  type ProjectDto,
  type ProjectOverviewDto,
  type ProjectOverviewQueryCountsDto,
  type ProjectOverviewProviderEntryDto,
  type ProjectOverviewTransitionsDto,
  type ProjectSearchHitDto,
  type ProjectSearchInsightHitDto,
  type ProjectSearchResponseDto,
  type ProjectSearchSnapshotHitDto,
  type RunDetailDto,
  validationError,
} from '@ainyc/canonry-contracts'
import { resolveProject } from './helpers.js'

const TOP_INSIGHT_LIMIT = 5
const SEARCH_HIT_HARD_LIMIT = 50
const SEARCH_SNIPPET_RADIUS = 80

type SnapshotMatchedField = ProjectSearchSnapshotHitDto['matchedField']
type InsightMatchedField = ProjectSearchInsightHitDto['matchedField']

export async function compositeRoutes(app: FastifyInstance) {
  // GET /projects/:name/overview — composite read for "how is project X doing?".
  // Bundles project info, latest run, top insights, health, and a transitions
  // summary so agents don't fan out to four list endpoints to answer the
  // common opener.
  app.get<{ Params: { name: string } }>('/projects/:name/overview', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const totalRunsRow = app.db
      .select({ count: sql<number>`count(*)` })
      .from(runs)
      .where(eq(runs.projectId, project.id))
      .get()
    const totalRuns = totalRunsRow?.count ?? 0

    const recentRuns = app.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, project.id))
      .orderBy(desc(runs.createdAt))
      .limit(2)
      .all()

    const [latestRunRow, previousRunRow] = recentRuns

    const latestRun: LatestProjectRunDto = latestRunRow
      ? { totalRuns, run: summarizeRun(latestRunRow) }
      : { totalRuns: 0, run: null }

    const healthRow = app.db
      .select()
      .from(healthSnapshots)
      .where(eq(healthSnapshots.projectId, project.id))
      .orderBy(desc(healthSnapshots.createdAt))
      .limit(1)
      .get()
    const health: HealthSnapshotDto | null = healthRow ? mapHealthRow(healthRow) : null

    const insightRows = app.db
      .select()
      .from(insights)
      .where(eq(insights.projectId, project.id))
      .orderBy(desc(insights.createdAt))
      .all()
    const topInsights: InsightDto[] = insightRows
      .filter(row => !row.dismissed)
      .slice(0, TOP_INSIGHT_LIMIT)
      .map(mapInsightRow)

    const { queryCounts, providers } = summarizeLatestRun(app, latestRunRow ?? null)
    const transitions = summarizeTransitions(app, latestRunRow ?? null, previousRunRow ?? null)

    const result: ProjectOverviewDto = {
      project: formatProject(project),
      latestRun,
      health,
      topInsights,
      queryCounts,
      providers,
      transitions,
    }
    return reply.send(result)
  })

  // GET /projects/:name/search?q=... — composite search across query
  // snapshots and intelligence insights so agents can answer "find anything
  // mentioning X" in one call instead of paginating snapshots.
  app.get<{
    Params: { name: string }
    Querystring: { q?: string; limit?: string }
  }>('/projects/:name/search', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const rawQuery = (request.query.q ?? '').trim()
    if (rawQuery.length < 2) {
      throw validationError('"q" must be at least 2 characters')
    }
    const limit = clampSearchLimit(request.query.limit)
    const escaped = escapeLikePattern(rawQuery)
    const pattern = `%${escaped}%`

    const snapshotMatches = app.db
      .select({
        id: querySnapshots.id,
        runId: querySnapshots.runId,
        queryId: querySnapshots.queryId,
        queryText: queries.query,
        provider: querySnapshots.provider,
        model: querySnapshots.model,
        citationState: querySnapshots.citationState,
        answerText: querySnapshots.answerText,
        citedDomains: querySnapshots.citedDomains,
        rawResponse: querySnapshots.rawResponse,
        createdAt: querySnapshots.createdAt,
      })
      .from(querySnapshots)
      .innerJoin(queries, eq(querySnapshots.queryId, queries.id))
      .where(
        and(
          eq(queries.projectId, project.id),
          or(
            sql`${querySnapshots.answerText} LIKE ${pattern} ESCAPE '\\'`,
            sql`${querySnapshots.citedDomains} LIKE ${pattern} ESCAPE '\\'`,
            sql`${querySnapshots.rawResponse} LIKE ${pattern} ESCAPE '\\'`,
            like(queries.query, pattern),
          ),
        ),
      )
      .orderBy(desc(querySnapshots.createdAt))
      .limit(limit + 1)
      .all()

    const insightMatches = app.db
      .select()
      .from(insights)
      .where(
        and(
          eq(insights.projectId, project.id),
          or(
            like(insights.title, pattern),
            like(insights.query, pattern),
            sql`${insights.recommendation} LIKE ${pattern} ESCAPE '\\'`,
            sql`${insights.cause} LIKE ${pattern} ESCAPE '\\'`,
          ),
        ),
      )
      .orderBy(desc(insights.createdAt))
      .limit(limit + 1)
      .all()

    const hits: ProjectSearchHitDto[] = []
    for (const row of snapshotMatches) {
      hits.push(buildSnapshotHit(row, rawQuery))
    }
    for (const row of insightMatches) {
      hits.push(buildInsightHit(row, rawQuery))
    }

    hits.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const truncated = hits.length > limit
    const trimmed = truncated ? hits.slice(0, limit) : hits

    const response: ProjectSearchResponseDto = {
      query: rawQuery,
      totalHits: trimmed.length,
      truncated,
      hits: trimmed,
    }
    return reply.send(response)
  })
}

function clampSearchLimit(raw: string | undefined): number {
  if (!raw) return 25
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) return 25
  if (parsed < 1) return 1
  if (parsed > SEARCH_HIT_HARD_LIMIT) return SEARCH_HIT_HARD_LIMIT
  return parsed
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

// Run summary used inside the overview composite. Snapshots are intentionally
// omitted — agents that want them can call canonry_run_get with the returned id.
function summarizeRun(run: typeof runs.$inferSelect): RunDetailDto {
  return {
    id: run.id,
    projectId: run.projectId,
    kind: run.kind as RunDetailDto['kind'],
    status: run.status as RunDetailDto['status'],
    trigger: run.trigger as RunDetailDto['trigger'],
    location: run.location,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: parseRunError(run.error),
    createdAt: run.createdAt,
  }
}

function summarizeLatestRun(
  app: FastifyInstance,
  run: typeof runs.$inferSelect | null,
): { queryCounts: ProjectOverviewQueryCountsDto; providers: ProjectOverviewProviderEntryDto[] } {
  const empty = {
    queryCounts: { totalQueries: 0, citedQueries: 0, notCitedQueries: 0, citedRate: 0 } as ProjectOverviewQueryCountsDto,
    providers: [] as ProjectOverviewProviderEntryDto[],
  }
  if (!run) return empty

  const rows = app.db
    .select({
      queryId: querySnapshots.queryId,
      provider: querySnapshots.provider,
      citationState: querySnapshots.citationState,
    })
    .from(querySnapshots)
    .where(eq(querySnapshots.runId, run.id))
    .all()
  if (rows.length === 0) return empty

  // Roll up per-query: a query counts as cited if any provider cited it.
  // Mirrors the dashboard's query-status badge.
  const perQuery = new Map<string, boolean>()
  const perProvider = new Map<string, { cited: number; total: number }>()
  for (const row of rows) {
    const cited = row.citationState === 'cited'
    if (!perQuery.has(row.queryId) || cited) {
      perQuery.set(row.queryId, cited)
    }
    const bucket = perProvider.get(row.provider) ?? { cited: 0, total: 0 }
    bucket.total += 1
    if (cited) bucket.cited += 1
    perProvider.set(row.provider, bucket)
  }

  const totalQueries = perQuery.size
  let citedQueries = 0
  for (const wasCited of perQuery.values()) {
    if (wasCited) citedQueries += 1
  }
  const notCitedQueries = totalQueries - citedQueries
  const citedRate = totalQueries === 0 ? 0 : Number((citedQueries / totalQueries).toFixed(4))

  const providers: ProjectOverviewProviderEntryDto[] = [...perProvider.entries()]
    .map(([provider, { cited, total }]) => ({
      provider,
      cited,
      total,
      citedRate: total === 0 ? 0 : Number((cited / total).toFixed(4)),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider))

  return {
    queryCounts: { totalQueries, citedQueries, notCitedQueries, citedRate },
    providers,
  }
}

function summarizeTransitions(
  app: FastifyInstance,
  latest: typeof runs.$inferSelect | null,
  previous: typeof runs.$inferSelect | null,
): ProjectOverviewTransitionsDto {
  const empty: ProjectOverviewTransitionsDto = { since: null, gained: 0, lost: 0, emerging: 0 }
  if (!latest || !previous) return empty

  const fetchCited = (runId: string): Map<string, boolean> => {
    const rows = app.db
      .select({
        queryId: querySnapshots.queryId,
        citationState: querySnapshots.citationState,
      })
      .from(querySnapshots)
      .where(eq(querySnapshots.runId, runId))
      .all()
    const map = new Map<string, boolean>()
    for (const row of rows) {
      const cited = row.citationState === 'cited'
      if (!map.has(row.queryId) || cited) map.set(row.queryId, cited)
    }
    return map
  }
  const latestMap = fetchCited(latest.id)
  const previousMap = fetchCited(previous.id)

  let gained = 0
  let lost = 0
  let emerging = 0
  for (const [queryId, latestCited] of latestMap) {
    const previousCited = previousMap.get(queryId)
    if (previousCited === undefined) {
      if (latestCited) emerging += 1
      continue
    }
    if (latestCited && !previousCited) gained += 1
    else if (!latestCited && previousCited) lost += 1
  }

  return { since: previous.createdAt, gained, lost, emerging }
}

function mapInsightRow(r: typeof insights.$inferSelect): InsightDto {
  return {
    id: r.id,
    projectId: r.projectId,
    runId: r.runId ?? null,
    type: r.type as InsightDto['type'],
    severity: r.severity as InsightDto['severity'],
    title: r.title,
    query: r.query,
    provider: r.provider,
    recommendation: parseJsonColumn<InsightDto['recommendation']>(r.recommendation, undefined),
    cause: parseJsonColumn<InsightDto['cause']>(r.cause, undefined),
    dismissed: r.dismissed,
    createdAt: r.createdAt,
  }
}

function mapHealthRow(r: typeof healthSnapshots.$inferSelect): HealthSnapshotDto {
  return {
    id: r.id,
    projectId: r.projectId,
    runId: r.runId ?? null,
    overallCitedRate: Number(r.overallCitedRate),
    totalPairs: r.totalPairs,
    citedPairs: r.citedPairs,
    providerBreakdown: parseJsonColumn<HealthSnapshotDto['providerBreakdown']>(r.providerBreakdown, {}),
    createdAt: r.createdAt,
    status: 'ready',
  }
}

function formatProject(row: typeof projects.$inferSelect): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    canonicalDomain: row.canonicalDomain,
    ownedDomains: parseJsonColumn<string[]>(row.ownedDomains, []),
    country: row.country,
    language: row.language,
    tags: parseJsonColumn<string[]>(row.tags, []),
    labels: parseJsonColumn<Record<string, string>>(row.labels, {}),
    locations: parseJsonColumn<LocationContext[]>(row.locations, []),
    defaultLocation: row.defaultLocation,
    autoExtractBacklinks: row.autoExtractBacklinks === 1,
    configSource: row.configSource as ProjectDto['configSource'],
    configRevision: row.configRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function buildSnapshotHit(
  row: {
    id: string
    runId: string
    queryId: string
    queryText: string | null
    provider: string
    model: string | null
    citationState: string
    answerText: string | null
    citedDomains: string
    rawResponse: string | null
    createdAt: string
  },
  searchTerm: string,
): ProjectSearchSnapshotHitDto {
  const lower = searchTerm.toLowerCase()
  const query = row.queryText ?? ''
  const answer = row.answerText ?? ''
  const cited = row.citedDomains
  const raw = row.rawResponse ?? ''
  let matchedField: SnapshotMatchedField
  let snippet: string
  if (answer.toLowerCase().includes(lower)) {
    matchedField = 'answerText'
    snippet = makeSnippet(answer, searchTerm)
  } else if (cited.toLowerCase().includes(lower)) {
    matchedField = 'citedDomains'
    snippet = makeSnippet(cited, searchTerm)
  } else if (raw.toLowerCase().includes(lower)) {
    matchedField = 'searchQueries'
    snippet = makeSnippet(raw, searchTerm)
  } else {
    matchedField = 'query'
    snippet = query
  }
  return {
    kind: 'snapshot',
    id: row.id,
    runId: row.runId,
    query,
    provider: row.provider,
    model: row.model,
    citationState: row.citationState as CitationState,
    matchedField,
    snippet,
    createdAt: row.createdAt,
  }
}

function buildInsightHit(row: typeof insights.$inferSelect, searchTerm: string): ProjectSearchInsightHitDto {
  const lower = searchTerm.toLowerCase()
  const recommendation = row.recommendation ?? ''
  const cause = row.cause ?? ''
  let matchedField: InsightMatchedField
  let snippet: string
  if (row.title.toLowerCase().includes(lower)) {
    matchedField = 'title'
    snippet = makeSnippet(row.title, searchTerm)
  } else if (row.query.toLowerCase().includes(lower)) {
    matchedField = 'query'
    snippet = row.query
  } else if (recommendation.toLowerCase().includes(lower)) {
    matchedField = 'recommendation'
    snippet = makeSnippet(recommendation, searchTerm)
  } else {
    matchedField = 'cause'
    snippet = makeSnippet(cause, searchTerm)
  }
  return {
    kind: 'insight',
    id: row.id,
    runId: row.runId ?? null,
    type: row.type as InsightDto['type'],
    severity: row.severity as InsightDto['severity'],
    title: row.title,
    query: row.query,
    provider: row.provider,
    matchedField,
    snippet,
    dismissed: row.dismissed,
    createdAt: row.createdAt,
  }
}

function makeSnippet(text: string, query: string): string {
  if (!text) return ''
  const needle = query.toLowerCase()
  const haystack = text.toLowerCase()
  const idx = haystack.indexOf(needle)
  if (idx < 0) {
    return text.length <= SEARCH_SNIPPET_RADIUS * 2
      ? text
      : `${text.slice(0, SEARCH_SNIPPET_RADIUS * 2)}…`
  }
  const start = Math.max(0, idx - SEARCH_SNIPPET_RADIUS)
  const end = Math.min(text.length, idx + query.length + SEARCH_SNIPPET_RADIUS)
  const prefix = start === 0 ? '' : '…'
  const suffix = end === text.length ? '' : '…'
  return `${prefix}${text.slice(start, end)}${suffix}`
}
