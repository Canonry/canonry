import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { projects, keywords, competitors, schedules, notifications } from '@ainyc/canonry-db'
import { validationError } from '@ainyc/canonry-contracts'
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
      country: string
      language: string
      tags?: string[]
      labels?: Record<string, string>
      providers?: string[]
      configSource?: string
    }
  }>('/projects/:name', async (request, reply) => {
    const { name } = request.params
    const body = request.body
    if (!body || !body.displayName || !body.canonicalDomain || !body.country || !body.language) {
      const err = validationError('Missing required fields: displayName, canonicalDomain, country, language')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const now = new Date().toISOString()
    const existing = app.db.select().from(projects).where(eq(projects.name, name)).get()

    if (existing) {
      app.db.update(projects).set({
        displayName: body.displayName,
        canonicalDomain: body.canonicalDomain,
        country: body.country,
        language: body.language,
        tags: JSON.stringify(body.tags ?? []),
        labels: JSON.stringify(body.labels ?? {}),
        providers: JSON.stringify(body.providers ?? []),
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
      country: body.country,
      language: body.language,
      tags: JSON.stringify(body.tags ?? []),
      labels: JSON.stringify(body.labels ?? {}),
      providers: JSON.stringify(body.providers ?? []),
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
        country: project.country,
        language: project.language,
        keywords: kws.map(k => k.keyword),
        competitors: comps.map(c => c.domain),
        providers: JSON.parse(project.providers || '[]') as string[],
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
  country: string
  language: string
  tags: string
  labels: string
  providers: string
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
    country: row.country,
    language: row.language,
    tags: JSON.parse(row.tags) as string[],
    labels: JSON.parse(row.labels) as Record<string, string>,
    providers: JSON.parse(row.providers || '[]') as string[],
    configSource: row.configSource,
    configRevision: row.configRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
