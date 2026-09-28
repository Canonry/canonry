import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRoutes, hashApiKey } from '@ainyc/canonry-api-routes'
import { OPERATIONAL_LOG_FIELDS_HEADER } from '@ainyc/canonry-contracts'
import { apiKeys, createClient, migrate, OperationalLogStore } from '@ainyc/canonry-db'
import { ApiClient } from '../src/client.js'
import { jsonToolResult } from '../src/mcp/results.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'
// The strict page contract every adapter built before #1209 validates with.
import { legacyOperationalLogPageSchema as legacyPageSchema } from '../../contracts/test/fixtures/operational-logs-v1.js'

const TOKEN = 'cnry_compat_logs'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const close of cleanup.splice(0).reverse()) await close()
})

/** The current server, with one saved sweep failure that carries its provider. */
async function currentServer(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-logs-compat-'))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(apiKeys).values({ id: 'logs', name: 'logs', keyHash: hashApiKey(TOKEN), keyPrefix: TOKEN.slice(0, 9), scopes: ['logs.read'], createdAt: now }).run()
  const logs = new OperationalLogStore(db)
  logs.append({ ts: now, level: 'error', module: 'JobRunner', action: 'query.failed', runId: 'run_1', provider: 'claude', query: 'private query' })
  expect(logs.list({ limit: 10 }).entries[0]!.context.provider).toBe('claude')
  const app = Fastify()
  cleanup.push(async () => { await app.close(); db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  app.register(apiRoutes, { db, operatorApiKeyIds: ['logs'], listOperationalLogs: query => logs.list(query) })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test address')
  return `http://127.0.0.1:${address.port}`
}

/** The request an older adapter makes: its bearer, and no field opt-in. */
async function readPage(origin: string, fields?: string): Promise<unknown> {
  const response = await fetch(`${origin}/api/v1/operations/logs`, {
    headers: { authorization: `Bearer ${TOKEN}`, ...(fields === undefined ? {} : { [OPERATIONAL_LOG_FIELDS_HEADER]: fields }) },
  })
  expect(response.status).toBe(200)
  return response.json()
}

async function connect(server: McpServer): Promise<Client> {
  const client = new Client({ name: 'logs-compat-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanup.push(async () => { await client.close(); await server.close() })
  // Listing caches the client's own validator for each advertised output schema.
  await client.listTools()
  return client
}

/** An adapter built before #1209: canonry_logs_list checked against the older strict contract. */
function legacyAdapter(page: () => Promise<unknown>): Promise<Client> {
  const server = new McpServer({ name: 'canonry', version: 'legacy' })
  server.registerTool('canonry_logs_list', { title: 'Read runtime logs', outputSchema: legacyPageSchema }, async () => jsonToolResult(await page()))
  return connect(server)
}

describe('runtime logs across adapter and server versions', () => {
  it('serves a default page an older strict reader still parses', async () => {
    const origin = await currentServer()
    const page = await readPage(origin)
    expect(legacyPageSchema.parse(page).entries).toMatchObject([{ action: 'query.failed', runId: 'run_1', context: { runId: 'run_1' } }])
    expect(JSON.stringify(page)).not.toMatch(/provider|claude|private query/)

    // Control: the provider-bearing page is exactly what that reader rejects.
    const optedIn = await readPage(origin, 'provider')
    expect(optedIn).toMatchObject({ entries: [{ context: { runId: 'run_1', provider: 'claude' } }] })
    expect(() => legacyPageSchema.parse(optedIn)).toThrow(/Unrecognized key.*provider/)
  })

  it('keeps an older adapter reading the log page through MCP', async () => {
    const origin = await currentServer()
    const legacy = await legacyAdapter(() => readPage(origin))
    const result = await legacy.callTool({ name: 'canonry_logs_list', arguments: {} })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ retention: 'durable', entries: [{ action: 'query.failed', context: { runId: 'run_1' } }] })
    expect(JSON.stringify(result)).not.toContain('provider')

    // Control, the reviewer's reproduction: fed the provider, the whole call fails.
    const rejecting = await legacyAdapter(() => readPage(origin, 'provider'))
    const failure = await rejecting.callTool({ name: 'canonry_logs_list', arguments: {} })
    expect(failure.isError).toBe(true)
    expect(JSON.stringify(failure.content)).toMatch(/Unrecognized key.*provider/)
  })

  it('shows the provider through this adapter against this server', async () => {
    const origin = await currentServer()
    const api = new ApiClient(origin, TOKEN, { skipProbe: true })
    const mcp = await connect(createCanonryMcpServer({ eager: true, operator: true, clientFactory: () => api }))
    const result = await mcp.callTool({ name: 'canonry_logs_list', arguments: {} })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ entries: [{ action: 'query.failed', context: { runId: 'run_1', provider: 'claude' } }] })
    expect(JSON.stringify(result)).not.toContain('private query')
  })

  it.each([
    ['an older server that ignores the opt-in', {}, {}],
    ['a newer server that adds fields', { region: 'us-east', provider: 'claude' }, { provider: 'claude' }],
  ] as const)('reads pages from %s through this adapter', async (_label, extraContext, expectedExtra) => {
    const headers: Array<string | null> = []
    const entry = { cursor: 'c1', ts: '2026-09-11T00:00:00.000Z', level: 'error', module: 'JobRunner', action: 'query.failed', runId: 'run_1' }
    const newer = 'region' in extraContext
    const page = {
      entries: [{ ...entry, ...(newer ? { severityText: 'ERROR' } : {}), context: { runId: 'run_1', ...extraContext } }],
      nextCursor: null, truncated: 0, dropped: 0, retention: 'durable', observedAt: '2026-09-11T00:00:01.000Z',
      ...(newer ? { region: 'us-east' } : {}),
    }
    if (!newer) legacyPageSchema.parse(page)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      expect(new URL(request.url).pathname).toBe('/api/v1/operations/logs')
      headers.push(request.headers.get(OPERATIONAL_LOG_FIELDS_HEADER))
      return new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json' } })
    }))
    const api = new ApiClient('https://logs-fixture.invalid', TOKEN, { skipProbe: true })
    const mcp = await connect(createCanonryMcpServer({ eager: true, operator: true, clientFactory: () => api }))
    const result = await mcp.callTool({ name: 'canonry_logs_list', arguments: {} })
    expect(result.isError).not.toBe(true)
    const expected = {
      entries: [{ ...entry, context: { runId: 'run_1', ...expectedExtra } }],
      nextCursor: null, truncated: 0, dropped: 0, retention: 'durable', observedAt: '2026-09-11T00:00:01.000Z',
    }
    expect(result.structuredContent).toEqual(expected)
    const text = (result.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text')!.text!
    expect(JSON.parse(text)).toEqual(expected)
    expect(headers).toEqual(['provider'])
    // The tool's declared output schema drops unknown keys on its own as well.
    expect(canonryMcpTools.find(tool => tool.name === 'canonry_logs_list')!.outputSchema!.parse(page)).toEqual(expected)
  })
})
