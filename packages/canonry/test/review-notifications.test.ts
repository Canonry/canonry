import { test, expect, onTestFinished, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, gbpLocations, gbpReviewRatings, gbpReviews, notifications, projects, writeNegativeReviewMaxStars } from '@ainyc/canonry-db'
import type { GbpReviewAlertState, GbpReviewOrigin, RatingWebhookPayload, ReviewWebhookPayload } from '@ainyc/canonry-contracts'
import { Notifier } from '../src/notifier.js'

// The sync decides what is news (see gbp-sync.test.ts); these tests pin what
// the dispatcher does with the queue: who receives it, what state each row
// ends in, and that nothing is sent twice or replayed after a long outage.

const HOUR = 3_600_000
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

function harness(opts: { events?: string[] | null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnry-reviews-'))
  onTestFinished(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const db = createClient(path.join(tmp, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'harborline', displayName: 'Harborline', canonicalDomain: 'harborline.example.com',
    country: 'US', language: 'en', providers: [], createdAt: now, updatedAt: now,
  }).run()
  db.insert(gbpLocations).values({
    id: 'loc_1', projectId, accountName: 'accounts/1', locationName: 'locations/1', displayName: 'Harborline Bayport',
    mapsUri: 'https://maps.google.com/?cid=1', selected: true, createdAt: now, updatedAt: now,
  }).run()
  const events = opts.events === undefined ? ['review.negative', 'review.rating-dropped'] : opts.events
  if (events !== null) {
    db.insert(notifications).values({
      id: crypto.randomUUID(), projectId, channel: 'webhook',
      config: { url: 'https://hooks.example/reviews', events },
      enabled: true, createdAt: now, updatedAt: now,
    } as never).run()
  }
  const notifier = new Notifier(db, 'https://canonry.test')
  const sent: Array<ReviewWebhookPayload | RatingWebhookPayload> = []
  const accept = { value: true }
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...args: unknown[]) => {
    sent.push(args[1] as ReviewWebhookPayload)
    return accept.value
  })
  return { db, projectId, notifier, sent, accept }
}

function addReview(
  db: ReturnType<typeof createClient>,
  projectId: string,
  id: string,
  opts: { starRating?: number; updateTime?: string; origin?: GbpReviewOrigin; alertState?: GbpReviewAlertState; replyComment?: string | null } = {},
) {
  const now = new Date().toISOString()
  const origin = opts.origin ?? 'gbp'
  db.insert(gbpReviews).values({
    id,
    projectId,
    locationName: 'locations/1',
    origin,
    reviewName: origin === 'gbp' ? `accounts/1/locations/1/reviews/${id}` : `places/ChIJ1/reviews/${id}`,
    starRating: opts.starRating ?? 2,
    comment: `Comment ${id}`,
    reviewerName: `Reviewer ${id}`,
    createTime: opts.updateTime ?? ago(HOUR),
    updateTime: opts.updateTime ?? ago(HOUR),
    replyComment: opts.replyComment ?? null,
    reviewUri: origin === 'places' ? `https://www.google.com/maps/reviews/${id}` : null,
    firstSeenAt: now,
    lastSeenAt: now,
    alertState: opts.alertState ?? 'pending',
    alertStateAt: now,
  }).run()
}

function reviewState(db: ReturnType<typeof createClient>, id: string) {
  return db.select().from(gbpReviews).where(eq(gbpReviews.id, id)).get()!.alertState
}

test('sends one review.negative payload with every queued review, oldest first, then marks them sent', async () => {
  const { db, projectId, notifier, sent } = harness()
  addReview(db, projectId, 'newer', { starRating: 1, updateTime: ago(HOUR) })
  addReview(db, projectId, 'older', { starRating: 3, updateTime: ago(5 * HOUR), replyComment: 'Thanks for the note.' })
  addReview(db, projectId, 'quiet', { starRating: 5, alertState: 'none' })

  const result = await notifier.dispatchReviewAlerts(projectId)

  expect(result).toEqual({ reviews: 2, ratingDrops: 0, delivered: 1 })
  expect(sent).toHaveLength(1)
  const payload = sent[0] as ReviewWebhookPayload
  expect(payload.event).toBe('review.negative')
  expect(payload).not.toHaveProperty('run')
  expect(payload.project).toEqual({ name: 'harborline', canonicalDomain: 'harborline.example.com' })
  expect(payload.dashboardUrl).toBe('https://canonry.test/projects/harborline')
  expect(payload.reviews.map((r) => [r.reviewName.split('/').at(-1), r.starRating, r.replied])).toEqual([
    ['older', 3, true],
    ['newer', 1, false],
  ])
  expect(payload.reviews[0]!.location).toEqual({
    name: 'locations/1', displayName: 'Harborline Bayport', mapsUri: 'https://maps.google.com/?cid=1',
  })
  expect(reviewState(db, 'newer')).toBe('sent')
  expect(reviewState(db, 'older')).toBe('sent')
  expect(reviewState(db, 'quiet')).toBe('none')

  // Nothing is queued any more, so a second dispatch sends nothing.
  expect(await notifier.dispatchReviewAlerts(projectId)).toEqual({ reviews: 0, ratingDrops: 0, delivered: 0 })
  expect(sent).toHaveLength(1)
})

test('only webhooks subscribed to the event receive it', async () => {
  const { db, projectId, notifier, sent } = harness({ events: ['run.completed'] })
  addReview(db, projectId, 'r1')

  const result = await notifier.dispatchReviewAlerts(projectId)

  expect(sent).toHaveLength(0)
  expect(result.delivered).toBe(0)
  // Not held for a future subscriber: subscribing later starts from new reviews.
  expect(reviewState(db, 'r1')).toBe('skipped')
})

test('a project with no webhooks marks queued alerts skipped', async () => {
  const { db, projectId, notifier, sent } = harness({ events: null })
  addReview(db, projectId, 'r1')
  await notifier.dispatchReviewAlerts(projectId)
  expect(sent).toHaveLength(0)
  expect(reviewState(db, 'r1')).toBe('skipped')
})

test('a failed delivery keeps the alert queued for the next sync', async () => {
  const { db, projectId, notifier, sent, accept } = harness()
  addReview(db, projectId, 'r1')

  accept.value = false
  expect((await notifier.dispatchReviewAlerts(projectId)).delivered).toBe(0)
  expect(reviewState(db, 'r1')).toBe('pending')

  accept.value = true
  expect((await notifier.dispatchReviewAlerts(projectId)).delivered).toBe(1)
  expect(reviewState(db, 'r1')).toBe('sent')
  expect(sent).toHaveLength(2)
})

test('an alert that outlived the window is retired as stale instead of sent', async () => {
  const { db, projectId, notifier, sent } = harness()
  addReview(db, projectId, 'late', { updateTime: ago(31 * DAY) })
  await notifier.dispatchReviewAlerts(projectId)
  expect(sent).toHaveLength(0)
  expect(reviewState(db, 'late')).toBe('stale')
})

test('Places signals are suppressed once Business Profile reviews cover the location', async () => {
  const { db, projectId, notifier, sent } = harness()
  db.update(gbpLocations).set({ reviewsAccess: 'ok' }).where(eq(gbpLocations.id, 'loc_1')).run()
  addReview(db, projectId, 'from-places', { origin: 'places' })
  addReview(db, projectId, 'from-v4', { origin: 'gbp' })
  const now = new Date().toISOString()
  db.insert(gbpReviewRatings).values({
    id: 'rating_1', projectId, locationName: 'locations/1', origin: 'places', rating: 4.3, reviewCount: 90,
    previousRating: 4.4, previousReviewCount: 89, firstObservedAt: now, observedAt: now, alertState: 'pending', alertStateAt: now,
  }).run()

  await notifier.dispatchReviewAlerts(projectId)

  expect(reviewState(db, 'from-places')).toBe('suppressed')
  expect(reviewState(db, 'from-v4')).toBe('sent')
  expect(db.select().from(gbpReviewRatings).where(eq(gbpReviewRatings.id, 'rating_1')).get()!.alertState).toBe('suppressed')
  expect(sent.map((p) => p.event)).toEqual(['review.negative'])
  expect((sent[0] as ReviewWebhookPayload).reviews.map((r) => r.origin)).toEqual(['gbp'])
})

test('lowering the threshold also stops reviews queued before the change', async () => {
  const { db, projectId, notifier, sent } = harness()
  addReview(db, projectId, 'three', { starRating: 3 })
  addReview(db, projectId, 'two', { starRating: 2 })
  writeNegativeReviewMaxStars(db, projectId, 2, new Date().toISOString())

  const result = await notifier.dispatchReviewAlerts(projectId)

  expect(result.reviews).toBe(1)
  expect((sent[0] as ReviewWebhookPayload).reviews.map((r) => r.starRating)).toEqual([2])
  expect(reviewState(db, 'three')).toBe('none')
  expect(reviewState(db, 'two')).toBe('sent')
})

test('a transient v4 error keeps a location covered once v4 has worked there', async () => {
  const { db, projectId, notifier, sent } = harness()
  db.update(gbpLocations).set({ reviewsAccess: 'error', reviewsAccessReason: 'HTTP_503' }).where(eq(gbpLocations.id, 'loc_1')).run()
  const now = new Date().toISOString()
  db.insert(gbpReviewRatings).values({
    id: 'v4_baseline', projectId, locationName: 'locations/1', origin: 'gbp', rating: 4.4, reviewCount: 80,
    firstObservedAt: now, observedAt: now, alertState: 'baseline', alertStateAt: now,
  }).run()
  addReview(db, projectId, 'from-places', { origin: 'places' })

  await notifier.dispatchReviewAlerts(projectId)

  expect(sent).toHaveLength(0)
  expect(reviewState(db, 'from-places')).toBe('suppressed')
})

test('a rating drop sends review.rating-dropped with both values; Places reviews carry no reply state', async () => {
  const { db, projectId, notifier, sent } = harness()
  const now = new Date().toISOString()
  db.insert(gbpReviewRatings).values({
    id: 'rating_1', projectId, locationName: 'locations/1', origin: 'places', rating: 4.5, reviewCount: 101,
    previousRating: 4.6, previousReviewCount: 100, firstObservedAt: now, observedAt: now, alertState: 'pending', alertStateAt: now,
  }).run()
  addReview(db, projectId, 'p2', { origin: 'places', starRating: 2 })

  const result = await notifier.dispatchReviewAlerts(projectId)

  expect(result).toEqual({ reviews: 1, ratingDrops: 1, delivered: 2 })
  const rating = sent.find((p) => p.event === 'review.rating-dropped') as RatingWebhookPayload
  expect(rating.ratings).toEqual([{
    location: { name: 'locations/1', displayName: 'Harborline Bayport', mapsUri: 'https://maps.google.com/?cid=1' },
    origin: 'places',
    previousRating: 4.6,
    rating: 4.5,
    previousReviewCount: 100,
    reviewCount: 101,
    observedAt: now,
  }])
  const review = sent.find((p) => p.event === 'review.negative') as ReviewWebhookPayload
  expect(review.reviews[0]).toMatchObject({ origin: 'places', replied: null, reviewUri: 'https://www.google.com/maps/reviews/p2' })
  expect(db.select().from(gbpReviewRatings).where(eq(gbpReviewRatings.id, 'rating_1')).get()!.alertState).toBe('sent')
})

test('two dispatches racing for one project send the queue once', async () => {
  const { db, projectId, notifier, sent } = harness()
  addReview(db, projectId, 'r1')
  await Promise.all([notifier.dispatchReviewAlerts(projectId), notifier.dispatchReviewAlerts(projectId)])
  expect(sent).toHaveLength(1)
  expect(reviewState(db, 'r1')).toBe('sent')
})
