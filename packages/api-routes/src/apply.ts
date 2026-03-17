import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { projects, keywords, competitors, schedules, notifications } from '@ainyc/canonry-db'
import { projectConfigSchema, validationError } from '@ainyc/canonry-contracts'
import { writeAuditLog } from './helpers.js'
import { resolvePreset, validateCron, isValidTimezone } from './schedule-utils.js'
import { resolveWebhookTarget } from './webhooks.js'

export interface ApplyRoutesOptions {
  onScheduleUpdated?: (action: 'upsert' | 'delete', projectId: string) => void
  onGoogleConnectionPropertyUpdated?: (domain: string, connectionType: 'gsc' | 'ga4', propertyId: string) => void
}

export async function applyRoutes(app: FastifyInstance, opts?: ApplyRoutesOptions) {
  // POST /apply — accept a canonry.yaml body (JSON-parsed version)
  app.post('/apply', async (request, reply) => {
    const parsed = projectConfigSchema.safeParse(request.body)
    if (!parsed.success) {
      const err = validationError('Invalid project config', {
        issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      })
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const config = parsed.data
    const now = new Date().toISOString()
    const name = config.metadata.name

    // Upsert project
    const existing = app.db.select().from(projects).where(eq(projects.name, name)).get()

    let projectId: string
    if (existing) {
      projectId = existing.id
      app.db.update(projects).set({
        displayName: config.spec.displayName,
        canonicalDomain: config.spec.canonicalDomain,
        ownedDomains: JSON.stringify(config.spec.ownedDomains ?? []),
        country: config.spec.country,
        language: config.spec.language,
        labels: JSON.stringify(config.metadata.labels),
        providers: JSON.stringify(config.spec.providers ?? []),
        locations: JSON.stringify(config.spec.locations ?? []),
        defaultLocation: config.spec.defaultLocation ?? null,
        configSource: 'config-file',
        configRevision: existing.configRevision + 1,
        updatedAt: now,
      }).where(eq(projects.id, existing.id)).run()

      writeAuditLog(app.db, {
        projectId,
        actor: 'api',
        action: 'project.applied',
        entityType: 'project',
        entityId: projectId,
      })
    } else {
      projectId = crypto.randomUUID()
      app.db.insert(projects).values({
        id: projectId,
        name,
        displayName: config.spec.displayName,
        canonicalDomain: config.spec.canonicalDomain,
        ownedDomains: JSON.stringify(config.spec.ownedDomains ?? []),
        country: config.spec.country,
        language: config.spec.language,
        tags: '[]',
        labels: JSON.stringify(config.metadata.labels),
        providers: JSON.stringify(config.spec.providers ?? []),
        locations: JSON.stringify(config.spec.locations ?? []),
        defaultLocation: config.spec.defaultLocation ?? null,
        configSource: 'config-file',
        configRevision: 1,
        createdAt: now,
        updatedAt: now,
      }).run()

      writeAuditLog(app.db, {
        projectId,
        actor: 'api',
        action: 'project.created',
        entityType: 'project',
        entityId: projectId,
      })
    }

    // Atomic replace: keywords + competitors in a single transaction
    app.db.transaction((tx) => {
      tx.delete(keywords).where(eq(keywords.projectId, projectId)).run()
      for (const kw of config.spec.keywords) {
        tx.insert(keywords).values({
          id: crypto.randomUUID(),
          projectId,
          keyword: kw,
          createdAt: now,
        }).run()
      }

      writeAuditLog(tx, {
        projectId,
        actor: 'api',
        action: 'keywords.replaced',
        entityType: 'keyword',
        diff: { keywords: config.spec.keywords },
      })

      tx.delete(competitors).where(eq(competitors.projectId, projectId)).run()
      for (const domain of config.spec.competitors) {
        tx.insert(competitors).values({
          id: crypto.randomUUID(),
          projectId,
          domain,
          createdAt: now,
        }).run()
      }

      writeAuditLog(tx, {
        projectId,
        actor: 'api',
        action: 'competitors.replaced',
        entityType: 'competitor',
        diff: { competitors: config.spec.competitors },
      })
    })

    // Handle schedule from config — declarative: absent means delete
    if (config.spec.schedule) {
      const schedSpec = config.spec.schedule
      let cronExpr: string
      let preset: string | null = null

      if (schedSpec.preset) {
        preset = schedSpec.preset
        try {
          cronExpr = resolvePreset(schedSpec.preset)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: msg } })
        }
      } else if (schedSpec.cron) {
        cronExpr = schedSpec.cron
        if (!validateCron(cronExpr)) {
          return reply.status(400).send({
            error: { code: 'VALIDATION_ERROR', message: `Invalid cron expression in schedule: ${cronExpr}` },
          })
        }
      } else {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'Schedule requires either "preset" or "cron"' },
        })
      }

      const timezone = schedSpec.timezone ?? 'UTC'
      if (!isValidTimezone(timezone)) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: `Invalid timezone: ${timezone}` },
        })
      }

      const existingSched = app.db.select().from(schedules).where(eq(schedules.projectId, projectId)).get()
      if (existingSched) {
        app.db.update(schedules).set({
          cronExpr,
          preset,
          timezone,
          providers: JSON.stringify(schedSpec.providers ?? []),
          enabled: 1,
          updatedAt: now,
        }).where(eq(schedules.id, existingSched.id)).run()
      } else {
        app.db.insert(schedules).values({
          id: crypto.randomUUID(),
          projectId,
          cronExpr,
          preset,
          timezone,
          enabled: 1,
          providers: JSON.stringify(schedSpec.providers ?? []),
          createdAt: now,
          updatedAt: now,
        }).run()
      }

      opts?.onScheduleUpdated?.('upsert', projectId)
    } else {
      // Declaratively remove schedule if omitted from config
      const existingSched = app.db.select().from(schedules).where(eq(schedules.projectId, projectId)).get()
      if (existingSched) {
        app.db.delete(schedules).where(eq(schedules.projectId, projectId)).run()
        opts?.onScheduleUpdated?.('delete', projectId)
      }
    }

    // Handle notifications from config — declarative replace only when key is
    // explicitly present (absent key leaves existing notifications untouched).
    const rawSpec = (request.body as { spec?: Record<string, unknown> })?.spec ?? {}
    if ('notifications' in rawSpec) {
      // Validate all URLs before any writes so the replace is atomic.
      for (const notif of config.spec.notifications) {
        const urlCheck = await resolveWebhookTarget(notif.url ?? '')
        if (!urlCheck.ok) {
          return reply.status(400).send({
            error: { code: 'VALIDATION_ERROR', message: `Notification URL invalid: ${urlCheck.message}` },
          })
        }
      }

      app.db.delete(notifications).where(eq(notifications.projectId, projectId)).run()
      for (const notif of config.spec.notifications) {
        app.db.insert(notifications).values({
          id: crypto.randomUUID(),
          projectId,
          channel: notif.channel,
          config: JSON.stringify({ url: notif.url, events: notif.events }),
          webhookSecret: crypto.randomBytes(32).toString('hex'),
          enabled: 1,
          createdAt: now,
          updatedAt: now,
        }).run()
      }

      writeAuditLog(app.db, {
        projectId,
        actor: 'api',
        action: 'notifications.replaced',
        entityType: 'notification',
        diff: { notifications: config.spec.notifications },
      })
    }

    // Handle google config — if spec.google.gsc.propertyUrl is set and a GSC connection
    // exists for this project's domain, update the property.
    if ('google' in rawSpec && config.spec.google?.gsc?.propertyUrl) {
      opts?.onGoogleConnectionPropertyUpdated?.(config.spec.canonicalDomain, 'gsc', config.spec.google.gsc.propertyUrl)
    }

    const project = app.db.select().from(projects).where(eq(projects.id, projectId)).get()!
    return reply.status(200).send({
      id: project.id,
      name: project.name,
      displayName: project.displayName,
      canonicalDomain: project.canonicalDomain,
      ownedDomains: JSON.parse(project.ownedDomains || '[]') as string[],
      country: project.country,
      language: project.language,
      tags: JSON.parse(project.tags) as string[],
      labels: JSON.parse(project.labels) as Record<string, string>,
      providers: JSON.parse(project.providers || '[]') as string[],
      locations: JSON.parse(project.locations || '[]') as unknown[],
      defaultLocation: project.defaultLocation,
      configSource: project.configSource,
      configRevision: project.configRevision,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })
  })
}
