import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { notifications } from '@canonry/canonry-db'
import type { NotificationEvent, NotificationDto, NotificationUpdateRequest } from '@canonry/canonry-contracts'
import { notificationEventSchema, notificationUpdateRequestSchema, validationError, notFound, deliveryFailed } from '@canonry/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import { redactNotificationUrl } from './notification-redaction.js'
import { deliverWebhook, resolveWebhookTarget, webhookUserAgent } from './webhooks.js'
import { toAlertView } from './notifications/alert.js'
import { resolveDestination } from './notifications/destinations.js'
import {
  connectionRoute,
  webhookOutcomeTarget,
  webhookResponseReason,
  webhookTargetRefusalReason,
  type ConnectionSubject,
} from './connection-telemetry.js'

/** The `source` the CLI and MCP give the external agent webhook. */
const AGENT_WEBHOOK_SOURCE = 'agent'

/** A webhook connection's outcome subject: an agent webhook or a plain one, and where it delivers. */
function webhookConnection(action: ConnectionSubject['action'], url: unknown, source: unknown): ConnectionSubject {
  return {
    integration: source === AGENT_WEBHOOK_SOURCE ? 'agent_webhook' : 'webhook',
    action,
    ...(typeof url === 'string' && url ? { target: webhookOutcomeTarget(url) } : {}),
  }
}

// Derived from the contract so a new event cannot be emitted by the notifier
// yet rejected when someone tries to subscribe to it.
const VALID_EVENTS: readonly NotificationEvent[] = notificationEventSchema.options

export interface NotificationRoutesOptions {
  /** Allow webhook URLs that resolve to loopback addresses. Defaults to false. */
  allowLoopbackWebhooks?: boolean
  /** The running Canonry package version, sent in the test delivery's User-Agent. */
  appVersion?: string
}

export async function notificationRoutes(app: FastifyInstance, opts: NotificationRoutesOptions = {}) {
  const allowLoopback = opts.allowLoopbackWebhooks === true
  // GET /notifications/events — list valid notification event types
  app.get('/notifications/events', async (_request, reply) => {
    return reply.send(VALID_EVENTS)
  })

  // POST /projects/:name/notifications — create notification
  app.post<{
    Params: { name: string }
    Body: { channel: string; url: string; events: string[]; source?: string }
  }>('/projects/:name/notifications', connectionRoute(app, (request) => {
    const body = request.body as { url?: unknown; source?: unknown } | undefined
    return webhookConnection('connect', body?.url, body?.source)
  }, async (request, reply, attempt) => {
    const project = resolveProject(app.db, request.params.name)

    const { channel, url, events, source } = request.body ?? {}

    if (channel !== 'webhook') throw validationError('Only "webhook" channel is supported')

    const urlCheck = await resolveWebhookTarget(url ?? '', { allowLoopback })
    if (!urlCheck.ok) {
      attempt.failed(undefined, webhookTargetRefusalReason(urlCheck))
      throw validationError(urlCheck.message)
    }

    if (!events?.length) throw validationError('"events" must be a non-empty array')

    const invalid = events.filter(e => !VALID_EVENTS.includes(e as NotificationEvent))
    if (invalid.length) {
      throw validationError(`Invalid event(s): ${invalid.join(', ')}. Must be one of: ${VALID_EVENTS.join(', ')}`)
    }

    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    const webhookSecret = crypto.randomBytes(32).toString('hex')

    app.db.insert(notifications).values({
      id,
      projectId: project.id,
      channel: 'webhook',
      config: { url, events, ...(source ? { source } : {}) },
      webhookSecret,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).run()

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'notification.created',
      entityType: 'notification',
      entityId: id,
      diff: { channel, ...redactNotificationUrl(url), events },
    })

    // Include webhookSecret only in the 201 response; it is never returned again.
    return reply.status(201).send({
      ...formatNotification(app.db.select().from(notifications).where(eq(notifications.id, id)).get()!),
      webhookSecret,
    })
  }))

  // GET /projects/:name/notifications — list notifications
  app.get<{ Params: { name: string } }>('/projects/:name/notifications', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const rows = app.db.select().from(notifications).where(eq(notifications.projectId, project.id)).all()
    return reply.send(rows.map(formatNotification))
  })

  // DELETE /projects/:name/notifications/:id — remove notification
  app.delete<{ Params: { name: string; id: string } }>('/projects/:name/notifications/:id', connectionRoute(app, (request) => {
    const stored = app.db.select({ config: notifications.config }).from(notifications).where(eq(notifications.id, request.params.id)).get()
    const config = stored?.config as { url?: string; source?: string } | undefined
    return config ? webhookConnection('disconnect', config.url, config.source) : undefined
  }, async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const notification = app.db.select().from(notifications).where(eq(notifications.id, request.params.id)).get()
    if (!notification || notification.projectId !== project.id) {
      throw notFound('Notification', request.params.id)
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
  }))

  // PATCH /projects/:name/notifications/:id — change a webhook's events or
  // enabled flag in place. The URL and signing secret are left alone, so a
  // receiver that checks the signature keeps working. Without this, a webhook
  // made before an event existed could only gain it by being deleted and
  // re-added with its URL, which MCP callers never see.
  app.patch<{ Params: { name: string; id: string }; Body: NotificationUpdateRequest }>('/projects/:name/notifications/:id', async (request, reply) => {
    const body: unknown = request.body
    const fields = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    const eventLists: unknown[] = [fields.events, fields.addEvents, fields.removeEvents]
    const invalid: unknown[] = eventLists.flatMap((list): unknown[] => Array.isArray(list)
      ? (list as unknown[]).filter(e => !VALID_EVENTS.includes(e as NotificationEvent))
      : [])
    if (invalid.length) {
      throw validationError(`Invalid event(s): ${invalid.join(', ')}. Must be one of: ${VALID_EVENTS.join(', ')}`)
    }
    const parsed = notificationUpdateRequestSchema.safeParse(body ?? {})
    if (!parsed.success) {
      throw validationError('Invalid notification update', {
        issues: parsed.error.issues.map(issue => ({
          path: issue.path.join('.') || ('keys' in issue && Array.isArray(issue.keys) ? issue.keys.join('.') : ''),
          message: issue.message,
        })),
      })
    }
    const update = parsed.data
    if (update.events !== undefined && (update.addEvents !== undefined || update.removeEvents !== undefined)) {
      throw validationError('"events" replaces the whole list; send it alone, or use "addEvents" / "removeEvents" without it')
    }
    if (update.events === undefined && update.addEvents === undefined && update.removeEvents === undefined && update.enabled === undefined) {
      throw validationError('Name at least one field to change: "events", "addEvents", "removeEvents" or "enabled"')
    }

    const project = resolveProject(app.db, request.params.name)
    const notification = app.db.select().from(notifications).where(eq(notifications.id, request.params.id)).get()
    if (!notification || notification.projectId !== project.id) {
      throw notFound('Notification', request.params.id)
    }

    const config = notification.config as { url: string; events: NotificationEvent[]; source?: string }
    const events = nextNotificationEvents(config.events, update)
    if (events.length === 0) {
      throw validationError('A webhook needs at least one event; remove the webhook instead of removing all of its events')
    }
    const enabled = update.enabled ?? notification.enabled
    const eventsChanged = events.length !== config.events.length || events.some((event, i) => event !== config.events[i])
    const enabledChanged = enabled !== notification.enabled

    if (eventsChanged || enabledChanged) {
      app.db.transaction((tx) => {
        tx.update(notifications)
          .set({ config: { ...config, events }, enabled, updatedAt: new Date().toISOString() })
          .where(eq(notifications.id, notification.id))
          .run()
        writeAuditLog(tx, {
          projectId: project.id,
          actor: 'api',
          action: 'notification.updated',
          entityType: 'notification',
          entityId: notification.id,
          diff: {
            ...(eventsChanged ? { events: { from: config.events, to: events } } : {}),
            ...(enabledChanged ? { enabled: { from: notification.enabled, to: enabled } } : {}),
          },
        })
      })
    }

    return reply.send(formatNotification(app.db.select().from(notifications).where(eq(notifications.id, notification.id)).get()!))
  })

  // POST /projects/:name/notifications/:id/test — send a test webhook from the server
  // Reported as an `integration.connection` test rather than a `webhooks.test`
  // feature outcome: it checks that one destination answers, beside its connect and delete.
  app.post<{ Params: { name: string; id: string } }>('/projects/:name/notifications/:id/test', connectionRoute(app, (request) => {
    const stored = app.db.select({ config: notifications.config }).from(notifications).where(eq(notifications.id, request.params.id)).get()
    const config = stored?.config as { url?: string; source?: string } | undefined
    return config ? webhookConnection('test', config.url, config.source) : undefined
  }, async (request, reply, attempt) => {
    const project = resolveProject(app.db, request.params.name)

    const notification = app.db.select().from(notifications).where(eq(notifications.id, request.params.id)).get()
    if (!notification || notification.projectId !== project.id) {
      throw notFound('Notification', request.params.id)
    }

    const config = notification.config

    // Re-validate URL at delivery time (stored URLs may predate validation logic)
    const urlCheck = await resolveWebhookTarget(config.url, { allowLoopback })
    if (!urlCheck.ok) {
      attempt.failed(undefined, webhookTargetRefusalReason(urlCheck))
      throw validationError(`Stored webhook URL is invalid: ${urlCheck.message}`)
    }

    const payload = {
      source: 'canonry',
      event: 'run.completed',
      project: { name: project.name, canonicalDomain: project.canonicalDomain },
      run: { id: 'test-run-id', status: 'completed', finishedAt: new Date().toISOString() },
      transitions: [
        { query: 'test query', from: 'not-cited', to: 'cited', provider: 'gemini' },
      ],
      // Absolute where possible: a chat receiver rejects a relative link.
      // The renderers drop an unusable one rather than failing the message,
      // but a test that exercises the real shape should carry a real link.
      dashboardUrl: `${request.protocol}://${request.hostname}/projects/${project.name}`,
    }

    // Send exactly what a real notification would send. This route used to POST
    // the payload verbatim regardless of destination, so testing a Discord or
    // Slack webhook always returned 400 — the receiver rejects arbitrary JSON.
    // A test that cannot succeed against a working destination is worse than no
    // test: it reports a healthy path as broken.
    const destination = resolveDestination(config.url)
    const body = destination.render
      ? destination.render(toAlertView(payload as never))
      : payload
    const signingSecret = destination.signed ? notification.webhookSecret ?? null : null

    const targetLabel = redactNotificationUrl(config.url).urlDisplay
    request.log.info(`[Notification test] POST ${targetLabel} (${destination.destination})`)
    const delivery = await deliverWebhook(urlCheck.target, body as never, signingSecret, { userAgent: webhookUserAgent(opts.appVersion) })
    const { status, error } = delivery
    request.log.info(`[Notification test] Response: HTTP ${status} from ${targetLabel}`)
    // Succeeded only when the destination answered 2xx; the route still answers 200 otherwise.
    const failure = webhookResponseReason(delivery)
    if (failure) attempt.failed(undefined, failure)

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'notification.tested',
      entityType: 'notification',
      entityId: notification.id,
      diff: { status, error },
    })

    if (error) throw deliveryFailed(error)
    return reply.send({ status, ok: status >= 200 && status < 300 })
  }))
}

/**
 * The event list an update leaves: `events` replaces the stored list;
 * otherwise `removeEvents` drops events and `addEvents` appends new ones after
 * the stored ones. A repeated event would send the same alert twice, so each
 * is kept once, in first-seen order.
 */
function nextNotificationEvents(
  stored: readonly NotificationEvent[],
  update: Pick<NotificationUpdateRequest, 'events' | 'addEvents' | 'removeEvents'>,
): NotificationEvent[] {
  if (update.events) return [...new Set(update.events)]
  const removed = new Set(update.removeEvents ?? [])
  return [...new Set([...stored, ...(update.addEvents ?? [])])].filter(event => !removed.has(event))
}

function formatNotification(row: typeof notifications.$inferSelect): Omit<NotificationDto, 'webhookSecret'> {
  const config = row.config as { url: string; events: NotificationEvent[]; source?: string }
  const redacted = redactNotificationUrl(config.url)
  return {
    id: row.id,
    projectId: row.projectId,
    channel: 'webhook',
    url: redacted.url,
    urlDisplay: redacted.urlDisplay,
    urlHost: redacted.urlHost,
    events: config.events,
    enabled: row.enabled,
    ...(config.source ? { source: config.source } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
