import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { notifications } from '@ainyc/aeo-platform-db'
import type { NotificationEvent, NotificationDto } from '@ainyc/aeo-platform-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import { deliverWebhook, resolveWebhookTarget } from './webhooks.js'

const VALID_EVENTS: NotificationEvent[] = ['citation.lost', 'citation.gained', 'run.completed', 'run.failed']

export async function notificationRoutes(app: FastifyInstance) {
  // POST /projects/:name/notifications — create notification
  app.post<{
    Params: { name: string }
    Body: { channel: string; url: string; events: string[] }
  }>('/projects/:name/notifications', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const { channel, url, events } = request.body ?? {}

    if (channel !== 'webhook') {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Only "webhook" channel is supported' },
      })
    }

    const urlCheck = await resolveWebhookTarget(url ?? '')
    if (!urlCheck.ok) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: urlCheck.message },
      })
    }

    if (!events?.length) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: '"events" must be a non-empty array' },
      })
    }

    const invalid = events.filter(e => !VALID_EVENTS.includes(e as NotificationEvent))
    if (invalid.length) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: `Invalid event(s): ${invalid.join(', ')}. Must be one of: ${VALID_EVENTS.join(', ')}` },
      })
    }

    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    const webhookSecret = crypto.randomBytes(32).toString('hex')

    app.db.insert(notifications).values({
      id,
      projectId: project.id,
      channel: 'webhook',
      config: JSON.stringify({ url, events }),
      webhookSecret,
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    }).run()

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'notification.created',
      entityType: 'notification',
      entityId: id,
      diff: { channel, url, events },
    })

    // Include webhookSecret only in the 201 response; it is never returned again.
    return reply.status(201).send({
      ...formatNotification(app.db.select().from(notifications).where(eq(notifications.id, id)).get()!),
      webhookSecret,
    })
  })

  // GET /projects/:name/notifications — list notifications
  app.get<{ Params: { name: string } }>('/projects/:name/notifications', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const rows = app.db.select().from(notifications).where(eq(notifications.projectId, project.id)).all()
    return reply.send(rows.map(formatNotification))
  })

  // DELETE /projects/:name/notifications/:id — remove notification
  app.delete<{ Params: { name: string; id: string } }>('/projects/:name/notifications/:id', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const notification = app.db.select().from(notifications).where(eq(notifications.id, request.params.id)).get()
    if (!notification || notification.projectId !== project.id) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `Notification '${request.params.id}' not found` },
      })
    }

    app.db.delete(notifications).where(eq(notifications.id, notification.id)).run()

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'notification.deleted',
      entityType: 'notification',
      entityId: notification.id,
    })

    return reply.status(204).send()
  })

  // POST /projects/:name/notifications/:id/test — send a test webhook from the server
  app.post<{ Params: { name: string; id: string } }>('/projects/:name/notifications/:id/test', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const notification = app.db.select().from(notifications).where(eq(notifications.id, request.params.id)).get()
    if (!notification || notification.projectId !== project.id) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `Notification '${request.params.id}' not found` },
      })
    }

    const config = JSON.parse(notification.config) as { url: string; events: string[] }

    // Re-validate URL at delivery time (stored URLs may predate validation logic)
    const urlCheck = await resolveWebhookTarget(config.url)
    if (!urlCheck.ok) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: `Stored webhook URL is invalid: ${urlCheck.message}` },
      })
    }

    const payload = {
      source: 'canonry',
      event: 'run.completed',
      project: { name: project.name, canonicalDomain: project.canonicalDomain },
      run: { id: 'test-run-id', status: 'completed', finishedAt: new Date().toISOString() },
      transitions: [
        { keyword: 'test keyword', from: 'not-cited', to: 'cited', provider: 'gemini' },
      ],
      dashboardUrl: `/projects/${project.name}`,
    }

    request.log.info(`[Notification test] POST ${config.url}`)
    const { status, error } = await deliverWebhook(urlCheck.target, payload, notification.webhookSecret ?? null)
    request.log.info(`[Notification test] Response: HTTP ${status} from ${config.url}`)

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'notification.tested',
      entityType: 'notification',
      entityId: notification.id,
      diff: { status, error },
    })

    if (error) {
      return reply.status(502).send({ error: { code: 'DELIVERY_FAILED', message: error } })
    }
    return reply.send({ status, ok: status >= 200 && status < 300 })
  })
}

function formatNotification(row: typeof notifications.$inferSelect): Omit<NotificationDto, 'webhookSecret'> {
  const config = JSON.parse(row.config) as { url: string; events: NotificationEvent[] }
  return {
    id: row.id,
    projectId: row.projectId,
    channel: 'webhook',
    url: config.url,
    events: config.events,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
