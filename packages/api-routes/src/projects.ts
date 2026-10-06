import crypto from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { projects, queries, competitors, schedules, notifications, runs, querySnapshots, insights, auditLog, readAllNegativeReviewMaxStars, readNegativeReviewMaxStars, writeNegativeReviewMaxStars, type DatabaseClient } from '@ainyc/canonry-db'
import type { InferSelectModel } from 'drizzle-orm'
import {
  alreadyExists,
  describeError,
  competitorAliasProjectIdentity,
  forbidden,
  hostOf,
  notFound,
  validationError,
  locationContextSchema,
  normalizeProjectAliases,
  normalizeProjectName,
  projectCreateRequestSchema,
  projectUpsertRequestSchema,
  resolveProjectQualifiedAliases,
  findDuplicateLocationLabels,
  hasLocationLabel,
  DEFAULT_MEASUREMENT_CONFIG,
  PROJECTS_WRITE_SCOPE,
  SchedulableRunKinds,
} from '@ainyc/canonry-contracts'
import type { CompetitorAliasRejection, LocationContext, MeasurementConfig, ProjectCreateRequest, ProviderDispatchModesMap, ProviderModels } from '@ainyc/canonry-contracts'
import { requireAdminSession, requireScope } from './auth.js'
import { resolveProject, writeAuditLog } from './helpers.js'
import { competitorNames, planCompetitorSet, readStoredCompetitors, syncCompetitorSet } from './competitor-writes.js'
import { SETTINGS_WRITE_SCOPE } from './settings.js'
import type { ProviderAdapterInfo } from './settings.js'
import { pruneProviderDispatchModes, pruneProviderModelsForProviders, validateProviderDispatchModes, validateProviderModels } from './provider-models.js'
import { activeRevisionProviders } from './run-queue.js'
import { readProjectRunsWithOutstandingProviderBatch } from './provider-batches.js'

export interface ProjectRoutesOptions {
  /**
   * Runs synchronously right before the project-delete transaction, after
   * `cancelRunProviderBatches` and a re-read of the project. It may throw to
   * abort the deletion. A returned compensator is called if the database
   * transaction cannot commit after this pre-delete work has persisted. Not
   * called when a concurrent DELETE removed the project first.
   */
  onProjectDeleting?: (projectId: string) => void | (() => void)
  onProjectDeleted?: (projectId: string) => void
  /**
   * Stops one run's outstanding provider batches at the provider. Awaited
   * first, before `onProjectDeleting` and the project-delete transaction, for
   * each of the project's runs still waiting on a batch: the delete cascades
   * away the only rows holding the provider's batch id, so afterwards nothing
   * could cancel a batch that keeps processing and billing. Best effort: a
   * rejection is logged and the delete goes ahead. The project is re-read
   * after these awaits, so a concurrent DELETE that committed meanwhile makes
   * this one the missing-project 404. A delete that `onProjectDeleting` then
   * aborts keeps the project, but its batches stay stopped.
   */
  cancelRunProviderBatches?: (runId: string, projectId: string) => Promise<void>
  onProjectUpserted?: (projectId: string, projectName: string) => void
  /** Post-commit lifecycle hook; failures must not turn a committed create into an HTTP 500. */
  onProjectCreated?: (projectId: string, projectName: string) => void
  /**
   * Fires when a project's normalized alias set changes (add, remove, or
   * reorder after canonicalization). Receivers should run a fire-and-forget
   * mention-fields backfill so historical snapshots reflect the new aliases.
   * Skipped when only other fields change.
   */
  onAliasesChanged?: (projectId: string, projectName: string) => void
  /** Fired when a project identity change drops a competitor alias. See `CompetitorRoutesOptions`. */
  onCompetitorAliasesChanged?: (projectId: string, projectName: string) => void
  /** Full descriptors from registered adapters — validate names and model overrides. */
  providerAdapters?: ProviderAdapterInfo[]
}

export async function projectRoutes(app: FastifyInstance, opts: ProjectRoutesOptions) {
  const notifyProjectCreated = (projectId: string, projectName: string): void => {
    try {
      opts.onProjectCreated?.(projectId, projectName)
    } catch (error) {
      app.log.error({ error, projectId, projectName }, 'Project-created callback failed after commit')
    }
  }

  // POST /projects — create only. The launchpad cannot race a CLI/API create
  // and overwrite the project the other caller already configured.
  app.post<{ Body: ProjectCreateRequest }>('/projects', async (request, reply) => {
    requireAdminSession(request)
    if (request.principal?.projectId) {
      throw forbidden('This API key is limited to one project, and cannot create projects for this install.')
    }
    requireScope(request, PROJECTS_WRITE_SCOPE)

    const parsedBody = projectCreateRequestSchema.safeParse(request.body)
    if (!parsedBody.success) {
      throw validationError('Invalid project payload', {
        issues: parsedBody.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }
    const body = parsedBody.data
    const name = normalizeProjectName(body.name)
    if (!name) {
      throw validationError('Project name must contain at least one letter or number after normalization.')
    }
    const canonicalDomain = hostOf(body.canonicalDomain)
    if (!canonicalDomain) {
      throw validationError('canonicalDomain must be a valid hostname or http(s) URL.')
    }

    // Validate provider names against registered adapters.
    const validNames = opts.providerAdapters?.map(adapter => adapter.name) ?? []
    if (validNames.length && body.providers?.length) {
      const invalid = body.providers.filter(p => !validNames.includes(p))
      if (invalid.length) {
        throw validationError(`Invalid provider(s): ${invalid.join(', ')}. Must be one of: ${validNames.join(', ')}`, {
          invalidProviders: invalid,
          validProviders: validNames,
        })
      }
    }
    const nextProviders = body.providers ?? []
    const providerModels = pruneProviderModelsForProviders(
      validateProviderModels(body.providerModels ?? {}, opts.providerAdapters),
      nextProviders,
    )
    assertProviderModelScope(request, {}, providerModels, nextProviders)
    // Pruned like model overrides: a preference for an engine the project
    // does not run would silently take effect the day it is added back.
    const providerDispatchModes = pruneProviderModelsForProviders(
      validateProviderDispatchModes(body.providerDispatchModes ?? {}, opts.providerAdapters),
      nextProviders,
    )

    const nextLocations = body.locations ?? []
    const duplicateLabels = findDuplicateLocationLabels(nextLocations)
    if (duplicateLabels.length > 0) {
      throw validationError(`Duplicate location labels are not allowed: ${duplicateLabels.join(', ')}`, {
        duplicateLabels,
      })
    }
    const nextDefaultLocation = body.defaultLocation ?? null
    if (!hasLocationLabel(nextLocations, nextDefaultLocation)) {
      throw validationError(`defaultLocation "${nextDefaultLocation}" must match a configured location label`, {
        defaultLocation: nextDefaultLocation,
      })
    }

    // Legacy path-based projects may predate normalized names. Compare their
    // normalized identity too, then rely on the exact unique index to make a
    // concurrent same-key insert a no-op rather than an overwrite.
    const normalizedCollision = app.db.select({
      name: projects.name,
    }).from(projects).all().find(project => normalizeProjectName(project.name) === name)
    if (normalizedCollision) throw alreadyExists('Project', name)

    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const nextAliases = normalizeProjectAliases(body.displayName, body.aliases ?? [])
    // A new project has no competitors yet, so only the alias rules apply.
    const qualifiedAliases = body.qualifiedAliases === undefined
      ? []
      : requireQualifiedAliases({ displayName: body.displayName, aliases: nextAliases }, body.qualifiedAliases, [])
    const inserted = app.db.transaction((tx) => {
      const result = tx.insert(projects).values({
        id,
        name,
        displayName: body.displayName,
        canonicalDomain,
        ownedDomains: body.ownedDomains ?? [],
        aliases: nextAliases,
        qualifiedAliases,
        country: body.country,
        language: body.language,
        tags: body.tags ?? [],
        labels: body.labels ?? {},
        providers: nextProviders,
        providerModels,
        providerDispatchModes,
        measurement: body.measurement ?? DEFAULT_MEASUREMENT_CONFIG,
        locations: nextLocations,
        defaultLocation: nextDefaultLocation,
        autoExtractBacklinks: body.autoExtractBacklinks ?? false,
        configSource: body.configSource ?? 'api',
        configRevision: 1,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().run()
      if (result.changes !== 1) return false
      writeNegativeReviewMaxStars(tx, id, body.negativeReviewMaxStars ?? null, now)

      writeAuditLog(tx, {
        projectId: id,
        actor: 'api',
        action: 'project.created',
        entityType: 'project',
        entityId: id,
      })
      return true
    })
    if (!inserted) throw alreadyExists('Project', name)

    notifyProjectCreated(id, name)
    opts.onProjectUpserted?.(id, name)
    const created = app.db.select().from(projects).where(eq(projects.id, id)).get()!
    return reply.status(201).send(formatProject(created, body.negativeReviewMaxStars ?? null))
  })

  // PUT /projects/:name — upsert project
  app.put<{
    Params: { name: string }
    Body: {
      displayName: string
      canonicalDomain: string
      ownedDomains?: string[]
      aliases?: string[]
      qualifiedAliases?: string[]
      country: string
      language: string
      tags?: string[]
      labels?: Record<string, string>
      providers?: string[]
      locations?: LocationContext[]
      defaultLocation?: string | null
      autoExtractBacklinks?: boolean
      negativeReviewMaxStars?: number | null
      configSource?: string
      providerModels?: Record<string, string>
      providerDispatchModes?: ProviderDispatchModesMap
      measurement?: MeasurementConfig
    }
  }>('/projects/:name', async (request, reply) => {
    const { name } = request.params
    const parsedBody = projectUpsertRequestSchema.safeParse(request.body)
    if (!parsedBody.success) {
      throw validationError('Invalid project payload', {
        issues: parsedBody.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }
    const body = parsedBody.data

    // Validate provider names against registered adapters
    const validNames = opts.providerAdapters?.map(adapter => adapter.name) ?? []
    if (validNames.length && body.providers?.length) {
      const invalid = body.providers.filter(p => !validNames.includes(p))
      if (invalid.length) {
        throw validationError(`Invalid provider(s): ${invalid.join(', ')}. Must be one of: ${validNames.join(', ')}`, {
          invalidProviders: invalid,
          validProviders: validNames,
        })
      }
    }
    const nextProviders = body.providers ?? []
    const providerModels = pruneProviderModelsForProviders(
      validateProviderModels(body.providerModels ?? {}, opts.providerAdapters),
      nextProviders,
    )

    const now = new Date().toISOString()
    const existing = app.db.select().from(projects).where(eq(projects.name, name)).get()
    assertProviderModelScope(request, existing?.providerModels ?? {}, providerModels, nextProviders)
    // Omitted keeps the stored preference (the dashboard's settings save and
    // other full-replace callers predate the field and never send it).
    const providerDispatchModes = pruneProviderDispatchModes(
      body.providerDispatchModes !== undefined
        ? validateProviderDispatchModes(body.providerDispatchModes, opts.providerAdapters)
        : existing?.providerDispatchModes ?? {},
      nextProviders,
      existing ? activeRevisionProviders(app.db, existing.id) : [],
    )
    const existingLocations = existing ? existing.locations : []
    const nextLocations = body.locations ?? existingLocations
    const duplicateLabels = findDuplicateLocationLabels(nextLocations)
    if (duplicateLabels.length > 0) {
      throw validationError(`Duplicate location labels are not allowed: ${duplicateLabels.join(', ')}`, {
        duplicateLabels,
      })
    }

    const nextDefaultLocation = body.defaultLocation !== undefined
      ? (body.defaultLocation ?? null)
      : existing?.defaultLocation ?? null
    if (!hasLocationLabel(nextLocations, nextDefaultLocation)) {
      throw validationError(`defaultLocation "${nextDefaultLocation}" must match a configured location label`, {
        defaultLocation: nextDefaultLocation,
      })
    }

    const nextAutoExtractBacklinks = body.autoExtractBacklinks !== undefined
      ? body.autoExtractBacklinks
      : existing?.autoExtractBacklinks ?? false
    // Omitted keeps the stored threshold; an explicit null resets it to the default.
    const nextNegativeReviewMaxStars = body.negativeReviewMaxStars !== undefined
      ? body.negativeReviewMaxStars
      : existing ? readNegativeReviewMaxStars(app.db, existing.id) : null

    const nextMeasurement = body.measurement ?? existing?.measurement ?? DEFAULT_MEASUREMENT_CONFIG

    const nextAliases = normalizeProjectAliases(body.displayName, body.aliases ?? [])
    // Explicit: every entry must pass the write rules against the live
    // competitors. Omitted: keep the stored list, minus names that no longer
    // pass them (the dashboard's settings save never sends the field).
    // Sentiment only reads it, so a change here never triggers the mention
    // backfill.
    const nextIdentity = { displayName: body.displayName, aliases: nextAliases }
    // A competitor alias the project now claims as its own name would count
    // the project as its own competitor, so it is dropped (and audited).
    // Qualified aliases are checked against the competitor names that remain.
    const nextAliasIdentity = competitorAliasProjectIdentity({
      displayName: body.displayName,
      aliases: nextAliases,
      canonicalDomain: body.canonicalDomain,
      ownedDomains: body.ownedDomains ?? [],
    })
    const competitorAliasPrune = existing
      ? planCompetitorSet(readStoredCompetitors(app.db, existing.id), [], { replace: false, project: nextAliasIdentity })
      : null
    const liveCompetitors = competitorAliasPrune ? competitorNames(competitorAliasPrune.final) : []
    const nextQualifiedAliases = body.qualifiedAliases !== undefined
      ? requireQualifiedAliases(nextIdentity, body.qualifiedAliases, liveCompetitors)
      : resolveProjectQualifiedAliases(nextIdentity, existing?.qualifiedAliases ?? [], liveCompetitors).value

    if (existing) {
      const prevAliases = existing.aliases
      const aliasesChanged = !aliasArraysEqual(prevAliases, nextAliases)
      let droppedCompetitorAliases: CompetitorAliasRejection[] = []

      app.db.transaction((tx) => {
        tx.update(projects).set({
          displayName: body.displayName,
          canonicalDomain: body.canonicalDomain,
          ownedDomains: body.ownedDomains ?? [],
          aliases: nextAliases,
          qualifiedAliases: nextQualifiedAliases,
          country: body.country,
          language: body.language,
          tags: body.tags ?? [],
          labels: body.labels ?? {},
          providers: body.providers ?? [],
          providerModels,
          providerDispatchModes,
          measurement: nextMeasurement,
          locations: nextLocations,
          defaultLocation: nextDefaultLocation,
          autoExtractBacklinks: nextAutoExtractBacklinks,
          configSource: body.configSource ?? 'api',
          configRevision: existing.configRevision + 1,
          updatedAt: now,
        }).where(eq(projects.id, existing.id)).run()
        writeNegativeReviewMaxStars(tx, existing.id, nextNegativeReviewMaxStars, now)
        if (competitorAliasPrune?.aliasChanges.length) {
          droppedCompetitorAliases = syncCompetitorSet(tx, existing.id, [], {
            replace: false,
            project: nextAliasIdentity,
            now,
          }).droppedAliases
        }

        writeAuditLog(tx, {
          projectId: existing.id,
          actor: 'api',
          action: 'project.updated',
          entityType: 'project',
          entityId: existing.id,
          ...(droppedCompetitorAliases.length ? { diff: { droppedCompetitorAliases } } : {}),
        })
      })

      opts.onProjectUpserted?.(existing.id, name)
      if (aliasesChanged) opts.onAliasesChanged?.(existing.id, name)
      else if (droppedCompetitorAliases.length) opts.onCompetitorAliasesChanged?.(existing.id, name)

      const updated = app.db.select().from(projects).where(eq(projects.id, existing.id)).get()!
      return reply.status(200).send(formatProject(updated, nextNegativeReviewMaxStars))
    }

    const id = crypto.randomUUID()
    app.db.transaction((tx) => {
      tx.insert(projects).values({
        id,
        name,
        displayName: body.displayName,
        canonicalDomain: body.canonicalDomain,
        ownedDomains: body.ownedDomains ?? [],
        aliases: nextAliases,
        qualifiedAliases: nextQualifiedAliases,
        country: body.country,
        language: body.language,
        tags: body.tags ?? [],
        labels: body.labels ?? {},
        providers: body.providers ?? [],
        providerModels,
        providerDispatchModes,
        measurement: nextMeasurement,
        locations: nextLocations,
        defaultLocation: nextDefaultLocation,
        autoExtractBacklinks: nextAutoExtractBacklinks,
        configSource: body.configSource ?? 'api',
        configRevision: 1,
        createdAt: now,
        updatedAt: now,
      }).run()
      writeNegativeReviewMaxStars(tx, id, nextNegativeReviewMaxStars, now)

      writeAuditLog(tx, {
        projectId: id,
        actor: 'api',
        action: 'project.created',
        entityType: 'project',
        entityId: id,
      })
    })

    notifyProjectCreated(id, name)
    opts.onProjectUpserted?.(id, name)

    const created = app.db.select().from(projects).where(eq(projects.id, id)).get()!
    return reply.status(201).send(formatProject(created, nextNegativeReviewMaxStars))
  })

  // GET /projects — list all. A project-scoped key sees ONLY its own project,
  // so the embedded dashboard's project switcher can never enumerate siblings.
  app.get('/projects', async (request, reply) => {
    const scoped = request.apiKey?.projectId
    const rows = scoped
      ? app.db.select().from(projects).where(eq(projects.id, scoped)).all()
      : app.db.select().from(projects).all()
    const thresholds = readAllNegativeReviewMaxStars(app.db)
    return reply.send(rows.map(row => formatProject(row, thresholds.get(row.id) ?? null)))
  })

  // GET /projects/:name — get single
  app.get<{ Params: { name: string } }>('/projects/:name', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    return reply.send(formatProject(project, readNegativeReviewMaxStars(app.db, project.id)))
  })

  app.get<{ Params: { name: string } }>('/projects/:name/delete-preview', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const pid = project.id

    const count = (n: number | undefined): number => n ?? 0
    const queryCount = app.db
      .select({ n: sql<number>`count(*)` })
      .from(queries)
      .where(eq(queries.projectId, pid))
      .get()
    const competitorCount = app.db
      .select({ n: sql<number>`count(*)` })
      .from(competitors)
      .where(eq(competitors.projectId, pid))
      .get()
    const runCount = app.db
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(eq(runs.projectId, pid))
      .get()
    // Snapshots have no projectId — count via the run join instead.
    const snapshotCount = app.db
      .select({ n: sql<number>`count(*)` })
      .from(querySnapshots)
      .innerJoin(runs, eq(querySnapshots.runId, runs.id))
      .where(eq(runs.projectId, pid))
      .get()
    const insightCount = app.db
      .select({ n: sql<number>`count(*)` })
      .from(insights)
      .where(eq(insights.projectId, pid))
      .get()
    const auditLogCount = app.db
      .select({ n: sql<number>`count(*)` })
      .from(auditLog)
      .where(eq(auditLog.projectId, pid))
      .get()

    return reply.send({
      project: { id: project.id, name: project.name },
      cascadeRows: {
        queries: count(queryCount?.n),
        competitors: count(competitorCount?.n),
        runs: count(runCount?.n),
        snapshots: count(snapshotCount?.n),
        insights: count(insightCount?.n),
      },
      detachedRows: {
        auditLog: count(auditLogCount?.n),
      },
    })
  })

  // DELETE /projects/:name
  app.delete<{ Params: { name: string } }>('/projects/:name', async (request, reply) => {
    const addressed = resolveProject(app.db, request.params.name)

    // Stop the project's outstanding provider batches first: the delete
    // cascades away the only rows holding the provider's batch ids. These
    // awaits are the handler's only suspension point, so they come before
    // every other side effect.
    if (opts.cancelRunProviderBatches) {
      for (const runId of readProjectRunsWithOutstandingProviderBatch(app.db, addressed.id)) {
        try {
          await opts.cancelRunProviderBatches(runId, addressed.id)
        } catch (error) {
          app.log.warn({ runId, projectId: addressed.id, error: describeError(error) }, 'Provider batch cancellation failed before project delete')
        }
      }
    }

    // A concurrent DELETE of this project may have committed during those
    // awaits. Re-read it by id: once it is gone (even if its name now belongs
    // to a recreated project, whose batches were never stopped here), answer
    // exactly as a DELETE of a missing project does, before the credential
    // hook, the audit row or any rollback can run.
    const project = app.db.select().from(projects).where(eq(projects.id, addressed.id)).get()
    if (!project) throw notFound('Project', request.params.name)

    // No await from here to the commit, so no other request can interleave.
    // Private credential stores are outside SQLite. Let their host persist a
    // durable removal first; if that fails, the project remains fully usable
    // and the caller can retry rather than leaving an orphaned secret behind.
    const rollback = opts.onProjectDeleting?.(project.id)
    try {
      app.db.transaction((tx) => {
        writeAuditLog(tx, {
          projectId: project.id,
          actor: 'api',
          action: 'project.deleted',
          entityType: 'project',
          entityId: project.id,
        })
        tx.delete(projects).where(eq(projects.id, project.id)).run()
      })
    } catch (error) {
      rollback?.()
      throw error
    }
    opts.onProjectDeleted?.(project.id)
    return reply.status(204).send()
  })

  // POST /projects/:name/locations — add location
  app.post<{
    Params: { name: string }
    Body: LocationContext
  }>('/projects/:name/locations', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const parsed = locationContextSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError(parsed.error.issues.map(i => i.message).join(', '))
    }

    const location = parsed.data
    const existing = [...project.locations]
    if (existing.some(l => l.label === location.label)) {
      throw validationError(`Location "${location.label}" already exists`)
    }

    existing.push(location)
    const now = new Date().toISOString()
    app.db.update(projects).set({
      locations: existing,
      updatedAt: now,
    }).where(eq(projects.id, project.id)).run()

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'location.added',
      entityType: 'location',
      entityId: location.label,
    })

    return reply.status(201).send(location)
  })

  // GET /projects/:name/locations — list locations
  app.get<{ Params: { name: string } }>('/projects/:name/locations', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    return reply.send({
      locations: project.locations,
      defaultLocation: project.defaultLocation,
    })
  })

  // DELETE /projects/:name/locations/:label — remove location
  app.delete<{
    Params: { name: string; label: string }
  }>('/projects/:name/locations/:label', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const label = decodeURIComponent(request.params.label)
    const existing = project.locations
    const filtered = existing.filter(l => l.label !== label)
    if (filtered.length === existing.length) {
      throw validationError(`Location "${label}" not found`)
    }

    const now = new Date().toISOString()
    const updates: Record<string, unknown> = {
      locations: filtered,
      updatedAt: now,
    }
    // Clear default if the removed location was the default
    if (project.defaultLocation === label) {
      updates.defaultLocation = null
    }
    app.db.update(projects).set(updates).where(eq(projects.id, project.id)).run()

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'location.removed',
      entityType: 'location',
      entityId: label,
    })

    return reply.status(204).send()
  })

  // PUT /projects/:name/locations/default — set default location
  app.put<{
    Params: { name: string }
    Body: { label: string }
  }>('/projects/:name/locations/default', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const label = request.body?.label
    if (!label) {
      throw validationError('label is required')
    }

    if (!project.locations.some(l => l.label === label)) {
      throw validationError(`Location "${label}" not found. Add it first.`)
    }

    const now = new Date().toISOString()
    app.db.update(projects).set({
      defaultLocation: label,
      updatedAt: now,
    }).where(eq(projects.id, project.id)).run()

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'location.default-set',
      entityType: 'location',
      entityId: label,
    })

    return reply.send({ defaultLocation: label })
  })

  // GET /projects/:name/export — export as canonry.yaml format
  app.get<{ Params: { name: string } }>('/projects/:name/export', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const negativeReviewMaxStars = readNegativeReviewMaxStars(app.db, project.id)

    const qs = app.db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    const comps = app.db.select().from(competitors).where(eq(competitors.projectId, project.id)).all()
    const schedule = app.db.select().from(schedules).where(and(
      eq(schedules.projectId, project.id),
      eq(schedules.kind, SchedulableRunKinds['answer-visibility']),
    )).get()
    const notificationRows = app.db.select().from(notifications).where(eq(notifications.projectId, project.id)).all()
    // Filtered by the rules `POST /apply` enforces, so an export always re-applies.
    const exportedQualifiedAliases = resolveProjectQualifiedAliases(
      project,
      project.qualifiedAliases,
      competitorNames(comps),
    ).value

    const config = {
      apiVersion: 'canonry/v1',
      kind: 'Project',
      metadata: {
        name: project.name,
        labels: project.labels,
      },
      spec: {
        displayName: project.displayName,
        canonicalDomain: project.canonicalDomain,
        ownedDomains: project.ownedDomains,
        aliases: project.aliases,
        ...(exportedQualifiedAliases.length ? { qualifiedAliases: exportedQualifiedAliases } : {}),
        country: project.country,
        language: project.language,
        queries: qs.map(q => q.query),
        // A competitor with curated aliases exports as `{ domain, aliases }`,
        // so export -> apply round-trips them; one without stays a bare
        // domain, so an alias-free export is unchanged.
        competitors: comps.map(c => c.aliases.length > 0 ? { domain: c.domain, aliases: c.aliases } : c.domain),
        providers: project.providers,
        ...(Object.keys(project.providerModels).length > 0 ? { providerModels: project.providerModels } : {}),
        ...(Object.keys(project.providerDispatchModes).length > 0 ? { providerDispatchModes: project.providerDispatchModes } : {}),
        measurement: project.measurement,
        locations: project.locations,
        ...(project.defaultLocation ? { defaultLocation: project.defaultLocation } : {}),
        ...(project.autoExtractBacklinks ? { autoExtractBacklinks: true } : {}),
        ...(negativeReviewMaxStars !== null ? { negativeReviewMaxStars } : {}),
        notifications: notificationRows.map((row) => {
          const cfg = row.config
          return {
            channel: row.channel,
            url: cfg.url,
            events: cfg.events,
          }
        }),
        ...(schedule ? {
          schedule: {
            ...(schedule.recurrence ? { recurrence: schedule.recurrence } : schedule.preset ? { preset: schedule.preset } : { cron: schedule.cronExpr }),
            timezone: schedule.timezone,
            providers: schedule.providers,
            enabled: schedule.enabled,
          },
        } : {}),
      },
    }

    return reply.send(config)
  })
}

/**
 * Choosing which model a provider executes with is an INSTANCE-level
 * capability — `PUT /settings/providers/:name` carries `SETTINGS_WRITE_SCOPE`
 * for exactly that reason (cost, availability, and what a measurement even
 * means all follow the model). The per-project override is the same capability
 * at a finer grain, so a delegate key with plain `write` and no `settings.write`
 * must not gain it through a project write.
 *
 * The gate keys off the selection actually CHANGING, not off the field's
 * presence in the payload: a rename or query edit that echoes the project's
 * current overrides back (or carries none on a project that has none) stays
 * ungated. Shared with `POST /apply`, which applies the same declarative
 * semantics — clearing an override for an engine the project still runs is a
 * change too.
 *
 * Both sides are compared through `pruneProviderModelsForProviders` against the
 * INCOMING engine set, so the gate asks exactly one question: does this write
 * change the model any engine the project will run executes with? Deselecting
 * an engine removes its override — that is removing a choice, not making one,
 * and it rides plain `write` like the rest of the engine-set edit. Choosing or
 * changing a value for a selected engine still requires `settings.write`,
 * including when the write also narrows the engine set (the surviving engine's
 * value is compared under the new provider list either way).
 *
 * Consequence worth naming: on a legacy row that still stores an override for
 * an unselected engine, re-selecting that engine is ungated, because no VALUE
 * changed — the value was already stored by a caller that had the authority to
 * store it. Any write normalizes the row, so orphans do not accumulate.
 */
export function assertProviderModelScope(
  request: FastifyRequest,
  current: ProviderModels,
  next: ProviderModels,
  nextProviders: readonly string[],
): void {
  const effectiveCurrent = pruneProviderModelsForProviders(current, nextProviders)
  const effectiveNext = pruneProviderModelsForProviders(next, nextProviders)
  if (providerModelsEqual(effectiveCurrent, effectiveNext)) return
  requireScope(request, SETTINGS_WRITE_SCOPE)
}

/**
 * An explicit `qualifiedAliases` write is all-or-nothing: any rejected entry is
 * a 400 naming each entry and its reason, in the message and in details.
 * Shared with `POST /apply`.
 */
export function requireQualifiedAliases(
  identity: { displayName: string; aliases: readonly string[] },
  requested: readonly string[],
  competitorNames: readonly string[],
): string[] {
  const resolved = resolveProjectQualifiedAliases(identity, requested, competitorNames)
  if (resolved.rejected.length > 0) {
    const reasons = resolved.rejected.map(entry => `${entry.name} (${entry.reason})`).join(', ')
    throw validationError(`Rejected qualifiedAliases: ${reasons}`, {
      rejectedQualifiedAliases: resolved.rejected,
    })
  }
  return resolved.value
}

/**
 * A project's live competitor names as a Simple run freezes them: each
 * competitor's brand label plus its curated aliases.
 */
export function liveCompetitorNames(db: Pick<DatabaseClient, 'select'>, projectId: string): string[] {
  return competitorNames(db.select({ domain: competitors.domain, aliases: competitors.aliases }).from(competitors)
    .where(eq(competitors.projectId, projectId)).all())
}

/**
 * Drops stored qualified aliases that now share a brand key with a live
 * competitor. Competitor writes outside a project PUT or apply call this in
 * their transaction, so the stored list, its export and a Simple run's frozen
 * list always agree. Returns the dropped names for the caller's audit entry.
 */
export function pruneQualifiedAliasesForCompetitors(
  tx: Pick<DatabaseClient, 'select' | 'update'>,
  projectId: string,
  now: string,
): string[] {
  const project = tx.select({
    displayName: projects.displayName,
    aliases: projects.aliases,
    qualifiedAliases: projects.qualifiedAliases,
  }).from(projects).where(eq(projects.id, projectId)).get()
  if (!project?.qualifiedAliases.length) return []
  const kept = resolveProjectQualifiedAliases(project, project.qualifiedAliases, liveCompetitorNames(tx, projectId)).value
  const dropped = project.qualifiedAliases.filter(name => !kept.includes(name))
  if (dropped.length === 0) return []
  tx.update(projects).set({ qualifiedAliases: kept, updatedAt: now }).where(eq(projects.id, projectId)).run()
  return dropped
}

function providerModelsEqual(a: ProviderModels, b: ProviderModels): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every(key => a[key] === b[key])
}

/**
 * `negativeReviewMaxStars` lives in `gbp_review_settings`, not on the row, so
 * every caller passes it in (null = the default). Required on purpose: an
 * optional argument would let a new caller silently report the default.
 */
export function formatProject(row: InferSelectModel<typeof projects>, negativeReviewMaxStars: number | null) {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    canonicalDomain: row.canonicalDomain,
    ownedDomains: row.ownedDomains,
    aliases: row.aliases,
    qualifiedAliases: row.qualifiedAliases,
    country: row.country,
    language: row.language,
    tags: row.tags,
    labels: row.labels,
    providers: row.providers,
    providerModels: row.providerModels,
    providerDispatchModes: row.providerDispatchModes,
    measurement: row.measurement,
    locations: row.locations,
    defaultLocation: row.defaultLocation,
    autoExtractBacklinks: row.autoExtractBacklinks,
    negativeReviewMaxStars,
    configSource: row.configSource,
    configRevision: row.configRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// Aliases are stored post-normalization (trimmed, case-insensitively deduped,
// stable order). Two sets that differ only in casing match the same answer
// text and produce the same persisted `answerMentioned` / overlap fields, so
// the compare is case-insensitive — a casing rename doesn't need a backfill.
function aliasArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.toLowerCase() !== b[i]!.toLowerCase()) return false
  }
  return true
}
