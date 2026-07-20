import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { auditLog, querySnapshots, runs, queries, parseJsonColumn } from '@ainyc/canonry-db'
import {
  CitationStates,
  mentionStateFromAnswerMentioned,
  notFound,
  RunKinds,
  validationError,
  visibilityStateFromAnswerMentioned,
} from '@ainyc/canonry-contracts'
import { notProbeRun, resolveProject, resolveSnapshotAnswerMentioned, resolveSnapshotMentionState, resolveSnapshotVisibilityState } from './helpers.js'
import { redactNotificationDiff } from './notification-redaction.js'

export async function historyRoutes(app: FastifyInstance) {
  // GET /projects/:name/history — audit log for project
  app.get<{
    Params: { name: string }
    Querystring: AuditHistoryQuery
  }>('/projects/:name/history', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const filters = [eq(auditLog.projectId, project.id)]
    addAuditHistoryFilters(filters, request.query)

    const rows = app.db
      .select()
      .from(auditLog)
      .where(and(...filters))
      .orderBy(desc(auditLog.createdAt))
      .limit(parseBoundedInt(request.query.limit, 100, 500))
      .offset(parseBoundedInt(request.query.offset, 0, Number.MAX_SAFE_INTEGER))
      .all()

    return reply.send(rows.map(formatAuditEntry))
  })

  // GET /history — audit log. Full-instance keys see every project's entries;
  // a project-scoped key sees ONLY its own project's audit log. This global
  // list is not under the /projects/:name auth gate, so filter explicitly
  // (NULL-project instance-level entries are intentionally hidden from a
  // scoped key).
  app.get<{ Querystring: AuditHistoryQuery }>('/history', async (request, reply) => {
    const scopedProjectId = request.apiKey?.projectId
    const filters = scopedProjectId ? [eq(auditLog.projectId, scopedProjectId)] : []
    addAuditHistoryFilters(filters, request.query)
    const rows = app.db
      .select()
      .from(auditLog)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(auditLog.createdAt))
      .limit(parseBoundedInt(request.query.limit, 100, 500))
      .offset(parseBoundedInt(request.query.offset, 0, Number.MAX_SAFE_INTEGER))
      .all()

    return reply.send(rows.map(formatAuditEntry))
  })

  // GET /projects/:name/snapshots — query snapshots for project (paginated)
  app.get<{
    Params: { name: string }
    Querystring: { limit?: string; offset?: string; location?: string }
  }>('/projects/:name/snapshots', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const limit = parseInt(request.query.limit ?? '50', 10)
    const offset = parseInt(request.query.offset ?? '0', 10)

    // Get all runs for this project
    const projectRuns = app.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.projectId, project.id), notProbeRun()))
      .all()

    if (projectRuns.length === 0) {
      return reply.send({ snapshots: [], total: 0 })
    }

    // Get snapshots for these runs
    const allSnapshots = app.db
      .select({
        id: querySnapshots.id,
        runId: querySnapshots.runId,
        queryId: querySnapshots.queryId,
        query: queries.query,
        provider: querySnapshots.provider,
        model: querySnapshots.model,
        citationState: querySnapshots.citationState,
        answerMentioned: querySnapshots.answerMentioned,
        answerText: querySnapshots.answerText,
        citedDomains: querySnapshots.citedDomains,
        competitorOverlap: querySnapshots.competitorOverlap,
        recommendedCompetitors: querySnapshots.recommendedCompetitors,
        location: querySnapshots.location,
        createdAt: querySnapshots.createdAt,
      })
      .from(querySnapshots)
      .leftJoin(queries, eq(querySnapshots.queryId, queries.id))
      .where(inArray(querySnapshots.runId, projectRuns.map(r => r.id)))
      .orderBy(desc(querySnapshots.createdAt))
      .all()

    // Filter by location if requested
    const locationFilter = request.query.location
    const filtered = locationFilter !== undefined
      ? allSnapshots.filter(s => s.location === (locationFilter || null))
      : allSnapshots

    const total = filtered.length
    const paged = filtered.slice(offset, offset + limit)

    return reply.send({
      snapshots: paged.map(s => ({
        id: s.id,
        runId: s.runId,
        queryId: s.queryId,
        query: s.query,
        provider: s.provider,
        model: s.model,
        citationState: s.citationState,
        answerMentioned: resolveSnapshotAnswerMentioned(s, project),
        visibilityState: resolveSnapshotVisibilityState(s, project),
        mentionState: resolveSnapshotMentionState(s, project),
        answerText: s.answerText,
        citedDomains: s.citedDomains,
        competitorOverlap: s.competitorOverlap,
        recommendedCompetitors: s.recommendedCompetitors,
        location: s.location,
        createdAt: s.createdAt,
      })),
      total,
    })
  })

  // GET /projects/:name/timeline — per-query citation state over time
  app.get<{ Params: { name: string }; Querystring: { location?: string; limit?: string } }>('/projects/:name/timeline', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    // Get project queries
    const projectQueries = app.db
      .select()
      .from(queries)
      .where(eq(queries.projectId, project.id))
      .all()

    // Get project runs ordered by creation time.
    //
    // Restricted to `answer-visibility` runs — the only kind that writes
    // `query_snapshots` (the sole snapshot writer is the sweep path in
    // `job-runner.executeRun`, and `POST /projects/:name/runs` pins that
    // path's `kind` to the `answer-visibility` literal). Every field this
    // route returns is derived from snapshots, so including other kinds adds
    // nothing to the response — but it does consume the `limit` window.
    // Projects sync traffic every ~30 minutes while sweeps run roughly twice
    // a month, so an unfiltered `limit=20` selects ~10 hours of integration
    // syncs and zero sweeps, and every entry comes back with `runs: []`
    // (issue: "Query evidence" panel stuck on "Awaiting first run").
    // With the filter, `limit` means "the last N sweeps", which is what every
    // caller intends. `visibility-stats` filters on the same run kind, but also
    // narrows to completed/partial runs; this route deliberately does not, so a
    // failed sweep still appears in the timeline.
    const runKindFilter = and(
      eq(runs.projectId, project.id),
      notProbeRun(),
      eq(runs.kind, RunKinds['answer-visibility']),
    )
    const requestedLimit = parseOptionalPositiveInt(request.query.limit, 100)
    const projectRuns = requestedLimit == null
      ? app.db
        .select()
        .from(runs)
        .where(runKindFilter)
        .orderBy(asc(runs.createdAt))
        .all()
      : app.db
        .select()
        .from(runs)
        .where(runKindFilter)
        .orderBy(desc(runs.createdAt))
        .limit(requestedLimit)
        .all()
        .reverse()

    if (projectRuns.length === 0 || projectQueries.length === 0) {
      return reply.send([])
    }

    const runIds = new Set(projectRuns.map(r => r.id))

    // Get snapshots for these runs
    const rawSnapshots = app.db
      .select()
      .from(querySnapshots)
      .where(inArray(querySnapshots.runId, [...runIds]))
      .all()

    // Filter by location if requested
    const timelineLocationFilter = request.query.location
    const filteredSnapshots = timelineLocationFilter !== undefined
      ? rawSnapshots.filter(s => s.location === (timelineLocationFilter || null))
      : rawSnapshots
    const allSnapshots = filteredSnapshots.map(snapshot => ({
      ...snapshot,
      answerMentioned: resolveSnapshotAnswerMentioned(snapshot, project),
    }))

    // Query attribution fallback ladder. A snapshot's primary link to a
    // query is `query_id` (FK). When the operator runs `query replace` or
    // `query remove`, the FK is `ON DELETE SET NULL` and `query_id` goes
    // to NULL — but `query_text` was denormalized onto the snapshot at
    // insert time (since ~2026-04-08) precisely so the snapshot can still
    // attribute itself to a query of the same text if one exists later.
    // For pre-2026-04-08 snapshots, `query_text` may also be NULL — those
    // are recovered via the audit-log-replay backfill in
    // `cnry repair snapshot-attribution`.
    //
    // Map each query's id AND its text → the query row, so a snapshot
    // whose query_id matches OR (query_id is NULL and query_text matches)
    // lands on the right query in the timeline.
    const queryByText = new Map<string, typeof projectQueries[number]>()
    for (const q of projectQueries) queryByText.set(q.query, q)
    function resolveSnapQueryId(snap: typeof allSnapshots[number]): string | null {
      if (snap.queryId) return snap.queryId
      if (snap.queryText) {
        const match = queryByText.get(snap.queryText)
        if (match) return match.id
      }
      return null
    }
    // Pre-compute the resolved query id for each snapshot so downstream
    // grouping never has to recompute it.
    const allSnapshotsResolved = allSnapshots.map(s => ({
      ...s,
      resolvedQueryId: resolveSnapQueryId(s),
    }))

    // Deduplicate to one entry per (runId, queryId) before building transitions so that
    // multi-provider runs don't produce spurious transition events within a single run.
    // Prefer 'cited' when providers disagree within the same run.
    const deduped = new Map<string, typeof allSnapshotsResolved[number]>()
    for (const snap of allSnapshotsResolved) {
      // Skip snapshots that can't be attributed to a current query — they
      // have no query_id and their query_text doesn't match any current
      // query (likely an archived query). The repair command can recover
      // these by populating query_text from the audit log.
      if (!snap.resolvedQueryId) continue
      const key = `${snap.runId}:${snap.resolvedQueryId}`
      const existing = deduped.get(key)
      if (
        !existing ||
        (!existing.answerMentioned && snap.answerMentioned) ||
        (existing.answerMentioned === snap.answerMentioned && snap.citationState === CitationStates.cited)
      ) {
        deduped.set(key, snap)
      }
    }
    const dedupedSnapshots = [...deduped.values()]

    // Index raw (un-deduplicated) snapshots by query+provider for per-provider timelines
    const rawByQueryProvider = new Map<string, typeof allSnapshotsResolved[number][]>()
    for (const snap of allSnapshotsResolved) {
      if (!snap.resolvedQueryId) continue
      const key = `${snap.resolvedQueryId}::${snap.provider}`
      const arr = rawByQueryProvider.get(key)
      if (arr) arr.push(snap)
      else rawByQueryProvider.set(key, [snap])
    }

    // Index raw snapshots by query+provider+model for per-model timelines
    const rawByQueryModel = new Map<string, typeof allSnapshotsResolved[number][]>()
    for (const snap of allSnapshotsResolved) {
      if (!snap.resolvedQueryId) continue
      const key = `${snap.resolvedQueryId}::${snap.provider}:${snap.model ?? 'unknown'}`
      const arr = rawByQueryModel.get(key)
      if (arr) arr.push(snap)
      else rawByQueryModel.set(key, [snap])
    }

    function computeTransitions(snaps: typeof allSnapshots) {
      return snaps.map((snap, idx) => {
        const run = projectRuns.find(r => r.id === snap.runId)
        let transition: string = snap.citationState === CitationStates.cited ? 'cited' : 'not-cited'
        let visibilityTransition: string = snap.answerMentioned ? 'visible' : 'not-visible'
        let mentionTransition: string = snap.answerMentioned ? 'mentioned' : 'not-mentioned'

        if (idx === 0) {
          transition = 'new'
          visibilityTransition = 'new'
          mentionTransition = 'new'
        } else {
          const prev = snaps[idx - 1]!
          if (prev.citationState === CitationStates['not-cited'] && snap.citationState === CitationStates.cited) {
            transition = 'emerging'
          } else if (prev.citationState === CitationStates.cited && snap.citationState === CitationStates['not-cited']) {
            transition = 'lost'
          }

          if (!prev.answerMentioned && snap.answerMentioned) {
            visibilityTransition = 'emerging'
            mentionTransition = 'emerging'
          } else if (prev.answerMentioned && !snap.answerMentioned) {
            visibilityTransition = 'lost'
            mentionTransition = 'lost'
          }
        }

        return {
          runId: snap.runId,
          createdAt: run?.createdAt ?? snap.createdAt,
          citationState: snap.citationState,
          transition,
          answerMentioned: snap.answerMentioned,
          // Legacy aliases of `mentionState` / `mentionTransition`.
          visibilityState: snap.answerMentioned ? 'visible' : 'not-visible',
          visibilityTransition,
          // Canonical-vocabulary fields — new consumers prefer these.
          mentionState: snap.answerMentioned ? 'mentioned' : 'not-mentioned',
          mentionTransition,
          location: snap.location,
        }
      })
    }

    // Build per-query timeline
    const timeline = projectQueries.map(q => {
      const qSnapshots = dedupedSnapshots
        .filter(s => s.resolvedQueryId === q.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

      const runEntries = computeTransitions(qSnapshots)

      // Build per-provider run histories from raw snapshots
      const providerRuns: Record<string, typeof runEntries> = {}
      const providerKeys = [...rawByQueryProvider.keys()].filter(k => k.startsWith(`${q.id}::`))
      for (const pk of providerKeys) {
        const provider = pk.split('::')[1]!
        const provSnaps = rawByQueryProvider.get(pk)!
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        providerRuns[provider] = computeTransitions(provSnaps)
      }

      // Build per-model run histories (keyed by "provider:model")
      const modelRuns: Record<string, typeof runEntries> = {}
      const modelKeys = [...rawByQueryModel.keys()].filter(k => k.startsWith(`${q.id}::`))
      for (const mk of modelKeys) {
        const modelKey = mk.split('::')[1]! // "provider:model"
        const modelSnaps = rawByQueryModel.get(mk)!
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        modelRuns[modelKey] = computeTransitions(modelSnaps)
      }

      return {
        query: q.query,
        runs: runEntries,
        providerRuns,
        modelRuns,
      }
    })

    return reply.send(timeline)
  })

  // GET /projects/:name/snapshots/diff — compare two runs
  app.get<{
    Params: { name: string }
    Querystring: { run1: string; run2: string }
  }>('/projects/:name/snapshots/diff', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const { run1, run2 } = request.query
    if (!run1 || !run2) {
      throw validationError('Both run1 and run2 query params are required')
    }

    const requestedRunIds = [...new Set([run1, run2])]
    const runRows = app.db
      .select({ id: runs.id, projectId: runs.projectId })
      .from(runs)
      .where(inArray(runs.id, requestedRunIds))
      .all()
    const runsById = new Map(runRows.map(row => [row.id, row]))
    for (const runId of requestedRunIds) {
      const run = runsById.get(runId)
      if (!run || run.projectId !== project.id) {
        throw notFound('Run', runId)
      }
    }

    // Get snapshots for both runs
    const snaps1 = app.db
      .select({
        queryId: querySnapshots.queryId,
        query: queries.query,
        citationState: querySnapshots.citationState,
        answerMentioned: querySnapshots.answerMentioned,
        answerText: querySnapshots.answerText,
      })
      .from(querySnapshots)
      .leftJoin(queries, eq(querySnapshots.queryId, queries.id))
      .where(eq(querySnapshots.runId, run1))
      .all()

    const snaps2 = app.db
      .select({
        queryId: querySnapshots.queryId,
        query: queries.query,
        citationState: querySnapshots.citationState,
        answerMentioned: querySnapshots.answerMentioned,
        answerText: querySnapshots.answerText,
      })
      .from(querySnapshots)
      .leftJoin(queries, eq(querySnapshots.queryId, queries.id))
      .where(eq(querySnapshots.runId, run2))
      .all()

    // Build a query-level lookup across providers. Citation and answer mention
    // are aggregated independently: a query may be cited by one engine and
    // mentioned by another, and neither signal may erase the other.
    const map1 = new Map<string | null, (typeof snaps1[number]) & {
      resolvedAnswerMentioned: boolean
    }>()
    for (const s of snaps1) {
      const existing = map1.get(s.queryId)
      map1.set(s.queryId, {
        ...s,
        query: existing?.query ?? s.query,
        citationState: existing?.citationState === CitationStates.cited || s.citationState === CitationStates.cited
          ? CitationStates.cited
          : CitationStates['not-cited'],
        resolvedAnswerMentioned: (existing?.resolvedAnswerMentioned ?? false) || resolveSnapshotAnswerMentioned(s, project),
      })
    }
    const map2 = new Map<string | null, (typeof snaps2[number]) & {
      resolvedAnswerMentioned: boolean
    }>()
    for (const s of snaps2) {
      const existing = map2.get(s.queryId)
      map2.set(s.queryId, {
        ...s,
        query: existing?.query ?? s.query,
        citationState: existing?.citationState === CitationStates.cited || s.citationState === CitationStates.cited
          ? CitationStates.cited
          : CitationStates['not-cited'],
        resolvedAnswerMentioned: (existing?.resolvedAnswerMentioned ?? false) || resolveSnapshotAnswerMentioned(s, project),
      })
    }

    // Compute diff for all queries present in either run
    const allQueryIds = new Set([...map1.keys(), ...map2.keys()])
    const diff = [...allQueryIds].map(qId => {
      const s1 = map1.get(qId)
      const s2 = map2.get(qId)
      return {
        queryId: qId,
        query: s2?.query ?? s1?.query ?? null,
        run1State: s1?.citationState ?? null,
        run2State: s2?.citationState ?? null,
        run1AnswerMentioned: s1?.resolvedAnswerMentioned ?? null,
        run2AnswerMentioned: s2?.resolvedAnswerMentioned ?? null,
        // Legacy aliases — same data as run{1,2}MentionState below.
        run1VisibilityState: s1 ? visibilityStateFromAnswerMentioned(s1.resolvedAnswerMentioned) : null,
        run2VisibilityState: s2 ? visibilityStateFromAnswerMentioned(s2.resolvedAnswerMentioned) : null,
        run1MentionState: s1 ? mentionStateFromAnswerMentioned(s1.resolvedAnswerMentioned) : null,
        run2MentionState: s2 ? mentionStateFromAnswerMentioned(s2.resolvedAnswerMentioned) : null,
        changed: (s1?.citationState ?? null) !== (s2?.citationState ?? null),
        visibilityChanged: (s1?.resolvedAnswerMentioned ?? null) !== (s2?.resolvedAnswerMentioned ?? null),
      }
    })

    return reply.send({ run1, run2, diff })
  })
}

function formatAuditEntry(row: {
  id: string
  projectId: string | null
  actor: string
  action: string
  entityType: string
  entityId: string | null
  diff: string | null
  userAgent: string | null
  actorSession: string | null
  createdAt: string
}) {
  return {
    id: row.id,
    projectId: row.projectId,
    actor: row.actor,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    diff: row.diff
      ? row.entityType === 'notification'
        ? redactNotificationDiff(parseJsonColumn<unknown>(row.diff, null))
        : parseJsonColumn<unknown>(row.diff, null)
      : null,
    userAgent: row.userAgent,
    actorSession: row.actorSession,
    createdAt: row.createdAt,
  }
}

interface AuditHistoryQuery {
  limit?: string
  offset?: string
  since?: string
  action?: string
  actor?: string
  entityType?: string
}

function addAuditHistoryFilters(filters: SQL[], query: AuditHistoryQuery): void {
  if (query.since && !Number.isNaN(Date.parse(query.since))) filters.push(gte(auditLog.createdAt, query.since))
  if (query.action) filters.push(eq(auditLog.action, query.action))
  if (query.actor) filters.push(eq(auditLog.actor, query.actor))
  if (query.entityType) filters.push(eq(auditLog.entityType, query.entityType))
}

function parseBoundedInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.min(parsed, max)
}

function parseOptionalPositiveInt(value: string | undefined, max: number): number | undefined {
  if (value == null) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.min(parsed, max)
}
