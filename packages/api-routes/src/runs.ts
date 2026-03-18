import crypto from 'node:crypto'
import { eq, asc } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { runs, querySnapshots, keywords, projects } from '@ainyc/canonry-db'
import type { LocationContext } from '@ainyc/canonry-contracts'
import { unsupportedKind, runInProgress, runNotCancellable, notFound, parseProviderName } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import { queueRunIfProjectIdle } from './run-queue.js'

export interface RunRoutesOptions {
  onRunCreated?: (runId: string, projectId: string, providers?: string[], location?: LocationContext | null) => void
}

export async function runRoutes(app: FastifyInstance, opts: RunRoutesOptions) {
  // POST /projects/:name/runs — trigger a run
  app.post<{
    Params: { name: string }
    Body: { kind?: string; trigger?: string; providers?: string[]; location?: string; allLocations?: boolean; noLocation?: boolean }
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
    if (rawProviders?.length) {
      const parsed = rawProviders.map(p => parseProviderName(p))
      const invalid = rawProviders.filter((_, i) => !parsed[i])
      if (invalid.length) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid provider(s): ${invalid.join(', ')}. Must be one of: gemini, openai, claude, local` } })
      }
      // Use normalized names
      rawProviders.splice(0, rawProviders.length, ...parsed.filter(Boolean) as string[])
    }
    const providers = rawProviders?.length ? rawProviders : undefined

    // Resolve location for this run
    let resolvedLocation: LocationContext | null | undefined
    const projectLocations = JSON.parse(project.locations || '[]') as LocationContext[]

    if (request.body?.noLocation) {
      resolvedLocation = null // explicitly no location
    } else if (request.body?.allLocations) {
      // allLocations triggers one run per location — handled below
    } else if (request.body?.location) {
      const loc = projectLocations.find(l => l.label === request.body.location)
      if (!loc) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: `Location "${request.body.location}" not found. Configure it first.` } })
      }
      resolvedLocation = loc
    }
    // else resolvedLocation = undefined → use project default

    // Handle --all-locations: create one run per configured location
    // Skip the idle-check here — each location gets its own run regardless of other active runs.
    if (request.body?.allLocations) {
      if (projectLocations.length === 0) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'No locations configured for this project' } })
      }

      // Insert all run records first, then dispatch — bypassing queueRunIfProjectIdle
      // which would block after the first run is inserted.
      const newRuns: Array<{ runId: string; loc: LocationContext }> = []
      for (const loc of projectLocations) {
        const runId = crypto.randomUUID()
        app.db.insert(runs).values({
          id: runId,
          projectId: project.id,
          kind,
          status: 'queued',
          trigger,
          location: loc.label,
          createdAt: now,
        }).run()
        newRuns.push({ runId, loc })
      }

      const results = []
      for (const { runId, loc } of newRuns) {
        writeAuditLog(app.db, {
          projectId: project.id,
          actor: 'api',
          action: 'run.created',
          entityType: 'run',
          entityId: runId,
        })
        const r = app.db.select().from(runs).where(eq(runs.id, runId)).get()!
        if (opts.onRunCreated) {
          opts.onRunCreated(runId, project.id, providers, loc)
        }
        results.push({ ...formatRun(r), location: loc.label })
      }
      return reply.status(207).send(results)
    }

    const locationLabel = resolvedLocation?.label ?? null
    const queueResult = queueRunIfProjectIdle(app.db, {
      createdAt: now,
      kind,
      projectId: project.id,
      trigger,
      location: locationLabel,
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
      opts.onRunCreated(runId, project.id, providers, resolvedLocation)
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

  // POST /runs — trigger a run for all projects
  app.post<{
    Body: { kind?: string; providers?: string[] }
  }>('/runs', async (request, reply) => {
    const allProjects = app.db.select().from(projects).all()
    if (allProjects.length === 0) {
      return reply.status(207).send([])
    }

    const kind = request.body?.kind ?? 'answer-visibility'
    if (kind !== 'answer-visibility') {
      const err = unsupportedKind(kind)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const rawProviders = request.body?.providers
    if (rawProviders?.length) {
      const parsed = rawProviders.map(p => parseProviderName(p))
      const invalid = rawProviders.filter((_, i) => !parsed[i])
      if (invalid.length) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid provider(s): ${invalid.join(', ')}. Must be one of: gemini, openai, claude, local` } })
      }
      rawProviders.splice(0, rawProviders.length, ...parsed.filter(Boolean) as string[])
    }
    const providers = rawProviders?.length ? rawProviders : undefined

    const now = new Date().toISOString()
    const results = []

    for (const project of allProjects) {
      const queueResult = queueRunIfProjectIdle(app.db, {
        createdAt: now,
        kind,
        projectId: project.id,
        trigger: 'manual',
      })

      if (queueResult.conflict) {
        results.push({ projectName: project.name, projectId: project.id, status: 'conflict', error: 'run_in_progress' })
        continue
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

      results.push({ ...formatRun(run), projectName: project.name })
    }

    return reply.status(207).send(results)
  })

  // POST /runs/:id/cancel — cancel a queued or running run
  app.post<{ Params: { id: string } }>('/runs/:id/cancel', async (request, reply) => {
    const run = app.db.select().from(runs).where(eq(runs.id, request.params.id)).get()
    if (!run) {
      const err = notFound('Run', request.params.id)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const terminalStatuses = new Set(['completed', 'partial', 'failed', 'cancelled'])
    if (terminalStatuses.has(run.status)) {
      const err = runNotCancellable(run.id, run.status)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const now = new Date().toISOString()
    app.db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: now, error: 'Cancelled by user' })
      .where(eq(runs.id, run.id))
      .run()

    writeAuditLog(app.db, {
      projectId: run.projectId,
      actor: 'api',
      action: 'run.cancelled',
      entityType: 'run',
      entityId: run.id,
    })

    const updated = app.db.select().from(runs).where(eq(runs.id, run.id)).get()!
    return reply.send(formatRun(updated))
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
        model: querySnapshots.model,
        citationState: querySnapshots.citationState,
        answerText: querySnapshots.answerText,
        citedDomains: querySnapshots.citedDomains,
        competitorOverlap: querySnapshots.competitorOverlap,
        location: querySnapshots.location,
        rawResponse: querySnapshots.rawResponse,
        createdAt: querySnapshots.createdAt,
      })
      .from(querySnapshots)
      .leftJoin(keywords, eq(querySnapshots.keywordId, keywords.id))
      .where(eq(querySnapshots.runId, run.id))
      .all()

    return reply.send({
      ...formatRun(run),
      snapshots: snapshots.map(s => {
        const rawParsed = parseSnapshotRawResponse(s.rawResponse)
        return {
          id: s.id,
          runId: s.runId,
          keywordId: s.keywordId,
          keyword: s.keyword,
          provider: s.provider,
          citationState: s.citationState,
          answerText: s.answerText,
          citedDomains: tryParseJson(s.citedDomains, []),
          competitorOverlap: tryParseJson(s.competitorOverlap, []),
          model: s.model ?? rawParsed.model,
          location: s.location,
          groundingSources: rawParsed.groundingSources,
          searchQueries: rawParsed.searchQueries,
          createdAt: s.createdAt,
        }
      }),
    })
  })
}

function formatRun(row: {
  id: string
  projectId: string
  kind: string
  status: string
  trigger: string
  location: string | null
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
    location: row.location,
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
