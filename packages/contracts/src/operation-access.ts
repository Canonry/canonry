import { z } from 'zod'

export const operationAccessSchema = z.enum(['stored', 'live', 'write'])
export type OperationAccess = z.infer<typeof operationAccessSchema>
export const OperationAccesses = Object.freeze(operationAccessSchema.enum)

export const OPERATION_ACCESS_HEADER = 'x-canonry-access'

/** Provider reads and diagnostics whose result is not satisfied by stored data. */
export const LIVE_READ_OPERATIONS: ReadonlySet<string> = new Set([
  'GET /api/v1/projects/{name}/google/properties',
  'GET /api/v1/projects/{name}/google/gsc/sitemaps',
  'GET /api/v1/projects/{name}/gbp/accounts',
  'GET /api/v1/projects/{name}/ga/properties',
  'GET /api/v1/projects/{name}/bing/sites',
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
  'POST /api/v1/apply/preview',
  'GET /api/v1/projects/{name}/discover/sessions/{id}/harvest',
  'GET /api/v1/cdp/status',
  'GET /api/v1/projects/{name}/wordpress/status',
  'GET /api/v1/projects/{name}/wordpress/pages',
  'GET /api/v1/projects/{name}/wordpress/page',
  'GET /api/v1/projects/{name}/wordpress/schema',
  'GET /api/v1/projects/{name}/wordpress/schema/status',
  'GET /api/v1/projects/{name}/wordpress/llms-txt',
  'GET /api/v1/projects/{name}/wordpress/audit',
  'GET /api/v1/projects/{name}/wordpress/diff',
  'GET /api/v1/projects/{name}/wordpress/staging/status',
  'POST /api/v1/projects/{name}/measurement-discovery',
])

/** GET operations with a write side effect, including OAuth callbacks and derived snapshots. */
export const WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  'GET /api/v1/projects/{name}/bing/coverage',
  'GET /api/v1/google/callback',
  'GET /api/v1/projects/{name}/google/callback',
  'GET /api/v1/google-marketing/callback',
])

/** POST previews that calculate from supplied or draft data without persistence. */
export const READ_SEMANTIC_OPERATIONS: ReadonlySet<string> = new Set([
  'POST /api/v1/projects/{name}/measurement-plan/compile-preview',
  'POST /api/v1/projects/{name}/measurement-plan/diff-preview',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/preview-assignments',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/preview-group-membership',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/compile-preview',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/diff-preview',
])

/** Stored provider-free reads added by the competitor evidence surface. */
export const STORED_READ_OPERATIONS: ReadonlySet<string> = new Set([
  'GET /api/v1/projects/{name}/competitor-suggestions',
])

export function operationAccess(method: string, pathTemplate: string): OperationAccess {
  const operation = `${method.toUpperCase()} ${pathTemplate}`
  if (method.toUpperCase() !== 'GET' && READ_SEMANTIC_OPERATIONS.has(operation)) return OperationAccesses.stored
  if (WRITE_OPERATIONS.has(operation)) return OperationAccesses.write
  if (STORED_READ_OPERATIONS.has(operation)) return OperationAccesses.stored
  if (method.toUpperCase() === 'GET' && LIVE_READ_OPERATIONS.has(operation)) return OperationAccesses.live
  if (LIVE_READ_OPERATIONS.has(operation)) return OperationAccesses.live
  if (method.toUpperCase() !== 'GET') return OperationAccesses.write
  return OperationAccesses.stored
}

export function maxOperationAccess(accesses: readonly OperationAccess[]): OperationAccess {
  if (accesses.includes(OperationAccesses.write)) return OperationAccesses.write
  if (accesses.includes(OperationAccesses.live)) return OperationAccesses.live
  return OperationAccesses.stored
}
