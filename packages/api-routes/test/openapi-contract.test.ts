import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

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
  app.register(apiRoutes, { db, skipAuth: true, ...opts })

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
        .map((value) => `${value} ${url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`)
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
    expect(normalizeSpecRoutes(body.paths)).toEqual(normalizeObservedRoutes(ctx.observedRoutes))
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
})
