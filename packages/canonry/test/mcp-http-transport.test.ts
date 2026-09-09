import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createClient, migrate, apiKeys, oauthClients, users, type DatabaseClient } from '@ainyc/canonry-db'
import { createUserSession, USER_SESSION_COOKIE_NAME } from '@ainyc/canonry-api-routes'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CanonryConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'

/**
 * MCP over Streamable HTTP. The properties worth pinning are the ones the
 * stdio adapter got for free and this transport does not: that the endpoint is
 * authenticated at all, that a read-only key is not refused by the method-based
 * write gate, and that a session belongs to the credential that opened it.
 */

/** Same shape as app.inject, but over the live listener. */
interface InjectLike {
  statusCode: number
  headers: Record<string, string>
  body: string
  json: <T = Record<string, unknown>>() => T
}

async function request(
  built: { origin: string },
  opts: { method: string; url: string; headers?: Record<string, string>; payload?: unknown },
): Promise<InjectLike> {
  const isForm = opts.headers?.['content-type']?.includes('x-www-form-urlencoded')
  // `inject` infers a JSON content-type from an object payload; fetch does not,
  // and Fastify cannot parse a body without one. Default it explicitly.
  const headers = { ...opts.headers }
  if (opts.payload !== undefined && typeof opts.payload === 'object' && !headers['content-type']) {
    headers['content-type'] = 'application/json'
  }
  const res = await fetch(`${built.origin}${opts.url}`, {
    method: opts.method,
    headers,
    body: opts.payload === undefined
      ? undefined
      : (isForm || typeof opts.payload === 'string' ? String(opts.payload) : JSON.stringify(opts.payload)),
    redirect: 'manual',
  })
  const body = await res.text()
  return {
    statusCode: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body,
    json: <T,>() => JSON.parse(body) as T,
  }
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
}
const MCP_ACCEPT = 'application/json, text/event-stream'


const PKCE_VERIFIER = 'v'.repeat(64)

/** Drive the real authorize + token flow end to end, as a client would. */
async function mintAccessToken(
  built: Built,
  opts: { role?: 'admin' | 'viewer'; scope?: string } = {},
): Promise<string> {
  const challenge = crypto.createHash('sha256').update(PKCE_VERIFIER).digest('base64url')
  const redirectUri = 'https://client.example.com/cb'
  built.registerClient(redirectUri)
  const sessionCookie = built.signIn(opts.role ?? 'viewer')

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: 'test-client',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: opts.scope ?? 'read',
  })
  // The GET now renders an approval page rather than minting a code: a session
  // is authentication, not consent. Approving is a separate POST carrying a
  // CSRF token bound to this person and these exact parameters.
  const consent = await request(built, {
    method: 'GET',
    url: `/oauth/authorize?${params.toString()}`,
    headers: { cookie: sessionCookie },
  })
  const csrf = /name="csrf" value="([^"]+)"/.exec(consent.body)?.[1]
  if (!csrf) throw new Error(`no consent form returned: ${consent.statusCode} ${consent.body.slice(0, 120)}`)
  const approved = await request(built, {
    method: 'POST',
    url: `/oauth/authorize/consent?${params.toString()}`,
    headers: { cookie: sessionCookie, 'content-type': 'application/x-www-form-urlencoded', origin: built.origin },
    payload: new URLSearchParams({ csrf, approve: 'yes' }).toString(),
  })
  const code = new URL(approved.headers.location as string).searchParams.get('code')!
  const token = await request(built, {
    method: 'POST',
    url: '/oauth/token',
    payload: {
      grant_type: 'authorization_code',
      code,
      code_verifier: PKCE_VERIFIER,
      client_id: 'test-client',
      redirect_uri: redirectUri,
    },
  })
  return token.json().access_token as string
}

interface Built {
  /** Base URL of the live test listener. */
  origin: string
  app: Awaited<ReturnType<typeof createServer>>
  wildcardKey: string
  readOnlyKey: string
  /** Register a pre-registered OAuth client; there is no DCR by design. */
  registerClient: (redirectUri: string) => void
  /** Create a real signed-in session and return its cookie header. */
  signIn: (role?: 'admin' | 'viewer') => string
  /** Ephemeral per-session api keys, for asserting they are cleaned up. */
  sessionKeys: () => { scopes: string[]; revokedAt: string | null }[]
  cleanup: () => Promise<void>
}

async function buildServer(): Promise<Built> {
  const tmpDir = path.join(os.tmpdir(), `canonry-mcp-http-${crypto.randomUUID()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const dbPath = path.join(tmpDir, 'test.db')
  const db: DatabaseClient = createClient(dbPath)
  migrate(db)

  const wildcardKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  const readOnlyKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  for (const [raw, scopes, name] of [[wildcardKey, ['*'], 'root'], [readOnlyKey, ['read'], 'reader']] as const) {
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name,
      keyHash: crypto.createHash('sha256').update(raw).digest('hex'),
      keyPrefix: raw.slice(0, 9),
      scopes: [...scopes],
      createdAt: new Date().toISOString(),
    }).run()
  }

  const config: CanonryConfig = {
    apiUrl: 'http://127.0.0.1:4100',
    database: dbPath,
    apiKey: wildcardKey,
    publicUrl: 'https://instance.example.com',
    providers: {},
  }
  const app = await createServer({ config, db, logger: false })
  // A REAL listener, not app.inject().
  //
  // The MCP transport hands the request to @hono/node-server, which arms a
  // response timeout and force-closes the socket when it fires. light-my-request
  // fakes the socket with an EventEmitter that has no destroySoon, so every
  // injected request raised an unhandled TypeError after the test finished —
  // enough to fail the run with every assertion green.
  //
  // Binding a port is also the more faithful test: this transport streams and
  // holds sessions across requests, which is precisely what an injection
  // harness models least well.
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const origin = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
  return {
    app,
    origin,
    wildcardKey,
    readOnlyKey,
    sessionKeys: () => db.select().from(apiKeys).all()
      .filter(k => k.name.startsWith('mcp-session:'))
      .map(k => ({ scopes: k.scopes, revokedAt: k.revokedAt })),
    registerClient: (redirectUri: string) => {
      db.insert(oauthClients).values({
        id: 'test-client',
        name: 'Test client',
        secretHash: null,
        redirectUris: [redirectUri],
        createdAt: new Date().toISOString(),
      }).run()
    },
    signIn: (role: 'admin' | 'viewer' = 'viewer') => {
      const userId = crypto.randomUUID()
      db.insert(users).values({
        id: userId, name: `u-${userId.slice(0, 8)}`, nameKey: `u-${userId.slice(0, 8)}`,
        passwordHash: 'x', role,
        createdAt: new Date().toISOString(),
      }).run()
      const token = createUserSession(db, userId)
      return `${USER_SESSION_COOKIE_NAME}=${token}`
    },
    cleanup: async () => {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

function initRequest(built: Built, key: string) {
  return request(built, {
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { authorization: `Bearer ${key}`, accept: MCP_ACCEPT, 'content-type': 'application/json' },
    payload: INIT,
  })
}

describe('MCP over OAuth', () => {
  let built: Built

  beforeEach(async () => {
    built = await buildServer()
  })

  afterEach(async () => {
    await built.cleanup()
  })

  it('challenges an unauthenticated caller with its discovery document', async () => {
    // RFC 9728 s5.1. This header is the entire entry point: a client holding no
    // credential learns from it where the authorization server lives. Without
    // it there is nothing to discover and the connector simply fails.
    const res = await request(built, {
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { accept: MCP_ACCEPT, 'content-type': 'application/json' },
      payload: INIT,
    })
    expect(res.statusCode).toBe(401)
    const challenge = res.headers['www-authenticate'] as string
    expect(challenge).toContain('Bearer')
    expect(challenge).toContain('/.well-known/oauth-protected-resource/api/v1/mcp')
  })

  it('serves the protected-resource document the challenge points at', async () => {
    const res = await request(built, { method: 'GET', url: '/.well-known/oauth-protected-resource/api/v1/mcp' })
    expect(res.statusCode).toBe(200)
    expect(res.json().authorization_servers).toEqual(['https://instance.example.com'])
  })

  it('accepts an OAuth access token as a bearer on the MCP endpoint', async () => {
    // The link that makes the whole chain work: a hosted client cannot present
    // an api key, so if this fails OAuth is decorative.
    const token = await mintAccessToken(built)
    const res = await request(built, {
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${token}`, accept: MCP_ACCEPT, 'content-type': 'application/json' },
      payload: INIT,
    })
    expect(res.statusCode).toBeLessThan(400)
    expect(res.headers['mcp-session-id']).toBeTruthy()
  })

  it('a read-scoped token from an ADMIN cannot mint an api key', async () => {
    // The escalation this closes. The token used to carry the person's ROLE
    // scopes and was accepted on every REST route, so an admin approving a
    // `scope=read` connector handed it full admin — enough to mint a root
    // cnry_* key through POST /api/v1/keys and keep it after revocation.
    const token = await mintAccessToken(built, { role: 'admin', scope: 'read' })
    const res = await request(built, {
      method: 'POST',
      url: '/api/v1/keys',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { name: 'pwned' },
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('an OAuth token is refused on every route except the MCP transport', async () => {
    // Confinement, checked independently of scope: the token is minted for the
    // MCP resource and must not authenticate the wider REST surface at all.
    const token = await mintAccessToken(built, { role: 'admin', scope: 'read' })
    const rest = await request(built, {
      method: 'GET',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(rest.statusCode).toBe(401)

    const mcp = await request(built, {
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${token}`, accept: MCP_ACCEPT, 'content-type': 'application/json' },
      payload: INIT,
    })
    expect(mcp.statusCode).toBeLessThan(400)
  })

  it('mints an ephemeral key for an OAuth session and REVOKES it on close', async () => {
    // Two defects in one test. The tool call re-enters over HTTP, where an
    // OAuth token is deliberately refused, so without a session-scoped api key
    // every tool call fails while initialize and tools/list look healthy.
    // And a client-initiated DELETE closes the transport directly, bypassing
    // the close() path — so revoking only there leaked a live credential on
    // every well-behaved client that ended its own session.
    const token = await mintAccessToken(built)
    const init = await request(built, {
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${token}`, accept: MCP_ACCEPT, 'content-type': 'application/json' },
      payload: INIT,
    })
    const sessionId = init.headers['mcp-session-id']!

    const live = built.sessionKeys()
    expect(live.length).toBe(1)
    expect(live[0]!.revokedAt).toBeNull()
    // Exactly the authority already resolved for the caller, never more.
    expect(live[0]!.scopes).toEqual(['read'])

    await request(built, {
      method: 'DELETE',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${token}`, accept: MCP_ACCEPT, 'mcp-session-id': sessionId },
    })

    const after = built.sessionKeys()
    expect(after[0]!.revokedAt).not.toBeNull()
  })

  it('an operator can list clients and revoking one kills its live tokens', async () => {
    // Before this existed, nothing in production ever set revoked_at: a client
    // was permanent once registered and a grant could not be withdrawn without
    // editing the database by hand.
    const token = await mintAccessToken(built)
    const adminKey = built.wildcardKey

    const listed = await request(built, {
      method: 'GET', url: '/api/v1/oauth/clients',
      headers: { authorization: `Bearer ${adminKey}` },
    })
    expect(listed.statusCode).toBe(200)
    const clients = listed.json<{ clients: { id: string; activeGrants: number; registration: string }[] }>().clients
    const mine = clients.find(c => c.id === 'test-client')
    expect(mine?.activeGrants).toBe(1)
    expect(mine?.registration).toBe('operator')

    // The token works right up until revocation.
    const before = await request(built, {
      method: 'POST', url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${token}`, accept: MCP_ACCEPT, 'content-type': 'application/json' },
      payload: INIT,
    })
    expect(before.statusCode).toBeLessThan(400)

    const revoked = await request(built, {
      method: 'DELETE', url: '/api/v1/oauth/clients/test-client',
      headers: { authorization: `Bearer ${adminKey}` },
    })
    expect(revoked.statusCode).toBe(200)

    // Revoking the client must kill its outstanding tokens too — marking only
    // the client would leave live access tokens working until they expired.
    const after = await request(built, {
      method: 'POST', url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${token}`, accept: MCP_ACCEPT, 'content-type': 'application/json' },
      payload: INIT,
    })
    expect(after.statusCode).toBe(401)
  })

  it('refuses a wildcard scope rather than granting it', async () => {
    // `*` used to be stored verbatim and, for an admin, became the effective
    // scope — a client-controlled path to the full write catalog.
    const cookie = built.signIn('admin')
    built.registerClient('https://client.example.com/cb')
    const params = new URLSearchParams({
      response_type: 'code', client_id: 'test-client',
      redirect_uri: 'https://client.example.com/cb',
      code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', scope: '*',
    })
    const res = await request(built, {
      method: 'GET', url: `/oauth/authorize?${params.toString()}`, headers: { cookie },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toBe('invalid_scope')
  })

  it('refuses a revoked OAuth token', async () => {
    const token = await mintAccessToken(built)
    await request(built, { method: 'POST', url: '/oauth/revoke', payload: { token } })
    const res = await request(built, {
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${token}`, accept: MCP_ACCEPT, 'content-type': 'application/json' },
      payload: INIT,
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('MCP over Streamable HTTP', () => {
  let built: Built

  beforeEach(async () => {
    built = await buildServer()
  })

  afterEach(async () => {
    await built.cleanup()
  })

  it('refuses an unauthenticated caller', async () => {
    // The whole reason this mounts inside the api-routes scope. A route on the
    // root app has no auth hook and would answer this 200.
    const res = await request(built, {
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { accept: MCP_ACCEPT, 'content-type': 'application/json' },
      payload: INIT,
    })
    expect(res.statusCode).toBe(401)
  })

  it('admits a READ-ONLY key through the write-method gate', async () => {
    // The positive case for `transportEnvelope`. Without it the global
    // read-only gate 403s this POST before the handler ever runs, and a
    // read-only credential is useless to a hosted client.
    const res = await initRequest(built, built.readOnlyKey)
    expect(res.statusCode).not.toBe(403)
    expect(res.statusCode).toBeLessThan(400)
  })

  it('issues a session id on initialize and accepts it on a follow-up', async () => {
    const first = await initRequest(built, built.readOnlyKey)
    const sessionId = first.headers['mcp-session-id']
    expect(typeof sessionId).toBe('string')

    const second = await request(built, {
      method: 'POST',
      url: '/api/v1/mcp',
      headers: {
        authorization: `Bearer ${built.readOnlyKey}`,
        accept: MCP_ACCEPT,
        'content-type': 'application/json',
        'mcp-session-id': sessionId as string,
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    })
    expect(second.statusCode).toBeLessThan(400)
  })

  it('refuses a session id belonging to a different credential', async () => {
    // A session is pinned to the key that opened it. Without this, a leaked
    // session id would let any authenticated caller ride another caller's
    // server — and inherit its tool scope, which is the escalation that
    // matters: a read-only caller reusing a wildcard session.
    const first = await initRequest(built, built.wildcardKey)
    const sessionId = first.headers['mcp-session-id'] as string
    expect(typeof sessionId).toBe('string')

    const stolen = await request(built, {
      method: 'POST',
      url: '/api/v1/mcp',
      headers: {
        authorization: `Bearer ${built.readOnlyKey}`,
        accept: MCP_ACCEPT,
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    })
    expect(stolen.statusCode).toBe(404)
  })

  async function toolsFor(url: string, key: string): Promise<string[]> {
    const init = await request(built, {
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${key}`, accept: MCP_ACCEPT, 'content-type': 'application/json' },
      payload: INIT,
    })
    const sessionId = init.headers['mcp-session-id'] as string
    const res = await request(built, {
      method: 'POST',
      url,
      headers: {
        authorization: `Bearer ${key}`,
        accept: MCP_ACCEPT,
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    })
    // Streamable HTTP answers a POST as SSE, so the JSON-RPC body arrives as a
    // `data:` frame rather than a bare payload.
    const frame = res.body.split('\n').find(line => line.startsWith('data:'))
    const parsed = JSON.parse((frame ?? res.body).replace(/^data:\s*/, '')) as {
      result?: { tools?: { name: string }[] }
    }
    return (parsed.result?.tools ?? []).map(tool => tool.name)
  }

  it.each([
    ['/api/v1/mcp', false], ['/api/v1/mcp', true],
    ['/api/v1/mcp/readonly', false], ['/api/v1/mcp/readonly', true],
  ] as const)('exposes the entire permitted catalog at %s (read-only key: %s)', async (url, readOnlyKey) => {
    const tools = await toolsFor(url, readOnlyKey ? built.readOnlyKey : built.wildcardKey)
    const readOnly = readOnlyKey || url.endsWith('/readonly')
    const expected = canonryMcpTools.filter(tool => !readOnly || tool.access === 'read').map(tool => tool.name)
    expect(tools).toEqual([...expected, 'canonry_help'])
    expect(tools).toEqual(expect.arrayContaining([
      'canonry_project_overview', 'canonry_visibility_report',
      'canonry_measurement_overview', 'canonry_measurement_property_evidence',
      'canonry_measurement_portfolio_summary', 'canonry_measurement_property_questions',
      'canonry_measurement_question_result', 'canonry_measurement_property_competitors',
      'canonry_measurement_changes', 'canonry_measurement_data_quality',
      'canonry_gsc_performance', 'canonry_ga_status', 'canonry_gbp_accounts',
      'canonry_ads_status', 'canonry_traffic_sources_list', 'canonry_memory_list',
      'canonry_research_runs_list', 'canonry_measurement_setup',
      'canonry_google_ads_status', 'canonry_gtm_status', 'canonry_conversion_tracking_contracts',
    ]))
    expect(tools).not.toContain('canonry_load_toolkit')
  })

  it('exposes the entire read catalog to an OAuth reader without write tools', async () => {
    const token = await mintAccessToken(built, { role: 'admin', scope: 'read' })
    const tools = await toolsFor('/api/v1/mcp', token)
    const expected = canonryMcpTools.filter(tool => tool.access === 'read').map(tool => tool.name)
    expect(tools).toEqual([...expected, 'canonry_help'])
  })

  it('a /readonly endpoint narrows even a WILDCARD key', async () => {
    // The safety property that makes a /readonly URL a guarantee rather than a
    // naming convention: the path forces the read-only catalog regardless of
    // how much authority the presented key carries.
    const full = await toolsFor('/api/v1/mcp', built.wildcardKey)
    const readOnly = await toolsFor('/api/v1/mcp/readonly', built.wildcardKey)
    expect(readOnly.length).toBeLessThan(full.length)
    for (const name of readOnly) expect(full).toContain(name)
  })

  it('a toolkit endpoint adds that toolkit on top of core', async () => {
    const core = canonryMcpTools.filter(tool => tool.tier === 'core').map(tool => tool.name)
    const withToolkit = await toolsFor('/api/v1/mcp/x/gsc', built.wildcardKey)
    expect(withToolkit.length).toBeGreaterThan(core.length)
    // core rides along, or the toolkit's tools have no project to aim at
    for (const name of core) expect(withToolkit).toContain(name)
    expect(withToolkit).toContain('canonry_gsc_performance')
    expect(withToolkit).not.toContain('canonry_measurement_portfolio_summary')
  })

  it('refuses a session opened on a different segment', async () => {
    // A session id is bound to the endpoint that minted it. Without this, a
    // session opened on a wide segment could be replayed against a narrow URL
    // — or worse, a /readonly session id reused to reach a writable surface.
    const init = await request(built, {
      method: 'POST',
      url: '/api/v1/mcp/x/gsc',
      headers: { authorization: `Bearer ${built.wildcardKey}`, accept: MCP_ACCEPT, 'content-type': 'application/json' },
      payload: INIT,
    })
    const sessionId = init.headers['mcp-session-id'] as string
    expect(typeof sessionId).toBe('string')

    const replayed = await request(built, {
      method: 'POST',
      url: '/api/v1/mcp/readonly',
      headers: {
        authorization: `Bearer ${built.wildcardKey}`,
        accept: MCP_ACCEPT,
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    })
    expect(replayed.statusCode).toBe(404)
  })

  it('404s an unknown session id rather than silently opening a new one', async () => {
    // A client whose session was reaped must be told to re-initialize.
    const res = await request(built, {
      method: 'POST',
      url: '/api/v1/mcp',
      headers: {
        authorization: `Bearer ${built.readOnlyKey}`,
        accept: MCP_ACCEPT,
        'content-type': 'application/json',
        'mcp-session-id': crypto.randomUUID(),
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    })
    expect(res.statusCode).toBe(404)
  })
})
