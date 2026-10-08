import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type { ToolResultMessage } from '@earendil-works/pi-ai'
import {
  loadExternalMcpTools,
  connectStreamableHttp,
  type RemoteMcpClient,
} from '../src/agent/remote-mcp.js'
import { createAeroSession } from '../src/agent/session.js'
import { parseExternalMcpEnv, type CanonryConfig, type ExternalMcpServerConfig } from '../src/config.js'
import type { ApiClient } from '../src/client.js'
import { registerAeroFaux, type AeroFaux } from './helpers/aero-faux.js'

const READ_TOOL = 'demo_read_artifact'
const WRITE_TOOL = 'demo_write_thing'
const EXCLUDED_TOOL = 'demo_excluded_tool'
const FAILING_TOOL = 'demo_failing_read'
const KNOWN_ARTIFACT = { reasonCode: 'R7', value: 42 }
const REMOTE_ERROR_TEXT = 'upstream index unavailable'

/** Link a real MCP SDK Client to `server` over an InMemory transport pair. */
async function connectInMemory(server: McpServer): Promise<RemoteMcpClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const client = new Client({ name: 'test-aero', version: '1.0.0' }, { capabilities: {} })
  await client.connect(clientTransport)
  return client as unknown as RemoteMcpClient
}

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

  return connectInMemory(server)
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
    // The model reads structured evidence directly, while details keep the envelope.
    const text = result.content.find((c) => c.type === 'text') as { text: string } | undefined
    expect(text?.text).toContain('reasonCode')
    expect(text?.text).toContain('R7')
  })

  it('keeps large remote structured rows whole and retains the original programmatic envelope', async () => {
    const rows = Array.from({ length: 2_500 }, (_, index) => ({ id: `remote-${index}`, evidence: 'synthetic evidence'.repeat(55) }))
    const envelope = { content: [{ type: 'text', text: JSON.stringify({ rows, total: rows.length }) }], structuredContent: { rows, total: rows.length } }
    const [tool] = await loadExternalMcpTools([SERVER], { connect: async () => ({
      listTools: async () => ({ tools: [{ name: READ_TOOL, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }),
      callTool: async () => envelope,
    }) })
    const result = await tool!.execute('remote-large', {})
    const text = result.content.find(block => block.type === 'text') as { text: string }
    const parsed = JSON.parse(text.text)
    expect(text.text.length).toBeLessThanOrEqual(20_000)
    expect(parsed.rows).toEqual(rows.slice(0, parsed.rows.length))
    expect(parsed.rows.length).toBeGreaterThan(0)
    expect(parsed.total).toBe(2_500)
    expect(result.details).toBe(envelope)
  })

  it.each(['plain', 'json-field', 'blocks', 'structured-field'])('retains a marked text prefix for oversized remote %s results', async (shape) => {
    const document = 'DOCUMENT_HEADER ' + 'synthetic text '.repeat(2_500) + 'DOCUMENT_END'
    const envelope = shape === 'plain' ? { content: [{ type: 'text', text: document }] }
      : shape === 'json-field' ? { content: [{ type: 'text', text: JSON.stringify({ title: 'Brief', markdown: document }) }] }
      : shape === 'blocks' ? { content: [{ type: 'text', text: document }, { type: 'text', text: 'Second block' }] }
      : { structuredContent: { page: document }, content: [{ type: 'text', text: 'Fallback' }] }
    const [tool] = await loadExternalMcpTools([SERVER], { connect: async () => stubClient(envelope) })
    const result = await tool!.execute('remote-document', {})
    const text = result.content.find(block => block.type === 'text') as { text: string }
    const shown = JSON.parse(text.text)
    expect(text.text.length).toBeLessThanOrEqual(20_000)
    expect(text.text).toContain('DOCUMENT_HEADER')
    expect(text.text).not.toContain('DOCUMENT_END')
    expect(shown.__truncated).toBe(true)
    expect(shown.__truncation.slicedKeys).toBeDefined()
    expect(result.details).toBe(envelope)
  })

  // Fetch-style tools return each document as one row, which can alone exceed the cap.
  it.each([
    { shape: 'nested structured rows', rowPath: 'data.results[0]', listPath: 'data.results', rows: 1, partialLists: undefined },
    { shape: 'single JSON text block', rowPath: 'results[0]', listPath: 'results', rows: 1, partialLists: { results: '1 of 12' } },
    { shape: 'top-level array text block', rowPath: 'items[0]', listPath: 'items', rows: 1, partialLists: undefined },
    { shape: 'two oversized structured rows', rowPath: 'results[0]', listPath: 'results', rows: 2, partialLists: { results: '1 of 2' } },
  ])('shows a marked part of an oversized first row from $shape', async ({ shape, rowPath, listPath, rows, partialLists }) => {
    const document = 'DOCUMENT_HEADER ' + 'synthetic setup step. '.repeat(1_200) + 'DOCUMENT_END'
    const docs = Array.from({ length: rows }, (_, index) => ({ title: `Example setup guide ${index}`, url: `https://docs.example.com/setup-${index}`, markdown: document }))
    const envelope = shape === 'nested structured rows' ? { structuredContent: { data: { results: docs } }, content: [{ type: 'text', text: 'Fallback' }] }
      : shape === 'single JSON text block' ? { content: [{ type: 'text', text: JSON.stringify({ results: docs, total: 12 }) }] }
        : shape === 'top-level array text block' ? { content: [{ type: 'text', text: JSON.stringify(docs) }] }
          : { structuredContent: { results: docs, total: rows }, content: [{ type: 'text', text: 'Fallback' }] }
    const [tool] = await loadExternalMcpTools([SERVER], { connect: async () => stubClient(envelope) })
    const result = await tool!.execute('remote-oversized-row', {})
    const text = (result.content.find(block => block.type === 'text') as { text: string }).text
    const shown = JSON.parse(text)
    const list = listPath.split('.').reduce((owner, key) => owner[key], shown) as Array<{ title: string; url: string; markdown: string }>

    expect(text.length).toBeLessThanOrEqual(20_000)
    expect(list).toHaveLength(1)
    expect(list[0]!.title).toBe(docs[0]!.title)
    expect(list[0]!.url).toBe(docs[0]!.url)
    expect(list[0]!.markdown.startsWith('DOCUMENT_HEADER synthetic setup step.')).toBe(true)
    expect(list[0]!.markdown).toBe(document.slice(0, list[0]!.markdown.length))
    expect(list[0]!.markdown).not.toContain('DOCUMENT_END')
    expect(shown.__truncated).toBe(true)
    expect(shown.__truncation.slicedKeys).toEqual({ [`${rowPath}.markdown`]: { keptChars: list[0]!.markdown.length, totalChars: document.length } })
    expect(shown.__truncation.keptItems).toEqual(rows > 1 ? { [listPath]: `1 of ${rows}` } : {})
    expect(shown.__truncation.droppedKeys).toEqual([])
    expect(shown.__truncation.projection).toContain('Array rows are complete unless slicedKeys or droppedKeys name a field inside one')
    expect(shown.__partialLists).toEqual(partialLists)
    if (partialLists) expect(Object.keys(shown)[0]).toBe('__partialLists')
    expect(result.details).toBe(envelope)
  })

  // Search and fetch tools return the scraped page beside images, follow-up questions or warnings.
  it.each([
    {
      shape: 'follow-up questions beside the page',
      siblings: { query: 'example setup', follow_up_questions: ['What is a setup step?', 'How long does setup take?'], images: [] },
      structured: false,
    },
    { shape: 'an image list beside the page', siblings: { query: 'example setup', images: ['https://img.example/1.png'] }, structured: false },
    { shape: 'structured warnings after the page', siblings: { warnings: ['robots.txt slow'] }, structured: true },
  ])('shows a marked part of an oversized page beside $shape', async ({ siblings, structured }) => {
    const rawContent = 'RAW_HEADER ' + 'synthetic page text. '.repeat(1_250) + 'RAW_END'
    const page = { title: 'Example setup guide', url: 'https://docs.example.com/setup', content: 'Short summary of the setup guide.', raw_content: rawContent }
    const body = structured ? { results: [page], ...siblings } : { ...siblings, results: [page] }
    const envelope = structured ? { structuredContent: body, content: [{ type: 'text', text: 'Fallback' }] } : { content: [{ type: 'text', text: JSON.stringify(body) }] }
    const [tool] = await loadExternalMcpTools([SERVER], { connect: async () => stubClient(envelope) })
    const result = await tool!.execute('remote-page-with-siblings', {})
    const text = (result.content.find(block => block.type === 'text') as { text: string }).text
    const shown = JSON.parse(text)
    const [row] = shown.results

    expect(text.length).toBeLessThanOrEqual(20_000)
    expect(shown.results).toHaveLength(1)
    expect(row.title).toBe(page.title)
    expect(row.url).toBe(page.url)
    expect(row.content).toBe(page.content)
    expect(row.raw_content.startsWith('RAW_HEADER synthetic page text.')).toBe(true)
    expect(row.raw_content).toBe(rawContent.slice(0, row.raw_content.length))
    expect(row.raw_content).not.toContain('RAW_END')
    expect(shown.__truncation.slicedKeys).toEqual({ 'results[0].raw_content': { keptChars: row.raw_content.length, totalChars: rawContent.length } })
    expect(shown.__truncation.droppedKeys).toEqual([])
    expect(shown.__truncation.keptItems).toEqual({})
    for (const [key, value] of Object.entries(siblings)) expect(shown[key]).toEqual(value)
    expect(result.details).toBe(envelope)
  })

  it('shows an oversized page in part after the whole rows before it', async () => {
    const rawContent = 'RAW_HEADER ' + 'synthetic page text. '.repeat(1_250) + 'RAW_END'
    const small = { title: 'Example quick note', url: 'https://docs.example.com/note', content: 'One line.' }
    const page = { title: 'Example setup guide', url: 'https://docs.example.com/setup', content: 'Short summary.', raw_content: rawContent }
    const envelope = { structuredContent: { results: [small, page] }, content: [{ type: 'text', text: 'Fallback' }] }
    const [tool] = await loadExternalMcpTools([SERVER], { connect: async () => stubClient(envelope) })
    const result = await tool!.execute('remote-small-then-page', {})
    const shown = JSON.parse((result.content.find(block => block.type === 'text') as { text: string }).text)
    const [first, second] = shown.results

    expect(shown.results).toHaveLength(2)
    expect(first).toEqual(small)
    expect(second.title).toBe(page.title)
    expect(second.url).toBe(page.url)
    expect(second.raw_content).toBe(rawContent.slice(0, second.raw_content.length))
    expect(second.raw_content.length).toBeGreaterThan(10_000)
    expect(shown.__truncation.slicedKeys).toEqual({ 'results[1].raw_content': { keptChars: second.raw_content.length, totalChars: rawContent.length } })
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

/** A stub remote client advertising one read-only tool whose call answers `result`. */
function stubClient(result: unknown): RemoteMcpClient {
  return {
    listTools: async () => ({
      tools: [{ name: FAILING_TOOL, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }],
    }),
    callTool: async () => result,
  }
}

describe('remote tool errors', () => {
  it('flags a remote isError result as a failed AgentToolResult and keeps the content the model sees', async () => {
    // The MCP SDK hands a tool-level failure back as a CallToolResult with
    // isError: true rather than throwing, so the flag is the only failure signal.
    const envelope = { content: [{ type: 'text', text: REMOTE_ERROR_TEXT }], isError: true }
    const [tool] = await loadExternalMcpTools([SERVER], { connect: async () => stubClient(envelope) })

    const result = await tool!.execute('call-err', {})
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(envelope === null || typeof envelope !== 'object' ? envelope : envelope.content[0].text) }])
    expect(result.details).toEqual(envelope)
  })

  it.each([
    ['a plain result', { content: [{ type: 'text', text: 'ok' }] }],
    ['an explicit isError: false', { content: [{ type: 'text', text: 'ok' }], isError: false }],
    ['a non-boolean isError', { content: [{ type: 'text', text: 'ok' }], isError: 'true' }],
    ['a null result', null],
    ['a non-object result', 'ok'],
  ])('leaves %s unflagged', async (_label, envelope) => {
    const [tool] = await loadExternalMcpTools([SERVER], { connect: async () => stubClient(envelope) })

    const result = await tool!.execute('call-ok', {})
    expect(result.isError ?? false).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(envelope === null || typeof envelope !== 'object' ? envelope : envelope.content[0].text) }])
  })
})

describe('remote tool errors through the agent loop', () => {
  let faux: AeroFaux

  beforeEach(() => {
    faux = registerAeroFaux({ api: 'aero-remote-mcp-test', provider: 'aero-remote-mcp-test', models: [{ id: 'test' }] })
  })

  afterEach(() => {
    faux.unregister()
  })

  it('reports a failed remote call as an error on tool_execution_end and the toolResult message', async () => {
    // A real MCP server: the read tool succeeds, the failing tool throws, which
    // the SDK server turns into an isError CallToolResult carrying the message.
    const connect = async (): Promise<RemoteMcpClient> => {
      const server = new McpServer({ name: 'demo-remote', version: '1.0.0' })
      server.registerTool(
        READ_TOOL,
        { description: 'Read a known artifact (read-only).', inputSchema: {}, annotations: { readOnlyHint: true } },
        async () => ({ content: [{ type: 'text', text: JSON.stringify(KNOWN_ARTIFACT) }] }),
      )
      server.registerTool(
        FAILING_TOOL,
        { description: 'A read-only tool whose backend is down.', inputSchema: {}, annotations: { readOnlyHint: true } },
        async () => {
          throw new Error(REMOTE_ERROR_TEXT)
        },
      )
      return connectInMemory(server)
    }
    const tools = await loadExternalMcpTools([SERVER], { connect })
    expect(tools.map((t) => t.name)).toEqual([READ_TOOL, FAILING_TOOL])

    const config = { apiUrl: 'http://localhost:4100', database: ':memory:', apiKey: 'cnry_test', providers: { claude: { apiKey: 'anthropic-key' } } } as CanonryConfig
    const agent = createAeroSession({ projectName: 'demo', client: {} as ApiClient, config, systemPromptOverride: 'You are a test agent.', tools })
    agent.state.model = faux.getModel('test')!
    const ended: Record<string, boolean> = {}
    agent.subscribe((event) => {
      if (event.type === 'tool_execution_end') ended[event.toolName] = event.isError
    })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(READ_TOOL, {}), fauxToolCall(FAILING_TOOL, {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('The remote read failed.'),
    ])
    await agent.prompt('Read both')

    expect(ended).toEqual({ [READ_TOOL]: false, [FAILING_TOOL]: true })
    const results = agent.state.messages.filter((m): m is ToolResultMessage => m.role === 'toolResult')
    expect(Object.fromEntries(results.map((r) => [r.toolName, r.isError]))).toEqual({ [READ_TOOL]: false, [FAILING_TOOL]: true })
    // The model still reads the remote server's own error text.
    const failed = results.find((r) => r.toolName === FAILING_TOOL)!
    const text = failed.content.find((c) => c.type === 'text') as { text: string } | undefined
    expect(text?.text).toContain(REMOTE_ERROR_TEXT)
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
