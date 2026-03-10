import { eq, desc, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { auditLog, querySnapshots, runs, keywords } from '@ainyc/canonry-db'
import { resolveProject } from './helpers.js'

export async function historyRoutes(app: FastifyInstance) {
  // GET /projects/:name/history — audit log for project
  app.get<{ Params: { name: string } }>('/projects/:name/history', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const rows = app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.projectId, project.id))
      .orderBy(desc(auditLog.createdAt))
      .all()

    return reply.send(rows.map(formatAuditEntry))
  })

  // GET /history — global audit log
  app.get('/history', async (_request, reply) => {
    const rows = app.db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.createdAt))
      .all()

    return reply.send(rows.map(formatAuditEntry))
  })

  // GET /projects/:name/snapshots — query snapshots for project (paginated)
  app.get<{
    Params: { name: string }
    Querystring: { limit?: string; offset?: string }
  }>('/projects/:name/snapshots', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const limit = parseInt(request.query.limit ?? '50', 10)
    const offset = parseInt(request.query.offset ?? '0', 10)

    // Get all runs for this project
    const projectRuns = app.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.projectId, project.id))
      .all()

    if (projectRuns.length === 0) {
      return reply.send({ snapshots: [], total: 0 })
    }

    // Get snapshots for these runs
    const allSnapshots = app.db
      .select({
        id: querySnapshots.id,
        runId: querySnapshots.runId,
        keywordId: querySnapshots.keywordId,
        keyword: keywords.keyword,
        provider: querySnapshots.provider,
        citationState: querySnapshots.citationState,
        answerText: querySnapshots.answerText,
        citedDomains: querySnapshots.citedDomains,
        competitorOverlap: querySnapshots.competitorOverlap,
        createdAt: querySnapshots.createdAt,
      })
      .from(querySnapshots)
      .leftJoin(keywords, eq(querySnapshots.keywordId, keywords.id))
      .where(inArray(querySnapshots.runId, projectRuns.map(r => r.id)))
      .orderBy(desc(querySnapshots.createdAt))
      .all()

    const total = allSnapshots.length
    const paged = allSnapshots.slice(offset, offset + limit)

    return reply.send({
      snapshots: paged.map(s => ({
        id: s.id,
        runId: s.runId,
        keywordId: s.keywordId,
        keyword: s.keyword,
        provider: s.provider,
        citationState: s.citationState,
        answerText: s.answerText,
        citedDomains: tryParseJson(s.citedDomains, [] as string[]),
        competitorOverlap: tryParseJson(s.competitorOverlap, [] as string[]),
        createdAt: s.createdAt,
      })),
      total,
    })
  })

  // GET /projects/:name/timeline — per-keyword citation state over time
  app.get<{ Params: { name: string } }>('/projects/:name/timeline', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    // Get project keywords
    const projectKeywords = app.db
      .select()
      .from(keywords)
      .where(eq(keywords.projectId, project.id))
      .all()

    // Get project runs ordered by creation time
    const projectRuns = app.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, project.id))
      .orderBy(runs.createdAt)
      .all()

    if (projectRuns.length === 0 || projectKeywords.length === 0) {
      return reply.send([])
    }

    const runIds = new Set(projectRuns.map(r => r.id))

    // Get snapshots for these runs
    const allSnapshots = app.db
      .select()
      .from(querySnapshots)
      .where(inArray(querySnapshots.runId, [...runIds]))
      .all()

    // Deduplicate to one entry per (runId, keywordId) before building transitions so that
    // multi-provider runs don't produce spurious transition events within a single run.
    // Prefer 'cited' when providers disagree within the same run.
    const deduped = new Map<string, typeof allSnapshots[number]>()
    for (const snap of allSnapshots) {
      const key = `${snap.runId}:${snap.keywordId}`
      const existing = deduped.get(key)
      if (!existing || snap.citationState === 'cited') {
        deduped.set(key, snap)
      }
    }
    const dedupedSnapshots = [...deduped.values()]

    // Build per-keyword timeline
    const timeline = projectKeywords.map(kw => {
      const kwSnapshots = dedupedSnapshots
        .filter(s => s.keywordId === kw.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

      const runEntries = kwSnapshots.map((snap, idx) => {
        const run = projectRuns.find(r => r.id === snap.runId)
        let transition: string = snap.citationState === 'cited' ? 'cited' : 'not-cited'

        if (idx === 0) {
          transition = 'new'
        } else {
          const prev = kwSnapshots[idx - 1]!
          if (prev.citationState === 'not-cited' && snap.citationState === 'cited') {
            transition = 'emerging'
          } else if (prev.citationState === 'cited' && snap.citationState === 'not-cited') {
            transition = 'lost'
          }
        }

        return {
          runId: snap.runId,
          createdAt: run?.createdAt ?? snap.createdAt,
          citationState: snap.citationState,
          transition,
        }
      })

      return {
        keyword: kw.keyword,
        runs: runEntries,
      }
    })

    return reply.send(timeline)
  })

  // GET /projects/:name/snapshots/diff — compare two runs
  app.get<{
    Params: { name: string }
    Querystring: { run1: string; run2: string }
  }>('/projects/:name/snapshots/diff', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const { run1, run2 } = request.query
    if (!run1 || !run2) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Both run1 and run2 query params are required' } })
    }

    // Get snapshots for both runs
    const snaps1 = app.db
      .select({
        keywordId: querySnapshots.keywordId,
        keyword: keywords.keyword,
        citationState: querySnapshots.citationState,
      })
      .from(querySnapshots)
      .leftJoin(keywords, eq(querySnapshots.keywordId, keywords.id))
      .where(eq(querySnapshots.runId, run1))
      .all()

    const snaps2 = app.db
      .select({
        keywordId: querySnapshots.keywordId,
        keyword: keywords.keyword,
        citationState: querySnapshots.citationState,
      })
      .from(querySnapshots)
      .leftJoin(keywords, eq(querySnapshots.keywordId, keywords.id))
      .where(eq(querySnapshots.runId, run2))
      .all()

    // Build lookup by keyword id — prefer 'cited' when multiple providers gave different
    // states for the same keyword within a run (same logic as the timeline deduplication)
    const map1 = new Map<string | null, typeof snaps1[number]>()
    for (const s of snaps1) {
      const existing = map1.get(s.keywordId)
      if (!existing || s.citationState === 'cited') map1.set(s.keywordId, s)
    }
    const map2 = new Map<string | null, typeof snaps2[number]>()
    for (const s of snaps2) {
      const existing = map2.get(s.keywordId)
      if (!existing || s.citationState === 'cited') map2.set(s.keywordId, s)
    }

    // Compute diff for all keywords present in either run
    const allKeywordIds = new Set([...map1.keys(), ...map2.keys()])
    const diff = [...allKeywordIds].map(kwId => {
      const s1 = map1.get(kwId)
      const s2 = map2.get(kwId)
      return {
        keywordId: kwId,
        keyword: s2?.keyword ?? s1?.keyword ?? null,
        run1State: s1?.citationState ?? null,
        run2State: s2?.citationState ?? null,
        changed: (s1?.citationState ?? null) !== (s2?.citationState ?? null),
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
  createdAt: string
}) {
  return {
    id: row.id,
    projectId: row.projectId,
    actor: row.actor,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    diff: row.diff ? tryParseJson(row.diff, null) : null,
    createdAt: row.createdAt,
  }
}

function tryParseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function resolveProjectSafe(app: FastifyInstance, name: string, reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
  try {
    return resolveProject(app.db, name)
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'statusCode' in e && 'toJSON' in e) {
      const err = e as { statusCode: number; toJSON(): unknown }
      reply.status(err.statusCode).send(err.toJSON())
      return null
    }
    throw e
  }
}
