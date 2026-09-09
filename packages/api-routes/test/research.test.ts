import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, queries, researchRuns, runs } from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'
import { ResearchRunStatuses } from '@ainyc/canonry-contracts'
import { apiRoutes, type ApiRoutesOptions } from '../src/index.js'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(fn => fn()))

function harness(options: Partial<ApiRoutesOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-research-'))
  const db = createClient(path.join(dir, 'test.db')); migrate(db)
  const now = new Date().toISOString()
  for (const name of ['alpha', 'beta']) db.insert(projects).values({ id: name, name, displayName: name, canonicalDomain: `${name}.com`, country: 'US', language: 'en', providers: ['openai'], locations: [{ label: 'New York', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: 'New York', createdAt: now, updatedAt: now }).run()
  const app = Fastify(); const requested: string[] = []
  app.register(apiRoutes, { db, skipAuth: true, onResearchRunRequested: id => requested.push(id), providerSummary: [{ name: 'openai', configured: true }], providerAdapters: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-4.1', knownModels: [{ id: 'gpt-4.1', displayName: 'GPT-4.1', tier: 'standard' }], modelValidationPattern: /^gpt-[\w.-]+$/, modelValidationHint: 'gpt model' }], ...options } satisfies ApiRoutesOptions)
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { app, db, requested }
}

describe('research routes', () => {
  it('persists an isolated batch, lists/details it, and protects retry/project boundaries', async () => {
    const { app, db, requested } = harness()
    const payload = { queries: ['best solar installer', 'solar cost'], provider: 'openai', model: 'gpt-4.1', location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' }, idempotencyKey: 'retry-1' }
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload })
    expect(created.statusCode).toBe(202); const body = created.json(); expect(body.queries).toHaveLength(2); expect(body.queries[0]).toMatchObject({ namedCompetitors: [], citedCompetitorDomains: [] }); expect(requested).toHaveLength(1)
    expect(db.select().from(queries).all()).toHaveLength(0); expect(db.select().from(runs).all()).toHaveLength(0)
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/alpha/research/runs' })).json().runs).toHaveLength(1)
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/beta/research/runs/${body.id}` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload })).statusCode).toBe(200)
    expect(requested).toEqual([body.id, body.id])
    db.update(researchRuns).set({ status: ResearchRunStatuses.running }).run()
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload })).statusCode).toBe(200)
    expect(requested).toEqual([body.id, body.id])
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, queries: ['different'] } })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, idempotencyKey: undefined, queries: ['same', 'same'] } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, idempotencyKey: undefined, provider: 'claude' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, idempotencyKey: undefined, model: 'not-a-gpt-model' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, idempotencyKey: undefined, location: { ...payload.location, city: 'Boston' } } })).statusCode).toBe(400)
    expect(db.select().from(researchRuns).all()).toHaveLength(1)
  })

  it('rejects an unavailable executor before creating research rows', async () => {
    const { db } = harness()
    const app = Fastify()
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      providerSummary: [{ name: 'openai', configured: true }],
      providerAdapters: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-4.1', knownModels: [{ id: 'gpt-4.1', displayName: 'GPT-4.1', tier: 'standard' }], modelValidationPattern: /^gpt-[\w.-]+$/, modelValidationHint: 'gpt model' }],
    } satisfies ApiRoutesOptions)
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { queries: ['test'], provider: 'openai' } })
    expect(response.statusCode).toBe(422)
    expect(db.select().from(researchRuns).all()).toHaveLength(0)
  })
})


describe('research model defaults', () => {
  it('uses the same instance model as visibility, then project and explicit overrides', async () => {
    const { app, db } = harness({ getEffectiveProviderModels: () => ({ openai: 'gpt-instance' }) })
    const readDefault = async () => (await app.inject({ method: 'GET', url: '/api/v1/projects/alpha/research/runs' })).json().providers[0].defaultModel
    const create = (model?: string) => app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { queries: ['test'], provider: 'openai', ...(model ? { model } : {}) } })
    expect(await readDefault()).toBe('gpt-instance')
    expect((await create()).json()).toMatchObject({ requestedModel: null, resolvedModel: 'gpt-instance' })
    db.update(projects).set({ providerModels: { openai: 'gpt-project' } }).where(eq(projects.id, 'alpha')).run()
    expect(await readDefault()).toBe('gpt-project')
    expect((await create()).json()).toMatchObject({ requestedModel: null, resolvedModel: 'gpt-project' })
    expect((await create('gpt-override')).json()).toMatchObject({ requestedModel: 'gpt-override', resolvedModel: 'gpt-override' })
  })

  it('publishes dynamic models to research and settings without changing defaults', async () => {
    const models = [{ id: 'gpt-new', displayName: 'New GPT', tier: 'standard' as const }]
    const { app } = harness({ getProviderModels: async () => models, getEffectiveProviderModels: () => ({ openai: 'gpt-instance' }) })
    const research = (await app.inject({ method: 'GET', url: '/api/v1/projects/alpha/research/runs' })).json()
    expect(research.providers[0]).toMatchObject({ defaultModel: 'gpt-instance', knownModels: [{ id: 'gpt-instance' }, { id: 'gpt-new' }] })
    const settings = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json()
    expect(settings.providerCatalog[0].knownModels).toEqual(models)
  })
})


describe('model catalog fallback', () => {
  it('retains bundled choices for an unconfigured provider without attempting discovery', async () => {
    const lookedUp: string[] = []
    const { app } = harness({
      providerSummary: [{ name: 'openai', configured: false }],
      getProviderModels: async name => { lookedUp.push(name); return [] },
    })
    const response = await app.inject({ method: 'GET', url: '/api/v1/settings' })
    expect(response.statusCode).toBe(200)
    expect(response.json().providerCatalog[0].knownModels).toMatchObject([{ id: 'gpt-4.1' }])
    expect(lookedUp).toEqual([])
    await app.close()
  })

  it('retains bundled choices for an empty discovered catalog', async () => {
    const { app } = harness({ getProviderModels: async () => [], getEffectiveProviderModels: () => ({ openai: 'gpt-instance' }) })
    const settings = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json()
    const research = (await app.inject({ method: 'GET', url: '/api/v1/projects/alpha/research/runs' })).json()
    expect(settings.providerCatalog[0].knownModels).toMatchObject([{ id: 'gpt-4.1' }])
    expect(research.providers[0].knownModels).toMatchObject([{ id: 'gpt-instance' }, { id: 'gpt-4.1' }])
    await app.close()
  })
})
