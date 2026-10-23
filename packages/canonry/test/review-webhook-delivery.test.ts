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
} from '@canonry/canonry-db'
import { eq } from 'drizzle-orm'
import {
  deliverReviewEvent,
  reviewEventId,
} from '../src/review-webhook-delivery.js'
import type { ReviewWebhookPayload } from '@canonry/canonry-contracts'

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
})
