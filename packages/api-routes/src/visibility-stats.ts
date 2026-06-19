import { and, desc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { queries, querySnapshots, runs } from '@ainyc/canonry-db'
import {
  CitationStates,
  parseInclusiveEndMs,
  RunKinds,
  RunStatuses,
  validationError,
  type VisibilityStatsCounts,
  type VisibilityStatsDto,
  type VisibilityStatsGroupBy,
  type VisibilityStatsProviderEntry,
  type VisibilityStatsQueryEntry,
} from '@ainyc/canonry-contracts'
import { notProbeRun, resolveProject } from './helpers.js'

/** Snapshot fields the aggregation reads. Tri-state `answerMentioned` is read RAW. */
export interface VisibilityStatsSnapshotInput {
  queryId: string | null
  queryText: string | null
  provider: string
  citationState: string
  answerMentioned: boolean | null
  createdAt: string
}

export interface ComputeVisibilityStatsInput {
  /** Currently tracked queries — snapshots are attributed to these. */
  queries: Array<{ id: string; query: string }>
  snapshots: VisibilityStatsSnapshotInput[]
  /** `'provider'` to emit per-provider breakdowns, else `null`. */
  groupBy: VisibilityStatsGroupBy | null
}

export interface ComputeVisibilityStatsResult {
  totals: VisibilityStatsCounts
  /** Present only when `groupBy === 'provider'`. */
  byProvider?: VisibilityStatsProviderEntry[]
  queries: VisibilityStatsQueryEntry[]
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

interface Agg {
  total: number
  checked: number
  mentioned: number
  cited: number
  first: string | null
  last: string | null
}

function emptyAgg(): Agg {
  return { total: 0, checked: 0, mentioned: 0, cited: 0, first: null, last: null }
}

function addSnapshot(agg: Agg, snap: VisibilityStatsSnapshotInput): void {
  agg.total++
  // Tri-state: `null`/`undefined` ("not checked") is EXCLUDED from `checked`
  // and never coerced to not-mentioned. Only an explicit boolean counts as
  // checked; only `true` counts as mentioned. This intentionally reads the
  // RAW `answerMentioned` column rather than `resolveSnapshotAnswerMentioned`
  // (helpers.ts), which sibling "latest coverage" endpoints use but which
  // coerces null → false — that coercion would corrupt the `checked` sample
  // size this proportion depends on.
  if (snap.answerMentioned === true || snap.answerMentioned === false) agg.checked++
  if (snap.answerMentioned === true) agg.mentioned++
  // Citation is independent of mention and is always populated.
  if (snap.citationState === CitationStates.cited) agg.cited++
  if (agg.first === null || snap.createdAt < agg.first) agg.first = snap.createdAt
  if (agg.last === null || snap.createdAt > agg.last) agg.last = snap.createdAt
}

function counts(agg: Agg): VisibilityStatsCounts {
  return {
    total: agg.total,
    checked: agg.checked,
    mentioned: agg.mentioned,
    cited: agg.cited,
    // mention proportion is over the CHECKED sample; citation proportion is
    // over the full total (every snapshot is checked for citation).
    mentionRate: agg.checked > 0 ? round4(agg.mentioned / agg.checked) : null,
    citedRate: agg.total > 0 ? round4(agg.cited / agg.total) : null,
  }
}

function providerEntries(byProvider: Map<string, Agg>): VisibilityStatsProviderEntry[] {
  return [...byProvider.entries()]
    .map(([provider, agg]) => ({
      provider,
      ...counts(agg),
      // first/last are non-null once at least one snapshot landed in the agg,
      // which is guaranteed for any provider that made it into the map.
      firstObserved: agg.first ?? '',
      lastObserved: agg.last ?? '',
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider))
}

/**
 * Pure aggregation: attribute snapshots to currently-tracked queries (by
 * `queryId`, falling back to denormalized `queryText` — see `history.ts`),
 * then roll up tri-state mention + citation counts per query, per provider,
 * and pooled. Snapshots that can't be attributed to a current query are
 * dropped (matches the timeline endpoint's behavior).
 */
export function computeVisibilityStats(input: ComputeVisibilityStatsInput): ComputeVisibilityStatsResult {
  const { groupBy } = input
  const wantProviders = groupBy === 'provider'

  // Attribution maps. `queryId` is the primary link; `queryText` recovers a
  // snapshot whose query row was replaced (queryId SET NULL) but whose text
  // still matches a current query.
  const queryById = new Map<string, { id: string; query: string }>()
  const queryByText = new Map<string, { id: string; query: string }>()
  for (const q of input.queries) {
    queryById.set(q.id, q)
    queryByText.set(q.query, q)
  }

  interface QueryBucket {
    id: string
    query: string
    agg: Agg
    byProvider: Map<string, Agg>
  }
  const byQuery = new Map<string, QueryBucket>()
  const totals = emptyAgg()
  const totalsByProvider = new Map<string, Agg>()

  for (const snap of input.snapshots) {
    let resolved: { id: string; query: string } | undefined
    if (snap.queryId && queryById.has(snap.queryId)) resolved = queryById.get(snap.queryId)
    else if (snap.queryText && queryByText.has(snap.queryText)) resolved = queryByText.get(snap.queryText)
    if (!resolved) continue

    let bucket = byQuery.get(resolved.id)
    if (!bucket) {
      bucket = { id: resolved.id, query: resolved.query, agg: emptyAgg(), byProvider: new Map() }
      byQuery.set(resolved.id, bucket)
    }
    addSnapshot(bucket.agg, snap)
    addSnapshot(totals, snap)

    if (wantProviders) {
      const qpAgg = bucket.byProvider.get(snap.provider) ?? emptyAgg()
      addSnapshot(qpAgg, snap)
      bucket.byProvider.set(snap.provider, qpAgg)

      const tpAgg = totalsByProvider.get(snap.provider) ?? emptyAgg()
      addSnapshot(tpAgg, snap)
      totalsByProvider.set(snap.provider, tpAgg)
    }
  }

  const queryEntries: VisibilityStatsQueryEntry[] = [...byQuery.values()]
    .map((bucket) => ({
      queryId: bucket.id,
      query: bucket.query,
      ...counts(bucket.agg),
      firstObserved: bucket.agg.first ?? '',
      lastObserved: bucket.agg.last ?? '',
      ...(wantProviders ? { providers: providerEntries(bucket.byProvider) } : {}),
    }))
    .sort((a, b) => a.query.localeCompare(b.query))

  return {
    totals: counts(totals),
    ...(wantProviders ? { byProvider: providerEntries(totalsByProvider) } : {}),
    queries: queryEntries,
  }
}

export async function visibilityStatsRoutes(app: FastifyInstance) {
  // GET /projects/:name/visibility-stats
  // Per-query mention/citation counts with a sample size, pooled across many
  // answer-visibility runs, with an optional per-provider breakdown. Lets a
  // consumer compute confidence-aware (Wilson) proportions without N+1 fetches.
  app.get<{
    Params: { name: string }
    Querystring: { since?: string; until?: string; lastRuns?: string; groupBy?: string }
  }>('/projects/:name/visibility-stats', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const { since: sinceRaw, until: untilRaw, lastRuns: lastRunsRaw, groupBy: groupByRaw } = request.query

    let groupBy: VisibilityStatsGroupBy | null = null
    if (groupByRaw !== undefined && groupByRaw !== '') {
      if (groupByRaw !== 'provider') throw validationError('"groupBy" must be "provider"')
      groupBy = 'provider'
    }

    const hasSince = sinceRaw !== undefined && sinceRaw !== ''
    const hasUntil = untilRaw !== undefined && untilRaw !== ''
    const hasLastRuns = lastRunsRaw !== undefined && lastRunsRaw !== ''
    if (hasLastRuns && (hasSince || hasUntil)) {
      throw validationError('"lastRuns" cannot be combined with "since"/"until" — use one or the other')
    }

    let sinceMs: number | null = null
    let untilMs: number | null = null
    // A date-only `since` already parses to the day's start (00:00), so it is
    // a correct inclusive lower bound as-is. A date-only `until` must be
    // widened to end-of-day (23:59:59.999) via `parseInclusiveEndMs` — parsed
    // as a bare midnight instant it would exclude every run created later that
    // same day, silently truncating the advertised date window.
    if (hasSince) {
      const ms = Date.parse(sinceRaw as string)
      if (Number.isNaN(ms)) throw validationError('"since" must be an ISO 8601 date/time')
      sinceMs = ms
    }
    if (hasUntil) {
      const ms = parseInclusiveEndMs(untilRaw as string)
      if (ms === null) throw validationError('"until" must be an ISO 8601 date/time')
      untilMs = ms
    }
    if (sinceMs !== null && untilMs !== null && untilMs < sinceMs) {
      throw validationError('"until" must be on or after "since"')
    }

    let lastRuns: number | null = null
    if (hasLastRuns) {
      const n = Number(lastRunsRaw)
      if (!Number.isInteger(n) || n <= 0) throw validationError('"lastRuns" must be a positive integer')
      lastRuns = n
    }

    const projectQueries = app.db
      .select({ id: queries.id, query: queries.query })
      .from(queries)
      .where(eq(queries.projectId, project.id))
      .all()

    // Answer-visibility runs only (the only kind that writes query_snapshots),
    // probe runs excluded, terminal-with-data statuses only. Newest first so
    // `lastRuns` can slice the head.
    let projectRuns = app.db
      .select({ id: runs.id, createdAt: runs.createdAt, status: runs.status })
      .from(runs)
      .where(and(eq(runs.projectId, project.id), eq(runs.kind, RunKinds['answer-visibility']), notProbeRun()))
      .orderBy(desc(runs.createdAt))
      .all()
      .filter((r) => r.status === RunStatuses.completed || r.status === RunStatuses.partial)

    if (sinceMs !== null) projectRuns = projectRuns.filter((r) => Date.parse(r.createdAt) >= sinceMs!)
    if (untilMs !== null) projectRuns = projectRuns.filter((r) => Date.parse(r.createdAt) <= untilMs!)
    if (lastRuns !== null) projectRuns = projectRuns.slice(0, lastRuns)

    const runCount = projectRuns.length
    const runIds = projectRuns.map((r) => r.id)

    const snapshots: VisibilityStatsSnapshotInput[] =
      runIds.length > 0 && projectQueries.length > 0
        ? app.db
            .select({
              queryId: querySnapshots.queryId,
              queryText: querySnapshots.queryText,
              provider: querySnapshots.provider,
              citationState: querySnapshots.citationState,
              answerMentioned: querySnapshots.answerMentioned,
              createdAt: querySnapshots.createdAt,
            })
            .from(querySnapshots)
            .where(inArray(querySnapshots.runId, runIds))
            .all()
        : []

    const stats = computeVisibilityStats({ queries: projectQueries, snapshots, groupBy })

    const response: VisibilityStatsDto = {
      project: project.name,
      window: {
        since: hasSince ? (sinceRaw as string) : null,
        until: hasUntil ? (untilRaw as string) : null,
        lastRuns,
        runCount,
      },
      totals: stats.totals,
      queries: stats.queries,
      // `groupBy` + `byProvider` appear together only when a breakdown was
      // requested; both are OMITTED otherwise (absent = no breakdown) so the
      // SDK types `groupBy` as `groupBy?: 'provider'` rather than a misleading
      // always-present literal.
      ...(groupBy === 'provider' ? { groupBy, byProvider: stats.byProvider ?? [] } : {}),
    }
    return reply.send(response)
  })
}
