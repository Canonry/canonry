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
  'GET /api/v1/projects/{name}/ga/properties',
  'GET /api/v1/projects/{name}/bing/sites',
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
  'POST /api/v1/projects/{name}/measurement-discovery',
])

/** POST previews that calculate from supplied or draft data without persistence. */
export const READ_SEMANTIC_OPERATIONS: ReadonlySet<string> = new Set([
  'POST /api/v1/apply/preview',
  'POST /api/v1/projects/{name}/competitor-changes/preview',
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
  if (method.toUpperCase() !== 'GET' && READ_SEMANTIC_OPERATIONS.has(operation)) return 'stored'
  if (STORED_READ_OPERATIONS.has(operation)) return 'stored'
  if (method.toUpperCase() === 'GET' && LIVE_READ_OPERATIONS.has(operation)) return 'live'
  if (LIVE_READ_OPERATIONS.has(operation)) return 'live'
  if (method.toUpperCase() !== 'GET') return 'write'
  return 'stored'
}

export function maxOperationAccess(accesses: readonly OperationAccess[]): OperationAccess {
  if (accesses.includes('write')) return 'write'
  if (accesses.includes('live')) return 'live'
  return 'stored'
}

function apiPath(pathname: string): string {
  try {
    pathname = new URL(pathname, 'http://canonry.invalid').pathname
  } catch {
    pathname = pathname.split('?', 1)[0] ?? pathname
  }
  const marker = pathname.indexOf('/api/v1/')
  const path = marker >= 0 ? `/api/v1/${pathname.slice(marker + '/api/v1/'.length)}` : pathname
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
  const known = [...LIVE_READ_OPERATIONS, ...READ_SEMANTIC_OPERATIONS]
    .find(operation => operation.startsWith(`${operationMethod} `) && templateMatches(operation.slice(operationMethod.length + 1), path))
  return known ?? `${operationMethod} ${path}`
}
