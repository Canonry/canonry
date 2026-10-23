import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, onTestFinished } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  notifications,
  reviewWebhookDeliveries,
  gbpLocations,
  gbpReviews,
  auditLog,
  writeNegativeReviewMaxStars,
} from '@canonry/canonry-db'
import { eq } from 'drizzle-orm'
import {
  deliverReviewEvent,
  drainReviewDeliveries,
  reviewEventId,
} from '../src/review-webhook-delivery.js'
import type { ReviewWebhookPayload } from '@canonry/canonry-contracts'
import { Notifier } from '../src/notifier.js'

const transport = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; payload: ReviewWebhookPayload }>,
  outcomes: new Map<string, number[]>(),
}))
vi.mock('@canonry/canonry-api-routes', async importOriginal => ({
  ...await importOriginal<typeof import('@canonry/canonry-api-routes')>(),
  resolveWebhookTarget: vi.fn(async (url: string) => ({ ok: true, target: { url: new URL(url), address: '203.0.113.5', family: 4 } })),
  deliverWebhook: vi.fn(async (target: { url: URL }, payload: ReviewWebhookPayload) => {
    transport.calls.push({ url: target.url.href, payload })
    return { status: transport.outcomes.get(target.url.href)?.shift() ?? 200, error: null }
  }),
}))

const NOW = Date.parse('2026-10-23T18:00:00.000Z')
function fixture(url = 'https://receiver.example/events') {
  const root = mkdtempSync(join(tmpdir(), 'cnry-review-webhook-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const db = createClient(join(root, 'test.db'))
  migrate(db)
  db.insert(projects)
    .values({
      id: 'p1',
      name: 'client-one',
      displayName: 'Client One',
      canonicalDomain: 'one.example',
      country: 'US',
      language: 'en',
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    })
    .run()
  db.insert(projects)
    .values({
      id: 'p2',
      name: 'client-two',
      displayName: 'Client Two',
      canonicalDomain: 'two.example',
      country: 'US',
      language: 'en',
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    })
    .run()
  db.insert(gbpLocations)
    .values({
      id: 'loc1',
      projectId: 'p1',
      accountName: 'accounts/1',
      locationName: 'locations/1',
      displayName: 'Client One',
      selected: true,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    })
    .run()
  db.insert(notifications)
    .values({
      id: 'n1',
      projectId: 'p1',
      channel: 'webhook',
      config: { url, events: ['review.negative'] },
      webhookSecret: 'fixture-secret',
      enabled: true,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    })
    .run()
  db.insert(gbpReviews).values({
    id: 'review1', projectId: 'p1', locationName: 'locations/1', origin: 'gbp',
    reviewName: 'accounts/1/locations/1/reviews/review1', starRating: 2, comment: 'Needs attention.',
    createTime: new Date(NOW).toISOString(), updateTime: new Date(NOW).toISOString(),
    firstSeenAt: new Date(NOW).toISOString(), lastSeenAt: new Date(NOW).toISOString(),
    alertState: 'pending', alertStateAt: new Date(NOW).toISOString(),
  }).run()
  const payload: ReviewWebhookPayload = {
    source: 'canonry',
    event: 'review.negative',
    eventId: 'evt_' + 'a'.repeat(64),
    project: { name: 'client-one', canonicalDomain: 'one.example' },
    reviews: [
      {
        location: {
          name: 'locations/1',
          displayName: 'Client One',
          mapsUri: 'https://www.google.com/maps/?cid=123',
        },
        origin: 'gbp',
        reviewName: 'accounts/1/locations/1/reviews/review1',
        starRating: 2,
        comment: 'Needs attention.',
        reviewerName: 'Reviewer',
        createTime: new Date(NOW).toISOString(),
        updateTime: new Date(NOW).toISOString(),
        replied: false,
        reviewUri: null,
      },
    ],
    dashboardUrl: 'https://canonry.example/projects/client-one',
  }
  const resolve = vi.fn(async () => ({
    ok: true as const,
    target: { url: new URL(url), address: '203.0.113.5', family: 4 as const },
  }))
  let clock = NOW
  const options = {
    db,
    projectId: 'p1',
    notificationId: 'n1',
    payload,
    resolve,
    now: () => clock,
  }
  return {
    db,
    options,
    advance: () => {
      clock += 61_000
    },
  }
}

/** Exercise real admission while missing signing authority defers provider sends. */
async function queueReviewRevisions(f: ReturnType<typeof fixture>, count: number): Promise<void> {
  f.db.update(notifications).set({ webhookSecret: null }).where(eq(notifications.id, 'n1')).run()
  for (let i = 0; i < count; i++) {
    const review = { ...f.options.payload.reviews[0]!, comment: `Pending complaint ${i}` }
    const alertStateAt = new Date(NOW + i + 1).toISOString()
    f.db.update(gbpReviews).set({ comment: review.comment, alertStateAt }).where(eq(gbpReviews.id, 'review1')).run()
    await deliverReviewEvent({ ...f.options, payload: {
      ...f.options.payload, eventId: reviewEventId('p1', { ...review, alertStateAt }), reviews: [review],
    } })
  }
  f.db.update(notifications).set({ webhookSecret: 'fixture-secret' }).where(eq(notifications.id, 'n1')).run()
}

describe('engine review events and per-destination durable delivery', () => {
  it('keeps event IDs stable for the same material revision, separate across clients and edits', () => {
    const row = {
      reviewName: 'review1',
      origin: 'gbp',
      starRating: 3,
      comment: 'Text',
      alertStateAt: new Date(NOW).toISOString(),
    }
    expect(reviewEventId('p1', row)).toBe(reviewEventId('p1', { ...row }))
    expect(reviewEventId('p1', row)).not.toBe(reviewEventId('p2', row))
    expect(reviewEventId('p1', row)).not.toBe(
      reviewEventId('p1', { ...row, starRating: 2 }),
    )
    expect(reviewEventId('p1', row)).not.toBe(
      reviewEventId('p1', {
        ...row,
        alertStateAt: new Date(NOW + 1000).toISOString(),
      }),
    )
  })
  it('does not repeat a successful delivery after repeated dispatch or restart', async () => {
    const f = fixture()
    const deliver = vi.fn(async () => ({ status: 200, error: null }))
    expect(await deliverReviewEvent({ ...f.options, deliver })).toBe(true)
    expect(await deliverReviewEvent({ ...f.options, deliver })).toBe(true)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(f.db.select().from(reviewWebhookDeliveries).all()).toHaveLength(1)
  })
  it('retains failed destination debt independently and retries after its bound', async () => {
    const f = fixture()
    const deliver = vi
      .fn()
      .mockResolvedValueOnce({ status: 503, error: null })
      .mockResolvedValueOnce({ status: 200, error: null })
    expect(await deliverReviewEvent({ ...f.options, deliver })).toBe(false)
    expect(await deliverReviewEvent({ ...f.options, deliver })).toBe(false)
    f.advance()
    expect(await deliverReviewEvent({ ...f.options, deliver })).toBe(true)
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(deliver.mock.calls[0]?.[1]).toEqual(deliver.mock.calls[1]?.[1])
  })
  it('isolates projects and does not deliver when disabled or unsubscribed', async () => {
    const f = fixture()
    const deliver = vi.fn(async () => ({ status: 200, error: null }))
    expect(
      await deliverReviewEvent({ ...f.options, projectId: 'p2', deliver }),
    ).toBe(false)
    f.db
      .update(notifications)
      .set({ enabled: false })
      .where(eq(notifications.id, 'n1'))
      .run()
    expect(await deliverReviewEvent({ ...f.options, deliver })).toBe(false)
    expect(
      await deliverReviewEvent({
        ...f.options,
        payload: {
          ...f.options.payload,
          project: { name: 'client-two', canonicalDomain: 'two.example' },
        },
        deliver,
      }),
    ).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
    expect(f.db.select().from(reviewWebhookDeliveries).all()).toHaveLength(0)
  })
  it('refuses an unapproved destination change and unsafe endpoints', async () => {
    const f = fixture()
    const deliver = vi.fn(async () => ({ status: 503, error: null }))
    await deliverReviewEvent({ ...f.options, deliver })
    f.advance()
    f.db
      .update(notifications)
      .set({
        config: {
          url: 'https://other.example/events',
          events: ['review.negative'],
        },
      })
      .where(eq(notifications.id, 'n1'))
      .run()
    expect(await deliverReviewEvent({ ...f.options, deliver })).toBe(false)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
  it('uses a concise Discord adapter and holds an ambiguous response instead of duplicating it', async () => {
    const f = fixture('https://discord.com/api/webhooks/123/fixture_token')
    const deliver = vi.fn(async () => ({ status: 0, error: 'timeout' }))
    expect(await deliverReviewEvent({ ...f.options, deliver })).toBe(false)
    f.advance()
    expect(await deliverReviewEvent({ ...f.options, deliver })).toBe(false)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({
      username: 'Canonry',
      embeds: [{ description: 'Needs attention.' }],
    })
    expect(f.db.select().from(reviewWebhookDeliveries).get()?.state).toBe(
      'uncertain',
    )
  })
  it('claims a concurrent event once and requires a signing secret for generic receivers', async () => {
    const f = fixture()
    const deliver = vi.fn(async () => ({ status: 200, error: null }))
    await Promise.all([
      deliverReviewEvent({ ...f.options, deliver }),
      deliverReviewEvent({ ...f.options, deliver }),
    ])
    expect(deliver).toHaveBeenCalledTimes(1)
    f.db
      .update(notifications)
      .set({ webhookSecret: null })
      .where(eq(notifications.id, 'n1'))
      .run()
    expect(
      await deliverReviewEvent({
        ...f.options,
        payload: { ...f.options.payload, eventId: 'evt_' + 'b'.repeat(64) },
        deliver,
      }),
    ).toBe(false)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('retries an older failed destination after a newer material event succeeds, including a notifier restart', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    onTestFinished(() => vi.useRealTimers())
    const f = fixture()
    transport.calls.length = 0
    transport.outcomes.clear()
    transport.outcomes.set('https://receiver.example/events', [200, 200])
    transport.outcomes.set('https://second.example/events', [503, 200, 200])
    f.db.insert(notifications).values({
      id: 'n2', projectId: 'p1', channel: 'webhook',
      config: { url: 'https://second.example/events', events: ['review.negative'] },
      webhookSecret: 'fixture-second', enabled: true,
      createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    }).run()
    const notifier = new Notifier(f.db, 'https://canonry.example')
    await notifier.dispatchReviewAlerts('p1')
    const oldEvent = transport.calls[0]!.payload.eventId
    f.db.update(gbpReviews).set({ comment: 'Updated complaint.', alertStateAt: new Date(NOW + 1000).toISOString() }).where(eq(gbpReviews.id, 'review1')).run()
    await notifier.dispatchReviewAlerts('p1')
    expect(f.db.select().from(gbpReviews).get()?.alertState).toBe('sent')
    f.db.update(reviewWebhookDeliveries).set({ retryAt: '2020-01-01T00:00:00.000Z' }).where(eq(reviewWebhookDeliveries.eventId, oldEvent!)).run()
    expect(await new Notifier(f.db, 'https://canonry.example').dispatchReviewAlerts('p1')).toEqual({ reviews: 0, ratingDrops: 0, delivered: 1 })
    expect(transport.calls.filter(call => call.payload.eventId === oldEvent).map(call => call.url)).toEqual([
      'https://receiver.example/events', 'https://second.example/events', 'https://second.example/events',
    ])
    expect(transport.calls.at(-1)?.payload.reviews[0]?.comment).toBe('Needs attention.')
    expect(f.db.select().from(reviewWebhookDeliveries).all()).toHaveLength(4)
    expect(f.db.select().from(reviewWebhookDeliveries).all().every(row => row.state === 'sent')).toBe(true)
    await new Notifier(f.db, 'https://canonry.example').dispatchReviewAlerts('p1')
    expect(transport.calls).toHaveLength(5)
  })

  it.each([
    ['positive rating', 'review_no_longer_negative', (db: ReturnType<typeof createClient>) => { db.update(gbpReviews).set({ starRating: 5 }).run() }],
    ['lower threshold', 'review_no_longer_negative', (db: ReturnType<typeof createClient>) => { writeNegativeReviewMaxStars(db, 'p1', 1, new Date(NOW).toISOString()) }],
    ['expired review', 'review_expired', (db: ReturnType<typeof createClient>) => { db.update(gbpReviews).set({ updateTime: '2020-01-01T00:00:00.000Z' }).run() }],
    ['removed review', 'review_removed', (db: ReturnType<typeof createClient>) => { db.delete(gbpReviews).run() }],
    ['deselected location', 'location_removed_or_deselected', (db: ReturnType<typeof createClient>) => { db.update(gbpLocations).set({ selected: false }).run() }],
    ['removed location', 'location_removed_or_deselected', (db: ReturnType<typeof createClient>) => { db.delete(gbpLocations).run() }],
    ['changed account', 'location_removed_or_deselected', (db: ReturnType<typeof createClient>) => { db.update(gbpLocations).set({ accountName: 'accounts/other' }).run() }],
    ['disabled destination', 'destination_disabled', (db: ReturnType<typeof createClient>) => { db.update(notifications).set({ enabled: false }).run() }],
    ['changed destination', 'destination_changed', (db: ReturnType<typeof createClient>) => { db.update(notifications).set({ config: { url: 'https://other.example/events', events: ['review.negative'] } }).run() }],
    ['silent baseline', 'review_suppressed', (db: ReturnType<typeof createClient>) => { db.update(gbpReviews).set({ alertState: 'baseline' }).run() }],
  ] as const)('cancels %s debt once with an audit reason, without calling it delivered', async (_name, reason, revoke) => {
    const f = fixture()
    const deliver = vi.fn(async () => ({ status: 503, error: null }))
    await deliverReviewEvent({ ...f.options, deliver })
    f.advance()
    revoke(f.db)
    const drain = { db: f.db, projectId: 'p1', now: f.options.now, resolve: f.options.resolve, deliver }
    expect(await drainReviewDeliveries(drain)).toBe(0)
    expect(await drainReviewDeliveries(drain)).toBe(0)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(f.db.select().from(reviewWebhookDeliveries).get()).toMatchObject({ state: 'canceled', deliveredAt: null, retryAt: null, attempts: 1 })
    const audits = f.db.select().from(auditLog).all()
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ projectId: 'p1', action: 'notification.review-canceled', entityType: 'review-webhook-delivery' })
    expect(JSON.parse(audits[0]!.diff!)).toMatchObject({ reason, eventId: f.options.payload.eventId, notificationId: 'n1' })
  })

  it('does not resurrect canceled debt when its rating becomes negative again', async () => {
    const f = fixture()
    const deliver = vi.fn(async () => ({ status: 503, error: null }))
    await deliverReviewEvent({ ...f.options, deliver })
    f.db.update(gbpReviews).set({ starRating: 5 }).run()
    await deliverReviewEvent({ ...f.options, deliver })
    f.db.update(gbpReviews).set({ starRating: 2 }).run()
    f.advance()
    expect(await deliverReviewEvent({ ...f.options, deliver })).toBe(false)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(f.db.select().from(reviewWebhookDeliveries).get()?.state).toBe('canceled')
  })

  it('expires an old event even when the current review was edited recently', async () => {
    const f = fixture()
    const deliver = vi.fn(async () => ({ status: 503, error: null }))
    await deliverReviewEvent({ ...f.options, deliver })
    const later = NOW + 31 * 86_400_000
    f.db.update(gbpReviews).set({ updateTime: new Date(later).toISOString(), comment: 'Recent edit.' }).run()
    expect(await drainReviewDeliveries({ db: f.db, projectId: 'p1', now: () => later, resolve: f.options.resolve, deliver })).toBe(0)
    expect(f.db.select().from(reviewWebhookDeliveries).get()?.state).toBe('canceled')
    expect(JSON.parse(f.db.select().from(auditLog).get()!.diff!)).toMatchObject({ reason: 'review_expired' })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('does not drain another project’s delivery debt', async () => {
    const f = fixture()
    const deliver = vi.fn(async () => ({ status: 503, error: null }))
    await deliverReviewEvent({ ...f.options, deliver })
    f.advance()
    expect(await drainReviewDeliveries({ db: f.db, projectId: 'p2', now: f.options.now, resolve: f.options.resolve, deliver })).toBe(0)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(f.db.select().from(reviewWebhookDeliveries).get()?.state).toBe('pending')
  })

  it.each(['attempting', 'uncertain'] as const)('does not erase a revoked %s outcome or retry it', async state => {
    const f = fixture()
    const deliver = vi.fn(async () => ({ status: 503, error: null }))
    await deliverReviewEvent({ ...f.options, deliver })
    f.db.update(reviewWebhookDeliveries).set({ state }).run()
    f.db.update(gbpReviews).set({ starRating: 5 }).run()
    f.advance()
    await drainReviewDeliveries({ db: f.db, projectId: 'p1', now: f.options.now, resolve: f.options.resolve, deliver })
    expect(f.db.select().from(reviewWebhookDeliveries).get()?.state).toBe(state)
    expect(f.db.select().from(auditLog).all()).toHaveLength(0)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it.each(['rating', 'location', 'destination'] as const)('rechecks %s revocation after asynchronous DNS and cancels before send', async scope => {
    const f = fixture()
    const deliver = vi.fn(async () => ({ status: 200, error: null }))
    const resolve = async () => {
      if (scope === 'rating') f.db.update(gbpReviews).set({ starRating: 5 }).run()
      if (scope === 'location') f.db.update(gbpLocations).set({ selected: false }).run()
      if (scope === 'destination') f.db.update(notifications).set({ enabled: false }).run()
      return f.options.resolve()
    }
    expect(await deliverReviewEvent({ ...f.options, resolve, deliver })).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
    expect(f.db.select().from(reviewWebhookDeliveries).get()?.state).toBe('canceled')
    expect(f.db.select().from(auditLog).all()).toHaveLength(1)
  })

  it('does not let future retry debt consume the bounded ready-debt batch', async () => {
    const f = fixture()
    const deliver = vi.fn(async () => ({ status: 503, error: null }))
    await deliverReviewEvent({ ...f.options, deliver })
    await queueReviewRevisions(f, 101)
    const originalEvent = f.options.payload.eventId
    for (const debt of f.db.select().from(reviewWebhookDeliveries).all()) {
      if (debt.eventId !== originalEvent) f.db.update(reviewWebhookDeliveries).set({ retryAt: new Date(NOW + 3_600_000).toISOString() }).where(eq(reviewWebhookDeliveries.id, debt.id)).run()
    }
    f.advance()
    const accepted = vi.fn(async () => ({ status: 200, error: null }))
    expect(await drainReviewDeliveries({ db: f.db, projectId: 'p1', now: f.options.now, resolve: f.options.resolve, deliver: accepted })).toBe(1)
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(f.db.select().from(reviewWebhookDeliveries).all().filter(row => row.state === 'pending')).toHaveLength(101)
  })

  it('bounds a drain at 100 and gives unattempted ready debt priority on the next cycle', async () => {
    const f = fixture()
    const deliver = vi.fn(async () => ({ status: 503, error: null }))
    await queueReviewRevisions(f, 105)
    f.advance()
    const drain = { db: f.db, projectId: 'p1', now: f.options.now, resolve: f.options.resolve, deliver }
    await drainReviewDeliveries(drain)
    expect(deliver).toHaveBeenCalledTimes(100)
    expect(f.db.select().from(reviewWebhookDeliveries).all().filter(row => row.attempts === 0)).toHaveLength(5)
    f.advance()
    await drainReviewDeliveries(drain)
    expect(f.db.select().from(reviewWebhookDeliveries).all().every(row => row.attempts > 0)).toBe(true)
  })

  it('defers failed DNS reads without provider attempts so later ready debt still progresses', async () => {
    const f = fixture()
    const deliver = vi.fn(async () => ({ status: 503, error: null }))
    await queueReviewRevisions(f, 101)
    const initialDeadline = new Date(NOW + 60_000).toISOString()
    f.advance()
    const unavailable = vi.fn(async () => ({ ok: false as const, message: 'DNS unavailable', unresolved: true as const }))
    const drain = { db: f.db, projectId: 'p1', now: f.options.now, resolve: unavailable, deliver }
    await drainReviewDeliveries(drain)
    expect(unavailable).toHaveBeenCalledTimes(100)
    expect(f.db.select().from(reviewWebhookDeliveries).all().filter(row => row.retryAt === initialDeadline)).toHaveLength(1)
    f.advance()
    await drainReviewDeliveries(drain)
    const debts = f.db.select().from(reviewWebhookDeliveries).all()
    expect(debts.every(row => row.retryAt !== null && row.retryAt !== initialDeadline && row.attempts === 0 && row.attemptedAt === null)).toBe(true)
    expect(deliver).not.toHaveBeenCalled()
  })
})
