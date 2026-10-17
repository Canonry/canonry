import { and, sql, type SQL } from 'drizzle-orm'
import { isLocationRedirectStatus, LOCATION_REDIRECT_STATUSES } from '@canonry/canonry-contracts'
import { aiReferralEventsHourly } from '@canonry/canonry-db'

/**
 * An AI referral row records a REQUEST carrying AI-origin evidence, together
 * with the status the server answered it with. Not every such request is a
 * visit, and the status is what separates them.
 *
 * A Location redirect (301/302/303/307/308) is a hop. The visitor received no
 * content at that URL; their browser was sent somewhere else, and the
 * destination raises its own row when it carries the same evidence. Counting
 * the hop as an arrival counts one person twice on any site that redirects,
 * and counts them at least once on a site whose redirect target drops the
 * evidence, where the arrival is never observed at all. On live data 126 of
 * 1,572 referral hits (8.0%) were Location redirects, and on one project every
 * single referral hit was one: 120 hops reported as 120 visitors to a site
 * whose own analytics recorded 2 sessions.
 *
 * The band is deliberately NOT all of 3xx. A 304 is a served page view from
 * cache with no follow-on request — 122 of the hits in that same measurement
 * were 304s, i.e. real returning visitors — so excluding it would drop real
 * arrivals that are recouped nowhere. See `isLocationRedirectStatus`.
 *
 * 4xx and 5xx are deliberately KEPT. Someone did arrive; they landed on a
 * broken or missing page, which is a real finding rather than a miscount, and
 * suppressing it would hide exactly the pages worth fixing.
 *
 * Status 0 is KEPT as well, on benefit of the doubt: ingest stores 0 when the
 * source never observed a status, and an unobserved status is not a proven
 * hop. The cost is that a future source which cannot capture statuses reports
 * everything as landed — which is exactly the pre-filter behaviour, not a new
 * overcount. This is why the landed figures are documented as "not answered
 * with a proven redirect" rather than "proven served".
 */
const REDIRECT_LIST = sql.join([...LOCATION_REDIRECT_STATUSES].map((s) => sql`${s}`), sql`, `)

export { isLocationRedirectStatus as isReferralRedirectStatus }

/**
 * Rows not answered with a proven Location redirect. Use for any figure
 * presented as visits, visitors, sessions or arrivals.
 *
 * The complement (redirect hops) is DERIVED by callers as `total - landed`
 * rather than queried through a second hand-mirrored condition, so the
 * partition is structural and cannot drift when this band changes.
 */
export function referralLandedCondition(): SQL {
  return sql`${aiReferralEventsHourly.status} NOT IN (${REDIRECT_LIST})`
}

/**
 * Rows that count toward any visitor-facing referral figure: not a redirect
 * hop, and not a static subresource fetch riding the landing page's referrer.
 *
 * One condition on purpose. Its two halves used to be composed by hand at
 * every query site, and a site that takes one and forgets the other silently
 * reintroduces the miscount the half it forgot exists to prevent — the report
 * builder alone had five such sites.
 */
export function countableReferralCondition(): SQL {
  return and(nonSubresourceReferralPathCondition(), referralLandedCondition())!
}

/**
 * Excludes rows whose landing path is a static subresource (assets, styles,
 * scripts, icons, fonts, source maps): those requests ride the page's referrer
 * but are not themselves a visit.
 */
export function nonSubresourceReferralPathCondition(): SQL {
  return sql`
    LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '/_next/static/%'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '/assets/%'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '/static/%'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '/favicon.%'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.avif'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.css'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.gif'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.ico'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.jpeg'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.jpg'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.js'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.map'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.mjs'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.otf'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.png'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.svg'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.webmanifest'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.woff'
    AND LOWER(${aiReferralEventsHourly.landingPathNormalized}) NOT LIKE '%.woff2'
  `
}
