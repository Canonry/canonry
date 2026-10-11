import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { notifications, type DatabaseClient } from '@ainyc/canonry-db'
import { isRedactedNotificationUrl, validationError, type ConfigNotification } from '@ainyc/canonry-contracts'

export type StoredNotification = typeof notifications.$inferSelect

export interface NotificationSetPlan {
  kept: Array<{ stored: StoredNotification; desired: ConfigNotification }>
  added: ConfigNotification[]
  removed: StoredNotification[]
}

/** Plan an ID keyed notification replacement without touching the database. */
export function planNotificationSet(
  stored: readonly StoredNotification[],
  desired: readonly ConfigNotification[],
): NotificationSetPlan {
  const byId = new Map(stored.map(row => [row.id, row]))
  const claimed = new Set<string>()
  const kept: NotificationSetPlan['kept'] = []
  const added: ConfigNotification[] = []

  for (const [index, entry] of desired.entries()) {
    if (entry.id) {
      if (claimed.has(entry.id)) {
        throw validationError(`Notification id ${entry.id} appears more than once.`, {
          issues: [{ path: `spec.notifications.${index}.id`, message: 'Notification id must be unique.' }],
        })
      }
      const existing = byId.get(entry.id)
      if (existing) {
        claimed.add(entry.id)
        kept.push({ stored: existing, desired: entry })
        continue
      }
      if (isRedactedNotificationUrl(entry.url)) {
        throw validationError(`Redacted notification ${entry.id} does not match a stored notification.`, {
          issues: [{ path: `spec.notifications.${index}.url`, message: 'Redacted URL does not match a stored notification.' }],
        })
      }
      added.push(entry)
      continue
    }

    if (isRedactedNotificationUrl(entry.url)) {
      throw validationError('A redacted notification URL must include a matching notification id.', {
        issues: [{ path: `spec.notifications.${index}.url`, message: 'A redacted URL requires a notification id.' }],
      })
    }
    const existing = stored.find(row => !claimed.has(row.id) && row.config.url === entry.url)
    if (existing) {
      claimed.add(existing.id)
      kept.push({ stored: existing, desired: entry })
    } else {
      added.push(entry)
    }
  }

  return {
    kept,
    added,
    removed: stored.filter(row => !claimed.has(row.id) && !kept.some(item => item.stored.id === row.id)),
  }
}

type NotificationTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0]

/** Apply a prevalidated plan while preserving IDs, secrets, source, and state. */
export function syncNotificationSet(
  tx: NotificationTransaction,
  projectId: string,
  plan: NotificationSetPlan,
  now: string,
): void {
  for (const item of plan.kept) {
    const source = item.stored.config.source
    tx.update(notifications).set({
      config: {
        url: isRedactedNotificationUrl(item.desired.url) ? item.stored.config.url : item.desired.url,
        events: item.desired.events,
        ...(source ? { source } : {}),
      },
      updatedAt: now,
    }).where(eq(notifications.id, item.stored.id)).run()
  }

  for (const row of plan.removed) {
    tx.delete(notifications).where(eq(notifications.id, row.id)).run()
  }

  for (const entry of plan.added) {
    tx.insert(notifications).values({
      id: crypto.randomUUID(),
      projectId,
      channel: entry.channel,
      config: { url: entry.url, events: entry.events },
      webhookSecret: crypto.randomBytes(32).toString('hex'),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).run()
  }
}

export function notificationAuditDiff(plan: NotificationSetPlan): unknown {
  return {
    kept: plan.kept.map(item => item.stored.id),
    added: plan.added.map(entry => entry.id ?? 'new'),
    removed: plan.removed.map(row => row.id),
  }
}
