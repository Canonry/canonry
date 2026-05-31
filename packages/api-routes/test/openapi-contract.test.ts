import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'
import { canonryLocalRouteCatalog } from '../src/openapi.js'

interface RouteObserverContext {
  app: ReturnType<typeof Fastify>
  observedRoutes: Array<{ method: string; url: string }>
  tmpDir: string
}

function buildObservedApp(opts: Partial<Omit<ApiRoutesOptions, 'db'>> = {}): RouteObserverContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-openapi-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const observedRoutes: Array<{ method: string; url: string }> = []
  const app = Fastify()
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) {
      observedRoutes.push({ method: String(method), url: route.url })
    }
  })
  // Google routes register only when a state secret is configured; this
  // contract test enumerates every public path including Google's, so seed
  // a dummy secret to keep that surface mounted under test.
  //
  // `includeCanonryLocal: true` matches canonry's own server config so the
  // spec covers the Aero agent routes registered by `packages/canonry`.
  // The agent routes themselves are NOT mounted by this api-routes plugin;
  // the route-registration test below subtracts them from the comparison.
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    googleStateSecret: 'test-only-google-state-secret-32b',
    openApiInfo: { includeCanonryLocal: true },
    ...opts,
  })

  return { app, observedRoutes, tmpDir }
}

function normalizeObservedRoutes(observedRoutes: Array<{ method: string; url: string }>): string[] {
  return observedRoutes
    .flatMap(({ method, url }) => {
      if (!url.startsWith('/api/v1/')) return []
      return method
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value && value !== 'head')
        .map((value) => `${value} ${url.replace(/:(\w+)/g, '{$1}')}`)
    })
    .sort()
}

function normalizeSpecRoutes(paths: Record<string, Record<string, unknown>>): string[] {
  return Object.entries(paths)
    .flatMap(([url, operations]) =>
      Object.keys(operations).map((method) => `${method.toLowerCase()} ${url}`),
    )
    .sort()
}

/**
 * Stable string set of `<method> <path>` entries for every canonry-local
 * route. Used to subtract those operations from the spec before comparing
 * to api-routes' Fastify-registered routes — canonry-local routes ride in
 * the spec but are registered by `packages/canonry/src/agent/agent-routes.ts`,
 * not by this api-routes plugin.
 */
function canonryLocalRouteIds(): Set<string> {
  return new Set(
    canonryLocalRouteCatalog.map((route) => `${route.method.toLowerCase()} ${route.path}`),
  )
}

describe('openapi contract', () => {
  const contexts: RouteObserverContext[] = []

  afterEach(async () => {
    while (contexts.length > 0) {
      const ctx = contexts.pop()!
      await ctx.app.close()
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    }
  })

  it('documents every public route method registered under /api/v1', async () => {
    const ctx = buildObservedApp()
    contexts.push(ctx)
    await ctx.app.ready()

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(res.statusCode).toBe(200)

    const body = res.json() as { paths: Record<string, Record<string, unknown>> }
    const localIds = canonryLocalRouteIds()
    const specMinusLocal = normalizeSpecRoutes(body.paths).filter((entry) => !localIds.has(entry))
    // `/cloud/*` are admin-scope routes (Track 3 — Canonry Hosted bridge). They are
    // registered by api-routes but intentionally excluded from the public OpenAPI spec
    // because they are admin-scope only and not part of the public surface.
    const observedMinusCloud = normalizeObservedRoutes(ctx.observedRoutes).filter(
      (id) => !id.includes(' /api/v1/cloud/'),
    )
    expect(specMinusLocal).toEqual(observedMinusCloud)
  })

  it('marks public unauthenticated routes with empty security requirements', async () => {
    const ctx = buildObservedApp()
    contexts.push(ctx)
    await ctx.app.ready()

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(res.statusCode).toBe(200)

    const body = res.json() as {
      paths: Record<string, Record<string, { security?: unknown[] }>>
    }

    expect(body.paths['/api/v1/openapi.json']?.get?.security).toEqual([])
    expect(body.paths['/api/v1/google/callback']?.get?.security).toEqual([])
    expect(body.paths['/api/v1/projects/{name}/google/callback']?.get?.security).toEqual([])
  })

  it('documents gbp-sync and data-refresh as schedulable kinds in schedule request parameters and bodies', async () => {
    const ctx = buildObservedApp()
    contexts.push(ctx)
    await ctx.app.ready()

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(res.statusCode).toBe(200)

    const body = res.json() as {
      paths: Record<string, Record<string, {
        parameters?: Array<{ name: string; schema?: { enum?: string[] } }>
        requestBody?: {
          content?: Record<string, { schema?: { properties?: Record<string, { enum?: string[] }> } }>
        }
      }>>
    }
    const schedulePath = body.paths['/api/v1/projects/{name}/schedule']!

    for (const method of ['put', 'get', 'delete'] as const) {
      const kindParam = schedulePath[method]?.parameters?.find((p) => p.name === 'kind')
      expect(kindParam?.schema?.enum).toEqual(['answer-visibility', 'traffic-sync', 'gbp-sync', 'data-refresh'])
    }

    const requestKindEnum = schedulePath.put?.requestBody
      ?.content?.['application/json']?.schema?.properties?.kind?.enum
    expect(requestKindEnum).toEqual(['answer-visibility', 'traffic-sync', 'gbp-sync', 'data-refresh'])
  })

  it('every 2xx response declares a body schema (or carries a non-JSON content type)', async () => {
    // Codegen tools rely on response schemas to derive typed return values.
    // 2xx responses must either reference a `components.schemas` entry via
    // `$ref` (the normal path) or declare a non-JSON content type with its
    // own schema (binary downloads, HTML, SSE streams). 204 No Content is
    // exempt — it has no body.
    const ctx = buildObservedApp()
    contexts.push(ctx)
    await ctx.app.ready()

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(res.statusCode).toBe(200)

    type ResponseDef = { description: string; content?: Record<string, { schema?: unknown }> }
    const body = res.json() as {
      paths: Record<string, Record<string, { responses: Record<string, ResponseDef> }>>
    }

    const missingBodies: string[] = []
    for (const [path, operations] of Object.entries(body.paths)) {
      for (const [method, op] of Object.entries(operations)) {
        for (const [status, response] of Object.entries(op.responses)) {
          const code = Number(status)
          if (code < 200 || code >= 300) continue
          if (code === 204) continue
          const content = response.content
          if (!content || Object.keys(content).length === 0) {
            missingBodies.push(`${method.toUpperCase()} ${path} → ${status}`)
            continue
          }
          for (const [mediaType, media] of Object.entries(content)) {
            if (!media.schema) {
              missingBodies.push(`${method.toUpperCase()} ${path} → ${status} (${mediaType} has no schema)`)
            }
          }
        }
      }
    }

    expect(missingBodies, `Routes missing a 2xx response body schema:\n  ${missingBodies.join('\n  ')}`).toEqual([])
  })

  it('every registered component schema is referenced by at least one route', async () => {
    // Keeps the schema table honest: removing a schema from a route without
    // removing it from `openapi-schemas.ts` is a slow leak. This test
    // catches that as soon as the last reference disappears.
    const ctx = buildObservedApp()
    contexts.push(ctx)
    await ctx.app.ready()

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(res.statusCode).toBe(200)

    const body = res.json() as {
      components?: { schemas?: Record<string, unknown> }
      paths: Record<string, Record<string, unknown>>
    }

    const schemaNames = Object.keys(body.components?.schemas ?? {})
    expect(schemaNames.length).toBeGreaterThan(0)

    const serialized = JSON.stringify(body.paths)
    const unreferenced = schemaNames.filter((name) => !serialized.includes(`#/components/schemas/${name}`))

    expect(
      unreferenced,
      `Registered schemas with no $ref in any route:\n  ${unreferenced.join('\n  ')}`,
    ).toEqual([])
  })
})
