import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'

afterEach(() => vi.unstubAllGlobals())

it.each(['legacy', 'current'] as const)('supports telemetry reads and successful writes against a %s server', async version => {
  let configuredEnabled = true
  const methods: string[] = []
  // Legacy fixture matches GET/PUT /telemetry on main before this PR: only
  // enabled and optional masked anonymousId, with no effective-state fields.
  const status = () => version === 'legacy'
    ? { enabled: configuredEnabled, anonymousId: '01234567...' }
    : { enabled: false, configuredEnabled, reason: 'DO_NOT_TRACK', target: 'server', anonymousId: '01234567...' }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    expect(new URL(request.url).pathname).toBe('/api/v1/telemetry')
    methods.push(request.method)
    if (request.method === 'PUT') configuredEnabled = (await request.json() as { enabled: boolean }).enabled
    return new Response(JSON.stringify(status()), { headers: { 'content-type': 'application/json' } })
  }))
  const api = new ApiClient('https://telemetry-fixture.invalid', 'cnry_fixture', { skipProbe: true })
  const server = createCanonryMcpServer({ eager: true, operator: true, clientFactory: () => api })
  const client = new Client({ name: 'telemetry-compat-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    for (const enabled of [undefined, false, true]) {
      const result = await client.callTool({
        name: enabled === undefined ? 'canonry_telemetry_get' : 'canonry_telemetry_update',
        arguments: enabled === undefined ? {} : { enabled },
      })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual({
        enabled: version === 'legacy' ? configuredEnabled : false,
        configuredEnabled,
        reason: version === 'legacy' ? configuredEnabled ? 'enabled' : 'configured_disabled' : 'DO_NOT_TRACK',
        target: 'server',
        anonymousId: '01234567...',
      })
      const text = (result.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text')!.text!
      expect(JSON.parse(text)).toEqual(result.structuredContent)
      if (enabled !== undefined) expect(configuredEnabled).toBe(enabled)
    }
    expect(methods).toEqual(['GET', 'PUT', 'PUT'])
  } finally {
    await client.close()
    await server.close()
  }
})
