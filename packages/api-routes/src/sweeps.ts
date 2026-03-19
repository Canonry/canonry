import crypto from 'node:crypto'
import { eq, asc, and, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { indexingSweeps, indexingSweepResults, keywords, projects } from '@ainyc/canonry-db'
import { resolveProject, writeAuditLog } from './helpers.js'

const ALLOWED_TRIGGERS = new Set(['manual', 'scheduled', 'api'])

export interface SweepRoutesOptions {
  /** Called when a new indexing sweep is created */
  onSweepCreated?: (sweepId: string, projectId: string, keyword?: string) => void
}

export async function sweepRoutes(app: FastifyInstance, opts: SweepRoutesOptions) {
  // POST /projects/:name/sweeps — trigger an indexing sweep
  app.post<{
    Params: { name: string }
    Body: { keyword?: string; trigger?: string }
  }>('/projects/:name/sweeps', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const now = new Date().toISOString()
    const trigger = ALLOWED_TRIGGERS.has(request.body?.trigger ?? '')
      ? request.body!.trigger!
      : 'manual'
    const keyword = request.body?.keyword

    // Guard against concurrent sweeps for the same project.
    // Wrap the check+insert in a transaction so two simultaneous requests cannot
    // both observe no active sweep and then both insert — SQLite serialises writers.
    const sweepId = crypto.randomUUID()
    const txResult = app.db.transaction((tx) => {
      const activeSweep = tx
        .select()
        .from(indexingSweeps)
        .where(
          and(
            eq(indexingSweeps.projectId, project.id),
            inArray(indexingSweeps.status, ['queued', 'running']),
          ),
        )
        .get()
      if (activeSweep) {
        return { conflict: true, activeSweep } as const
      }

      tx.insert(indexingSweeps).values({
        id: sweepId,
        projectId: project.id,
        status: 'queued',
        trigger,
        createdAt: now,
      }).run()

      return { conflict: false } as const
    })

    if (txResult.conflict) {
      return reply.status(409).send({ error: `Sweep ${txResult.activeSweep.id} is already ${txResult.activeSweep.status}` })
    }

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'sweep.created',
      entityType: 'indexing_sweep',
      entityId: sweepId,
    })

    const sweep = app.db.select().from(indexingSweeps).where(eq(indexingSweeps.id, sweepId)).get()!

    if (opts.onSweepCreated) {
      opts.onSweepCreated(sweepId, project.id, keyword)
    }

    return reply.status(201).send(formatSweep(sweep))
  })

  // GET /projects/:name/sweeps — list sweeps for project
  app.get<{ Params: { name: string } }>('/projects/:name/sweeps', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return
    const rows = app.db.select().from(indexingSweeps)
      .where(eq(indexingSweeps.projectId, project.id))
      .orderBy(asc(indexingSweeps.createdAt))
      .all()
    return reply.send(rows.map(formatSweep))
  })

  // GET /sweeps/:id — get sweep with results
  app.get<{ Params: { id: string } }>('/sweeps/:id', async (request, reply) => {
    const sweep = app.db.select().from(indexingSweeps).where(eq(indexingSweeps.id, request.params.id)).get()
    if (!sweep) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Sweep '${request.params.id}' not found` } })
    }

    const results = app.db
      .select({
        id: indexingSweepResults.id,
        sweepId: indexingSweepResults.sweepId,
        keywordId: indexingSweepResults.keywordId,
        keyword: keywords.keyword,
        domain: indexingSweepResults.domain,
        domainRole: indexingSweepResults.domainRole,
        indexedPageCount: indexingSweepResults.indexedPageCount,
        topPages: indexingSweepResults.topPages,
        createdAt: indexingSweepResults.createdAt,
      })
      .from(indexingSweepResults)
      .leftJoin(keywords, eq(indexingSweepResults.keywordId, keywords.id))
      .where(eq(indexingSweepResults.sweepId, sweep.id))
      .all()

    return reply.send({
      ...formatSweep(sweep),
      results: results.map(r => ({
        ...r,
        topPages: tryParseJson(r.topPages, []),
      })),
    })
  })

  // GET /sweeps — list all sweeps across all projects (paginated)
  app.get<{ Querystring: { limit?: string; offset?: string } }>('/sweeps', async (request, reply) => {
    const limit = Math.min(Math.max(parseInt(String(request.query.limit ?? '50'), 10) || 50, 1), 200)
    const offset = Math.max(parseInt(String(request.query.offset ?? '0'), 10) || 0, 0)
    const rows = app.db
      .select({
        id: indexingSweeps.id,
        projectId: indexingSweeps.projectId,
        projectName: projects.name,
        status: indexingSweeps.status,
        trigger: indexingSweeps.trigger,
        startedAt: indexingSweeps.startedAt,
        finishedAt: indexingSweeps.finishedAt,
        error: indexingSweeps.error,
        createdAt: indexingSweeps.createdAt,
      })
      .from(indexingSweeps)
      .leftJoin(projects, eq(indexingSweeps.projectId, projects.id))
      .orderBy(asc(indexingSweeps.createdAt))
      .limit(limit)
      .offset(offset)
      .all()
    return reply.send(rows.map(r => ({ ...formatSweep(r), projectName: r.projectName })))
  })
}

function formatSweep(row: {
  id: string
  projectId: string
  status: string
  trigger: string
  startedAt?: string | null
  finishedAt?: string | null
  error?: string | null
  createdAt: string
}) {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    error: row.error ?? null,
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

function resolveProjectSafe(
  app: FastifyInstance,
  name: string,
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
) {
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
