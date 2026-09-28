import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getPlaceReviewSignals, toPlaceReviewSignals } from '../src/review-signals.js'
import { PLACES_ATMOSPHERE_FIELDS, PLACES_PRO_FIELDS, PLACES_REVIEW_SIGNAL_FIELDS } from '../src/constants.js'

// The first review mirrors a live Place Details response for the
// `id,rating,userRatingCount,reviews` mask (captured 2026-09-28 on a hotel
// listing), field for field, with identifiers, names and text replaced. Google
// sends `publishTime` with nanosecond precision and sends both `text` and
// `originalText` even when they match. The translated, rating-only and
// undatable cases below come from the reference, not the capture.
const place = {
  id: 'ChIJexample',
  rating: 4.4,
  userRatingCount: 212,
  reviews: [
    {
      name: 'places/ChIJexample/reviews/ChdDSUhNMG9nS0VJQ0FnTURBZXhhbXBsZRAB',
      relativePublishTimeDescription: '2 days ago',
      rating: 2,
      text: { text: 'The room was not ready at check-in.', languageCode: 'en' },
      originalText: { text: 'The room was not ready at check-in.', languageCode: 'en' },
      authorAttribution: {
        displayName: 'Sam Rivera',
        uri: 'https://www.google.com/maps/contrib/100000000000000000001/reviews',
        photoUri: 'https://lh3.googleusercontent.com/a-/ALV-UjExample=s128-c0x00000000-cc-rp-mo',
      },
      publishTime: '2026-09-24T18:03:11.482922501Z',
      flagContentUri: 'https://www.google.com/local/review/rap/report?postId=ChdDSUhNMG9nS0VJQ0FnTURBZXhhbXBsZRAB&d=17924085&t=1',
      googleMapsUri: 'https://www.google.com/maps/reviews/data=!4m6!14m5!1m4!2m3!1sChdDSUhNMG9nS0VJQ0FnTURBZXhhbXBsZRAB!2m1!1s0x0:0x1234567890abcdef',
    },
    {
      name: 'places/ChIJexample/reviews/ChZdef',
      relativePublishTimeDescription: 'a month ago',
      rating: 5,
      text: { text: 'Great stay.', languageCode: 'en' },
      originalText: { text: 'Excelente estancia.', languageCode: 'es' },
      authorAttribution: { displayName: 'Ana' },
      publishTime: '2026-08-20T10:00:00Z',
    },
    // Rating-only review: no text at all.
    { name: 'places/ChIJexample/reviews/ChZghi', rating: 1, publishTime: '2026-09-01T00:00:00Z' },
    // Undatable: dropped.
    { name: 'places/ChIJexample/reviews/ChZjkl', rating: 1 },
  ],
}

describe('toPlaceReviewSignals', () => {
  it('keeps the rating, the count, and every dated review', () => {
    expect(toPlaceReviewSignals(place)).toEqual({
      rating: 4.4,
      userRatingCount: 212,
      reviews: [
        {
          reviewName: 'places/ChIJexample/reviews/ChdDSUhNMG9nS0VJQ0FnTURBZXhhbXBsZRAB',
          starRating: 2,
          comment: 'The room was not ready at check-in.',
          reviewerName: 'Sam Rivera',
          publishTime: '2026-09-24T18:03:11.482Z',
          googleMapsUri: 'https://www.google.com/maps/reviews/data=!4m6!14m5!1m4!2m3!1sChdDSUhNMG9nS0VJQ0FnTURBZXhhbXBsZRAB!2m1!1s0x0:0x1234567890abcdef',
        },
        {
          reviewName: 'places/ChIJexample/reviews/ChZdef',
          starRating: 5,
          comment: 'Excelente estancia.',
          reviewerName: 'Ana',
          publishTime: '2026-08-20T10:00:00.000Z',
          googleMapsUri: null,
        },
        {
          reviewName: 'places/ChIJexample/reviews/ChZghi',
          starRating: 1,
          comment: null,
          reviewerName: null,
          publishTime: '2026-09-01T00:00:00.000Z',
          googleMapsUri: null,
        },
      ],
    })
  })

  it('reads a listing with no reviews as null rating and an empty list', () => {
    expect(toPlaceReviewSignals({ id: 'ChIJnew' })).toEqual({ rating: null, userRatingCount: null, reviews: [] })
  })
})

describe('getPlaceReviewSignals', () => {
  const fetchSpy = vi.fn()
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    fetchSpy.mockReset()
  })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('asks only for the review fields, never the amenity snapshot', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(place) })
    const signals = await getPlaceReviewSignals('ChIJexample', 'KEY')
    const headers = fetchSpy.mock.calls[0]![1].headers as Record<string, string>
    expect(headers['X-Goog-FieldMask']).toBe('id,rating,userRatingCount,reviews')
    expect(signals.userRatingCount).toBe(212)
  })
})

describe('field masks', () => {
  it('keeps review fields out of the amenity tiers so their SKU and snapshot hash do not change', () => {
    for (const field of ['rating', 'userRatingCount', 'reviews']) {
      expect(PLACES_PRO_FIELDS as readonly string[]).not.toContain(field)
      expect(PLACES_ATMOSPHERE_FIELDS as readonly string[]).not.toContain(field)
      expect(PLACES_REVIEW_SIGNAL_FIELDS as readonly string[]).toContain(field)
    }
  })
})
