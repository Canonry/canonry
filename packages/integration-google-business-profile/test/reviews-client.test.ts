import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { listReviews, classifyReviewsError, normalizeGoogleTimestamp } from '../src/reviews-client.js'
import { GbpApiError } from '../src/types.js'

// Review shapes follow the v4 reference for accounts.locations.reviews.list:
// Google gates that API per Cloud project, so no successful response has been
// captured. The SERVICE_DISABLED body mirrors the live error a gated project
// got on 2026-09-28, with the project number replaced.
function review(id: string, star: string, updateTime: string, extra: Record<string, unknown> = {}) {
  return {
    name: `accounts/111/locations/222/reviews/${id}`,
    reviewId: id,
    reviewer: { displayName: `Reviewer ${id}`, profilePhotoUrl: 'https://lh3.googleusercontent.com/a/x', isAnonymous: false },
    starRating: star,
    comment: `Comment ${id}`,
    createTime: updateTime,
    updateTime,
    ...extra,
  }
}

function ok(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}

describe('listReviews', () => {
  const fetchSpy = vi.fn()
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    fetchSpy.mockReset()
  })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('reads the v4 path through the account and maps each review', async () => {
    fetchSpy.mockResolvedValueOnce(ok({
      reviews: [
        review('r2', 'TWO', '2026-09-20T08:15:00.123456Z', {
          comment: '  Room was not cleaned.  ',
          createTime: '2026-09-19T21:00:00Z',
          reviewReply: { comment: 'Sorry to hear this.', updateTime: '2026-09-21T10:00:00Z' },
        }),
        review('r1', 'FIVE', '2026-09-10T12:00:00Z', {
          reviewer: { displayName: 'A Google User', isAnonymous: true },
          comment: '',
        }),
      ],
      averageRating: 4.4,
      totalReviewCount: 57,
    }))

    const listing = await listReviews('tok', 'accounts/111', 'locations/222')

    const url = new URL(fetchSpy.mock.calls[0]![0] as string)
    expect(url.origin + url.pathname).toBe('https://mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews')
    expect(url.searchParams.get('pageSize')).toBe('50')
    expect(url.searchParams.get('orderBy')).toBe('update_time desc')
    expect(listing).toEqual({
      averageRating: 4.4,
      totalReviewCount: 57,
      stoppedEarly: false,
      reviews: [
        {
          reviewName: 'accounts/111/locations/222/reviews/r2',
          starRating: 2,
          comment: 'Room was not cleaned.',
          reviewerName: 'Reviewer r2',
          createTime: '2026-09-19T21:00:00.000Z',
          updateTime: '2026-09-20T08:15:00.123Z',
          replyComment: 'Sorry to hear this.',
          replyUpdateTime: '2026-09-21T10:00:00.000Z',
        },
        {
          reviewName: 'accounts/111/locations/222/reviews/r1',
          starRating: 5,
          comment: null,
          reviewerName: null,
          createTime: '2026-09-10T12:00:00.000Z',
          updateTime: '2026-09-10T12:00:00.000Z',
          replyComment: null,
          replyUpdateTime: null,
        },
      ],
    })
  })

  it('treats an unspecified rating as null and drops reviews it cannot date or name', async () => {
    fetchSpy.mockResolvedValueOnce(ok({
      reviews: [
        review('r3', 'STAR_RATING_UNSPECIFIED', '2026-09-20T00:00:00Z'),
        { ...review('r4', 'ONE', '2026-09-19T00:00:00Z'), name: undefined },
        { ...review('r5', 'ONE', '2026-09-18T00:00:00Z'), createTime: undefined, updateTime: undefined },
      ],
    }))
    const listing = await listReviews('tok', 'accounts/111', 'locations/222')
    expect(listing.reviews.map((r) => [r.reviewName, r.starRating])).toEqual([
      ['accounts/111/locations/222/reviews/r3', null],
    ])
    expect(listing.averageRating).toBeNull()
    expect(listing.totalReviewCount).toBeNull()
  })

  it('reads every page when there is nothing stored yet', async () => {
    fetchSpy
      .mockResolvedValueOnce(ok({ reviews: [review('a', 'FIVE', '2026-09-20T00:00:00Z')], nextPageToken: 'p2' }))
      .mockResolvedValueOnce(ok({ reviews: [review('b', 'ONE', '2026-08-01T00:00:00Z')], nextPageToken: 'p3' }))
      .mockResolvedValueOnce(ok({ reviews: [review('c', 'FOUR', '2025-01-01T00:00:00Z')] }))
    const listing = await listReviews('tok', 'accounts/111', 'locations/222')
    expect(listing.reviews.map((r) => r.reviewName.split('/').at(-1))).toEqual(['a', 'b', 'c'])
    expect(listing.stoppedEarly).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(new URL(fetchSpy.mock.calls[1]![0] as string).searchParams.get('pageToken')).toBe('p2')
  })

  it('stops after the page that reaches the newest stored review', async () => {
    fetchSpy
      .mockResolvedValueOnce(ok({
        reviews: [review('new', 'TWO', '2026-09-22T00:00:00Z'), review('known', 'FIVE', '2026-09-01T00:00:00Z')],
        nextPageToken: 'p2',
      }))
      .mockResolvedValueOnce(ok({ reviews: [review('older', 'ONE', '2026-08-01T00:00:00Z')] }))
    const listing = await listReviews('tok', 'accounts/111', 'locations/222', { stopBefore: '2026-09-05T00:00:00.000Z' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(listing.stoppedEarly).toBe(true)
    expect(listing.reviews.map((r) => r.reviewName.split('/').at(-1))).toEqual(['new', 'known'])
  })

  it('keeps paging when a page is not newest-first, so an ignored orderBy cannot hide reviews', async () => {
    fetchSpy
      .mockResolvedValueOnce(ok({
        reviews: [review('old', 'FIVE', '2026-01-01T00:00:00Z'), review('newer', 'FIVE', '2026-02-01T00:00:00Z')],
        nextPageToken: 'p2',
      }))
      .mockResolvedValueOnce(ok({ reviews: [review('newest', 'ONE', '2026-09-22T00:00:00Z')] }))
    const listing = await listReviews('tok', 'accounts/111', 'locations/222', { stopBefore: '2026-09-01T00:00:00.000Z' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(listing.stoppedEarly).toBe(false)
    expect(listing.reviews.map((r) => r.reviewName.split('/').at(-1))).toEqual(['old', 'newer', 'newest'])
  })

  it('throws instead of returning the pages it got when a later page fails', async () => {
    fetchSpy
      .mockResolvedValueOnce(ok({ reviews: [review('a', 'ONE', '2026-09-20T00:00:00Z')], nextPageToken: 'p2' }))
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => JSON.stringify({ error: { message: 'Internal' } }) })
    await expect(listReviews('tok', 'accounts/111', 'locations/222')).rejects.toBeInstanceOf(GbpApiError)
  })

  it('surfaces the gated-API 403 as a GbpApiError carrying SERVICE_DISABLED', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({
        error: {
          code: 403,
          message: 'Google My Business API has not been used in project 123456789012 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/mybusiness.googleapis.com/overview?project=123456789012 then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.',
          status: 'PERMISSION_DENIED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'SERVICE_DISABLED',
              domain: 'googleapis.com',
              metadata: {
                consumer: 'projects/123456789012',
                activationUrl: 'https://console.developers.google.com/apis/api/mybusiness.googleapis.com/overview?project=123456789012',
                serviceTitle: 'Google My Business API',
                containerInfo: '123456789012',
                service: 'mybusiness.googleapis.com',
              },
            },
            {
              '@type': 'type.googleapis.com/google.rpc.LocalizedMessage',
              locale: 'en-US',
              message: 'Google My Business API has not been used in project 123456789012 before or it is disabled.',
            },
            {
              '@type': 'type.googleapis.com/google.rpc.Help',
              links: [{
                description: 'Google developers console API activation',
                url: 'https://console.developers.google.com/apis/api/mybusiness.googleapis.com/overview?project=123456789012',
              }],
            },
          ],
        },
      }),
    })
    const err = await listReviews('tok', 'accounts/111', 'locations/222').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GbpApiError)
    expect(classifyReviewsError(err)).toEqual({ access: 'unavailable', reason: 'SERVICE_DISABLED', projectWide: true })
  })
})

describe('classifyReviewsError', () => {
  it('reads a plain 403 as this location being unavailable, not the whole project', () => {
    expect(classifyReviewsError(new GbpApiError('denied', 403, null, {}))).toEqual({
      access: 'unavailable', reason: 'PERMISSION_DENIED', projectWide: false,
    })
  })

  it('reads a zero-quota 429 as the project-wide access gate', () => {
    expect(classifyReviewsError(new GbpApiError('quota', 429, 'RATE_LIMIT_EXCEEDED', {}, 0))).toEqual({
      access: 'unavailable', reason: 'QUOTA_ZERO', projectWide: true,
    })
  })

  it('reads a 404 as the location being unknown to v4', () => {
    expect(classifyReviewsError(new GbpApiError('nf', 404, null, {}))).toEqual({
      access: 'unavailable', reason: 'NOT_FOUND', projectWide: false,
    })
  })

  it('reads other failures as retryable errors', () => {
    expect(classifyReviewsError(new GbpApiError('boom', 500, null, {}))).toEqual({
      access: 'error', reason: 'HTTP_500', projectWide: false,
    })
    expect(classifyReviewsError(new GbpApiError('slow', 429, 'RATE_LIMIT_EXCEEDED', {}, 300))).toEqual({
      access: 'error', reason: 'RATE_LIMIT_EXCEEDED', projectWide: false,
    })
    expect(classifyReviewsError(new TypeError('fetch failed'))).toEqual({
      access: 'error', reason: 'NETWORK', projectWide: false,
    })
  })
})

describe('normalizeGoogleTimestamp', () => {
  it('normalizes every precision Google emits so string order matches time order', () => {
    const coarse = normalizeGoogleTimestamp('2026-01-15T10:20:30Z')!
    const fine = normalizeGoogleTimestamp('2026-01-15T10:20:30.5Z')!
    expect(coarse).toBe('2026-01-15T10:20:30.000Z')
    expect(fine).toBe('2026-01-15T10:20:30.500Z')
    expect(coarse < fine).toBe(true)
    expect(normalizeGoogleTimestamp('2026-01-15T10:20:30.123456789Z')).toBe('2026-01-15T10:20:30.123Z')
  })

  it('returns null for missing or unparseable values', () => {
    expect(normalizeGoogleTimestamp(undefined)).toBeNull()
    expect(normalizeGoogleTimestamp('')).toBeNull()
    expect(normalizeGoogleTimestamp('not a date')).toBeNull()
  })
})
