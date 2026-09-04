import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildEngineRoutePublicDto,
  buildImplicitNativeEngineRoute,
  engineConnectionModelCatalogResponseSchema,
  engineRouteConfigSchema,
  normalizeEngineConnection,
  upsertEngineConnection,
  type EngineConnectionConfig,
  type EngineRouteConfig,
} from '@ainyc/canonry-contracts'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

const tmpDirs: string[] = []

afterEach(() => {
  for (const directory of tmpDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-engine-routes-settings-'))
  tmpDirs.push(tmpDir)
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const connections: EngineConnectionConfig[] = []
  const routes: EngineRouteConfig[] = []
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    engineConnections: () => connections.map(buildEngineRoutePublicDto),
    engineRoutes: () => routes,
    onEngineConnectionUpsert: input => {
      const index = connections.findIndex(connection => connection.id === input.id)
      const next = upsertEngineConnection(index >= 0 ? connections[index] : undefined, input)
      if (index >= 0) connections[index] = next
      else connections.push(next)
      return buildEngineRoutePublicDto(next)
    },
    onEngineRouteUpsert: route => {
      const index = routes.findIndex(candidate => candidate.id === route.id)
      if (index >= 0) routes[index] = route
      else routes.push(route)
      return route
    },
    getEngineConnectionModelCatalog: async connectionId => engineConnectionModelCatalogResponseSchema.parse({
      connectionId,
      state: 'available',
      manualModelIdAllowed: true,
      fetchedAt: '2026-09-01T00:00:00.000Z',
      models: [
        { id: 'openai/gpt-5.4', displayName: 'GPT 5.4', provider: 'openai' },
        { id: 'anthropic/claude-sonnet', displayName: 'Claude Sonnet', provider: 'anthropic' },
      ],
    }),
  } satisfies ApiRoutesOptions)
  return { app, connections, routes }
}

describe('engine route settings API', () => {
  it('writes a generic connection but returns only redacted settings metadata', async () => {
    const { app, connections } = buildApp()
    await app.ready()
    try {
      const write = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/engine-connections/openrouter-main',
        payload: {
          label: 'OpenRouter', preset: 'openrouter', apiKey: 'never-in-a-read',
          quota: { maxConcurrency: 2, maxRequestsPerMinute: 20, maxRequestsPerDay: 100 },
        },
      })
      expect(write.statusCode).toBe(200)
      expect(connections).toHaveLength(1)
      expect(write.json()).toMatchObject({ id: 'openrouter-main', secretConfigured: true })
      expect(write.body).not.toContain('never-in-a-read')

      const read = await app.inject({ method: 'GET', url: '/api/v1/settings' })
      expect(read.statusCode).toBe(200)
      expect(read.json().engineConnections).toEqual([expect.objectContaining({ id: 'openrouter-main', secretConfigured: true })])
      expect(read.body).not.toContain('never-in-a-read')

      const redactedUpdate = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/engine-connections/openrouter-main',
        payload: {
          label: 'OpenRouter production', preset: 'openrouter',
          quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 50 },
        },
      })
      expect(redactedUpdate.statusCode).toBe(200)
      expect(connections[0]?.apiKey).toBe('never-in-a-read')
      expect(redactedUpdate.body).not.toContain('never-in-a-read')

      const repointedWithoutReplacement = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/engine-connections/openrouter-main',
        payload: {
          label: 'Replacement gateway', preset: 'custom-openai-compatible', baseUrl: 'https://gateway.example/v1',
          quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 50 },
        },
      })
      expect(repointedWithoutReplacement.statusCode).toBe(400)
      expect(repointedWithoutReplacement.json().error.message).toMatch(/explicit apiKey/i)
      expect(connections[0]).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'never-in-a-read' })

      const clientOwnedId = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/engine-connections/openrouter-main',
        payload: {
          id: 'try-to-replace-id',
          label: 'OpenRouter production', preset: 'openrouter',
          quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 50 },
        },
      })
      expect(clientOwnedId.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('accepts text-only routes and rejects a client claim of measurement evidence', async () => {
    const { app, routes, connections } = buildApp()
    connections.push(normalizeEngineConnection({
      id: 'openrouter-main', label: 'OpenRouter', preset: 'openrouter', apiKey: 'secret',
      quota: { maxConcurrency: 2, maxRequestsPerMinute: 20, maxRequestsPerDay: 100 },
    }))
    await app.ready()
    try {
      const route = {
        label: 'Analysis', connectionId: 'openrouter-main', modelId: 'openai/gpt-5.4',
      }
      const accepted = await app.inject({
        method: 'PUT', url: '/api/v1/settings/engine-routes/route:openrouter-main', payload: route,
      })
      expect(accepted.statusCode).toBe(200)
      expect(routes).toEqual([engineRouteConfigSchema.parse({
        id: 'route:openrouter-main', ...route, revision: 1, source: 'configured', capabilities: { kind: 'text-only' },
      })])

      const unsafe = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/engine-routes/route:openrouter-main',
        payload: {
          ...route,
          revision: 999,
        },
      })
      expect(unsafe.statusCode).toBe(400)
      expect(unsafe.json().error.message).toMatch(/invalid engine route configuration/i)
    } finally {
      await app.close()
    }
  })

  it('keeps a route with a missing connection visible but does not mark virtual native routes unavailable', async () => {
    const { app, routes } = buildApp()
    routes.push(engineRouteConfigSchema.parse({
      id: 'route:orphaned', label: 'Saved route', connectionId: 'missing-connection', modelId: 'openai/gpt-5.4',
      revision: 3, source: 'configured', capabilities: { kind: 'text-only' },
    }))
    routes.push(buildImplicitNativeEngineRoute({
      provider: 'openai', displayName: 'OpenAI', defaultModel: 'gpt-5.4',
      capabilities: {
        kind: 'verified-measurement', retrieval: true, citations: true,
        location: true, servedModel: true, fallback: 'disabled',
      },
    }))
    await app.ready()
    try {
      const summary = await app.inject({ method: 'GET', url: '/api/v1/settings/engine-routes' })
      expect(summary.statusCode).toBe(200)
      expect(summary.json()).toEqual({
        routes: [{
          id: 'native:openai', label: 'OpenAI', modelId: 'gpt-5.4', revision: 1, source: 'implicit-native',
          readiness: { state: 'measurement-ready', measurementReady: true },
        }, {
          id: 'route:orphaned', label: 'Saved route', modelId: 'openai/gpt-5.4', revision: 3, source: 'configured',
          readiness: { state: 'unavailable', measurementReady: false },
        }],
      })
      expect(summary.body).not.toContain('missing-connection')
    } finally {
      await app.close()
    }
  })

  it('returns a bounded credential-redacted model catalog without starting inference', async () => {
    const { app, connections } = buildApp()
    connections.push(normalizeEngineConnection({
      id: 'openrouter-main', label: 'OpenRouter', preset: 'openrouter', apiKey: 'catalog-secret',
      quota: { maxConcurrency: 2, maxRequestsPerMinute: 20, maxRequestsPerDay: 100 },
    }))
    await app.ready()
    try {
      const catalog = await app.inject({ method: 'GET', url: '/api/v1/settings/engine-connections/openrouter-main/models' })
      expect(catalog.statusCode).toBe(200)
      expect(catalog.json()).toMatchObject({
        connectionId: 'openrouter-main',
        state: 'available',
        manualModelIdAllowed: true,
        models: expect.arrayContaining([expect.objectContaining({ id: 'openai/gpt-5.4' })]),
      })
      expect(catalog.body).not.toContain('catalog-secret')

      const unknown = await app.inject({ method: 'GET', url: '/api/v1/settings/engine-connections/missing/models' })
      expect(unknown.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})
