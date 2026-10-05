import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BingCoverageSummaryDto } from '@ainyc/canonry-contracts'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'

const INSPECTED_AT = '2026-10-05T12:00:00.000Z'
const COVERAGE: BingCoverageSummaryDto = {
  summary: { total: 3, indexed: 1, notIndexed: 1, unknown: 1, percentage: 33.333333 },
  lastInspectedAt: INSPECTED_AT,
  indexed: [{ id: 'indexed', url: 'https://example.com/indexed', inIndex: true, inspectedAt: INSPECTED_AT }],
  notIndexed: [{ id: 'not-indexed', url: 'https://example.com/not-indexed', inIndex: false, inspectedAt: INSPECTED_AT }],
  unknown: [{ id: 'unknown', url: 'https://example.com/unknown', inIndex: null, inspectedAt: INSPECTED_AT }],
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(close => close()))
  vi.unstubAllGlobals()
})

async function connect(options: { body?: unknown; status?: number; progressive?: boolean } = {}) {
  const requests: Request[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(input instanceof Request ? input : new Request(input, init))
    return new Response(JSON.stringify(options.body ?? COVERAGE), {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetch)
  const server = createCanonryMcpServer({
    scope: 'read-only',
    ...(options.progressive ? {} : { tiers: ['core', 'bing'] }),
    clientFactory: () => new ApiClient('https://canonry.test/canonry', 'cnry_project_read', { skipProbe: true }),
  })
  const client = new Client({ name: 'bing-coverage-test', version: '1' }, { capabilities: {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanups.push(async () => { await client.close(); await server.close() })
  return { client, requests, fetch }
}

describe('Bing coverage MCP transport', () => {
  it.each(['simple', 'advanced'])('preserves stored coverage for the %s project through the authenticated public read', async project => {
    const { client, requests } = await connect()
    const result = await client.callTool({ name: 'canonry_bing_coverage', arguments: { project } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual(COVERAGE)
    const content = result.content.find(part => part.type === 'text')
    expect(JSON.parse(content!.text)).toEqual(COVERAGE)
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.method).toBe('GET')
    expect(new URL(request.url).pathname).toBe(`/canonry/api/v1/projects/${project}/bing/coverage`)
    expect(new URL(request.url).search).toBe('')
    expect(request.headers.get('authorization')).toBe('Bearer cnry_project_read')
  })

  it('loads the read tool through the progressive Bing toolkit', async () => {
    const { client, fetch } = await connect({ progressive: true })
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('canonry_bing_coverage')
    const loaded = await client.callTool({ name: 'canonry_load_toolkit', arguments: { name: 'bing' } })
    expect(loaded.isError).not.toBe(true)
    expect((await client.listTools()).tools.filter(tool => tool.name.startsWith('canonry_bing_')).map(tool => tool.name))
      .toEqual(['canonry_bing_coverage'])
    expect(fetch).not.toHaveBeenCalled()
    expect((await client.callTool({ name: 'canonry_bing_coverage', arguments: { project: 'simple' } })).structuredContent)
      .toEqual(COVERAGE)
  })

  it('preserves the API permission refusal without broadening the credential', async () => {
    const error = { error: { code: 'FORBIDDEN', message: 'This key cannot read that project.', details: { project: 'foreign' } } }
    const { client, requests } = await connect({ body: error, status: 403 })
    const result = await client.callTool({ name: 'canonry_bing_coverage', arguments: { project: 'foreign' } })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({ error: { ...error.error, details: { project: 'foreign', httpStatus: 403 } } })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer cnry_project_read')
  })

  it('rejects an empty project before reading the API', async () => {
    const { client, fetch } = await connect()
    const result = await client.callTool({ name: 'canonry_bing_coverage', arguments: { project: '' } })
    expect(result.isError).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })
})
