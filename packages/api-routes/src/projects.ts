import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { projects, keywords, competitors, schedules, notifications } from '@ainyc/canonry-db'
import { validationError, locationContextSchema } from '@ainyc/canonry-contracts'
import type { LocationContext } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'

export interface ProjectRoutesOptions {
  onProjectDeleted?: (projectId: string) => void
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
      configSource?: string
    }
  }>('/projects/:name', async (request, reply) => {
    const { name } = request.params
    const body = request.body
    if (!body || !body.displayName || !body.canonicalDomain || !body.country || !body.language) {
      const err = validationError('Missing required fields: displayName, canonicalDomain, country, language')
      return reply.status(err.statusCode).send(err.toJSON())
    }
    if (body.ownedDomains !== undefined && (
      !Array.isArray(body.ownedDomains) ||
      body.ownedDomains.some(d => typeof d !== 'string' || d.trim() === '')
    )) {
      const err = validationError('ownedDomains must be an array of non-empty strings')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const now = new Date().toISOString()
    const existing = app.db.select().from(projects).where(eq(projects.name, name)).get()

    if (existing) {
      app.db.update(projects).set({
        displayName: body.displayName,
        canonicalDomain: body.canonicalDomain,
        ownedDomains: JSON.stringify(body.ownedDomains ?? []),
        country: body.country,
        language: body.language,
        tags: JSON.stringify(body.tags ?? []),
        labels: JSON.stringify(body.labels ?? {}),
        providers: JSON.stringify(body.providers ?? []),
        locations: JSON.stringify(body.locations ?? JSON.parse(existing.locations || '[]')),
        defaultLocation: body.defaultLocation !== undefined ? (body.defaultLocation ?? null) : existing.defaultLocation,
        configSource: body.configSource ?? 'api',
        configRevision: existing.configRevision + 1,
        updatedAt: now,
      }).where(eq(projects.id, existing.id)).run()

      writeAuditLog(app.db, {
        projectId: existing.id,
        actor: 'api',
        action: 'project.updated',
        entityType: 'project',
        entityId: existing.id,
      })

      const updated = app.db.select().from(projects).where(eq(projects.id, existing.id)).get()!
      return reply.status(200).send(formatProject(updated))
    }

    const id = crypto.randomUUID()
    app.db.insert(projects).values({
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
      locations: JSON.stringify(body.locations ?? []),
      defaultLocation: body.defaultLocation ?? null,
      configSource: body.configSource ?? 'api',
      configRevision: 1,
      createdAt: now,
      updatedAt: now,
    }).run()

    writeAuditLog(app.db, {
      projectId: id,
      actor: 'api',
      action: 'project.created',
      entityType: 'project',
      entityId: id,
    })

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
    try {
      const project = resolveProject(app.db, request.params.name)
      return reply.send(formatProject(project))
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'statusCode' in e && 'toJSON' in e) {
        const err = e as { statusCode: number; toJSON(): unknown }
        return reply.status(err.statusCode).send(err.toJSON())
      }
      throw e
    }
  })

  // DELETE /projects/:name
  app.delete<{ Params: { name: string } }>('/projects/:name', async (request, reply) => {
    let project: ReturnType<typeof resolveProject>
    try {
      project = resolveProject(app.db, request.params.name)
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'statusCode' in e && 'toJSON' in e) {
        const err = e as { statusCode: number; toJSON(): unknown }
        return reply.status(err.statusCode).send(err.toJSON())
      }
      throw e
    }

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
    let project: ReturnType<typeof resolveProject>
    try {
      project = resolveProject(app.db, request.params.name)
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'statusCode' in e && 'toJSON' in e) {
        const err = e as { statusCode: number; toJSON(): unknown }
        return reply.status(err.statusCode).send(err.toJSON())
      }
      throw e
    }

    const parsed = locationContextSchema.safeParse(request.body)
    if (!parsed.success) {
      const err = validationError(parsed.error.issues.map(i => i.message).join(', '))
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const location = parsed.data
    const existing = JSON.parse(project.locations || '[]') as LocationContext[]
    if (existing.some(l => l.label === location.label)) {
      const err = validationError(`Location "${location.label}" already exists`)
      return reply.status(err.statusCode).send(err.toJSON())
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
    let project: ReturnType<typeof resolveProject>
    try {
      project = resolveProject(app.db, request.params.name)
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'statusCode' in e && 'toJSON' in e) {
        const err = e as { statusCode: number; toJSON(): unknown }
        return reply.status(err.statusCode).send(err.toJSON())
      }
      throw e
    }

    const locations = JSON.parse(project.locations || '[]') as LocationContext[]
    return reply.send({
      locations,
      defaultLocation: project.defaultLocation,
    })
  })

  // DELETE /projects/:name/locations/:label — remove location
  app.delete<{
    Params: { name: string; label: string }
  }>('/projects/:name/locations/:label', async (request, reply) => {
    let project: ReturnType<typeof resolveProject>
    try {
      project = resolveProject(app.db, request.params.name)
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'statusCode' in e && 'toJSON' in e) {
        const err = e as { statusCode: number; toJSON(): unknown }
        return reply.status(err.statusCode).send(err.toJSON())
      }
      throw e
    }

    const label = decodeURIComponent(request.params.label)
    const existing = JSON.parse(project.locations || '[]') as LocationContext[]
    const filtered = existing.filter(l => l.label !== label)
    if (filtered.length === existing.length) {
      const err = validationError(`Location "${label}" not found`)
      return reply.status(err.statusCode).send(err.toJSON())
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
    let project: ReturnType<typeof resolveProject>
    try {
      project = resolveProject(app.db, request.params.name)
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'statusCode' in e && 'toJSON' in e) {
        const err = e as { statusCode: number; toJSON(): unknown }
        return reply.status(err.statusCode).send(err.toJSON())
      }
      throw e
    }

    const label = request.body?.label
    if (!label) {
      const err = validationError('label is required')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const existing = JSON.parse(project.locations || '[]') as LocationContext[]
    if (!existing.some(l => l.label === label)) {
      const err = validationError(`Location "${label}" not found. Add it first.`)
      return reply.status(err.statusCode).send(err.toJSON())
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
    let project: ReturnType<typeof resolveProject>
    try {
      project = resolveProject(app.db, request.params.name)
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'statusCode' in e && 'toJSON' in e) {
        const err = e as { statusCode: number; toJSON(): unknown }
        return reply.status(err.statusCode).send(err.toJSON())
      }
      throw e
    }

    const kws = app.db.select().from(keywords).where(eq(keywords.projectId, project.id)).all()
    const comps = app.db.select().from(competitors).where(eq(competitors.projectId, project.id)).all()
    const schedule = app.db.select().from(schedules).where(eq(schedules.projectId, project.id)).get()
    const notificationRows = app.db.select().from(notifications).where(eq(notifications.projectId, project.id)).all()

    const config = {
      apiVersion: 'canonry/v1',
      kind: 'Project',
      metadata: {
        name: project.name,
        labels: JSON.parse(project.labels) as Record<string, string>,
      },
      spec: {
        displayName: project.displayName,
        canonicalDomain: project.canonicalDomain,
        ownedDomains: JSON.parse(project.ownedDomains || '[]') as string[],
        country: project.country,
        language: project.language,
        keywords: kws.map(k => k.keyword),
        competitors: comps.map(c => c.domain),
        providers: JSON.parse(project.providers || '[]') as string[],
        locations: JSON.parse(project.locations || '[]') as LocationContext[],
        ...(project.defaultLocation ? { defaultLocation: project.defaultLocation } : {}),
        notifications: notificationRows.map((row) => {
          const cfg = JSON.parse(row.config) as { url: string; events: string[] }
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
            providers: JSON.parse(schedule.providers || '[]') as string[],
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
    ownedDomains: JSON.parse(row.ownedDomains || '[]') as string[],
    country: row.country,
    language: row.language,
    tags: JSON.parse(row.tags) as string[],
    labels: JSON.parse(row.labels) as Record<string, string>,
    providers: JSON.parse(row.providers || '[]') as string[],
    locations: JSON.parse(row.locations || '[]') as LocationContext[],
    defaultLocation: row.defaultLocation,
    configSource: row.configSource,
    configRevision: row.configRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
