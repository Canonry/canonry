import crypto from 'node:crypto'
import { eq, asc, desc, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { runs, querySnapshots, keywords, projects, parseJsonColumn } from '@ainyc/canonry-db'
import type { LocationContext } from '@ainyc/canonry-contracts'
import {
  RunKinds,
  RunTriggers,
  runTriggerRequestSchema,
  unsupportedKind,
  runInProgress,
  runNotCancellable,
  notFound,
  validationError,
} from '@ainyc/canonry-contracts'
import { resolveProject, resolveSnapshotAnswerMentioned, resolveSnapshotVisibilityState, resolveSnapshotMatchedTerms, writeAuditLog } from './helpers.js'
import { queueRunIfProjectIdle } from './run-queue.js'

export interface RunRoutesOptions {
  onRunCreated?: (runId: string, projectId: string, providers?: string[], location?: LocationContext | null) => void
  /** Valid provider names from registered adapters — used to reject unknown providers */
  validProviderNames?: string[]
}

export async function runRoutes(app: FastifyInstance, opts: RunRoutesOptions) {
  // POST /projects/:name/runs — trigger a run
  app.post<{
    Params: { name: string }
    Body: { kind?: string; trigger?: string; providers?: string[]; location?: string; allLocations?: boolean; noLocation?: boolean }
  }>('/projects/:name/runs', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const body = parseRunTriggerRequest(request.body ?? {})

    const now = new Date().toISOString()
    const kind = body.kind ?? RunKinds['answer-visibility']
    const trigger = body.trigger ?? RunTriggers.manual
    const rawProviders = body.providers
    if (rawProviders?.length) {
      const normalized = rawProviders.map(p => p.trim().toLowerCase()).filter(Boolean)
      const validNames = opts.validProviderNames ?? []
      if (validNames.length) {
        const invalid = normalized.filter(p => !validNames.includes(p))
        if (invalid.length) {
          throw validationError(`Invalid provider(s): ${invalid.join(', ')}. Must be one of: ${validNames.join(', ')}`, {
            invalidProviders: invalid,
            validProviders: validNames,
          })
        }
      }
      rawProviders.splice(0, rawProviders.length, ...normalized)
    }
    const providers = rawProviders?.length ? rawProviders : undefined

    // Resolve location for this run
    let resolvedLocation: LocationContext | null | undefined
    const projectLocations = parseJsonColumn<LocationContext[]>(project.locations, [])

    if (body.noLocation) {
      resolvedLocation = null // explicitly no location
    } else if (body.allLocations) {
      // allLocations triggers one run per location — handled below
    } else if (body.location) {
      const loc = projectLocations.find(l => l.label === body.location)
      if (!loc) {
        throw validationError(`Location "${body.location}" not found. Configure it first.`)
      }
      resolvedLocation = loc
    } else if (project.defaultLocation) {
      // Auto-apply project's configured default location
      const loc = projectLocations.find(l => l.label === project.defaultLocation)
      if (!loc) {
        throw validationError(`Default location "${project.defaultLocation}" not found. Update the project configuration.`)
      }
      resolvedLocation = loc
    }

    // Handle --all-locations: create one run per configured location
    // Skip the idle-check here — each location gets its own run regardless of other active runs.
    if (body.allLocations) {
      if (projectLocations.length === 0) {
        throw validationError('No locations configured for this project')
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

    if (queueResult.conflict) throw runInProgress(project.name)

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
  app.get<{
    Params: { name: string }
    Querystring: { limit?: string }
  }>('/projects/:name/runs', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const parsedLimit = parseInt(request.query.limit ?? '', 10)
    const limit = Number.isNaN(parsedLimit) || parsedLimit <= 0 ? undefined : parsedLimit

    const rows = limit == null
      ? app.db
        .select()
        .from(runs)
        .where(eq(runs.projectId, project.id))
        .orderBy(asc(runs.createdAt))
        .all()
      : app.db
        .select()
        .from(runs)
        .where(eq(runs.projectId, project.id))
        .orderBy(desc(runs.createdAt))
        .limit(limit)
        .all()
        .reverse()

    return reply.send(rows.map(formatRun))
  })

  // GET /projects/:name/runs/latest — latest run plus total run count
  app.get<{ Params: { name: string } }>('/projects/:name/runs/latest', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const countRow = app.db
      .select({ count: sql<number>`count(*)` })
      .from(runs)
      .where(eq(runs.projectId, project.id))
      .get()
    const totalRuns = countRow?.count ?? 0

    const latestRun = app.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, project.id))
      .orderBy(desc(runs.createdAt))
      .limit(1)
      .get()

    if (!latestRun) {
      return reply.send({ totalRuns: 0, run: null })
    }

    return reply.send({
      totalRuns,
      run: loadRunDetail(app, latestRun),
    })
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
    if (kind !== 'answer-visibility') throw unsupportedKind(kind)

    const rawProviders = request.body?.providers
    if (rawProviders?.length) {
      const normalized = rawProviders.map(p => p.trim().toLowerCase()).filter(Boolean)
      const validNames = opts.validProviderNames ?? []
      if (validNames.length) {
        const invalid = normalized.filter(p => !validNames.includes(p))
        if (invalid.length) {
          throw validationError(`Invalid provider(s): ${invalid.join(', ')}. Must be one of: ${validNames.join(', ')}`, {
            invalidProviders: invalid,
            validProviders: validNames,
          })
        }
      }
      rawProviders.splice(0, rawProviders.length, ...normalized)
    }
    const providers = rawProviders?.length ? rawProviders : undefined

    const now = new Date().toISOString()
    const results = []

    for (const project of allProjects) {
      // Resolve default location for this project
      const projectLocations = parseJsonColumn<LocationContext[]>(project.locations, [])
      let resolvedLocation: LocationContext | undefined
      if (project.defaultLocation) {
        const loc = projectLocations.find(l => l.label === project.defaultLocation)
        if (!loc) {
          results.push({ projectName: project.name, projectId: project.id, status: 'error', error: `Default location "${project.defaultLocation}" not found` })
          continue
        }
        resolvedLocation = loc
      }
      const locationLabel = resolvedLocation?.label ?? null

      const queueResult = queueRunIfProjectIdle(app.db, {
        createdAt: now,
        kind,
        projectId: project.id,
        trigger: 'manual',
        location: locationLabel,
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
        opts.onRunCreated(runId, project.id, providers, resolvedLocation)
      }

      results.push({ ...formatRun(run), projectName: project.name })
    }

    return reply.status(207).send(results)
  })

  // POST /runs/:id/cancel — cancel a queued or running run
  app.post<{ Params: { id: string } }>('/runs/:id/cancel', async (request, reply) => {
    const run = app.db.select().from(runs).where(eq(runs.id, request.params.id)).get()
    if (!run) throw notFound('Run', request.params.id)

    const terminalStatuses = new Set(['completed', 'partial', 'failed', 'cancelled'])
    if (terminalStatuses.has(run.status)) throw runNotCancellable(run.id, run.status)

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
    if (!run) throw notFound('Run', request.params.id)
    return reply.send(loadRunDetail(app, run))
  })
}

function parseRunTriggerRequest(value: unknown) {
  const result = runTriggerRequestSchema.safeParse(value)
  if (result.success) return result.data
  throw validationError('Invalid run trigger request', {
    issues: result.error.issues.map(issue => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
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
  const parsed = parseJsonColumn<Record<string, unknown>>(raw, {})
  return {
    groundingSources: (parsed.groundingSources as unknown[] | undefined) ?? [],
    searchQueries: (parsed.searchQueries as string[] | undefined) ?? [],
    model: (parsed.model as string | undefined) ?? null,
  }
}

function loadRunDetail(app: FastifyInstance, run: typeof runs.$inferSelect) {
  const project = app.db
    .select({
      displayName: projects.displayName,
      canonicalDomain: projects.canonicalDomain,
      ownedDomains: projects.ownedDomains,
    })
    .from(projects)
    .where(eq(projects.id, run.projectId))
    .get()

  const snapshots = app.db
    .select({
      id: querySnapshots.id,
      runId: querySnapshots.runId,
      keywordId: querySnapshots.keywordId,
      keyword: keywords.keyword,
      provider: querySnapshots.provider,
      model: querySnapshots.model,
      citationState: querySnapshots.citationState,
      answerMentioned: querySnapshots.answerMentioned,
      answerText: querySnapshots.answerText,
      citedDomains: querySnapshots.citedDomains,
      competitorOverlap: querySnapshots.competitorOverlap,
      recommendedCompetitors: querySnapshots.recommendedCompetitors,
      location: querySnapshots.location,
      rawResponse: querySnapshots.rawResponse,
      createdAt: querySnapshots.createdAt,
    })
    .from(querySnapshots)
    .leftJoin(keywords, eq(querySnapshots.keywordId, keywords.id))
    .where(eq(querySnapshots.runId, run.id))
    .all()

  return {
    ...formatRun(run),
    snapshots: snapshots.map(s => {
      const rawParsed = parseSnapshotRawResponse(s.rawResponse)
      const answerMentioned = project
        ? resolveSnapshotAnswerMentioned(s, project)
        : (s.answerMentioned ?? false)
      return {
        id: s.id,
        runId: s.runId,
        keywordId: s.keywordId,
        keyword: s.keyword,
        provider: s.provider,
        citationState: s.citationState,
        answerMentioned,
        visibilityState: project
          ? resolveSnapshotVisibilityState(s, project)
          : (answerMentioned ? 'visible' : 'not-visible'),
        answerText: s.answerText,
        citedDomains: parseJsonColumn<string[]>(s.citedDomains, []),
        competitorOverlap: parseJsonColumn<string[]>(s.competitorOverlap, []),
        recommendedCompetitors: parseJsonColumn<string[]>(s.recommendedCompetitors, []),
        matchedTerms: project ? resolveSnapshotMatchedTerms(s, project) : [],
        model: s.model ?? rawParsed.model,
        location: s.location,
        groundingSources: rawParsed.groundingSources,
        searchQueries: rawParsed.searchQueries,
        createdAt: s.createdAt,
      }
    }),
  }
}
