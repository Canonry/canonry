import { PLACES_REVIEW_SIGNAL_FIELDS } from './constants.js'
import { getPlaceDetails } from './place-details-client.js'
import type { PlaceDetails, PlaceReview, PlacesFetchOptions } from './types.js'

export interface PlaceReviewRow {
  /** "places/{placeId}/reviews/{id}", stable across fetches. */
  reviewName: string
  /** 1-5, or null when the listing omits it. */
  starRating: number | null
  /** The review in its original language, falling back to the translated text. */
  comment: string | null
  reviewerName: string | null
  /** When the review was posted. Normalized to millisecond ISO-8601 UTC. */
  publishTime: string
  /** Link to the review on Google Maps. */
  googleMapsUri: string | null
}

export interface PlaceReviewSignals {
  /** Average rating as the public listing shows it (one decimal), or null when it has none. */
  rating: number | null
  userRatingCount: number | null
  reviews: PlaceReviewRow[]
}

// Same normalization as the GBP package: Google mixes fractional-second
// precisions, which do not sort as strings until they are normalized.
function normalizeTimestamp(value: string | undefined): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function toStarRating(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  return rounded >= 1 && rounded <= 5 ? rounded : null
}

function toRow(review: PlaceReview): PlaceReviewRow | null {
  const publishTime = normalizeTimestamp(review.publishTime)
  if (!review.name || !publishTime) return null
  const comment = (review.originalText?.text ?? review.text?.text)?.trim()
  return {
    reviewName: review.name,
    starRating: toStarRating(review.rating),
    comment: comment ? comment : null,
    reviewerName: review.authorAttribution?.displayName ?? null,
    publishTime,
    googleMapsUri: review.googleMapsUri ?? null,
  }
}

/** Reduce a Place Details response to the review signals the alerting reads. */
export function toPlaceReviewSignals(place: PlaceDetails): PlaceReviewSignals {
  return {
    rating: typeof place.rating === 'number' && Number.isFinite(place.rating) ? place.rating : null,
    userRatingCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
    reviews: (place.reviews ?? []).map(toRow).filter((row): row is PlaceReviewRow => row !== null),
  }
}

/**
 * Fetch a place's public rating, review count, and listed reviews. Billed at
 * Place Details Enterprise + Atmosphere (see PLACES_REVIEW_SIGNAL_FIELDS).
 * Throws `PlacesApiError` like `getPlaceDetails`; the sync treats it as
 * best-effort.
 */
export async function getPlaceReviewSignals(
  placeId: string,
  apiKey: string,
  opts: PlacesFetchOptions = {},
): Promise<PlaceReviewSignals> {
  const place = await getPlaceDetails(placeId, apiKey, { ...opts, fieldMask: PLACES_REVIEW_SIGNAL_FIELDS.join(',') })
  return toPlaceReviewSignals(place)
}
