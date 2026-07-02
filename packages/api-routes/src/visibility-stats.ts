import { and, desc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { competitors, queries, querySnapshots, runs } from '@ainyc/canonry-db'
import { buildMentionShare } from '@ainyc/canonry-intelligence'
import {
  brandLabelFromDomain,
  calendarMonthBounds,
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
  type VisibilityStatsShareOfVoice,
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

type QueryAttributionSnapshot = Pick<VisibilityStatsSnapshotInput, 'queryId' | 'queryText'>
type CurrentQuery = { id: string; query: string }

function buildQueryAttribution(projectQueries: CurrentQuery[]): {
  byId: Map<string, CurrentQuery>
  byText: Map<string, CurrentQuery>
} {
  const byId = new Map<string, CurrentQuery>()
  const byText = new Map<string, CurrentQuery>()
  for (const q of projectQueries) {
    byId.set(q.id, q)
    byText.set(q.query, q)
  }
  return { byId, byText }
}

function resolveCurrentQuery(
  attribution: ReturnType<typeof buildQueryAttribution>,
  snap: QueryAttributionSnapshot,
): CurrentQuery | undefined {
  if (snap.queryId && attribution.byId.has(snap.queryId)) return attribution.byId.get(snap.queryId)
  if (snap.queryText && attribution.byText.has(snap.queryText)) return attribution.byText.get(snap.queryText)
  return undefined
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
  const attribution = buildQueryAttribution(input.queries)

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
    const resolved = resolveCurrentQuery(attribution, snap)
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
    Querystring: {
      since?: string
      until?: string
      lastRuns?: string
      groupBy?: string
      month?: string
      shareOfVoice?: string
    }
  }>('/projects/:name/visibility-stats', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const {
      since: sinceRaw,
      until: untilRaw,
      lastRuns: lastRunsRaw,
      groupBy: groupByRaw,
      month: monthRaw,
      shareOfVoice: shareOfVoiceRaw,
    } = request.query

    let groupBy: VisibilityStatsGroupBy | null = null
    if (groupByRaw !== undefined && groupByRaw !== '') {
      if (groupByRaw !== 'provider') throw validationError('"groupBy" must be "provider"')
      groupBy = 'provider'
    }

    const hasSince = sinceRaw !== undefined && sinceRaw !== ''
    const hasUntil = untilRaw !== undefined && untilRaw !== ''
    const hasLastRuns = lastRunsRaw !== undefined && lastRunsRaw !== ''
    const hasMonth = monthRaw !== undefined && monthRaw !== ''
    const wantShareOfVoice = shareOfVoiceRaw === '1' || shareOfVoiceRaw === 'true'
    if (hasLastRuns && (hasSince || hasUntil)) {
      throw validationError('"lastRuns" cannot be combined with "since"/"until" — use one or the other')
    }
    if (hasMonth && (hasSince || hasUntil || hasLastRuns)) {
      throw validationError('"month" cannot be combined with "since"/"until"/"lastRuns" — use one or the other')
    }

    let sinceMs: number | null = null
    let untilMs: number | null = null
    let resolvedMonthWindow: { since: string; until: string } | null = null
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
    if (hasMonth) {
      let bounds: { since: string; until: string }
      try {
        bounds = calendarMonthBounds(monthRaw as string)
      } catch (err) {
        throw validationError(err instanceof RangeError ? err.message : '"month" must be in YYYY-MM format')
      }
      sinceMs = Date.parse(bounds.since)
      untilMs = Date.parse(bounds.until)
      resolvedMonthWindow = bounds
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
    const queryAttribution = buildQueryAttribution(projectQueries)

    // Pooled share of voice (opt-in) — how often the project's brand is named in
    // answer text vs tracked competitors, across the SAME window of runs, via the
    // shared buildMentionShare. Loads answerText only on this path so the default
    // endpoint stays lean.
    let shareOfVoice: VisibilityStatsShareOfVoice | undefined
    if (wantShareOfVoice) {
      const competitorRows = app.db
        .select({ domain: competitors.domain })
        .from(competitors)
        .where(eq(competitors.projectId, project.id))
        .all()
      const mentionShareCompetitors = competitorRows.map((c) => ({
        domain: c.domain,
        brandTokens: [brandLabelFromDomain(c.domain)].filter((t) => t.length >= 3),
      }))
      const sovSnapshots =
        runIds.length > 0
          ? app.db
              .select({
                queryId: querySnapshots.queryId,
                queryText: querySnapshots.queryText,
                answerMentioned: querySnapshots.answerMentioned,
                answerText: querySnapshots.answerText,
              })
              .from(querySnapshots)
              .where(inArray(querySnapshots.runId, runIds))
              .all()
          : []
      const attributedSovSnapshots = sovSnapshots.filter((s) => resolveCurrentQuery(queryAttribution, s) !== undefined)
      const result = buildMentionShare(
        attributedSovSnapshots.map((s) => ({ projectMentioned: s.answerMentioned === true, answerText: s.answerText })),
        { competitors: mentionShareCompetitors },
      )
      const b = result.breakdown
      const denom = b.projectMentionSnapshots + b.competitorMentionSnapshots
      shareOfVoice = {
        // `null` (not 0) when there is no competitive frame configured — a 0 here
        // would read as "losing" when the head-to-head metric is simply undefined.
        percent: competitorRows.length === 0 ? null : denom > 0 ? Math.round((b.projectMentionSnapshots / denom) * 100) : 0,
        projectMentions: b.projectMentionSnapshots,
        competitorMentions: b.competitorMentionSnapshots,
        snapshotsWithAnswerText: b.snapshotsWithAnswerText,
        perCompetitor: b.perCompetitor.map((c) => ({ domain: c.domain, mentions: c.mentionSnapshots })),
      }
    }

    const response: VisibilityStatsDto = {
      project: project.name,
      window: {
        // A `month` request echoes the resolved inclusive bounds it expanded to,
        // so the window is self-documenting regardless of which input was used.
        since: resolvedMonthWindow ? resolvedMonthWindow.since : hasSince ? (sinceRaw as string) : null,
        until: resolvedMonthWindow ? resolvedMonthWindow.until : hasUntil ? (untilRaw as string) : null,
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
      ...(shareOfVoice ? { shareOfVoice } : {}),
    }
    return reply.send(response)
  })
}
