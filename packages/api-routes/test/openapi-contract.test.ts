import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { projectConfigExportSchema } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'
import { buildOpenApiDocument, canonryLocalRouteCatalog } from '../src/openapi.js'

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

  it('documents Google Marketing OAuth capacity responses', () => {
    const paths = buildOpenApiDocument().paths ?? {}
    const callback = paths['/api/v1/google-marketing/callback'] as Record<string, {
      responses: Record<string, unknown>
    }>
    const adsConnect = paths['/api/v1/projects/{name}/google-ads/oauth/connect'] as Record<string, {
      responses: Record<string, unknown>
    }>
    const gtmConnect = paths['/api/v1/projects/{name}/gtm/oauth/connect'] as Record<string, {
      responses: Record<string, unknown>
    }>

    expect(callback.get.responses).toHaveProperty('503')
    expect(adsConnect.post.responses).toHaveProperty('429')
    expect(gtmConnect.post.responses).toHaveProperty('429')
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
    expect(specMinusLocal).toEqual(normalizeObservedRoutes(ctx.observedRoutes))
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

  it('documents the bodies the pages, query-generation and default-location routes send', () => {
    // Each handler's own test pins the body and parses it with the schema named here.
    const doc = buildOpenApiDocument()
    const paths = doc.paths as Record<string, Record<string, {
      responses: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>
    }>>
    const okRef = (path: string, method: string) =>
      paths[path]?.[method]?.responses['200']?.content?.['application/json']?.schema?.$ref

    expect(okRef('/api/v1/projects/{name}/wordpress/pages', 'get')).toBe('#/components/schemas/WordpressPageListDto')
    expect(okRef('/api/v1/projects/{name}/queries/generate', 'post')).toBe('#/components/schemas/QueryGenerateResponse')
    expect(okRef('/api/v1/projects/{name}/locations/default', 'put')).toBe('#/components/schemas/ProjectDefaultLocationResponse')
    // The legacy alias sends the same suggestions under `keywords`.
    expect(okRef('/api/v1/projects/{name}/keywords/generate', 'post')).toBe('#/components/schemas/KeywordGenerateResponse')
    const schemas = doc.components?.schemas as Record<string, { required?: string[] }>
    expect(schemas.KeywordGenerateResponse?.required).toEqual(['keywords', 'provider'])
  })

  it('documents the POST /apply config document in its input form', () => {
    // Apply fills a defaulted field when the document leaves it out, so none
    // of them may be documented as required on the request body.
    const doc = buildOpenApiDocument()
    const apply = (doc.paths as Record<string, Record<string, {
      requestBody?: { content: Record<string, { schema?: { $ref?: string } }> }
    }>>)['/api/v1/apply']?.post
    expect(apply?.requestBody?.content['application/json']?.schema?.$ref).toBe('#/components/schemas/ProjectConfig')

    const schemas = doc.components?.schemas as Record<string, {
      required?: string[]
      properties: Record<string, { required?: string[] }>
    }>
    const config = schemas.ProjectConfig!
    expect(config.required).toEqual(['apiVersion', 'kind', 'metadata', 'spec'])
    expect(config.properties.spec!.required).toEqual(['displayName', 'canonicalDomain', 'country', 'language'])
    expect(config.properties.metadata!.required).toEqual(['name'])
  })

  it('documents GET /export with every field it always writes required', async () => {
    const doc = buildOpenApiDocument()
    const exportOperation = (doc.paths as Record<string, Record<string, {
      responses: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>
    }>>)['/api/v1/projects/{name}/export']?.get
    expect(exportOperation?.responses['200']?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/ProjectConfigExport')

    type ObjectSchema = { required?: string[]; properties: Record<string, ObjectSchema> }
    const exported = (doc.components?.schemas as Record<string, ObjectSchema>).ProjectConfigExport!
    const spec = exported.properties.spec!
    expect(exported.required).toEqual(['apiVersion', 'kind', 'metadata', 'spec'])
    expect(exported.properties.metadata!.required).toEqual(['name', 'labels'])
    expect(spec.required).toEqual([
      'displayName', 'canonicalDomain', 'ownedDomains', 'aliases', 'country', 'language',
      'competitors', 'providers', 'locations', 'measurement', 'notifications',
    ])
    expect(spec.properties.schedule!.required).toEqual(['timezone', 'providers'])
    // Export leaves these two out at their defaults (an empty map, false).
    expect(Object.keys(spec.properties)).toEqual(expect.arrayContaining(['providerModels', 'autoExtractBacklinks']))

    const ctx = buildObservedApp()
    contexts.push(ctx)
    await ctx.app.ready()
    const project = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/exportable',
      payload: { displayName: 'Exportable', canonicalDomain: 'example.com', country: 'US', language: 'en' },
    })
    expect(project.statusCode).toBe(201)
    const schedule = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/exportable/schedule',
      payload: { preset: 'daily', timezone: 'UTC', providers: ['gemini'] },
    })
    expect(schedule.statusCode).toBe(201)

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/exportable/export' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { metadata: Record<string, unknown>; spec: Record<string, unknown> & { schedule: Record<string, unknown> } }
    expect(Object.keys(body.metadata)).toEqual(expect.arrayContaining(exported.properties.metadata!.required!))
    expect(Object.keys(body.spec)).toEqual(expect.arrayContaining(spec.required!))
    expect(Object.keys(body.spec.schedule)).toEqual(expect.arrayContaining(spec.properties.schedule!.required!))
    expect(body.spec).not.toHaveProperty('providerModels')
    expect(body.spec).not.toHaveProperty('autoExtractBacklinks')
    // Parsing fills no default and drops no key, so the schema describes the body exactly.
    expect(projectConfigExportSchema.parse(body)).toEqual(body)
  })

  it('lists null in every nullable enum, so generated clients keep the null', () => {
    const doc = buildOpenApiDocument()
    // OpenAPI 3.0.3 admits null into an enum only when null is listed;
    // `nullable: true` beside the enum does not widen it.
    const offenders: string[] = []
    const visit = (node: unknown, at: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => visit(item, `${at}[${index}]`))
        return
      }
      if (node === null || typeof node !== 'object') return
      const record = node as Record<string, unknown>
      if (record.nullable === true && Array.isArray(record.enum) && !record.enum.includes(null)) offenders.push(at)
      for (const [key, value] of Object.entries(record)) visit(value, `${at}.${key}`)
    }
    visit(doc, '$')
    expect(offenders).toEqual([])

    // GA status answers `authMethod: null` while the project is disconnected.
    const gaStatus = (doc.components?.schemas as Record<string, { properties: Record<string, unknown> }>).GA4StatusDto
    expect(gaStatus?.properties.authMethod).toMatchObject({ enum: ['service-account', 'oauth', null], nullable: true })
  })

  it('documents all schedulable kinds (incl. backlinks-sync) via a single SchedulableRunKind component', async () => {
    const ctx = buildObservedApp()
    contexts.push(ctx)
    await ctx.app.ready()

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(res.statusCode).toBe(200)

    const body = res.json() as {
      components?: { schemas?: Record<string, { enum?: string[] }> }
      paths: Record<string, Record<string, {
        parameters?: Array<{ name: string; schema?: { $ref?: string } }>
        requestBody?: {
          content?: Record<string, { schema?: { properties?: Record<string, { $ref?: string }> } }>
        }
      }>>
    }

    // The enum values live in exactly one place — the shared component — so the
    // union isn't repeated across every schedule param, body, and the DTO.
    const KIND_REF = '#/components/schemas/SchedulableRunKind'
    expect(body.components?.schemas?.SchedulableRunKind?.enum).toEqual(
      ['answer-visibility', 'traffic-sync', 'gbp-sync', 'data-refresh', 'backlinks-sync', 'site-audit', 'ads-sync', 'doctor'],
    )

    const schedulePath = body.paths['/api/v1/projects/{name}/schedule']!
    expect(schedulePath.put?.requestBody?.content?.['application/json']?.schema?.properties?.recurrence).toEqual({ $ref: '#/components/schemas/CalendarRecurrence' })
    for (const method of ['put', 'get', 'delete'] as const) {
      const kindParam = schedulePath[method]?.parameters?.find((p) => p.name === 'kind')
      expect(kindParam?.schema?.$ref).toBe(KIND_REF)
    }

    const requestKindRef = schedulePath.put?.requestBody
      ?.content?.['application/json']?.schema?.properties?.kind?.$ref
    expect(requestKindRef).toBe(KIND_REF)
  })

  it('documents schedule collection reads as a typed array with no absence error', async () => {
    const ctx = buildObservedApp()
    contexts.push(ctx)
    await ctx.app.ready()

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(res.statusCode).toBe(200)

    const body = res.json() as {
      paths: Record<string, Record<string, {
        responses?: Record<string, {
          content?: Record<string, {
            schema?: {
              type?: string
              items?: { $ref?: string }
            }
          }>
        }>
      }>>
    }
    const operation = body.paths['/api/v1/projects/{name}/schedules']?.get
    expect(operation?.responses?.['200']?.content?.['application/json']?.schema).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/ScheduleDto' },
    })
    expect(operation?.responses?.['404']).toBeUndefined()
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

  it('documents independent native measurement results on the GA sync response', async () => {
    const ctx = buildObservedApp()
    contexts.push(ctx)
    await ctx.app.ready()

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      components?: {
        schemas?: Record<string, {
          required?: string[]
          properties?: Record<string, unknown>
        }>
      }
    }
    const schema = body.components?.schemas?.GA4SyncResponseDto
    expect(schema?.required).toContain('measurement')
    expect(schema?.properties).toHaveProperty('measurement')
    expect(JSON.stringify(schema?.properties?.measurement)).toContain('acquisition')
    expect(JSON.stringify(schema?.properties?.measurement)).toContain('leads')
    expect(JSON.stringify(schema?.properties?.measurement)).toContain('days')
  })

  it('publishes the typed search response, including cited URL matches', async () => {
    const ctx = buildObservedApp()
    contexts.push(ctx)
    await ctx.app.ready()

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(res.statusCode).toBe(200)

    const body = res.json() as {
      components?: { schemas?: Record<string, unknown> }
      paths: Record<string, Record<string, {
        responses?: Record<string, {
          content?: Record<string, { schema?: { $ref?: string } }>
        }>
      }>>
    }

    const responseSchema = body.paths['/api/v1/projects/{name}/search']?.get
      ?.responses?.['200']?.content?.['application/json']?.schema
    expect(responseSchema?.$ref).toBe('#/components/schemas/ProjectSearchResponseDto')
    expect(JSON.stringify(body.components?.schemas?.ProjectSearchResponseDto)).toContain('citedUrls')
  })

  it('publishes typed measurement discovery and revision-pinned report operations', async () => {
    const ctx = buildObservedApp()
    contexts.push(ctx)
    await ctx.app.ready()

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(res.statusCode).toBe(200)

    type SchemaRef = { $ref?: string }
    type Operation = {
      parameters?: Array<{
        name?: string
        in?: string
        required?: boolean
        schema?: { minimum?: number }
      }>
      requestBody?: { content?: Record<string, { schema?: SchemaRef }> }
      responses?: Record<string, { content?: Record<string, { schema?: SchemaRef }> }>
    }
    const body = res.json() as {
      paths: Record<string, { get?: Operation; post?: Operation }>
    }

    const discovery = body.paths['/api/v1/projects/{name}/measurement-discovery']?.post
    expect(discovery?.requestBody?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/MeasurementDiscoveryRequest')
    expect(discovery?.responses?.['200']?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/MeasurementDiscoveryResponse')
    expect(discovery?.responses?.['403']).toBeDefined()

    const report = body.paths['/api/v1/projects/{name}/measurement-report']?.get
    const revision = report?.parameters?.find(parameter => parameter.name === 'revision')
    expect(revision).toMatchObject({ in: 'query', required: true, schema: { minimum: 1 } })
    expect(report?.responses?.['200']?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/MeasurementReportResponse')
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
