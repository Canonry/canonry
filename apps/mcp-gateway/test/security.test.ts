import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatewayConfigSchema } from '@canonry/canonry-config'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import { createGateway } from '../src/server.js'

const redirectUri = 'http://127.0.0.1:47001/callback'
const running: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const fixture of running.splice(0)) await fixture.close()
})

/** These guards run before upstream contact; no engine or provider is replaced. */
async function fixture(input: { clientName?: string; workspaceName?: string; enabled?: boolean; redirectUri?: string } = {}) {
  const registeredRedirect = input.redirectUri ?? redirectUri
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
    clients: [{ client_id: 'browser-client', client_name: input.clientName ?? 'Synthetic browser client', redirect_uris: [registeredRedirect] }],
    tenants: [{
      id: 'synthetic', displayName: input.workspaceName ?? 'Synthetic workspace', enabled: input.enabled ?? true,
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
      client_id: 'browser-client', redirect_uri: registeredRedirect, response_type: 'code',
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
  const built = { issuer, redirectUri: registeredRedirect, request, authorize, consent, cookies, close }
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
  const registeredRedirect = new URL(built.redirectUri)
  expect(`${callback.origin}${callback.pathname}`).toBe(`${registeredRedirect.origin}${registeredRedirect.pathname}`)
  for (const [name, value] of registeredRedirect.searchParams) expect(callback.searchParams.get(name)).toBe(value)
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
    expect(consent.contentSecurityPolicy).toContain("default-src 'none'")
    expect(consent.contentSecurityPolicy).toContain("font-src 'self'")
    expect(consent.contentSecurityPolicy).not.toContain("'unsafe-inline'")
    const document = JSDOM.fragment(consent.document)
    const nonce = document.querySelector('style')?.getAttribute('nonce')
    expect(nonce).toBeTruthy()
    expect(consent.contentSecurityPolicy).toContain(`style-src 'nonce-${nonce}'`)
    expect(document.querySelector('script')).toBeNull()
    expect(consent.document).toContain('Synthetic browser client')
    expect(consent.document).toContain('Synthetic workspace')
    expect(consent.document).toContain(redirectUri)
    await cancel(built, consent.path, consent.csrf)
    const next = await built.consent()
    const nextNonce = JSDOM.fragment(next.document).querySelector('style')?.getAttribute('nonce')
    expect(nextNonce).toBeTruthy()
    expect(nextNonce).not.toBe(nonce)
    expect(next.contentSecurityPolicy).toContain(`style-src 'nonce-${nextNonce}'`)
    await cancel(built, next.path, next.csrf)
  })

  it('renders configured client, workspace and callback values as text rather than markup', async () => {
    const clientName = '"><script>alert("client")</script>'
    const workspaceName = '</option><img src=x onerror="alert(1)"> & workspace'
    const callback = `${redirectUri}?label=read%20%22only%22&copy;=%3Cscript%3E`
    const built = await fixture({ clientName, workspaceName, redirectUri: callback })
    const consent = await built.consent()
    const document = JSDOM.fragment(consent.document)
    expect(document.textContent).toContain(clientName)
    expect(document.querySelector('option')?.textContent).toBe(workspaceName)
    expect(document.querySelector('details')?.textContent).toContain(callback)
    expect(document.querySelector('script, img, [onerror]')).toBeNull()
    expect(document.querySelector('form')?.getAttribute('action')).toBe(`${built.issuer}${consent.path}/start`)
    expect(document.querySelectorAll('form')).toHaveLength(1)
    expect(document.querySelectorAll('option')).toHaveLength(1)
    await cancel(built, consent.path, consent.csrf)
  })

  it('disables approval when no workspaces are available while keeping cancellation usable', async () => {
    const built = await fixture({ enabled: false })
    const consent = await built.consent()
    const document = JSDOM.fragment(consent.document)
    expect(document.querySelector('select[name="tenant"]')?.hasAttribute('disabled')).toBe(true)
    expect(document.querySelector('button[name="approve"][value="yes"]')?.hasAttribute('disabled')).toBe(true)
    expect(document.querySelector('button[name="approve"][value="no"]')?.hasAttribute('disabled')).toBe(false)
    expect(document.textContent).toContain('No workspaces are available')
    expect(document.querySelector('option[value="synthetic"]')).toBeNull()
    await cancel(built, consent.path, consent.csrf)
  })

  it('serves only the fixed font asset with GET and HEAD', async () => {
    const built = await fixture()
    const fontPath = '/assets/geist-latin-5.3.0.woff2'
    const font = await built.request(fontPath)
    expect(font.status).toBe(200)
    expect(font.headers.get('content-type')).toBe('font/woff2')
    expect(font.headers.get('x-content-type-options')).toBe('nosniff')
    const bytes = Buffer.from(await font.arrayBuffer())
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('wOF2')
    expect(Number(font.headers.get('content-length'))).toBe(bytes.length)
    const head = await built.request(fontPath, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe(font.headers.get('content-type'))
    expect(head.headers.get('content-length')).toBe(font.headers.get('content-length'))
    expect((await head.arrayBuffer()).byteLength).toBe(0)
    const unsupported = await built.request(fontPath, { method: 'POST' })
    expect(unsupported.status).toBe(405)
    expect(unsupported.headers.get('content-type')).not.toBe('font/woff2')
    await unsupported.body?.cancel()
    for (const path of ['/assets/missing.woff2', '/assets/%2e%2e%2fpackage.json']) {
      const unknown = await built.request(path)
      expect(unknown.status).toBe(404)
      expect(unknown.headers.get('content-type')).not.toBe('font/woff2')
      await unknown.body?.cancel()
    }
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
