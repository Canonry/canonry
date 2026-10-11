import { describe, expect, it } from 'vitest'
import { buildOpenApiDocument } from '../src/openapi.js'
import { LIVE_READ_OPERATIONS, READ_SEMANTIC_OPERATIONS } from '@ainyc/canonry-contracts'

describe('OpenAPI operation access metadata', () => {
  it('declares access for every operation and marks provider routes live', () => {
    const document = buildOpenApiDocument() as { paths: Record<string, Record<string, { 'x-canonry-access'?: string }>> }
    const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
    )
    expect(operations.length).toBeGreaterThan(100)
    expect(operations.every(({ operation }) => ['stored', 'live', 'write'].includes(operation['x-canonry-access'] ?? ''))).toBe(true)
    expect(document.paths['/api/v1/projects/{name}/google/properties']?.get?.['x-canonry-access']).toBe('live')
    expect(document.paths['/api/v1/projects/{name}/competitors']?.get?.['x-canonry-access']).toBe('stored')
    expect(document.paths['/api/v1/projects/{name}/measurement-plan/compile-preview']?.post?.['x-canonry-access']).toBe('stored')
  })

  it('keeps explicit live and semantic tables in both directions with the OpenAPI map', () => {
    const document = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> }
    const operations = new Set(Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map(method => `${method.toUpperCase()} ${path}`),
    ))
    for (const operation of LIVE_READ_OPERATIONS) expect(operations.has(operation)).toBe(true)
    for (const operation of READ_SEMANTIC_OPERATIONS) expect(operations.has(operation)).toBe(true)
    expect([...LIVE_READ_OPERATIONS].some(operation => operation.includes('/ads/'))).toBe(true)
    expect([...LIVE_READ_OPERATIONS].some(operation => operation.includes('/google-ads/'))).toBe(true)
    const paidAdsReads = [
      'GET /api/v1/projects/{name}/ads/account',
      'GET /api/v1/projects/{name}/ads/geo/search',
      'GET /api/v1/projects/{name}/ads/conversions/pixels',
      'GET /api/v1/projects/{name}/ads/conversions/event-settings',
      'GET /api/v1/projects/{name}/ads/live-delivery',
    ]
    for (const operation of paidAdsReads) {
      expect(LIVE_READ_OPERATIONS.has(operation)).toBe(true)
      expect(operations.has(operation)).toBe(true)
    }
  })

  it('keeps access metadata when the API is mounted below a proxy prefix', () => {
    const document = buildOpenApiDocument({ routePrefix: '/canonry/api/v1' }) as { paths: Record<string, Record<string, { 'x-canonry-access'?: string }>> }
    expect(document.paths['/canonry/api/v1/projects/{name}/google/properties']?.get?.['x-canonry-access']).toBe('live')
    expect(document.paths['/canonry/api/v1/projects/{name}/measurement-plan/compile-preview']?.post?.['x-canonry-access']).toBe('stored')
  })
})
