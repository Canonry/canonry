import { describe, expect, it } from 'vitest'
import { isUiApiRouteTemplate } from '@ainyc/canonry-contracts'
import { buildOpenApiDocument } from '../src/openapi.js'

/**
 * Upkeep guard for the `ui.error` route rule. The dashboard reports a failed
 * API call by its route TEMPLATE, and the canonry.ai collector rejects any
 * template its copy of the rule does not accept. A new API path that fails
 * here would silently lose every UI error reported against it.
 */
describe('UI telemetry route templates', () => {
  it('accepts every path in the OpenAPI document', () => {
    const doc = buildOpenApiDocument({ includeCanonryLocal: true }) as { paths: Record<string, unknown> }
    const paths = Object.keys(doc.paths)
    expect(paths.length).toBeGreaterThan(100)
    const rejected = paths.filter(path => !isUiApiRouteTemplate(path))
    expect(
      rejected,
      'These API paths fail isUiApiRouteTemplate, so ui.error events for them would be dropped. '
      + 'For each, add the new fixed sub-path (`collection/child`) to UI_ROUTE_FIXED_CHILDREN, or the id '
      + 'collection to UI_ROUTE_ID_COLLECTIONS, in packages/contracts/src/ui-telemetry.ts, AND to the '
      + 'mirrored copies in canonry.ai lib/telemetry/validation.ts and canonry-telemetry lib/metrics.py.',
    ).toEqual([])
  })

  it('rejects real paths: ids and names after an id collection', () => {
    for (const probe of [
      '/api/v1/traffic/sources/abc',
      '/api/v1/keys/cnry_abcdef',
      '/api/v1/projects/{name}/competitors/acme.com',
      '/api/v1/projects/joes-plumbing/runs',
      '/api/v1/runs/30ed4717-c740-433f-9d37-05421e3f1a75',
    ]) {
      expect(isUiApiRouteTemplate(probe), probe).toBe(false)
    }
  })
})
