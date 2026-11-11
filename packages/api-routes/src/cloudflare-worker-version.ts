import { CLOUDFLARE_PAGE_VIEWS_VERSION_SUFFIX } from '@canonry/canonry-integration-cloudflare-worker'

/**
 * Semver of the Canonry-issued Cloudflare Worker bundle. Bump when the
 * Worker's edge-side filter, payload shape, or auth header set changes so the
 * doctor check can identify deployments still running an older revision.
 */
export const CURRENT_CLOUDFLARE_WORKER_VERSION = '1.1.2'

/**
 * The version a Worker generated with these options reports. A Worker that
 * forwards page views carries a `+page-views` suffix, so the doctor check and
 * journey reads can tell whether the deployed Worker matches the source.
 */
export function cloudflareWorkerVersionFor(options: { forwardPageViews: boolean }): string {
  return `${CURRENT_CLOUDFLARE_WORKER_VERSION}${options.forwardPageViews ? CLOUDFLARE_PAGE_VIEWS_VERSION_SUFFIX : ''}`
}

/**
 * Whether a deployed Worker's reported version says it forwards page views.
 * Any version with the suffix does: a bump for an unrelated change (a new
 * bot keyword) must not make journeys call a page-view Worker incomplete.
 * The doctor's worker-version check is what flags an older Worker.
 */
export function workerReportsPageViews(version: string | null | undefined): boolean {
  return version?.endsWith(CLOUDFLARE_PAGE_VIEWS_VERSION_SUFFIX) ?? false
}
