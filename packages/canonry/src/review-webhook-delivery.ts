/** Engine-owned review event delivery. Reuses the existing guarded webhook adapters. */
import { createHash } from 'node:crypto'
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm'
import {
  notifications,
  reviewWebhookDeliveries,
  projects,
  gbpLocations,
  gbpReviews,
  gbpReviewRatings,
  readNegativeReviewMaxStars,
  type DatabaseClient,
} from '@canonry/canonry-db'
import {
  ReviewDeliveryStates as State,
  googleBusinessReviewUrl,
  businessProfileReviewsCover,
  isNegativeReviewRating,
  resolveNegativeReviewMaxStars,
  type ReviewWebhookPayload,
} from '@canonry/canonry-contracts'
import {
  deliverWebhook,
  resolveDestination,
  resolveWebhookTarget,
  toAlertView,
  writeAuditLog,
  type WebhookDeliveryResult,
} from '@canonry/canonry-api-routes'
import { describeError } from '@canonry/canonry-contracts'
import { isWithinAlertWindow } from './gbp-reviews.js'
import { createLogger } from './logger.js'

const log = createLogger('ReviewDelivery')

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Provider attempts before a retryable failure is reported instead of retried. */
export const REVIEW_DELIVERY_MAX_ATTEMPTS = 10
/**
 * Chat sends per destination in one pass. Discord and Slack rate-limit each
 * webhook, so a burst of reviews goes out a few per pass instead of tripping
 * that limit; the rest stay due for the next pass.
 */
export const REVIEW_CHAT_SENDS_PER_PASS = 3
/** How often due deliveries are retried between GBP syncs. */
export const REVIEW_DELIVERY_INTERVAL_MS = 60_000
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 6 * 60 * 60_000

/** One minute doubling to six hours, and never sooner than the receiver asked. */
function retryDelayMs(attempts: number, retryAfterSeconds?: number): number {
  const backoff = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS)
  return Math.max(backoff, (retryAfterSeconds ?? 0) * 1000)
}

/** A 4xx a retry cannot change: the destination refused the request as sent. */
function permanentlyRefused(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429
}
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
type ReviewDeliveryOptions = {
  db: DatabaseClient
  projectId: string
  notificationId: string
  payload: ReviewWebhookPayload
  now?: () => number
  allowLoopback?: boolean
  onDelivered?: () => void
  resolve?: typeof resolveWebhookTarget
  deliver?: typeof deliverWebhook
  /** Chat sends left per destination (target digest) in this pass. */
  chatSendsLeft?: Map<string, number>
}

/** A stored event can outlive its mutable review row, but never its authority. */
function reviewEventRefusal(
  db: DatabaseClient,
  projectId: string,
  payload: ReviewWebhookPayload,
  notification: typeof notifications.$inferSelect | undefined,
  targetDigest: string | undefined,
  now: Date,
): string | null {
  if (!notification?.enabled || !notification.config.events.includes('review.negative')) return 'destination_disabled'
  if (targetDigest !== undefined && hash(notification.config.url) !== targetDigest) return 'destination_changed'
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project || project.name !== payload.project.name || project.canonicalDomain !== payload.project.canonicalDomain) return 'project_changed'
  const review = payload.reviews[0]!
  const location = db.select().from(gbpLocations).where(and(
    eq(gbpLocations.projectId, projectId),
    eq(gbpLocations.locationName, review.location.name),
    eq(gbpLocations.selected, true),
  )).get()
  if (!location || (review.origin === 'gbp' && !review.reviewName.startsWith(`${location.accountName}/${location.locationName}/reviews/`))) return 'location_removed_or_deselected'
  const current = db.select().from(gbpReviews).where(and(
    eq(gbpReviews.projectId, projectId),
    eq(gbpReviews.origin, review.origin),
    eq(gbpReviews.reviewName, review.reviewName),
    eq(gbpReviews.locationName, review.location.name),
  )).get()
  if (!current) return 'review_removed'
  if (!isWithinAlertWindow(review.updateTime, now) || !isWithinAlertWindow(current.updateTime, now)) return 'review_expired'
  const threshold = resolveNegativeReviewMaxStars(readNegativeReviewMaxStars(db, projectId))
  if (!isNegativeReviewRating(current.starRating, threshold) || !isNegativeReviewRating(review.starRating, threshold)) return 'review_no_longer_negative'
  if (['baseline', 'skipped', 'suppressed', 'stale', 'none'].includes(current.alertState)) return 'review_suppressed'
  if (review.origin === 'places') {
    const v4HasWorked = db.select({ id: gbpReviewRatings.id }).from(gbpReviewRatings).where(and(
      eq(gbpReviewRatings.projectId, projectId),
      eq(gbpReviewRatings.locationName, review.location.name),
      eq(gbpReviewRatings.origin, 'gbp'),
    )).get() !== undefined
    if (businessProfileReviewsCover(location.reviewsAccess, v4HasWorked)) return 'review_origin_superseded'
  }
  return null
}

/** Pending work is cancelable; attempting/uncertain outcomes retain their evidence. */
function cancelReviewDelivery(db: DatabaseClient, id: string, reason: string): void {
  db.transaction(tx => {
    const canceled = tx.update(reviewWebhookDeliveries).set({ state: State.Canceled, retryAt: null }).where(and(
      eq(reviewWebhookDeliveries.id, id),
      eq(reviewWebhookDeliveries.state, State.Pending),
    )).returning({ projectId: reviewWebhookDeliveries.projectId, eventId: reviewWebhookDeliveries.eventId, notificationId: reviewWebhookDeliveries.notificationId, targetDigest: reviewWebhookDeliveries.targetDigest }).get()
    if (canceled) writeAuditLog(tx, {
      projectId: canceled.projectId, actor: 'scheduler', action: 'notification.review-canceled',
      entityType: 'review-webhook-delivery', entityId: id,
      diff: { eventId: canceled.eventId, notificationId: canceled.notificationId, targetDigest: canceled.targetDigest, reason },
    })
  })
}

/**
 * A failed preflight read is not a provider attempt, but must yield the batch.
 * With no attempt to count, the wait grows with the event's age instead, so an
 * unreachable target is not resolved every minute for a month.
 */
function deferReviewDelivery(db: DatabaseClient, saved: typeof reviewWebhookDeliveries.$inferSelect, now: number): void {
  if (saved.state !== State.Pending && saved.state !== State.Attempting) return
  const waited = now - Date.parse(saved.createdAt)
  const delay = Math.min(Math.max(RETRY_BASE_MS, Number.isFinite(waited) ? waited / 4 : RETRY_BASE_MS), RETRY_MAX_MS)
  db.update(reviewWebhookDeliveries).set({ retryAt: new Date(now + delay).toISOString() }).where(and(
    eq(reviewWebhookDeliveries.id, saved.id),
    eq(reviewWebhookDeliveries.state, saved.state),
    eq(reviewWebhookDeliveries.attempts, saved.attempts),
  )).run()
}

/** A delivery that stopped without landing: the doctor check lists it, the audit log explains it. */
function auditUndelivered(
  db: DatabaseClient,
  saved: typeof reviewWebhookDeliveries.$inferSelect,
  outcome: { state: string; reason: string; status?: number; attempts: number },
): void {
  writeAuditLog(db, {
    projectId: saved.projectId, actor: 'scheduler', action: 'notification.review-undelivered',
    entityType: 'review-webhook-delivery', entityId: saved.id,
    diff: { eventId: saved.eventId, notificationId: saved.notificationId, targetDigest: saved.targetDigest, ...outcome },
  })
}

/** Projects with review deliveries due now: pending past their retry time, or an attempt that never finished. */
export function dueReviewDeliveryProjects(db: DatabaseClient, now: number): string[] {
  const at = new Date(now).toISOString()
  const staleAttempt = new Date(now - 60_000).toISOString()
  return db.selectDistinct({ projectId: reviewWebhookDeliveries.projectId }).from(reviewWebhookDeliveries).where(or(
    and(eq(reviewWebhookDeliveries.state, State.Pending), or(isNull(reviewWebhookDeliveries.retryAt), lte(reviewWebhookDeliveries.retryAt, at))),
    and(eq(reviewWebhookDeliveries.state, State.Attempting), lte(reviewWebhookDeliveries.attemptedAt, staleAttempt)),
  )).all().map(row => row.projectId)
}

/**
 * Drain due deliveries every `intervalMs`, so a failed send waits for its
 * retry time rather than for the next GBP sync. Passes never overlap.
 */
export function startReviewDeliveryLoop(drain: () => Promise<number>, intervalMs = REVIEW_DELIVERY_INTERVAL_MS): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void drain()
      .catch((err: unknown) => { log.warn('review-delivery.drain-failed', { error: describeError(err) }) })
      .finally(() => { running = false })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Retry bounded durable debt even when a newer review revision is already sent. */
export async function drainReviewDeliveries(options: Omit<ReviewDeliveryOptions, 'notificationId' | 'payload'>): Promise<number> {
  const now = (options.now ?? Date.now)()
  const at = new Date(now).toISOString()
  const staleAttempt = new Date(now - 60_000).toISOString()
  const ready = options.db.select().from(reviewWebhookDeliveries).where(and(
    eq(reviewWebhookDeliveries.projectId, options.projectId),
    or(isNull(reviewWebhookDeliveries.retryAt), lte(reviewWebhookDeliveries.retryAt, at)),
    or(
      eq(reviewWebhookDeliveries.state, State.Pending),
      and(eq(reviewWebhookDeliveries.state, State.Attempting), lte(reviewWebhookDeliveries.attemptedAt, staleAttempt)),
    ),
  )).orderBy(asc(reviewWebhookDeliveries.retryAt), asc(reviewWebhookDeliveries.attemptedAt), asc(reviewWebhookDeliveries.createdAt), asc(reviewWebhookDeliveries.id)).limit(100).all()
  let delivered = 0
  const chatSendsLeft = options.chatSendsLeft ?? new Map<string, number>()
  for (const debt of ready) {
    await deliverReviewEvent({ ...options, notificationId: debt.notificationId, payload: debt.payload, chatSendsLeft,
      onDelivered: () => { delivered += 1; options.onDelivered?.() },
    })
  }
  return delivered
}

export async function deliverReviewEvent(options: ReviewDeliveryOptions): Promise<boolean> {
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
  const id = hash([projectId, notificationId, payload.eventId])
  const now = options.now ?? Date.now
  const at = new Date(now()).toISOString()
  let saved = db.select().from(reviewWebhookDeliveries).where(eq(reviewWebhookDeliveries.id, id)).get()
  const event = saved?.payload ?? payload
  const refusal = reviewEventRefusal(db, projectId, event, notification, saved?.targetDigest, new Date(now()))
  if (refusal) {
    cancelReviewDelivery(db, id, refusal)
    if (saved?.state === State.Attempting) deferReviewDelivery(db, saved, now())
    return false
  }
  // The eligibility check above established this configured destination.
  if (!notification) return false
  const targetDigest = hash(notification.config.url)
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
  saved = db
    .select()
    .from(reviewWebhookDeliveries)
    .where(eq(reviewWebhookDeliveries.id, id))
    .get()
  if (!saved || saved.targetDigest !== targetDigest) return false
  if (saved.state === State.Sent) return true
  if (saved.state === State.Uncertain || saved.state === State.Canceled) return false
  const review = saved.payload.reviews[0]!
  const destination = resolveDestination(notification.config.url)
  if (
    destination.render &&
    !googleBusinessReviewUrl(review.reviewUri) &&
    !googleBusinessReviewUrl(review.location.mapsUri)
  ) {
    deferReviewDelivery(db, saved, now())
    return false
  }
  if (saved.state === State.Attempting) {
    if (!saved.attemptedAt || !Number.isFinite(Date.parse(saved.attemptedAt)) || now() - Date.parse(saved.attemptedAt) < 60_000)
      return false
    // Generic receivers deduplicate by stable eventId. A chat webhook cannot
    // prove whether an interrupted request landed, so it needs reconciliation.
    const state = destination.signed ? State.Pending : State.Uncertain
    const moved = db.update(reviewWebhookDeliveries)
      .set({ state })
      .where(
        and(
          eq(reviewWebhookDeliveries.id, id),
          eq(reviewWebhookDeliveries.state, State.Attempting),
          eq(reviewWebhookDeliveries.attempts, saved.attempts),
          eq(reviewWebhookDeliveries.attemptedAt, saved.attemptedAt),
        ),
      )
      .returning({ id: reviewWebhookDeliveries.id })
      .get()
    if (moved && state === State.Uncertain) {
      auditUndelivered(db, saved, { state, reason: 'interrupted_attempt', attempts: saved.attempts })
    }
    saved = db
      .select()
      .from(reviewWebhookDeliveries)
      .where(eq(reviewWebhookDeliveries.id, id))
      .get()
    if (!saved || saved.state !== State.Pending) return false
  }
  if (saved.retryAt && Date.parse(saved.retryAt) > now()) return false
  if (destination.render && options.chatSendsLeft) {
    const left = options.chatSendsLeft.get(targetDigest) ?? REVIEW_CHAT_SENDS_PER_PASS
    if (left <= 0) return false
    options.chatSendsLeft.set(targetDigest, left - 1)
  }
  if (destination.signed && !notification.webhookSecret) { deferReviewDelivery(db, saved, now()); return false }
  const target = await (options.resolve ?? resolveWebhookTarget)(
    notification.config.url,
    { allowLoopback: options.allowLoopback ?? false },
  )
  if (!target.ok) { deferReviewDelivery(db, saved, now()); return false }
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
  const latestRefusal = reviewEventRefusal(db, projectId, saved.payload, latest, targetDigest, new Date(now()))
  if (latestRefusal) { cancelReviewDelivery(db, id, latestRefusal); return false }
  const claimed = db
    .update(reviewWebhookDeliveries)
    .set({
      state: State.Attempting,
      attempts: saved.attempts + 1,
      attemptedAt: new Date(now()).toISOString(),
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
  let result: WebhookDeliveryResult
  try {
    result = await (options.deliver ?? deliverWebhook)(
      target.target,
      body,
      destination.signed ? notification.webhookSecret : null,
    )
  } catch (err) {
    // A transport that threw cannot say how far the request got.
    result = { status: 0, error: describeError(err), requestSent: true }
  }
  const attempts = saved.attempts + 1
  const sent = result.status >= 200 && result.status < 300
  // Only a request that may have reached the receiver and got no answer is
  // ambiguous. A chat webhook cannot deduplicate, so that one is never resent;
  // a signed receiver deduplicates by event id, so it is retried like any
  // failure. A request known never to have left (DNS, connect, TLS) cannot
  // have landed anywhere; a transport that does not say counts as ambiguous.
  const uncertain = !sent && result.status === 0 && result.requestSent !== false && !destination.signed
  const refused = !sent && permanentlyRefused(result.status)
  const exhausted = !sent && !uncertain && !refused && attempts >= REVIEW_DELIVERY_MAX_ATTEMPTS
  const state = sent ? State.Sent : uncertain ? State.Uncertain : refused || exhausted ? State.Failed : State.Pending
  db.update(reviewWebhookDeliveries)
    .set({
      state,
      deliveredAt: sent ? new Date(now()).toISOString() : null,
      retryAt: state === State.Pending ? new Date(now() + retryDelayMs(attempts, result.retryAfterSeconds)).toISOString() : null,
    })
    .where(
      and(
        eq(reviewWebhookDeliveries.id, id),
        eq(reviewWebhookDeliveries.state, State.Attempting),
        eq(reviewWebhookDeliveries.attempts, attempts),
      ),
    )
    .run()
  if (state === State.Uncertain || state === State.Failed) {
    const reason = uncertain ? 'no_response' : refused ? 'refused' : 'retries_exhausted'
    auditUndelivered(db, saved, { state, reason, status: result.status, attempts })
  }
  if (sent) options.onDelivered?.()
  return sent
}
