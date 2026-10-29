import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatewayConfigSchema } from '@canonry/canonry-config'
import Database from 'better-sqlite3'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGateway, type GatewayAuditEvent } from '../src/server.js'
import { GatewayStore } from '../src/store.js'

const cleanups: Array<() => Promise<void>> = []
const sensitive = {
  access: 'diagnostic-private-access-bearer', refresh: 'diagnostic-private-refresh-bearer',
  cookie: 'diagnostic-private-cookie', query: 'diagnostic-private-query', body: 'diagnostic-private-upstream-body',
  verifier: 'diagnostic-private-pkce-verifier-that-is-long-enough', code: 'diagnostic-private-authorization-code',
}
type Failure = 'discovery' | 'token' | 'profile' | 'revocation'

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

/** HTTP policy fixture for diagnostics only; no Canonry business operations are simulated. */
async function fixture(failure?: Failure, pendingRevocation = false) {
  let upstreamOrigin = ''
  const upstream = createServer((req, res) => {
    const path = new URL(req.url ?? '/', upstreamOrigin).pathname
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      json(res, 200, failure === 'discovery' ? { unexpected: sensitive.body } : {
        resource: `${upstreamOrigin}/api/v1/mcp`, authorization_servers: [upstreamOrigin],
      })
    } else if (path === '/.well-known/oauth-authorization-server') {
      json(res, 200, { issuer: upstreamOrigin, authorization_endpoint: `${upstreamOrigin}/oauth/authorize`,
        token_endpoint: `${upstreamOrigin}/oauth/token`, revocation_endpoint: `${upstreamOrigin}/oauth/revoke`,
        authorization_response_iss_parameter_supported: true })
    } else if (path === '/oauth/token') {
      req.resume()
      json(res, 200, failure === 'token' ? { unexpected: sensitive.body } : {
        access_token: sensitive.access, refresh_token: sensitive.refresh, token_type: 'Bearer', expires_in: 600, scope: 'read offline_access',
      })
    } else if (path === '/api/v1/mcp/profile') {
      json(res, 200, failure === 'profile' ? { unexpected: sensitive.body } : {
        userId: 'diagnostic-user', displayName: 'Diagnostic user', scopes: ['read'],
        instance: { issuer: upstreamOrigin, resource: `${upstreamOrigin}/api/v1/mcp` },
      })
    } else if (path === '/oauth/revoke') {
      req.resume()
      json(res, failure === 'revocation' ? 503 : 200, { detail: sensitive.body })
    } else json(res, 404, {})
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('Missing upstream listener')
  upstreamOrigin = `http://127.0.0.1:${upstreamAddress.port}`
  cleanups.push(async () => { await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections() }) })

  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('Missing gateway listener')
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const issuer = `http://127.0.0.1:${address.port}`
  const directory = mkdtempSync(join(tmpdir(), 'canonry-gateway-diagnostics-'))
  const databasePath = join(directory, 'gateway.sqlite')
  const secrets = { vaultKey: randomBytes(32), cookieKeys: [randomBytes(32).toString('hex')] }
  const config = gatewayConfigSchema.parse({
    issuer, port: address.port, development: true, databasePath,
    clients: [{ client_id: 'diagnostic-client', client_name: 'Diagnostic client', redirect_uris: ['http://127.0.0.1:47001/callback'] }],
    tenants: [{ id: 'registered-diagnostic-tenant', displayName: 'Diagnostic workspace', origin: upstreamOrigin, issuer: upstreamOrigin,
      resource: `${upstreamOrigin}/api/v1/mcp`, mcpUrl: `${upstreamOrigin}/api/v1/mcp/readonly`, enabled: true,
      allowPrivateNetwork: true, protocolVersions: ['2025-11-25'], catalogVersion: 'canonry-readonly-v1', upstreamClientId: 'diagnostic-upstream-client' }],
  })
  if (pendingRevocation) {
    const vault = new GatewayStore(databasePath, secrets.vaultKey)
    try {
      vault.put('pending-authorization', 'diagnostic-private-pending-state', {
        tenantId: config.tenants[0]!.id, upstreamClientId: 'diagnostic-upstream-client',
        discovery: { issuer: upstreamOrigin, authorization_endpoint: `${upstreamOrigin}/oauth/authorize`,
          token_endpoint: `${upstreamOrigin}/oauth/token`, revocation_endpoint: `${upstreamOrigin}/oauth/revoke` },
        tokens: { access_token: sensitive.access, refresh_token: sensitive.refresh },
      })
    } finally { vault.close() }
  }
  const events: GatewayAuditEvent[] = []
  const gateway = createGateway(config, secrets, event => events.push(event))
  await new Promise<void>(resolve => gateway.server.listen(config.port, '127.0.0.1', resolve))
  cleanups.push(async () => { await gateway.close(); rmSync(directory, { recursive: true, force: true }) })
  const cookies = new Map<string, string>()
  async function request(path: string, init: RequestInit = {}) {
    const headers = new Headers({ connection: 'close', cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') })
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    const response = await fetch(`${issuer}${path}`, { ...init, headers, redirect: 'manual' })
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]!
      const index = pair.indexOf('=')
      cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    return response
  }
  async function authorize() {
    const query = new URLSearchParams({ client_id: 'diagnostic-client', redirect_uri: 'http://127.0.0.1:47001/callback',
      response_type: 'code', scope: 'read offline_access', resource: `${issuer}/mcp`, state: sensitive.query,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(sensitive.verifier).digest('base64url') })
    const response = await request(`/oauth/authorize?${query}`)
    expect(response.status).toBe(303)
    await response.body?.cancel()
    return new URL(response.headers.get('location')!, issuer).pathname
  }
  async function selectWorkspace() {
    const path = await authorize()
    const page = await request(path)
    expect(page.status).toBe(200)
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1]
    if (!csrf) throw new Error('Missing consent CSRF')
    return request(`${path}/start`, { method: 'POST', headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, tenant: config.tenants[0]!.id, approve: 'yes' }) })
  }
  async function completeUpstream(response: Response) {
    expect(response.status).toBe(200)
    const content = JSDOM.fragment(await response.text()).querySelector('meta[http-equiv="refresh"]')?.getAttribute('content')
    if (!content) throw new Error('Missing upstream authorization handoff')
    const authorization = new URL(content.replace(/^0;\s*url=/i, ''))
    const callback = `/upstream/callback?${new URLSearchParams({ state: authorization.searchParams.get('state')!, code: sensitive.code, iss: upstreamOrigin })}`
    const redirect = await request(callback)
    expect(redirect.status).toBe(303)
    await redirect.body?.cancel()
    const location = new URL(redirect.headers.get('location')!, issuer)
    return request(`${location.pathname}${location.search}`)
  }
  async function login(): Promise<string> {
    let response = await completeUpstream(await selectWorkspace())
    for (let hops = 0; hops < 8; hops++) {
      expect(response.status).toBe(303)
      const next = new URL(response.headers.get('location')!, issuer)
      await response.body?.cancel()
      if (next.origin !== issuer) {
        expect(next.searchParams.get('error')).toBeNull()
        const token = await request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: 'diagnostic-client', redirect_uri: 'http://127.0.0.1:47001/callback',
            grant_type: 'authorization_code', code: next.searchParams.get('code')!, code_verifier: sensitive.verifier, resource: `${issuer}/mcp` }) })
        expect(token.status).toBe(200)
        return (await token.json() as { access_token: string }).access_token
      }
      response = await request(`${next.pathname}${next.search}`)
    }
    throw new Error('Authorization redirect limit exceeded')
  }
  return { request, authorize, selectWorkspace, completeUpstream, login, events, databasePath, issuer, upstreamOrigin }
}

function expectSanitized(events: GatewayAuditEvent[], origins: string[]): void {
  const serialized = JSON.stringify(events)
  for (const value of [...Object.values(sensitive), ...origins]) expect(serialized).not.toContain(value)
  for (const event of events) expect(Object.keys(event).sort()).toEqual(
    ['event', 'status', 'durationMs', 'method', ...(event.code ? ['code', 'errorClass'] : []), ...(event.tenantId ? ['tenantId'] : [])].sort(),
  )
}

describe('gateway sanitized diagnostics', () => {
  it('distinguishes a rejected request from an unexpected storage failure without exposing request values', async () => {
    const built = await fixture()
    const rejected = await built.request(`/mcp?secret=${sensitive.query}`, { method: 'POST',
      headers: { authorization: `Bearer ${sensitive.access}`, cookie: sensitive.cookie, 'x-canonry-tenant': sensitive.body }, body: sensitive.verifier })
    expect(rejected.status).toBe(401)
    await rejected.body?.cancel()
    expect(built.events.at(-1)).toMatchObject({ event: 'gateway_request', status: 401, errorClass: 'request', code: 'request_rejected' })
    expect(built.events.at(-1)?.tenantId).toBeUndefined()
    const interaction = await built.authorize()
    const raw = new Database(built.databasePath)
    try { raw.prepare("UPDATE gateway_records SET payload = ? WHERE kind = 'oidc:Interaction'").run(Buffer.from(sensitive.body)) }
    finally { raw.close() }
    const failed = await built.request(interaction)
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'request_failed' })
    expect(built.events.at(-1)).toMatchObject({ event: 'gateway_request', status: 500, errorClass: 'internal', code: 'internal_error' })
    expectSanitized(built.events, [built.issuer, built.upstreamOrigin])
  })

  it('records provider-handled server errors once instead of treating them as client input failures', async () => {
    const built = await fixture()
    const raw = new Database(built.databasePath)
    try { raw.exec('DROP TABLE gateway_records') } finally { raw.close() }
    const response = await built.request(`/oauth/authorize?client_id=diagnostic-client&response_type=code&redirect_uri=${encodeURIComponent('http://127.0.0.1:47001/callback')}&scope=read&code_challenge_method=S256&code_challenge=${createHash('sha256').update(sensitive.verifier).digest('base64url')}`)
    expect(response.status).toBe(500)
    await response.body?.cancel()
    expect(built.events).toHaveLength(1)
    expect(built.events[0]).toMatchObject({ event: 'gateway_request', status: 500, errorClass: 'oauth', code: 'oidc_server_error' })
    expectSanitized(built.events, [built.issuer, built.upstreamOrigin])
  })

  it.each(['discovery', 'token', 'profile'] as const)('reports invalid upstream %s as 502 with only its registered tenant identity', async failure => {
    const built = await fixture(failure)
    let response = await built.selectWorkspace()
    if (failure !== 'discovery') response = await built.completeUpstream(response)
    expect(response.status).toBe(502)
    await response.body?.cancel()
    expect(built.events.at(-1)).toMatchObject({ event: 'gateway_request', status: 502, errorClass: 'upstream', code: 'invalid_upstream_response', tenantId: 'registered-diagnostic-tenant' })
    expectSanitized(built.events, [built.issuer, built.upstreamOrigin])
  })

  it('records proxy rejections and malformed authenticated JSON with one sanitized event per request', async () => {
    const built = await fixture()
    const bearer = await built.login()
    built.events.length = 0
    const rejected = await built.request('/mcp', { method: 'POST', headers: {
      authorization: `Bearer ${bearer}`, 'mcp-session-id': sensitive.cookie, 'mcp-protocol-version': '2025-11-25',
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
    expect(rejected.status).toBe(404)
    await rejected.body?.cancel()
    expect(built.events).toHaveLength(1)
    expect(built.events[0]).toMatchObject({ event: 'gateway_request', status: 404, errorClass: 'mcp', code: 'mcp_request_failed', tenantId: 'registered-diagnostic-tenant' })
    const malformed = await built.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: `{${sensitive.body}` })
    expect(malformed.status).toBe(400)
    await malformed.body?.cancel()
    expect(built.events).toHaveLength(2)
    expect(built.events[1]).toMatchObject({ event: 'gateway_request', status: 400, errorClass: 'request', code: 'invalid_json', tenantId: 'registered-diagnostic-tenant' })
    expectSanitized(built.events, [built.issuer, built.upstreamOrigin, bearer])
  })

  it('reports failed durable revocation cleanup without exposing credentials or upstream response bodies', async () => {
    const built = await fixture('revocation', true)
    await vi.waitFor(() => expect(built.events).toHaveLength(1))
    expect(built.events[0]).toMatchObject({ event: 'gateway_background_error', status: 503, method: 'BACKGROUND',
      errorClass: 'upstream', code: 'upstream_http_error', tenantId: 'registered-diagnostic-tenant' })
    expectSanitized(built.events, [built.issuer, built.upstreamOrigin])
  })
})
