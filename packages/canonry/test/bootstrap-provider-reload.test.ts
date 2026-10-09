import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@ainyc/canonry-db'
import { geminiAdapter } from '@ainyc/canonry-provider-gemini'
import { bootstrapCommand } from '../src/commands/bootstrap.js'
import { createApiClient } from '../src/client.js'
import { loadConfig, saveConfig, type CanonryConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { invokeCli } from './cli-test-utils.js'

const SETUP_QUOTA = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 500 }

describe('bootstrap provider activation', () => {
  let temp: string
  let app: Awaited<ReturnType<typeof createServer>> | undefined

  /** Start a real server for this config and return its port. */
  async function startServer(config: CanonryConfig = loadConfig()): Promise<number> {
    app = await createServer({ config, db: createClient(config.database), logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')
    return address.port
  }

  async function configuredOnServer(apiKey: string): Promise<string[]> {
    const response = await app!.inject({ method: 'GET', url: '/api/v1/settings', headers: { authorization: `Bearer ${apiKey}` } })
    expect(response.statusCode).toBe(200)
    return (response.json() as { providers: Array<{ name: string; configured: boolean }> }).providers
      .filter(provider => provider.configured).map(provider => provider.name)
  }

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
    for (const name of [
      'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_BASE_URL', 'GEMINI_VERTEX_PROJECT', 'GEMINI_VERTEX_REGION', 'GEMINI_VERTEX_CREDENTIALS',
      'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'PERPLEXITY_API_KEY', 'PERPLEXITY_MODEL',
      'MUSE_API_KEY', 'MUSE_MODEL', 'LOCAL_BASE_URL', 'LOCAL_API_KEY', 'LOCAL_MODEL',
    ]) {
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
    const port = await startServer(config)
    config.apiUrl = `http://127.0.0.1:${port}/canonry`
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

  it('sends no reload request when a rerun leaves the saved providers unchanged', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'unchanged-provider-key-fixture')
    await bootstrapCommand({ format: 'json' })
    const fetch = vi.spyOn(globalThis, 'fetch')

    const result = await invokeCli(['bootstrap', '--format', 'json'])

    expect(result.exitCode).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'unchanged', serverReload: { status: 'unchanged' }, nextSteps: [] })
  })

  it('replaces the saved Gemini credentials as a unit and keeps its other settings when the env supplies a key', async () => {
    await bootstrapCommand({ format: 'json' })
    const settings = {
      model: 'gemini-2.5-pro', baseUrl: 'https://provider.example',
      quota: { maxConcurrency: 3, maxRequestsPerMinute: 80, maxRequestsPerDay: 2000 },
      batch: { enabled: true, maxRequestsPerBatch: 200, deadlineHours: 8 },
      pricing: { models: { 'gemini-2.5-pro': { inputPerMTok: 2, outputPerMTok: 8 } } },
    }
    saveConfig({ ...loadConfig(), providers: { gemini: {
      ...settings, apiKey: 'original-provider-key',
      vertexProject: 'saved-project', vertexRegion: 'europe-west1', vertexCredentials: '/fixture/account.json',
    } } })
    vi.stubEnv('GEMINI_API_KEY', 'rotated-provider-key')

    const result = await invokeCli(['bootstrap', '--format', 'json'])

    expect(result.exitCode).toBeUndefined()
    // A Vertex project left behind would win over the new key in the adapter.
    expect(loadConfig().providers?.gemini).toEqual({ ...settings, apiKey: 'rotated-provider-key' })
    expect(result.stdout).not.toContain('rotated-provider-key')
  })

  it('switches Gemini between Vertex and API-key auth through the env in both directions', async () => {
    vi.stubEnv('GEMINI_VERTEX_PROJECT', 'old-project')
    vi.stubEnv('GEMINI_VERTEX_REGION', 'europe-west1')
    vi.stubEnv('GEMINI_MODEL', 'gemini-2.5-pro')
    await bootstrapCommand({ format: 'json' })
    expect(loadConfig().providers?.gemini).toMatchObject({ vertexProject: 'old-project', vertexRegion: 'europe-west1', model: 'gemini-2.5-pro' })

    vi.stubEnv('GEMINI_VERTEX_PROJECT', undefined)
    vi.stubEnv('GEMINI_VERTEX_REGION', undefined)
    vi.stubEnv('GEMINI_MODEL', undefined)
    vi.stubEnv('GEMINI_API_KEY', 'new-provider-key')
    await bootstrapCommand({ format: 'json' })
    expect(loadConfig().providers?.gemini).toEqual({ apiKey: 'new-provider-key', model: 'gemini-2.5-pro', quota: SETUP_QUOTA })

    vi.stubEnv('GEMINI_API_KEY', undefined)
    vi.stubEnv('GEMINI_VERTEX_PROJECT', 'next-project')
    await bootstrapCommand({ format: 'json' })
    const gemini = loadConfig().providers?.gemini
    expect(gemini).toMatchObject({ vertexProject: 'next-project', model: 'gemini-2.5-pro', quota: SETUP_QUOTA })
    expect(gemini?.apiKey ?? '').toBe('')
    expect(gemini?.vertexRegion).toBeUndefined()
  })

  it('gives a new provider the setup defaults, keeps a saved model and quota on rerun, and lets an explicit env model win', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'openai-provider-key')
    await bootstrapCommand({ format: 'json' })
    expect(loadConfig().providers?.openai).toEqual({ apiKey: 'openai-provider-key', model: 'gpt-5.4', quota: SETUP_QUOTA })

    const quota = { maxConcurrency: 4, maxRequestsPerMinute: 30, maxRequestsPerDay: 900 }
    saveConfig({ ...loadConfig(), providers: { openai: { apiKey: 'openai-provider-key', model: 'gpt-4.1', quota } } })
    await bootstrapCommand({ format: 'json' })
    expect(loadConfig().providers?.openai).toEqual({ apiKey: 'openai-provider-key', model: 'gpt-4.1', quota })

    vi.stubEnv('OPENAI_MODEL', 'gpt-5.5')
    await bootstrapCommand({ format: 'json' })
    expect(loadConfig().providers?.openai).toEqual({ apiKey: 'openai-provider-key', model: 'gpt-5.5', quota })
  })

  it('leaves a server that runs another install alone and exits 0 when its identity does not match', async () => {
    await bootstrapCommand({ format: 'json' })
    const config = loadConfig()
    const port = await startServer(config)
    saveConfig({ ...config, apiUrl: `http://127.0.0.1:${port}`, database: path.join(temp, 'other.db') })
    vi.stubEnv('CANONRY_API_URL', undefined)
    vi.stubEnv('GEMINI_API_KEY', 'mismatched-provider-key-fixture')

    const result = await invokeCli(['bootstrap', '--format', 'json'])

    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({ serverReload: { status: 'not-matching', reason: 'other-install', code: 'VALIDATION_ERROR' } })
    expect(output.nextSteps.join(' ')).toContain('canonry settings reload-providers')
    expect(await configuredOnServer(config.apiKey)).toEqual([])
    expect(loadConfig().providers?.gemini?.apiKey).toBe('mismatched-provider-key-fixture')
    expect(result.stdout + result.stderr).not.toContain('mismatched-provider-key-fixture')
  })

  it('says the server is not this install\'s when it refuses this install\'s key, and exits 0', async () => {
    await bootstrapCommand({ format: 'json' })
    const installA = loadConfig()
    const port = await startServer(installA)
    vi.stubEnv('CANONRY_CONFIG_DIR', path.join(temp, 'install-b'))
    vi.stubEnv('CANONRY_API_KEY', 'cnry_other_install_fixture')
    vi.stubEnv('CANONRY_API_URL', `http://127.0.0.1:${port}`)
    vi.stubEnv('GEMINI_API_KEY', 'install-b-provider-key')

    const result = await invokeCli(['bootstrap'])

    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain(`The server at http://127.0.0.1:${port} is not this install's server, so it was not reloaded.`)
    expect(result.stdout).toContain('run `canonry settings reload-providers` against this install\'s server, or restart that server')
    expect(loadConfig().providers?.gemini?.apiKey).toBe('install-b-provider-key')
    expect(await configuredOnServer(installA.apiKey)).toEqual([])
  })

  it.each([
    { status: 403, code: 'FORBIDDEN', reason: 'other-install', text: 'is not this install\'s server, so it was not reloaded.' },
    { status: 404, code: 'NOT_FOUND', reason: 'reload-unsupported', text: 'cannot reload providers: it is too old or does not support reload.' },
    { status: 501, code: 'NOT_IMPLEMENTED', reason: 'reload-unsupported', text: 'cannot reload providers: it is too old or does not support reload.' },
  ])('saves the providers and exits 0 when the local server answers the reload with $status', async ({ status, code, reason, text }) => {
    await bootstrapCommand({ format: 'json' })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      return url.endsWith('/health')
        ? Response.json({ status: 'ok' })
        : Response.json({ error: { code, message: 'Fixture refusal' } }, { status })
    }))
    vi.stubEnv('GEMINI_API_KEY', `status-${status}-provider-key`)

    const json = await invokeCli(['bootstrap', '--format', 'json'])

    expect(json.exitCode).toBeUndefined()
    expect(json.stderr).toBe('')
    expect(JSON.parse(json.stdout)).toMatchObject({ serverReload: { status: 'not-matching', reason, code } })
    expect(loadConfig().providers?.gemini?.apiKey).toBe(`status-${status}-provider-key`)

    vi.stubEnv('GEMINI_API_KEY', `status-${status}-text-provider-key`)
    const human = await invokeCli(['bootstrap'])

    expect(human.exitCode).toBeUndefined()
    expect(human.stdout).toContain(`The server at http://127.0.0.1:1 ${text}`)
  })

  it('reloads the matching server when config.yaml is a symlink that the bootstrap write replaces', async () => {
    await bootstrapCommand({ format: 'json' })
    const configPath = path.join(temp, 'config.yaml')
    const linkedPath = path.join(temp, 'linked', 'config.yaml')
    fs.mkdirSync(path.dirname(linkedPath))
    fs.renameSync(configPath, linkedPath)
    fs.symlinkSync(linkedPath, configPath)
    const port = await startServer()
    vi.stubEnv('CANONRY_API_URL', `http://127.0.0.1:${port}`)
    vi.stubEnv('GEMINI_API_KEY', 'symlinked-provider-key')

    const result = await invokeCli(['bootstrap', '--format', 'json'])

    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({ serverReload: { status: 'reloaded', providers: ['gemini'] } })
    expect(await configuredOnServer(loadConfig().apiKey)).toEqual(['gemini'])
  })

  it('reports failed activation when a reachable server returns malformed JSON', async () => {
    await bootstrapCommand({ format: 'json' })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      return new Response(url.endsWith('/health') ? JSON.stringify({ status: 'ok', basePath: '' }) : 'not valid JSON', {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }))
    vi.stubEnv('GEMINI_API_KEY', 'malformed-response-provider-key')

    const result = await invokeCli(['bootstrap', '--format', 'json'])

    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({ serverReload: { status: 'failed', code: 'CONNECTION_ERROR' } })
    expect(JSON.parse(result.stderr).error.code).toBe('CONNECTION_ERROR')
  })
})
