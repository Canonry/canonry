import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildOpenApiDocument } from '../src/openapi.js'
import { LIVE_READ_OPERATIONS, READ_SEMANTIC_OPERATIONS, STORED_READ_OPERATIONS, WRITE_OPERATIONS } from '@ainyc/canonry-contracts'
import { apiRoutes, canonicalRouteTemplate } from '../src/index.js'

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
    for (const operation of WRITE_OPERATIONS) expect(operations.has(operation)).toBe(true)
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

  it('classifies every OpenAPI GET in an explicit access set', () => {
    const document = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> }
    const explicit = new Set([...LIVE_READ_OPERATIONS, ...WRITE_OPERATIONS, ...STORED_READ_OPERATIONS])
    const gets = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.keys(methods).filter(method => method.toLowerCase() === 'get').map(method => `${method.toUpperCase()} ${path}`),
    )
    expect(gets.filter(operation => !explicit.has(operation))).toEqual([])
  })

  it('checks semantic and paid-read tables against actual registered route config', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-access-routes-'))
    const db = createClient(path.join(tmp, 'test.db'))
    migrate(db)
    const app = Fastify()
    const semantic: string[] = []
    const paidReads: string[] = []
    app.addHook('onRoute', route => {
      const method = Array.isArray(route.method) ? route.method : [route.method]
      for (const verb of method) {
        const operation = canonicalRouteTemplate(route.url.replace(/:(\w+)/g, '{$1}'), '/api/v1')
          .replace(/^\/api\/v1/, `${verb.toUpperCase()} /api/v1`)
        if ((route.config as { readSemantic?: boolean } | undefined)?.readSemantic === true) semantic.push(operation)
        if (verb.toUpperCase() === 'GET' && (route.config as { paidRead?: boolean } | undefined)?.paidRead === true) paidReads.push(operation)
      }
    })
    app.register(apiRoutes, { db, skipAuth: true, googleStateSecret: 'test-only-google-state-secret-32b' })
    await app.ready()
    try {
      expect(semantic, semantic.join('\n')).toEqual(expect.arrayContaining([...READ_SEMANTIC_OPERATIONS]))
      expect(semantic).toContain('POST /api/v1/telemetry/ui')
      expect([...READ_SEMANTIC_OPERATIONS]).not.toContain('DELETE /api/v1/projects/{name}/agent/transcript')
      expect([...READ_SEMANTIC_OPERATIONS]).not.toContain('POST /api/v1/telemetry/ui')
      const paidAdsReads = [
        'GET /api/v1/projects/{name}/ads/account',
        'GET /api/v1/projects/{name}/ads/geo/search',
        'GET /api/v1/projects/{name}/ads/conversions/pixels',
        'GET /api/v1/projects/{name}/ads/conversions/event-settings',
        'GET /api/v1/projects/{name}/ads/live-delivery',
      ]
      expect(paidReads.sort()).toEqual(paidAdsReads.sort())
      expect(paidReads.every(operation => LIVE_READ_OPERATIONS.has(operation))).toBe(true)
    } finally {
      await app.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('keeps access metadata when the API is mounted below a proxy prefix', () => {
    const document = buildOpenApiDocument({ routePrefix: '/canonry/api/v1' }) as { paths: Record<string, Record<string, { 'x-canonry-access'?: string }>> }
    expect(document.paths['/canonry/api/v1/projects/{name}/google/properties']?.get?.['x-canonry-access']).toBe('live')
    expect(document.paths['/canonry/api/v1/projects/{name}/measurement-plan/compile-preview']?.post?.['x-canonry-access']).toBe('stored')
  })

  it('canonicalizes exact configured prefixes without matching an unrelated path segment', () => {
    expect(canonicalRouteTemplate('/custom/projects/:name', '/custom')).toBe('/api/v1/projects/:name')
    expect(canonicalRouteTemplate('/tenant/api/v1/projects/:name', '/tenant/api/v1')).toBe('/api/v1/projects/:name')
    expect(canonicalRouteTemplate('/projects/:name', '/custom/api/v1')).toBe('/api/v1/projects/:name')
    expect(canonicalRouteTemplate('/customized/api/v1/projects/:name', '/custom/api/v1')).toBe('/api/v1/customized/api/v1/projects/:name')
  })
})
