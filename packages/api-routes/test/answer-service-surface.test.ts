import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { answerServiceCatalogFields, settingsDtoSchema } from '@canonry/canonry-contracts'
import { apiKeys, createClient, migrate, projects, queries, researchRunQueries, researchRuns } from '@canonry/canonry-db'
import { createFakeAnswerServiceAdapter, FAKE_SERVICE_ID, fakeServiceDescriptor } from '@canonry/canonry-provider-answer-services/testing'
import { apiRoutes, type ApiRoutesOptions } from '../src/index.js'
import type { ProviderAdapterInfo } from '../src/settings.js'
import { hashApiKey } from '../src/auth.js'

const CITED = `${FAKE_SERVICE_ID}:cited`
const RESULTS = `${FAKE_SERVICE_ID}:results`

/** The description a host publishes for the fake service, built the way the server builds it. */
function fakeServiceInfo(): ProviderAdapterInfo {
  const adapter = createFakeAnswerServiceAdapter()
  return {
    name: adapter.name, displayName: adapter.displayName, mode: 'api', modelConfigurable: false,
    defaultModel: adapter.modelRegistry.defaultModel, knownModels: adapter.modelRegistry.knownModels,
    modelValidationPattern: adapter.modelRegistry.validationPattern, modelValidationHint: adapter.modelRegistry.validationHint,
    kind: adapter.kind!, capabilities: adapter.capabilities!, routes: adapter.routes!,
    ...answerServiceCatalogFields(fakeServiceDescriptor),
  }
}

const openai: ProviderAdapterInfo = {
  name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-4.1',
  knownModels: [{ id: 'gpt-4.1', displayName: 'GPT-4.1', tier: 'standard' }], modelValidationPattern: /^gpt-[\w.-]+$/, modelValidationHint: 'gpt model',
}

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(fn => fn()))

async function harness(options: Partial<ApiRoutesOptions> & { projectProviders?: string[] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-answer-service-'))
  const db = createClient(path.join(dir, 'test.db')); migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({ id: 'alpha', name: 'alpha', displayName: 'Alpha', canonicalDomain: 'alpha.example', country: 'US', language: 'en', providers: options.projectProviders ?? [], createdAt: now, updatedAt: now }).run()
  const onProviderUpdate = vi.fn((name: string) => ({ name, configured: true }))
  const requested: string[] = []
  const onRunCreated = vi.fn()
  const app = Fastify()
  const { projectProviders: _ignored, ...rest } = options
  app.register(apiRoutes, {
    db, skipAuth: true, onProviderUpdate, onRunCreated,
    onResearchRunRequested: id => requested.push(id),
    providerSummary: [{ name: 'openai', configured: true }, { name: FAKE_SERVICE_ID, configured: true, kind: 'answer-service' }],
    providerAdapters: [openai, fakeServiceInfo()],
    getRunnableProviderNames: () => ['openai', FAKE_SERVICE_ID],
    getEffectiveProviderModels: () => ({ openai: 'gpt-4.1' }),
    ...rest,
  } satisfies ApiRoutesOptions)
  await app.ready()
  cleanups.push(() => { void app.close(); db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { app, db, onProviderUpdate, requested, onRunCreated }
}

describe('settings catalog from the descriptor', () => {
  it('lists the connection and one entry per profile, and leaves engine entries unchanged', async () => {
    const { app } = await harness()
    const response = await app.inject({ method: 'GET', url: '/api/v1/settings' })
    expect(response.statusCode).toBe(200)
    const settings = settingsDtoSchema.parse(response.json())
    const byName = Object.fromEntries(settings.providerCatalog.map(entry => [entry.name, entry]))
    expect(Object.keys(byName)).toEqual(['openai', FAKE_SERVICE_ID, CITED, RESULTS, `${FAKE_SERVICE_ID}:stream`, `${FAKE_SERVICE_ID}:job`])
    // An answer engine's entry gains no new fields.
    expect(Object.keys(response.json().providerCatalog[0]).sort()).toEqual(['defaultModel', 'displayName', 'knownModels', 'mode', 'modelConfigurable', 'modelValidationHint', 'modelValidationPattern', 'name'])
    expect(byName[FAKE_SERVICE_ID]).toMatchObject({
      kind: 'answer-service', connection: FAKE_SERVICE_ID, selectionKind: 'profile', modelConfigurable: false, textGeneration: false, workflows: [],
      settingsFields: [{ key: 'apiKey', kind: 'secret', required: true, env: 'FAKE_ANSWERS_API_KEY', label: 'API key' }],
      keyCheck: 'saved-not-verified', vendorDocsUrl: 'https://fake-answers.example/docs',
    })
    expect(byName[FAKE_SERVICE_ID]!.profiles!.map(profile => profile.route)).toEqual([CITED, RESULTS, `${FAKE_SERVICE_ID}:stream`, `${FAKE_SERVICE_ID}:job`])
    expect(byName[CITED]).toMatchObject({
      kind: 'answer-service', connection: FAKE_SERVICE_ID, selectionKind: null, displayName: 'Cited · Fake Answers', defaultModel: 'cited',
      workflows: ['research', 'snapshot', 'visibility-sweep'], textGeneration: false,
    })
    expect(byName[CITED]!.settingsFields).toBeUndefined()
    expect(byName[RESULTS]!.profiles![0]!.evidence).toMatchObject({ citationBasis: 'none', citationMeasurable: false })
  })

  it('accepts only a key for an answer service', async () => {
    const { app, onProviderUpdate } = await harness()
    const baseUrl = await app.inject({ method: 'PUT', url: `/api/v1/settings/providers/${FAKE_SERVICE_ID}`, payload: { apiKey: 'k', baseUrl: 'https://elsewhere.example' } })
    expect(baseUrl.statusCode).toBe(400)
    expect(baseUrl.json().error.message).toBe('Fake Answers uses a fixed endpoint; baseUrl is not accepted.')
    const model = await app.inject({ method: 'PUT', url: `/api/v1/settings/providers/${FAKE_SERVICE_ID}`, payload: { model: 'cited' } })
    expect(model.statusCode).toBe(400)
    expect(onProviderUpdate).not.toHaveBeenCalled()
    const key = await app.inject({ method: 'PUT', url: `/api/v1/settings/providers/${FAKE_SERVICE_ID}`, payload: { apiKey: 'new-key' } })
    expect(key.statusCode).toBe(200)
    expect(onProviderUpdate).toHaveBeenCalledWith(FAKE_SERVICE_ID, 'new-key', undefined, undefined, undefined, expect.anything())
  })
})

describe('project engine selection', () => {
  it('saves a sweep-eligible profile and refuses the bare connection and a profile that cannot sweep', async () => {
    const { app } = await harness()
    const put = (providers: string[]) => app.inject({ method: 'PUT', url: '/api/v1/projects/alpha', payload: { displayName: 'Alpha', canonicalDomain: 'alpha.example', country: 'US', language: 'en', providers } })
    const bare = await put(['openai', FAKE_SERVICE_ID])
    expect(bare.statusCode).toBe(400)
    expect(bare.json().error.details.invalidProviders).toEqual([FAKE_SERVICE_ID])
    const researchOnly = await put(['openai', RESULTS])
    expect(researchOnly.statusCode).toBe(400)
    expect(researchOnly.json().error.details.invalidProviders).toEqual([RESULTS])
    const saved = await put(['openai', CITED])
    expect(saved.statusCode).toBe(200)
    expect(saved.json().providers).toEqual(['openai', CITED])
  })

  it('needs settings authority to add a profile, like choosing an OpenRouter model', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-answer-service-scope-'))
    const db = createClient(path.join(dir, 'test.db')); migrate(db)
    const now = new Date().toISOString()
    db.insert(projects).values({ id: 'alpha', name: 'alpha', displayName: 'Alpha', canonicalDomain: 'alpha.example', country: 'US', language: 'en', providers: ['openai'], createdAt: now, updatedAt: now }).run()
    db.insert(apiKeys).values({ id: 'k', name: 'writer', keyHash: hashApiKey('cnry_writer'), keyPrefix: 'cnry_wri', scopes: ['projects.write'], createdAt: now }).run()
    const app = Fastify()
    app.register(apiRoutes, { db, providerAdapters: [openai, fakeServiceInfo()], getRunnableProviderNames: () => ['openai', FAKE_SERVICE_ID] } satisfies ApiRoutesOptions)
    await app.ready()
    try {
      const response = await app.inject({
        method: 'PUT', url: '/api/v1/projects/alpha', headers: { authorization: 'Bearer cnry_writer' },
        payload: { displayName: 'Alpha', canonicalDomain: 'alpha.example', country: 'US', language: 'en', providers: ['openai', CITED] },
      })
      expect(response.statusCode).toBe(403)
      expect(db.select({ providers: projects.providers }).from(projects).where(eq(projects.id, 'alpha')).get()!.providers).toEqual(['openai'])
    } finally {
      await app.close(); db.$client.close(); fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('research with an answer service connected', () => {
  it('never defaults to the service and runs a profile only when named', async () => {
    const { app, db, requested } = await harness({ projectProviders: [CITED] })
    // The project saved the profile for sweeps; research still defaults to an answer engine.
    const implicit = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { queries: ['best roofer'] } })
    expect(implicit.statusCode).toBe(202)
    expect(implicit.json()).toMatchObject({ provider: 'openai' })
    const explicit = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { queries: ['best roofer'], provider: RESULTS } })
    expect(explicit.statusCode).toBe(202)
    expect(explicit.json()).toMatchObject({ provider: RESULTS, resolvedModel: 'results' })
    const bare = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { queries: ['best roofer'], provider: FAKE_SERVICE_ID } })
    expect(bare.statusCode).toBe(400)
    expect(requested).toHaveLength(2)
    expect(db.select({ provider: researchRuns.provider }).from(researchRuns).all().map(row => row.provider).sort()).toEqual([RESULTS, 'openai'])
  })

  it('offers each research profile as an option with its identity, and never the bare connection', async () => {
    const { app } = await harness()
    const list = await app.inject({ method: 'GET', url: '/api/v1/projects/alpha/research/runs' })
    const providers = list.json().providers as Array<{ name: string; kind?: string; connection?: string; selectionKind?: string | null; profiles?: Array<{ id: string }> }>
    expect(providers.map(option => option.name)).toEqual(['openai', CITED, RESULTS, `${FAKE_SERVICE_ID}:stream`, `${FAKE_SERVICE_ID}:job`])
    expect(providers[0]).not.toHaveProperty('kind')
    expect(providers.find(option => option.name === RESULTS)).toMatchObject({ kind: 'answer-service', connection: FAKE_SERVICE_ID, selectionKind: 'profile', profiles: [{ id: 'results' }] })
  })

  it('returns stored evidence and citation measurability only for rows that recorded evidence', async () => {
    const { app, db } = await harness()
    const now = new Date().toISOString()
    const evidence = { version: 1, citationMeasurable: false, citationBasis: 'none' }
    db.insert(researchRuns).values({ id: 'r', projectId: 'alpha', status: 'completed', provider: RESULTS, resolvedModel: 'results', totalQueries: 2, completedQueries: 2, failedQueries: 0, createdAt: now }).run()
    db.insert(researchRunQueries).values({ id: 'q1', researchRunId: 'r', position: 0, queryText: 'a', status: 'completed', resolvedModel: 'results', answerText: 'x', groundingSources: [], citedDomains: [], searchQueries: [], answerMentioned: false, citationState: null, answerEvidence: evidence as never, createdAt: now }).run()
    db.insert(researchRunQueries).values({ id: 'q2', researchRunId: 'r', position: 1, queryText: 'b', status: 'completed', resolvedModel: 'results', answerText: 'x', groundingSources: [], citedDomains: [], searchQueries: [], answerMentioned: false, citationState: 'not-cited', createdAt: now }).run()
    const detail = (await app.inject({ method: 'GET', url: '/api/v1/projects/alpha/research/runs/r' })).json()
    expect(detail.queries[0]).toMatchObject({ evidence, citationMeasured: false, citationState: null })
    expect(detail.queries[1]).not.toHaveProperty('evidence')
    expect(detail.queries[1]).not.toHaveProperty('citationMeasured')
  })
})

describe('runs with an answer service connected', () => {
  it('refuses an "all configured" run when the only configured provider is an answer service', async () => {
    const { app, db, onRunCreated } = await harness({ getRunnableProviderNames: () => [FAKE_SERVICE_ID] })
    db.insert(queries).values({ id: 'q', projectId: 'alpha', query: 'best roofer', createdAt: new Date().toISOString() }).run()
    const run = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/runs', payload: {} })
    expect(run.statusCode).toBe(503)
    expect(run.json().error).toMatchObject({ code: 'NO_PROVIDER', details: { availableProviders: [FAKE_SERVICE_ID], selectedProviders: [], selectionSource: 'instance' } })
    expect(onRunCreated).not.toHaveBeenCalled()
  })

  it('runs an explicitly requested profile through its configured connection', async () => {
    const { app, db, onRunCreated } = await harness({ getRunnableProviderNames: () => [FAKE_SERVICE_ID] })
    db.insert(queries).values({ id: 'q', projectId: 'alpha', query: 'best roofer', createdAt: new Date().toISOString() }).run()
    const run = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/runs', payload: { providers: [CITED] } })
    expect(run.statusCode, run.body).toBe(201)
    expect(onRunCreated).toHaveBeenCalledWith(expect.any(String), 'alpha', [CITED], undefined)
  })
})
