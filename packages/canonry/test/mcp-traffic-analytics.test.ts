import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'
import { TRAFFIC_ANALYTICS_FIXTURE } from './traffic-analytics-fixture.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(close => close()))
  vi.unstubAllGlobals()
})

async function connect(value: unknown = TRAFFIC_ANALYTICS_FIXTURE) {
  const requests: Request[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(input instanceof Request ? input : new Request(input, init))
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  const server = createCanonryMcpServer({
    scope: 'read-only',
    tiers: ['core', 'traffic'],
    clientFactory: () => new ApiClient('https://canonry.test/canonry', 'cnry_read', { skipProbe: true }),
  })
  const client = new Client({ name: 'traffic-analytics-test', version: '1' }, { capabilities: {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanups.push(async () => { await client.close(); await server.close() })
  return { client, requests, fetch }
}

describe('traffic analytics MCP transport', () => {
  it.each([undefined, 14] as const)('preserves complete API evidence over the read-only traffic catalog with period %s', async period => {
    const { client, requests } = await connect()
    const result = await client.callTool({ name: 'canonry_traffic_analytics', arguments: { project: 'advanced', ...(period !== undefined && { period }) } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual(TRAFFIC_ANALYTICS_FIXTURE)
    const text = result.content.find(content => content.type === 'text')
    expect(JSON.parse(text!.text)).toEqual(TRAFFIC_ANALYTICS_FIXTURE)
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    const url = new URL(request.url)
    expect(url.pathname).toBe('/canonry/api/v1/projects/advanced/traffic/analytics')
    expect(url.searchParams.get('period')).toBe(period === undefined ? null : String(period))
    expect(request.headers.get('authorization')).toBe('Bearer cnry_read')
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('canonry_report')
  })

  it('returns missing-source evidence unchanged', async () => {
    const { client } = await connect({ activity: null })
    const result = await client.callTool({ name: 'canonry_traffic_analytics', arguments: { project: 'simple' } })
    expect(result.structuredContent).toEqual({ activity: null })
  })

  it('rejects unsupported periods before any API request', async () => {
    const { client, fetch } = await connect()
    const result = await client.callTool({ name: 'canonry_traffic_analytics', arguments: { project: 'simple', period: 6 } })
    expect(result.isError).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })
})
