import crypto from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { gbpReviewRatings, gbpReviews } from '@ainyc/canonry-db'
import { businessProfileReviewsCover, describeError, isNegativeReviewRating } from '@ainyc/canonry-contracts'
import type { GbpReviewAlertState, GbpReviewOrigin, GbpReviewsAccess } from '@ainyc/canonry-contracts'
import { classifyReviewsError, listReviews } from '@ainyc/canonry-integration-google-business-profile'
import { getPlaceReviewSignals } from '@ainyc/canonry-integration-google-places'
import type { PlacesTierConfig } from './places-config.js'
import { createLogger } from './logger.js'

const log = createLogger('GbpReviews')

const MS_PER_DAY = 86_400_000

/**
 * A negative review only alerts while it is this recent. The Places listing
 * picks its five reviews by relevance, so an old review can appear there for
 * the first time long after it was posted; without this window it would read
 * as new. The dispatcher also uses it to expire alerts whose delivery kept
 * failing, so a broken webhook does not replay a month of reviews on repair.
 */
export const REVIEW_ALERT_MAX_AGE_DAYS = 30

/**
 * v4 paging stops once it passes the newest stored review, minus this overlap.
 * A review can become visible to the API after a newer one was already stored;
 * the overlap re-reads that stretch so such a review is still seen.
 */
const REVIEW_PAGING_OVERLAP_DAYS = 7

/**
 * The Places fallback runs at most once per location in this window, however
 * often GBP syncs run. It bills the Enterprise + Atmosphere SKU and
 * `atmosphere` is the default tier, so without a cap an install with a key and
 * a frequent schedule would start spending on upgrade. Twenty hours rather
 * than 24 keeps a daily schedule from skipping a day when one sync runs long.
 */
export const PLACES_REVIEW_MIN_INTERVAL_HOURS = 20

// Slack for comparing Places' one-decimal ratings stored as REAL.
const RATING_EPSILON = 1e-9

export function isWithinAlertWindow(timestamp: string, now: Date): boolean {
  const ms = Date.parse(timestamp)
  return Number.isFinite(ms) && now.getTime() - ms <= REVIEW_ALERT_MAX_AGE_DAYS * MS_PER_DAY
}

/**
 * Alert state for a review seen for the first time, or whose rating or text
 * changed since it was last seen. A location's first observation is the
 * baseline: its reviews are recorded and never sent, so connecting a listing
 * does not replay its history. `negativeMaxStars` is the project's threshold.
 */
export function reviewAlertState(
  review: { starRating: number | null; updateTime: string },
  ctx: { baseline: boolean; now: Date; negativeMaxStars: number },
): GbpReviewAlertState {
  if (ctx.baseline) return 'baseline'
  if (!isNegativeReviewRating(review.starRating, ctx.negativeMaxStars)) return 'none'
  return isWithinAlertWindow(review.updateTime, ctx.now) ? 'pending' : 'stale'
}

/**
 * Alert state for a rating that changed. Only the Places origin alerts: with
 * Business Profile access every review is alerted on individually, so a
 * falling v4 average would repeat news already sent.
 */
export function ratingAlertState(
  origin: GbpReviewOrigin,
  previous: number | null,
  current: number | null,
): GbpReviewAlertState {
  if (origin !== 'places' || previous === null || current === null) return 'none'
  return current < previous - RATING_EPSILON ? 'pending' : 'none'
}

/** One review as fetched, in the shape both origins normalize to. */
export interface ObservedReview {
  reviewName: string
  starRating: number | null
  comment: string | null
  reviewerName: string | null
  createTime: string | null
  updateTime: string
  replyComment: string | null
  replyUpdateTime: string | null
  reviewUri: string | null
}

/** Everything one origin said about one location on this sync. */
export interface ReviewObservation {
  locationName: string
  origin: GbpReviewOrigin
  rating: number | null
  reviewCount: number | null
  reviews: ObservedReview[]
}

export interface LocationReviewFetch {
  /** Business Profile v4 access for the location on this sync. */
  access: { status: GbpReviewsAccess; reason: string | null }
  observations: ReviewObservation[]
}

export interface ReviewFetchContext {
  runId: string
  /** The sync's clock, for the Places cadence gate. */
  now: Date
  accessToken: string
  places: { apiKey?: string; tier: PlacesTierConfig }
  /**
   * Shared by every location in a run. Once one location learns that v4 is
   * off for the whole Cloud project, the rest skip the call and inherit the
   * reason instead of each spending a request on the same 403.
   */
  gate: { projectWideReason: string | null }
}

type ReadDb = Pick<DatabaseClient, 'select'>

function hasBaseline(db: ReadDb, projectId: string, locationName: string, origin: GbpReviewOrigin): boolean {
  return db.select({ id: gbpReviewRatings.id }).from(gbpReviewRatings)
    .where(and(
      eq(gbpReviewRatings.projectId, projectId),
      eq(gbpReviewRatings.locationName, locationName),
      eq(gbpReviewRatings.origin, origin),
    ))
    .limit(1)
    .get() !== undefined
}

function placesReviewsDue(db: ReadDb, projectId: string, locationName: string, now: Date): boolean {
  const latest = db.select({ observedAt: gbpReviewRatings.observedAt }).from(gbpReviewRatings)
    .where(and(
      eq(gbpReviewRatings.projectId, projectId),
      eq(gbpReviewRatings.locationName, locationName),
      eq(gbpReviewRatings.origin, 'places'),
    ))
    .orderBy(desc(gbpReviewRatings.observedAt))
    .limit(1)
    .get()
  if (!latest) return true
  return now.getTime() - Date.parse(latest.observedAt) >= PLACES_REVIEW_MIN_INTERVAL_HOURS * 3_600_000
}

function newestStoredUpdateTime(db: ReadDb, projectId: string, locationName: string, origin: GbpReviewOrigin): string | null {
  const row = db.select({ newest: sql<string | null>`max(${gbpReviews.updateTime})` }).from(gbpReviews)
    .where(and(
      eq(gbpReviews.projectId, projectId),
      eq(gbpReviews.locationName, locationName),
      eq(gbpReviews.origin, origin),
    ))
    .get()
  return row?.newest ?? null
}

/**
 * Fetch one location's reviews: Business Profile v4 when Google has granted
 * access, otherwise the public Places listing on the `atmosphere` tier, at
 * most once a day per location. Never throws; a failure on either source is
 * logged and leaves the rest of the location's sync untouched.
 */
export async function fetchLocationReviews(
  db: ReadDb,
  projectId: string,
  loc: { accountName: string; locationName: string; placeId: string | null },
  ctx: ReviewFetchContext,
): Promise<LocationReviewFetch> {
  const observations: ReviewObservation[] = []
  let access: LocationReviewFetch['access']
  const v4HasWorked = hasBaseline(db, projectId, loc.locationName, 'gbp')

  if (ctx.gate.projectWideReason) {
    access = { status: 'unavailable', reason: ctx.gate.projectWideReason }
  } else {
    // Before a baseline exists every page is read, so the baseline is complete.
    const newest = v4HasWorked
      ? newestStoredUpdateTime(db, projectId, loc.locationName, 'gbp')
      : null
    const stopBefore = newest
      ? new Date(Date.parse(newest) - REVIEW_PAGING_OVERLAP_DAYS * MS_PER_DAY).toISOString()
      : null
    try {
      const listing = await listReviews(ctx.accessToken, loc.accountName, loc.locationName, { stopBefore })
      access = { status: 'ok', reason: null }
      observations.push({
        locationName: loc.locationName,
        origin: 'gbp',
        rating: listing.averageRating,
        reviewCount: listing.totalReviewCount,
        reviews: listing.reviews.map((r) => ({ ...r, reviewUri: null })),
      })
    } catch (err) {
      const classified = classifyReviewsError(err)
      access = { status: classified.access, reason: classified.reason }
      if (classified.projectWide) {
        if (!ctx.gate.projectWideReason) {
          ctx.gate.projectWideReason = classified.reason
          log.info('reviews.unavailable', { runId: ctx.runId, reason: classified.reason })
        }
      } else if (classified.access === 'error') {
        log.warn('reviews.failed', { runId: ctx.runId, location: loc.locationName, error: describeError(err) })
      } else {
        log.info('reviews.location-unavailable', { runId: ctx.runId, location: loc.locationName, reason: classified.reason })
      }
    }
  }

  // The Places fallback bills the Enterprise + Atmosphere SKU, so it runs only
  // on the tier the operator already chose to pay for, once a day at most, and
  // stops by itself as soon as Business Profile reviews cover the location.
  const placesKey = ctx.places.apiKey
  if (
    placesKey
    && loc.placeId
    && ctx.places.tier === 'atmosphere'
    && !businessProfileReviewsCover(access.status, v4HasWorked)
    && placesReviewsDue(db, projectId, loc.locationName, ctx.now)
  ) {
    try {
      const signals = await getPlaceReviewSignals(loc.placeId, placesKey)
      observations.push({
        locationName: loc.locationName,
        origin: 'places',
        rating: signals.rating,
        reviewCount: signals.userRatingCount,
        reviews: signals.reviews.map((r) => ({
          reviewName: r.reviewName,
          starRating: r.starRating,
          comment: r.comment,
          reviewerName: r.reviewerName,
          createTime: r.publishTime,
          updateTime: r.publishTime,
          replyComment: null,
          replyUpdateTime: null,
          reviewUri: r.googleMapsUri,
        })),
      })
    } catch (err) {
      log.warn('places-reviews.failed', { runId: ctx.runId, location: loc.locationName, error: describeError(err) })
    }
  }

  return { access, observations }
}

export interface PersistedReviewObservation {
  /** True when this was the location's first observation for the origin. */
  baseline: boolean
  inserted: number
  /** Negative reviews queued for `review.negative` on this sync. */
  queuedReviews: number
  /** Whether a rating drop was queued for `review.rating-dropped`. */
  queuedRatingDrop: boolean
}

// Lookups by review name are chunked to stay far below SQLite's bound-parameter limit.
const LOOKUP_CHUNK = 500

/**
 * Store one origin's observation of one location and queue its alerts.
 * Synchronous so it runs inside the sync's per-location transaction.
 *
 *   - rating: snapshot on change, re-stamp otherwise. The first row is the
 *     baseline marker; with no row, every review below is `baseline`.
 *   - new review: stored with a fresh alert state.
 *   - known review whose rating or text changed: fields updated and the alert
 *     state recomputed, so a review edited down to 2 stars alerts, while one
 *     whose only change is a new timestamp or an owner reply does not.
 *   - known review otherwise: refreshed in place, alert state kept.
 */
export function persistReviewObservation(
  tx: Pick<DatabaseClient, 'select' | 'insert' | 'update'>,
  projectId: string,
  runId: string,
  obs: ReviewObservation,
  ctx: { now: Date; negativeMaxStars: number },
): PersistedReviewObservation {
  const { now, negativeMaxStars } = ctx
  const nowIso = now.toISOString()
  const latestRating = tx.select().from(gbpReviewRatings)
    .where(and(
      eq(gbpReviewRatings.projectId, projectId),
      eq(gbpReviewRatings.locationName, obs.locationName),
      eq(gbpReviewRatings.origin, obs.origin),
    ))
    .orderBy(desc(gbpReviewRatings.observedAt))
    .limit(1)
    .get()
  const baseline = latestRating === undefined

  let queuedRatingDrop = false
  if (!latestRating) {
    tx.insert(gbpReviewRatings).values({
      id: crypto.randomUUID(),
      projectId,
      locationName: obs.locationName,
      origin: obs.origin,
      rating: obs.rating,
      reviewCount: obs.reviewCount,
      previousRating: null,
      previousReviewCount: null,
      firstObservedAt: nowIso,
      observedAt: nowIso,
      syncRunId: runId,
      alertState: 'baseline',
      alertStateAt: nowIso,
    }).run()
  } else if (sameRating(latestRating.rating, obs.rating) && latestRating.reviewCount === obs.reviewCount) {
    tx.update(gbpReviewRatings)
      .set({ observedAt: nowIso, syncRunId: runId })
      .where(eq(gbpReviewRatings.id, latestRating.id))
      .run()
  } else {
    const alertState = ratingAlertState(obs.origin, latestRating.rating, obs.rating)
    queuedRatingDrop = alertState === 'pending'
    tx.insert(gbpReviewRatings).values({
      id: crypto.randomUUID(),
      projectId,
      locationName: obs.locationName,
      origin: obs.origin,
      rating: obs.rating,
      reviewCount: obs.reviewCount,
      previousRating: latestRating.rating,
      previousReviewCount: latestRating.reviewCount,
      firstObservedAt: nowIso,
      observedAt: nowIso,
      syncRunId: runId,
      alertState,
      alertStateAt: nowIso,
    }).run()
  }

  // Google can repeat a review across pages; the first (newest) copy wins.
  const fetched = new Map<string, ObservedReview>()
  for (const review of obs.reviews) {
    if (!fetched.has(review.reviewName)) fetched.set(review.reviewName, review)
  }
  const names = [...fetched.keys()]
  const existing = new Map<string, typeof gbpReviews.$inferSelect>()
  for (let i = 0; i < names.length; i += LOOKUP_CHUNK) {
    const rows = tx.select().from(gbpReviews)
      .where(and(
        eq(gbpReviews.projectId, projectId),
        eq(gbpReviews.origin, obs.origin),
        inArray(gbpReviews.reviewName, names.slice(i, i + LOOKUP_CHUNK)),
      ))
      .all()
    for (const row of rows) existing.set(row.reviewName, row)
  }

  let inserted = 0
  let queuedReviews = 0
  for (const review of fetched.values()) {
    const stored = existing.get(review.reviewName)
    const content = {
      locationName: obs.locationName,
      starRating: review.starRating,
      comment: review.comment,
      reviewerName: review.reviewerName,
      createTime: review.createTime,
      updateTime: review.updateTime,
      replyComment: review.replyComment,
      replyUpdateTime: review.replyUpdateTime,
      reviewUri: review.reviewUri,
      lastSeenAt: nowIso,
      syncRunId: runId,
    }
    if (!stored) {
      const alertState = reviewAlertState(review, { baseline, now, negativeMaxStars })
      if (alertState === 'pending') queuedReviews++
      tx.insert(gbpReviews).values({
        id: crypto.randomUUID(),
        projectId,
        origin: obs.origin,
        reviewName: review.reviewName,
        ...content,
        firstSeenAt: nowIso,
        alertState,
        alertStateAt: nowIso,
      }).run()
      inserted++
    } else if (stored.starRating !== review.starRating || stored.comment !== review.comment) {
      const alertState = reviewAlertState(review, { baseline, now, negativeMaxStars })
      if (alertState === 'pending') queuedReviews++
      tx.update(gbpReviews)
        .set({ ...content, alertState, alertStateAt: nowIso })
        .where(eq(gbpReviews.id, stored.id))
        .run()
    } else {
      tx.update(gbpReviews).set(content).where(eq(gbpReviews.id, stored.id)).run()
    }
  }

  return { baseline, inserted, queuedReviews, queuedRatingDrop }
}

function sameRating(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a - b) <= RATING_EPSILON
}
