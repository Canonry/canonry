import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { createClient, migrate, type DatabaseClient } from '@canonry/canonry-db'
import { localAdapter } from '@canonry/canonry-provider-local'
import { createServer } from '../src/server.js'
import type { CanonryConfig } from '../src/config.js'

const LOCAL_KEY = 'local-fixture-key-9f2c'

let directory: string
let config: CanonryConfig
let db: DatabaseClient
let app: Awaited<ReturnType<typeof createServer>> | undefined
const closers: Array<() => Promise<void>> = []

/** An OpenAI-compatible endpoint on loopback; the Local adapter's check lists its models. */
async function startEndpoint(respond: () => { status: number; body: unknown }) {
  const requests: Array<{ method: string; url: string; authorization: string | undefined }> = []
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method ?? '', url: request.url ?? '', authorization: request.headers.authorization })
    const { status, body } = respond()
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests }
}

async function start(providers: CanonryConfig['providers']) {
  config.providers = providers
  fs.writeFileSync(path.join(directory, 'config.yaml'), stringify(config))
  app = await createServer({ config, db, logger: false })
}

function testConnection(name: string) {
  return app!.inject({
    method: 'POST',
    url: `/api/v1/settings/providers/${name}/test`,
    headers: { authorization: `Bearer ${config.apiKey}` },
  })
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-provider-connection-test-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', directory)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1')
  config = {
    apiUrl: 'http://localhost:4100', database: path.join(directory, 'data.db'),
    apiKey: 'cnry_provider_connection_test', port: 4100,
    agent: { mode: 'disabled' }, providers: {},
  }
  db = createClient(config.database)
  migrate(db)
})

afterEach(async () => {
  await app?.close()
  app = undefined
  for (const close of closers.splice(0)) await close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('local server provider connection test', () => {
  it('checks the active Local registration against its own endpoint with its saved key', async () => {
    const endpoint = await startEndpoint(() => ({ status: 200, body: { object: 'list', data: [{ id: 'qwen3', object: 'model' }, { id: 'llama3', object: 'model' }] } }))
    await start({ local: { baseUrl: endpoint.baseUrl, apiKey: LOCAL_KEY, model: 'qwen3' } })
    const response = await testConnection('local')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ provider: 'local', status: 'connected', ok: true, model: 'qwen3', message: 'connected, 2 model(s) available' })
    expect(endpoint.requests).toContainEqual({ method: 'GET', url: '/v1/models', authorization: `Bearer ${LOCAL_KEY}` })
  })

  it('reports a refusing endpoint as failed without returning the saved key it quoted', async () => {
    const endpoint = await startEndpoint(() => ({ status: 401, body: { error: { message: `Unknown token ${LOCAL_KEY} for this server`, type: 'invalid_request_error' } } }))
    await start({ local: { baseUrl: endpoint.baseUrl, apiKey: LOCAL_KEY } })
    const response = await testConnection('local')
    expect(response.statusCode).toBe(200)
    const result = response.json()
    expect(result).toMatchObject({ provider: 'local', status: 'failed', ok: false })
    expect(result.message).toContain('Unknown token [REDACTED] for this server')
    expect(response.body).not.toContain(LOCAL_KEY)
    expect(endpoint.requests.some(request => request.url === '/v1/models')).toBe(true)
  })

  it('hands the check the route\'s signal, which ends once the route answers', async () => {
    const endpoint = await startEndpoint(() => ({ status: 200, body: { object: 'list', data: [{ id: 'llama3', object: 'model' }] } }))
    await start({ local: { baseUrl: endpoint.baseUrl } })
    const signals: Array<AbortSignal | undefined> = []
    const healthcheck = localAdapter.healthcheck.bind(localAdapter)
    vi.spyOn(localAdapter, 'healthcheck').mockImplementation((config, signal) => {
      signals.push(signal)
      return healthcheck(config, signal)
    })
    expect((await testConnection('local')).json()).toMatchObject({ status: 'connected' })
    // Without it, a check the route stopped waiting for would keep retrying, and spending, unseen.
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
  })

  it('refuses a known provider with nothing saved before any provider call', async () => {
    await start({})
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const response = await testConnection('openai')
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', details: { provider: 'openai', reason: 'provider-not-configured' } } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
