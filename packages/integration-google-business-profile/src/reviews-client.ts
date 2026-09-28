import { GBP_LEGACY_V4_BASE, GBP_MAX_PAGES, GBP_REVIEWS_PAGE_SIZE } from './constants.js'
import { gbpFetchGet } from './http.js'
import { GbpApiError } from './types.js'
import type { GbpFetchOptions } from './types.js'

// Shapes from the v4 reference (accounts.locations.reviews.list). Google gates
// this API separately from the v1 Business Profile APIs, so these are the
// documented shapes, not a captured response: every field is optional here and
// the mapper tolerates any of them being absent.
type V4StarRating = 'STAR_RATING_UNSPECIFIED' | 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE'

interface V4Review {
  /** "accounts/{a}/locations/{l}/reviews/{r}" */
  name?: string
  reviewId?: string
  reviewer?: { displayName?: string; profilePhotoUrl?: string; isAnonymous?: boolean }
  starRating?: V4StarRating
  comment?: string
  createTime?: string
  updateTime?: string
  reviewReply?: { comment?: string; updateTime?: string }
}

interface ListReviewsResponse {
  reviews?: V4Review[]
  averageRating?: number
  totalReviewCount?: number
  nextPageToken?: string
}

const STAR_VALUES: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }

export interface GbpReviewRow {
  /** Full resource name, stable across edits. */
  reviewName: string
  /** 1-5, or null when Google reports STAR_RATING_UNSPECIFIED. */
  starRating: number | null
  comment: string | null
  reviewerName: string | null
  createTime: string | null
  /** Last edit by the reviewer. Normalized to millisecond ISO-8601 UTC. */
  updateTime: string
  replyComment: string | null
  replyUpdateTime: string | null
}

export interface GbpReviewListing {
  /** Newest first, as Google returned them. */
  reviews: GbpReviewRow[]
  averageRating: number | null
  totalReviewCount: number | null
  /** True when paging stopped at `stopBefore` instead of the last page. */
  stoppedEarly: boolean
}

export interface ListReviewsOptions extends GbpFetchOptions {
  /**
   * ISO timestamp of the newest review already stored. Paging stops after the
   * first page that reaches a review updated before it, since the list is
   * sorted by update time and everything further back is already known. Omit
   * to fetch every page (the first sync of a location).
   */
  stopBefore?: string | null
}

/**
 * Google returns RFC 3339 timestamps with anywhere from 0 to 9 fractional
 * digits, and those do not sort correctly as strings ("...30Z" sorts after
 * "...30.5Z"). Normalizing to millisecond ISO at the boundary makes every
 * later comparison, including SQL ORDER BY, a plain string comparison.
 */
export function normalizeGoogleTimestamp(value: string | null | undefined): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function toRow(review: V4Review): GbpReviewRow | null {
  const updateTime = normalizeGoogleTimestamp(review.updateTime) ?? normalizeGoogleTimestamp(review.createTime)
  // A review with no name or no timestamp cannot be tracked or dated, so it
  // cannot be alerted on either. The documented resource always has both.
  if (!review.name || !updateTime) return null
  const comment = review.comment?.trim()
  const reply = review.reviewReply
  return {
    reviewName: review.name,
    starRating: review.starRating ? STAR_VALUES[review.starRating] ?? null : null,
    comment: comment ? comment : null,
    reviewerName: review.reviewer?.isAnonymous ? null : review.reviewer?.displayName ?? null,
    createTime: normalizeGoogleTimestamp(review.createTime),
    updateTime,
    replyComment: reply?.comment?.trim() ? reply.comment.trim() : null,
    replyUpdateTime: normalizeGoogleTimestamp(reply?.updateTime),
  }
}

function isNewestFirst(rows: GbpReviewRow[]): boolean {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.updateTime > rows[i - 1]!.updateTime) return false
  }
  return true
}

/**
 * List a location's reviews from the legacy v4 host, newest update first.
 *
 * `accountName` is "accounts/{n}" and `locationName` is "locations/{n}", as
 * stored on `gbp_locations`; v4 addresses a location through its account.
 * Throws `GbpApiError` on failure; callers use {@link classifyReviewsError} to
 * tell the access gate apart from a transient failure. The listing is
 * all-or-nothing: a failure on any page throws, so a caller never stores a
 * partial page run and then skips past the reviews it did not receive.
 */
export async function listReviews(
  accessToken: string,
  accountName: string,
  locationName: string,
  opts: ListReviewsOptions = {},
): Promise<GbpReviewListing> {
  const reviews: GbpReviewRow[] = []
  let averageRating: number | null = null
  let totalReviewCount: number | null = null
  let stoppedEarly = false
  let pageToken: string | undefined
  let page = 0
  do {
    const url = new URL(`${GBP_LEGACY_V4_BASE}/${accountName}/${locationName}/reviews`)
    url.searchParams.set('pageSize', String(GBP_REVIEWS_PAGE_SIZE))
    // Documented default, set explicitly because early stop depends on it.
    url.searchParams.set('orderBy', 'update_time desc')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await gbpFetchGet<ListReviewsResponse>(url.toString(), accessToken, opts)
    if (page === 0) {
      averageRating = typeof res.averageRating === 'number' ? res.averageRating : null
      totalReviewCount = typeof res.totalReviewCount === 'number' ? res.totalReviewCount : null
    }
    const rows = (res.reviews ?? []).map(toRow).filter((row): row is GbpReviewRow => row !== null)
    reviews.push(...rows)
    pageToken = res.nextPageToken
    page++
    // Only trust the stop when the page really is newest-first. If Google ever
    // ignores `orderBy`, reading every page is slower but still complete.
    const oldest = rows.at(-1)
    if (pageToken && opts.stopBefore && oldest && isNewestFirst(rows) && oldest.updateTime < opts.stopBefore) {
      stoppedEarly = true
      break
    }
  } while (pageToken && page < GBP_MAX_PAGES)
  return { reviews, averageRating, totalReviewCount, stoppedEarly }
}

export type GbpReviewsAccess = 'ok' | 'unavailable' | 'error'

export interface GbpReviewsErrorClass {
  /** `unavailable`: Google has not granted access, retrying cannot help. `error`: anything else. */
  access: Exclude<GbpReviewsAccess, 'ok'>
  /** Stable short reason for storage and display, e.g. "SERVICE_DISABLED". */
  reason: string
  /** True when the cause applies to the whole Google Cloud project, not one location. */
  projectWide: boolean
}

/**
 * Classify a failed reviews call.
 *
 *   - 403 SERVICE_DISABLED / API_DISABLED: the legacy API is not enabled for
 *     the Cloud project. Google enables it only after a separate access
 *     request, so this is the normal state for most installs.
 *   - 403 otherwise: the signed-in user cannot read this location's reviews.
 *   - 429 with a zero quota: the access-form gate on the project.
 *   - 404: v4 does not know the location (for example, unverified).
 *   - anything else: transient or unexpected; the next sync retries.
 */
export function classifyReviewsError(err: unknown): GbpReviewsErrorClass {
  if (err instanceof GbpApiError) {
    if (err.status === 403) {
      const reason = err.reason ?? 'PERMISSION_DENIED'
      const projectWide = reason === 'SERVICE_DISABLED' || reason === 'API_DISABLED'
      return { access: 'unavailable', reason, projectWide }
    }
    if (err.status === 429 && err.quotaLimitValue === 0) {
      return { access: 'unavailable', reason: 'QUOTA_ZERO', projectWide: true }
    }
    if (err.status === 404) {
      return { access: 'unavailable', reason: 'NOT_FOUND', projectWide: false }
    }
    return { access: 'error', reason: err.reason ?? `HTTP_${err.status}`, projectWide: false }
  }
  return { access: 'error', reason: 'NETWORK', projectWide: false }
}
