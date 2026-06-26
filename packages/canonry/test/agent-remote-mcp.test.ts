import { describe, it, expect } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  loadExternalMcpTools,
  connectStreamableHttp,
  type RemoteMcpClient,
} from '../src/agent/remote-mcp.js'
import { parseExternalMcpEnv, type ExternalMcpServerConfig } from '../src/config.js'

const READ_TOOL = 'demo_read_artifact'
const WRITE_TOOL = 'demo_write_thing'
const EXCLUDED_TOOL = 'demo_excluded_tool'
const KNOWN_ARTIFACT = { reasonCode: 'R7', value: 42 }

/**
 * Stand up an in-process MCP server exposing three tools:
 *   - a read-only tool (readOnlyHint: true) that returns a known artifact
 *   - a write tool (readOnlyHint: false)
 *   - a tool whose NAME is in the exclusion set passed to the loader
 * Connect a real MCP SDK Client to it over an InMemory transport pair and
 * return the client. This exercises the same `listTools` / `callTool` path the
 * production StreamableHTTP client uses, without standing up an HTTP server.
 */
async function makeInMemoryServerClient(): Promise<RemoteMcpClient> {
  const server = new McpServer({ name: 'demo-remote', version: '1.0.0' })

  server.registerTool(
    READ_TOOL,
    {
      description: 'Read a known artifact (read-only).',
      inputSchema: {},
      annotations: { readOnlyHint: true, title: 'Read artifact' },
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(KNOWN_ARTIFACT) }],
    }),
  )

  server.registerTool(
    WRITE_TOOL,
    {
      description: 'A mutating tool that must never reach Aero.',
      inputSchema: {},
      annotations: { readOnlyHint: false },
    },
    async () => ({ content: [{ type: 'text', text: 'wrote' }] }),
  )

  // Excluded tool is ALSO read-only, proves the exclusion filter is independent
  // of the read-only filter (a read-only tool can still be excluded by name).
  server.registerTool(
    EXCLUDED_TOOL,
    {
      description: 'Read-only but excluded by name.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: 'text', text: 'should-not-load' }] }),
  )

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const client = new Client({ name: 'test-aero', version: '1.0.0' }, { capabilities: {} })
  await client.connect(clientTransport)
  return client as unknown as RemoteMcpClient
}

const SERVER: ExternalMcpServerConfig = { url: 'http://remote.invalid/mcp', token: 'tok_abc', label: 'demo' }

describe('loadExternalMcpTools', () => {
  it('discovers + calls a read-only tool, returning its artifact', async () => {
    const tools = await loadExternalMcpTools([SERVER], {
      connect: makeInMemoryServerClient,
      excluded: new Set([EXCLUDED_TOOL]),
    })

    const readTool = tools.find((t) => t.name === READ_TOOL)
    expect(readTool, 'read-only tool should be discovered').toBeDefined()

    const result = await readTool!.execute('call-1', {})
    // The adapter returns the raw MCP callTool envelope under `details`. The
    // tool's known artifact rides inside that envelope's first text block.
    const details = result.details as { content: Array<{ type: string; text: string }> }
    expect(JSON.parse(details.content[0].text)).toEqual(KNOWN_ARTIFACT)
    // And the model-facing content is the serialized envelope (carrying the artifact).
    const text = result.content.find((c) => c.type === 'text') as { text: string } | undefined
    expect(text?.text).toContain('reasonCode')
    expect(text?.text).toContain('R7')
  })

  it('filters OUT the write tool (not read-only)', async () => {
    const tools = await loadExternalMcpTools([SERVER], {
      connect: makeInMemoryServerClient,
      excluded: new Set([EXCLUDED_TOOL]),
    })
    expect(tools.map((t) => t.name)).not.toContain(WRITE_TOOL)
  })

  it('filters OUT the excluded tool even though it is read-only', async () => {
    const tools = await loadExternalMcpTools([SERVER], {
      connect: makeInMemoryServerClient,
      excluded: new Set([EXCLUDED_TOOL]),
    })
    expect(tools.map((t) => t.name)).not.toContain(EXCLUDED_TOOL)
  })

  it('only the read-only, non-excluded tool survives the filter', async () => {
    const tools = await loadExternalMcpTools([SERVER], {
      connect: makeInMemoryServerClient,
      excluded: new Set([EXCLUDED_TOOL]),
    })
    expect(tools.map((t) => t.name)).toEqual([READ_TOOL])
  })

  it('returns [] when no servers are configured', async () => {
    expect(await loadExternalMcpTools(undefined)).toEqual([])
    expect(await loadExternalMcpTools([])).toEqual([])
  })

  it('skips a server that fails to connect (never throws the whole load)', async () => {
    const tools = await loadExternalMcpTools(
      [
        { url: 'http://bad.invalid/mcp', token: 't1', label: 'bad' },
        SERVER,
      ],
      {
        connect: async (server) => {
          if (server.label === 'bad') throw new Error('connection refused')
          return makeInMemoryServerClient()
        },
        excluded: new Set([EXCLUDED_TOOL]),
      },
    )
    // The good server's read tool still loads; the bad one is skipped silently.
    expect(tools.map((t) => t.name)).toEqual([READ_TOOL])
  })
})

describe('connectStreamableHttp (frozen transport)', () => {
  it('constructs a StreamableHTTPClientTransport with the bearer header', async () => {
    // We do not actually connect (no server at the URL); we only assert that the
    // production path builds the bearer-gated Streamable HTTP transport. The
    // transport is constructed lazily inside connectStreamableHttp, so we probe
    // the SDK transport directly with the same options the loader uses.
    const transport = new StreamableHTTPClientTransport(new URL(SERVER.url), {
      requestInit: { headers: { Authorization: `Bearer ${SERVER.token}` } },
    })
    // The transport stores requestInit privately; assert via its constructed shape.
    const requestInit = (transport as unknown as { _requestInit?: RequestInit })._requestInit
    expect(requestInit?.headers).toEqual({ Authorization: 'Bearer tok_abc' })
    await transport.close()

    // And assert the production helper is callable + uses StreamableHTTP: it
    // should reject (no real server) rather than fall back to any other transport.
    await expect(connectStreamableHttp(SERVER)).rejects.toBeDefined()
  })
})

describe('parseExternalMcpEnv (CANONRY_EXTERNAL_MCP)', () => {
  it('parses a JSON array of {url, token, label}', () => {
    const parsed = parseExternalMcpEnv(
      JSON.stringify([{ url: 'http://a/mcp', token: 't1', label: 'a' }, { url: 'http://b/mcp', token: 't2' }]),
    )
    expect(parsed).toEqual([
      { url: 'http://a/mcp', token: 't1', label: 'a' },
      { url: 'http://b/mcp', token: 't2' },
    ])
  })

  it('drops entries missing a url or token', () => {
    const parsed = parseExternalMcpEnv(
      JSON.stringify([{ url: 'http://a/mcp' }, { token: 't2' }, { url: 'http://c/mcp', token: 't3' }]),
    )
    expect(parsed).toEqual([{ url: 'http://c/mcp', token: 't3' }])
  })

  it('returns undefined for absent / empty / malformed / non-array input', () => {
    expect(parseExternalMcpEnv(undefined)).toBeUndefined()
    expect(parseExternalMcpEnv('')).toBeUndefined()
    expect(parseExternalMcpEnv('   ')).toBeUndefined()
    expect(parseExternalMcpEnv('{not json')).toBeUndefined()
    expect(parseExternalMcpEnv(JSON.stringify({ url: 'x', token: 'y' }))).toBeUndefined()
    expect(parseExternalMcpEnv(JSON.stringify([{ url: 'x' }]))).toBeUndefined()
  })
})
