import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { cloudMetadata, notifications, parseJsonColumn } from '@ainyc/canonry-db'
import { type NotificationEvent, validationError } from '@ainyc/canonry-contracts'
import { requireCloudBootstrap, writeAuditLog } from '../helpers.js'
import { resolveWebhookTarget } from '../webhooks.js'
import { cloudBootstrapRequestSchema } from './schema.js'

/**
 * The full set of event types the control plane subscribes to via the
 * bootstrap-created notification row. Six legacy events + six cloud events
 * — the control plane wants all of them so it can mirror state changes,
 * trigger downstream automation, and dispatch digest emails without a
 * second registration step.
 */
const CONTROL_PLANE_SUBSCRIBED_EVENTS: NotificationEvent[] = [
  // Legacy six (existing `WebhookPayload` envelope).
  'citation.lost',
  'citation.gained',
  'run.completed',
  'run.failed',
  'insight.critical',
  'insight.high',
  // Cloud six (new `CloudWebhookPayload` envelope; Track 3).
  'baseline.completed',
  'digest.generated',
  'action.created',
  'action.completed',
  'connection.created',
  'connection.revoked',
]

/**
 * Options injected by the host so the bootstrap response can report the
 * runtime's actual version + so the route doesn't need to import package.json
 * directly (api-routes is bundled separately and `import.meta.url` parsing
 * gets messy across the cjs/esm dual-build).
 */
export interface CloudBootstrapRoutesOptions {
  /** Tenant runtime version reported in the bootstrap response. */
  canonryVersion?: string
  /** Allow webhook URLs that resolve to loopback addresses. */
  allowLoopbackWebhooks?: boolean
  /** Allow webhook URLs that resolve to private RFC 1918 / Docker-bridge ranges. */
  allowPrivateNetworkWebhooks?: boolean
}

export async function cloudBootstrapRoutes(app: FastifyInstance, opts: CloudBootstrapRoutesOptions = {}) {
  const allowLoopback = opts.allowLoopbackWebhooks === true
  const allowPrivateNetworks = opts.allowPrivateNetworkWebhooks === true
  const canonryVersion = opts.canonryVersion ?? '0.0.0'

  // POST /cloud/bootstrap — register the control plane against this tenant.
  app.post('/cloud/bootstrap', async (request, reply) => {
    requireCloudBootstrap(request)

    const parsed = cloudBootstrapRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid cloud bootstrap request', {
        issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      })
    }

    // Validate the control-plane callback URL through the SSRF guard before
    // entering the transaction. Bootstrap is operator-driven and the URL
    // comes from a trusted control plane, but the same guard that protects
    // user-supplied webhooks still applies — preserves the invariant that
    // every URL written into `notifications` has been resolved at least once.
    const callbackUrl = parsed.data.control_plane_callback_url
    const urlCheck = await resolveWebhookTarget(callbackUrl, { allowLoopback, allowPrivateNetworks })
    if (!urlCheck.ok) {
      throw validationError(`control_plane_callback_url is not reachable: ${urlCheck.message}`)
    }

    const now = new Date().toISOString()

    app.db.transaction((tx) => {
      // Upsert the singleton cloud_metadata row. The migration's CHECK
      // constraint pins id='singleton' — re-running bootstrap with the
      // same tenant_id is idempotent and refreshes the row. A second
      // bootstrap with a *different* tenant_id would also collapse into
      // the same row, which is correct: one tenant id per DB per
      // deployment-posture.
      const existing = tx.select().from(cloudMetadata).where(eq(cloudMetadata.id, 'singleton')).get()
      if (existing) {
        tx.update(cloudMetadata)
          .set({
            tenantId: parsed.data.tenant_id,
            accountId: parsed.data.account_id,
            plan: parsed.data.plan,
            controlPlaneCallbackUrl: callbackUrl,
            webhookSecret: parsed.data.webhook_secret,
            managedGoogleClientId: parsed.data.managed_oauth.google_client_id,
            managedGoogleRedirectUrl: parsed.data.managed_oauth.google_callback_url,
            updatedAt: now,
          })
          .where(eq(cloudMetadata.id, 'singleton'))
          .run()
      } else {
        tx.insert(cloudMetadata).values({
          id: 'singleton',
          tenantId: parsed.data.tenant_id,
          accountId: parsed.data.account_id,
          plan: parsed.data.plan,
          controlPlaneCallbackUrl: callbackUrl,
          webhookSecret: parsed.data.webhook_secret,
          managedGoogleClientId: parsed.data.managed_oauth.google_client_id,
          managedGoogleRedirectUrl: parsed.data.managed_oauth.google_callback_url,
          bootstrappedAt: now,
          updatedAt: now,
        }).run()
      }

      // Register (or refresh) the control plane as a tenant-scoped
      // notification subscriber so the existing event-dispatch path
      // delivers our 12 events without a second integration. We key the
      // lookup off the URL — if a prior bootstrap registered the same
      // callback, refresh the events list and webhook secret in place
      // rather than creating a duplicate.
      //
      // `projectId: null` indicates a tenant-scoped webhook (the migration
      // that flipped this column nullable shipped in the same PR as the
      // bootstrap endpoint — see migration v69).
      const allRows = tx.select().from(notifications).all()
      const existingSubscriber = allRows.find((row) => {
        const config = parseJsonColumn<{ url?: string }>(
          typeof row.config === 'string' ? row.config : JSON.stringify(row.config),
          {},
        )
        return config.url === callbackUrl
      })

      if (existingSubscriber) {
        tx.update(notifications)
          .set({
            config: { url: callbackUrl, events: CONTROL_PLANE_SUBSCRIBED_EVENTS },
            webhookSecret: parsed.data.webhook_secret,
            enabled: true,
            updatedAt: now,
          })
          .where(eq(notifications.id, existingSubscriber.id))
          .run()
      } else {
        tx.insert(notifications).values({
          id: crypto.randomUUID(),
          projectId: null,
          channel: 'webhook',
          config: { url: callbackUrl, events: CONTROL_PLANE_SUBSCRIBED_EVENTS },
          webhookSecret: parsed.data.webhook_secret,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        }).run()
      }

      writeAuditLog(tx, {
        projectId: null,
        actor: 'cloud',
        action: 'cloud.bootstrap',
        entityType: 'cloud_metadata',
        entityId: parsed.data.tenant_id,
        diff: {
          tenantId: parsed.data.tenant_id,
          accountId: parsed.data.account_id,
          plan: parsed.data.plan,
          callbackUrl,
        },
      })
    })

    return reply.status(200).send({
      canonry_version: canonryVersion,
      bootstrap_completed_at: now,
      webhook_attached: true,
    })
  })
}
