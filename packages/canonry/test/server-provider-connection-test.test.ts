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
import { loadConfig, type CanonryConfig } from '../src/config.js'

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

function request(method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return app!.inject({ method, url, headers: { authorization: `Bearer ${config.apiKey}` }, ...(payload === undefined ? {} : { payload }) })
}

async function lastTest(name: string) {
  const response = await request('GET', `/api/v1/settings/providers/${name}`)
  expect(response.statusCode).toBe(200)
  return response.json().lastTest
}

/** The test response without the fields only the response carries. */
function asLastTest(result: Record<string, unknown>) {
  const { provider: _provider, displayName: _displayName, ...stored } = result
  return stored
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

  it('reports a refusing endpoint as failed without returning or keeping the saved key it quoted', async () => {
    const endpoint = await startEndpoint(() => ({ status: 401, body: { error: { message: `Unknown token ${LOCAL_KEY} for this server`, type: 'invalid_request_error' } } }))
    await start({ local: { baseUrl: endpoint.baseUrl, apiKey: LOCAL_KEY } })
    const response = await testConnection('local')
    expect(response.statusCode).toBe(200)
    const result = response.json()
    expect(result).toMatchObject({ provider: 'local', status: 'failed', ok: false })
    expect(result.message).toContain('Unknown token [REDACTED] for this server')
    expect(response.body).not.toContain(LOCAL_KEY)
    expect(endpoint.requests.some(entry => entry.url === '/v1/models')).toBe(true)
    // A failed test is kept too, as returned.
    expect(await lastTest('local')).toEqual(asLastTest(result))
    expect(JSON.stringify(db.$client.prepare('SELECT * FROM provider_connection_tests').all())).not.toContain(LOCAL_KEY)
  })

  it('keeps the latest result with the connection until the settings it tested change', async () => {
    const endpoint = await startEndpoint(() => ({ status: 200, body: { object: 'list', data: [{ id: 'qwen3', object: 'model' }] } }))
    await start({ local: { baseUrl: endpoint.baseUrl, apiKey: LOCAL_KEY, model: 'qwen3' } })
    expect(await lastTest('local')).toBeNull()
    const kept = asLastTest((await testConnection('local')).json())
    expect(kept).toMatchObject({ status: 'connected', ok: true, model: 'qwen3' })
    expect(await lastTest('local')).toEqual(kept)
    const settings = (await request('GET', '/api/v1/settings')).json()
    expect(settings.providerConnections.find((connection: { name: string }) => connection.name === 'local').lastTest).toEqual(kept)

    // Request limits change nothing about reaching the provider, and a restart forgets nothing.
    expect((await request('PUT', '/api/v1/settings/providers/local', { quota: { maxConcurrency: 3 } })).statusCode).toBe(200)
    expect(await lastTest('local')).toEqual(kept)
    await app!.close()
    app = await createServer({ config: loadConfig(path.join(directory, 'config.yaml')), db, logger: false })
    expect(await lastTest('local')).toEqual(kept)

    // A different model is different settings, so the earlier test no longer describes them.
    expect((await request('PUT', '/api/v1/settings/providers/local', { model: 'llama3' })).statusCode).toBe(200)
    expect(await lastTest('local')).toBeNull()

    // Reconnecting after a disconnect starts unproven, even with the same settings.
    await testConnection('local')
    expect(await lastTest('local')).toMatchObject({ status: 'connected', model: 'llama3' })
    expect((await request('DELETE', '/api/v1/settings/providers/local', {})).statusCode).toBe(200)
    expect((await request('PUT', '/api/v1/settings/providers/local', { baseUrl: endpoint.baseUrl, apiKey: LOCAL_KEY, model: 'llama3' })).statusCode).toBe(200)
    expect(await lastTest('local')).toBeNull()
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
