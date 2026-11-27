import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import type { RunPreviewDto } from '@canonry/canonry-contracts'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServerWithCatalog } from '../src/mcp/server.js'
import { invokeCliRead, prepareCliReadFixture } from './cli-read-fixture.js'
import { invokeCli } from './cli-test-utils.js'

function fixture(mode: 'simple' | 'advanced'): RunPreviewDto {
  return {
    mode, revision: mode === 'advanced' ? 7 : null, queryCount: 2, assignmentCount: mode === 'advanced' ? 4 : null,
    queryClasses: [
      { queryClass: 'non-brand', queryCount: 1, assignmentCount: mode === 'advanced' ? 3 : null },
      { queryClass: 'branded', queryCount: 1, assignmentCount: mode === 'advanced' ? 1 : null },
    ],
    requestCount: 2, expectedRequestCount: 4,
    engines: [
      { provider: 'gemini', models: ['frozen-model'], requestCount: 2, expectedRequestCount: 2, available: true },
      { provider: 'openai', models: ['other-model'], requestCount: 0, expectedRequestCount: 2, available: false },
    ],
    locations: [{ location: 'Harbor', requestCount: 2 }],
    admission: { refused: false, retryAfter: null, providers: {} }, activeRunId: null, canStart: true, blockedReason: null,
  }
}

describe('manual sweep preview transports', () => {
  let cleanup = () => {}
  beforeEach(() => { cleanup = prepareCliReadFixture() })
  afterEach(() => { vi.restoreAllMocks(); cleanup() })

  it.each(['simple', 'advanced'] as const)('preserves %s planned and runnable counts through stored-only CLI and MCP calls', async mode => {
    const payload = fixture(mode)
    const cli = await invokeCliRead(['run', 'preview', 'demo', '--format', 'json', '--stored-only'], payload, { pathname: '/prefix/api/v1/projects/demo/run-preview' })
    expect(cli.stderr).toBe('')
    expect(cli.exitCode).toBeUndefined()
    expect(JSON.parse(cli.stdout)).toEqual(payload)

    const requests: Request[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init))
      return Response.json(payload)
    }))
    const api = new ApiClient('https://canonry.test/prefix', 'cnry_preview-read', { skipProbe: true })
    const { server } = createCanonryMcpServerWithCatalog({ clientFactory: () => api, scope: 'stored-only', credentialScopes: ['read'], eager: true })
    const mcp = new Client({ name: 'run-preview-test', version: '1' }, { capabilities: {} })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await mcp.connect(clientTransport)
      const response = await mcp.callTool({ name: 'canonry_run_preview', arguments: { project: 'demo' } })
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
      expect(response.structuredContent).toEqual(payload)
    } finally {
      await mcp.close()
      await server.close()
    }
    expect(requests).toHaveLength(1)
    expect(requests[0]!.method).toBe('GET')
    expect(new URL(requests[0]!.url).pathname).toBe('/prefix/api/v1/projects/demo/run-preview')
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer cnry_preview-read')
  })

  it('prints server counts and frozen revision with unavailable engines, without presenting planned work as runnable', async () => {
    const cli = await invokeCliRead(['run', 'preview', 'demo'], fixture('advanced'), { pathname: '/prefix/api/v1/projects/demo/run-preview' })
    expect(cli.stdout).toContain('published revision 7')
    expect(cli.stdout).toContain('2 queries · 4 assignments')
    expect(cli.stdout).toContain('2 runnable requests · 4 planned answers')
    expect(cli.stdout).toContain('openai (other-model): 0 requests · unavailable')
    expect(cli.stdout).toContain('Location: Harbor · 2 requests')
  })

  it('emits one complete preview per JSONL line for streaming consumers', async () => {
    const payload = fixture('advanced')
    const written: string[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
    const cli = await invokeCliRead(['run', 'preview', 'demo', '--format', 'jsonl'], payload, { pathname: '/prefix/api/v1/projects/demo/run-preview' })
    stdout.mockRestore()
    expect(cli.stderr).toBe('')
    expect(cli.exitCode).toBeUndefined()
    expect(cli.stdout).toBe('')
    expect(written.join('').trim().split('\n').map(line => JSON.parse(line))).toEqual([payload])
  })

  it('never treats a preview without a project as a launch', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const cli = await invokeCli(['run', 'preview', '--format', 'json'])
    expect(cli.exitCode).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  })
})
