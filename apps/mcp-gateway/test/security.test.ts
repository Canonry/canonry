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
async function fixture(input: { clientName?: string; workspaceName?: string; workspaceOrigin?: string; enabled?: boolean; provisioned?: boolean; redirectUri?: string; extraRedirectUris?: string[]; applicationType?: 'web' | 'native' } = {}) {
  const registeredRedirect = input.redirectUri ?? redirectUri
  const workspaceOrigin = input.workspaceOrigin ?? 'http://127.0.0.1:1'
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
    clients: [{
      client_id: 'browser-client', client_name: input.clientName ?? 'Synthetic browser client', redirect_uris: [registeredRedirect, ...(input.extraRedirectUris ?? [])],
      ...(input.applicationType ? { application_type: input.applicationType } : {}),
    }],
    tenants: [{
      id: 'synthetic', displayName: input.workspaceName ?? 'Synthetic workspace', enabled: input.enabled ?? true,
      origin: workspaceOrigin, issuer: workspaceOrigin, allowPrivateNetwork: true,
      resource: `${workspaceOrigin}/api/v1/mcp`, mcpUrl: `${workspaceOrigin}/api/v1/mcp/readonly`,
      protocolVersions: ['2025-11-25'], catalogVersion: 'canonry-readonly-v1', upstreamClientId: input.provisioned === false ? undefined : 'gateway',
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
    body: new URLSearchParams({ csrf, tenant: '', approve: 'no' }),
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
  it('keeps registered workspace identities private and permits cancellation without a workspace', async () => {
    const built = await fixture()
    const consent = await built.consent()
    // no-referrer makes real browser form POSTs send Origin: null and fail the exact-origin guard.
    expect(consent.referrerPolicy).toBe('same-origin')
    // Browsers apply form-action to the OAuth redirect chain as well as the form target.
    expect(consent.contentSecurityPolicy).toContain("form-action 'self' http://127.0.0.1:47001;")
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
    for (const privateValue of ['Synthetic workspace', 'synthetic', 'http://127.0.0.1:1']) {
      expect(consent.document).not.toContain(privateValue)
      expect(consent.contentSecurityPolicy).not.toContain(privateValue)
    }
    const workspace = document.querySelector('input[name="tenant"]')
    expect(workspace?.getAttribute('type')).toBe('text')
    expect(workspace?.hasAttribute('required')).toBe(true)
    expect(workspace?.getAttribute('autocomplete')).toBe('off')
    expect(workspace?.getAttribute('value')).toBeNull()
    expect(document.querySelector('select, option, datalist')).toBeNull()
    expect(document.querySelector('button[value="no"]')?.hasAttribute('formnovalidate')).toBe(true)
    expect(consent.document).toContain(redirectUri)
    await cancel(built, consent.path, consent.csrf)
    const next = await built.consent()
    const nextNonce = JSDOM.fragment(next.document).querySelector('style')?.getAttribute('nonce')
    expect(nextNonce).toBeTruthy()
    expect(nextNonce).not.toBe(nonce)
    expect(next.contentSecurityPolicy).toContain(`style-src 'nonce-${nextNonce}'`)
    await cancel(built, next.path, next.csrf)
  })

  it('escapes client and callback text without rendering configured workspace names', async () => {
    const clientName = '"><script>alert("client")</script>'
    const workspaceName = '</option><img src=x onerror="alert(1)"> & workspace'
    const callback = `${redirectUri}?label=read%20%22only%22&copy;=%3Cscript%3E`
    const built = await fixture({ clientName, workspaceName, redirectUri: callback })
    const consent = await built.consent()
    const document = JSDOM.fragment(consent.document)
    expect(document.textContent).toContain(clientName)
    expect(document.textContent).not.toContain(workspaceName)
    expect(document.querySelector('details')?.textContent).toContain(callback)
    expect(document.querySelector('script, img, [onerror]')).toBeNull()
    expect(document.querySelector('form')?.getAttribute('action')).toBe(`${built.issuer}${consent.path}/start`)
    expect(document.querySelectorAll('form')).toHaveLength(1)
    expect(document.querySelectorAll('option')).toHaveLength(0)
    await cancel(built, consent.path, consent.csrf)
  })

  it.each([
    { selection: '', enabled: true, provisioned: true },
    { selection: 'unknown-workspace', enabled: true, provisioned: true },
    { selection: 'synthetic', enabled: false, provisioned: true },
    { selection: 'synthetic', enabled: true, provisioned: false },
  ])('returns the same recoverable response for an unavailable workspace: %j', async input => {
    const built = await fixture(input)
    const consent = await built.consent()
    const initial = JSDOM.fragment(consent.document)
    expect(initial.querySelector('input[name="tenant"]')?.hasAttribute('disabled')).toBe(false)
    expect(initial.querySelector('button[value="yes"]')?.hasAttribute('disabled')).toBe(false)
    expect(initial.textContent).not.toContain('No workspaces')
    const rejected = await built.request(`${consent.path}/start`, {
      method: 'POST', headers: { origin: built.issuer, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: consent.csrf, tenant: input.selection, approve: 'yes' }),
    })
    expect(rejected.status).toBe(400)
    expect(rejected.headers.get('location')).toBeNull()
    const document = JSDOM.fragment(await rejected.text())
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Unable to connect. Check your workspace and try again.')
    expect(document.querySelector('input[name="tenant"]')?.getAttribute('value')).toBeNull()
    const retryCsrf = document.querySelector('input[name="csrf"]')?.getAttribute('value')
    expect(retryCsrf).toBeTruthy()
    expect(retryCsrf).not.toBe(consent.csrf)
    await cancel(built, consent.path, retryCsrf!)
  })

  it('accepts only an exact registered slug or domain and creates a fresh navigation to its pinned authorization endpoint', async () => {
    const requests: string[] = []
    let workspaceOrigin = ''
    const upstream = createServer((req, res) => {
      requests.push(req.url ?? '')
      const metadata = req.url?.startsWith('/.well-known/oauth-protected-resource')
        ? { resource: `${workspaceOrigin}/api/v1/mcp`, authorization_servers: [workspaceOrigin] }
        : { issuer: workspaceOrigin, authorization_endpoint: `${workspaceOrigin}/oauth/authorize`, token_endpoint: `${workspaceOrigin}/oauth/token`, revocation_endpoint: `${workspaceOrigin}/oauth/revoke` }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(metadata))
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('Missing upstream listener')
    workspaceOrigin = `http://127.0.0.1:${address.port}`
    running.push({ close: () => new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())) })
    const built = await fixture({ workspaceOrigin })
    for (const selection of [`${workspaceOrigin}/unregistered`, `${new URL(workspaceOrigin).host}.attacker.example`, 'synthetic-other']) {
      const consent = await built.consent()
      const denied = await built.request(`${consent.path}/start`, {
        method: 'POST', headers: { origin: built.issuer, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: consent.csrf, tenant: selection, approve: 'yes' }),
      })
      expect(denied.status).toBe(400)
      expect(JSDOM.fragment(await denied.text()).querySelector('[role="alert"]')?.textContent).toBe('Unable to connect. Check your workspace and try again.')
      expect(requests).toEqual([])
    }
    for (const selection of ['synthetic', new URL(workspaceOrigin).host]) {
      const consent = await built.consent()
      expect(consent.document).not.toContain(workspaceOrigin)
      expect(consent.contentSecurityPolicy).not.toContain(workspaceOrigin)
      const selected = await built.request(`${consent.path}/start`, {
        method: 'POST', headers: { origin: built.issuer, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: consent.csrf, tenant: selection, approve: 'yes' }),
      })
      expect(selected.status).toBe(200)
      expect(selected.headers.get('location')).toBeNull()
      expect(selected.headers.get('referrer-policy')).toBe('no-referrer')
      const handoff = JSDOM.fragment(await selected.text())
      const refresh = handoff.querySelector('meta[http-equiv="refresh"]')?.getAttribute('content')
      expect(refresh?.startsWith('0;url=')).toBe(true)
      const authorize = new URL(refresh!.slice('0;url='.length))
      expect(handoff.querySelector('a')?.getAttribute('href')).toBe(authorize.toString())
      expect(authorize.origin).toBe(workspaceOrigin)
      expect(authorize.pathname).toBe('/oauth/authorize')
      expect(authorize.searchParams.get('client_id')).toBe('gateway')
      expect(authorize.searchParams.get('redirect_uri')).toBe(`${built.issuer}/upstream/callback`)
      expect(authorize.searchParams.get('resource')).toBe(`${workspaceOrigin}/api/v1/mcp`)
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
      expect(authorize.searchParams.get('state')).toBeTruthy()
      const replay = await built.request(`${consent.path}/start`, {
        method: 'POST', headers: { origin: built.issuer, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: consent.csrf, tenant: selection, approve: 'yes' }),
      })
      expect(replay.status).toBe(403)
      await replay.body?.cancel()
    }
    expect(requests).toEqual(Array(2).fill(['/.well-known/oauth-protected-resource/api/v1/mcp/readonly', '/.well-known/oauth-authorization-server']).flat())
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

  it('lets a native client pick its loopback port and holds web clients to the exact redirect', async () => {
    // Claude Code and Codex receive the code on a port they choose per sign-in (RFC 8252 section 7.3).
    const native = await fixture({ applicationType: 'native', redirectUri: 'http://localhost/callback' })
    for (const port of [53682, 61234]) {
      const accepted = await native.authorize({ redirect_uri: `http://localhost:${port}/callback` })
      expect(accepted.status).toBe(303)
      expect(new URL(accepted.headers.get('location')!, native.issuer).pathname).toMatch(/^\/interaction\/[^/]+$/)
    }
    for (const redirect of ['http://localhost:53682/other', 'http://127.0.0.1:53682/callback', 'https://localhost:53682/callback']) {
      const refused = await native.authorize({ redirect_uri: redirect })
      expect(refused.status).toBe(400)
      expect(refused.headers.get('location')).toBeNull()
    }
    const web = await fixture()
    const refused = await web.authorize({ redirect_uri: 'http://127.0.0.1:47002/callback' })
    expect(refused.status).toBe(400)
    expect(refused.headers.get('location')).toBeNull()
  })

  it('lets one client start sign-in from a hosted app and from a CLI that requests every advertised scope', async () => {
    // ChatGPT and Codex share the plugin's client ID. ChatGPT returns to an exact
    // HTTPS redirect; Codex picks a loopback port per sign-in, sends no prompt,
    // and requests every scope the authorization server metadata advertises.
    const hosted = 'https://chatgpt.com/connector_platform_oauth_redirect'
    const shared = await fixture({ applicationType: 'native', redirectUri: hosted, extraRedirectUris: ['http://127.0.0.1/callback'] })
    const metadata = await shared.request('/.well-known/oauth-authorization-server')
    const { scopes_supported: advertised } = await metadata.json() as { scopes_supported: string[] }
    expect(advertised).toEqual(['read', 'offline_access'])
    const requests: Record<string, string | null>[] = [
      { redirect_uri: hosted },
      { redirect_uri: 'http://127.0.0.1:53682/callback', scope: advertised.join(' '), prompt: null },
      { redirect_uri: 'http://127.0.0.1:61234/callback', scope: advertised.join(' '), prompt: null },
    ]
    for (const request of requests) {
      const accepted = await shared.authorize(request)
      expect(accepted.status).toBe(303)
      expect(new URL(accepted.headers.get('location')!, shared.issuer).pathname).toMatch(/^\/interaction\/[^/]+$/)
    }
    for (const redirect of [`${hosted}/other`, 'http://localhost:53682/callback']) {
      const refused = await shared.authorize({ redirect_uri: redirect })
      expect(refused.status).toBe(400)
      expect(refused.headers.get('location')).toBeNull()
    }
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
