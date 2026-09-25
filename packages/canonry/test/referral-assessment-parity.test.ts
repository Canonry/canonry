import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { apiKeys, projects, trafficSources, aiReferralEventsHourly, createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes, hashApiKey } from '@ainyc/canonry-api-routes'
import { referralAssessmentSchema } from '@ainyc/canonry-contracts'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'
import { TRAFFIC_CLI_COMMANDS } from '../src/cli-commands/traffic.js'

let api: ApiClient
vi.mock('../src/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/client.js')>(), createApiClient: () => api }))

describe('referral assessment authenticated HTTP, CLI and MCP parity', () => {
  let db: ReturnType<typeof createClient>
  let app: ReturnType<typeof Fastify>
  const token = 'cnry_referral_fixture_only'
  const input = { startDate: '2026-08-01', endDate: '2026-08-31', sourceId: 'source', burstThreshold: 119, ratioThreshold: 4, limit: 2 }
  const path = `/canonry/api/v1/projects/example/traffic/referral-assessment?${new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]))}`

  beforeEach(async () => {
    db = createClient(':memory:'); migrate(db)
    const date = '2026-08-01T00:00:00.000Z'
    for (const name of ['example', 'other']) db.insert(projects).values({ id: name, name, displayName: name, canonicalDomain: `${name}.com`, country: 'US', language: 'en', createdAt: date, updatedAt: date }).run()
    db.insert(apiKeys).values({ id: 'reader', name: 'Scoped reader', keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), scopes: ['read'], projectId: 'example', createdAt: date }).run()
    db.insert(trafficSources).values({ id: 'source', projectId: 'example', sourceType: 'cloudflare', displayName: 'Source', status: 'connected', createdAt: date, updatedAt: date }).run()
    db.insert(aiReferralEventsHourly).values({ projectId: 'example', sourceId: 'source', tsHour: date, product: 'ChatGPT', operator: 'OpenAI', sourceDomain: 'chatgpt.com', evidenceType: 'referer', landingPathNormalized: '/', status: 200, sessionsOrHits: 119, paidSessionsOrHits: 9, organicSessionsOrHits: 100, createdAt: date, updatedAt: date }).run()
    app = Fastify(); await app.register(apiRoutes, { db, routePrefix: '/canonry/api/v1' }); await app.ready()
    // Keep the real SDK request, serialization, authorization and Fastify route.
    // Only replace the socket with Fastify's HTTP injection transport.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      const response = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers.entries()) })
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } })
    }))
    api = new ApiClient('https://fixture.invalid/canonry', token, { skipProbe: true })
  })
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await app.close(); db.$client.close() })

  it('returns the exact API evidence through CLI JSON and a real MCP tools/call', async () => {
    const http = await app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${token}` } })
    expect(http.statusCode).toBe(200)
    const expected = referralAssessmentSchema.parse(http.json())
    expect(expected.totals.suspected).toEqual({ total: 119, paid: 9, organic: 100, unknown: 10 })
    const command = TRAFFIC_CLI_COMMANDS.find(command => command.path.join(' ') === 'traffic referral-assessment')
    expect(command).toBeDefined()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await command!.run({ positionals: ['example'], values: { 'start-date': input.startDate, 'end-date': input.endDate, source: input.sourceId, 'burst-threshold': '119', 'ratio-threshold': '4', limit: '2' }, format: 'json', dryRun: false })
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(expected)
    const server = createCanonryMcpServer({ eager: true, scope: 'read-only', clientFactory: () => api })
    const client = new Client({ name: 'referral-smoke', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport); await client.connect(clientTransport)
      const result = await client.callTool({ name: 'canonry_traffic_referral_assessment', arguments: { project: 'example', ...input } })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual(expected)
      const denied = await client.callTool({ name: 'canonry_traffic_referral_assessment', arguments: { project: 'other', ...input } })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied)).not.toContain('adjustedEstimate')
    } finally { await client.close(); await server.close() }
  })

  it('enforces missing authentication, project boundaries and unsupported Advanced attribution', async () => {
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: path.replace('/example/', '/other/'), headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: `${path}&marketKey=europe`, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(400)
  })
})
