import crypto from 'node:crypto'
import { and, eq, asc, desc, inArray, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { runs, querySnapshots, queries, projects, competitors, parseJsonColumn } from '@ainyc/canonry-db'
import { compileCompetitiveSignalResolver } from '@ainyc/canonry-intelligence'
import type { LocationContext, MeasurementExecutionIdentity, MeasurementRunScope } from '@ainyc/canonry-contracts'
import {
  AppError as AppErrorClass,
  type AppError,
  measurementRunScopeIsEmpty,
  RunKinds,
  RunTriggers,
  runTriggerRequestSchema,
  noProvider,
  noQueries,
  unsupportedKind,
  runInProgress,
  runNotCancellable,
  notFound,
  validationError,
  parseRunError,
  serializeRunError,
} from '@ainyc/canonry-contracts'
import { notProbeRun, resolveProject, resolveSnapshotAnswerMentioned, resolveSnapshotMentionState, resolveSnapshotVisibilityState, resolveSnapshotMatchedTerms, writeAuditLog } from './helpers.js'
import { assertProjectScope } from './auth.js'
import { gte } from 'drizzle-orm'
import { assertMeasurementRunStampable, hasActiveMeasurementPlan, queueRunIfProjectIdle, resolveRunnableProviderSelection } from './run-queue.js'

export interface RunRoutesOptions {
  onRunCreated?: (runId: string, projectId: string, providers?: string[], location?: LocationContext | null) => void
  /**
   * Lets a local host interrupt in-process work after the durable status flip.
   * The route remains storage-only when no host has an executor to abort.
   */
  onRunCancelled?: (runId: string, projectId: string) => void
  /** Valid provider names from registered adapters — used to reject unknown providers */
  validProviderNames?: string[]
  /** Current provider registry membership. When omitted, activation preflight is disabled. */
  getRunnableProviderNames?: () => readonly string[]
  /** Provider → the model this instance has it pointed at, for freezing model identity. */
  getEffectiveProviderModels?: () => Readonly<Record<string, string>>
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

    // Validate activation state before queuing a normal sweep. Probe runs keep
    // their existing operator-test semantics and are validated by the worker.
    const shouldPreflight = trigger !== RunTriggers.probe
      && opts.getRunnableProviderNames !== undefined
    const trackedRows = (body.queries?.length || shouldPreflight)
      ? app.db
          .select({ query: queries.query })
          .from(queries)
          .where(eq(queries.projectId, project.id))
          .all()
      : []
    if (shouldPreflight) {
      // A published plan froze its own questions. Deleting a query from the
      // live library must not retroactively make a published revision
      // unrunnable — and the scheduler never consulted the live library, so
      // without this the two paths disagreed about the same project.
      const measuresAPlan = hasActiveMeasurementPlan(app.db, project.id)
      const preflightError = answerVisibilityPreflightError({
        projectName: project.name,
        projectProviders: project.providers,
        requestedProviders: providers,
        runnableProviderNames: opts.getRunnableProviderNames!(),
        trackedQueryCount: measuresAPlan ? 1 : trackedRows.length,
      })
      if (preflightError) throw preflightError
    }

    // A scope that names nothing is not a request for everything. An agent
    // whose filter came back empty would otherwise buy a full sweep by
    // accident; omitting the field entirely is how you ask for one.
    if (body.measurementScope !== undefined && measurementRunScopeIsEmpty(body.measurementScope)) {
      throw validationError(
        'The measurement scope names nothing to measure. Name at least one group or target, '
        + 'or leave the scope out entirely to run a full sweep.',
      )
    }

    // A published plan sets the location per execution node, so a per-run
    // location has nothing to apply to. Rejecting says so; accepting would
    // take the flag and ignore it. `--all-locations` also bypasses the queue
    // helper entirely, which would leave a plan project with unstamped runs.
    if (hasActiveMeasurementPlan(app.db, project.id) && (body.location || body.allLocations || body.noLocation)) {
      throw validationError(
        'This project measures a published measurement plan, which sets the location for each question itself. '
        + 'Run it without "location", "allLocations", or "noLocation".',
      )
    }

    // Two different subset mechanisms. A plan-scoped run executes the plan's
    // own execution nodes and never reads the run's query list, so accepting
    // both would silently drop one of them.
    if (body.queries?.length && !measurementRunScopeIsEmpty(body.measurementScope)) {
      throw validationError(
        'A run can be narrowed by queries or by a measurement scope, not both. '
        + 'Drop "queries" to measure a slice of the plan, or drop "measurementScope" to measure specific questions.',
      )
    }

    // Validate that body.queries (if provided) is a subset of the project's
    // tracked queries. Untracked queries can't produce snapshots (no queries
    // row to FK against), so we reject up-front rather than silently dropping.
    let scopedQueries: string[] | null = null
    if (body.queries?.length) {
      const tracked = new Set(trackedRows.map(r => r.query))
      const missing = body.queries.filter(q => !tracked.has(q))
      if (missing.length) {
        throw validationError(`Queries not tracked on project "${project.name}": ${missing.join(', ')}`, {
          missing,
          tracked: [...tracked],
        })
      }
      scopedQueries = body.queries
    }
    const queriesColumn = scopedQueries ?? null

    // Resolve location for this run
    let resolvedLocation: LocationContext | null | undefined
    const projectLocations = project.locations

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

    // Handle --all-locations: create one run per configured location.
    //
    // The fan-out is atomic with respect to the project-level idle lock:
    // a single transaction checks for any active run and, only if none
    // exists, inserts the per-location runs. Two concurrent --all-locations
    // calls (manual + scheduled, two CLI shells, etc.) can no longer stack
    // duplicate sweeps on the same project, double-billing provider calls
    // and racing snapshots into the same window.
    if (body.allLocations) {
      if (projectLocations.length === 0) {
        throw validationError('No locations configured for this project')
      }

      const result = app.db.transaction((tx) => {
        const activeRun = tx
          .select({ id: runs.id })
          .from(runs)
          .where(and(
            eq(runs.projectId, project.id),
            or(eq(runs.status, 'queued'), eq(runs.status, 'running')),
          ))
          .get()
        if (activeRun) {
          return { conflict: true as const }
        }

        const inserted: Array<{ runId: string; loc: LocationContext }> = []
        for (const loc of projectLocations) {
          const runId = crypto.randomUUID()
          tx.insert(runs).values({
            id: runId,
            projectId: project.id,
            kind,
            status: 'queued',
            trigger,
            location: loc.label,
            queries: queriesColumn,
            createdAt: now,
          }).run()
          inserted.push({ runId, loc })
        }
        return { conflict: false as const, inserted }
      })

      if (result.conflict) {
        throw runInProgress(project.name)
      }

      const results = []
      for (const { runId, loc } of result.inserted) {
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
      queries: queriesColumn,
      providers,
      runnableProviders: opts.getRunnableProviderNames?.(),
      providerModels: opts.getEffectiveProviderModels?.(),
      measurementScope: body.measurementScope ?? null,
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
    Querystring: { limit?: string; kind?: string }
  }>('/projects/:name/runs', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const parsedLimit = parseInt(request.query.limit ?? '', 10)
    const limit = Number.isNaN(parsedLimit) || parsedLimit <= 0 ? undefined : parsedLimit

    // Per-URL integration runs (bing-inspect especially) can fill the limit
    // window and push answer-visibility runs out — the same footgun GET /runs
    // guards against. ?kind= scopes the list to the one kind a caller needs.
    const kind = parseListKind(request.query.kind)
    const where = kind
      ? and(eq(runs.projectId, project.id), eq(runs.kind, kind))
      : eq(runs.projectId, project.id)

    const rows = limit == null
      ? app.db
        .select()
        .from(runs)
        .where(where)
        .orderBy(asc(runs.createdAt))
        .all()
      : app.db
        .select()
        .from(runs)
        .where(where)
        .orderBy(desc(runs.createdAt))
        .limit(limit)
        .all()
        .reverse()

    return reply.send(rows.map(formatRun))
  })

  // GET /projects/:name/runs/latest — latest run plus total run count.
  // Excludes probe runs: this powers the dashboard headline, `canonry status`,
  // `canonry export`, and the MCP `canonry_project_overview` tool, so a probe
  // written after the most recent real sweep must not become the project's
  // public state. Per-run detail endpoints (`GET /runs/:id`) still include
  // probes for operator inspection.
  app.get<{ Params: { name: string } }>('/projects/:name/runs/latest', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const countRow = app.db
      .select({ count: sql<number>`count(*)` })
      .from(runs)
      .where(and(eq(runs.projectId, project.id), notProbeRun()))
      .get()
    const totalRuns = countRow?.count ?? 0

    const latestRun = app.db
      .select()
      .from(runs)
      .where(and(eq(runs.projectId, project.id), notProbeRun()))
      .orderBy(desc(runs.createdAt), desc(runs.id))
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

  // GET /runs — list runs newest-first with sensible defaults
  //
  // Default behavior:
  //   - ORDER BY created_at DESC, id DESC (deterministic tiebreak)
  //   - LIMIT 500
  //   - Excludes probe runs (trigger='probe' — operator/agent test runs
  //     that shouldn't pollute aggregates or the dashboard list)
  //   - Filters to the last 30 days
  //
  // Without these defaults, an instance with thousands of historical runs
  // returns multi-MB JSON on every dashboard mount (the SPA's
  // `useDashboard` hook hits this endpoint to compute "latest run per
  // project"), gating first paint behind a full-table scan + JSON parse.
  //
  // Query params let agents and the CLI override when needed:
  //   ?limit=N         — cap at N rows (default 500, max 5000)
  //   ?since=ISO       — only runs with created_at >= ISO (default 30d ago)
  //   ?includeProbe=1  — include probe runs (rarely needed; operator only)
  //   ?kind=K          — restrict to a single run kind (e.g. 'answer-visibility').
  //                      Critical for the dashboard: integration syncs
  //                      (bing-inspect, gsc-sync, ga-sync) fire on cron and
  //                      can easily fill the 500-row window in <1 hour,
  //                      pushing the answer-visibility runs the dashboard
  //                      actually needs off the response.
  app.get<{
    Querystring: { limit?: string; since?: string; includeProbe?: string; kind?: string }
  }>('/runs', async (request, reply) => {
    const limit = parseListLimit(request.query.limit, 500, 5000)
    const since = parseListSince(request.query.since)
    const includeProbe = request.query.includeProbe === '1' || request.query.includeProbe === 'true'
    const kind = parseListKind(request.query.kind)

    const filters = [gte(runs.createdAt, since)]
    if (!includeProbe) filters.push(notProbeRun())
    if (kind) filters.push(eq(runs.kind, kind))
    // A project-scoped key sees ONLY its own project's runs (this global list
    // is not under the /projects/:name auth gate, so filter explicitly).
    const scopedProjectId = request.apiKey?.projectId
    if (scopedProjectId) filters.push(eq(runs.projectId, scopedProjectId))

    const rows = app.db
      .select()
      .from(runs)
      .where(and(...filters))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(limit)
      .all()
    return reply.send(rows.map(formatRun))
  })

  // POST /runs — trigger a run for all projects
  app.post<{
    Body: { kind?: string; providers?: string[] }
  }>('/runs', async (request, reply) => {
    // A project-scoped key may only trigger runs for ITS project — restrict the
    // batch to that project so it can never queue runs for a sibling.
    const scopedProjectId = request.apiKey?.projectId
    const allProjects = (scopedProjectId
      ? app.db.select().from(projects).where(eq(projects.id, scopedProjectId))
      : app.db.select().from(projects)).all()
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
    const runnableProviderNames = opts.getRunnableProviderNames?.()

    // Two passes on purpose. This route answers for many projects at once, so
    // one project's problem must never decide the others' fate or hide what
    // was already dispatched: every project is checked first, then the ones
    // that can run are queued, and each project gets its own row in the
    // response — queued with its run id, or refused with the reason.
    const eligible: Array<{ project: typeof allProjects[number]; resolvedLocation: LocationContext | undefined }> = []

    for (const project of allProjects) {
      if (runnableProviderNames) {
        const trackedQuery = app.db
          .select({ id: queries.id })
          .from(queries)
          .where(eq(queries.projectId, project.id))
          .limit(1)
          .get()
        const preflightError = answerVisibilityPreflightError({
          projectName: project.name,
          projectProviders: project.providers,
          requestedProviders: providers,
          runnableProviderNames,
          // A project measuring a published plan runs the plan's frozen
          // questions, not today's library — same rule as the single-project
          // route, so the two agree.
          trackedQueryCount: trackedQuery || hasActiveMeasurementPlan(app.db, project.id) ? 1 : 0,
        })
        if (preflightError) {
          results.push({
            projectName: project.name,
            projectId: project.id,
            status: 'error',
            error: preflightError.message,
            errorCode: preflightError.code,
          })
          continue
        }
      }

      // Resolve default location for this project
      const projectLocations = project.locations
      let resolvedLocation: LocationContext | undefined
      if (project.defaultLocation) {
        const loc = projectLocations.find(l => l.label === project.defaultLocation)
        if (!loc) {
          results.push({ projectName: project.name, projectId: project.id, status: 'error', error: `Default location "${project.defaultLocation}" not found` })
          continue
        }
        resolvedLocation = loc
      }

      eligible.push({ project, resolvedLocation })
    }

    const dispatchable: typeof eligible = []
    for (const entry of eligible) {
      try {
        assertMeasurementRunStampable(app.db, {
          projectId: entry.project.id,
          kind,
          trigger: 'manual',
          location: entry.resolvedLocation?.label ?? null,
          providers,
          runnableProviders: runnableProviderNames,
          providerModels: opts.getEffectiveProviderModels?.(),
        })
        dispatchable.push(entry)
      } catch (error) {
        if (!(error instanceof AppErrorClass)) throw error
        results.push({
          projectName: entry.project.name,
          projectId: entry.project.id,
          status: 'error',
          error: error.message,
          errorCode: error.code,
        })
      }
    }

    for (const { project, resolvedLocation } of dispatchable) {
      const queueResult = queueRunIfProjectIdle(app.db, {
        createdAt: now,
        kind,
        projectId: project.id,
        trigger: 'manual',
        location: resolvedLocation?.label ?? null,
        // The same list this route dispatches with, so what a run is measured
        // against is what it was actually asked to do.
        providers,
        runnableProviders: runnableProviderNames,
        providerModels: opts.getEffectiveProviderModels?.(),
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
    assertProjectScope(request, run.projectId)

    const terminalStatuses = new Set(['completed', 'partial', 'failed', 'cancelled'])
    if (terminalStatuses.has(run.status)) throw runNotCancellable(run.id, run.status)

    const now = new Date().toISOString()
    const cancelled = app.db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: now, error: serializeRunError({ message: 'Cancelled by user' }) })
      // The read above is only an early error message. This conditional write
      // is the real state transition: a terminal executor must never be
      // overwritten by a stale cancellation request.
      .where(and(eq(runs.id, run.id), inArray(runs.status, ['queued', 'running'])))
      .run()
    if (cancelled.changes === 0) {
      const current = app.db.select().from(runs).where(eq(runs.id, run.id)).get()
      if (!current) throw notFound('Run', run.id)
      throw runNotCancellable(run.id, current.status)
    }

    writeAuditLog(app.db, {
      projectId: run.projectId,
      actor: 'api',
      action: 'run.cancelled',
      entityType: 'run',
      entityId: run.id,
    })

    // Update durable state first. A host callback may synchronously abort a
    // worker that throws, and its CAS finalization must observe `cancelled`.
    opts.onRunCancelled?.(run.id, run.projectId)

    const updated = app.db.select().from(runs).where(eq(runs.id, run.id)).get()!
    return reply.send(formatRun(updated))
  })

  // GET /runs/:id — get single run with snapshots
  app.get<{ Params: { id: string } }>('/runs/:id', async (request, reply) => {
    const run = app.db.select().from(runs).where(eq(runs.id, request.params.id)).get()
    if (!run) throw notFound('Run', request.params.id)
    assertProjectScope(request, run.projectId)
    return reply.send(loadRunDetail(app, run))
  })
}

export function answerVisibilityPreflightError(input: {
  projectName: string
  projectProviders: readonly string[]
  requestedProviders?: readonly string[]
  runnableProviderNames: readonly string[]
  trackedQueryCount: number
}): AppError | null {
  if (input.trackedQueryCount === 0) {
    return noQueries(input.projectName)
  }

  const selection = resolveRunnableProviderSelection({
    requestedProviders: input.requestedProviders,
    projectProviders: input.projectProviders,
    runnableProviders: input.runnableProviderNames,
  })

  if (selection.runnableProviders.length > 0) return null

  return noProvider(input.projectName, {
    availableProviders: selection.availableProviders,
    selectedProviders: selection.selectedProviders,
    selectionSource: selection.selectionSource,
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

/**
 * Parse the `?limit=` query param for `GET /runs`. Defaults + caps protect
 * the unbounded-list footgun: dashboards and agents shouldn't be able to
 * trigger a full table scan by passing `limit=1000000`. Cap and default are
 * tuned for the home-page use case (dashboard wants ~latest 100 per project
 * × 5 projects worst case = ~500 rows).
 */
function parseListLimit(raw: string | undefined, defaultValue: number, max: number): number {
  if (raw === undefined) return defaultValue
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    throw validationError('"limit" must be a positive integer')
  }
  return Math.min(parsed, max)
}

/**
 * Parse the `?kind=` query param for `GET /runs`. Restricts the response to
 * a single run kind. Returns `null` when the param is absent (no filter
 * applied). Validates against the `RunKinds` enum so a typo produces a 400
 * instead of silently returning empty.
 */
function parseListKind(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null
  const validKinds = Object.values(RunKinds)
  if (!validKinds.includes(raw as (typeof validKinds)[number])) {
    throw validationError(`"kind" must be one of: ${validKinds.join(', ')}`)
  }
  return raw
}

/**
 * Parse the `?since=` query param. Accepts an ISO 8601 timestamp; defaults
 * to 30 days ago. SQLite text comparisons on `created_at` work because the
 * column is consistently ISO 8601 UTC ("YYYY-MM-DDTHH:MM:SS.SSSZ").
 */
function parseListSince(raw: string | undefined): string {
  if (raw === undefined) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    return thirtyDaysAgo.toISOString()
  }
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    throw validationError('"since" must be a valid ISO 8601 timestamp')
  }
  return date.toISOString()
}

export function formatRun(row: {
  id: string
  projectId: string
  kind: string
  status: string
  trigger: string
  location: string | null
  queries: string[] | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  createdAt: string
  measurementPlanVersionId?: string | null
  measurementManifest?: unknown
  measurementScope?: MeasurementRunScope | null
  measurementExecutionIdentity?: MeasurementExecutionIdentity | null
}) {
  const measurementManifest = row.measurementManifest !== null
    && typeof row.measurementManifest === 'object'
    && !Array.isArray(row.measurementManifest)
    ? row.measurementManifest as Record<string, unknown>
    : null
  // These fields were added after the original run DTO. Keep legacy responses
  // byte-for-byte compatible until a run actually carries measurement-plan
  // provenance; clients that never opt into plans must not see new null keys.
  const hasMeasurementProvenance = row.measurementPlanVersionId != null || measurementManifest !== null
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    status: row.status,
    trigger: row.trigger,
    location: row.location,
    queries: row.queries ?? null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    error: parseRunError(row.error),
    ...(hasMeasurementProvenance
      ? {
          measurementPlanVersionId: row.measurementPlanVersionId ?? null,
          measurementManifest,
          measurementScope: row.measurementScope ?? null,
          measurementExecutionIdentity: row.measurementExecutionIdentity ?? null,
        }
      : {}),
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
      aliases: projects.aliases,
    })
    .from(projects)
    .where(eq(projects.id, run.projectId))
    .get()
  const competitorDomains = app.db
    .select({ domain: competitors.domain })
    .from(competitors)
    .where(eq(competitors.projectId, run.projectId))
    .all()
    .map(row => row.domain)
  const competitiveSignalResolver = compileCompetitiveSignalResolver(competitorDomains)

  const snapshots = app.db
    .select({
      id: querySnapshots.id,
      runId: querySnapshots.runId,
      queryId: querySnapshots.queryId,
      query: queries.query,
      provider: querySnapshots.provider,
      model: querySnapshots.model,
      servedModel: querySnapshots.servedModel,
      citationState: querySnapshots.citationState,
      answerMentioned: querySnapshots.answerMentioned,
      answerText: querySnapshots.answerText,
      citedDomains: querySnapshots.citedDomains,
      citedUrls: querySnapshots.citedUrls,
      captureStatus: querySnapshots.captureStatus,
      sourceCount: querySnapshots.sourceCount,
      resolvedCount: querySnapshots.resolvedCount,
      captureVersion: querySnapshots.captureVersion,
      competitorOverlap: querySnapshots.competitorOverlap,
      recommendedCompetitors: querySnapshots.recommendedCompetitors,
      location: querySnapshots.location,
      // The honesty pair behind `location`: what a plan-aware run asked for,
      // and whether the provider actually honoured it. Without both, a
      // caller cannot tell "no location was requested" apart from "one was
      // requested and ignored" — `location` alone reads the same either way.
      requestedContext: querySnapshots.requestedContext,
      supportedContext: querySnapshots.supportedContext,
      rawResponse: querySnapshots.rawResponse,
      createdAt: querySnapshots.createdAt,
    })
    .from(querySnapshots)
    .leftJoin(queries, eq(querySnapshots.queryId, queries.id))
    .where(eq(querySnapshots.runId, run.id))
    .all()

  return {
    ...formatRun(run),
    snapshots: snapshots.map(s => {
      const rawParsed = parseSnapshotRawResponse(s.rawResponse)
      const signalGroundingSources = rawParsed.groundingSources.filter(
        (source): source is { uri: string } =>
          typeof source === 'object'
          && source !== null
          && typeof (source as { uri?: unknown }).uri === 'string',
      )
      const competitiveSignals = competitiveSignalResolver.resolve({
        citedDomains: s.citedDomains,
        groundingSources: signalGroundingSources,
        answerText: s.answerText,
      })
      const answerMentioned = project
        ? resolveSnapshotAnswerMentioned(s, project)
        : (s.answerMentioned ?? false)
      return {
        id: s.id,
        runId: s.runId,
        queryId: s.queryId,
        query: s.query,
        provider: s.provider,
        citationState: s.citationState,
        answerMentioned,
        // Legacy alias of `mentionState`, retained for backwards compatibility.
        visibilityState: project
          ? resolveSnapshotVisibilityState(s, project)
          : (answerMentioned ? 'visible' : 'not-visible'),
        // Canonical vocabulary for answer-text presence; new consumers prefer this.
        mentionState: project
          ? resolveSnapshotMentionState(s, project)
          : (answerMentioned ? 'mentioned' : 'not-mentioned'),
        answerText: s.answerText,
        citedDomains: s.citedDomains,
        citedUrls: s.citedUrls,
        captureStatus: s.captureStatus,
        sourceCount: s.sourceCount,
        resolvedCount: s.resolvedCount,
        captureVersion: s.captureVersion,
        ...competitiveSignals,
        // Legacy mixed signal retained for backwards compatibility.
        competitorOverlap: s.competitorOverlap,
        recommendedCompetitors: s.recommendedCompetitors,
        matchedTerms: project ? resolveSnapshotMatchedTerms(s, project) : [],
        model: s.model ?? rawParsed.model,
        // Column only. `model` may fall back to the stored envelope because both
        // record the same requested value; a served id has no such equivalent —
        // an unrecoverable one stays null rather than echoing configuration.
        servedModel: s.servedModel,
        location: s.location,
        requestedContext: s.requestedContext,
        supportedContext: s.supportedContext,
        groundingSources: rawParsed.groundingSources,
        searchQueries: rawParsed.searchQueries,
        createdAt: s.createdAt,
      }
    }),
  }
}
