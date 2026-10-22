import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { CookieJar, JSDOM } from 'jsdom'
import { expect, it, onTestFinished, vi } from 'vitest'
import { hashUserPassword, USER_SESSION_COOKIE_NAME } from '@canonry/canonry-api-routes'
import { canonicalMeasurementPlanV2Json } from '@canonry/canonry-contracts'
import { apiKeys, createClient, measurementPlans, measurementPlanVersions, migrate, projects, users } from '@canonry/canonry-db'
import { measurementPlanV2Fixture } from '../../api-routes/test/measurement-plan-v2-fixture.js'
import { createServer } from '../src/server.js'

const PASSWORD = 'hosted-onboarding-fixture-password'
const REDIRECT = 'https://client.example/callback'
const VERIFIER = 'v'.repeat(64)
const MCP_HEADERS = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
const INITIALIZE = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hosted-onboarding-test', version: '1' } },
}

interface OAuthMetadata {
  issuer: string
  authorization_endpoint: string
  registration_endpoint: string
  token_endpoint: string
  revocation_endpoint: string
}

interface RpcResponse {
  result?: { isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }
}

async function rpcBody(response: Response): Promise<RpcResponse> {
  const text = await response.text()
  expect(response.status, text).toBe(200)
  const frame = text.split('\n').find(line => line.startsWith('data:'))
  return JSON.parse(frame ? frame.slice(5).trim() : text) as RpcResponse
}

/** Real browser cookie semantics, including Path, without following the client's external callback. */
function browserSession() {
  const jar = new CookieJar()
  return {
    jar,
    async request(url: string, fields?: Record<string, string>) {
      const headers = new Headers()
      const cookies = await jar.getCookieString(url)
      if (cookies) headers.set('cookie', cookies)
      if (fields) {
        headers.set('content-type', 'application/x-www-form-urlencoded')
        headers.set('origin', new URL(url).origin)
      }
      const response = await fetch(url, {
        method: fields ? 'POST' : 'GET', headers, redirect: 'manual',
        ...(fields ? { body: new URLSearchParams(fields).toString() } : {}),
      })
      for (const cookie of response.headers.getSetCookie()) await jar.setCookie(cookie, url)
      return response
    },
  }
}

async function buildHost(basePath: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-hosted-onboarding-'))
  const database = path.join(directory, 'test.db')
  const db = createClient(database)
  let app: Awaited<ReturnType<typeof createServer>> | undefined = undefined
  onTestFinished(async () => {
    try {
      await app?.close()
    } finally {
      db.$client.close()
      vi.unstubAllEnvs()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
  vi.stubEnv('CANONRY_CONFIG_DIR', directory)
  vi.stubEnv('CANONRY_BASE_PATH', undefined)
  vi.stubEnv('CANONRY_AGENT_DISABLED', '1')
  vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1')
  migrate(db)
  const now = new Date().toISOString()
  const rootKey = 'cnry_hosted_onboarding_fixture'
  db.insert(apiKeys).values({ id: 'root', name: 'fixture', keyHash: crypto.createHash('sha256').update(rootKey).digest('hex'),
    keyPrefix: rootKey.slice(0, 9), scopes: ['*'], createdAt: now }).run()
  db.insert(users).values({ id: 'owner', name: 'Owner', nameKey: 'owner', role: 'admin',
    passwordHash: await hashUserPassword(PASSWORD), createdAt: now }).run()
  for (const [name, displayName, domain] of [
    ['simple', 'Simple portfolio', 'simple.example'], ['advanced', 'Northstar', 'northstar.example'],
  ] as const) {
    db.insert(projects).values({ id: name, name, displayName, canonicalDomain: domain,
      country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  }
  const plan = measurementPlanV2Fixture()
  db.insert(measurementPlanVersions).values({ id: 'advanced-version', projectId: 'advanced', revision: 3,
    canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'a'.repeat(64), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, createdAt: now }).run()
  db.insert(measurementPlans).values({ projectId: 'advanced', activeVersionId: 'advanced-version',
    createdAt: now, updatedAt: now }).run()

  // The transport's inner REST hop needs the real listener address at construction.
  // Reserve an ephemeral port, as the scheduled-sync server boundary suite does.
  const reservation = net.createServer()
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP address')
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const origin = `http://127.0.0.1:${address.port}`
  app = await createServer({
    db, logger: false,
    config: { apiUrl: `${origin}${basePath}`, publicUrl: `${origin}${basePath}`, basePath,
      database, apiKey: rootKey, providers: {} },
  })
  await app.listen({ host: '127.0.0.1', port: address.port })
  return { origin, mcpUrl: `${origin}${basePath}api/v1/mcp` }
}

// The transport suite seeds an already signed-in cookie. This owner follows
// discovery and signs in from scratch, so cookie-path and form wiring are real.
it.each(['/', '/canonry/'])('connects a hosted account through OAuth under %s and reads both portfolio types', async basePath => {
  const { origin, mcpUrl } = await buildHost(basePath)
  const challenge = await fetch(mcpUrl, { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify(INITIALIZE) })
  expect(challenge.status).toBe(401)
  await challenge.text()
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get('www-authenticate') ?? '')?.[1]
  expect(metadataUrl).toBe(`${origin}/.well-known/oauth-protected-resource${basePath}api/v1/mcp`)
  const resource = await (await fetch(metadataUrl!)).json() as { resource: string; authorization_servers: string[] }
  expect(resource).toMatchObject({ resource: mcpUrl, authorization_servers: [origin] })
  const metadata = await (await fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json() as OAuthMetadata
  expect(metadata).toMatchObject({ issuer: origin,
    registration_endpoint: `${origin}/oauth/register`, token_endpoint: `${origin}/oauth/token`, revocation_endpoint: `${origin}/oauth/revoke` })

  const registered = await fetch(metadata.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Hosted fixture client', redirect_uris: [REDIRECT] }) })
  expect(registered.status).toBe(201)
  const { client_id: clientId } = await registered.json() as { client_id: string }
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
    code_challenge: crypto.createHash('sha256').update(VERIFIER).digest('base64url'), code_challenge_method: 'S256',
    resource: mcpUrl, scope: 'read', state: 'hosted?return=portfolio' })
  const authorizeUrl = `${metadata.authorization_endpoint}?${query}`
  const browser = browserSession()

  const signedOut = await browser.request(authorizeUrl)
  expect(signedOut.status).toBe(200)
  const loginForm = JSDOM.fragment(await signedOut.text()).querySelector('form')!
  expect(loginForm.querySelector('input[name="password"]')).not.toBeNull()
  const loginUrl = new URL(loginForm.getAttribute('action')!, authorizeUrl).href
  const loggedIn = await browser.request(loginUrl, { name: 'Owner', password: PASSWORD })
  expect(loggedIn.status).toBe(302)
  const cookies = await browser.jar.getCookies(`${origin}${basePath}`)
  expect(cookies.find(cookie => cookie.key === USER_SESSION_COOKIE_NAME)?.path).toBe(basePath)
  if (basePath !== '/') {
    expect(await browser.jar.getCookieString(`${origin}/oauth/authorize`)).toBe('')
    expect(await browser.jar.getCookieString(`${origin}/another-tenant/`)).toBe('')
  }
  const consentUrl = new URL(loggedIn.headers.get('location')!, loginUrl).href
  const consent = await browser.request(consentUrl)
  expect(consent.status).toBe(200)
  expect(consent.headers.get('location')).toBeNull()
  const consentForm = JSDOM.fragment(await consent.text()).querySelector('form')!
  const csrf = consentForm.querySelector<HTMLInputElement>('input[name="csrf"]')?.value
  expect(csrf).toBeTruthy()
  const approved = await browser.request(new URL(consentForm.getAttribute('action')!, consentUrl).href, { csrf: csrf!, approve: 'yes' })
  expect(approved.status).toBe(302)
  const callback = new URL(approved.headers.get('location')!)
  expect(metadata.authorization_endpoint).toBe(`${origin}${basePath}oauth/authorize`)
  expect(callback.origin + callback.pathname).toBe(REDIRECT)
  expect(callback.searchParams.get('state')).toBe('hosted?return=portfolio')
  expect(callback.searchParams.get('iss')).toBe(origin)
  const code = callback.searchParams.get('code')
  expect(code).toBeTruthy()
  const exchanged = await fetch(metadata.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: code!, code_verifier: VERIFIER, client_id: clientId, redirect_uri: REDIRECT }) })
  expect(exchanged.status).toBe(200)
  const grant = await exchanged.json() as { access_token: string; scope: string }
  expect(grant.scope).toBe('read')
  if (basePath !== '/') {
    for (const [suffix, fields] of [
      ['', undefined], ['', { name: 'Owner', password: PASSWORD }], ['/consent', { csrf: 'legacy', approve: 'yes' }],
    ] as const) {
      const legacy = await browser.request(`${origin}/oauth/authorize${suffix}?${query}`, fields)
      expect(legacy.status).toBe(307)
      expect(new URL(legacy.headers.get('location')!, origin).href).toBe(`${metadata.authorization_endpoint}${suffix}?${query}`)
      await legacy.text()
    }
  }
  const headers = { ...MCP_HEADERS, authorization: `Bearer ${grant.access_token}` }
  const initialized = await fetch(mcpUrl, { method: 'POST', headers, body: JSON.stringify(INITIALIZE) })
  expect(initialized.status).toBe(200)
  const session = initialized.headers.get('mcp-session-id')
  expect(session).toBeTruthy()
  await initialized.text()
  let requestId = 2
  const call = (name: string, args: Record<string, unknown>) => fetch(mcpUrl, {
    method: 'POST', headers: { ...headers, 'mcp-session-id': session! },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId++, method: 'tools/call', params: { name, arguments: args } }),
  })
  // This fixture uses loopback HTTP: transport works, but hosted readiness must
  // remain unavailable in both public health and authenticated status reads.
  const expectedMcp = { status: 'available', hosted: { status: 'unavailable', reason: 'https-required' } }
  const health = await (await fetch(`${origin}${basePath}health`)).json()
  expect(health).toMatchObject({ mcp: expectedMcp })
  const status = await rpcBody(await call('canonry_status', {}))
  expect(status.result?.isError).not.toBe(true)
  expect(status.result?.structuredContent).toMatchObject({ mcp: expectedMcp, summary: { projects: 2 } })
  const simple = await rpcBody(await call('canonry_project_get', { project: 'simple' }))
  expect(simple.result?.isError).not.toBe(true)
  expect(simple.result?.structuredContent).toMatchObject({ name: 'simple', displayName: 'Simple portfolio', canonicalDomain: 'simple.example' })
  const advanced = await rpcBody(await call('canonry_measurement_plan_get', { project: 'advanced' }))
  expect(advanced.result?.isError).not.toBe(true)
  expect(advanced.result?.structuredContent).toMatchObject({ active: { revision: 3, plan: { schemaVersion: 2,
    targets: [{ stableKey: 'bayside', label: 'Bayside Homes' }, { stableKey: 'harbor', label: 'Harbor Homes' }],
    groups: [{ stableKey: 'regional', targetKeys: ['bayside', 'harbor'] }],
  } } })

  const restWrite = await fetch(`${origin}${basePath}api/v1/projects/simple`, { method: 'PATCH', headers,
    body: JSON.stringify({ displayName: 'Should not change' }) })
  expect(restWrite.status).toBe(401)
  await restWrite.text()
  const mcpWrite = await rpcBody(await call('canonry_project_update', { project: 'simple', request: { displayName: 'Should not change' } }))
  expect(mcpWrite.result).toMatchObject({ isError: true, content: [
    { type: 'text', text: expect.stringContaining('Tool canonry_project_update not found') },
  ] })
  const unchanged = await rpcBody(await call('canonry_project_get', { project: 'simple' }))
  expect(unchanged.result?.structuredContent).toMatchObject({ displayName: 'Simple portfolio' })
  const revoked = await fetch(metadata.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: grant.access_token }) })
  expect(revoked.status).toBe(200)
  await revoked.text()
  const afterRevocation = await call('canonry_project_get', { project: 'simple' })
  expect(afterRevocation.status).toBe(401)
  await afterRevocation.text()
})
