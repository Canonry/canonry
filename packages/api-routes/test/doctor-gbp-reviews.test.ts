import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, projects, gbpLocations, gbpReviewRatings, notifications, reviewWebhookDeliveries, type DatabaseClient } from '@canonry/canonry-db'
import type { GbpReviewsAccess, ReviewDeliveryState, ReviewWebhookPayload } from '@canonry/canonry-contracts'
import { GBP_REVIEWS_CHECK_BY_ID } from '../src/doctor/checks/gbp-reviews.js'
import { ALL_CHECKS } from '../src/doctor/registry.js'
import type { DoctorContext, ProjectInfo } from '../src/doctor/types.js'
import type { GoogleConnectionStore } from '../src/google.js'

const check = GBP_REVIEWS_CHECK_BY_ID['gbp.reviews.access']!
const project: ProjectInfo = { id: 'p1', name: 'hotels', canonicalDomain: 'hotels.example.com', displayName: 'Hotels' }

let tmpDir: string
let db: DatabaseClient

function seedLocation(opts: {
  locationName: string
  reviewsAccess?: GbpReviewsAccess | null
  reason?: string | null
  placeId?: string | null
  selected?: boolean
}) {
  const now = new Date().toISOString()
  db.insert(gbpLocations).values({
    id: crypto.randomUUID(),
    projectId: project.id,
    accountName: 'accounts/1',
    locationName: opts.locationName,
    displayName: opts.locationName,
    placeId: opts.placeId === undefined ? 'ChIJx' : opts.placeId,
    selected: opts.selected ?? true,
    reviewsAccess: opts.reviewsAccess ?? null,
    reviewsAccessReason: opts.reason ?? null,
    reviewsCheckedAt: opts.reviewsAccess ? now : null,
    createdAt: now,
    updatedAt: now,
  }).run()
}

function subscribe(events: string[], enabled = true) {
  const now = new Date().toISOString()
  db.insert(notifications).values({
    id: crypto.randomUUID(), projectId: project.id, channel: 'webhook',
    config: { url: 'https://hooks.example/x', events }, enabled, createdAt: now, updatedAt: now,
  } as never).run()
}

function gbpStore(connected = true): GoogleConnectionStore {
  const conn = connected
    ? { domain: project.canonicalDomain, connectionType: 'gbp' as const, createdAt: 'x', updatedAt: 'x' }
    : undefined
  return {
    listConnections: () => (conn ? [conn] : []),
    getConnection: () => conn,
    upsertConnection: (r) => r,
    updateConnection: () => conn,
    deleteConnection: () => true,
  }
}

function ctx(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    db,
    project,
    googleConnectionStore: gbpStore(true),
    getPlacesConfig: () => ({ apiKey: 'KEY', tier: 'atmosphere', refreshIntervalDays: 7 }),
    ...overrides,
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-gbp-reviews-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: project.id, name: project.name, displayName: project.displayName, canonicalDomain: project.canonicalDomain,
    country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
})
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

describe('gbp.reviews.access', () => {
  it('is registered', () => {
    expect(ALL_CHECKS.map((c) => c.id)).toContain('gbp.reviews.access')
  })

  it('skips without a GBP connection, selected locations, or a first sync', async () => {
    expect((await check.run(ctx({ googleConnectionStore: gbpStore(false) }))).code).toBe('gbp.reviews.no-gbp-connection')
    expect((await check.run(ctx())).code).toBe('gbp.reviews.no-locations')
    seedLocation({ locationName: 'locations/1' })
    const r = await check.run(ctx())
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('gbp.reviews.not-checked')
  })

  it('is ok when Business Profile reviews work everywhere', async () => {
    seedLocation({ locationName: 'locations/1', reviewsAccess: 'ok' })
    seedLocation({ locationName: 'locations/2', reviewsAccess: 'ok' })
    seedLocation({ locationName: 'locations/3', reviewsAccess: 'unavailable', selected: false })
    const r = await check.run(ctx())
    expect(r.status).toBe('ok')
    expect(r.code).toBe('gbp.reviews.full')
    expect(r.summary).toContain('2 location(s)')
  })

  it('still counts a transient error as full coverage once v4 has worked there', async () => {
    seedLocation({ locationName: 'locations/1', reviewsAccess: 'error', reason: 'HTTP_503', placeId: null })
    const now = new Date().toISOString()
    db.insert(gbpReviewRatings).values({
      id: 'r1', projectId: project.id, locationName: 'locations/1', origin: 'gbp', rating: 4.5, reviewCount: 10,
      firstObservedAt: now, observedAt: now, alertState: 'baseline',
    }).run()
    expect((await check.run(ctx())).code).toBe('gbp.reviews.full')
  })

  it('reports gated v4 with the Places fallback as partial, without paging', async () => {
    seedLocation({ locationName: 'locations/1', reviewsAccess: 'unavailable', reason: 'SERVICE_DISABLED' })
    subscribe(['review.negative'])
    const r = await check.run(ctx())
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('gbp.reviews.partial')
    expect(r.summary).toBe('Business Profile reviews are not available (SERVICE_DISABLED). 1 use the public Places listing instead, which shows at most five reviews plus the rating.')
    expect(r.remediation).toContain('mybusiness.googleapis.com')
    expect(r.details).toMatchObject({ placesFallback: true, full: 0, partial: 1, none: 0 })
  })

  it('stays quiet about a location with no source when nobody subscribed to review alerts', async () => {
    seedLocation({ locationName: 'locations/1', reviewsAccess: 'unavailable', reason: 'SERVICE_DISABLED' })
    subscribe(['run.completed'])
    subscribe(['review.negative'], false)
    const r = await check.run(ctx({ getPlacesConfig: () => ({ tier: 'atmosphere', refreshIntervalDays: 7 }) }))
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('gbp.reviews.unavailable')
    expect(r.remediation).toContain('places.tier: atmosphere')
  })

  it('warns when review webhooks are subscribed but a location has no source', async () => {
    seedLocation({ locationName: 'locations/1', reviewsAccess: 'unavailable', reason: 'SERVICE_DISABLED' })
    seedLocation({ locationName: 'locations/2', reviewsAccess: 'unavailable', reason: 'SERVICE_DISABLED', placeId: null })
    subscribe(['review.rating-dropped'])
    const r = await check.run(ctx())
    expect(r.status).toBe('warn')
    expect(r.code).toBe('gbp.reviews.no-source')
    expect(r.details).toMatchObject({ full: 0, partial: 1, none: 1 })
  })

  it('treats the pro tier as no Places fallback, since the review fields bill above it', async () => {
    seedLocation({ locationName: 'locations/1', reviewsAccess: 'unavailable', reason: 'SERVICE_DISABLED' })
    subscribe(['review.negative'])
    const r = await check.run(ctx({ getPlacesConfig: () => ({ apiKey: 'KEY', tier: 'pro', refreshIntervalDays: 7 }) }))
    expect(r.status).toBe('warn')
    expect(r.details).toMatchObject({ placesFallback: false, none: 1 })
  })
})

describe('gbp.reviews.delivery', () => {
  const delivery = GBP_REVIEWS_CHECK_BY_ID['gbp.reviews.delivery']!
  const DAY = 86_400_000

  function destination(url: string): string {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(notifications).values({
      id, projectId: project.id, channel: 'webhook',
      config: { url, events: ['review.negative'] }, enabled: true, createdAt: now, updatedAt: now,
    } as never).run()
    return id
  }

  function seedDelivery(notificationId: string, state: ReviewDeliveryState, attemptedAgoMs: number, projectId = project.id) {
    const attemptedAt = new Date(Date.now() - attemptedAgoMs).toISOString()
    const payload: ReviewWebhookPayload = {
      source: 'canonry',
      event: 'review.negative',
      eventId: 'evt_' + crypto.randomBytes(32).toString('hex'),
      project: { name: project.name, canonicalDomain: project.canonicalDomain },
      reviews: [{
        location: { name: 'locations/1', displayName: 'Hotel', mapsUri: 'https://www.google.com/maps/?cid=1' },
        origin: 'gbp',
        reviewName: 'accounts/1/locations/1/reviews/r1',
        starRating: 1,
        comment: 'Cold room.',
        reviewerName: 'A guest',
        createTime: attemptedAt,
        updateTime: attemptedAt,
        replied: false,
        reviewUri: null,
      }],
      dashboardUrl: 'https://canonry.example/projects/hotels',
    }
    db.insert(reviewWebhookDeliveries).values({
      id: crypto.randomUUID(), projectId, notificationId, eventId: payload.eventId!, targetDigest: 'digest',
      payload, state, attempts: 1, attemptedAt, createdAt: attemptedAt,
    }).run()
  }

  it('is registered and passes when every recent alert was delivered or is still retrying', () => {
    expect(ALL_CHECKS.map((c) => c.id)).toContain('gbp.reviews.delivery')
    const n = destination('https://discord.com/api/webhooks/1/secret-token')
    seedDelivery(n, 'sent', DAY)
    seedDelivery(n, 'pending', DAY)
    expect(delivery.run(ctx())).toMatchObject({ status: 'ok', code: 'gbp.reviews.delivery.ok' })
  })

  it('warns about unanswered and failed alerts with the destination redacted and the review link', () => {
    const chat = destination('https://discord.com/api/webhooks/1/secret-token')
    const generic = destination('https://hooks.example/review')
    seedDelivery(chat, 'uncertain', DAY)
    seedDelivery(generic, 'failed', 2 * DAY)
    const result = delivery.run(ctx())
    expect(result).toMatchObject({ status: 'warn', code: 'gbp.reviews.delivery.undelivered' })
    expect(result.summary).toContain('2 review alert(s)')
    expect(result.summary).toContain('1 got no answer from a chat webhook')
    expect(result.summary).toContain('1 were refused or ran out of retries')
    const deliveries = (result.details as { deliveries: Array<Record<string, unknown>> }).deliveries
    expect(deliveries.map((row) => [row.state, row.destination, row.reviewUrl, row.starRating])).toEqual([
      ['uncertain', 'discord.com/redacted', 'https://www.google.com/maps/?cid=1', 1],
      ['failed', 'hooks.example/redacted', 'https://www.google.com/maps/?cid=1', 1],
    ])
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })

  it('stops warning a week after the attempt, and never reports another project', () => {
    const n = destination('https://hooks.example/review')
    seedDelivery(n, 'failed', 8 * DAY)
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'p2', name: 'other', displayName: 'Other', canonicalDomain: 'other.example',
      country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()
    seedDelivery(n, 'uncertain', DAY, 'p2')
    expect(delivery.run(ctx())).toMatchObject({ status: 'ok' })
  })
})
