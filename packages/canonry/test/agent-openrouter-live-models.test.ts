/**
 * Aero, analysis and classification on OpenRouter take their models from the
 * catalog Canonry already caches for sweeps, so a model OpenRouter adds after
 * the installed pi-ai version needs no code change.
 *
 * No network: `fetch` is stubbed. OpenRouter's `GET /api/v1/models` answers
 * with entries in the shape OpenRouter documents
 * (https://openrouter.ai/docs/api-reference/models/get-models), one list per
 * bearer key; any other request gets a 404. Every OpenRouter request is
 * recorded, so an unexpected call shows up in the request assertions.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { normalizeContext } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { AgentProviderId, LlmCapability, ProviderConfig } from '@canonry/canonry-contracts'
import { agentSessions, createClient, migrate, projects } from '@canonry/canonry-db'
import { openrouterAdapter } from '@canonry/canonry-provider-openrouter'
import { aeroModels, aeroStreamFn, completeOnce, openRouterModels } from '../src/agent/pi-models.js'
import {
  AGENT_MODEL_CHOICES,
  AGENT_PROVIDERS,
  buildAgentProvidersResponse,
  isAgentModelAvailable,
  refreshAgentModels,
  resolveModelForCapability,
  resolveModelForProvider,
} from '../src/agent/providers.js'
import { describeAgentPin } from '../src/agent/session.js'
import { SessionRegistry } from '../src/agent/session-registry.js'
import type { ApiClient } from '../src/client.js'
import type { CanonryConfig } from '../src/config.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'
import { createProviderModelCatalog } from '../src/provider-model-catalog.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { createServer } from '../src/server.js'
import { openRouterCompletionsReply } from './openrouter-pi-fixture.js'

const MODELS_URL = 'https://openrouter.ai/api/v1/models'
const KEY_A = 'or-key-a'
const KEY_B = 'or-key-b'
/** Released after the bundled pi-ai catalog: only the live catalog has it. */
const FRESH = 'canonrytest/released-after-pi-1'
const NO_TOOLS = 'canonrytest/no-tools-1'
const SECOND_KEY_ONLY = 'canonrytest/second-key-1'
/** In pi-ai's bundled list on Anthropic's messages API. */
const SONNET = 'anthropic/claude-sonnet-5.5'
/** The OpenRouter default for every tier, in pi-ai's bundled list. */
const LUNA = 'openai/gpt-6-luna'
const UNLISTED = 'canonrytest/not-listed-1'
const notInList = (id: string) => `OpenRouter model '${id}' is not in OpenRouter's model list. Check the ID against the OpenRouter catalog, or pick a model from the Aero model list.`

/** One `GET /api/v1/models` entry in the shape OpenRouter documents. */
function catalogEntry(id: string, name: string, opts: { parameters?: string[]; contextLength?: number; prompt?: string; completion?: string } = {}) {
  const contextLength = opts.contextLength ?? 400_000
  return {
    id, canonical_slug: id, name, created: 1790000000, description: `${name}.`, context_length: contextLength,
    architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'Other', instruct_type: null },
    pricing: { prompt: opts.prompt ?? '0.0000005', completion: opts.completion ?? '0.000002', request: '0', image: '0', web_search: '0', internal_reasoning: '0', input_cache_read: '0.00000005' },
    top_provider: { context_length: contextLength, max_completion_tokens: 64_000, is_moderated: false },
    per_request_limits: null,
    supported_parameters: opts.parameters ?? ['max_tokens', 'temperature', 'tools', 'tool_choice', 'reasoning', 'include_reasoning'],
  }
}

const LIST_A = [
  catalogEntry(FRESH, 'Canonry Test: Released After Pi'),
  catalogEntry(NO_TOOLS, 'Canonry Test: No Tools', { parameters: ['max_tokens', 'temperature'] }),
  // pi-ai's bundled list has this model; the catalog's figures differ on purpose.
  catalogEntry(SONNET, 'Anthropic: Claude Sonnet 5.5 (catalog)', { contextLength: 123_456, prompt: '0.00009', completion: '0.00009' }),
]
const LIST_B = [catalogEntry(SECOND_KEY_ONLY, 'Canonry Test: Second Key')]

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }
const connection = (apiKey: string): ProviderConfig => ({ provider: 'openrouter', apiKey, quotaPolicy })

/** Stubs OpenRouter's model catalog per key and records every request. */
function stubCatalog(lists: Record<string, unknown[]>): Array<{ url: string; key: string | null }> {
  const requests: Array<{ url: string; key: string | null }> = []
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init)
    const key = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null
    // Every OpenRouter request is recorded; the server's own update check is not ours to count.
    if (new URL(request.url).hostname === 'openrouter.ai') requests.push({ url: request.url, key })
    const list = key ? lists[key] : undefined
    if (request.url !== MODELS_URL || !list) return Response.json({ error: { code: 404, message: 'Not stubbed' } }, { status: 404 })
    return Response.json({ data: list })
  })
  return requests
}

/** The shared catalog `server.ts` builds, connected the way it connects it. */
function connectCatalog(apiKey: string): ProviderRegistry {
  const registry = new ProviderRegistry()
  registry.register(openrouterAdapter, connection(apiKey))
  const catalog = createProviderModelCatalog(registry)
  onTestFinished(openRouterModels.connect({ read: () => catalog('openrouter'), cached: () => catalog.cached('openrouter') }))
  return registry
}

function tempDatabase(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'test.db')
  const db = createClient(file)
  migrate(db)
  return { db, file }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/** A project row for session tests. */
function seedProject(db: ReturnType<typeof createClient>, name: string): void {
  const now = new Date().toISOString()
  db.insert(projects).values({ id: crypto.randomUUID(), name, displayName: name, canonicalDomain: `${name}.example.com`, country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
}

describe('Aero OpenRouter models follow the shared catalog', () => {
  it('makes a model pi-ai lacks resolvable after a refresh and calls it through pi\'s OpenRouter completions transport', async () => {
    const requests = stubCatalog({ [KEY_A]: LIST_A })
    connectCatalog(KEY_A)
    expect(() => resolveModelForProvider('openrouter', FRESH)).toThrow(`OpenRouter model '${FRESH}' is not in OpenRouter's model list.`)

    await refreshAgentModels('openrouter')

    const model = resolveModelForProvider('openrouter', FRESH)
    expect(model).toEqual({
      type: 'chat', id: FRESH, name: 'Canonry Test: Released After Pi', api: 'openai-completions', provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1', reasoning: true, thinkingLevelMap: { off: null }, input: ['text', 'image'],
      cost: { input: 0.5, output: 2, cacheRead: 0.05, cacheWrite: 0 }, contextWindow: 400_000, maxTokens: 64_000,
    })
    expect(requests).toEqual([{ url: MODELS_URL, key: KEY_A }])

    onTestFinished(resetSharedProviderExecutionGates)
    const sent: Array<{ url: string; authorization: string | null; model: unknown }> = []
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init)
      sent.push({ url: request.url, authorization: request.headers.get('authorization'), model: (await request.json() as { model?: unknown }).model })
      return new Response(openRouterCompletionsReply(FRESH, 'Live answer.'), { headers: { 'content-type': 'text/event-stream' } })
    })
    const reply = await completeOnce(model, { messages: [{ role: 'user', content: 'Synthetic question.', timestamp: 1 }] }, { apiKey: KEY_A })
    expect(sent).toEqual([{ url: 'https://openrouter.ai/api/v1/chat/completions', authorization: `Bearer ${KEY_A}`, model: FRESH }])
    expect(reply).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'Live answer.' }] })
    // Priced from the catalog: 10 input tokens at $0.50/M plus 4 output tokens at $2/M.
    expect(reply.usage.cost.total).toBeCloseTo(0.000013, 12)
  })

  it('keeps pi-ai\'s bundled definition for a model both lists carry', async () => {
    stubCatalog({ [KEY_A]: LIST_A })
    connectCatalog(KEY_A)
    await refreshAgentModels('openrouter')
    const bundled = builtinModels().getModel('openrouter', SONNET)
    expect(bundled?.api).toBe('anthropic-messages')
    expect(resolveModelForProvider('openrouter', SONNET)).toEqual(bundled)
  })

  it('sends no reasoning field with thinking off for a live-only reasoning model, and leaves pi-ai\'s bundled models as pi tuned them', async () => {
    stubCatalog({ [KEY_A]: [catalogEntry(FRESH, 'Canonry Test: Released After Pi'), catalogEntry(LUNA, 'OpenAI: GPT-6 Luna (catalog)')] })
    connectCatalog(KEY_A)
    await refreshAgentModels('openrouter')

    onTestFinished(resetSharedProviderExecutionGates)
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = await new Request(input, init).json() as Record<string, unknown>
      bodies.push(body)
      return new Response(openRouterCompletionsReply(String(body.model), 'Answer.'), { headers: { 'content-type': 'text/event-stream' } })
    })
    // An Aero turn with thinking off: pi-agent-core passes no reasoning level.
    const context = normalizeContext({ messages: [{ role: 'user', content: 'Synthetic question.', timestamp: 1 }] })
    for (const id of [FRESH, LUNA]) {
      const stream = await aeroStreamFn(resolveModelForProvider('openrouter', id), context, { apiKey: KEY_A })
      expect(await stream.result()).toMatchObject({ stopReason: 'stop' })
    }

    expect(bodies.map(body => body.model)).toEqual([FRESH, LUNA])
    // The catalog marks FRESH as taking reasoning controls; OpenRouter picks its default.
    expect(bodies[0]).not.toHaveProperty('reasoning')
    // pi-ai's own definition maps thinking off to effort "none" for this model, and that stands.
    expect(builtinModels().getModel('openrouter', LUNA)?.thinkingLevelMap?.off).toBe('none')
    expect(bodies[1]).toHaveProperty('reasoning', { effort: 'none' })
  })

  it('offers each provider its short model list rather than the live catalog, while any catalog model can still be named', async () => {
    stubCatalog({ [KEY_A]: LIST_A })
    connectCatalog(KEY_A)
    await refreshAgentModels('openrouter')
    const response = buildAgentProvidersResponse({ providers: { openrouter: { apiKey: KEY_A } } }, { models: true })
    for (const provider of response.providers) {
      expect(provider.models?.map(model => model.id), provider.id).toEqual(AGENT_MODEL_CHOICES[provider.id])
      expect(provider.models?.[0]?.id).toBe(provider.defaultModel)
    }
    expect(response.providers.find(provider => provider.id === 'openrouter')?.models).toContainEqual({ id: LUNA, displayName: 'OpenAI: GPT-6 Luna' })
    expect(resolveModelForProvider('openrouter', FRESH).id).toBe(FRESH)
    expect(resolveModelForCapability('openrouter', 'classify', NO_TOOLS).id).toBe(NO_TOOLS)
  })

  it('lists a pinned model first when it is not on the short list', () => {
    const response = buildAgentProvidersResponse({ providers: { openrouter: { apiKey: KEY_A } }, agent: { provider: 'openrouter', model: FRESH } }, { models: true })
    const openrouter = response.providers.find(provider => provider.id === 'openrouter')
    expect(openrouter?.defaultModel).toBe(FRESH)
    expect(openrouter?.models?.map(model => model.id)).toEqual([FRESH, ...AGENT_MODEL_CHOICES.openrouter])
  })

  it('falls back to pi-ai\'s bundled list when the catalog cannot be reached', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => { throw new TypeError('fetch failed') })
    vi.stubGlobal('fetch', fetchMock)
    connectCatalog(KEY_A)
    const pending = refreshAgentModels('openrouter')
    await vi.advanceTimersByTimeAsync(3000)
    await pending

    expect(fetchMock).toHaveBeenCalled()
    expect(aeroModels.getModels('openrouter')).toEqual(builtinModels().getModels('openrouter'))
    expect(resolveModelForProvider('openrouter').id).toBe(LUNA)
    const choices = buildAgentProvidersResponse({}, { models: true }).providers.find(provider => provider.id === 'openrouter')?.models ?? []
    expect(choices).toContainEqual({ id: LUNA, displayName: 'OpenAI: GPT-6 Luna' })
    expect(choices.filter(choice => choice.id.endsWith(':batch') || choice.id.startsWith('~'))).toEqual([])
    for (const choice of choices) expect(isAgentModelAvailable('openrouter', choice.id)).toBe(true)
  })

  it('reads the catalog again only when the shared cache expires', async () => {
    vi.useFakeTimers()
    const requests = stubCatalog({ [KEY_A]: LIST_A })
    connectCatalog(KEY_A)
    await refreshAgentModels('openrouter')
    await refreshAgentModels('openrouter')
    await refreshAgentModels('openrouter')
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    await refreshAgentModels('openrouter')
    expect(requests).toEqual([{ url: MODELS_URL, key: KEY_A }, { url: MODELS_URL, key: KEY_A }])
  })

  it('loads a fresh list when the OpenRouter key changes', async () => {
    const requests = stubCatalog({ [KEY_A]: LIST_A, [KEY_B]: LIST_B })
    const registry = connectCatalog(KEY_A)
    await refreshAgentModels('openrouter')
    expect(isAgentModelAvailable('openrouter', FRESH)).toBe(true)

    registry.register(openrouterAdapter, connection(KEY_B))
    await refreshAgentModels('openrouter')

    expect(isAgentModelAvailable('openrouter', SECOND_KEY_ONLY)).toBe(true)
    expect(isAgentModelAvailable('openrouter', FRESH)).toBe(false)
    expect(requests.map(request => request.key)).toEqual([KEY_A, KEY_B])
  })

  it('runs an Aero turn on a model newer than pi-ai, with no catalog request per turn', async () => {
    const requests = stubCatalog({ [KEY_A]: LIST_A })
    connectCatalog(KEY_A)
    const { db } = tempDatabase('canonry-openrouter-turn-')
    const now = new Date().toISOString()
    db.insert(projects).values({ id: crypto.randomUUID(), name: 'demo', displayName: 'demo', canonicalDomain: 'demo.example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
    const registry = new SessionRegistry({
      db,
      client: {} as unknown as ApiClient,
      config: { apiUrl: 'http://localhost:4100', database: ':memory:', apiKey: 'cnry_test', providers: { openrouter: { apiKey: KEY_A } }, agent: { provider: 'openrouter', model: FRESH } } as CanonryConfig,
    })

    const first = await registry.acquireForTurn('demo')
    expect(first.state.model).toMatchObject({ id: FRESH, api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1' })
    await registry.acquireForTurn('demo')
    expect(requests).toEqual([{ url: MODELS_URL, key: KEY_A }])
  })

  it('keeps a session on its live-only model, without rewriting the row, while the list cannot be loaded', async () => {
    const { db } = tempDatabase('canonry-openrouter-carried-')
    seedProject(db, 'demo')
    // Unpinned: the session's stored model decides when a turn names none.
    const config = { apiUrl: 'http://localhost:4100', database: ':memory:', apiKey: 'cnry_test', providers: { openrouter: { apiKey: KEY_A } } } as CanonryConfig
    const newRegistry = () => new SessionRegistry({ db, client: {} as unknown as ApiClient, config })
    const row = () => db.select().from(agentSessions).get()

    stubCatalog({ [KEY_A]: LIST_A })
    connectCatalog(KEY_A)
    await newRegistry().acquireForTurn('demo', { provider: 'openrouter', modelId: FRESH })
    expect(row()).toMatchObject({ modelProvider: 'openrouter', modelId: FRESH })

    // A restart while OpenRouter refuses every catalog read (HTTP 404): the
    // turn fails naming the model, and the row still holds it.
    const refused = stubCatalog({})
    connectCatalog(KEY_A)
    await expect(newRegistry().acquireForTurn('demo')).rejects.toThrow(notInList(FRESH))
    expect(refused).toEqual([{ url: MODELS_URL, key: KEY_A }])
    expect(row()).toMatchObject({ modelProvider: 'openrouter', modelId: FRESH })

    // Once the catalog answers again, the session resumes on that model.
    stubCatalog({ [KEY_A]: LIST_A })
    connectCatalog(KEY_A)
    expect((await newRegistry().acquireForTurn('demo')).state.model.id).toBe(FRESH)
    expect(row()).toMatchObject({ modelProvider: 'openrouter', modelId: FRESH })
  })

  it('takes the default for a session on a live-only model once no OpenRouter key resolves, so the error names the key rather than the model', async () => {
    const { db } = tempDatabase('canonry-openrouter-no-key-')
    seedProject(db, 'demo')
    const row = () => db.select().from(agentSessions).get()
    stubCatalog({ [KEY_A]: LIST_A })
    connectCatalog(KEY_A)
    const withKey = { apiUrl: 'http://localhost:4100', database: ':memory:', apiKey: 'cnry_test', providers: { openrouter: { apiKey: KEY_A } } } as CanonryConfig
    await new SessionRegistry({ db, client: {} as unknown as ApiClient, config: withKey }).acquireForTurn('demo', { provider: 'openrouter', modelId: FRESH })
    expect(row()).toMatchObject({ modelProvider: 'openrouter', modelId: FRESH })

    // The operator removes the OpenRouter key: no list can load any more.
    onTestFinished(openRouterModels.connect({ cached: () => [], read: async () => [] }))
    const withoutKey = { apiUrl: 'http://localhost:4100', database: ':memory:', apiKey: 'cnry_test', providers: { claude: { apiKey: 'claude-key' } } } as CanonryConfig
    const outcome = await new SessionRegistry({ db, client: {} as unknown as ApiClient, config: withoutKey }).acquireForTurn('demo').then(
      agent => ({ model: agent.state.model.id, error: null as string | null }),
      (error: unknown) => ({ model: null, error: error instanceof Error ? error.message : String(error) }),
    )
    expect(outcome.error ?? '').not.toContain(notInList(FRESH))
    if (outcome.model) expect(outcome.model).toBe(LUNA)
  })

  it('doctor checks an OpenRouter pin against the live list, with the same answer before and after the first OpenRouter turn', async () => {
    const requests = stubCatalog({ [KEY_A]: LIST_A })
    connectCatalog(KEY_A)
    const pinned = (model: string): CanonryConfig => ({ apiUrl: 'http://localhost:4100', database: ':memory:', apiKey: 'cnry_test', providers: { openrouter: { apiKey: KEY_A } }, agent: { provider: 'openrouter', model } } as CanonryConfig)
    const check = async () => {
      const errors: Array<string | null | undefined> = []
      for (const model of [FRESH, UNLISTED, 'Not an OpenRouter model']) errors.push((await describeAgentPin(pinned(model)))?.modelError)
      return errors
    }
    const expected = [null, notInList(UNLISTED), notInList('Not an OpenRouter model')]

    // No OpenRouter turn has loaded the list yet; doctor loads it itself.
    expect(await check()).toEqual(expected)
    await refreshAgentModels('openrouter')
    expect(await check()).toEqual(expected)
    expect(requests).toEqual([{ url: MODELS_URL, key: KEY_A }])
  })

  it('doctor leaves a well-formed OpenRouter pin unchecked while the catalog cannot be read', async () => {
    stubCatalog({})
    connectCatalog(KEY_A)
    const pinned = (model: string): CanonryConfig => ({ apiUrl: 'http://localhost:4100', database: ':memory:', apiKey: 'cnry_test', providers: { openrouter: { apiKey: KEY_A } }, agent: { provider: 'openrouter', model } } as CanonryConfig)
    expect((await describeAgentPin(pinned(UNLISTED)))?.modelError).toBeNull()
    expect((await describeAgentPin(pinned('Not an OpenRouter model')))?.modelError).toBe(notInList('Not an OpenRouter model'))
  })

  it('serves the short Aero list with no catalog request, and the sweep model settings from one, without exposing Aero metadata in settings', async () => {
    const requests = stubCatalog({ [KEY_A]: LIST_A })
    const { db, file } = tempDatabase('canonry-openrouter-server-')
    const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const app = await createServer({
      config: { apiUrl: 'http://localhost:4100', database: file, apiKey, providers: { openrouter: { apiKey: KEY_A } } } as CanonryConfig,
      db,
      logger: false,
    })
    onTestFinished(() => app.close())
    const headers = { authorization: `Bearer ${apiKey}` }
    const seeded = await app.inject({ method: 'PUT', url: '/api/v1/projects/acme', headers, payload: { displayName: 'acme', canonicalDomain: 'acme.example.com', country: 'US', language: 'en' } })
    expect(seeded.statusCode).toBe(201)

    const providers = await app.inject({ method: 'GET', url: '/api/v1/projects/acme/agent/providers', headers })
    expect(providers.statusCode).toBe(200)
    expect((providers.json() as { providers: Array<{ id: string; models?: Array<{ id: string }> }> }).providers.find(provider => provider.id === 'openrouter')?.models?.map(model => model.id)).toEqual(AGENT_MODEL_CHOICES.openrouter)
    expect(requests).toEqual([])

    const settings = await app.inject({ method: 'GET', url: '/api/v1/settings', headers })
    expect(settings.statusCode).toBe(200)
    expect((settings.json() as { providerCatalog: Array<{ name: string; knownModels: unknown }> }).providerCatalog.find(entry => entry.name === 'openrouter')?.knownModels).toEqual([
      { id: FRESH, displayName: 'Canonry Test: Released After Pi', tier: 'standard' },
      { id: NO_TOOLS, displayName: 'Canonry Test: No Tools', tier: 'standard' },
      { id: SONNET, displayName: 'Anthropic: Claude Sonnet 5.5 (catalog)', tier: 'standard' },
    ])
    expect(requests).toEqual([{ url: MODELS_URL, key: KEY_A }])
  })

  it('reads the live list for Aero with only OPENROUTER_API_KEY in the environment, while sweeps still need the key in config.yaml', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', KEY_B)
    const requests = stubCatalog({ [KEY_B]: LIST_B })
    const { db, file } = tempDatabase('canonry-openrouter-env-')
    const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const app = await createServer({
      config: { apiUrl: 'http://localhost:4100', database: file, apiKey } as CanonryConfig,
      db,
      logger: false,
    })
    onTestFinished(() => app.close())
    const headers = { authorization: `Bearer ${apiKey}` }
    const seeded = await app.inject({ method: 'PUT', url: '/api/v1/projects/acme', headers, payload: { displayName: 'acme', canonicalDomain: 'acme.example.com', country: 'US', language: 'en' } })
    expect(seeded.statusCode).toBe(201)

    const providers = await app.inject({ method: 'GET', url: '/api/v1/projects/acme/agent/providers', headers })
    expect(providers.statusCode).toBe(200)
    expect((providers.json() as { providers: Array<{ id: string }> }).providers.find(provider => provider.id === 'openrouter')).toMatchObject({
      configured: true,
      keySource: 'env',
    })
    await refreshAgentModels('openrouter')
    expect(isAgentModelAvailable('openrouter', SECOND_KEY_ONLY)).toBe(true)

    const settings = await app.inject({ method: 'GET', url: '/api/v1/settings', headers })
    expect(settings.statusCode).toBe(200)
    const body = settings.json() as { providers: Array<{ name: string; configured: boolean }>; providerCatalog: Array<{ name: string; knownModels: unknown }> }
    expect(body.providers.find(provider => provider.name === 'openrouter')?.configured).toBe(false)
    expect(body.providerCatalog.find(entry => entry.name === 'openrouter')?.knownModels).toEqual([])
    expect(requests).toEqual([{ url: MODELS_URL, key: KEY_B }])
  })
})

describe('default models', () => {
  const DEFAULTS: Array<[AgentProviderId, Record<LlmCapability, string>]> = [
    ['openrouter', { agent: LUNA, analyze: LUNA, classify: LUNA }],
    ['claude', { agent: 'claude-haiku-5-5', analyze: 'claude-haiku-5-5', classify: 'claude-haiku-5-5' }],
    ['openai', { agent: 'gpt-6-luna', analyze: 'gpt-6-luna', classify: 'gpt-6-luna' }],
    ['gemini', { agent: 'gemini-3.5-flash-lite', analyze: 'gemini-3.5-flash-lite', classify: 'gemini-3.5-flash-lite' }],
    ['zai', { agent: 'glm-5.3-flash', analyze: 'glm-5.3-flash', classify: 'glm-5.3-flash' }],
  ]

  it.each(DEFAULTS)('%s defaults resolve from pi-ai\'s bundled catalog with no live catalog connected', (provider, tiers) => {
    const piProvider = AGENT_PROVIDERS[provider].piAiProvider
    for (const [capability, id] of Object.entries(tiers) as Array<[LlmCapability, string]>) {
      const bundled = builtinModels().getModel(piProvider, id)
      expect(bundled, `${provider} ${capability}`).toBeDefined()
      expect(resolveModelForCapability(provider, capability)).toEqual(bundled)
    }
  })

  it('a live OpenRouter list leaves the direct providers\' catalogs untouched and sends them no catalog request', async () => {
    const requests = stubCatalog({ [KEY_A]: LIST_A })
    connectCatalog(KEY_A)
    await refreshAgentModels('openrouter')
    for (const provider of ['claude', 'openai', 'gemini', 'zai'] as const) await refreshAgentModels(provider)
    expect(requests).toHaveLength(1)
    for (const piProvider of ['anthropic', 'openai', 'google', 'zai']) {
      expect(aeroModels.getModels(piProvider)).toEqual(builtinModels().getModels(piProvider))
    }
  })
})
