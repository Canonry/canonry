import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { Client, StreamableHTTPClientTransport, type McpSubscription } from '@modelcontextprotocol/client'
import { createMcpHandler, isLegacyRequest, LOG_LEVEL_META_KEY, ProtocolError, SdkHttpError, Server, type ServerContext, type McpHttpHandler, type SubscriptionFilter, type ServerEvent, type Notification, type JSONRPCRequest, type Result, type ServerCapabilities, type Tool, type LoggingLevel } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node'
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsResultSchema,
  ResultSchema,
  SubscriptionsListenRequestSchema,
  SetLevelRequestSchema,
  LoggingLevelSchema,
} from '@modelcontextprotocol/core'

import { tenantFetch } from './upstream.js'
import { gatewayProfileTool, withGatewaySecurity, type GatewayProfile } from './profile.js'

export interface GatewayBinding {
  grantId: string
  tenantId: string
  userId: string
  /** Fingerprint of the OUTER bearer. Never an upstream token fingerprint. */
  tokenFingerprint: string
  accessToken: string
  mcpUrl: string
  origin: string
  allowPrivateNetwork: boolean
  protocolVersions: string[]
  catalogVersion: string
  profile: GatewayProfile
}

interface RequestContext {
  binding: GatewayBinding
  validate: () => Promise<void>
}

interface Upstream {
  client: Client
  transport: StreamableHTTPClientTransport
  accessToken: string
}

interface Session {
  binding: GatewayBinding
  validate: () => Promise<void>
  server: Server
  transport?: NodeStreamableHTTPServerTransport
  modern?: McpHttpHandler
  subscription?: McpSubscription
  subscriptionFilter?: SubscriptionFilter
  logLevel?: LoggingLevel
  requestNotifications?: { notify: ServerContext['mcpReq']['notify']; deliveries: Promise<void>[] }
  upstream: Upstream
  reconnecting?: Promise<void>
  lastSeenAt: number
  closed: boolean
}

const READ_METHODS = new Map<string, keyof ServerCapabilities | undefined>([
  ['ping', undefined], ['tools/list', 'tools'], ['tools/call', 'tools'],
  ['resources/list', 'resources'], ['resources/templates/list', 'resources'],
  ['resources/read', 'resources'], ['resources/subscribe', 'resources'], ['resources/unsubscribe', 'resources'],
  ['prompts/list', 'prompts'], ['prompts/get', 'prompts'],
  ['completion/complete', 'completions'], ['logging/setLevel', 'logging'],
])
const FORWARDED_NOTIFICATIONS = new Set([
  'notifications/tools/list_changed', 'notifications/resources/list_changed',
  'notifications/resources/updated', 'notifications/prompts/list_changed', 'notifications/message',
])
const SESSION_IDLE_MS = 10 * 60_000
const MAX_SESSIONS = 1_000
const MAX_CATALOG_PAGES = 100

/**
 * Terminates both MCP transports. Routing and authority are supplied only by
 * the authenticated grant; neither headers nor tool arguments choose a host.
 */
export class GatewayProxy {
  private readonly sessions = new Map<string, Session>()
  private readonly requests = new AsyncLocalStorage<RequestContext>()
  private readonly sweep: ReturnType<typeof setInterval>
  private opening = 0
  private readonly exchanges = new Set<Session>()

  constructor(private readonly timeoutMs = 30_000) {
    this.sweep = setInterval(() => {
      const cutoff = Date.now() - SESSION_IDLE_MS
      for (const session of this.sessions.values()) {
        if (session.lastSeenAt < cutoff) void this.drop(session)
      }
    }, 60_000)
    this.sweep.unref()
  }

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    binding: GatewayBinding,
    validate: () => Promise<void>,
  ): Promise<void> {
    await validate()
    if (binding.catalogVersion !== 'canonry-readonly-v1') throw new Error('Unsupported read-only catalog policy.')
    if (!await isLegacyRequest(await toWebRequest(req, body))) {
      await this.modern(req, res, body, binding, validate)
      return
    }
    const sessionId = req.headers['mcp-session-id']
    if (sessionId !== undefined) {
      const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined
      if (!session || !this.sameAuthority(session.binding, binding)) {
        this.reject(res, 404, 'Unknown MCP session. Initialize a new session.')
        return
      }
      session.binding = { ...binding }
      session.validate = validate
      session.lastSeenAt = Date.now()
      await this.requests.run({ binding, validate }, () => session.transport!.handleRequest(req, res, body))
      return
    }

    const initialize = InitializeRequestSchema.safeParse(body)
    if (req.method !== 'POST' || !initialize.success) {
      this.reject(res, 400, 'Expected an initialize request.')
      return
    }
    if (this.sessions.size + this.opening >= MAX_SESSIONS) {
      this.reject(res, 503, 'MCP session capacity reached.')
      return
    }
    this.opening++
    let session: Session | undefined
    try {
      session = await this.open(binding, validate)
      const opened = session
      await this.requests.run({ binding, validate }, () => opened.transport!.handleRequest(req, res, body))
    } finally {
      this.opening--
      if (session && (res.statusCode >= 400 || !session.transport?.sessionId)) await this.drop(session)
    }
  }

  async disconnect(grantId: string): Promise<void> {
    await Promise.all([...this.sessions.values(), ...this.exchanges].filter(session => session.binding.grantId === grantId).map(session => this.drop(session)))
  }

  async close(): Promise<void> {
    clearInterval(this.sweep)
    await Promise.all([...this.sessions.values(), ...this.exchanges].map(session => this.drop(session)))
  }

  private sameAuthority(left: GatewayBinding, right: GatewayBinding): boolean {
    return left.grantId === right.grantId && left.tenantId === right.tenantId
      && left.userId === right.userId && left.tokenFingerprint === right.tokenFingerprint
      && left.mcpUrl === right.mcpUrl && left.catalogVersion === right.catalogVersion
      && left.origin === right.origin && left.allowPrivateNetwork === right.allowPrivateNetwork
      && JSON.stringify(left.protocolVersions) === JSON.stringify(right.protocolVersions)
  }

  private reject(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
  }

  /** Every modern exchange owns its bridge, including a long-lived listen POST. */
  private async modern(req: IncomingMessage, res: ServerResponse, body: unknown, binding: GatewayBinding, validate: () => Promise<void>): Promise<void> {
    if (req.headers['mcp-session-id']) {
      this.reject(res, 400, 'Modern MCP requests do not use sessions.')
      return
    }
    if (this.exchanges.size + this.opening >= MAX_SESSIONS) {
      this.reject(res, 503, 'MCP request capacity reached.')
      return
    }
    this.opening++
    let bridge: Session | undefined
    const handler = createMcpHandler(async () => {
      bridge = await this.build(binding, validate)
      bridge.modern = handler
      this.exchanges.add(bridge)
      this.listen(bridge, bridge.upstream)
      const subscription = SubscriptionsListenRequestSchema.safeParse(body)
      if (subscription.success) await this.subscribe(bridge, subscription.data.params.notifications)
      return bridge.server
    }, { legacy: 'reject', responseMode: 'auto', maxSubscriptions: 1 })
    try {
      await this.requests.run({ binding, validate }, () => toNodeHandler(handler)(req, res, body))
    } finally {
      this.opening--
      if (bridge) await this.drop(bridge)
      await handler.close()
    }
  }

  private changeEvent(notification: Notification): ServerEvent | undefined {
    const params = notification.params
    switch (notification.method) {
      case 'notifications/tools/list_changed': return { kind: 'tools_list_changed', params }
      case 'notifications/prompts/list_changed': return { kind: 'prompts_list_changed', params }
      case 'notifications/resources/list_changed': return { kind: 'resources_list_changed', params }
      case 'notifications/resources/updated': return typeof params?.uri === 'string' ? { kind: 'resource_updated', uri: params.uri, params } : undefined
      default: return undefined
    }
  }

  private async subscribe(session: Session, filter: SubscriptionFilter): Promise<void> {
    session.subscriptionFilter = filter
    if (session.upstream.client.getProtocolEra() === 'modern') {
      const previous = session.subscription
      session.subscription = undefined
      await previous?.close()
      session.subscription = await session.upstream.client.listen(filter, { timeout: this.timeoutMs })
      const subscription = session.subscription
      void subscription.closed.then(() => {
        if (session.subscription !== subscription || session.closed) return
        session.subscription = undefined
        if (session.modern) return this.drop(session)
        // A modern upstream has no session to lose. Keep the legacy caller's
        // transport alive; the next request restores its notification stream.
      })
    } else {
      for (const uri of filter.resourceSubscriptions ?? []) {
        await session.upstream.client.subscribeResource({ uri }, { timeout: this.timeoutMs })
      }
    }
  }

  private async closeUpstream(upstream: Upstream): Promise<void> {
    try {
      if (upstream.transport.sessionId) await upstream.transport.terminateSession()
    } catch {
      // Expired bearer or lost process-local session: closing still releases sockets.
    } finally {
      await upstream.client.close().catch(() => {})
    }
  }

  private async connect(binding: GatewayBinding): Promise<Upstream> {
    const destination = new URL(binding.mcpUrl).href
    const client = new Client({ name: 'canonry-mcp-gateway', version: '1.0.0' }, { capabilities: {}, supportedProtocolVersions: binding.protocolVersions, versionNegotiation: { mode: 'auto', probe: { timeoutMs: this.timeoutMs } } })
    const fetchTenant = tenantFetch(binding, this.timeoutMs)
    const transport = new StreamableHTTPClientTransport(new URL(destination), {
      requestInit: { headers: { authorization: `Bearer ${binding.accessToken}` }, redirect: 'error' },
      fetch: async (input, init) => {
        if (new URL(input).href !== destination) throw new Error('Unregistered MCP destination.')
        return fetchTenant(input, { ...init, redirect: 'error' })
      },
    })
    try {
      await client.connect(transport, { timeout: this.timeoutMs, ...(binding.protocolVersions.includes('2026-07-28') ? {} : { prior: { kind: 'legacy' as const } }) })
      if (!client.getNegotiatedProtocolVersion() || !binding.protocolVersions.includes(client.getNegotiatedProtocolVersion()!)) {
        throw new Error('Upstream MCP protocol is not provisioned.')
      }
      return { client, transport, accessToken: binding.accessToken }
    } catch (error) {
      await client.close().catch(() => {})
      throw error
    }
  }

  private async build(binding: GatewayBinding, validate: () => Promise<void>): Promise<Session> {
    const upstream = await this.connect(binding)
    const upstreamCapabilities = upstream.client.getServerCapabilities() ?? {}
    // Only capabilities that this read-only bridge implements cross the hop.
    const capabilities: ServerCapabilities = {
      ...(upstreamCapabilities.tools ? { tools: upstreamCapabilities.tools } : {}),
      ...(upstreamCapabilities.resources ? { resources: upstreamCapabilities.resources } : {}),
      ...(upstreamCapabilities.prompts ? { prompts: upstreamCapabilities.prompts } : {}),
      ...(upstreamCapabilities.completions ? { completions: upstreamCapabilities.completions } : {}),
      ...(upstreamCapabilities.logging ? { logging: upstreamCapabilities.logging } : {}),
    }
    const server = new Server({ name: 'canonry-mcp-gateway', version: '1.0.0' }, {
      capabilities,
      instructions: upstream.client.getInstructions(),
    })
    const session: Session = { binding: { ...binding }, validate, server, upstream, lastSeenAt: Date.now(), closed: false }
    server.fallbackRequestHandler = (request, extra) => this.forward(session, request, extra)
    server.setRequestHandler('ping', (request, ctx) => this.forward(session, { ...request, jsonrpc: '2.0', id: ctx.mcpReq.id }, ctx))
    if (capabilities.logging) server.setRequestHandler('logging/setLevel', (request, ctx) => this.forward(session, { ...request, jsonrpc: '2.0', id: ctx.mcpReq.id }, ctx))
    return session
  }

  private async open(binding: GatewayBinding, validate: () => Promise<void>): Promise<Session> {
    const session = await this.build(binding, validate)
    const { server, upstream } = session
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: id => { this.sessions.set(id, session) } })
    session.transport = transport
    try {
      this.listen(session, upstream)
      if (upstream.client.getProtocolEra() === 'modern') {
        const caps = upstream.client.getServerCapabilities()
        session.subscriptionFilter = { toolsListChanged: caps?.tools?.listChanged, resourcesListChanged: caps?.resources?.listChanged, promptsListChanged: caps?.prompts?.listChanged }
        await this.subscribe(session, session.subscriptionFilter)
      }
      await server.connect(transport)
    } catch (error) {
      await this.drop(session)
      throw error
    }
    const onclose = transport.onclose
    transport.onclose = () => {
      onclose?.()
      void this.drop(session)
    }
    return session
  }

  private listen(session: Session, upstream: Upstream): void {
    upstream.client.fallbackNotificationHandler = async notification => {
      if (!FORWARDED_NOTIFICATIONS.has(notification.method) || session.closed || session.upstream !== upstream) return
      if (session.modern && notification.method === 'notifications/message') {
        const target = session.requestNotifications
        if (!target) return
        const delivery = session.validate().then(() => target.notify(notification)).catch(() => this.drop(session))
        target.deliveries.push(delivery)
        await delivery
        return
      }
      try {
        await session.validate()
        if (session.modern) {
          const event = this.changeEvent(notification)
          if (event) session.modern.bus.publish(event)
        } else await session.server.notification(notification)
      } catch {
        await this.drop(session)
      }
    }
  }

  private async reconnect(session: Session, binding: GatewayBinding, stale?: Upstream): Promise<void> {
    if (session.reconnecting) {
      await session.reconnecting
      if (session.upstream.accessToken === binding.accessToken && (!stale || session.upstream !== stale)) return
    }
    if (!stale && session.upstream.accessToken === binding.accessToken) return
    if (stale && session.upstream !== stale && session.upstream.accessToken === binding.accessToken) return
    session.reconnecting = (async () => {
      const replacement = await this.connect(binding)
      if (session.closed) {
        await replacement.client.close()
        throw ProtocolError.fromError(-32000, 'MCP session closed.')
      }
      const previous = session.upstream
      session.subscription = undefined
      session.upstream = replacement
      this.listen(session, replacement)
      await this.closeUpstream(previous)
      if (session.logLevel && replacement.client.getProtocolEra() === 'legacy' && replacement.client.getServerCapabilities()?.logging) {
        await replacement.client.setLoggingLevel(session.logLevel, { timeout: this.timeoutMs })
      }
      if (session.subscriptionFilter) await this.subscribe(session, session.subscriptionFilter)
    })()
    try {
      await session.reconnecting
    } finally {
      session.reconnecting = undefined
    }
  }

  private async verifyTool(upstream: Upstream, name: string, signal: AbortSignal): Promise<Tool> {
    let cursor: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
      const result = await upstream.client.request({ method: 'tools/list', params: cursor !== undefined ? { cursor } : {} }, ListToolsResultSchema, { signal, timeout: this.timeoutMs })
      const tool = result.tools.find(candidate => candidate.name === name)
      if (tool) {
        if (tool.annotations?.readOnlyHint !== true || tool.annotations.destructiveHint !== false) break
        return tool
      }
      cursor = result.nextCursor
      if (cursor === undefined || seen.has(cursor)) break
      seen.add(cursor)
    }
    throw ProtocolError.fromError(-32602, 'Tool is not available in the approved read-only catalog.')
  }

  private async forward(session: Session, request: JSONRPCRequest, extra: ServerContext): Promise<Result> {
    if (!READ_METHODS.has(request.method)) throw ProtocolError.fromError(-32601, 'Method is not available on the read-only gateway.')
    // Async tasks can start work that outlives the authorized read request.
    if (request.params?.task !== undefined) throw ProtocolError.fromError(-32602, 'Task execution is not available on the read-only gateway.')
    const context = this.requests.getStore()
    if (!context || !this.sameAuthority(session.binding, context.binding)) throw ProtocolError.fromError(-32600, 'Missing request authorization.')
    await context.validate()
    if (request.method === 'tools/call' && request.params?.name === gatewayProfileTool.name) {
      const call = CallToolRequestSchema.safeParse(request)
      if (!call.success || Object.keys(call.data.params.arguments ?? {}).length) throw ProtocolError.fromError(-32602, 'The profile tool accepts no arguments.')
      const profile = { ...context.binding.profile }
      return { structuredContent: profile, content: [{ type: 'text', text: JSON.stringify(profile) }] }
    }
    await this.reconnect(session, context.binding)
    const requireCapability = () => {
      const capabilities = session.upstream.client.getServerCapabilities()
      const capability = READ_METHODS.get(request.method)
      if ((capability && !capabilities?.[capability])
        || ((request.method === 'resources/subscribe' || request.method === 'resources/unsubscribe') && !capabilities?.resources?.subscribe)) {
        throw ProtocolError.fromError(-32601, 'Method not found')
      }
    }
    // The client SDK rejects absent capabilities locally. Preserve the MCP
    // method-not-found contract instead of leaking that SDK error as -32603.
    requireCapability()
    if (!session.modern && session.subscriptionFilter && !session.subscription && session.upstream.client.getProtocolEra() === 'modern') {
      await this.subscribe(session, session.subscriptionFilter)
    }
    let pendingLogLevel: LoggingLevel | undefined
    if (request.method === 'logging/setLevel') {
      const level = SetLevelRequestSchema.safeParse(request)
      if (!level.success) throw ProtocolError.fromError(-32602, 'Invalid logging level.')
      pendingLogLevel = level.data.params.level
      if (session.upstream.client.getProtocolEra() === 'modern') {
        session.logLevel = pendingLogLevel
        return {}
      }
    }
    let pendingSubscription: { uri: string; subscribe: boolean } | undefined
    if (request.method === 'resources/subscribe' || request.method === 'resources/unsubscribe') {
      const uri = request.params?.uri
      if (typeof uri !== 'string') throw ProtocolError.fromError(-32602, 'Expected a resource URI.')
      pendingSubscription = { uri, subscribe: request.method === 'resources/subscribe' }
      if (session.upstream.client.getProtocolEra() === 'modern') {
        const uris = new Set(session.subscriptionFilter?.resourceSubscriptions ?? [])
        if (pendingSubscription.subscribe) uris.add(uri)
        else uris.delete(uri)
        await this.subscribe(session, { ...session.subscriptionFilter, resourceSubscriptions: [...uris] })
        return {}
      }
    }
    const execute = async (): Promise<Result> => {
      const envelope = extra.mcpReq.envelope
      const requestedLogLevel = LoggingLevelSchema.safeParse(envelope && LOG_LEVEL_META_KEY in envelope ? envelope[LOG_LEVEL_META_KEY] : request.params?._meta?.[LOG_LEVEL_META_KEY])
      const logLevel = requestedLogLevel.success ? requestedLogLevel.data : session.logLevel
      const requestNotifications = { notify: extra.mcpReq.notify, deliveries: [] as Promise<void>[] }
      if (session.modern) session.requestNotifications = logLevel ? requestNotifications : undefined
      if (session.modern && logLevel && session.upstream.client.getProtocolEra() === 'legacy' && session.upstream.client.getServerCapabilities()?.logging) {
        await session.upstream.client.setLoggingLevel(logLevel, { signal: extra.mcpReq.signal, timeout: this.timeoutMs })
      }
      let tool: Tool | undefined
      if (request.method === 'tools/call') {
        const call = CallToolRequestSchema.safeParse(request)
        if (!call.success) throw ProtocolError.fromError(-32602, 'Invalid tools/call parameters.')
        tool = await this.verifyTool(session.upstream, call.data.params.name, extra.mcpReq.signal)
      }
      const progressToken = request.params?._meta?.progressToken
      const progressDelivery: Promise<void>[] = []
      const options = {
        signal: extra.mcpReq.signal,
        timeout: this.timeoutMs,
        ...(progressToken !== undefined ? {
          onprogress: (progress: { progress: number; total?: number; message?: string }) => {
            progressDelivery.push(context.validate().then(() => extra.mcpReq.notify({ method: 'notifications/progress', params: { ...progress, progressToken } })).catch(() => this.drop(session)))
          },
        } : {}),
      }
      const params = logLevel && session.upstream.client.getProtocolEra() === 'modern'
        ? { ...request.params, _meta: { ...request.params?._meta, [LOG_LEVEL_META_KEY]: logLevel } }
        : request.params
      const result = tool
        ? await session.upstream.client.callTool(CallToolRequestSchema.parse({ ...request, params }).params, { ...options, toolDefinition: tool })
        : await session.upstream.client.request({ method: request.method, params }, ResultSchema, options)
      await Promise.all(progressDelivery)
      await Promise.all(requestNotifications.deliveries)
      if (pendingLogLevel) session.logLevel = pendingLogLevel
      if (pendingSubscription) {
        const uris = new Set(session.subscriptionFilter?.resourceSubscriptions ?? [])
        if (pendingSubscription.subscribe) uris.add(pendingSubscription.uri)
        else uris.delete(pendingSubscription.uri)
        session.subscriptionFilter = { ...session.subscriptionFilter, resourceSubscriptions: [...uris] }
      }
      if (request.method === 'tools/list') {
        const catalog = ListToolsResultSchema.parse(result)
        if (catalog.tools.some(tool => tool.annotations?.readOnlyHint !== true || tool.annotations.destructiveHint !== false)) {
          throw ProtocolError.fromError(-32603, 'Upstream catalog violates the read-only contract.')
        }
        // Validate with the SDK, but retain extension fields on the original
        // descriptors before adding this gateway's OAuth metadata.
        const tools = (result.tools as Tool[]).map(withGatewaySecurity)
        return { ...result, tools: request.params?.cursor !== undefined ? tools : [gatewayProfileTool, ...tools] }
      }
      return result
    }
    const initial = session.upstream
    try {
      return await execute()
    } catch (error) {
      // A 404 means the process-local upstream session no longer exists. All
      // admitted calls are catalog-verified reads, so one reinitialize is safe.
      if (!(error instanceof SdkHttpError) || error.status !== 404 || extra.mcpReq.signal.aborted) throw error
      await context.validate()
      await this.reconnect(session, context.binding, initial)
      requireCapability()
      return execute()
    }
  }

  private async drop(session: Session): Promise<void> {
    if (session.closed) return
    session.closed = true
    this.exchanges.delete(session)
    const id = session.transport?.sessionId
    if (id) this.sessions.delete(id)
    await Promise.allSettled([
      session.server.close(),
      this.closeUpstream(session.upstream),
      session.modern?.close(),
      session.subscription?.close(),
    ])
  }
}
