import { z } from 'zod'

export const operationAccessSchema = z.enum(['stored', 'live', 'write'])
export type OperationAccess = z.infer<typeof operationAccessSchema>
export const OperationAccesses = Object.freeze(operationAccessSchema.enum)

export const OPERATION_ACCESS_HEADER = 'x-canonry-access'
export const STORED_ONLY_HEADER = 'x-canonry-stored-only'

/** Provider reads and diagnostics whose result is not satisfied by stored data. */
export const LIVE_READ_OPERATIONS: ReadonlySet<string> = new Set([
  'GET /api/v1/projects/{name}/google/properties',
  'GET /api/v1/projects/{name}/google/gsc/sitemaps',
  'GET /api/v1/projects/{name}/gbp/accounts',
  'GET /api/v1/projects/{name}/gbp/local-posts',
  'GET /api/v1/projects/{name}/gbp/local-post',
  'GET /api/v1/projects/{name}/gbp/reviews/live',
  'GET /api/v1/projects/{name}/ga/properties',
  'GET /api/v1/projects/{name}/bing/sites',
  // Performance reads query Bing directly rather than the local snapshot.
  'GET /api/v1/projects/{name}/bing/performance',
  'GET /api/v1/projects/{name}/doctor',
  'GET /api/v1/doctor',
  'GET /api/v1/backlinks/latest-release',
  'GET /api/v1/projects/{name}/google-ads/customers',
  'GET /api/v1/projects/{name}/gtm/accounts',
  'GET /api/v1/projects/{name}/gtm/accounts/{accountId}/containers',
  'GET /api/v1/projects/{name}/gtm/accounts/{accountId}/containers/{containerId}/workspaces',
  'GET /api/v1/projects/{name}/ads/account',
  'GET /api/v1/projects/{name}/ads/geo/search',
  'GET /api/v1/projects/{name}/ads/conversions/pixels',
  'GET /api/v1/projects/{name}/ads/conversions/event-settings',
  'GET /api/v1/projects/{name}/ads/live-delivery',
  'GET /api/v1/projects/{name}/wordpress/status',
  'GET /api/v1/projects/{name}/wordpress/pages',
  'GET /api/v1/projects/{name}/wordpress/page',
  'GET /api/v1/projects/{name}/wordpress/schema',
  'GET /api/v1/projects/{name}/wordpress/schema/status',
  'GET /api/v1/projects/{name}/wordpress/llms-txt',
  'GET /api/v1/projects/{name}/wordpress/audit',
  'GET /api/v1/projects/{name}/wordpress/diff',
  'GET /api/v1/projects/{name}/wordpress/staging/status',
  'GET /api/v1/projects/{name}/discover/sessions/{id}/harvest',
  'GET /api/v1/cdp/status',
  'POST /api/v1/apply/preview',
  'POST /api/v1/projects/{name}/measurement-discovery',
])

/** POST previews that calculate from supplied or draft data without persistence. */
export const READ_SEMANTIC_OPERATIONS: ReadonlySet<string> = new Set([
  'POST /api/v1/projects/{name}/measurement-plan/compile-preview',
  'POST /api/v1/projects/{name}/measurement-plan/diff-preview',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/preview-assignments',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/preview-group-membership',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/preview-route-markets',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/compile-preview',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/diff-preview',
])

/** GET callbacks and provider-backed reads that have write side effects. */
export const WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  'GET /api/v1/session',
  'GET /api/v1/auth/session',
  'GET /api/v1/auth/sessions',
  'GET /api/v1/google/callback',
  'GET /api/v1/projects/{name}/google/callback',
  'GET /api/v1/google-marketing/callback',
  'GET /api/v1/projects/{name}/bing/coverage',
])

/** Stored reads and pure previews that retain write-scope authorization. */
export const STORED_READ_OPERATIONS: ReadonlySet<string> = new Set([
  'GET /api/v1/projects/{name}/gbp/local-post-attempt',
  'GET /api/v1/openapi.json',
  'GET /api/v1/screenshots/{snapshotId}',
  'GET /api/v1/projects/{name}/technical-aeo/runs/{runId}/page-health-preview',
  'POST /api/v1/projects/{name}/competitor-changes/preview',
  'POST /api/v1/projects/{name}/queries/replace-preview',
  'GET /api/v1/projects/{name}/ga/acquisition',
  'GET /api/v1/projects/{name}/traffic/referral-assessment',
  'GET /api/v1/projects/{name}/traffic/samples',
  'GET /api/v1/projects/{name}/sentiment/settings',
  'GET /api/v1/projects/{name}/sentiment',
  'GET /api/v1/projects/{name}/sentiment/evidence',
  'GET /api/v1/projects/{name}/sentiment/compare',
  'GET /api/v1/projects/{name}/sentiment/backfill-preview',
  'GET /api/v1/projects/{name}/sentiment/jobs',
  'GET /api/v1/projects/{name}/sentiment/jobs/{jobId}',
  'GET /api/v1/operations/logs',
  'GET /api/v1/projects',
  'GET /api/v1/projects/{name}',
  'GET /api/v1/projects/{name}/delete-preview',
  'GET /api/v1/projects/{name}/locations',
  'GET /api/v1/projects/{name}/export',
  'GET /api/v1/projects/{name}/results/export',
  'GET /api/v1/projects/{name}/queries',
  'GET /api/v1/projects/{name}/keywords',
  'GET /api/v1/projects/{name}/competitors',
  'GET /api/v1/projects/{name}/competitor-suggestions',
  'GET /api/v1/projects/{name}/analytics/competitors',
  'GET /api/v1/projects/{name}/competitor-auto-aliases',
  'GET /api/v1/projects/{name}/measurement-plan',
  'GET /api/v1/projects/{name}/measurement-plan/versions',
  'GET /api/v1/projects/{name}/measurement-plan/versions/{revision}',
  'GET /api/v1/projects/{name}/measurement-report',
  'GET /api/v1/projects/{name}/measurement-setup',
  'GET /api/v1/projects/{name}/measurement-plan/draft',
  'GET /api/v1/projects/{name}/measurement-plan/draft/targets',
  'GET /api/v1/projects/{name}/measurement-plan/draft/assignments',
  'GET /api/v1/projects/{name}/measurement-plan/draft/groups',
  'GET /api/v1/projects/{name}/measurement-overview',
  'GET /api/v1/projects/{name}/visibility-report',
  'GET /api/v1/projects/{name}/query-tracking',
  'GET /api/v1/projects/{name}/measurement-property-evidence',
  'GET /api/v1/projects/{name}/measurement-portfolio-summary',
  'GET /api/v1/projects/{name}/measurement-property-questions',
  'GET /api/v1/projects/{name}/measurement-question-result',
  'GET /api/v1/projects/{name}/measurement-property-competitors',
  'GET /api/v1/projects/{name}/measurement-changes',
  'GET /api/v1/projects/{name}/measurement-data-quality',
  'GET /api/v1/projects/{name}/measurement-query-sets',
  'GET /api/v1/projects/{name}/measurement-query-sets/{setId}',
  'GET /api/v1/projects/{name}/measurement-query-templates',
  'GET /api/v1/projects/{name}/research/runs',
  'GET /api/v1/projects/{name}/research/runs/{runId}',
  'GET /api/v1/projects/{name}/organic-evidence',
  'GET /api/v1/projects/{name}/runs',
  'GET /api/v1/projects/{name}/runs/latest',
  'GET /api/v1/projects/{name}/run-admission',
  'GET /api/v1/runs',
  'GET /api/v1/runs/{id}',
  'GET /api/v1/runs/{id}/completeness',
  'GET /api/v1/projects/{name}/history',
  'GET /api/v1/history',
  'GET /api/v1/projects/{name}/snapshots',
  'GET /api/v1/projects/{name}/timeline',
  'GET /api/v1/projects/{name}/analytics/metrics',
  'GET /api/v1/projects/{name}/analytics/gaps',
  'GET /api/v1/projects/{name}/analytics/sources',
  'GET /api/v1/projects/{name}/visibility-stats',
  'GET /api/v1/projects/{name}/visibility-compare',
  'GET /api/v1/projects/{name}/snapshots/diff',
  'GET /api/v1/settings',
  'GET /api/v1/keys',
  'GET /api/v1/keys/self',
  'GET /api/v1/users',
  'GET /api/v1/projects/{name}/schedules',
  'GET /api/v1/projects/{name}/schedule',
  'GET /api/v1/notifications/events',
  'GET /api/v1/projects/{name}/notifications',
  'GET /api/v1/telemetry',
  'GET /api/v1/projects/{name}/runs/{runId}/browser-diff',
  'GET /api/v1/projects/{name}/google/connections',
  'GET /api/v1/projects/{name}/google/gsc/performance',
  'GET /api/v1/projects/{name}/google/gsc/performance/daily',
  'GET /api/v1/projects/{name}/google/gsc/top-pages',
  'GET /api/v1/projects/{name}/google/gsc/query-totals',
  'GET /api/v1/projects/{name}/google/gsc/inspections',
  'GET /api/v1/projects/{name}/google/gsc/deindexed',
  'GET /api/v1/projects/{name}/google/gsc/coverage',
  'GET /api/v1/projects/{name}/google/gsc/coverage/history',
  'GET /api/v1/projects/{name}/gbp/locations',
  'GET /api/v1/projects/{name}/ads/status',
  'GET /api/v1/projects/{name}/ads/operations',
  'GET /api/v1/projects/{name}/ads/operations/{operationKey}',
  'GET /api/v1/projects/{name}/ads/campaigns',
  'GET /api/v1/projects/{name}/ads/insights',
  'GET /api/v1/projects/{name}/ads/summary',
  'GET /api/v1/projects/{name}/ads/delivery-diagnostics',
  'GET /api/v1/projects/{name}/gbp/metrics',
  'GET /api/v1/projects/{name}/gbp/keywords',
  'GET /api/v1/projects/{name}/gbp/place-actions',
  'GET /api/v1/projects/{name}/gbp/lodging',
  'GET /api/v1/projects/{name}/gbp/attributes',
  'GET /api/v1/projects/{name}/gbp/places',
  'GET /api/v1/projects/{name}/gbp/reviews',
  'GET /api/v1/projects/{name}/gbp/summary',
  'GET /api/v1/projects/{name}/google-ads/status',
  'GET /api/v1/projects/{name}/gtm/status',
  'GET /api/v1/projects/{name}/conversion-tracking/options',
  'GET /api/v1/projects/{name}/google-ads/performance',
  'GET /api/v1/projects/{name}/google-ads/snapshots',
  'GET /api/v1/projects/{name}/google-ads/snapshots/{snapshotId}',
  'GET /api/v1/projects/{name}/gtm/snapshots',
  'GET /api/v1/projects/{name}/gtm/snapshots/{snapshotId}',
  'GET /api/v1/projects/{name}/conversion-tracking/contracts',
  'GET /api/v1/projects/{name}/conversion-tracking/contracts/{contractId}',
  'GET /api/v1/projects/{name}/conversion-tracking/contracts/{contractId}/integrity',
  'GET /api/v1/projects/{name}/bing/status',
  'GET /api/v1/projects/{name}/bing/coverage/history',
  'GET /api/v1/projects/{name}/bing/inspections',
  'GET /api/v1/projects/{name}/traffic/sources',
  'GET /api/v1/projects/{name}/traffic/status',
  'GET /api/v1/projects/{name}/traffic/analytics',
  'GET /api/v1/projects/{name}/traffic/sources/{id}',
  'GET /api/v1/projects/{name}/traffic/events',
  'GET /api/v1/projects/{name}/ga/status',
  'GET /api/v1/projects/{name}/ga/measurement-analysis',
  'GET /api/v1/projects/{name}/ga/search-landing-pages',
  'GET /api/v1/projects/{name}/ga/traffic',
  'GET /api/v1/projects/{name}/ga/ai-referral-history',
  'GET /api/v1/projects/{name}/ga/ai-referral-daily',
  'GET /api/v1/projects/{name}/ga/social-referral-history',
  'GET /api/v1/projects/{name}/ga/social-referral-trend',
  'GET /api/v1/projects/{name}/ga/attribution-trend',
  'GET /api/v1/projects/{name}/ga/session-history',
  'GET /api/v1/projects/{name}/ga/coverage',
  'GET /api/v1/projects/{name}/content/targets',
  'GET /api/v1/projects/{name}/content/sources',
  'GET /api/v1/projects/{name}/content/gaps',
  'GET /api/v1/projects/{name}/content/domain-classifications',
  'GET /api/v1/projects/{name}/content/recommendations/{targetRef}/brief',
  'GET /api/v1/projects/{name}/content/dismissals',
  'GET /api/v1/projects/{name}/content/recommendations/{targetRef}/analysis',
  'GET /api/v1/projects/{name}/insights',
  'GET /api/v1/projects/{name}/insights/{id}',
  'GET /api/v1/projects/{name}/health/latest',
  'GET /api/v1/projects/{name}/health/history',
  'GET /api/v1/projects/{name}/citations/visibility',
  'GET /api/v1/projects/{name}/overview',
  'GET /api/v1/projects/{name}/search',
  'GET /api/v1/status',
  'GET /api/v1/backlinks/status',
  'GET /api/v1/backlinks/syncs',
  'GET /api/v1/backlinks/syncs/latest',
  'GET /api/v1/backlinks/releases',
  'GET /api/v1/projects/{name}/backlinks/summary',
  'GET /api/v1/projects/{name}/backlinks/domains',
  'GET /api/v1/projects/{name}/backlinks/sources',
  'GET /api/v1/projects/{name}/backlinks/history',
  'GET /api/v1/projects/{name}/agent/conversations',
  'GET /api/v1/projects/{name}/agent/conversations/{id}',
  'GET /api/v1/projects/{name}/agent/transcript',
  'GET /api/v1/projects/{name}/agent/memory',
  'GET /api/v1/projects/{name}/agent/providers',
  'GET /api/v1/projects/{name}/discover/sessions',
  'GET /api/v1/projects/{name}/discover/sessions/{id}',
  'GET /api/v1/projects/{name}/discover/sessions/{id}/promote',
  'GET /api/v1/projects/{name}/technical-aeo',
  'GET /api/v1/projects/{name}/technical-aeo/pages',
  'GET /api/v1/projects/{name}/technical-aeo/trend',
  'GET /api/v1/projects/{name}/technical-aeo/crawl',
  'GET /api/v1/projects/{name}/technical-aeo/subgraph',
  'GET /api/v1/projects/{name}/technical-aeo/path',
  'GET /api/v1/projects/{name}/technical-aeo/changes',
  'GET /api/v1/projects/{name}/technical-aeo/graph',
  'GET /api/v1/projects/{name}/technical-aeo/crawl/pages',
  'GET /api/v1/projects/{name}/technical-aeo/crawl/pages/audit',
  'GET /api/v1/projects/{name}/technical-aeo/issues',
  'GET /api/v1/projects/{name}/technical-aeo/issues/{issueId}/pages',
  'GET /api/v1/projects/{name}/technical-aeo/structure',
  'GET /api/v1/projects/{name}/technical-aeo/internal-links',
  'GET /api/v1/projects/{name}/technical-aeo/internal-links/neighbors',
  'GET /api/v1/projects/{name}/technical-aeo/dead-links',
  'GET /api/v1/projects/{name}/technical-aeo/runs',
  'GET /api/v1/projects/{name}/technical-aeo/runs/{runId}/progress',
])

/**
 * Classify an operation. Unknown GETs fail closed as live provider work so a
 * newly added route cannot quietly become a free stored read. Callers with a
 * complete local catalog may provide a different fallback explicitly.
 */
export function operationAccess(method: string, pathTemplate: string, unknownGetAccess: OperationAccess = OperationAccesses.live): OperationAccess {
  const operation = `${method.toUpperCase()} ${pathTemplate}`
  if (WRITE_OPERATIONS.has(operation)) return OperationAccesses.write
  if (method.toUpperCase() !== 'GET' && READ_SEMANTIC_OPERATIONS.has(operation)) return OperationAccesses.stored
  if (STORED_READ_OPERATIONS.has(operation)) return OperationAccesses.stored
  if (method.toUpperCase() === 'GET' && LIVE_READ_OPERATIONS.has(operation)) return OperationAccesses.live
  if (LIVE_READ_OPERATIONS.has(operation)) return OperationAccesses.live
  if (method.toUpperCase() !== 'GET') return OperationAccesses.write
  return unknownGetAccess
}

export function maxOperationAccess(accesses: readonly OperationAccess[]): OperationAccess {
  if (accesses.includes(OperationAccesses.write)) return OperationAccesses.write
  if (accesses.includes(OperationAccesses.live)) return OperationAccesses.live
  return OperationAccesses.stored
}

function apiPath(pathname: string): string {
  try {
    pathname = new URL(pathname, 'http://canonry.invalid').pathname
  } catch {
    pathname = pathname.split('?', 1)[0] ?? pathname
  }
  const marker = pathname.indexOf('/api/v1')
  const path = marker >= 0 ? `/api/v1${pathname.slice(marker + '/api/v1'.length)}` : pathname
  // Fastify exposes registered routes as /projects/:name/... while the
  // operation catalog uses {name} placeholders. Normalize both forms before
  // matching so guards classify the route before its handler runs.
  return path.replace(/:(\w+)/g, '{$1}')
}

function templateMatches(template: string, pathname: string): boolean {
  const templateParts = template.split('/').filter(Boolean)
  const pathParts = pathname.split('/').filter(Boolean)
  return templateParts.length === pathParts.length && templateParts.every((part, index) => (part.startsWith('{') && part.endsWith('}')) || part === pathParts[index])
}

/** Return the registered operation key for a URL, or a concrete fallback key. */
export function matchOperationTemplate(method: string, pathname: string): string {
  const path = apiPath(pathname)
  const operationMethod = method.toUpperCase()
  const known = [...WRITE_OPERATIONS, ...LIVE_READ_OPERATIONS, ...READ_SEMANTIC_OPERATIONS, ...STORED_READ_OPERATIONS]
    .find(operation => operation.startsWith(`${operationMethod} `) && templateMatches(operation.slice(operationMethod.length + 1), path))
  return known ?? `${operationMethod} ${path}`
}
