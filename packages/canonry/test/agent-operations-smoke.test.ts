import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { apiRoutes, hashApiKey } from '@ainyc/canonry-api-routes'
import { apiKeys, createClient, migrate, projects, OperationalLogStore } from '@ainyc/canonry-db'
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

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-ops-smoke-'))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({ id: 'project-demo', name: 'demo', displayName: 'Demo', canonicalDomain: 'demo.example', country: 'US', language: 'en', providers: ['openai'], createdAt: now, updatedAt: now }).run()
  for (const [name, scopes] of Object.entries({ root: ['*'], unrelated: ['runs.write'], read: ['read'], research: ['read', 'research.run'], settings: ['read', 'settings.write'], logs: ['read', 'logs.read'], scopedLogs: ['read', 'logs.read'] })) {
    const token = `cnry_smoke_${name}`
    db.insert(apiKeys).values({ id: name, name, keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), scopes, projectId: name === 'read' || name === 'scopedLogs' ? 'project-demo' : null, createdAt: now }).run()
  }
  const app = Fastify()
  cleanup.push(async () => { await app.close(); db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const providers = [{ name: 'openai', configured: true, model: 'gpt-old' }]
  let telemetry = false
  const logs = new OperationalLogStore(db)
  logs.append({ ts: now, level: 'info', module: 'Smoke', action: 'smoke.completed', projectId: 'project-demo', runId: 'fixture-run', query: 'private query' })
  const providerUpdate = vi.fn((_provider: string, _key: string, model?: string) => {
    providers[0]!.model = model ?? providers[0]!.model
    return { ...providers[0]! }
  })
  const options: McpHttpOptions = { db, selfApiUrl: '' }
  app.register(apiRoutes, {
    db,
    providerSummary: providers,
    providerAdapters: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-old', knownModels: [], modelValidationPattern: /^gpt-/, modelValidationHint: 'gpt model' }],
    googleSettingsSummary: { configured: true },
    onProviderUpdate: providerUpdate,
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
  return { app, api, connect, providerUpdate, origin }
}

describe('agent operations cross-surface smoke', () => {
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
      const result = await mcp.callTool({ name: 'canonry_logs_list', arguments: { projectId: 'project-demo' } })
      expect(result.isError, name).toBe(true)
      expect(result.structuredContent).toMatchObject({ error: { details: { httpStatus: 403 } } })
    }
    const mcp = await connect('logs')
    const result = await mcp.callTool({ name: 'canonry_logs_list', arguments: {} })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ retention: 'durable', entries: [expect.objectContaining({ runId: 'fixture-run' })] })
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
    const denied = await unrelated.callTool({ name: 'canonry_telemetry_update', arguments: { enabled: false } })
    expect(denied.isError).toBe(true)
    expect(denied.structuredContent).toMatchObject({ error: { details: { httpStatus: 403 } } })
  })
})
