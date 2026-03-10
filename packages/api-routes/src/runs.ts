import { eq, asc } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { runs, querySnapshots, keywords } from '@ainyc/canonry-db'
import { unsupportedKind, runInProgress } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import { queueRunIfProjectIdle } from './run-queue.js'

export interface RunRoutesOptions {
  onRunCreated?: (runId: string, projectId: string, providers?: string[]) => void
}

export async function runRoutes(app: FastifyInstance, opts: RunRoutesOptions) {
  // POST /projects/:name/runs — trigger a run
  app.post<{
    Params: { name: string }
    Body: { kind?: string; trigger?: string; providers?: string[] }
  }>('/projects/:name/runs', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const kind = request.body?.kind ?? 'answer-visibility'
    if (kind !== 'answer-visibility') {
      const err = unsupportedKind(kind)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const now = new Date().toISOString()
    const trigger = request.body?.trigger ?? 'manual'
    const rawProviders = request.body?.providers
    const validProviders = ['gemini', 'openai', 'claude', 'local'] as const
    if (rawProviders?.length) {
      const invalid = rawProviders.filter(p => !(validProviders as readonly string[]).includes(p))
      if (invalid.length) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid provider(s): ${invalid.join(', ')}. Must be one of: ${validProviders.join(', ')}` } })
      }
    }
    const providers = rawProviders?.length ? rawProviders : undefined

    const queueResult = queueRunIfProjectIdle(app.db, {
      createdAt: now,
      kind,
      projectId: project.id,
      trigger,
    })

    if (queueResult.conflict) {
      const err = runInProgress(project.name)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const runId = queueResult.runId

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'run.created',
      entityType: 'run',
      entityId: runId,
    })

    const run = app.db.select().from(runs).where(eq(runs.id, runId)).get()!

    if (opts.onRunCreated) {
      opts.onRunCreated(runId, project.id, providers)
    }

    return reply.status(201).send(formatRun(run))
  })

  // GET /projects/:name/runs — list runs for project
  app.get<{ Params: { name: string } }>('/projects/:name/runs', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return
    const rows = app.db.select().from(runs).where(eq(runs.projectId, project.id)).orderBy(asc(runs.createdAt)).all()
    return reply.send(rows.map(formatRun))
  })

  // GET /runs — list all runs
  app.get('/runs', async (_request, reply) => {
    const rows = app.db.select().from(runs).all()
    return reply.send(rows.map(formatRun))
  })

  // GET /runs/:id — get single run with snapshots
  app.get<{ Params: { id: string } }>('/runs/:id', async (request, reply) => {
    const run = app.db.select().from(runs).where(eq(runs.id, request.params.id)).get()
    if (!run) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Run '${request.params.id}' not found` } })
    }

    const snapshots = app.db
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
        rawResponse: querySnapshots.rawResponse,
        createdAt: querySnapshots.createdAt,
      })
      .from(querySnapshots)
      .leftJoin(keywords, eq(querySnapshots.keywordId, keywords.id))
      .where(eq(querySnapshots.runId, run.id))
      .all()

    return reply.send({
      ...formatRun(run),
      snapshots: snapshots.map(s => ({
        id: s.id,
        runId: s.runId,
        keywordId: s.keywordId,
        keyword: s.keyword,
        provider: s.provider,
        citationState: s.citationState,
        answerText: s.answerText,
        citedDomains: tryParseJson(s.citedDomains, []),
        competitorOverlap: tryParseJson(s.competitorOverlap, []),
        ...parseSnapshotRawResponse(s.rawResponse),
        createdAt: s.createdAt,
      })),
    })
  })
}

function formatRun(row: {
  id: string
  projectId: string
  kind: string
  status: string
  trigger: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  createdAt: string
}) {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    error: row.error,
    createdAt: row.createdAt,
  }
}

function parseSnapshotRawResponse(raw: string | null): {
  groundingSources: unknown[]
  searchQueries: string[]
  model: string | null
} {
  const parsed = tryParseJson(raw ?? '{}', {} as Record<string, unknown>)
  return {
    groundingSources: (parsed.groundingSources as unknown[] | undefined) ?? [],
    searchQueries: (parsed.searchQueries as string[] | undefined) ?? [],
    model: (parsed.model as string | undefined) ?? null,
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
