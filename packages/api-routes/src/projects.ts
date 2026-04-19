import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { projects, keywords, competitors, schedules, notifications, parseJsonColumn } from '@ainyc/canonry-db'
import {
  validationError,
  locationContextSchema,
  projectUpsertRequestSchema,
  findDuplicateLocationLabels,
  hasLocationLabel,
} from '@ainyc/canonry-contracts'
import type { LocationContext } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'

export interface ProjectRoutesOptions {
  onProjectDeleted?: (projectId: string) => void
  onProjectUpserted?: (projectId: string, projectName: string) => void
  /** Valid provider names from registered adapters — used to reject unknown providers */
  validProviderNames?: string[]
}

export async function projectRoutes(app: FastifyInstance, opts: ProjectRoutesOptions) {
  // PUT /projects/:name — upsert project
  app.put<{
    Params: { name: string }
    Body: {
      displayName: string
      canonicalDomain: string
      ownedDomains?: string[]
      country: string
      language: string
      tags?: string[]
      labels?: Record<string, string>
      providers?: string[]
      locations?: LocationContext[]
      defaultLocation?: string | null
      autoExtractBacklinks?: boolean
      configSource?: string
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
    const validNames = opts.validProviderNames ?? []
    if (validNames.length && body.providers?.length) {
      const invalid = body.providers.filter(p => !validNames.includes(p))
      if (invalid.length) {
        throw validationError(`Invalid provider(s): ${invalid.join(', ')}. Must be one of: ${validNames.join(', ')}`, {
          invalidProviders: invalid,
          validProviders: validNames,
        })
      }
    }

    const now = new Date().toISOString()
    const existing = app.db.select().from(projects).where(eq(projects.name, name)).get()
    const existingLocations = existing
      ? (parseJsonColumn<LocationContext[]>(existing.locations, []))
      : []
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
      ? (body.autoExtractBacklinks ? 1 : 0)
      : existing?.autoExtractBacklinks ?? 0

    if (existing) {
      app.db.transaction((tx) => {
        tx.update(projects).set({
          displayName: body.displayName,
          canonicalDomain: body.canonicalDomain,
          ownedDomains: JSON.stringify(body.ownedDomains ?? []),
          country: body.country,
          language: body.language,
          tags: JSON.stringify(body.tags ?? []),
          labels: JSON.stringify(body.labels ?? {}),
          providers: JSON.stringify(body.providers ?? []),
          locations: JSON.stringify(nextLocations),
          defaultLocation: nextDefaultLocation,
          autoExtractBacklinks: nextAutoExtractBacklinks,
          configSource: body.configSource ?? 'api',
          configRevision: existing.configRevision + 1,
          updatedAt: now,
        }).where(eq(projects.id, existing.id)).run()

        writeAuditLog(tx, {
          projectId: existing.id,
          actor: 'api',
          action: 'project.updated',
          entityType: 'project',
          entityId: existing.id,
        })
      })

      opts.onProjectUpserted?.(existing.id, name)

      const updated = app.db.select().from(projects).where(eq(projects.id, existing.id)).get()!
      return reply.status(200).send(formatProject(updated))
    }

    const id = crypto.randomUUID()
    app.db.transaction((tx) => {
      tx.insert(projects).values({
        id,
        name,
        displayName: body.displayName,
        canonicalDomain: body.canonicalDomain,
        ownedDomains: JSON.stringify(body.ownedDomains ?? []),
        country: body.country,
        language: body.language,
        tags: JSON.stringify(body.tags ?? []),
        labels: JSON.stringify(body.labels ?? {}),
        providers: JSON.stringify(body.providers ?? []),
        locations: JSON.stringify(nextLocations),
        defaultLocation: nextDefaultLocation,
        autoExtractBacklinks: nextAutoExtractBacklinks,
        configSource: body.configSource ?? 'api',
        configRevision: 1,
        createdAt: now,
        updatedAt: now,
      }).run()

      writeAuditLog(tx, {
        projectId: id,
        actor: 'api',
        action: 'project.created',
        entityType: 'project',
        entityId: id,
      })
    })

    opts.onProjectUpserted?.(id, name)

    const created = app.db.select().from(projects).where(eq(projects.id, id)).get()!
    return reply.status(201).send(formatProject(created))
  })

  // GET /projects — list all
  app.get('/projects', async (_request, reply) => {
    const rows = app.db.select().from(projects).all()
    return reply.send(rows.map(formatProject))
  })

  // GET /projects/:name — get single
  app.get<{ Params: { name: string } }>('/projects/:name', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    return reply.send(formatProject(project))
  })

  // DELETE /projects/:name
  app.delete<{ Params: { name: string } }>('/projects/:name', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'project.deleted',
      entityType: 'project',
      entityId: project.id,
    })

    app.db.delete(projects).where(eq(projects.id, project.id)).run()
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
    const existing = parseJsonColumn<LocationContext[]>(project.locations, [])
    if (existing.some(l => l.label === location.label)) {
      throw validationError(`Location "${location.label}" already exists`)
    }

    existing.push(location)
    const now = new Date().toISOString()
    app.db.update(projects).set({
      locations: JSON.stringify(existing),
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

    const locations = parseJsonColumn<LocationContext[]>(project.locations, [])
    return reply.send({
      locations,
      defaultLocation: project.defaultLocation,
    })
  })

  // DELETE /projects/:name/locations/:label — remove location
  app.delete<{
    Params: { name: string; label: string }
  }>('/projects/:name/locations/:label', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const label = decodeURIComponent(request.params.label)
    const existing = parseJsonColumn<LocationContext[]>(project.locations, [])
    const filtered = existing.filter(l => l.label !== label)
    if (filtered.length === existing.length) {
      throw validationError(`Location "${label}" not found`)
    }

    const now = new Date().toISOString()
    const updates: Record<string, unknown> = {
      locations: JSON.stringify(filtered),
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

    const existing = parseJsonColumn<LocationContext[]>(project.locations, [])
    if (!existing.some(l => l.label === label)) {
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

    const kws = app.db.select().from(keywords).where(eq(keywords.projectId, project.id)).all()
    const comps = app.db.select().from(competitors).where(eq(competitors.projectId, project.id)).all()
    const schedule = app.db.select().from(schedules).where(eq(schedules.projectId, project.id)).get()
    const notificationRows = app.db.select().from(notifications).where(eq(notifications.projectId, project.id)).all()

    const config = {
      apiVersion: 'canonry/v1',
      kind: 'Project',
      metadata: {
        name: project.name,
        labels: parseJsonColumn<Record<string, string>>(project.labels, {}),
      },
      spec: {
        displayName: project.displayName,
        canonicalDomain: project.canonicalDomain,
        ownedDomains: parseJsonColumn<string[]>(project.ownedDomains, []),
        country: project.country,
        language: project.language,
        keywords: kws.map(k => k.keyword),
        competitors: comps.map(c => c.domain),
        providers: parseJsonColumn<string[]>(project.providers, []),
        locations: parseJsonColumn<LocationContext[]>(project.locations, []),
        ...(project.defaultLocation ? { defaultLocation: project.defaultLocation } : {}),
        ...(project.autoExtractBacklinks === 1 ? { autoExtractBacklinks: true } : {}),
        notifications: notificationRows.map((row) => {
          const cfg = parseJsonColumn<{ url: string; events: string[] }>(row.config, { url: '', events: [] })
          return {
            channel: row.channel,
            url: cfg.url,
            events: cfg.events,
          }
        }),
        ...(schedule ? {
          schedule: {
            ...(schedule.preset ? { preset: schedule.preset } : { cron: schedule.cronExpr }),
            timezone: schedule.timezone,
            providers: parseJsonColumn<string[]>(schedule.providers, []),
          },
        } : {}),
      },
    }

    return reply.send(config)
  })
}

function formatProject(row: {
  id: string
  name: string
  displayName: string
  canonicalDomain: string
  ownedDomains: string
  country: string
  language: string
  tags: string
  labels: string
  providers: string
  locations: string
  defaultLocation: string | null
  autoExtractBacklinks: number
  configSource: string
  configRevision: number
  createdAt: string
  updatedAt: string
}) {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    canonicalDomain: row.canonicalDomain,
    ownedDomains: parseJsonColumn<string[]>(row.ownedDomains, []),
    country: row.country,
    language: row.language,
    tags: parseJsonColumn<string[]>(row.tags, []),
    labels: parseJsonColumn<Record<string, string>>(row.labels, {}),
    providers: parseJsonColumn<string[]>(row.providers, []),
    locations: parseJsonColumn<LocationContext[]>(row.locations, []),
    defaultLocation: row.defaultLocation,
    autoExtractBacklinks: row.autoExtractBacklinks === 1,
    configSource: row.configSource,
    configRevision: row.configRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
