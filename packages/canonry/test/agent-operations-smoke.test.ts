import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { apiRoutes, hashApiKey, type ApiRoutesOptions } from '@canonry/canonry-api-routes'
import { apiKeys, createClient, migrate, projects, OperationalLogStore } from '@canonry/canonry-db'
import { providerConnectionFixture } from './fixtures/provider-connection.js'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { SETTINGS_CLI_COMMANDS } from '../src/cli-commands/settings.js'
import { ApiClient } from '../src/client.js'
import { registerMcpHttpRoutes, type McpHttpOptions } from '../src/mcp-http.js'

const state = vi.hoisted(() => ({ client: undefined as unknown }))
vi.mock('../src/client.js', async importOriginal => ({
  ...await importOriginal(),
  createApiClient: () => state.client,
}))
vi.mock('../src/config.js', async importOriginal => ({
  ...await importOriginal(),
  loadConfig: () => ({ apiUrl: 'https://unused.invalid', apiKey: 'fake', database: ':memory:' }),
}))
const { showSettings, setProvider } = await import('../src/commands/settings.js')
const { telemetryCommand } = await import('../src/commands/telemetry.js')
const { showOperationalLogs } = await import('../src/commands/logs.js')
const { showApiKeySelf } = await import('../src/commands/keys.js')

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function harness(lifecycle = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-ops-smoke-'))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({ id: 'project-demo', name: 'demo', displayName: 'Demo', canonicalDomain: 'demo.example', country: 'US', language: 'en', providers: ['openai'], createdAt: now, updatedAt: now }).run()
  for (const [name, scopes] of Object.entries({ root: ['*'], unrelated: ['runs.write'], read: ['read'], research: ['read', 'research.run'], settings: ['read', 'settings.write'], logs: ['read', 'logs.read'], scopedLogs: ['read', 'logs.read'], projectAdmin: ['*'] })) {
    const token = `cnry_smoke_${name}`
    db.insert(apiKeys).values({ id: name, name, keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), scopes, projectId: name === 'read' || name === 'scopedLogs' || name === 'projectAdmin' ? 'project-demo' : null, createdAt: now }).run()
  }
  const app = Fastify()
  cleanup.push(async () => { await app.close(); db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const providers = [{ name: 'openai', configured: true, model: 'gpt-old' }]
  let telemetry = false
  const logs = new OperationalLogStore(db)
  logs.append({ ts: now, level: 'info', module: 'Smoke', action: 'smoke.completed', projectId: 'project-demo', runId: 'fixture-run', provider: 'openai', query: 'private query' })
  const providerUpdate = vi.fn((_provider: string, _key: string, model?: string) => {
    providers[0]!.model = model ?? providers[0]!.model
    return { ...providers[0]! }
  })
  const providerTest = vi.fn<NonNullable<ApiRoutesOptions['onProviderTest']>>(() => ({ check: Promise.resolve({ ok: true, provider: 'openai', message: 'openai api key verified', model: 'gpt-old' }) }))
  const connection = structuredClone(providerConnectionFixture)
  const providerDisconnect = vi.fn(() => { connection.configured = false; connection.apiKeyConfigured = false; connection.revision = 'connection-v2' })
  const options: McpHttpOptions = { db, selfApiUrl: '' }
  app.register(apiRoutes, {
    db,
    operatorApiKeyIds: ['root', 'settings', 'logs'],
    providerSummary: providers,
    providerAdapters: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-old', knownModels: [], modelValidationPattern: /^gpt-/, modelValidationHint: 'gpt model' }],
    googleSettingsSummary: { configured: true },
    onProviderUpdate: providerUpdate,
    onProviderTest: providerTest,
    ...(lifecycle ? { getProviderConnections: () => [connection], onProviderDisconnect: providerDisconnect } : {}),
    getTelemetryStatus: () => ({ enabled: telemetry, anonymousId: '01234567-89ab-4cde-8fab-0123456789ab' }),
    setTelemetryEnabled: value => { telemetry = value },
    listOperationalLogs: query => logs.list(query),
    registerAuthenticatedRoutes: scope => registerMcpHttpRoutes(scope, options),
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test address')
  const origin = `http://127.0.0.1:${address.port}`
  options.selfApiUrl = origin
  const api = new ApiClient(origin, 'cnry_smoke_root', { skipProbe: true })
  state.client = api
  async function connect(name: string) {
    const mcp = new Client({ name: 'agent-operations-smoke', version: '1' })
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/v1/mcp`), {
      requestInit: { headers: { authorization: `Bearer cnry_smoke_${name}` } },
    }))
    cleanup.push(() => mcp.close())
    return mcp
  }
  return { app, api, connect, providerUpdate, providerDisconnect, providerTest, origin }
}

describe('agent operations cross-surface smoke', () => {
  it('previews and disconnects through actual CLI and MCP transports with the same impact guard', async () => {
    const { api, connect, providerDisconnect, origin } = await harness(true)
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    const preview = await api.getProviderSettings('openai')
    expect(preview.usage).toEqual({ projectCount: 1, projects: [{ name: 'demo', displayName: 'Demo', providers: ['openai'], sources: ['project'] }] })
    await dispatchRegisteredCommand(['settings', 'provider-info', 'openai', '--format', 'json'], 'human', SETTINGS_CLI_COMMANDS)
    expect(JSON.parse(out.mock.calls.at(-1)![0])).toEqual(preview)
    await dispatchRegisteredCommand(['settings', 'disconnect-provider', 'openai', '--format', 'jsonl'], 'human', SETTINGS_CLI_COMMANDS)
    expect(JSON.parse(out.mock.calls.at(-1)![0])).toEqual(preview)
    expect(providerDisconnect).not.toHaveBeenCalled()

    const mcp = await connect('root')
    const detail = await mcp.callTool({ name: 'canonry_provider_settings_get', arguments: { provider: 'openai' } })
    expect(detail.isError).not.toBe(true)
    expect(detail.structuredContent).toEqual(preview)
    const stale = await mcp.callTool({ name: 'canonry_provider_disconnect', arguments: { provider: 'openai', expectedImpactRevision: 'stale' } })
    expect(stale.isError).toBe(true)
    expect(providerDisconnect).not.toHaveBeenCalled()
    const denied = await connect('settings')
    expect((await denied.callTool({ name: 'canonry_provider_disconnect', arguments: { provider: 'openai', expectedImpactRevision: preview.impactRevision } })).isError).toBe(true)
    expect(providerDisconnect).not.toHaveBeenCalled()
    state.client = new ApiClient(origin, 'cnry_smoke_read', { skipProbe: true })
    await expect(dispatchRegisteredCommand(['settings', 'provider-info', 'openai', '--format', 'json'], 'human', SETTINGS_CLI_COMMANDS)).rejects.toMatchObject({ details: { httpStatus: 403 } })
    state.client = api
    await dispatchRegisteredCommand(['settings', 'disconnect-provider', 'openai', '--confirm', '--if-impact-revision', preview.impactRevision, '--format', 'json'], 'human', SETTINGS_CLI_COMMANDS)
    expect(JSON.parse(out.mock.calls.at(-1)![0])).toMatchObject({ configured: false, apiKeyConfigured: false, usage: preview.usage })
    expect(providerDisconnect).toHaveBeenCalledTimes(1)
    expect(providerDisconnect).toHaveBeenCalledWith('openai', preview.revision, expect.objectContaining({ actor: 'api-key:root' }))
    const disconnected = await api.getProviderSettings('openai')
    const repeated = await mcp.callTool({ name: 'canonry_provider_disconnect', arguments: { provider: 'openai', expectedImpactRevision: disconnected.impactRevision } })
    expect(repeated.isError).not.toBe(true)
    expect(repeated.structuredContent).toEqual(disconnected)
  })

  it('tests a saved provider with the same result through the API, the CLI and MCP', async () => {
    const { api, connect, providerTest, origin } = await harness()
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    const run = (args: string[]) => dispatchRegisteredCommand(['settings', 'provider', 'test', ...args], 'human', SETTINGS_CLI_COMMANDS)
    const connected = { provider: 'openai', displayName: 'OpenAI', status: 'connected', ok: true, message: 'openai api key verified', model: 'gpt-old', checkedAt: expect.any(String), durationMs: expect.any(Number) }
    expect(await api.testProvider('openai')).toEqual(connected)
    await run(['openai', '--format', 'json'])
    expect(JSON.parse(out.mock.calls.at(-1)![0])).toEqual(connected)
    const mcp = await connect('root')
    const viaMcp = await mcp.callTool({ name: 'canonry_provider_test', arguments: { provider: 'openai' } })
    expect(viaMcp.isError).not.toBe(true)
    expect(viaMcp.structuredContent).toEqual(connected)

    // A provider refusal is a result everywhere; only the CLI turns it into exit 2, after printing it.
    providerTest.mockImplementation(() => ({ check: Promise.resolve({ ok: false, provider: 'openai', message: '401 Incorrect API key provided', model: 'gpt-old' }) }))
    const failed = { ...connected, status: 'failed', ok: false, message: '401 Incorrect API key provided' }
    await expect(run(['openai', '--format', 'json'])).rejects.toMatchObject({ code: 'PROVIDER_TEST_FAILED', exitCode: 2 })
    expect(JSON.parse(out.mock.calls.at(-1)![0])).toEqual(failed)
    const failedViaMcp = await mcp.callTool({ name: 'canonry_provider_test', arguments: { provider: 'openai' } })
    expect(failedViaMcp.isError).not.toBe(true)
    expect(failedViaMcp.structuredContent).toEqual(failed)

    // Nothing saved is the caller's mistake (exit 1), on every surface.
    providerTest.mockReturnValue(undefined)
    await expect(run(['openai', '--format', 'json'])).rejects.toMatchObject({ exitCode: 1, details: { httpStatus: 400 } })
    expect((await mcp.callTool({ name: 'canonry_provider_test', arguments: { provider: 'openai' } })).isError).toBe(true)
    expect(providerTest).toHaveBeenCalledTimes(7)

    // A key that cannot save provider settings is refused on every surface, before any provider call.
    const unrelated = await connect('unrelated')
    expect((await unrelated.callTool({ name: 'canonry_provider_test', arguments: { provider: 'openai' } })).isError).toBe(true)
    state.client = new ApiClient(origin, 'cnry_smoke_unrelated', { skipProbe: true })
    await expect(run(['openai', '--format', 'json'])).rejects.toMatchObject({ exitCode: 1, details: { httpStatus: 403 } })
    expect(providerTest).toHaveBeenCalledTimes(7)

    // So is a full-access key confined to one project: the connection and its account are the install's.
    const narrow = 'narrower than the install'
    const projectAdmin = await connect('projectAdmin')
    const refused = await projectAdmin.callTool({ name: 'canonry_provider_test', arguments: { provider: 'openai' } })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain(narrow)
    state.client = new ApiClient(origin, 'cnry_smoke_projectAdmin', { skipProbe: true })
    await expect(run(['openai', '--format', 'json'])).rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining(narrow), details: { httpStatus: 403 } })
    expect(providerTest).toHaveBeenCalledTimes(7)
  })

  it('denies internal diagnostics in the actual CLI while exposing host-derived identity', async () => {
    const { origin } = await harness()
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    state.client = new ApiClient(origin, 'cnry_smoke_unrelated', { skipProbe: true })
    await expect(showOperationalLogs({}, 'json')).rejects.toMatchObject({ details: { httpStatus: 403 } })
    await expect(telemetryCommand('status', 'json', 'server')).rejects.toMatchObject({ details: { httpStatus: 403 } })
    expect(out).not.toHaveBeenCalled()
    await showApiKeySelf('json')
    expect(JSON.parse(out.mock.calls.at(-1)![0])).toMatchObject({ operator: false })
    state.client = new ApiClient(origin, 'cnry_smoke_logs', { skipProbe: true })
    await showApiKeySelf('json')
    expect(JSON.parse(out.mock.calls.at(-1)![0])).toMatchObject({ operator: true, readOnly: true })
    await showOperationalLogs({}, 'json')
    expect(JSON.parse(out.mock.calls.at(-1)![0]).entries).toMatchObject([{ context: { runId: 'fixture-run', provider: 'openai' } }])
    out.mockClear()
    await showOperationalLogs({}, 'text')
    expect(out.mock.calls.map(call => String(call[0])).find(line => line.includes('smoke.completed'))).toContain('"provider":"openai"')
  })
  it('reads remote settings through CLI and edits a provider without transporting its secret', async () => {
    const { api, connect, providerUpdate } = await harness()
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    await showSettings('json')
    expect(JSON.parse(out.mock.calls.at(-1)![0])).toEqual(await api.getSettings())
    expect(JSON.parse(out.mock.calls.at(-1)![0]).google.configured).toBe(true)
    await setProvider('openai', { model: 'gpt-new', format: 'json' })
    expect(providerUpdate).toHaveBeenCalledWith('openai', '', 'gpt-new', undefined, undefined, expect.objectContaining({ actor: 'api-key:root' }))
    const mcp = await connect('root')
    const result = await mcp.callTool({ name: 'canonry_settings_get', arguments: {} })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual(await api.getSettings())
  })

  it('exposes the current scoped identity through MCP without granting mutation access', async () => {
    const { connect } = await harness()
    const mcp = await connect('read')
    const listed = await mcp.listTools()
    expect(listed.tools.some(tool => tool.name === 'canonry_key_self')).toBe(true)
    expect(listed.tools.some(tool => tool.name === 'canonry_research_run_start')).toBe(false)
    const result = await mcp.callTool({ name: 'canonry_key_self', arguments: {} })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ scopes: ['read'], readOnly: true, projectId: 'project-demo' })
    expect(JSON.stringify(result)).not.toContain('cnry_smoke_read')
    expect(JSON.stringify(result)).not.toContain('keyHash')
  })

  it('denies unrelated/read/research keys telemetry changes and exposes status through MCP', async () => {
    const { app, api, connect } = await harness()
    for (const name of ['unrelated', 'read', 'research']) {
      const response = await app.inject({ method: 'PUT', url: '/api/v1/telemetry', headers: { authorization: `Bearer cnry_smoke_${name}` }, payload: { enabled: true } })
      expect(response.statusCode, `${name}: ${response.body}`).toBe(403)
    }
    expect((await api.updateTelemetry(true)).enabled).toBe(true)
    const mcp = await connect('root')
    const result = await mcp.callTool({ name: 'canonry_telemetry_get', arguments: {} })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual(await api.getTelemetry())
  })

  it('preserves the complete server telemetry DTO through the explicit remote CLI target', async () => {
    const { api } = await harness()
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    await telemetryCommand('status', 'json', 'server')
    expect(JSON.parse(out.mock.calls.at(-1)![0])).toEqual(await api.getTelemetry())
  })

  it('enforces log access through MCP and returns only diagnostic metadata', async () => {
    const { connect } = await harness()
    for (const name of ['read', 'research', 'scopedLogs']) {
      const mcp = await connect(name)
      expect((await mcp.listTools()).tools.some(tool => tool.name === 'canonry_logs_list')).toBe(false)
      await expect(mcp.callTool({ name: 'canonry_logs_list', arguments: { projectId: 'project-demo' } }), name).rejects.toMatchObject({ code: -32602, message: 'Tool canonry_logs_list not found' })
    }
    const mcp = await connect('logs')
    const result = await mcp.callTool({ name: 'canonry_logs_list', arguments: {} })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ retention: 'durable', entries: [expect.objectContaining({ runId: 'fixture-run', context: expect.objectContaining({ provider: 'openai' }) })] })
    expect(JSON.stringify(result)).not.toContain('private query')
  })

  it('attributes an MCP write to its authenticated caller with transport correlation', async () => {
    const { api, connect } = await harness()
    const mcp = await connect('root')
    const result = await mcp.callTool({ name: 'canonry_queries_add', arguments: { project: 'demo', request: { queries: ['fixture query'] } } })
    expect(result.isError).not.toBe(true)
    const history = await api.getHistory('demo')
    expect(history).toContainEqual(expect.objectContaining({ actor: 'api-key:root', userAgent: expect.stringMatching(/^canonry-mcp\//), actorSession: expect.any(String) }))
  })

  it('supports approved non-secret settings mutations through MCP with the same API scope', async () => {
    const { connect, providerUpdate } = await harness()
    const mcp = await connect('settings')
    const updated = await mcp.callTool({ name: 'canonry_telemetry_update', arguments: { enabled: true } })
    expect(updated.isError).not.toBe(true)
    expect(updated.structuredContent).toMatchObject({ enabled: true, configuredEnabled: true })
    const provider = await mcp.callTool({ name: 'canonry_provider_settings_update', arguments: { provider: 'openai', model: 'gpt-new' } })
    expect(provider.isError).not.toBe(true)
    expect(providerUpdate).toHaveBeenCalledWith('openai', '', 'gpt-new', undefined, undefined, expect.objectContaining({
      actor: 'api-key:settings', userAgent: expect.stringMatching(/^canonry-mcp\//), actorSession: expect.any(String),
    }))
    const secret = await mcp.callTool({ name: 'canonry_provider_settings_update', arguments: { provider: 'openai', apiKey: 'must-not-be-accepted' } })
    expect(secret.isError).toBe(true)
    const unrelated = await connect('unrelated')
    expect((await unrelated.listTools()).tools.some(tool => tool.name === 'canonry_telemetry_update')).toBe(false)
    await expect(unrelated.callTool({ name: 'canonry_telemetry_update', arguments: { enabled: false } })).rejects.toMatchObject({ code: -32602, message: 'Tool canonry_telemetry_update not found' })
  })
})
