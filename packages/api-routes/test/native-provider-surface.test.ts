import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { parseMeasurementRunManifestV1 } from '@canonry/canonry-contracts'
import { createClient, migrate, projects, queries, runs, type DatabaseClient } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'
import { buildOpenApiDocument } from '../src/openapi.js'

describe('native provider surface', () => {
  let app: ReturnType<typeof Fastify>
  let directory: string
  let db: DatabaseClient
  const onProviderUpdate = vi.fn((name: string) => ({ name, configured: true }))

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-native-provider-surface-'))
    db = createClient(path.join(directory, 'test.db'))
    migrate(db)
    onProviderUpdate.mockClear()
    app = Fastify()
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      onProviderUpdate,
      providerSummary: [
        { name: 'openai', configured: true },
        { name: 'openrouter', configured: true },
        { name: 'local', configured: true },
        { name: 'claude', configured: false },
        { name: 'gemini', configured: false, vertexConfigured: true },
      ],
      providerAdapters: ['openai', 'local', 'claude', 'gemini', 'openrouter'].map(name => ({
        name, displayName: name, mode: 'api' as const, modelConfigurable: true,
        defaultModel: name === 'openai' ? 'gpt-4.1' : 'llama3', knownModels: name === 'openrouter' ? [{ id: 'google/gemini-2.5-flash', displayName: 'Gemini Flash', tier: 'fast' as const }] : [],
        modelValidationPattern: /.+/, modelValidationHint: 'nonempty model',
      })),
      onResearchRunRequested: vi.fn(),
      onRunCreated: vi.fn(),
      getRunnableProviderNames: () => ['openai', 'openrouter'],
      getEffectiveProviderModels: () => ({ openai: 'gpt-4.1', openrouter: 'google/gemini-2.5-flash' }),
    })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    db.$client.close()
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
    expect(settings.json().providerCatalog.filter((provider: { name: string }) => !provider.name.startsWith('openrouter')).map((provider: { name: string }) => provider.name)).toEqual(['openai', 'local', 'claude', 'gemini'])
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

  it('offers pinned OpenRouter model routes through the existing settings catalog', async () => {
    const settings = await app.inject({ method: 'GET', url: '/api/v1/settings' })
    expect(settings.json().providerCatalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'openrouter', knownModels: [{ id: 'google/gemini-2.5-flash', displayName: 'Gemini Flash', tier: 'fast' }] }),
      expect.objectContaining({ name: 'openrouter:google/gemini-2.5-flash', defaultModel: 'google/gemini-2.5-flash', modelConfigurable: false }),
    ]))
    expect(settings.json().providers.filter((provider: { name: string }) => provider.name.startsWith('openrouter'))).toEqual([{ name: 'openrouter', configured: true }])
  })

  it('selects direct and multiple routed models and freezes each model in an Advanced sweep', async () => {
    const providers = ['openai', 'openrouter:google/gemini-2.5-flash', 'openrouter:anthropic/claude-sonnet-4.6']
    const project = await app.inject({ method: 'PUT', url: '/api/v1/projects/routes', payload: {
      displayName: 'Example', canonicalDomain: 'example.com', country: 'US', language: 'en', providers,
    } })
    expect(project.statusCode, project.body).toBe(201)
    const added = await app.inject({ method: 'POST', url: '/api/v1/projects/routes/queries', payload: { queries: ['best widget shop'] } })
    expect(added.statusCode, added.body).toBe(200)
    const simple = await app.inject({ method: 'POST', url: '/api/v1/projects/routes/runs', payload: { providers } })
    expect(simple.statusCode, simple.body).toBe(201)
    db.update(runs).set({ status: 'completed' }).where(eq(runs.id, simple.json().id as string)).run()
    const queryId = db.select({ id: queries.id }).from(queries).get()!.id
    const published = await app.inject({ method: 'PUT', url: '/api/v1/projects/routes/measurement-plan', payload: {
      expectedActiveRevision: null,
      plan: {
        schemaVersion: 1,
        targets: [{ stableKey: 'widget', label: 'Widget', aliases: ['Widget'], urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/widgets', pathCase: 'insensitive' }] }],
        groups: [{ stableKey: 'all', label: 'All', targetKeys: ['widget'] }],
        targetQuerySelections: [{ targetKey: 'widget', queryIds: [queryId] }],
      },
    } })
    expect(published.statusCode, published.body).toBe(201)
    const triggered = await app.inject({ method: 'POST', url: '/api/v1/projects/routes/runs', payload: { providers } })
    expect(triggered.statusCode, triggered.body).toBe(201)
    const run = db.select().from(runs).where(eq(runs.id, triggered.json().id as string)).get()!
    const slots = parseMeasurementRunManifestV1(run.measurementManifest).expectedSlots
    expect(slots.map(slot => [slot.provider, slot.requestedModel]).sort()).toEqual([
      ['openai', 'gpt-4.1'],
      ['openrouter:anthropic/claude-sonnet-4.6', 'anthropic/claude-sonnet-4.6'],
      ['openrouter:google/gemini-2.5-flash', 'google/gemini-2.5-flash'],
    ])
    expect(db.select().from(projects).get()!.providers).toEqual(providers)
  })

  it('refuses a connection-only sweep selection and conflicting model overrides before writing', async () => {
    const project = { displayName: 'Example', canonicalDomain: 'example.com', country: 'US', language: 'en' }
    for (const providers of [['openrouter'], ['openrouter:openrouter/auto'], ['openrouter:typesafe/jev-1.13']]) {
      const result = await app.inject({ method: 'PUT', url: '/api/v1/projects/invalid', payload: { ...project, providers } })
      expect(result.statusCode, result.body).toBe(400)
    }
    const conflict = await app.inject({ method: 'PUT', url: '/api/v1/projects/invalid', payload: {
      ...project, providers: ['openrouter:google/gemini-2.5-flash'], providerModels: { 'openrouter:google/gemini-2.5-flash': 'openai/gpt-5' },
    } })
    expect(conflict.statusCode, conflict.body).toBe(400)
    expect(db.select().from(projects).all()).toEqual([])
  })
})
