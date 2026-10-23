/** Engine-owned review event delivery. Reuses the existing guarded webhook adapters. */
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import {
  notifications,
  reviewWebhookDeliveries,
  projects,
  gbpLocations,
  type DatabaseClient,
} from '@canonry/canonry-db'
import {
  ReviewDeliveryStates as State,
  googleBusinessReviewUrl,
  type ReviewWebhookPayload,
} from '@canonry/canonry-contracts'
import {
  deliverWebhook,
  resolveDestination,
  resolveWebhookTarget,
  toAlertView,
} from '@canonry/canonry-api-routes'

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function reviewEventId(
  projectId: string,
  review: {
    reviewName: string
    origin: string
    starRating: number | null
    comment: string | null
    alertStateAt: string | null
  },
): string {
  return (
    'evt_' +
    hash([
      projectId,
      review.reviewName,
      review.origin,
      review.starRating,
      review.comment,
      review.alertStateAt,
    ])
  )
}
export async function deliverReviewEvent(options: {
  db: DatabaseClient
  projectId: string
  notificationId: string
  payload: ReviewWebhookPayload
  now?: () => number
  allowLoopback?: boolean
  onDelivered?: () => void
  resolve?: typeof resolveWebhookTarget
  deliver?: typeof deliverWebhook
}): Promise<boolean> {
  const { db, projectId, notificationId, payload } = options
  if (
    !payload.eventId ||
    !/^evt_[a-f0-9]{64}$/u.test(payload.eventId) ||
    payload.reviews.length !== 1
  )
    return false
  const notification = db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.projectId, projectId),
      ),
    )
    .get()
  if (
    !notification?.enabled ||
    !notification.config.events.includes('review.negative')
  )
    return false
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get()
  const review = payload.reviews[0]!
  const location = db
    .select()
    .from(gbpLocations)
    .where(
      and(
        eq(gbpLocations.projectId, projectId),
        eq(gbpLocations.locationName, review.location.name),
        eq(gbpLocations.selected, true),
      ),
    )
    .get()
  if (
    !project ||
    project.name !== payload.project.name ||
    project.canonicalDomain !== payload.project.canonicalDomain ||
    !location ||
    (review.origin === 'gbp' &&
      !review.reviewName.startsWith(
        `${location.accountName}/${location.locationName}/reviews/`,
      ))
  )
    return false
  const targetDigest = hash(notification.config.url)
  const id = hash([projectId, notificationId, payload.eventId])
  const now = options.now ?? Date.now
  const at = new Date(now()).toISOString()
  db.insert(reviewWebhookDeliveries)
    .values({
      id,
      projectId,
      notificationId,
      eventId: payload.eventId,
      targetDigest,
      payload,
      createdAt: at,
    })
    .onConflictDoNothing()
    .run()
  let saved = db
    .select()
    .from(reviewWebhookDeliveries)
    .where(eq(reviewWebhookDeliveries.id, id))
    .get()
  if (!saved || saved.targetDigest !== targetDigest) return false
  if (saved.state === State.Sent) return true
  if (saved.state === State.Uncertain) return false
  const destination = resolveDestination(notification.config.url)
  if (
    destination.render &&
    !googleBusinessReviewUrl(review.reviewUri) &&
    !googleBusinessReviewUrl(review.location.mapsUri)
  )
    return false
  if (saved.state === State.Attempting) {
    if (!saved.attemptedAt || now() - Date.parse(saved.attemptedAt) < 60_000)
      return false
    // Generic receivers deduplicate by stable eventId. A chat webhook cannot
    // prove whether an interrupted request landed, so it needs reconciliation.
    const state = destination.signed ? State.Pending : State.Uncertain
    db.update(reviewWebhookDeliveries)
      .set({ state })
      .where(
        and(
          eq(reviewWebhookDeliveries.id, id),
          eq(reviewWebhookDeliveries.state, State.Attempting),
        ),
      )
      .run()
    saved = db
      .select()
      .from(reviewWebhookDeliveries)
      .where(eq(reviewWebhookDeliveries.id, id))
      .get()
    if (!saved || saved.state !== State.Pending) return false
  }
  if (saved.retryAt && Date.parse(saved.retryAt) > now()) return false
  if (destination.signed && !notification.webhookSecret) return false
  const target = await (options.resolve ?? resolveWebhookTarget)(
    notification.config.url,
    { allowLoopback: options.allowLoopback ?? false },
  )
  if (!target.ok) return false
  // Recheck destination authority after asynchronous DNS, before claim/send.
  const latest = db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.projectId, projectId),
      ),
    )
    .get()
  if (
    !latest?.enabled ||
    !latest.config.events.includes('review.negative') ||
    hash(latest.config.url) !== targetDigest
  )
    return false
  const claimed = db
    .update(reviewWebhookDeliveries)
    .set({
      state: State.Attempting,
      attempts: saved.attempts + 1,
      attemptedAt: at,
    })
    .where(
      and(
        eq(reviewWebhookDeliveries.id, id),
        eq(reviewWebhookDeliveries.state, State.Pending),
        eq(reviewWebhookDeliveries.attempts, saved.attempts),
      ),
    )
    .returning({ id: reviewWebhookDeliveries.id })
    .get()
  if (!claimed) return false
  const rendered = destination.render?.(toAlertView(saved.payload))
  const body =
    destination.destination === 'discord' &&
    rendered &&
    typeof rendered === 'object'
      ? { ...rendered, allowed_mentions: { parse: [] } }
      : (rendered ?? saved.payload)
  let status = 0
  try {
    status = (
      await (options.deliver ?? deliverWebhook)(
        target.target,
        body,
        destination.signed ? notification.webhookSecret : null,
      )
    ).status
  } catch {
    /* Ambiguous transport outcome is deliberately retained. */
  }
  const sent = status >= 200 && status < 300
  const uncertain = status === 0 && !destination.signed
  db.update(reviewWebhookDeliveries)
    .set({
      state: sent ? State.Sent : uncertain ? State.Uncertain : State.Pending,
      deliveredAt: sent ? new Date(now()).toISOString() : null,
      retryAt:
        sent || uncertain ? null : new Date(now() + 60_000).toISOString(),
    })
    .where(
      and(
        eq(reviewWebhookDeliveries.id, id),
        eq(reviewWebhookDeliveries.state, State.Attempting),
        eq(reviewWebhookDeliveries.attempts, saved.attempts + 1),
      ),
    )
    .run()
  if (sent) options.onDelivered?.()
  return sent
}
