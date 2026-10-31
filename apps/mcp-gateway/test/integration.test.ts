import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { RequestListener } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { gatewayConfigSchema, type GatewayConfig } from '@canonry/canonry-config'
import { canonicalMeasurementPlanV2Json, measurementOverviewResponseSchema, UserRoles } from '@canonry/canonry-contracts'
import { measurementPlans, measurementPlanVersions, users } from '@canonry/canonry-db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { authorizeSyntheticMcp, startSyntheticMcpInstance, type SyntheticMcpInstance } from '../../../packages/canonry/test/mcp-gateway-fixture.js'
import { handoffTarget } from '../../../packages/canonry/test/oauth-handoff.js'
import { measurementPlanV2Fixture } from '../../../packages/api-routes/test/measurement-plan-v2-fixture.js'
import { createGateway } from '../src/server.js'
import { GatewayStore } from '../src/store.js'

interface TokenPair { access_token: string; refresh_token: string; token_type: string; scope: string }
interface RpcMessage { result?: Record<string, unknown>; error?: { code: number; message: string }; id?: number }
interface McpConnection { endpoint: string; token: string; protocol: string; sessionId?: string }
interface AuthorizationAttempt { browser: Browser; verifier: string; state: string; upstream: URL; interaction: URL }

/** Keep explicit listener restarts independent of Node's shared HTTP socket pool. */
function fixtureFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('connection', 'close')
  return fetch(input, { ...init, headers })
}

/** Modern transport attaches server identity outside the unchanged business result. */
function businessResult(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!result) return undefined
  const original = { ...result }
  if (original._meta && typeof original._meta === 'object') {
    const metadata = { ...original._meta } as Record<string, unknown>
    delete metadata['io.modelcontextprotocol/serverInfo']
    if (Object.keys(metadata).length) original._meta = metadata
    else delete original._meta
  }
  return original
}

function businessCatalog(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!result) return undefined
  const tools = result.tools as Array<Record<string, unknown>>
  return { ...businessResult(result), tools: tools.filter(tool => tool.name !== 'canonry_gateway_profile').map(tool => {
    const original = { ...tool }
    delete original.securitySchemes
    if (original._meta && typeof original._meta === 'object') {
      const metadata = { ...original._meta } as Record<string, unknown>
      delete metadata.securitySchemes
      if (Object.keys(metadata).length) original._meta = metadata
      else delete original._meta
    }
    return original
  }) }
}

/** Separate browser contexts preserve real path-scoped cookies on manual redirects. */
class Browser {
  private readonly cookies = new Map<string, { origin: string; name: string; value: string; path: string }>()

  async request(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const target = new URL(url)
    const headers = new Headers(init.headers)
    const cookies = [...this.cookies.values()].filter(item => item.origin === target.origin && target.pathname.startsWith(item.path))
    if (cookies.length) headers.set('cookie', cookies.map(item => `${item.name}=${item.value}`).join('; '))
    const response = await fixtureFetch(target, { ...init, headers, redirect: 'manual' })
    for (const value of response.headers.getSetCookie()) {
      const [pair, ...attributes] = value.split(';').map(part => part.trim())
      const separator = pair!.indexOf('=')
      const name = pair!.slice(0, separator)
      const content = pair!.slice(separator + 1)
      const path = attributes.find(item => item.toLowerCase().startsWith('path='))?.slice(5) ?? '/'
      this.cookies.set(`${target.origin}:${path}:${name}`, { origin: target.origin, name, value: content, path })
    }
    return response
  }

  post(url: URL, fields: Record<string, string>): Promise<Response> {
    return this.request(url, { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
  }
}

function redirect(response: Response, from: URL): URL {
  const location = response.headers.get('location')
  if (!location || ![302, 303, 307].includes(response.status)) throw new Error(`Expected redirect, got ${response.status}`)
  return new URL(location, from)
}
function csrf(html: string): string {
  const value = /name="csrf" value="([^"]+)"/.exec(html)?.[1]
  if (!value) throw new Error('Expected an explicit consent form with CSRF token')
  return value
}
async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture listener address')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}
async function body(response: Response): Promise<RpcMessage> {
  const text = await response.text()
  if (!text) return {}
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text.split('\n').find(line => line.startsWith('data: ') && /"(?:result|error)"/.test(line))
    if (!data) throw new Error('Expected an MCP result or protocol error in the event stream')
    return JSON.parse(data.slice(6)) as RpcMessage
  }
  return JSON.parse(text) as RpcMessage
}
let nextId = 1
async function rpc(connection: McpConnection, method: string, params: Record<string, unknown> = {}) {
  const modern = connection.protocol === '2026-07-28'
  const name = method === 'resources/read' ? params.uri : params.name
  const response = await fixtureFetch(connection.endpoint, {
    method: 'POST', headers: {
      authorization: `Bearer ${connection.token}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': connection.protocol,
      ...(modern ? { 'mcp-method': method, ...(typeof name === 'string' ? { 'mcp-name': name } : {}) } : {}),
      ...(connection.sessionId ? { 'mcp-session-id': connection.sessionId } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: {
      ...params,
      ...(modern ? { _meta: { 'io.modelcontextprotocol/protocolVersion': connection.protocol, 'io.modelcontextprotocol/clientInfo': { name: 'gateway-integration', version: '1.0.0' }, 'io.modelcontextprotocol/clientCapabilities': {} } } : {}),
    } }),
  })
  return { status: response.status, headers: response.headers, message: await body(response) }
}
async function connect(endpoint: string, token: string, protocol = '2025-11-25'): Promise<McpConnection> {
  const connection = { endpoint, token, protocol }
  if (protocol === '2026-07-28') {
    const discovery = await rpc(connection, 'server/discover')
    expect(discovery.status).toBe(200)
    expect(discovery.message.error).toBeUndefined()
    expect(discovery.headers.get('mcp-session-id')).toBeNull()
    return connection
  }
  const initialized = await rpc(connection, 'initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'gateway-integration', version: '1.0.0' } })
  expect(initialized.status).toBe(200)
  expect(initialized.message.error).toBeUndefined()
  const sessionId = initialized.headers.get('mcp-session-id') ?? undefined
  const ready = { ...connection, sessionId }
  const notified = await fixtureFetch(endpoint, {
    method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': protocol, ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  await notified.body?.cancel()
  expect([200, 202, 204]).toContain(notified.status)
  return ready
}

describe('gateway with two real isolated Canonry engines', () => {
  let alpha: SyntheticMcpInstance
  let beta: SyntheticMcpInstance
  let betaSameIdUser: SyntheticMcpInstance['user']
  let gateway: ReturnType<typeof createGateway>
  let config: GatewayConfig
  let directory: string
  let issuer: string
  const clientId = 'integration-client'
  const otherClientId = 'independent-integration-client'
  const callback = 'http://127.0.0.1:55999/client/callback'
  const secrets = { vaultKey: randomBytes(32), cookieKeys: [randomBytes(32).toString('hex')] }

  async function listen(): Promise<void> {
    gateway = createGateway(config, secrets)
    await new Promise<void>((resolve, reject) => { gateway.server.once('error', reject); gateway.server.listen(config.port, '127.0.0.1', resolve) })
  }
  async function seedAdvanced(instance: SyntheticMcpInstance, name: string): Promise<void> {
    const response = await fixtureFetch(`${instance.origin}${instance.basePath}/api/v1/projects/${name}`, {
      method: 'PUT', headers: { authorization: `Bearer ${instance.rootKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Northstar synthetic portfolio', canonicalDomain: 'northstar.example', country: 'US', language: 'en' }),
    })
    expect(response.status).toBe(201)
    const project = await response.json() as { id: string }
    const plan = measurementPlanV2Fixture()
    const versionId = randomUUID()
    const createdAt = new Date().toISOString()
    instance.db.transaction(tx => {
      tx.insert(measurementPlanVersions).values({ id: versionId, projectId: project.id, revision: 1, schemaVersion: 2, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'a'.repeat(64), compiledChecksum: plan.compiledChecksum, createdAt }).run()
      tx.insert(measurementPlans).values({ projectId: project.id, activeVersionId: versionId, createdAt, updatedAt: createdAt }).run()
    })
  }
  async function begin(tenantId: string): Promise<AuthorizationAttempt> {
    const browser = new Browser()
    const verifier = randomBytes(48).toString('base64url')
    const state = randomBytes(24).toString('base64url')
    const authorize = new URL(`${issuer}/oauth/authorize`)
    authorize.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: callback, resource: `${issuer}/mcp`, scope: 'read offline_access', state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString()
    const initial = await browser.request(authorize)
    const interaction = redirect(initial, authorize)
    const selection = await browser.request(interaction)
    expect(selection.status).toBe(200)
    const text = await selection.text()
    expect(text).toContain('read-only access')
    expect(text).not.toContain('tenant-alpha')
    expect(text).not.toContain('tenant-beta')
    const start = new URL(`${interaction.pathname}/start`, issuer)
    const selected = await browser.post(start, { csrf: csrf(text), tenant: tenantId, approve: 'yes' })
    expect(selected.status).toBe(200)
    const handoff = JSDOM.fragment(await selected.text())
    const refresh = handoff.querySelector('meta[http-equiv="refresh"]')?.getAttribute('content')
    if (!refresh?.startsWith('0;url=')) throw new Error('Missing workspace authorization handoff')
    const upstream = new URL(refresh.slice('0;url='.length))
    expect(upstream.origin).toBe(config.tenants.find(tenant => tenant.id === tenantId)?.origin)
    expect(handoff.querySelector('a')?.getAttribute('href')).toBe(upstream.toString())
    return { browser, verifier, state, upstream, interaction }
  }
  async function signIn(attempt: AuthorizationAttempt, instance: SyntheticMcpInstance, user = instance.user): Promise<URL> {
    expect(attempt.upstream.origin).toBe(instance.origin)
    expect(attempt.upstream.searchParams.get('resource')).toBe(instance.resource)
    expect(attempt.upstream.searchParams.get('scope')).toBe('read offline_access')
    const signInPage = await attempt.browser.request(attempt.upstream)
    expect(signInPage.status).toBe(200)
    expect(await signInPage.text()).toContain('name="password"')
    const loggedIn = await attempt.browser.post(attempt.upstream, { name: user.name, password: user.password })
    const consentUrl = redirect(loggedIn, attempt.upstream)
    const consent = await attempt.browser.request(consentUrl)
    expect(consent.status).toBe(200)
    const token = csrf(await consent.text())
    const submit = new URL(consentUrl)
    submit.pathname += '/consent'
    const approved = await attempt.browser.post(submit, { csrf: token, approve: 'yes' })
    expect(approved.status).toBe(200)
    return handoffTarget(await approved.text())
  }
  async function complete(attempt: AuthorizationAttempt, upstreamCallback: URL): Promise<string> {
    let current = upstreamCallback
    for (let remaining = 10; remaining > 0; remaining--) {
      const response = await attempt.browser.request(current)
      if (![302, 303, 307].includes(response.status)) {
        const text = await response.text()
        const title = /<title>([^<]*)<\/title>/.exec(text)?.[1] ?? 'no title'
        const heading = /<h1>([^<]*)<\/h1>/.exec(text)?.[1] ?? 'no heading'
        const fieldNames = [...text.matchAll(/name="([^"]+)"/g)].map(match => match[1])
        const path = current.pathname.replace(/(\/interaction\/)[^/]+/, '$1[interaction]').replace(/(\/oauth\/authorize\/)[^/]+/, '$1[resume]')
        throw new Error(`OAuth completion stopped at ${path}: HTTP ${response.status}; title=${title}; heading=${heading}; form fields=${fieldNames.join(',')}`)
      }
      const next = redirect(response, current)
      if (next.origin + next.pathname === callback) {
        expect(next.searchParams.get('state')).toBe(attempt.state)
        expect(next.searchParams.get('error')).toBeNull()
        const code = next.searchParams.get('code')
        if (!code) throw new Error('Outer authorization did not produce a code')
        return code
      }
      expect(next.origin).toBe(issuer)
      current = next
    }
    throw new Error('OAuth redirect limit exceeded')
  }
  async function token(fields: Record<string, string>): Promise<Response> {
    return fixtureFetch(`${issuer}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, resource: `${issuer}/mcp`, ...fields }) })
  }
  async function login(id: string, instance: SyntheticMcpInstance, user = instance.user): Promise<TokenPair> {
    const attempt = await begin(id)
    const code = await complete(attempt, await signIn(attempt, instance, user))
    const response = await token({ grant_type: 'authorization_code', redirect_uri: callback, code, code_verifier: attempt.verifier })
    expect(response.status).toBe(200)
    const tokens = await response.json() as TokenPair
    expect(tokens.access_token).toBeTruthy()
    expect(tokens.refresh_token).toBeTruthy()
    return tokens
  }
  async function projectList(connection: McpConnection): Promise<string> {
    const result = await rpc(connection, 'tools/call', { name: 'canonry_projects_list', arguments: {} })
    expect(result.status).toBe(200)
    expect(result.message.error).toBeUndefined()
    expect(result.message.result?.isError).not.toBe(true)
    return JSON.stringify(result.message.result)
  }
  async function gatewayProfile(connection: McpConnection): Promise<{ id: string; name: string; nickname: string }> {
    const result = await rpc(connection, 'tools/call', { name: 'canonry_gateway_profile', arguments: {} })
    expect(result.message.error).toBeUndefined()
    expect(result.message.result?.isError).not.toBe(true)
    const profile = result.message.result?.structuredContent as { id: string; name: string; nickname: string }
    expect(profile.id).toBeTypeOf('string')
    expect(profile.name).toBeTypeOf('string')
    expect(profile.nickname).toBeTypeOf('string')
    return profile
  }

  beforeAll(async () => {
    process.env.CANONRY_TELEMETRY_DISABLED = '1'
    process.env.CANONRY_DISABLE_UPDATE_CHECK = '1'
    directory = mkdtempSync(join(tmpdir(), 'canonry-gateway-integration-'))
    alpha = await startSyntheticMcpInstance({ name: 'tenant-alpha' })
    beta = await startSyntheticMcpInstance({ name: 'tenant-beta', basePath: '/nested' })
    // IDs are local to an instance. Equal IDs in separate databases are different people.
    betaSameIdUser = { id: alpha.user.id, name: 'Independent beta reader', password: beta.user.password }
    const betaCredential = beta.db.$client.prepare('SELECT password_hash FROM users WHERE id = ?').get(beta.user.id) as { password_hash: string }
    beta.db.insert(users).values({ id: betaSameIdUser.id, name: betaSameIdUser.name, nameKey: betaSameIdUser.name.toLowerCase(), passwordHash: betaCredential.password_hash, role: UserRoles.viewer, createdAt: new Date().toISOString() }).run()
    await seedAdvanced(alpha, 'alpha-advanced')
    await seedAdvanced(beta, 'beta-advanced')
    const port = await reservePort()
    issuer = `http://127.0.0.1:${port}`
    const tenants = []
    for (const [id, instance] of [['alpha', alpha], ['beta', beta]] as const) {
      const registered = await fixtureFetch(`${instance.origin}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Synthetic shared gateway', redirect_uris: [`${issuer}/upstream/callback`] }) })
      expect(registered.status).toBe(201)
      const registration = await registered.json() as { client_id: string }
      tenants.push({ id, displayName: `tenant-${id}`, origin: instance.origin, issuer: instance.origin, resource: instance.resource, mcpUrl: instance.transportUrl, enabled: true, allowPrivateNetwork: true, protocolVersions: ['2026-07-28', '2025-11-25'], catalogVersion: 'canonry-readonly-v1', upstreamClientId: registration.client_id })
    }
    config = gatewayConfigSchema.parse({ issuer, development: true, port, databasePath: join(directory, 'gateway.sqlite'), clients: [
      { client_id: clientId, client_name: 'Integration client', redirect_uris: [callback] },
      { client_id: otherClientId, client_name: 'Independent integration client', redirect_uris: [callback] },
    ], tenants, rateLimitPerMinute: 10_000 })
    await listen()
  }, 120_000)
  afterAll(async () => {
    if (gateway) await gateway.close()
    await beta?.close()
    await alpha?.close()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }, 30_000)

  it('discovers OAuth, signs in at each instance, and preserves full read-only catalog and data isolation', async () => {
    const metadata = await fixtureFetch(`${issuer}/.well-known/oauth-protected-resource/mcp`)
    expect(await metadata.json()).toMatchObject({ resource: `${issuer}/mcp`, authorization_servers: [issuer] })
    const authorizationServer = await fixtureFetch(`${issuer}/.well-known/oauth-authorization-server`)
    expect(authorizationServer.status).toBe(200)
    expect(await authorizationServer.json()).toMatchObject({ issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, code_challenge_methods_supported: ['S256'] })
    const unauthorized = await fixtureFetch(`${issuer}/mcp`)
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('www-authenticate')).toContain(`${issuer}/.well-known/oauth-protected-resource/mcp`)
    const alphaTokens = await login('alpha', alpha)
    const betaTokens = await login('beta', beta)
    const a = await connect(`${issuer}/mcp`, alphaTokens.access_token, '2026-07-28')
    const b = await connect(`${issuer}/mcp`, betaTokens.access_token)
    const alphaIdentity = await gatewayProfile(a)
    const betaIdentity = await gatewayProfile(b)
    expect(alphaIdentity.id).not.toBe(betaIdentity.id)
    expect(alphaIdentity.id).not.toContain(alpha.user.id)
    expect(betaIdentity.id).not.toContain(beta.user.id)
    const reconnected = await login('alpha', alpha)
    expect((await gatewayProfile(await connect(`${issuer}/mcp`, reconnected.access_token))).id).toBe(alphaIdentity.id)
    const equalLocalIdTokens = await login('beta', beta, betaSameIdUser)
    const equalLocalId = await connect(`${issuer}/mcp`, equalLocalIdTokens.access_token)
    expect((await gatewayProfile(equalLocalId)).id).not.toBe(alphaIdentity.id)
    const betaLocalProfile = await rpc(equalLocalId, 'tools/call', { name: 'canonry_mcp_profile', arguments: {} })
    expect(JSON.stringify(betaLocalProfile.message.result)).toContain(alpha.user.id)
    const equalLocalProjects = await projectList(equalLocalId)
    expect(equalLocalProjects).toContain('tenant-beta')
    expect(equalLocalProjects).not.toContain('tenant-alpha')
    const alphaProjects = await projectList(a)
    const betaProjects = await projectList(b)
    expect(alphaProjects).toContain('tenant-alpha')
    expect(alphaProjects).not.toContain('tenant-beta')
    expect(betaProjects).toContain('tenant-beta')
    expect(betaProjects).not.toContain('tenant-alpha')
    const upstreamTokens = await authorizeSyntheticMcp(alpha)
    const direct = await connect(alpha.transportUrl, upstreamTokens.access_token, '2026-07-28')
    for (const name of ['canonry_measurement_plan_get', 'canonry_measurement_setup']) {
      const params = { name, arguments: { project: 'alpha-advanced' } }
      const expected = await rpc(direct, 'tools/call', params)
      const actual = await rpc(a, 'tools/call', params)
      expect(actual.message.result?.isError).not.toBe(true)
      expect(businessResult(actual.message.result)).toEqual(businessResult(expected.message.result))
    }
    for (const scope of [{ scope: 'property', targetKey: 'harbor' }, { scope: 'group', groupKey: 'regional' }]) {
      const params = { name: 'canonry_measurement_overview', arguments: { project: 'alpha-advanced', ...scope, provider: 'openai', queryClass: 'non-brand', compact: true, limit: 1 } }
      const expected = await rpc(direct, 'tools/call', params)
      const actual = await rpc(a, 'tools/call', params)
      expect(actual.message.result?.isError).not.toBe(true)
      expect(businessResult(actual.message.result)).toEqual(businessResult(expected.message.result))
      const overview = measurementOverviewResponseSchema.parse(actual.message.result?.structuredContent)
      expect(overview.queryClass).toBe('non-brand')
      if (scope.scope === 'group') {
        expect(overview.properties.nextCursor).toBeTruthy()
        const next = { ...params, arguments: { ...params.arguments, cursor: overview.properties.nextCursor } }
        expect(businessResult((await rpc(a, 'tools/call', next)).message.result)).toEqual(businessResult((await rpc(direct, 'tools/call', next)).message.result))
      }
    }
    const foreignPortfolio = await rpc(b, 'tools/call', { name: 'canonry_measurement_plan_get', arguments: { project: 'alpha-advanced' } })
    expect(foreignPortfolio.message.result?.isError).toBe(true)
    for (const method of ['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']) {
      const expected = await rpc(direct, method)
      const proxied = await rpc(a, method)
      if (method === 'tools/list') {
        expect(businessCatalog(proxied.message.result)).toEqual(businessCatalog(expected.message.result))
        const tools = proxied.message.result?.tools as Array<Record<string, unknown>>
        for (const tool of tools) {
          expect(tool.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['read'] }])
          expect((tool._meta as Record<string, unknown>).securitySchemes).toEqual(tool.securitySchemes)
        }
        const profileTool = tools.find(tool => tool.name === 'canonry_gateway_profile')
        expect(profileTool).toBeDefined()
        expect((profileTool!._meta as Record<string, unknown>)['openai/profile']).toBe(true)
      } else expect(businessResult(proxied.message.result)).toEqual(businessResult(expected.message.result))
      expect(proxied.message.error?.code).toEqual(expected.message.error?.code)
    }
    const listed = await rpc(a, 'resources/list')
    const resources = listed.message.result?.resources as Array<{ uri: string }>
    expect(resources.length).toBeGreaterThan(0)
    const uri = resources[0]!.uri
    expect(businessResult((await rpc(a, 'resources/read', { uri })).message.result)).toEqual(businessResult((await rpc(direct, 'resources/read', { uri })).message.result))
    const unknownPrompt = { name: 'unregistered-prompt', arguments: {} }
    expect((await rpc(a, 'prompts/get', unknownPrompt)).message.error?.code).toEqual((await rpc(direct, 'prompts/get', unknownPrompt)).message.error?.code)
    const profile = await rpc(a, 'tools/call', { name: 'canonry_mcp_profile', arguments: {} })
    expect(JSON.stringify(profile.message.result)).toContain(alpha.user.id)
    expect(JSON.stringify(profile.message.result)).not.toContain(beta.user.id)
    const isolatedLegacySession = await connect(`${issuer}/mcp`, alphaTokens.access_token)
    expect((await rpc({ ...isolatedLegacySession, token: betaTokens.access_token }, 'tools/list')).status).toBe(404)
    expect((await rpc({ ...direct, token: alphaTokens.access_token }, 'tools/list')).status).toBe(401)
    expect((await rpc({ ...a, token: upstreamTokens.access_token }, 'tools/list')).status).toBe(401)
    const otherProject = await rpc(a, 'tools/call', { name: 'canonry_project_get', arguments: { project: 'tenant-beta' } })
    expect(otherProject.message.result?.isError).toBe(true)
    for (const name of ['canonry_project_upsert', 'canonry_research_run_start', 'canonry_provider_settings_update']) {
      const rejected = await rpc(a, 'tools/call', { name, arguments: { project: 'tenant-alpha' } })
      expect(rejected.message.error?.code).toBe(-32602)
    }
  }, 120_000)

  it('reads current instance authority once for each HTTP request across both MCP transports', async () => {
    const tokens = await login('alpha', alpha)
    let profileReads = 0
    const observe: RequestListener = req => {
      if (req.url === new URL(alpha.profileUrl).pathname) profileReads++
    }
    alpha.app.server.on('request', observe)
    try {
      for (const protocol of ['2026-07-28', '2025-11-25']) {
        const connection = await connect(`${issuer}/mcp`, tokens.access_token, protocol)
        for (let request = 0; request < 2; request++) {
          profileReads = 0
          expect(await projectList(connection)).toContain('tenant-alpha')
          expect(profileReads).toBe(1)
        }
      }
    } finally { alpha.app.server.removeListener('request', observe) }
  }, 120_000)

  it('rejects a different upstream issuer, wrong outer PKCE and callback reuse', async () => {
    const badIssuer = await begin('alpha')
    const validCallback = await signIn(badIssuer, alpha)
    validCallback.searchParams.set('iss', beta.origin)
    const intermediate = await badIssuer.browser.request(validCallback)
    const rejectedIssuer = await badIssuer.browser.request(redirect(intermediate, validCallback))
    expect(rejectedIssuer.status).toBe(403)
    const attempt = await begin('alpha')
    const completedCallback = await signIn(attempt, alpha)
    const code = await complete(attempt, completedCallback)
    const badPkce = await token({ grant_type: 'authorization_code', redirect_uri: callback, code, code_verifier: 'wrong-verifier-that-is-long-enough-to-be-valid-syntax' })
    expect(badPkce.status).toBe(400)
    expect(await badPkce.json()).toMatchObject({ error: 'invalid_grant' })
    expect((await attempt.browser.request(completedCallback)).status).toBe(403)
  }, 120_000)

  it('rotates refresh tokens, rejects replay, and disconnects one grant without affecting another', async () => {
    const first = await login('alpha', alpha)
    const independent = await login('beta', beta)
    const oldSession = await connect(`${issuer}/mcp`, first.access_token)
    const identity = await gatewayProfile(oldSession)
    const wrongClient = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: 'unregistered-client' })
    expect(wrongClient.status).toBe(401)
    expect(await wrongClient.json()).toMatchObject({ error: 'invalid_client' })
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token })
    expect(refreshed.status).toBe(200)
    const rotated = await refreshed.json() as TokenPair
    expect(rotated.refresh_token === first.refresh_token).toBe(false)
    expect((await rpc({ ...oldSession, token: rotated.access_token }, 'tools/list')).status).toBe(404)
    const current = await connect(`${issuer}/mcp`, rotated.access_token)
    expect((await gatewayProfile(current)).id).toBe(identity.id)
    expect(await projectList(current)).toContain('tenant-alpha')
    const replayed = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token })
    expect(replayed.status).toBe(400)
    expect(await replayed.json()).toMatchObject({ error: 'invalid_grant' })
    expect((await rpc(current, 'tools/list')).status).toBe(401)
    const other = await connect(`${issuer}/mcp`, independent.access_token)
    expect(await projectList(other)).toContain('tenant-beta')
    const disconnected = await fixtureFetch(`${issuer}/disconnect`, { method: 'POST', headers: { authorization: `Bearer ${independent.access_token}` } })
    expect(disconnected.status).toBe(200)
    expect((await rpc(other, 'tools/list')).status).toBe(401)
    const refreshAfterDisconnect = await token({ grant_type: 'refresh_token', refresh_token: independent.refresh_token })
    expect(refreshAfterDisconnect.status).toBe(400)
  }, 120_000)

  it('revokes the upstream OAuth family after public gateway token revocation without affecting another grant', async () => {
    // Reset maintenance timing so the short propagation deadline exercises the
    // provider revocation event, not the periodic orphan-grant cleanup.
    await gateway.close()
    await listen()
    const vault = new GatewayStore(config.databasePath, secrets.vaultKey)
    try {
      const existing = new Set(vault.list('connection').map(item => item.id))
      const first = await login('alpha', alpha)
      const firstConnection = vault.list<{ tenantId: string; tokens: { access_token: string } }>('connection')
        .find(item => !existing.has(item.id) && item.value.tenantId === 'alpha')
      if (!firstConnection) throw new Error('Expected the first upstream authorization')
      existing.add(firstConnection.id)
      const independent = await login('alpha', alpha)
      const secondConnection = vault.list<{ tenantId: string; tokens: { access_token: string } }>('connection')
        .find(item => !existing.has(item.id) && item.value.tenantId === 'alpha')
      if (!secondConnection) throw new Error('Expected an independent upstream authorization')
      async function upstreamStatus(accessToken: string): Promise<number> {
        const response = await fixtureFetch(alpha.profileUrl, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(3000) })
        await response.body?.cancel()
        return response.status
      }
      expect(await upstreamStatus(firstConnection.value.tokens.access_token)).toBe(200)
      expect(await upstreamStatus(secondConnection.value.tokens.access_token)).toBe(200)
      const wrongClient = await fixtureFetch(`${issuer}/oauth/revoke`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: otherClientId, token: first.refresh_token, token_type_hint: 'refresh_token' }),
      })
      expect(wrongClient.status).toBe(200)
      await wrongClient.body?.cancel()
      expect(await upstreamStatus(firstConnection.value.tokens.access_token)).toBe(200)
      expect(await projectList(await connect(`${issuer}/mcp`, first.access_token))).toContain('tenant-alpha')
      const revoked = await fixtureFetch(`${issuer}/oauth/revoke`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, token: first.refresh_token, token_type_hint: 'refresh_token' }),
      })
      expect(revoked.status).toBe(200)
      await revoked.body?.cancel()
      const deadline = Date.now() + 3000
      let status = await upstreamStatus(firstConnection.value.tokens.access_token)
      while (status === 200 && Date.now() < deadline) {
        await delay(50)
        status = await upstreamStatus(firstConnection.value.tokens.access_token)
      }
      expect(status).toBe(401)
      expect(await upstreamStatus(secondConnection.value.tokens.access_token)).toBe(200)
      expect(await projectList(await connect(`${issuer}/mcp`, independent.access_token))).toContain('tenant-alpha')
    } finally { vault.close() }
  }, 120_000)

  it('revokes failed upstream authorizations immediately and recovers queued cleanup after restart', async () => {
    const independent = await login('alpha', alpha)
    const original = config
    try {
      for (const revocationUnavailable of [false, true]) {
        const attempt = await begin('alpha')
        const callbackUrl = await signIn(attempt, alpha)
        const server = alpha.app.server
        const listeners = server.listeners('request') as RequestListener[]
        let issuedAccessToken: string | undefined
        const failedSetup: RequestListener = (req, res) => {
          const path = new URL(req.url ?? '/', alpha.origin).pathname
          if (path === new URL(alpha.profileUrl).pathname) {
            issuedAccessToken = req.headers.authorization?.replace(/^Bearer /, '')
            res.writeHead(503, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'synthetic_profile_outage' }))
          } else if (path === '/oauth/revoke' && revocationUnavailable) {
            req.resume()
            res.writeHead(503, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'synthetic_revocation_outage' }))
          } else {
            for (const listener of listeners) listener.call(server, req, res)
          }
        }
        for (const listener of listeners) server.removeListener('request', listener)
        server.on('request', failedSetup)
        try {
          const intermediate = await attempt.browser.request(callbackUrl)
          const failed = await attempt.browser.request(redirect(intermediate, callbackUrl))
          expect(failed.status).toBe(503)
          expect(await failed.json()).toMatchObject({ error: 'request_failed' })
        } finally {
          server.removeListener('request', failedSetup)
          for (const listener of listeners) server.on('request', listener)
        }
        if (!issuedAccessToken) throw new Error('Expected real token exchange before profile failure')
        const upstreamStatus = async (): Promise<number> => {
          const response = await fixtureFetch(alpha.profileUrl, { headers: { authorization: `Bearer ${issuedAccessToken}` } })
          await response.body?.cancel()
          return response.status
        }
        if (revocationUnavailable) {
          expect(await upstreamStatus()).toBe(200)
          const registration = await fixtureFetch(`${alpha.origin}/oauth/register`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ client_name: 'Replacement after failed setup', redirect_uris: [`${issuer}/upstream/callback`] }),
          })
          expect(registration.status).toBe(201)
          const replacement = await registration.json() as { client_id: string }
          await gateway.close()
          config = gatewayConfigSchema.parse({ ...config, tenants: config.tenants.map(tenant => tenant.id === 'alpha' ? { ...tenant, upstreamClientId: replacement.client_id } : tenant) })
          await listen()
          const deadline = Date.now() + 3000
          let status = await upstreamStatus()
          while (status === 200 && Date.now() < deadline) {
            await delay(50)
            status = await upstreamStatus()
          }
          expect(status).toBe(401)
        } else expect(await upstreamStatus()).toBe(401)
        expect(await projectList(await connect(`${issuer}/mcp`, independent.access_token))).toContain('tenant-alpha')
      }
    } finally {
      if (config !== original) {
        await gateway.close()
        config = original
        await listen()
      }
    }
  }, 120_000)

  it('serves modern calls without sessions and preserves legacy clients on each configured upstream protocol', async () => {
    const tokens = await login('beta', beta)
    for (const upstreamProtocol of ['2025-11-25', '2026-07-28']) {
      await gateway.close()
      config = gatewayConfigSchema.parse({ ...config, tenants: config.tenants.map(tenant => tenant.id === 'beta' ? { ...tenant, protocolVersions: [upstreamProtocol] } : tenant) })
      await listen()
      for (const clientProtocol of ['2025-11-25', '2026-07-28']) {
        const connection = await connect(`${issuer}/mcp`, tokens.access_token, clientProtocol)
        expect(await projectList(connection)).toContain('tenant-beta')
        expect(await projectList(connection)).not.toContain('tenant-alpha')
        if (clientProtocol === '2026-07-28') {
          expect(connection.sessionId).toBeUndefined()
          const listed = await rpc(connection, 'tools/list')
          expect(listed.headers.get('mcp-session-id')).toBeNull()
        } else expect(connection.sessionId).toBeTruthy()
      }
    }
  }, 120_000)

  it('refreshes an expired upstream bearer once across concurrent reads and honors upstream grant revocation', async () => {
    // Operator-side fixture access supplies the real upstream revoke credential;
    // no browser/tool response is allowed to expose this encrypted value.
    const vault = new GatewayStore(config.databasePath, secrets.vaultKey)
    try {
      const existing = new Set(vault.list('connection').map(item => item.id))
      const tokens = await login('alpha', alpha)
      const connection = await connect(`${issuer}/mcp`, tokens.access_token)
      const linked = vault.list<{ tenantId: string; tokens: { refresh_token: string } }>('connection')
        .find(item => !existing.has(item.id) && item.value.tenantId === 'alpha')
      if (!linked) throw new Error('Expected a new encrypted upstream connection')
      const upstreamClient = config.tenants.find(tenant => tenant.id === 'alpha')!.upstreamClientId!
      const countTokens = () => alpha.db.$client.prepare('SELECT COUNT(*) AS total FROM oauth_tokens WHERE client_id = ? AND kind = ?')
        .get(upstreamClient, 'refresh') as { total: number }
      const before = countTokens().total
      alpha.db.$client.prepare('UPDATE oauth_tokens SET expires_at = ? WHERE client_id = ? AND kind = ?')
        .run('2000-01-01T00:00:00.000Z', upstreamClient, 'access')
      const results = await Promise.all([projectList(connection), projectList(connection), projectList(connection)])
      for (const result of results) {
        expect(result).toContain('tenant-alpha')
        expect(result).not.toContain('tenant-beta')
      }
      expect(countTokens().total).toBe(before + 1)
      const rotated = vault.get<{ tokens: { refresh_token: string } }>('connection', linked.id)
      expect(rotated?.tokens.refresh_token === linked.value.tokens.refresh_token).toBe(false)
      const revoked = await fixtureFetch(`${alpha.origin}/oauth/revoke`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: upstreamClient, token: rotated!.tokens.refresh_token }),
      })
      expect(revoked.status).toBe(200)
      expect((await rpc(connection, 'tools/list')).status).toBe(401)
    } finally { vault.close() }
  }, 120_000)

  it('reports upstream outage and reconnects the same authorized legacy session after an instance restart', async () => {
    await gateway.close()
    config = gatewayConfigSchema.parse({ ...config, tenants: config.tenants.map(tenant => tenant.id === 'beta' ? { ...tenant, protocolVersions: ['2025-11-25'] } : tenant) })
    await listen()
    const tokens = await login('beta', beta)
    const connection = await connect(`${issuer}/mcp`, tokens.access_token)
    const disconnectedTokens = await login('beta', beta)
    const disconnectedSession = await connect(`${issuer}/mcp`, disconnectedTokens.access_token)
    expect(await projectList(connection)).toContain('tenant-beta')
    await beta.app.close()
    try {
      const unavailable = await rpc(connection, 'tools/list')
      expect([502, 503, 504]).toContain(unavailable.status)
      expect(unavailable.message.result).toBeUndefined()
      const disconnected = await fixtureFetch(`${issuer}/disconnect`, { method: 'POST', headers: { authorization: `Bearer ${disconnectedTokens.access_token}` } })
      expect(disconnected.status).toBe(200)
      expect((await rpc(disconnectedSession, 'tools/list')).status).toBe(401)
    } finally { await beta.restart() }
    expect(await projectList(connection)).toContain('tenant-beta')
    expect(await projectList(connection)).not.toContain('tenant-alpha')
    expect((await rpc(disconnectedSession, 'tools/list')).status).toBe(401)
  }, 120_000)

  it('keeps existing upstream refresh grants bound to their original registered client', async () => {
    const tokens = await login('alpha', alpha)
    const original = config
    const oldClient = config.tenants.find(tenant => tenant.id === 'alpha')!.upstreamClientId!
    const registration = await fixtureFetch(`${alpha.origin}/oauth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Replacement synthetic gateway client', redirect_uris: [`${issuer}/upstream/callback`] }),
    })
    expect(registration.status).toBe(201)
    const replacement = await registration.json() as { client_id: string }
    await gateway.close()
    config = gatewayConfigSchema.parse({ ...config, tenants: config.tenants.map(tenant => tenant.id === 'alpha' ? { ...tenant, upstreamClientId: replacement.client_id } : tenant) })
    await listen()
    try {
      alpha.db.$client.prepare('UPDATE oauth_tokens SET expires_at = ? WHERE client_id = ? AND kind = ?')
        .run('2000-01-01T00:00:00.000Z', oldClient, 'access')
      const connection = await connect(`${issuer}/mcp`, tokens.access_token)
      expect(await projectList(connection)).toContain('tenant-alpha')
    } finally {
      await gateway.close()
      config = original
      await listen()
    }
  }, 120_000)

  it('persists grants through gateway restart, requires legacy reinitialization, and enforces tenant suspension', async () => {
    const tokens = await login('alpha', alpha)
    const old = await connect(`${issuer}/mcp`, tokens.access_token)
    const identity = await gatewayProfile(old)
    await gateway.close()
    await listen()
    expect((await rpc(old, 'tools/list')).status).toBe(404)
    const resumed = await connect(`${issuer}/mcp`, tokens.access_token)
    expect(await projectList(resumed)).toContain('tenant-alpha')
    expect((await gatewayProfile(resumed)).id).toBe(identity.id)
    await gateway.close()
    config = gatewayConfigSchema.parse({ ...config, tenants: config.tenants.map(tenant => tenant.id === 'alpha' ? { ...tenant, enabled: false } : tenant) })
    await listen()
    expect((await rpc({ ...old, sessionId: undefined }, 'initialize', { protocolVersion: old.protocol, capabilities: {}, clientInfo: { name: 'suspended', version: '1' } })).status).toBe(403)
    await gateway.close()
    config = gatewayConfigSchema.parse({ ...config, tenants: config.tenants.map(tenant => ({ ...tenant, enabled: true })) })
    await listen()
  }, 120_000)

  it('rechecks current user identity and authority after role changes and deletion', async () => {
    const otherTenantTokens = await login('beta', beta, betaSameIdUser)
    const otherTenant = await connect(`${issuer}/mcp`, otherTenantTokens.access_token)
    alpha.db.$client.prepare('UPDATE users SET role = ? WHERE id = ?').run(UserRoles.admin, alpha.user.id)
    const tokens = await login('alpha', alpha)
    const connection = await connect(`${issuer}/mcp`, tokens.access_token)
    const identity = await gatewayProfile(connection)
    expect(await projectList(connection)).toContain('tenant-alpha')
    alpha.db.$client.prepare('UPDATE users SET role = ?, name = ? WHERE id = ?').run(UserRoles.viewer, 'Updated synthetic reader', alpha.user.id)
    const profile = await rpc(connection, 'tools/call', { name: 'canonry_mcp_profile', arguments: {} })
    expect(JSON.stringify(profile.message.result)).toContain('Updated synthetic reader')
    const updatedIdentity = await gatewayProfile(connection)
    expect(updatedIdentity.id).toBe(identity.id)
    expect(updatedIdentity.name).toBe('Updated synthetic reader')
    expect((await rpc(connection, 'tools/call', { name: 'canonry_provider_settings_update', arguments: {} })).message.error?.code).toBe(-32602)
    expect(await projectList(connection)).toContain('tenant-alpha')
    alpha.db.$client.prepare('DELETE FROM users WHERE id = ?').run(alpha.user.id)
    const response = await rpc(connection, 'tools/list')
    expect([400, 401, 403]).toContain(response.status)
    expect(response.message.result).toBeUndefined()
    expect(await projectList(otherTenant)).toContain('tenant-beta')
  }, 120_000)
})
