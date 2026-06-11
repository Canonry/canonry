import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { notifications, parseJsonColumn } from '@ainyc/canonry-db'
import type {
  CloudNotificationEvent,
  CloudWebhookPayload,
  NotificationEvent,
} from '@ainyc/canonry-contracts'
import { parseBooleanFlag } from '@ainyc/canonry-contracts'
import { deliverWebhook, resolveWebhookTarget } from '../webhooks.js'
import { redactNotificationUrl } from '../notification-redaction.js'

/**
 * Honor the same operator opt-in flag the host sets for the SSRF guard at
 * boot (`CANONRY_ALLOW_PRIVATE_WEBHOOKS=1` in `canonry/src/server.ts`).
 *
 * The bootstrap route validates the control-plane callback URL with this
 * flag threaded in via `ApiRoutesOptions.allowPrivateNetworkWebhooks`; the
 * cloud event dispatcher re-validates the URL on every emit (DNS / firewall
 * may have moved) and must apply the same operator policy or every emit to
 * a Docker-bridge / VPN-resolved target silently fails.
 *
 * Read at call time rather than module load so a test that toggles the env
 * between cases sees the change.
 */
function privateWebhooksAllowed(): boolean {
  return parseBooleanFlag(process.env.CANONRY_ALLOW_PRIVATE_WEBHOOKS)
}

/**
 * Snapshot of the project's identity fields the cloud envelope embeds.
 * Sourced directly from the `projects` row so callers don't have to
 * reshape it.
 */
export interface CloudEventProject {
  id: string
  name: string
  canonicalDomain: string
}

export interface EmitCloudEventOptions {
  event: CloudNotificationEvent
  project: CloudEventProject
  payload: Record<string, unknown>
  /** Override `occurred_at`; defaults to `new Date().toISOString()`. */
  occurredAt?: string
  /** Override `event_id`; defaults to a fresh UUID. */
  eventId?: string
}

export interface EmitConnectionEventOptions {
  event: Extract<CloudNotificationEvent, 'connection.created' | 'connection.revoked'>
  project: CloudEventProject
  payload: {
    connectionType: string
    propertyRef: string | null
    scopes: string[]
    /** Free-form reason field — populated for `connection.revoked`. */
    reason?: string
  }
  /** Override `occurred_at`; defaults to `new Date().toISOString()`. */
  occurredAt?: string
  /** Override `event_id`; defaults to a fresh UUID. */
  eventId?: string
}

/**
 * Generic cloud-event dispatcher — used for `baseline.completed` and any
 * future tenant-emitted cloud envelope. Connection events use the
 * narrower `emitConnectionEvent` wrapper that constrains the payload
 * shape.
 *
 * Best-effort fire-and-forget: failures are swallowed (logged via
 * console.error) so callers' write paths aren't blocked by a slow or
 * down subscriber.
 */
export async function emitCloudEvent(
  db: DatabaseClient,
  options: EmitCloudEventOptions,
): Promise<void> {
  const subscribers = matchingSubscribers(db, options.event)
  if (subscribers.length === 0) return

  const occurredAt = options.occurredAt ?? new Date().toISOString()
  const eventId = options.eventId ?? crypto.randomUUID()

  const cloudPayload: CloudWebhookPayload = {
    source: 'canonry-cloud',
    event: options.event,
    event_id: eventId,
    project: {
      name: options.project.name,
      canonicalDomain: options.project.canonicalDomain,
    },
    payload: options.payload,
    occurred_at: occurredAt,
  }

  const allowPrivateNetworks = privateWebhooksAllowed()
  for (const subscriber of subscribers) {
    const url = subscriber.url
    // Webhook URLs routinely embed capability tokens in path or query —
    // never log them raw (matches the Notifier's redaction).
    const urlLabel = redactNotificationUrl(url).urlDisplay
    try {
      const target = await resolveWebhookTarget(url, { allowLoopback: true, allowPrivateNetworks })
      if (!target.ok) {
        // SSRF / unreachable target — log to stderr and continue. The
        // bootstrap registration already validated reachability; this
        // path only fails if DNS / firewall changed afterward.
        console.error(`[cloud-event] resolve failed for ${urlLabel}: ${target.message}`)
        continue
      }
      await deliverWebhook(target.target, cloudPayload, subscriber.webhookSecret)
    } catch (err) {
      console.error(`[cloud-event] deliver failed for ${urlLabel}:`, err)
    }
  }
}

/**
 * Narrower wrapper for `connection.created` / `connection.revoked` —
 * constrains the payload to the documented shape (spec §12 table).
 */
export async function emitConnectionEvent(
  db: DatabaseClient,
  options: EmitConnectionEventOptions,
): Promise<void> {
  return emitCloudEvent(db, {
    event: options.event,
    project: options.project,
    payload: { ...options.payload },
    occurredAt: options.occurredAt,
    eventId: options.eventId,
  })
}

interface MatchingSubscriber {
  url: string
  webhookSecret: string | null
}

/**
 * Pull every enabled notification row that subscribes to the given event.
 * Includes both project-scoped legacy subscribers (`projectId IS NOT NULL`)
 * and the tenant-scoped bootstrap subscriber (`projectId IS NULL`) so
 * connection events reach all interested parties — the control plane in
 * cloud mode and any operator-installed external agents in OSS.
 */
function matchingSubscribers(
  db: DatabaseClient,
  event: NotificationEvent,
): MatchingSubscriber[] {
  const rows = db.select().from(notifications).where(eq(notifications.enabled, true)).all()
  const out: MatchingSubscriber[] = []
  for (const row of rows) {
    const config = parseJsonColumn<{ url?: string; events?: string[] }>(
      typeof row.config === 'string' ? row.config : JSON.stringify(row.config),
      {},
    )
    if (!config.url) continue
    if (!Array.isArray(config.events) || !config.events.includes(event)) continue
    out.push({ url: config.url, webhookSecret: row.webhookSecret ?? null })
  }
  return out
}
