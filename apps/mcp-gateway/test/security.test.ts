import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatewayConfigSchema } from '@canonry/canonry-config'
import { afterEach, describe, expect, it } from 'vitest'
import { createGateway } from '../src/server.js'

const redirectUri = 'http://127.0.0.1:47001/callback'
const running: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const fixture of running.splice(0)) await fixture.close()
})

/** These guards run before upstream contact; no engine or provider is replaced. */
async function fixture() {
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('Missing ephemeral listener')
  const port = address.port
  const issuer = `http://127.0.0.1:${port}`
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const directory = mkdtempSync(join(tmpdir(), 'canonry-gateway-browser-'))
  const config = gatewayConfigSchema.parse({
    issuer, port, development: true, databasePath: join(directory, 'gateway.sqlite'),
    clients: [{ client_id: 'browser-client', client_name: 'Synthetic browser client', redirect_uris: [redirectUri] }],
    tenants: [{
      id: 'synthetic', displayName: 'Synthetic workspace', enabled: true,
      origin: 'http://127.0.0.1:1', issuer: 'http://127.0.0.1:1',
      resource: 'http://127.0.0.1:1/api/v1/mcp', mcpUrl: 'http://127.0.0.1:1/api/v1/mcp/readonly',
      protocolVersions: ['2025-11-25'], catalogVersion: 'canonry-readonly-v1', upstreamClientId: 'gateway',
    }],
  })
  const gateway = createGateway(config, { vaultKey: randomBytes(32), cookieKeys: [randomBytes(32).toString('base64url')] })
  await new Promise<void>((resolve, reject) => {
    gateway.server.once('error', reject)
    gateway.server.listen(port, '127.0.0.1', resolve)
  })
  const cookies = new Map<string, string>()
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers({ cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') })
    new Headers(init.headers).forEach((value, name) => headers.set(name, value))
    const response = await fetch(`${issuer}${path}`, { ...init, headers, redirect: 'manual' })
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]!
      const index = pair.indexOf('=')
      cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    return response
  }
  const authorize = (patch: Record<string, string | null> = {}) => {
    const verifier = randomBytes(32).toString('base64url')
    const params = new URLSearchParams({
      client_id: 'browser-client', redirect_uri: redirectUri, response_type: 'code',
      scope: 'read offline_access', resource: `${issuer}/mcp`, state: 'outer-browser-state', prompt: 'consent',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    })
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) params.delete(key)
      else params.set(key, value)
    }
    return request(`/oauth/authorize?${params}`)
  }
  const consent = async () => {
    const authorization = await authorize()
    expect(authorization.status).toBe(303)
    const location = new URL(authorization.headers.get('location')!, issuer)
    expect(location.pathname).toMatch(/^\/interaction\/[^/]+$/)
    const response = await request(location.pathname)
    expect(response.status).toBe(200)
    const document = await response.text()
    const csrf = /name="csrf" value="([^"]+)"/.exec(document)?.[1]
    if (!csrf) throw new Error('Consent form did not include a CSRF value')
    return { path: location.pathname, csrf, document, referrerPolicy: response.headers.get('referrer-policy'), contentSecurityPolicy: response.headers.get('content-security-policy') }
  }
  const close = async () => {
    try { await gateway.close() } finally { rmSync(directory, { recursive: true, force: true }) }
  }
  const built = { issuer, request, authorize, consent, cookies, close }
  running.push(built)
  return built
}

async function cancel(built: Awaited<ReturnType<typeof fixture>>, path: string, csrf: string) {
  const response = await built.request(`${path}/start`, {
    method: 'POST', headers: { origin: built.issuer, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, tenant: 'synthetic', approve: 'no' }),
  })
  expect(response.status).toBe(303)
  const resume = new URL(response.headers.get('location')!, built.issuer)
  expect(resume.origin).toBe(built.issuer)
  const resumed = await built.request(`${resume.pathname}${resume.search}`)
  expect(resumed.status).toBe(303)
  const callback = new URL(resumed.headers.get('location')!)
  expect(`${callback.origin}${callback.pathname}`).toBe(redirectUri)
  expect(callback.searchParams.get('error')).toBe('access_denied')
  expect(callback.searchParams.get('state')).toBe('outer-browser-state')
  expect(callback.searchParams.has('code')).toBe(false)
}

describe('gateway browser authorization boundary', () => {
  it('renders the requesting client and selected-workspace consent, and honors cancellation', async () => {
    const built = await fixture()
    const consent = await built.consent()
    // no-referrer makes real browser form POSTs send Origin: null and fail the exact-origin guard.
    expect(consent.referrerPolicy).toBe('same-origin')
    // Browsers apply form-action to the OAuth redirect chain as well as the form target.
    expect(consent.contentSecurityPolicy).toContain("form-action 'self' http://127.0.0.1:47001 http://127.0.0.1:1;")
    expect(consent.contentSecurityPolicy).toContain("frame-ancestors 'none'")
    expect(consent.document).toContain('Synthetic browser client')
    expect(consent.document).toContain('Synthetic workspace')
    expect(consent.document).toContain(redirectUri)
    await cancel(built, consent.path, consent.csrf)
  })

  const invalidPkce: Array<Record<string, string | null>> = [
    { code_challenge: null, code_challenge_method: null },
    { code_challenge_method: 'plain' },
    { code_challenge_method: null },
  ]
  it.each(invalidPkce)('refuses authorization without S256 PKCE: %j', async patch => {
    const built = await fixture()
    const response = await built.authorize(patch)
    expect(response.status).toBe(303)
    const callback = new URL(response.headers.get('location')!)
    expect(`${callback.origin}${callback.pathname}`).toBe(redirectUri)
    expect(callback.searchParams.get('error')).toBe('invalid_request')
    expect(callback.searchParams.has('code')).toBe(false)
    const valid = await built.consent()
    await cancel(built, valid.path, valid.csrf)
  })

  const invalidAuthority: Array<{ patch: Record<string, string>; error: string }> = [
    { patch: { resource: 'https://unregistered.example/mcp' }, error: 'invalid_target' },
    { patch: { scope: 'read research.run' }, error: 'invalid_scope' },
  ]
  it.each(invalidAuthority)('refuses unauthorized OAuth authority: $error', async ({ patch, error }) => {
    const built = await fixture()
    const response = await built.authorize(patch)
    expect(response.status).toBe(303)
    const callback = new URL(response.headers.get('location')!)
    expect(`${callback.origin}${callback.pathname}`).toBe(redirectUri)
    expect(callback.searchParams.get('error')).toBe(error)
    expect(callback.searchParams.has('code')).toBe(false)
    const valid = await built.consent()
    await cancel(built, valid.path, valid.csrf)
  })

  it('refuses an unregistered redirect without sending the browser there', async () => {
    const built = await fixture()
    const response = await built.authorize({ redirect_uri: 'https://unregistered.example/callback' })
    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
    const valid = await built.consent()
    await cancel(built, valid.path, valid.csrf)
  })

  it.each(['origin', 'csrf', 'browser-cookie'] as const)('binds the consent form to its %s', async guard => {
    const built = await fixture()
    const consent = await built.consent()
    const headers: Record<string, string> = { origin: built.issuer, 'content-type': 'application/x-www-form-urlencoded' }
    if (guard === 'origin') headers.origin = 'https://unregistered.example'
    if (guard === 'browser-cookie') {
      headers.cookie = [...built.cookies].map(([name, value]) => `${name}=${name.startsWith('gateway_') ? 'wrong-browser' : value}`).join('; ')
    }
    const rejected = await built.request(`${consent.path}/start`, {
      method: 'POST', headers,
      body: new URLSearchParams({ csrf: guard === 'csrf' ? 'wrong-csrf' : consent.csrf, tenant: 'synthetic', approve: 'no' }),
    })
    expect(rejected.status).toBe(403)
    expect(rejected.headers.get('location')).toBeNull()
    const valid = await built.consent()
    await cancel(built, valid.path, valid.csrf)
  })

  it('refuses unknown upstream state and does not route unauthenticated MCP requests from headers', async () => {
    const built = await fixture()
    const callback = await built.request('/upstream/callback?state=unknown&code=untrusted')
    expect(callback.status).toBe(403)
    expect(callback.headers.get('location')).toBeNull()
    const mcp = await built.request('/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-canonry-tenant': 'other', 'x-upstream-url': 'http://127.0.0.1:1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(mcp.status).toBe(401)
    expect(mcp.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${built.issuer}/.well-known/oauth-protected-resource/mcp"`)
  })
})
