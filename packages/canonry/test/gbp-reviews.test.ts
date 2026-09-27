import { describe, test, expect, beforeEach, onTestFinished, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, migrate, gbpReviewRatings, gbpReviews, projects, runs } from '@ainyc/canonry-db'
import { GbpApiError } from '@ainyc/canonry-integration-google-business-profile'
import {
  fetchLocationReviews,
  persistReviewObservation,
  ratingAlertState,
  reviewAlertState,
  type ReviewFetchContext,
} from '../src/gbp-reviews.js'

const listReviewsMock = vi.fn()
const getPlaceReviewSignalsMock = vi.fn()

vi.mock('@ainyc/canonry-integration-google-business-profile', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google-business-profile')>(
    '@ainyc/canonry-integration-google-business-profile',
  )
  return { ...actual, listReviews: (...a: unknown[]) => listReviewsMock(...a) }
})
vi.mock('@ainyc/canonry-integration-google-places', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google-places')>(
    '@ainyc/canonry-integration-google-places',
  )
  return { ...actual, getPlaceReviewSignals: (...a: unknown[]) => getPlaceReviewSignalsMock(...a) }
})

const DAY = 86_400_000
const NOW = new Date('2026-09-26T12:00:00.000Z')
const daysBefore = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString()

function tempDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnry-gbp-reviews-'))
  onTestFinished(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const db = createClient(path.join(tmp, 'test.db'))
  migrate(db)
  const now = NOW.toISOString()
  db.insert(projects).values({
    id: 'proj', name: 'harborline', displayName: 'Harborline', canonicalDomain: 'harborline.example.com',
    country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
  db.insert(runs).values({ id: 'run_1', projectId: 'proj', kind: 'gbp-sync', status: 'running', trigger: 'manual', createdAt: now }).run()
  return db
}

function context(): ReviewFetchContext {
  return { runId: 'run_1', now: NOW, accessToken: 'tok', places: { apiKey: 'K', tier: 'atmosphere' }, gate: { projectWideReason: null } }
}

/** A stored rating row: the baseline marker for its origin, and for Places the last-fetched stamp. */
function seedRating(db: ReturnType<typeof tempDb>, locationName: string, origin: 'gbp' | 'places', observedAt: string) {
  db.insert(gbpReviewRatings).values({
    id: `${origin}-${locationName}`, projectId: 'proj', locationName, origin, rating: 4.5, reviewCount: 10,
    firstObservedAt: observedAt, observedAt, alertState: 'baseline',
  }).run()
}

beforeEach(() => {
  vi.clearAllMocks()
  getPlaceReviewSignalsMock.mockResolvedValue({ rating: 4.5, userRatingCount: 10, reviews: [] })
})

describe('alert rules', () => {
  test('a review alerts only after the baseline, when negative, and while recent', () => {
    const recent = daysBefore(1)
    const ctx = { baseline: false, now: NOW, negativeMaxStars: 3 }
    expect(reviewAlertState({ starRating: 1, updateTime: recent }, { ...ctx, baseline: true })).toBe('baseline')
    expect(reviewAlertState({ starRating: 1, updateTime: recent }, ctx)).toBe('pending')
    expect(reviewAlertState({ starRating: 3, updateTime: daysBefore(30) }, ctx)).toBe('pending')
    expect(reviewAlertState({ starRating: 3, updateTime: daysBefore(31) }, ctx)).toBe('stale')
    expect(reviewAlertState({ starRating: 4, updateTime: recent }, ctx)).toBe('none')
    expect(reviewAlertState({ starRating: null, updateTime: recent }, ctx)).toBe('none')
  })

  test("the project's threshold decides what is negative", () => {
    const recent = daysBefore(1)
    const strict = { baseline: false, now: NOW, negativeMaxStars: 2 }
    expect(reviewAlertState({ starRating: 2, updateTime: recent }, strict)).toBe('pending')
    expect(reviewAlertState({ starRating: 3, updateTime: recent }, strict)).toBe('none')
    const wide = { baseline: false, now: NOW, negativeMaxStars: 4 }
    expect(reviewAlertState({ starRating: 4, updateTime: recent }, wide)).toBe('pending')
    expect(reviewAlertState({ starRating: 5, updateTime: recent }, wide)).toBe('none')
  })

  test('only a falling Places rating alerts, and float noise is not a fall', () => {
    expect(ratingAlertState('places', 4.6, 4.5)).toBe('pending')
    expect(ratingAlertState('places', 4.6, 4.6000000000001)).toBe('none')
    expect(ratingAlertState('places', 4.5, 4.6)).toBe('none')
    expect(ratingAlertState('places', null, 4.5)).toBe('none')
    expect(ratingAlertState('places', 4.6, null)).toBe('none')
    expect(ratingAlertState('gbp', 4.6, 4.1)).toBe('none')
  })
})

describe('fetchLocationReviews', () => {
  const loc = (n: number) => ({ accountName: 'accounts/1', locationName: `locations/${n}`, placeId: `ChIJ${n}` })

  test('a project-wide 403 is learned once and inherited by the remaining locations', async () => {
    const db = tempDb()
    listReviewsMock.mockRejectedValue(new GbpApiError('disabled', 403, 'SERVICE_DISABLED', {}))
    const ctx = context()

    const first = await fetchLocationReviews(db, 'proj', loc(1), ctx)
    const second = await fetchLocationReviews(db, 'proj', loc(2), ctx)

    expect(listReviewsMock).toHaveBeenCalledTimes(1)
    expect(ctx.gate.projectWideReason).toBe('SERVICE_DISABLED')
    expect(first.access).toEqual({ status: 'unavailable', reason: 'SERVICE_DISABLED' })
    expect(second.access).toEqual({ status: 'unavailable', reason: 'SERVICE_DISABLED' })
    // Both still get the Places fallback.
    expect(getPlaceReviewSignalsMock).toHaveBeenCalledTimes(2)
    expect(second.observations.map((o) => o.origin)).toEqual(['places'])
  })

  test('a per-location 403 does not stop the other locations from trying v4', async () => {
    const db = tempDb()
    listReviewsMock.mockRejectedValueOnce(new GbpApiError('denied', 403, null, {}))
    listReviewsMock.mockResolvedValueOnce({ reviews: [], averageRating: null, totalReviewCount: 0, stoppedEarly: false })
    const ctx = context()

    const first = await fetchLocationReviews(db, 'proj', loc(1), ctx)
    const second = await fetchLocationReviews(db, 'proj', loc(2), ctx)

    expect(ctx.gate.projectWideReason).toBeNull()
    expect(first.access).toEqual({ status: 'unavailable', reason: 'PERMISSION_DENIED' })
    expect(second.access).toEqual({ status: 'ok', reason: null })
    expect(second.observations.map((o) => o.origin)).toEqual(['gbp'])
    expect(getPlaceReviewSignalsMock).toHaveBeenCalledTimes(1)
  })

  test('a transient v4 error where v4 has worked skips the Places fallback, so no review is sent twice', async () => {
    const db = tempDb()
    seedRating(db, 'locations/1', 'gbp', daysBefore(1))
    listReviewsMock.mockRejectedValue(new GbpApiError('Backend Error', 503, null, {}))
    const result = await fetchLocationReviews(db, 'proj', loc(1), context())
    expect(result).toEqual({ access: { status: 'error', reason: 'HTTP_503' }, observations: [] })
    expect(getPlaceReviewSignalsMock).not.toHaveBeenCalled()
  })

  test('a transient v4 error where v4 never worked still uses the fallback', async () => {
    const db = tempDb()
    listReviewsMock.mockRejectedValue(new GbpApiError('Backend Error', 503, null, {}))
    const result = await fetchLocationReviews(db, 'proj', loc(1), context())
    expect(result.observations.map((o) => o.origin)).toEqual(['places'])
  })

  test('the Places fallback runs at most once per location per 20 hours', async () => {
    const db = tempDb()
    listReviewsMock.mockRejectedValue(new GbpApiError('disabled', 403, 'SERVICE_DISABLED', {}))
    const hoursBefore = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()

    seedRating(db, 'locations/1', 'places', hoursBefore(19))
    const recent = await fetchLocationReviews(db, 'proj', loc(1), context())
    expect(getPlaceReviewSignalsMock).not.toHaveBeenCalled()
    expect(recent).toEqual({ access: { status: 'unavailable', reason: 'SERVICE_DISABLED' }, observations: [] })

    db.update(gbpReviewRatings).set({ observedAt: hoursBefore(20) }).run()
    const due = await fetchLocationReviews(db, 'proj', loc(1), context())
    expect(getPlaceReviewSignalsMock).toHaveBeenCalledTimes(1)
    expect(due.observations.map((o) => o.origin)).toEqual(['places'])
  })

  test('a Places failure is swallowed and leaves only the access result', async () => {
    const db = tempDb()
    listReviewsMock.mockRejectedValue(new GbpApiError('disabled', 403, 'SERVICE_DISABLED', {}))
    getPlaceReviewSignalsMock.mockRejectedValue(new Error('PERMISSION_DENIED'))
    const result = await fetchLocationReviews(db, 'proj', loc(1), context())
    expect(result).toEqual({ access: { status: 'unavailable', reason: 'SERVICE_DISABLED' }, observations: [] })
  })
})

describe('persistReviewObservation', () => {
  test('a review Google repeats across pages is stored once', () => {
    const db = tempDb()
    const review = {
      reviewName: 'accounts/1/locations/1/reviews/dup', starRating: 2, comment: 'x', reviewerName: null,
      createTime: daysBefore(1), updateTime: daysBefore(1), replyComment: null, replyUpdateTime: null, reviewUri: null,
    }
    const result = persistReviewObservation(db, 'proj', 'run_1', {
      locationName: 'locations/1', origin: 'gbp', rating: 2, reviewCount: 1, reviews: [review, { ...review, comment: 'older copy' }],
    }, { now: NOW, negativeMaxStars: 3 })
    expect(result).toEqual({ baseline: true, inserted: 1, queuedReviews: 0, queuedRatingDrop: false })
    const rows = db.select().from(gbpReviews).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.comment).toBe('x')
  })
})
