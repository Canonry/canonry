import { and, eq } from 'drizzle-orm'
import { gbpLocations, gbpReviewRatings, notifications } from '@ainyc/canonry-db'
import { CheckCategories, CheckScopes, CheckStatuses, businessProfileReviewsCover } from '@ainyc/canonry-contracts'
import type { CheckDefinition, CheckOutput, DoctorContext } from '../types.js'

const REVIEW_EVENTS = new Set(['review.negative', 'review.rating-dropped'])

const V4_ACCESS_REMEDIATION = 'Business Profile reviews use the legacy My Business API (mybusiness.googleapis.com), which Google enables per Cloud project only on request; the API Library and `gcloud services enable` cannot turn it on. Open the enable link in the API access approval email as the approved account, or reply to the access-request thread asking Google to enable mybusiness.googleapis.com for your project number, then run `canonry gbp sync`.'

type Coverage = 'full' | 'partial' | 'none'

/**
 * `gbp.reviews.access` — can negative-review alerts fire for this project, and
 * how completely? Reads what the last GBP sync stored; makes no Google call.
 *
 * Coverage per selected location:
 *   - full: Business Profile v4 reviews work, so every review is seen. A
 *     transient v4 error on a location that has worked before still counts:
 *     the next sync pages back past it, so alerts are delayed, not lost.
 *   - partial: no v4 access, but the Places fallback runs (atmosphere tier,
 *     API key, location on Maps): five reviews by relevance, plus the rating.
 *   - none: neither.
 *
 * Doctor results feed the health webhook, which reaches every enabled webhook
 * on the project. Missing v4 access is the normal state for most installs, so
 * it reports `skipped`, not `warn`. The check warns only when the project
 * subscribed to a review event and a location has no source at all, because
 * then the alerts someone asked for cannot fire.
 */
const reviewsAccessCheck: CheckDefinition = {
  id: 'gbp.reviews.access',
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'Google Business Profile review alerts',
  run: (ctx: DoctorContext): CheckOutput => {
    if (!ctx.project) {
      return { status: CheckStatuses.skipped, code: 'gbp.reviews.no-project', summary: 'Project context required.', remediation: null }
    }
    const project = ctx.project

    const conn = ctx.googleConnectionStore?.getConnection(project.canonicalDomain, 'gbp')
    if (!conn) {
      return {
        status: CheckStatuses.skipped,
        code: 'gbp.reviews.no-gbp-connection',
        summary: 'No Google Business Profile connection; review alerts do not apply.',
        remediation: `Connect GBP first: \`canonry gbp connect ${project.name}\`.`,
      }
    }

    const locations = ctx.db.select({
      locationName: gbpLocations.locationName,
      placeId: gbpLocations.placeId,
      reviewsAccess: gbpLocations.reviewsAccess,
      reviewsAccessReason: gbpLocations.reviewsAccessReason,
      reviewsCheckedAt: gbpLocations.reviewsCheckedAt,
    }).from(gbpLocations)
      .where(and(eq(gbpLocations.projectId, project.id), eq(gbpLocations.selected, true)))
      .all()
    if (locations.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'gbp.reviews.no-locations',
        summary: 'No selected GBP locations.',
        remediation: `Discover and select locations: \`canonry gbp locations discover ${project.name}\`.`,
      }
    }
    if (!locations.some((loc) => loc.reviewsCheckedAt)) {
      return {
        status: CheckStatuses.skipped,
        code: 'gbp.reviews.not-checked',
        summary: 'Review access has not been checked yet.',
        remediation: `Run \`canonry gbp sync ${project.name}\`.`,
      }
    }

    const places = ctx.getPlacesConfig?.()
    const placesFallback = places !== undefined && places.tier === 'atmosphere' && Boolean(places.apiKey)
    const v4Worked = new Set(
      ctx.db.select({ locationName: gbpReviewRatings.locationName }).from(gbpReviewRatings)
        .where(and(eq(gbpReviewRatings.projectId, project.id), eq(gbpReviewRatings.origin, 'gbp')))
        .all()
        .map((row) => row.locationName),
    )
    const coverageOf = (loc: typeof locations[number]): Coverage => {
      if (businessProfileReviewsCover(loc.reviewsAccess ?? null, v4Worked.has(loc.locationName))) return 'full'
      return placesFallback && loc.placeId ? 'partial' : 'none'
    }
    const perLocation = locations.map((loc) => ({
      locationName: loc.locationName,
      reviewsAccess: loc.reviewsAccess,
      reason: loc.reviewsAccessReason,
      coverage: coverageOf(loc),
    }))
    const count = (coverage: Coverage) => perLocation.filter((loc) => loc.coverage === coverage).length
    const full = count('full')
    const partial = count('partial')
    const none = count('none')
    const details = { placesFallback, full, partial, none, locations: perLocation }

    if (full === locations.length) {
      return {
        status: CheckStatuses.ok,
        code: 'gbp.reviews.full',
        summary: `Business Profile reviews are synced for ${full} location(s); negative-review alerts see every review.`,
        remediation: null,
        details,
      }
    }

    const reasons = [...new Set(perLocation.filter((loc) => loc.coverage !== 'full' && loc.reason).map((loc) => loc.reason!))]
    const why = reasons.length > 0 ? ` (${reasons.join(', ')})` : ''
    const parts = [
      full > 0 ? `${full} location(s) have full coverage` : null,
      partial > 0 ? `${partial} use the public Places listing instead, which shows at most five reviews plus the rating` : null,
      none > 0 ? `${none} have no review source` : null,
    ].filter((part): part is string => part !== null)
    const summary = `Business Profile reviews are not available${why}. ${parts.join('; ')}.`

    const subscribed = ctx.db.select({ config: notifications.config, enabled: notifications.enabled }).from(notifications)
      .where(eq(notifications.projectId, project.id))
      .all()
      .some((n) => n.enabled && (n.config.events ?? []).some((event) => REVIEW_EVENTS.has(event)))
    const placesHint = placesFallback
      ? ''
      : ' For partial coverage meanwhile, set a Places API key (`GOOGLE_PLACES_API_KEY` or `places.apiKey`) with `places.tier: atmosphere`.'

    if (none > 0 && subscribed) {
      return {
        status: CheckStatuses.warn,
        code: 'gbp.reviews.no-source',
        summary: `${summary} This project subscribes to review webhooks, which cannot fire for those locations.`,
        remediation: `${V4_ACCESS_REMEDIATION}${placesHint}`,
        details,
      }
    }
    return {
      status: CheckStatuses.skipped,
      code: none > 0 ? 'gbp.reviews.unavailable' : 'gbp.reviews.partial',
      summary,
      remediation: `${V4_ACCESS_REMEDIATION}${placesHint}`,
      details,
    }
  },
}

export const GBP_REVIEWS_CHECKS: readonly CheckDefinition[] = [reviewsAccessCheck]

export const GBP_REVIEWS_CHECK_BY_ID = Object.fromEntries(
  GBP_REVIEWS_CHECKS.map((check) => [check.id, check]),
) as Record<string, CheckDefinition>
