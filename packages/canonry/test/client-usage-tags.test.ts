import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, runWithUsageTags } from '../src/client.js'
import { cliRuntimeContext } from '../src/runtime-context.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function captureRequests(delayFor: (request: Request) => number = () => 0) {
  const requests: Request[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    requests.push(request)
    await new Promise(resolve => setTimeout(resolve, delayFor(request)))
    return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } })
  }))
  return requests
}

describe('ApiClient usage labels', () => {
  it('labels every request with its surface, defaulting to the CLI', async () => {
    const requests = captureRequests()

    await new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true }).listProjects()
    await new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true, surface: 'mcp-stdio' }).listProjects()

    expect(requests.map(r => r.headers.get('x-canonry-surface'))).toEqual(['cli', 'mcp-stdio'])
    for (const request of requests) expect(request.headers.get('x-canonry-agent')).toEqual(expect.any(String))
  })

  it('attaches tool labels only inside their scope, and never across concurrent tool calls', async () => {
    const client = new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true, surface: 'mcp-stdio' })
    // The first call answers last, so a label leaking through shared state
    // rather than the async scope would land on the wrong request.
    const requests = captureRequests(() => (requests.length === 1 ? 30 : 0))

    await Promise.all([
      runWithUsageTags(client, { mcpTool: 'canonry_a', mcpCall: 'call-a', mcpClient: 'claude-code' }, () => client.listProjects()),
      runWithUsageTags(client, { mcpTool: 'canonry_b', mcpCall: 'call-b' }, () => client.listProjects()),
    ])
    await client.listProjects()

    const labels = requests.map(r => [r.headers.get('x-canonry-mcp-tool'), r.headers.get('x-canonry-mcp-call'), r.headers.get('x-canonry-mcp-client')])
    expect(labels).toEqual([
      ['canonry_a', 'call-a', 'claude-code'],
      ['canonry_b', 'call-b', null],
      [null, null, null],
    ])
  })

  it('never fails a tool call over an MCP client name a header cannot carry', async () => {
    const client = new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true, surface: 'mcp-stdio' })
    const requests = captureRequests()

    // Headers.set throws on non-Latin-1 and control characters; clientInfo.name is free text.
    await expect(runWithUsageTags(client, { mcpTool: 'canonry_a', mcpClient: 'Claude — Desktop 日本' }, () => client.listProjects())).resolves.toEqual([])
    await expect(runWithUsageTags(client, { mcpTool: 'canonry_a', mcpClient: 'bad\nname' }, () => client.listProjects())).resolves.toEqual([])
    await expect(runWithUsageTags(client, { mcpTool: 'canonry_a', mcpClient: '日本' }, () => client.listProjects())).resolves.toEqual([])

    expect(requests.map(r => r.headers.get('x-canonry-mcp-client'))).toEqual(['claude-desktop', 'bad-name', null])
  })

  it('claims no env-detected agent for clients the server builds for itself', async () => {
    vi.stubEnv('CLAUDECODE', '1')
    try {
      const requests = captureRequests()

      await new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true, surface: 'aero' }).listProjects()
      await new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true, surface: 'mcp-http' }).listProjects()
      await new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true, surface: 'mcp-stdio' }).listProjects()

      // `canonry serve` launched from Claude Code must not label hosted MCP or Aero traffic as Claude.
      expect(requests.map(r => r.headers.get('x-canonry-agent'))).toEqual([null, null, 'claude'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('runs the work unlabelled for a client double that cannot carry labels', async () => {
    const fake = { listProjects: vi.fn().mockResolvedValue([]) }
    await expect(runWithUsageTags(fake, { mcpTool: 'canonry_a' }, () => fake.listProjects())).resolves.toEqual([])
  })
})

describe('cliRuntimeContext', () => {
  it('reports the detected agent and whether a person is at a terminal', () => {
    expect(cliRuntimeContext({ CLAUDECODE: '1' }, { stdin: { isTTY: false }, stdout: { isTTY: false } }))
      .toEqual({ agent: 'claude', interactive: false })
    expect(cliRuntimeContext({}, { stdin: { isTTY: true }, stdout: { isTTY: true } }))
      .toEqual({ agent: 'none', interactive: true })
    expect(cliRuntimeContext({}, { stdin: { isTTY: true }, stdout: {} }))
      .toEqual({ agent: 'none', interactive: false })
  })
})
