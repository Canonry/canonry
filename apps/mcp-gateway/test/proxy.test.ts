import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'

import { Client, StreamableHTTPClientTransport, type Progress } from '@modelcontextprotocol/client'
import { Server, createMcpHandler, ProtocolError, LOG_LEVEL_META_KEY } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport, toNodeHandler } from '@modelcontextprotocol/node'
import { ListToolsResultSchema, ListResourcesResultSchema, ListResourceTemplatesResultSchema, ListPromptsResultSchema, ResultSchema } from '@modelcontextprotocol/core'
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server as LegacyServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport as LegacyServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema as LegacyCallToolRequestSchema, ListToolsRequestSchema as LegacyListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GatewayProxy, type GatewayBinding } from '../src/proxy.js'

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  const text = Buffer.concat(chunks).toString()
  return text ? JSON.parse(text) as unknown : undefined
}

async function listen(server: HttpServer): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener address.')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: HttpServer): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

/**
 * Protocol fixture, deliberately separate from the two real-engine suite: the
 * real engine has no paginated MCP catalog or subscription/progress producer.
 * SDK endpoints exercise those wire contracts without adding production hooks.
 */
async function fixture(options: { upstreamModern?: boolean; upstreamV1?: boolean; clientModern?: boolean; emptyToolCursor?: boolean; timeoutMs?: number } = {}) {
  const transports = new Map<string, { server: Server | LegacyServer; transport: NodeStreamableHTTPServerTransport | LegacyServerTransport }>()
  const subscriptions = new WeakMap<Server, Set<string>>()
  let upstreamBearer = 'initial-upstream-bearer'
  let generation = 1
  let reads = 0
  let writes = 0
  let aborted = 0
  let discoveries = 0
  let catalogPages = 0
  let calls = 0
  let diagnostics = 0
  let backgroundErrors = 0
  let receivedCalls = 0
  let blockedCatalog: { started: () => void; released: Promise<void> } | undefined
  let annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = { readOnlyHint: true, destructiveHint: false }
  const makeServer = () => {
    const server = new Server({ name: 'protocol-fixture', version: '1' }, {
      capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true }, prompts: { listChanged: true }, completions: {}, logging: {} },
      instructions: 'Read the synthetic protocol evidence.',
    })
    const subscribed = new Set<string>()
    subscriptions.set(server, subscribed)
    server.setRequestHandler('tools/list', async request => {
      const result = {
        tools: [{ name: request.params?.cursor !== undefined ? 'paged_read' : 'first_read', description: 'Synthetic stored read.', inputSchema: { type: 'object' as const }, annotations }],
        ...(request.params?.cursor !== undefined ? {} : { nextCursor: options.emptyToolCursor ? '' : 'tools-page-2' }),
      }
      if (blockedCatalog && request.params?.cursor !== undefined) {
        const blocked = blockedCatalog
        blockedCatalog = undefined
        blocked.started()
        await blocked.released
      }
      return result
    })
    server.setRequestHandler('tools/call', async (request, extra) => {
      if (request.params.name === 'mutate') { writes++; return { content: [{ type: 'text', text: 'mutated' }] } }
      reads++
      await extra.mcpReq.log('debug', { source: 'debug-diagnostic' }, 'protocol-fixture')
      await extra.mcpReq.log('info', { source: 'stored-evidence' }, 'protocol-fixture')
      const progressToken = request.params._meta?.progressToken
      if (progressToken !== undefined) await extra.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: 1, total: 2, message: 'Reading stored evidence.' } })
      if (request.params.arguments?.wait) {
        await new Promise<void>(resolve => {
          if (extra.mcpReq.signal.aborted) { aborted++; resolve(); return }
          extra.mcpReq.signal.addEventListener('abort', () => { aborted++; resolve() }, { once: true })
        })
      }
      return { content: [{ type: 'text', text: `generation:${generation}` }], structuredContent: { generation, queryClass: 'non-brand' }, _meta: { fixture: true } }
    })
    server.setRequestHandler('resources/list', request => ({
      resources: [{ name: request.params?.cursor ? 'second' : 'first', uri: request.params?.cursor ? 'fixture://second' : 'fixture://first' }],
      ...(request.params?.cursor ? {} : { nextCursor: 'resources-page-2' }),
    }))
    server.setRequestHandler('resources/templates/list', request => ({
      resourceTemplates: [{ name: request.params?.cursor ? 'second' : 'first', uriTemplate: request.params?.cursor ? 'fixture://second/{id}' : 'fixture://first/{id}' }],
      ...(request.params?.cursor ? {} : { nextCursor: 'templates-page-2' }),
    }))
    server.setRequestHandler('resources/read', request => {
      if (request.params.uri === 'fixture://denied') throw ProtocolError.fromError(-32099, 'Synthetic denial.', { reason: 'not-in-selection' })
      return { contents: [{ uri: request.params.uri, mimeType: 'application/json', text: '{"stored":true}' }] }
    })
    server.setRequestHandler('prompts/list', request => ({
      prompts: [{ name: request.params?.cursor ? 'second' : 'first', arguments: [{ name: 'project', required: true }] }],
      ...(request.params?.cursor ? {} : { nextCursor: 'prompts-page-2' }),
    }))
    server.setRequestHandler('prompts/get', request => ({
      description: 'Synthetic stored-evidence workflow.',
      messages: [{ role: 'user', content: { type: 'text', text: `Inspect ${request.params.arguments?.project ?? 'none'}.` } }],
    }))
    server.setRequestHandler('resources/subscribe', request => {
      if (request.params.uri === 'fixture://denied') throw ProtocolError.fromError(-32099, 'Synthetic subscription denial.')
      subscribed.add(request.params.uri)
      return {}
    })
    server.setRequestHandler('resources/unsubscribe', request => { subscribed.delete(request.params.uri); return {} })
    server.setRequestHandler('completion/complete', request => ({ completion: { values: [`${request.params.argument.value}-stored`], total: 1, hasMore: false } }))
    return server
  }
  let modernHandler = createMcpHandler(makeServer)
  const upstreamHttp = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== `Bearer ${upstreamBearer}`) {
        res.writeHead(401).end()
        return
      }
      const body = await bodyOf(req)
      const method = (body as { method?: string } | undefined)?.method
      if (method === 'initialize' || method === 'server/discover') discoveries++
      if (method === 'tools/list') catalogPages++
      if (method === 'tools/call') calls++
      if (options.upstreamModern) { await toNodeHandler(modernHandler)(req, res, body); return }
      const id = req.headers['mcp-session-id']
      if (typeof id === 'string') {
        const existing = transports.get(id)
        if (!existing) { res.writeHead(404).end(); return }
        await existing.transport.handleRequest(req, res, body)
        return
      }
      if (options.upstreamV1) {
        const server = new LegacyServer({ name: 'v1-only-upstream', version: '1' }, { capabilities: { tools: {} } })
        server.setRequestHandler(LegacyListToolsRequestSchema, () => ({ tools: [{ name: 'legacy_read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: false } }] }))
        server.setRequestHandler(LegacyCallToolRequestSchema, () => {
          reads++
          return { content: [{ type: 'text', text: 'Stored legacy engine evidence.' }], structuredContent: { legacyOnly: true } }
        })
        const transport = new LegacyServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: sessionId => { transports.set(sessionId, { server, transport }) } })
        await server.connect(transport)
        const onclose = transport.onclose
        transport.onclose = () => { onclose?.(); if (transport.sessionId) transports.delete(transport.sessionId) }
        try { await transport.handleRequest(req, res, body) } finally { if (!transport.sessionId) await server.close() }
        return
      }
      const server = makeServer()
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: sessionId => { transports.set(sessionId, { server, transport }) } })
      await server.connect(transport)
      const onclose = transport.onclose
      transport.onclose = () => { onclose?.(); if (transport.sessionId) transports.delete(transport.sessionId) }
      await transport.handleRequest(req, res, body)
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  const upstreamOrigin = await listen(upstreamHttp)
  let binding: GatewayBinding = {
    tenantId: 'tenant-one', userId: 'local-user', grantId: 'outer-grant', tokenFingerprint: 'outer-bearer-fingerprint',
    authorityFingerprint: 'instance-read-authority',
    profile: { id: 'stable-tenant-user', name: 'Synthetic User', nickname: 'Synthetic' },
    accessToken: upstreamBearer, mcpUrl: `${upstreamOrigin}/api/v1/mcp/readonly`, origin: upstreamOrigin,
    allowPrivateNetwork: true, protocolVersions: options.upstreamModern || options.upstreamV1 ? ['2026-07-28', '2025-11-25'] : ['2025-11-25', '2025-06-18'], catalogVersion: 'canonry-readonly-v1',
  }
  let authorized = true
  let proxy = new GatewayProxy(options.timeoutMs ?? 2_000, undefined, () => { backgroundErrors++ })
  const gatewayHttp = createServer((req, res) => {
    void bodyOf(req).then(body => {
      if ((body as { method?: string } | undefined)?.method === 'tools/call') receivedCalls++
      return proxy.handle(req, res, body, { ...binding }, async () => {
        if (!authorized) throw new Error('Grant revoked.')
      }, () => { diagnostics++ })
    }).catch(() => { if (!res.headersSent) res.writeHead(401); res.end() })
  })
  const gatewayOrigin = await listen(gatewayHttp)
  const client = new Client({ name: 'protocol-test', version: '1' }, { versionNegotiation: { mode: options.clientModern ? { pin: '2026-07-28' } : 'legacy' } })
  const transport = new StreamableHTTPClientTransport(new URL(`${gatewayOrigin}/mcp`))
  await client.connect(transport)
  return {
    client, transport, gatewayOrigin,
    pages: {
      tools: (params = {}) => client.request({ method: 'tools/list', params }, ListToolsResultSchema),
      resources: (params = {}) => client.request({ method: 'resources/list', params }, ListResourcesResultSchema),
      templates: (params = {}) => client.request({ method: 'resources/templates/list', params }, ListResourceTemplatesResultSchema),
      prompts: (params = {}) => client.request({ method: 'prompts/list', params }, ListPromptsResultSchema),
    },
    restartGateway: async () => { await proxy.close(); proxy = new GatewayProxy(options.timeoutMs ?? 2_000, undefined, () => { backgroundErrors++ }) },
    aborted: () => aborted,
    setAnnotations: (value: typeof annotations) => { annotations = value },
    setBinding: (patch: Partial<GatewayBinding>) => { binding = { ...binding, ...patch } },
    revoke: () => { authorized = false },
    counts: () => ({ reads, writes }),
    traffic: () => ({ discoveries, catalogPages, calls }),
    diagnostics: () => diagnostics,
    backgroundErrors: () => backgroundErrors,
    receivedCalls: () => receivedCalls,
    holdCatalogPage: () => {
      let release: () => void = () => {}
      let entered: () => void = () => {}
      const started = new Promise<void>(resolve => { entered = resolve })
      const released = new Promise<void>(resolve => { release = resolve })
      blockedCatalog = { started: entered, released }
      return { started, release }
    },
    catalogChanged: async () => {
      modernHandler.notify.toolsChanged()
      await Promise.all([...transports.values()].map(entry => entry.server.notification({ method: 'notifications/tools/list_changed' })))
    },
    rotate: () => { upstreamBearer = `rotated-upstream-bearer-${generation + 1}`; binding = { ...binding, accessToken: upstreamBearer }; generation++ },
    restart: async () => {
      await Promise.all([...transports.values()].map(entry => entry.server.close()))
      transports.clear()
      await modernHandler.close()
      modernHandler = createMcpHandler(makeServer)
      generation++
    },
    notify: async (uri = 'fixture://first') => {
      modernHandler.notify.resourceUpdated(uri)
      await Promise.all([...transports.values()].filter(entry => entry.server instanceof Server && subscriptions.get(entry.server)?.has(uri)).map(entry => entry.server.notification({ method: 'notifications/resources/updated', params: { uri } })))
    },
    close: async () => {
      await client.close()
      await proxy.close()
      await modernHandler.close()
      await Promise.all([...transports.values()].map(entry => entry.server.close()))
      await Promise.all([close(gatewayHttp), close(upstreamHttp)])
    },
  }
}

const running: Array<Awaited<ReturnType<typeof fixture>>> = []
const peers: Client[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(peers.splice(0).map(client => client.close()))
  await Promise.all(running.splice(0).map(item => item.close()))
})
async function setup(options: Parameters<typeof fixture>[0] = {}) { const built = await fixture(options); running.push(built); return built }

async function peer(origin: string, modern: boolean) {
  const client = new Client({ name: 'admission-test', version: '1' }, { versionNegotiation: { mode: modern ? { pin: '2026-07-28' } : 'legacy' } })
  peers.push(client)
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`))
  await client.connect(transport)
  return { client, transport }
}

describe.each([['legacy', 'legacy'], ['modern', 'legacy'], ['legacy', 'modern'], ['modern', 'modern']] as const)('%s client → %s upstream MCP', (outer, upstream) => {
  it('preserves catalog pagination, read outputs, and progress while denying unlisted execution', async () => {
    const built = await setup({ clientModern: outer === 'modern', upstreamModern: upstream === 'modern', emptyToolCursor: true })
    expect(built.client.getInstructions()).toBe('Read the synthetic protocol evidence.')
    const first = await built.pages.tools()
    expect(first.nextCursor).toBe('')
    expect(first.tools.map(tool => tool.name)).toEqual(['canonry_gateway_profile', 'first_read'])
    expect(first.tools[1]._meta).toMatchObject({ securitySchemes: [{ type: 'oauth2', scopes: ['read'] }] })
    const second = await built.pages.tools({ cursor: first.nextCursor })
    expect(second.tools.map(tool => tool.name)).toEqual(['paged_read'])
    expect(second.nextCursor).toBeUndefined()
    const progress: Progress[] = []
    const logs: unknown[] = []
    built.client.setNotificationHandler('notifications/message', event => { logs.push(event.params) })
    if (outer === 'legacy') await built.client.setLoggingLevel('info')
    const result = await built.client.callTool({ name: 'paged_read', _meta: { [LOG_LEVEL_META_KEY]: 'info' } }, { onprogress: event => { progress.push(event) } })
    expect(result).toMatchObject({ structuredContent: { generation: 1, queryClass: 'non-brand' }, _meta: { fixture: true } })
    expect(progress).toEqual([expect.objectContaining({ progress: 1, total: 2, message: 'Reading stored evidence.' })])
    await expect.poll(() => logs).toEqual([{ level: 'info', logger: 'protocol-fixture', data: { source: 'stored-evidence' } }])
    await expect(built.client.callTool({ name: 'mutate' })).rejects.toMatchObject({ code: -32602 })
    expect(built.diagnostics()).toBe(1)
    await expect(built.client.request({ method: 'tasks/cancel', params: { taskId: 'forged' } }, ResultSchema)).rejects.toMatchObject(outer === 'modern' ? { code: 'CLIENT_HTTP_NOT_IMPLEMENTED', data: { status: 404 } } : { code: -32601 })
    built.setAnnotations({ readOnlyHint: true })
    await expect(built.pages.tools()).rejects.toMatchObject({ code: -32603 })
    await expect(built.client.callTool({ name: 'paged_read' })).rejects.toMatchObject({ code: -32603 })
    expect(built.counts()).toEqual({ reads: 1, writes: 0 })
  })

  it('forwards resource/template/prompt pages and preserves structured protocol errors', async () => {
    const built = await setup({ clientModern: outer === 'modern', upstreamModern: upstream === 'modern' })
    const resources = await built.pages.resources()
    expect(resources.nextCursor).toBe('resources-page-2')
    expect((await built.pages.resources({ cursor: resources.nextCursor })).resources).toEqual([{ name: 'second', uri: 'fixture://second' }])
    const templates = await built.pages.templates()
    expect(templates.nextCursor).toBe('templates-page-2')
    expect((await built.pages.templates({ cursor: templates.nextCursor })).resourceTemplates).toEqual([{ name: 'second', uriTemplate: 'fixture://second/{id}' }])
    const prompts = await built.pages.prompts()
    expect(prompts.nextCursor).toBe('prompts-page-2')
    expect((await built.pages.prompts({ cursor: prompts.nextCursor })).prompts).toEqual([{ name: 'second', arguments: [{ name: 'project', required: true }] }])
    expect(await built.client.getPrompt({ name: 'first', arguments: { project: 'synthetic-one' } })).toMatchObject({ description: 'Synthetic stored-evidence workflow.', messages: [{ role: 'user', content: { type: 'text', text: 'Inspect synthetic-one.' } }] })
    expect((await built.client.complete({ ref: { type: 'ref/prompt', name: 'first' }, argument: { name: 'project', value: 'synthetic' } })).completion).toEqual({ values: ['synthetic-stored'], total: 1, hasMore: false })
    expect(await built.client.readResource({ uri: 'fixture://first' })).toMatchObject({ contents: [{ uri: 'fixture://first', mimeType: 'application/json', text: '{"stored":true}' }] })
    await expect(built.client.readResource({ uri: 'fixture://denied' })).rejects.toMatchObject({ code: -32099, data: { reason: 'not-in-selection' } })
  })

  it('reinitializes lost upstream sessions and rotated upstream bearers without replaying writes', async () => {
    const built = await setup({ clientModern: outer === 'modern', upstreamModern: upstream === 'modern' })
    const logs: string[] = []
    built.client.setNotificationHandler('notifications/message', event => { logs.push(event.params.level) })
    if (outer === 'legacy') await built.client.setLoggingLevel('info')
    await built.restart()
    expect(await built.client.callTool({ name: 'paged_read', _meta: { [LOG_LEVEL_META_KEY]: 'info' } })).toMatchObject({ structuredContent: { generation: 2 } })
    await expect.poll(() => logs).toEqual(['info'])
    built.rotate()
    expect(await built.client.callTool({ name: 'paged_read', _meta: { [LOG_LEVEL_META_KEY]: 'info' } })).toMatchObject({ structuredContent: { generation: 3 } })
    await expect.poll(() => logs).toEqual(['info', 'info'])
    expect(built.counts()).toEqual({ reads: 2, writes: 0 })
  })

  it('delivers subscribed notifications and rejects a session reused by a different outer token', async () => {
    const built = await setup({ clientModern: outer === 'modern', upstreamModern: upstream === 'modern' })
    const notifications: string[] = []
    built.client.setNotificationHandler('notifications/resources/updated', event => { notifications.push(event.params.uri) })
    if (outer === 'modern') await built.client.listen({ resourceSubscriptions: ['fixture://first'] })
    else await built.client.subscribeResource({ uri: 'fixture://first' })
    await built.notify()
    await expect.poll(() => notifications).toEqual(['fixture://first'])
    if (outer === 'modern') {
      expect(built.transport.sessionId).toBeUndefined()
      await built.restartGateway()
      expect(await built.client.callTool({ name: 'paged_read' })).toMatchObject({ structuredContent: { generation: 1 } })
      return
    }
    built.rotate()
    await built.client.callTool({ name: 'paged_read' })
    await built.notify()
    await expect.poll(() => notifications).toEqual(['fixture://first', 'fixture://first'])
    await built.restart()
    await built.client.callTool({ name: 'paged_read' })
    await built.notify()
    await expect.poll(() => notifications).toEqual(['fixture://first', 'fixture://first', 'fixture://first'])
    await built.client.unsubscribeResource({ uri: 'fixture://first' })
    await built.client.subscribeResource({ uri: 'fixture://second' })
    if (upstream === 'legacy') await expect(built.client.subscribeResource({ uri: 'fixture://denied' })).rejects.toMatchObject({ code: -32099 })
    built.rotate()
    await built.client.callTool({ name: 'paged_read' })
    await built.notify('fixture://first')
    await built.notify('fixture://second')
    await expect.poll(() => notifications).toEqual(['fixture://first', 'fixture://first', 'fixture://first', 'fixture://second'])
    built.setBinding({ tokenFingerprint: 'another-authorized-outer-token' })
    const response = await fetch(`${built.gatewayOrigin}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': built.transport.sessionId ?? '' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'paged_read' } }),
    })
    expect(response.status).toBe(404)
    expect(built.counts()).toEqual({ reads: 3, writes: 0 })
  })
  it('propagates caller cancellation through the upstream request stream', async () => {
    const built = await setup({ clientModern: outer === 'modern', upstreamModern: upstream === 'modern' })
    const controller = new AbortController()
    const pending = built.client.callTool({ name: 'paged_read', arguments: { wait: true } }, {
      signal: controller.signal, onprogress: () => controller.abort(new Error('Caller cancelled.')),
    })
    await expect(pending).rejects.toThrow()
    await expect.poll(built.aborted).toBe(1)
    expect(built.counts()).toEqual({ reads: 1, writes: 0 })
  })

})

it('accepts an actual SDK v1 client without changing its legacy handshake', async () => {
  const built = await setup({ upstreamModern: true })
  const client = new LegacyClient({ name: 'v1-compatibility', version: '1' })
  const transport = new LegacyTransport(new URL(`${built.gatewayOrigin}/mcp`))
  try {
    await client.connect(transport)
    expect(transport.sessionId).toEqual(expect.any(String))
    expect(await client.callTool({ name: 'paged_read' })).toMatchObject({ structuredContent: { generation: 1 } })
  } finally { await client.close() }
})

it('negotiates an actual SDK v1 upstream for a sessionless modern caller', async () => {
  const built = await setup({ clientModern: true, upstreamV1: true })
  expect(built.transport.sessionId).toBeUndefined()
  expect((await built.pages.tools()).tools.map(tool => tool.name)).toEqual(['canonry_gateway_profile', 'legacy_read'])
  expect(await built.client.callTool({ name: 'legacy_read' })).toMatchObject({ structuredContent: { legacyOnly: true } })
  // Raw HTTP deliberately bypasses the caller SDK's own capability guard, so
  // this checks the gateway's wire error for an absent upstream capability.
  const unsupported = await fetch(`${built.gatewayOrigin}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'prompts/list' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'unsupported-prompts', method: 'prompts/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
  })
  expect(await unsupported.json()).toMatchObject({ id: 'unsupported-prompts', error: { code: -32601 } })
  expect(built.counts()).toEqual({ reads: 1, writes: 0 })
})

it('bounds warm modern read traffic and partitions reuse by grant, token and current authority', async () => {
  const built = await setup({ clientModern: true, upstreamModern: true })
  const tool = (await built.pages.tools({ cursor: 'tools-page-2' })).tools[0]!
  const before = built.traffic()
  await built.client.callTool({ name: tool.name }, { toolDefinition: tool })
  await built.client.callTool({ name: tool.name }, { toolDefinition: tool })
  expect(built.traffic()).toEqual({ discoveries: before.discoveries, catalogPages: before.catalogPages + 2, calls: before.calls + 2 })

  built.setBinding({ grantId: 'independent-grant' })
  await built.client.callTool({ name: tool.name }, { toolDefinition: tool })
  expect(built.traffic()).toEqual({ discoveries: before.discoveries + 1, catalogPages: before.catalogPages + 4, calls: before.calls + 3 })
  built.rotate()
  await built.client.callTool({ name: tool.name }, { toolDefinition: tool })
  expect(built.traffic()).toEqual({ discoveries: before.discoveries + 2, catalogPages: before.catalogPages + 6, calls: before.calls + 4 })

  built.setAnnotations({ readOnlyHint: false, destructiveHint: true })
  built.setBinding({ authorityFingerprint: 'changed-instance-authority' })
  await expect(built.client.callTool({ name: tool.name }, { toolDefinition: tool })).rejects.toMatchObject({ code: -32603 })
  expect(built.counts()).toEqual({ reads: 4, writes: 0 })
})

it('expires catalog and idle client caches without serving stale read authority', async () => {
  const built = await setup({ clientModern: true, upstreamModern: true })
  const tool = (await built.pages.tools({ cursor: 'tools-page-2' })).tools[0]!
  await built.client.callTool({ name: tool.name }, { toolDefinition: tool })
  const before = built.traffic()
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 6_000)
  await built.client.callTool({ name: tool.name }, { toolDefinition: tool })
  expect(built.traffic()).toEqual({ discoveries: before.discoveries, catalogPages: before.catalogPages + 2, calls: before.calls + 1 })
  clock.mockReturnValue(now + 67_000)
  await built.client.callTool({ name: tool.name }, { toolDefinition: tool })
  expect(built.traffic()).toEqual({ discoveries: before.discoveries + 1, catalogPages: before.catalogPages + 4, calls: before.calls + 2 })
  built.setAnnotations({ readOnlyHint: false, destructiveHint: true })
  clock.mockReturnValue(now + 73_000)
  await expect(built.client.callTool({ name: tool.name }, { toolDefinition: tool })).rejects.toMatchObject({ code: -32603 })
  expect(built.counts()).toEqual({ reads: 3, writes: 0 })
})

it('keeps a grant and a user from exhausting shared legacy and modern admission', async () => {
  const built = await setup({ upstreamModern: true })
  const concurrent = await Promise.allSettled(Array.from({ length: 18 }, () => peer(built.gatewayOrigin, false)))
  expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(15)
  const rejected = concurrent.filter(result => result.status === 'rejected')
  expect(rejected).toHaveLength(3)
  for (const result of rejected) expect(result.reason).toMatchObject({ status: 503 })
  await expect(peer(built.gatewayOrigin, true)).rejects.toMatchObject({ status: 503 })
  built.setBinding({ grantId: 'second-grant' })
  const secondGrant = []
  for (let index = 0; index < 16; index++) secondGrant.push(await peer(built.gatewayOrigin, false))
  built.setBinding({ grantId: 'third-grant' })
  await expect(peer(built.gatewayOrigin, true)).rejects.toMatchObject({ status: 503 })

  built.setBinding({ grantId: 'independent-user-grant', userId: 'another-user' })
  const independent = await peer(built.gatewayOrigin, true)
  expect(await independent.client.callTool({ name: 'paged_read' })).toMatchObject({ structuredContent: { generation: 1 } })
  built.setBinding({ grantId: 'second-grant', userId: 'local-user' })
  await secondGrant[0]!.transport.terminateSession()
  built.setBinding({ grantId: 'third-grant' })
  let released: Awaited<ReturnType<typeof peer>> | undefined
  await expect.poll(async () => {
    try { released = await peer(built.gatewayOrigin, true); return true } catch { return false }
  }).toBe(true)
  expect(await released!.client.callTool({ name: 'paged_read' })).toMatchObject({ structuredContent: { generation: 1 } })
})

it('revalidates a long-lived modern subscription after request authorization was memoized', async () => {
  const built = await setup({ clientModern: true, upstreamModern: true })
  const notifications: string[] = []
  built.client.setNotificationHandler('notifications/resources/updated', event => { notifications.push(event.params.uri) })
  const subscription = await built.client.listen({ resourceSubscriptions: ['fixture://first'] })
  await built.notify()
  await expect.poll(() => notifications).toEqual(['fixture://first'])
  built.revoke()
  await built.notify()
  await subscription.closed
  expect(notifications).toEqual(['fixture://first'])
  expect(built.backgroundErrors()).toBe(1)
  await expect(built.client.callTool({ name: 'paged_read' })).rejects.toThrow()
  expect(built.counts()).toEqual({ reads: 0, writes: 0 })
})

it('rejects every waiter on a catalog load invalidated before its final page arrives', async () => {
  const built = await setup({ timeoutMs: 10_000 })
  const tool = (await built.pages.tools({ cursor: 'tools-page-2' })).tools[0]!
  const blocked = built.holdCatalogPage()
  const first = built.client.callTool({ name: tool.name }, { toolDefinition: tool }).catch((error: unknown) => error)
  try {
    await blocked.started
    const changed = new Promise<void>(resolve => { built.client.setNotificationHandler('notifications/tools/list_changed', () => { resolve() }) })
    built.setAnnotations({ readOnlyHint: false, destructiveHint: true })
    await built.catalogChanged()
    await changed
    const before = built.receivedCalls()
    const second = built.client.callTool({ name: tool.name }, { toolDefinition: tool }).catch((error: unknown) => error)
    await expect.poll(built.receivedCalls).toBe(before + 1)
    // A separate round trip lets the second request join the pending load
    // before the fixture releases the captured pre-invalidation page.
    await built.client.ping()
    blocked.release()
    await expect(first).resolves.toMatchObject({ code: -32603 })
    await expect(second).resolves.toMatchObject({ code: -32603 })
    expect(built.counts()).toEqual({ reads: 0, writes: 0 })
  } finally { blocked.release() }
})
