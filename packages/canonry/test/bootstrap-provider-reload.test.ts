import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@ainyc/canonry-db'
import { geminiAdapter } from '@ainyc/canonry-provider-gemini'
import { bootstrapCommand } from '../src/commands/bootstrap.js'
import { createApiClient } from '../src/client.js'
import { loadConfig, saveConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { invokeCli } from './cli-test-utils.js'

describe('bootstrap provider activation', () => {
  let temp: string
  let app: Awaited<ReturnType<typeof createServer>> | undefined

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-bootstrap-reload-'))
    vi.stubEnv('CANONRY_CONFIG_DIR', temp)
    vi.stubEnv('CANONRY_API_KEY', 'cnry_bootstrap_reload_fixture')
    vi.stubEnv('CANONRY_API_URL', 'http://127.0.0.1:1')
    vi.stubEnv('CANONRY_DATABASE_PATH', undefined)
    vi.stubEnv('CANONRY_PORT', undefined)
    vi.stubEnv('CANONRY_BASE_PATH', undefined)
    vi.stubEnv('CANONRY_AGENT_DISABLED', '1')
    vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1')
    for (const name of ['GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_BASE_URL', 'GEMINI_VERTEX_PROJECT', 'GEMINI_VERTEX_REGION', 'GEMINI_VERTEX_CREDENTIALS', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PERPLEXITY_API_KEY', 'MUSE_API_KEY', 'LOCAL_BASE_URL']) {
      vi.stubEnv(name, undefined)
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(geminiAdapter, 'listModels').mockResolvedValue([])
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fs.rmSync(temp, { recursive: true, force: true })
  })

  it('activates a bootstrap provider on the running server without a restart, including behind a base path', async () => {
    await bootstrapCommand({ format: 'json' })
    const config = { ...loadConfig(), basePath: '/canonry' }
    const db = createClient(config.database)
    app = await createServer({ config, db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')
    config.apiUrl = `http://127.0.0.1:${address.port}/canonry`
    saveConfig(config)
    vi.stubEnv('CANONRY_API_URL', undefined)
    expect((await createApiClient().getSettings()).providers.filter(provider => provider.configured)).toEqual([])

    vi.stubEnv('GEMINI_API_KEY', 'bootstrap-provider-key-fixture')
    const result = await invokeCli(['bootstrap', '--format', 'json'])

    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(loadConfig().providers?.gemini?.apiKey).toBe('bootstrap-provider-key-fixture')
    expect((await createApiClient().getSettings()).providers.find(provider => provider.name === 'gemini')).toMatchObject({ configured: true })
    expect(JSON.parse(result.stdout)).toMatchObject({
      providers: ['gemini'], nextSteps: [], serverReload: { status: 'reloaded', providers: ['gemini'] },
    })
    expect(result.stdout).not.toContain('bootstrap-provider-key-fixture')
  })

  it('saves provider settings when no local server is running and reports that startup will apply them', async () => {
    vi.stubEnv('CANONRY_API_URL', 'http://127.0.0.1:1')
    vi.stubEnv('GEMINI_API_KEY', 'offline-provider-key-fixture')

    const result = await invokeCli(['bootstrap', '--format', 'jsonl'])

    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(loadConfig().providers?.gemini?.apiKey).toBe('offline-provider-key-fixture')
    expect(JSON.parse(result.stdout)).toMatchObject({ serverReload: { status: 'unavailable' } })
    expect(JSON.parse(result.stdout).nextSteps.join(' ')).toContain('canonry serve')
  })

  it('does not send a provider reload to a remote server during local bootstrap', async () => {
    vi.stubEnv('CANONRY_API_URL', 'https://remote.example.com/canonry')
    vi.stubEnv('GEMINI_API_KEY', 'remote-provider-key-fixture')
    const fetch = vi.spyOn(globalThis, 'fetch')

    const result = await invokeCli(['bootstrap', '--format', 'json'])

    expect(result.exitCode).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.parse(result.stdout)).toMatchObject({ serverReload: { status: 'not-local' } })
  })

  it('preserves saved provider settings when bootstrap rotates only its environment key', async () => {
    await bootstrapCommand({ format: 'json' })
    const provider = {
      apiKey: 'original-provider-key', model: 'gemini-2.5-pro', baseUrl: 'https://provider.example',
      vertexProject: 'saved-project', vertexRegion: 'europe-west1', vertexCredentials: '/fixture/account.json',
      quota: { maxConcurrency: 3, maxRequestsPerMinute: 80, maxRequestsPerDay: 2000 },
      batch: { enabled: true, maxRequestsPerBatch: 200, deadlineHours: 8 },
      pricing: { models: { 'gemini-2.5-pro': { inputPerMTok: 2, outputPerMTok: 8 } } },
    }
    saveConfig({ ...loadConfig(), providers: { gemini: provider } })
    vi.stubEnv('GEMINI_API_KEY', 'rotated-provider-key')

    const result = await invokeCli(['bootstrap', '--format', 'json'])

    expect(result.exitCode).toBeUndefined()
    expect(loadConfig().providers?.gemini).toEqual({ ...provider, apiKey: 'rotated-provider-key' })
    expect(result.stdout).not.toContain('rotated-provider-key')
  })

  it('reports failed activation when the running server belongs to a different database', async () => {
    await bootstrapCommand({ format: 'json' })
    const config = loadConfig()
    app = await createServer({ config, db: createClient(config.database), logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')
    saveConfig({ ...config, apiUrl: `http://127.0.0.1:${address.port}`, database: path.join(temp, 'other.db') })
    vi.stubEnv('CANONRY_API_URL', undefined)
    vi.stubEnv('GEMINI_API_KEY', 'mismatched-provider-key-fixture')

    const result = await invokeCli(['bootstrap', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ serverReload: { status: 'failed', code: 'VALIDATION_ERROR' } })
    expect(JSON.parse(result.stderr).error.code).toBe('VALIDATION_ERROR')
    expect((await createApiClient().getSettings()).providers.filter(provider => provider.configured)).toEqual([])
    expect(loadConfig().providers?.gemini?.apiKey).toBe('mismatched-provider-key-fixture')
    expect(result.stdout + result.stderr).not.toContain('mismatched-provider-key-fixture')
  })

  it('reports failed activation when a reachable server returns malformed JSON', async () => {
    await bootstrapCommand({ format: 'json' })
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = input instanceof Request ? input.url : String(input)
      return new Response(url.endsWith('/health') ? JSON.stringify({ status: 'ok', basePath: '' }) : 'not valid JSON', {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }))

    const result = await invokeCli(['bootstrap', '--format', 'json'])

    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({ serverReload: { status: 'failed', code: 'CONNECTION_ERROR' } })
    expect(JSON.parse(result.stderr).error.code).toBe('CONNECTION_ERROR')
  })
})
