import { eq, and, desc, sql, like, or, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  bingCoverageSnapshots,
  competitors,
  filterTrackedSnapshots,
  groupRunsByCreatedAt,
  gscCoverageSnapshots,
  gscUrlInspections,
  insights,
  healthSnapshots,
  pickGroupRepresentative,
  queries,
  parseJsonColumn,
  projects,
  querySnapshots,
  runs,
} from '@ainyc/canonry-db'
import {
  CitationStates,
  effectiveDomains,
  parseRunError,
  RunKinds,
  RunStatuses,
  type AttentionItemDto,
  type CitationState,
  type RunKind,
  type HealthSnapshotDto,
  type InsightDto,
  type LatestProjectRunDto,
  type LocationContext,
  type MetricTone,
  type ProjectDto,
  type ProjectOverviewCompetitorDto,
  type ProjectOverviewDto,
  type ProjectOverviewProviderScoreDto,
  type ProjectOverviewQueryCountsDto,
  type ProjectOverviewProviderEntryDto,
  type ProjectOverviewScoresDto,
  type ProjectOverviewTransitionsDto,
  type ProjectSearchHitDto,
  type ProjectSearchInsightHitDto,
  type ProjectSearchResponseDto,
  type ProjectSearchSnapshotHitDto,
  type RunDetailDto,
  type RunHistoryPointDto,
  type ScoreSummaryDto,
  validationError,
} from '@ainyc/canonry-contracts'
import {
  buildCompetitorPressureScore,
  buildGapQueryScore,
  buildMentionGapScore,
  buildMovementSummary,
  buildOverviewCompetitors,
  buildProviderScores,
  buildRunHistory,
  buildMentionCoverage,
  buildShareOfVoice,
  buildVisibilityScore,
  DEFAULT_RUN_HISTORY_LIMIT,
} from '@ainyc/canonry-intelligence'
import { resolveProject } from './helpers.js'

const TOP_INSIGHT_LIMIT = 5
const SEARCH_HIT_HARD_LIMIT = 50
const SEARCH_SNIPPET_RADIUS = 80

// Run kinds that count as upstream-data syncs for the "stale visibility"
// dashboard hint. Allowlist style so future non-sync kinds (e.g. discovery)
// don't silently start triggering the warning. Typed as ReadonlySet<string>
// because `runs.kind` from the DB is plain text — the values are RunKind
// in practice but TypeScript can't prove that from a Drizzle row.
const INTEGRATION_SYNC_KINDS: ReadonlySet<string> = new Set<RunKind>([
  RunKinds['gsc-sync'],
  RunKinds['inspect-sitemap'],
  RunKinds['ga-sync'],
  RunKinds['bing-inspect'],
  RunKinds['bing-inspect-sitemap'],
  RunKinds['backlink-extract'],
  RunKinds['traffic-sync'],
])

type SnapshotMatchedField = ProjectSearchSnapshotHitDto['matchedField']
type InsightMatchedField = ProjectSearchInsightHitDto['matchedField']

export async function compositeRoutes(app: FastifyInstance) {
  // GET /projects/:name/overview — composite read for "how is project X doing?".
  // Bundles project info, latest run, top insights, health, and a transitions
  // summary so agents don't fan out to four list endpoints to answer the
  // common opener.
  app.get<{
    Params: { name: string }
    Querystring: { location?: string; since?: string }
  }>('/projects/:name/overview', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const filterLocation = (request.query.location ?? '').trim() || null
    const sinceIso = parseSinceFilter(request.query.since)

    // Load all runs once. We need the absolute-latest for `latestRun.run`
    // (any kind), the latest answer-visibility run for snapshot-driven
    // metrics, and a window of recent visibility runs for the sparkline.
    // Filters narrow the run pool — every snapshot-derived metric below
    // operates on the filtered subset.
    const allRunsRaw = app.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, project.id))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .all()
    const allRuns = allRunsRaw.filter(r => runMatchesFilters(r, filterLocation, sinceIso))
    const totalRuns = allRuns.length

    const visibilityRuns = allRuns.filter(r => r.kind === RunKinds['answer-visibility'])
    const completedVisRuns = visibilityRuns.filter(
      r => r.status === RunStatuses.completed || r.status === RunStatuses.partial,
    )
    // Group completed visibility runs by `createdAt`. A `--all-locations` fan-out
    // creates N runs sharing the same timestamp; the group is the unit, not the
    // row. Latest group = current state; previous group = the next-most-recent
    // distinct timestamp. Picking `[0]`/`[1]` raw misclassifies the sibling
    // location's current run as "previous." See #480.
    const visRunGroups = groupRunsByCreatedAt(completedVisRuns)
    const latestVisRunGroup = visRunGroups[0] ?? []
    const previousVisRunGroup = visRunGroups[1] ?? []
    // Representative previous run is only needed for the transition's `since`
    // timestamp; all snapshots from the previous group feed the snapshot-derived
    // metrics below. Using `pickGroupRepresentative` rather than `[0]` decouples
    // this from the SQL ordering — if anyone later removes the `desc(runs.id)`
    // tiebreak, the rep is still stable.
    const previousVisibilityRun = pickGroupRepresentative(previousVisRunGroup)
    const latestRunRow = allRuns[0] ?? null

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

    // Load snapshots for the latest visibility run + previous, then a window
    // of recent visibility runs for the sparkline. One DB hit gathers them
    // all so we don't fan out per-primitive.
    const sparklineRunIds = visibilityRuns.slice(0, DEFAULT_RUN_HISTORY_LIMIT).map(r => r.id)
    const snapshotRunIds = new Set<string>(sparklineRunIds)
    for (const run of latestVisRunGroup) snapshotRunIds.add(run.id)
    for (const run of previousVisRunGroup) snapshotRunIds.add(run.id)

    const snapshotsByRun = loadSnapshotsByRunIds(app, [...snapshotRunIds])
    const latestSnapshots = latestVisRunGroup.flatMap(r => snapshotsByRun.get(r.id) ?? [])
    const previousSnapshots = previousVisRunGroup.flatMap(r => snapshotsByRun.get(r.id) ?? [])

    const { queryCounts, providers } = summarizeFromSnapshots(latestSnapshots)
    const transitions = summarizeTransitionsFromSnapshots(
      latestSnapshots,
      previousSnapshots,
      previousVisibilityRun?.createdAt ?? null,
    )

    const competitorRows = app.db
      .select()
      .from(competitors)
      .where(eq(competitors.projectId, project.id))
      .all()
    const projectQueries = app.db
      .select({ id: queries.id, query: queries.query })
      .from(queries)
      .where(eq(queries.projectId, project.id))
      .all()
    const queryLookup = { byId: new Map(projectQueries.map(q => [q.id, q.query])) }

    const configuredApiProviders = parseJsonColumn<string[]>(project.providers, [])
      .filter(p => !p.startsWith('cdp:'))

    const projectDomains = effectiveDomains({
      canonicalDomain: project.canonicalDomain,
      ownedDomains: parseJsonColumn<string[]>(project.ownedDomains, []),
    })

    const scores: ProjectOverviewScoresDto = {
      mention: buildMentionCoverage(latestSnapshots, { configuredApiProviders }),
      visibility: buildVisibilityScore(latestSnapshots, { configuredApiProviders }),
      shareOfVoice: buildShareOfVoice(latestSnapshots, { projectDomains }),
      gapQueries: buildGapQueryScore(latestSnapshots),
      mentionGaps: buildMentionGapScore(latestSnapshots),
      indexCoverage: buildIndexCoverageScore(app, project.id),
      competitorPressure: buildCompetitorPressureScore(
        latestSnapshots,
        competitorRows.map(c => c.domain),
        competitorRows.length,
      ),
      runStatus: buildRunStatusScore(allRuns),
    }

    const movementSummary = buildMovementSummary(latestSnapshots, previousSnapshots, {
      queryLookup: queryLookup.byId,
    })
    const providerScores = buildProviderScores(latestSnapshots)
    const overviewCompetitors: ProjectOverviewCompetitorDto[] = buildOverviewCompetitors(
      latestSnapshots,
      competitorRows.map(c => ({ id: c.id, domain: c.domain })),
      queryLookup,
    )
    const attentionItems = buildAttentionItems(insightRows, allRuns)
    const sparklineRuns = visibilityRuns
      .slice(0, DEFAULT_RUN_HISTORY_LIMIT)
      .map(r => ({ id: r.id, createdAt: r.createdAt, status: r.status }))
    const runHistory: RunHistoryPointDto[] = buildRunHistory(sparklineRuns, snapshotsByRun)

    const result: ProjectOverviewDto = {
      project: formatProject(project),
      latestRun,
      health,
      topInsights,
      queryCounts,
      providers,
      transitions,
      scores,
      movementSummary,
      competitors: overviewCompetitors,
      providerScores,
      attentionItems,
      runHistory,
      dateRangeLabel: 'All time',
      contextLabel: `${project.country} / ${project.language.toUpperCase()}`,
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

    // INNER JOIN already excludes orphan snapshots at the SQL level, but
    // drizzle still types queryId as `string | null`. Wrap so TS narrows.
    const snapshotMatches = filterTrackedSnapshots(app.db
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
      .all())

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

function parseSinceFilter(raw: string | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) {
    throw validationError('"since" must be an ISO 8601 datetime')
  }
  return new Date(parsed).toISOString()
}

function runMatchesFilters(
  run: typeof runs.$inferSelect,
  location: string | null,
  sinceIso: string | null,
): boolean {
  if (location !== null && (run.location ?? '') !== location) return false
  if (sinceIso !== null && run.createdAt < sinceIso) return false
  return true
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

// Snapshot fields used across the overview's summarization primitives. Loaded
// once per request and reused — keeping the shape narrow lets the intelligence
// primitives accept it via structural typing.
interface OverviewSnapshot {
  queryId: string
  provider: string
  model: string | null
  citationState: string
  answerMentioned: boolean | null
  competitorOverlap: string[]
  citedDomains: string[]
}

function loadSnapshotsByRunIds(
  app: FastifyInstance,
  runIds: readonly string[],
): Map<string, OverviewSnapshot[]> {
  const result = new Map<string, OverviewSnapshot[]>()
  if (runIds.length === 0) return result
  // Drop orphan snapshots (queryId NULL post-v58) — overview-snapshot
  // rollups key by queryId and can't slot null-keyed rows.
  const rows = filterTrackedSnapshots(app.db
    .select({
      runId: querySnapshots.runId,
      queryId: querySnapshots.queryId,
      provider: querySnapshots.provider,
      model: querySnapshots.model,
      citationState: querySnapshots.citationState,
      answerMentioned: querySnapshots.answerMentioned,
      competitorOverlap: querySnapshots.competitorOverlap,
      citedDomains: querySnapshots.citedDomains,
    })
    .from(querySnapshots)
    .where(inArray(querySnapshots.runId, [...runIds]))
    .all())
  for (const row of rows) {
    const list = result.get(row.runId) ?? []
    list.push({
      queryId: row.queryId,
      provider: row.provider,
      model: row.model,
      citationState: row.citationState,
      answerMentioned: row.answerMentioned,
      competitorOverlap: parseJsonColumn<string[]>(row.competitorOverlap, []),
      citedDomains: parseJsonColumn<string[]>(row.citedDomains, []),
    })
    result.set(row.runId, list)
  }
  return result
}

function summarizeFromSnapshots(
  snapshots: readonly OverviewSnapshot[],
): { queryCounts: ProjectOverviewQueryCountsDto; providers: ProjectOverviewProviderEntryDto[] } {
  const empty = {
    queryCounts: { totalQueries: 0, citedQueries: 0, notCitedQueries: 0, citedRate: 0 } as ProjectOverviewQueryCountsDto,
    providers: [] as ProjectOverviewProviderEntryDto[],
  }
  if (snapshots.length === 0) return empty

  const perQuery = new Map<string, boolean>()
  const perProvider = new Map<string, { cited: number; total: number }>()
  for (const snap of snapshots) {
    const cited = snap.citationState === CitationStates.cited
    if (!perQuery.has(snap.queryId) || cited) {
      perQuery.set(snap.queryId, cited)
    }
    const bucket = perProvider.get(snap.provider) ?? { cited: 0, total: 0 }
    bucket.total += 1
    if (cited) bucket.cited += 1
    perProvider.set(snap.provider, bucket)
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

function summarizeTransitionsFromSnapshots(
  latest: readonly OverviewSnapshot[],
  previous: readonly OverviewSnapshot[],
  since: string | null,
): ProjectOverviewTransitionsDto {
  if (!since || previous.length === 0) {
    return { since: null, gained: 0, lost: 0, emerging: 0 }
  }
  const buildMap = (snaps: readonly OverviewSnapshot[]): Map<string, boolean> => {
    const m = new Map<string, boolean>()
    for (const s of snaps) {
      const cited = s.citationState === CitationStates.cited
      if (!m.has(s.queryId) || cited) m.set(s.queryId, cited)
    }
    return m
  }
  const latestMap = buildMap(latest)
  const previousMap = buildMap(previous)

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

  return { since, gained, lost, emerging }
}

function buildIndexCoverageScore(app: FastifyInstance, projectId: string): ScoreSummaryDto {
  const tooltip = 'Percentage of inspected URLs currently indexed. Google Search Console is preferred when available, otherwise Bing Webmaster Tools is used.'
  const empty: ScoreSummaryDto = {
    label: 'Index Coverage',
    value: 'No data',
    delta: 'Connect GSC or Bing',
    tone: 'neutral',
    description: 'Connect Google Search Console or Bing Webmaster Tools and inspect your sitemap to populate coverage.',
    tooltip,
    trend: [],
  }

  const gscRow = app.db
    .select()
    .from(gscCoverageSnapshots)
    .where(eq(gscCoverageSnapshots.projectId, projectId))
    .orderBy(desc(gscCoverageSnapshots.date))
    .limit(1)
    .get()
  const bingRow = app.db
    .select()
    .from(bingCoverageSnapshots)
    .where(eq(bingCoverageSnapshots.projectId, projectId))
    .orderBy(desc(bingCoverageSnapshots.date))
    .limit(1)
    .get()

  const chosen = pickIndexCoverageRow(gscRow, bingRow)
  if (!chosen) return empty

  const total = chosen.indexed + chosen.notIndexed
  if (total === 0) return empty

  // Bing has no per-URL inspection history, so deindexed only applies to Google.
  const deindexed = chosen.provider === 'Google'
    ? countGoogleDeindexedUrls(app, projectId)
    : 0

  const percentage = (chosen.indexed / total) * 100
  // Newly deindexed URLs are a hard signal — they used to be indexed and now aren't.
  // Surface as negative regardless of headline percentage so the gauge matches the
  // previous client-side behavior. Mirror /google/gsc/coverage's deindexed accounting.
  const tone: MetricTone = deindexed > 0
    ? 'negative'
    : percentage >= 90 ? 'positive'
    : percentage >= 70 ? 'caution'
    : 'negative'
  const notIndexedLabel = chosen.notIndexed === 1 ? 'URL is' : 'URLs are'
  const deindexedLabel = deindexed === 1 ? 'URL' : 'URLs'

  return {
    label: 'Index Coverage',
    value: `${Math.round(percentage)}`,
    delta: `${chosen.provider} · ${chosen.indexed} of ${total} indexed`,
    tone,
    description: deindexed > 0
      ? `${deindexed} deindexed ${deindexedLabel} detected in the latest Google Search Console inspection.`
      : `${chosen.notIndexed} ${notIndexedLabel} not indexed in ${chosen.provider === 'Google' ? 'Google Search Console' : 'Bing Webmaster Tools'}.`,
    tooltip,
    trend: [],
    progress: Math.round(percentage),
  }
}

/**
 * Walk this project's GSC URL inspection history and count URLs whose latest
 * inspection flipped to non-indexed after a previous indexed reading. Mirrors
 * the deindexed computation in `GET /projects/:name/google/gsc/coverage` so
 * the two surfaces report the same number.
 */
function countGoogleDeindexedUrls(app: FastifyInstance, projectId: string): number {
  const rows = app.db
    .select({
      url: gscUrlInspections.url,
      indexingState: gscUrlInspections.indexingState,
      inspectedAt: gscUrlInspections.inspectedAt,
    })
    .from(gscUrlInspections)
    .where(eq(gscUrlInspections.projectId, projectId))
    .orderBy(desc(gscUrlInspections.inspectedAt))
    .all()

  if (rows.length === 0) return 0

  // Collapse http:// / https:// duplicates per coverage endpoint's logic.
  const canonicalUrl = (url: string) => url.replace(/^http:\/\//, 'https://')
  const historyByUrl = new Map<string, typeof rows>()
  for (const row of rows) {
    const key = canonicalUrl(row.url)
    const list = historyByUrl.get(key)
    if (list) list.push(row)
    else historyByUrl.set(key, [row])
  }

  let deindexed = 0
  for (const history of historyByUrl.values()) {
    if (history.length < 2) continue
    const latest = history[0]!
    const previous = history[1]!
    if (
      previous.indexingState === 'INDEXING_ALLOWED' &&
      latest.indexingState !== 'INDEXING_ALLOWED'
    ) {
      deindexed++
    }
  }
  return deindexed
}

function pickIndexCoverageRow(
  gsc: typeof gscCoverageSnapshots.$inferSelect | undefined,
  bing: typeof bingCoverageSnapshots.$inferSelect | undefined,
): { provider: 'Google' | 'Bing'; indexed: number; notIndexed: number } | null {
  if (gsc && (gsc.indexed + gsc.notIndexed) > 0) {
    return { provider: 'Google', indexed: gsc.indexed, notIndexed: gsc.notIndexed }
  }
  if (bing && (bing.indexed + bing.notIndexed) > 0) {
    return { provider: 'Bing', indexed: bing.indexed, notIndexed: bing.notIndexed }
  }
  if (gsc) return { provider: 'Google', indexed: gsc.indexed, notIndexed: gsc.notIndexed }
  if (bing) return { provider: 'Bing', indexed: bing.indexed, notIndexed: bing.notIndexed }
  return null
}

function buildRunStatusScore(allRuns: readonly (typeof runs.$inferSelect)[]): ScoreSummaryDto {
  const tooltip = 'Current execution state of visibility sweeps. Shows the status of the most recent run and total run count.'
  if (allRuns.length === 0) {
    return {
      label: 'Run Status',
      value: 'None',
      delta: 'No runs yet',
      tone: 'neutral',
      description: 'Trigger a visibility sweep to start tracking.',
      tooltip,
      trend: [],
    }
  }

  const latestVisibility = allRuns.find(r => r.kind === RunKinds['answer-visibility'])
  const latest = latestVisibility ?? allRuns[0]!

  const value = latest.status === RunStatuses.completed ? 'Healthy'
    : latest.status === RunStatuses.running ? 'Running'
    : latest.status === RunStatuses.queued ? 'Queued'
    : latest.status === RunStatuses.partial ? 'Partial'
    : 'Failed'

  const tone: MetricTone = latest.status === RunStatuses.completed ? 'positive'
    : latest.status === RunStatuses.failed ? 'negative'
    : latest.status === RunStatuses.partial ? 'caution'
    : 'neutral'

  const visibilityRunCount = allRuns.filter(r => r.kind === RunKinds['answer-visibility']).length
  const syncRunCount = allRuns.length - visibilityRunCount
  const delta = syncRunCount > 0
    ? `${visibilityRunCount} visibility · ${syncRunCount} sync`
    : `${visibilityRunCount} visibility run${visibilityRunCount === 1 ? '' : 's'}`

  return {
    label: 'Run Status',
    value,
    delta,
    tone,
    description: `Latest run ${value.toLowerCase()}. ${allRuns.length} total run${allRuns.length === 1 ? '' : 's'}.`,
    tooltip,
    trend: [],
  }
}

const ATTENTION_INSIGHT_LIMIT = 5

function buildAttentionItems(
  insightRows: readonly (typeof insights.$inferSelect)[],
  allRuns: readonly (typeof runs.$inferSelect)[],
): AttentionItemDto[] {
  const items: AttentionItemDto[] = []

  for (const row of insightRows) {
    if (row.dismissed) continue
    if (row.severity !== 'critical' && row.severity !== 'high') continue
    if (items.length >= ATTENTION_INSIGHT_LIMIT) break
    items.push({
      id: `insight_${row.id}`,
      tone: row.severity === 'critical' ? 'negative' : 'caution',
      title: row.title,
      detail: row.query ? `On query: ${row.query}` : '',
      actionLabel: row.severity === 'critical' ? 'Critical' : 'High',
      href: `#insight-${row.id}`,
    })
  }

  // Surface a stale-visibility hint when integration syncs ran more recently
  // than the latest visibility sweep — the dashboard's existing rule.
  //
  // INTEGRATION_SYNC_KINDS is an explicit allowlist (not "everything that
  // isn't answer-visibility"): discovery runs (`aeo-discover-*`) and site
  // audits are NOT syncs, so an active discovery session would otherwise
  // spuriously trigger "integration syncs have run since." Keep this list
  // tight to what literally pulls upstream third-party data.
  const sortedRuns = [...allRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const latestVisRun = sortedRuns.find(r => r.kind === RunKinds['answer-visibility'])
  const latestSyncRun = sortedRuns.find(r => INTEGRATION_SYNC_KINDS.has(r.kind))
  if (latestVisRun && latestSyncRun) {
    const visibilityAge = new Date(latestSyncRun.createdAt).getTime() - new Date(latestVisRun.createdAt).getTime()
    const ONE_DAY = 24 * 60 * 60 * 1000
    if (visibilityAge > ONE_DAY) {
      items.push({
        id: 'stale_visibility',
        tone: 'caution',
        title: 'Stale visibility data',
        detail: `Last visibility sweep was ${latestVisRun.createdAt}; integration syncs have run since.`,
        actionLabel: 'Stale',
        href: '#runs',
      })
    }
  }

  return items
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
    aliases: parseJsonColumn<string[]>(row.aliases, []),
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
