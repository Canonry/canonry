import { describe, it, beforeEach, expect, vi } from 'vitest'
import type { GbpReviewListResponse } from '@ainyc/canonry-contracts'

// Pure output tests: the API client is mocked, so these pin what `canonry gbp
// reviews` prints and which filters it forwards.
const mocks = { listGbpReviews: vi.fn() }

vi.mock('../src/client.js', () => ({
  createApiClient: () => mocks,
}))

import { gbpReviews } from '../src/commands/gbp.js'

async function capture(fn: () => Promise<void>): Promise<string> {
  let out = ''
  const orig = console.log
  console.log = (msg?: unknown) => { out += `${String(msg)}\n` }
  try {
    await fn()
  } finally {
    console.log = orig
  }
  return out
}

const RESPONSE: GbpReviewListResponse = {
  locations: [
    {
      locationName: 'locations/1', displayName: 'Harborline Bayport', reviewsAccess: 'ok', reviewsAccessReason: null,
      reviewsCheckedAt: '2026-09-26T06:00:00.000Z', rating: 4.357142857, reviewCount: 14, ratingOrigin: 'gbp', ratingObservedAt: '2026-09-26T06:00:00.000Z',
    },
    {
      locationName: 'locations/2', displayName: 'Harborline Anchor', reviewsAccess: 'unavailable', reviewsAccessReason: 'SERVICE_DISABLED',
      reviewsCheckedAt: '2026-09-26T06:00:00.000Z', rating: 4.5, reviewCount: 212, ratingOrigin: 'places', ratingObservedAt: '2026-09-26T06:00:00.000Z',
    },
  ],
  reviews: [
    {
      locationName: 'locations/2', origin: 'places', reviewName: 'places/ChIJ2/reviews/a', starRating: 2, negative: true,
      comment: 'The room was not ready at check-in.', reviewerName: 'Sam Rivera', createTime: '2026-09-25T18:03:11.482Z',
      updateTime: '2026-09-25T18:03:11.482Z', replied: null, replyComment: null, replyUpdateTime: null,
      reviewUri: 'https://www.google.com/maps/reviews/a', firstSeenAt: '2026-09-26T06:00:00.000Z', lastSeenAt: '2026-09-26T06:00:00.000Z',
      alertState: 'sent', alertStateAt: '2026-09-26T06:00:01.000Z',
    },
  ],
  total: 3,
}

beforeEach(() => {
  mocks.listGbpReviews.mockReset()
  mocks.listGbpReviews.mockResolvedValue(RESPONSE)
})

describe('canonry gbp reviews', () => {
  it('prints the API response verbatim for json and jsonl', async () => {
    for (const format of ['json', 'jsonl']) {
      const out = await capture(() => gbpReviews('harborline', { format }))
      expect(JSON.parse(out)).toEqual(RESPONSE)
    }
  })

  it('forwards the location, negative, and limit filters', async () => {
    await capture(() => gbpReviews('harborline', { location: 'locations/2', negative: true, limit: 5, format: 'json' }))
    expect(mocks.listGbpReviews).toHaveBeenCalledWith('harborline', { locationName: 'locations/2', negative: true, limit: 5 })
    await capture(() => gbpReviews('harborline', { format: 'json' }))
    expect(mocks.listGbpReviews).toHaveBeenLastCalledWith('harborline', { locationName: undefined })
  })

  it('renders each location\'s source and the newest reviews', async () => {
    const out = await capture(() => gbpReviews('harborline', { negative: true }))
    expect(out).toContain('Harborline Bayport  locations/1\n  4.36 from 14 reviews (Business Profile); every review')
    expect(out).toContain('Harborline Anchor  locations/2\n  4.5 from 212 reviews (public listing); Business Profile reviews unavailable (SERVICE_DISABLED)')
    expect(out).toContain('3 negative review(s), newest 1 shown:')
    expect(out).toContain('  2026-09-25  2★  Harborline Anchor  Sam Rivera  "The room was not ready at check-in."  [places, sent]')
  })

  it('points at a sync when nothing is stored', async () => {
    mocks.listGbpReviews.mockResolvedValue({ locations: [], reviews: [], total: 0 })
    expect(await capture(() => gbpReviews('harborline', {}))).toBe('No reviews yet. Run "canonry gbp sync" first.\n')
  })
})
