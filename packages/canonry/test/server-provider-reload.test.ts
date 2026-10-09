import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'
import { auditLog, createClient, migrate, type DatabaseClient } from '@ainyc/canonry-db'
import { geminiAdapter } from '@ainyc/canonry-provider-gemini'
import { openaiAdapter } from '@ainyc/canonry-provider-openai'
import { cdpChatgptAdapter } from '@ainyc/canonry-provider-cdp'
import type { ProviderConfig, ProviderQuotaPolicy, SettingsDto } from '@ainyc/canonry-contracts'
import { createServer } from '../src/server.js'
import { loadConfig, type CanonryConfig } from '../src/config.js'

let directory: string
let config: CanonryConfig
let db: DatabaseClient
let app: Awaited<ReturnType<typeof createServer>> | undefined

function save(patch: Partial<CanonryConfig>) {
  fs.writeFileSync(path.join(directory, 'config.yaml'), stringify({ ...config, ...patch }))
}

function request(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  return app!.inject({
    method, url,
    headers: { authorization: `Bearer ${config.apiKey}` },
    ...(payload === undefined ? {} : { payload }),
  })
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-provider-reload-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', directory)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1')
  config = {
    apiUrl: 'http://localhost:4100', database: path.join(directory, 'data.db'),
    apiKey: 'cnry_provider_reload_fixture', port: 4100,
    agent: { mode: 'disabled' }, providers: {},
  }
  db = createClient(config.database)
  migrate(db)
  save({})
  vi.spyOn(geminiAdapter, 'listModels').mockResolvedValue([])
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected external request')))
})

afterEach(async () => {
  await app?.close()
  app = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('local server provider reload', () => {
  it('keeps repeated reloads of an unchanged retired model alias out of the provider audit history', async () => {
    config.providers = { perplexity: { apiKey: 'fixture-perplexity-key', model: 'sonar' } }
    save({})
    app = await createServer({ config, db, logger: false })
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request('POST', '/api/v1/settings/providers/reload', {})
      expect(response.statusCode).toBe(200)
      expect(response.json().providers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'perplexity', configured: true, model: 'fast' }),
      ]))
    }
    expect(db.select().from(auditLog).all().filter(entry => entry.entityType === 'provider')).toEqual([])
  })

  it('activates disk credentials immediately and leaves unrelated running configuration intact', async () => {
    app = await createServer({ config, db, logger: false })
    save({
      providers: { gemini: { apiKey: 'new-private-provider-key', model: 'gemini-2.5-flash' } },
      port: 4200, apiUrl: 'http://localhost:4200', apiKey: 'cnry_other_runtime',
      database: path.join(directory, 'other.db'), agent: { mode: 'prompt-only' },
    })

    const response = await request('POST', '/api/v1/settings/providers/reload', {})
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ reloaded: true, providers: expect.arrayContaining([
      expect.objectContaining({ name: 'gemini', configured: true, model: 'gemini-2.5-flash', quota: {
        maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000,
      } }),
    ]) })
    expect(response.body).not.toContain('new-private-provider-key')
    expect(config).toMatchObject({
      apiUrl: 'http://localhost:4100', apiKey: 'cnry_provider_reload_fixture',
      database: path.join(directory, 'data.db'), port: 4100, agent: { mode: 'disabled' },
    })
    const settings = await request('GET', '/api/v1/settings')
    expect(settings.statusCode).toBe(200)
    expect(settings.json<SettingsDto>().providers.find(provider => provider.name === 'gemini')?.configured).toBe(true)
    expect(db.select().from(auditLog).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'provider.created', entityId: 'gemini' }),
    ]))
    expect((await request('PUT', '/api/v1/settings/providers/gemini', { model: 'gemini-2.5-pro' })).statusCode).toBe(200)
    expect(parse(fs.readFileSync(path.join(directory, 'config.yaml'), 'utf8'))).toMatchObject({
      port: 4200, apiUrl: 'http://localhost:4200', apiKey: 'cnry_other_runtime',
      database: path.join(directory, 'other.db'), agent: { mode: 'prompt-only' },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reloads Vertex and CDP, preserves batch/pricing/full quotas in execution, and removes absent providers', async () => {
    const quota = { maxConcurrency: 3, maxRequestsPerMinute: 120, maxRequestsPerDay: 2500 }
    const batch = { enabled: true, maxRequestsPerBatch: 400, deadlineHours: 12 }
    const pricing = { models: { 'gemini-2.5-flash': { inputPerMTok: 0.4, outputPerMTok: 2 } } }
    app = await createServer({ config, db, logger: false })
    save({ providers: { gemini: {
      vertexProject: 'fixture-project', vertexRegion: 'europe-west1', vertexCredentials: '/fixture/service-account.json',
      model: 'gemini-2.5-flash', quota, batch, pricing,
    } }, cdp: { host: '127.0.0.1', port: 9333, quota } })
    const reload = await request('POST', '/api/v1/settings/providers/reload', {
      configPath: path.join(directory, 'config.yaml'), databasePath: config.database,
    })
    expect(reload.statusCode).toBe(200)
    expect(reload.json().providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'gemini', configured: true, vertexConfigured: true, quota }),
      expect.objectContaining({ name: 'cdp:chatgpt', configured: true, quota }),
    ]))

    const browserHealth = vi.spyOn(cdpChatgptAdapter, 'healthcheck').mockResolvedValue({ ok: true, provider: 'cdp:chatgpt', message: 'fixture-browser' })
    expect((await request('GET', '/api/v1/cdp/status')).json().endpoint).toBe('ws://127.0.0.1:9333')
    expect(browserHealth.mock.calls[0]?.[0]).toMatchObject({ quotaPolicy: quota })

    let calledConfig: ProviderConfig | undefined
    vi.spyOn(geminiAdapter, 'executeTrackedQuery').mockImplementation(async (_input, providerConfig) => {
      calledConfig = providerConfig
      return { provider: 'gemini', model: providerConfig.model!, rawResponse: {}, groundingSources: [], searchQueries: [], retrievalStatus: 'used', retrievalContract: 'search-required-v1' }
    })
    vi.spyOn(geminiAdapter, 'normalizeResult').mockReturnValue({ provider: 'gemini', answerText: 'Fixture answer', citedDomains: [], groundingSources: [], searchQueries: [], retrievalStatus: 'used' })
    expect((await request('PUT', '/api/v1/projects/acme', { displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en', providers: ['gemini'] })).statusCode).toBe(201)
    expect((await request('PUT', '/api/v1/projects/acme/queries', { queries: ['Which services are available?'] })).statusCode).toBe(200)
    expect((await request('POST', '/api/v1/projects/acme/runs', { trigger: 'probe' })).statusCode).toBe(201)
    await vi.waitFor(() => expect(calledConfig).toBeDefined())
    expect(calledConfig).toMatchObject({
      vertexProject: 'fixture-project', vertexRegion: 'europe-west1', vertexCredentials: '/fixture/service-account.json',
      model: 'gemini-2.5-flash', quotaPolicy: quota, batch, pricing,
    })
    save({ providers: {}, cdp: undefined })
    expect((await request('POST', '/api/v1/settings/providers/reload', {})).json().providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'gemini', configured: false }),
      expect.objectContaining({ name: 'cdp:chatgpt', configured: false }),
    ]))
    expect((await request('GET', '/api/v1/cdp/status')).json().connected).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reloads every config it boots with, registering the same normalized limits as startup', async () => {
    // Partial quota blocks boot today: each saved limit wins, the rest default.
    config.providers = {
      openai: { apiKey: 'fixture-openai-key', quota: { maxConcurrency: 4 } as ProviderQuotaPolicy },
      gemini: { apiKey: 'fixture-gemini-key', model: 'gemini-2.5-flash', quota: { maxRequestsPerDay: 50 } as ProviderQuotaPolicy },
    }
    config.cdp = { host: '127.0.0.1', port: 9333, quota: { maxRequestsPerDay: 20 } as ProviderQuotaPolicy }
    save({})
    vi.spyOn(openaiAdapter, 'listModels').mockResolvedValue([])
    const browserHealth = vi.spyOn(cdpChatgptAdapter, 'healthcheck').mockResolvedValue({ ok: true, provider: 'cdp:chatgpt', message: 'fixture-browser' })
    app = await createServer({ config, db, logger: false })
    const registration = async () => {
      const settings = (await request('GET', '/api/v1/settings')).json<SettingsDto>()
      await request('GET', '/api/v1/cdp/status')
      return { providers: settings.providers, cdpQuota: browserHealth.mock.lastCall?.[0].quotaPolicy }
    }

    const atStartup = await registration()
    expect(atStartup.providers.find(provider => provider.name === 'openai')?.quota)
      .toEqual({ maxConcurrency: 4, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 })
    expect(atStartup.providers.find(provider => provider.name === 'gemini')?.quota)
      .toEqual({ maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 50 })
    expect(atStartup.cdpQuota).toEqual({ maxConcurrency: 1, maxRequestsPerMinute: 4, maxRequestsPerDay: 20 })

    const reload = await request('POST', '/api/v1/settings/providers/reload', {
      configPath: path.join(directory, 'config.yaml'), databasePath: config.database,
    })
    expect(reload.statusCode).toBe(200)
    expect(await registration()).toEqual(atStartup)

    // A settings write re-registers the provider with the same limits too.
    const update = await request('PUT', '/api/v1/settings/providers/openai', { model: 'gpt-5.4' })
    expect(update.statusCode).toBe(200)
    expect(update.json().quota).toEqual({ maxConcurrency: 4, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    'providers:\n  gemini:\n    apiKey: next-private-key\n    batch:\n      enabled: nope\n',
    'providers:\n  gemini:\n    apiKey: next-private-key\n  - not yaml\n',
  ])('refuses configuration that startup also refuses, without changing the live registry: %s', async malformed => {
    config.providers = { gemini: { apiKey: 'original-private-key', model: 'gemini-2.5-pro' } }
    save({})
    app = await createServer({ config, db, logger: false })
    fs.writeFileSync(path.join(directory, 'config.yaml'), stringify({ apiUrl: config.apiUrl, apiKey: config.apiKey, database: config.database }) + malformed)
    expect(() => loadConfig(path.join(directory, 'config.yaml'))).toThrow()
    const response = await request('POST', '/api/v1/settings/providers/reload', {})
    expect(response.statusCode).toBe(400)
    const settings = await request('GET', '/api/v1/settings')
    expect(settings.json<SettingsDto>().providers.find(provider => provider.name === 'gemini')).toMatchObject({ configured: true, model: 'gemini-2.5-pro' })
    expect(config.providers.gemini?.apiKey).toBe('original-private-key')
    expect(response.body).not.toContain('next-private-key')
  })

  it('rejects another runtime identity and keeps reading the config path captured at startup', async () => {
    app = await createServer({ config, db, logger: false })
    save({ providers: { gemini: { apiKey: 'captured-runtime-key' } } })
    const otherDirectory = path.join(directory, 'other')
    fs.mkdirSync(otherDirectory)
    fs.writeFileSync(path.join(otherDirectory, 'config.yaml'), stringify({ ...config, providers: { openai: { apiKey: 'wrong-runtime-key' } } }))
    vi.stubEnv('CANONRY_CONFIG_DIR', otherDirectory)
    for (const identity of [
      { configPath: path.join(otherDirectory, 'config.yaml'), databasePath: config.database },
      { configPath: path.join(directory, 'config.yaml'), databasePath: path.join(directory, 'other.db') },
    ]) {
      const rejected = await request('POST', '/api/v1/settings/providers/reload', identity)
      expect(rejected.statusCode).toBe(400)
      // Callers branch on this stable reason, never on the message.
      expect(rejected.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', details: { reason: 'install-identity-mismatch' } } })
      expect(config.providers).toEqual({})
    }
    const response = await request('POST', '/api/v1/settings/providers/reload', {})
    expect(response.statusCode).toBe(200)
    expect(response.json().providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'gemini', configured: true }),
      expect.objectContaining({ name: 'openai', configured: false }),
    ]))
  })
})
