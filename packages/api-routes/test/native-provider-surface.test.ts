import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { buildOpenApiDocument } from '../src/openapi.js'

describe('native provider surface', () => {
  let app: ReturnType<typeof Fastify>
  let directory: string
  const onProviderUpdate = vi.fn((name: string) => ({ name, configured: true }))

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-native-provider-surface-'))
    const db = createClient(path.join(directory, 'test.db'))
    migrate(db)
    onProviderUpdate.mockClear()
    app = Fastify()
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      onProviderUpdate,
      providerSummary: [
        { name: 'openai', configured: true },
        { name: 'local', configured: true },
        { name: 'claude', configured: false },
        { name: 'gemini', configured: false, vertexConfigured: true },
      ],
      providerAdapters: ['openai', 'local', 'claude', 'gemini'].map(name => ({
        name, displayName: name, mode: 'api' as const, modelConfigurable: true,
        defaultModel: name === 'openai' ? 'gpt-4.1' : 'llama3', knownModels: [],
        modelValidationPattern: /.+/, modelValidationHint: 'nonempty model',
      })),
      onResearchRunRequested: vi.fn(),
    })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('does not register or document generic connection and route APIs', async () => {
    const requests = [
      { method: 'GET' as const, url: '/api/v1/settings/engine-routes' },
      { method: 'GET' as const, url: '/api/v1/settings/engine-connections/example/models' },
      { method: 'PUT' as const, url: '/api/v1/settings/engine-connections/example', payload: {} },
      { method: 'PUT' as const, url: '/api/v1/settings/engine-routes/route:example', payload: {} },
    ]
    for (const request of requests) {
      expect((await app.inject(request)).statusCode, request.url).toBe(404)
    }
    for (const includeCanonryLocal of [false, true]) {
      const document = buildOpenApiDocument({ includeCanonryLocal })
      expect(Object.keys(document.paths ?? {}).filter(key => key.includes('/settings/engine-'))).toEqual([])
      expect(document.components?.schemas).not.toHaveProperty('EngineRouteConfig')
      expect(document.components?.schemas).not.toHaveProperty('EngineConnectionPublicDto')
    }
    expect(onProviderUpdate).not.toHaveBeenCalled()
  })

  it('keeps native settings and caller-supplied endpoints without a route catalog', async () => {
    const settings = await app.inject({ method: 'GET', url: '/api/v1/settings' })
    expect(settings.statusCode).toBe(200)
    expect(settings.json().providerCatalog.map((provider: { name: string }) => provider.name)).toEqual(['openai', 'local', 'claude', 'gemini'])
    expect(settings.json()).not.toHaveProperty('engineRoutes')
    expect(settings.json()).not.toHaveProperty('engineConnections')

    const endpoint = 'http://localhost:11434/v1'
    const local = await app.inject({
      method: 'PUT', url: '/api/v1/settings/providers/local', payload: { baseUrl: endpoint, model: 'llama3' },
    })
    expect(local.statusCode).toBe(200)
    expect(onProviderUpdate).toHaveBeenLastCalledWith('local', '', 'llama3', endpoint, undefined, expect.objectContaining({ actor: 'api' }))

    const native = await app.inject({
      method: 'PUT', url: '/api/v1/settings/providers/openai',
      payload: { apiKey: 'test-only-key', model: 'gpt-4.1', baseUrl: 'https://provider.example/v1' },
    })
    expect(native.statusCode).toBe(200)
    expect(onProviderUpdate).toHaveBeenLastCalledWith('openai', 'test-only-key', 'gpt-4.1', 'https://provider.example/v1', undefined, expect.objectContaining({ actor: 'api' }))
  })

  it('allows credential-free model and quota edits for configured providers only', async () => {
    const openai = await app.inject({
      method: 'PUT', url: '/api/v1/settings/providers/openai',
      payload: { model: 'gpt-4.1', quota: { maxConcurrency: 3 } },
    })
    expect(openai.statusCode).toBe(200)
    expect(onProviderUpdate).toHaveBeenLastCalledWith(
      'openai', '', 'gpt-4.1', undefined, { maxConcurrency: 3 }, expect.objectContaining({ actor: 'api' }),
    )

    const local = await app.inject({
      method: 'PUT', url: '/api/v1/settings/providers/local',
      payload: { model: 'llama3' },
    })
    expect(local.statusCode).toBe(200)
    expect(onProviderUpdate).toHaveBeenLastCalledWith('local', '', 'llama3', undefined, undefined, expect.objectContaining({ actor: 'api' }))

    const empty = await app.inject({
      method: 'PUT', url: '/api/v1/settings/providers/openai', payload: {},
    })
    expect(empty.statusCode).toBe(400)

    const unconfigured = await app.inject({
      method: 'PUT', url: '/api/v1/settings/providers/claude', payload: { model: 'claude-test' },
    })
    expect(unconfigured.statusCode).toBe(400)

    const vertexGemini = await app.inject({
      method: 'PUT', url: '/api/v1/settings/providers/gemini', payload: { model: 'gemini-test' },
    })
    expect(vertexGemini.statusCode).toBe(200)
    expect(onProviderUpdate).toHaveBeenLastCalledWith('gemini', '', 'gemini-test', undefined, undefined, expect.objectContaining({ actor: 'api' }))
  })

  it('preserves project model overrides but cannot select a generic route for tracking or research', async () => {
    const nativeProject = {
      displayName: 'Example', canonicalDomain: 'example.com', country: 'US', language: 'en',
      providers: ['openai', 'local'], providerModels: { openai: 'gpt-4.1', local: 'llama3' },
    }
    const created = await app.inject({ method: 'PUT', url: '/api/v1/projects/example', payload: nativeProject })
    expect(created.statusCode).toBe(201)
    const changed = await app.inject({
      method: 'PUT', url: '/api/v1/projects/example',
      payload: { ...nativeProject, researchProvider: 'route:example' },
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toMatchObject({ providers: nativeProject.providers, providerModels: nativeProject.providerModels })
    expect(changed.json()).not.toHaveProperty('researchProvider')

    const tracked = await app.inject({
      method: 'PUT', url: '/api/v1/projects/example', payload: { ...nativeProject, providers: ['route:example'] },
    })
    expect(tracked.statusCode).toBe(400)
    const research = await app.inject({
      method: 'POST', url: '/api/v1/projects/example/research/runs',
      payload: { queries: ['example query'], provider: 'route:example' },
    })
    expect(research.statusCode).toBe(400)
    const loaded = await app.inject({ method: 'GET', url: '/api/v1/projects/example' })
    expect(loaded.json()).toMatchObject({ providers: nativeProject.providers, providerModels: nativeProject.providerModels })
  })
})
