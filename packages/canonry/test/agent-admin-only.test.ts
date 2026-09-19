/**
 * Aero is an administrator tool.
 *
 * The dashboard bar is one gate, but it is presentation: a signed-in viewer
 * holds a session cookie and can call the same endpoints straight from a
 * console. These tests hold the REAL boundary — the routes themselves.
 *
 * There is exactly ONE Aero session per project, so an ungated transcript read
 * is not a leak of metadata about a conversation, it is a leak of the
 * operator's conversation.
 *
 * Two layers, because they fail for different reasons:
 *
 *   1. Each route refuses a viewer ON ITS OWN, tested against a bare Fastify
 *      scope with the principal injected directly. The shared auth plugin
 *      already refuses a viewer on write METHODS, so a full-server test of
 *      POST/PUT/DELETE passes whether or not this route carries a gate — it
 *      would go green on a prompt endpoint that had none. Bypassing the
 *      method gate is what makes the route's own boundary observable.
 *
 *   2. A real signed-in viewer is refused end to end, through `createServer`,
 *      with the production auth plugin and a real cookie — in both viewer
 *      research configurations, since that deployment flag changes which
 *      generic gate fires first and must not change the answer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { createClient, migrate, projects, users, type DatabaseClient } from '@ainyc/canonry-db'
import { AppError } from '@ainyc/canonry-contracts'
import { hashUserPassword, type AuthPrincipal } from '@ainyc/canonry-api-routes'
import { createServer } from '../src/server.js'
import { registerAgentRoutes } from '../src/agent/agent-routes.js'
import { SessionRegistry } from '../src/agent/session-registry.js'
import type { ApiClient } from '../src/client.js'
import type { CanonryConfig } from '../src/config.js'

const ORIGIN = 'http://localhost:4100'
const HOST = 'localhost:4100'
const ADMIN_PASSWORD = 'a-long-enough-admin-password'
const VIEWER_PASSWORD = 'a-long-enough-viewer-password'

/**
 * Mirrors `ADMIN_ONLY_MESSAGE` in api-routes. Asserted rather than imported so
 * the refusal a viewer actually reads is pinned here: a generic "you cannot
 * make this change" would mean some OTHER gate answered, which says nothing
 * about whether Aero itself is administrator-only.
 */
const ADMIN_ONLY = 'Only an administrator account can use this.'

/**
 * Every route `registerAgentRoutes` mounts. Payloads are empty on purpose: for
 * a caller who passes the gate, the mutating routes stop at a 400 validation
 * error before any LLM turn runs, so these tests never spend a provider call.
 */
const AGENT_ROUTES: ReadonlyArray<readonly [string, string, unknown?]> = [
  ['GET', '/projects/acme/agent/transcript'],
  ['GET', '/projects/acme/agent/providers'],
  ['GET', '/projects/acme/agent/memory'],
  ['DELETE', '/projects/acme/agent/transcript'],
  ['POST', '/projects/acme/agent/prompt', { prompt: '' }],
  ['PUT', '/projects/acme/agent/memory', {}],
  ['DELETE', '/projects/acme/agent/memory', {}],
] as const

/** The reads that were wide open before this gate existed. */
const AGENT_READS = AGENT_ROUTES.filter(([method]) => method === 'GET')

const labelled = (routes: typeof AGENT_ROUTES) =>
  routes.map(route => [`${route[0]} ${route[1]}`, route] as const)

// ──────────────────────────────────────────────────────────────────
// Layer 1 — each route, with the principal injected directly.
// ──────────────────────────────────────────────────────────────────

function stubClient(): ApiClient {
  return {} as unknown as ApiClient
}

function stubConfig(): CanonryConfig {
  return {
    apiUrl: ORIGIN,
    database: ':memory:',
    apiKey: 'cnry_test',
    providers: { claude: { apiKey: 'anthropic-key' } },
  } as CanonryConfig
}

function principalFor(role: 'admin' | 'viewer'): AuthPrincipal {
  return {
    kind: 'user',
    id: `${role}-user`,
    name: role,
    // What `scopesForRole` hands a signed-in person of this role.
    scopes: role === 'admin' ? ['*'] : ['read'],
    projectId: null,
    role,
    viaCookie: true,
  }
}

describe('every Aero route carries the administrator gate itself', () => {
  let tmpDir: string
  let db: DatabaseClient
  let app: FastifyInstance
  let principal: AuthPrincipal | undefined

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-admin-route-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'proj_acme',
      name: 'acme',
      displayName: 'acme',
      canonicalDomain: 'acme.example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()

    app = Fastify()
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: error.message } })
    })
    // Stand in for the auth plugin, WITHOUT its method-based write gate, so
    // each route has to refuse the viewer by itself.
    app.addHook('onRequest', async (request) => {
      request.principal = principal
    })
    registerAgentRoutes(app, {
      db,
      sessionRegistry: new SessionRegistry({ db, client: stubClient(), config: stubConfig() }),
    })
    await app.ready()
  })

  afterEach(async () => {
    principal = undefined
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function call(route: readonly [string, string, unknown?]) {
    const [method, url, payload] = route
    return app.inject({
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      url,
      ...(payload !== undefined ? { payload } : {}),
    })
  }

  it.each(labelled(AGENT_ROUTES))('refuses a viewer on %s', async (_label, route) => {
    principal = principalFor('viewer')
    const res = await call(route)

    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: { message: string } }).error.message).toBe(ADMIN_ONLY)
  })

  it.each(labelled(AGENT_ROUTES))('serves an administrator on %s', async (_label, route) => {
    principal = principalFor('admin')
    // 400 is the empty-payload validation error on the mutating routes; the
    // point is only that the role gate did not fire.
    expect((await call(route)).statusCode).not.toBe(403)
  })

  it.each(labelled(AGENT_ROUTES))('serves an install-key caller on %s', async (_label, route) => {
    // No role at all — the install root key the CLI and MCP present. Aero has
    // always been theirs to drive, and this gate must not change that.
    principal = {
      kind: 'api-key',
      id: 'root',
      name: 'root',
      scopes: ['*'],
      projectId: null,
      viaCookie: false,
    }
    expect((await call(route)).statusCode).not.toBe(403)
  })

  it('refuses a viewer before it looks the project up', async () => {
    principal = principalFor('viewer')
    // A project that does not exist. A 404 here would mean the refusal can be
    // used to probe which projects an install has.
    const res = await call(['GET', '/projects/does-not-exist/agent/transcript'])

    expect(res.statusCode).toBe(403)
  })
})

// ──────────────────────────────────────────────────────────────────
// Layer 2 — a real signed-in viewer, end to end.
// ──────────────────────────────────────────────────────────────────

describe.each([
  ['viewer research off', false],
  ['viewer research on', true],
])('a signed-in viewer on a real server (%s)', (_label, allowViewers) => {
  let tmpDir: string
  let db: DatabaseClient
  let app: Awaited<ReturnType<typeof createServer>>
  let apiKey: string

  async function addAccount(name: string, role: 'admin' | 'viewer', password: string): Promise<void> {
    db.insert(users).values({
      id: crypto.randomUUID(),
      name,
      nameKey: name.toLowerCase(),
      passwordHash: await hashUserPassword(password),
      role,
      createdAt: new Date().toISOString(),
    }).run()
  }

  async function signIn(name: string, password: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN, host: HOST },
      payload: { name, password },
    })
    expect(res.statusCode).toBe(200)
    return res.cookies.map(({ name: n, value }) => `${n}=${value}`).join('; ')
  }

  function callAsSession(cookie: string, route: readonly [string, string, unknown?]) {
    const [method, url, payload] = route
    return app.inject({
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: `/api/v1${url}`,
      // origin + host satisfy the same-origin write gate, so a refusal here is
      // always a role decision and never CSRF protection standing in for one.
      headers: { cookie, origin: ORIGIN, host: HOST },
      ...(payload !== undefined ? { payload } : {}),
    })
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-admin-server-'))
    const dbPath = path.join(tmpDir, 'test.db')
    db = createClient(dbPath)
    migrate(db)
    apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    app = await createServer({
      config: {
        apiUrl: ORIGIN,
        database: dbPath,
        apiKey,
        providers: {},
        research: { allowViewers },
      } as CanonryConfig,
      db,
      logger: false,
    })

    const seeded = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/acme',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { displayName: 'acme', canonicalDomain: 'acme.example.com', country: 'US', language: 'en' },
    })
    expect(seeded.statusCode).toBe(201)

    await addAccount('owner', 'admin', ADMIN_PASSWORD)
    await addAccount('analyst', 'viewer', VIEWER_PASSWORD)
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it.each(labelled(AGENT_ROUTES))('is refused on %s', async (_label, route) => {
    const res = await callAsSession(await signIn('analyst', VIEWER_PASSWORD), route)

    expect(res.statusCode).toBe(403)
  })

  it.each(labelled(AGENT_READS))('is told it is an administrator surface on %s', async (_label, route) => {
    // The reads are the half that was open. A viewer must be refused here for
    // the stated reason, not by a gate that happens to catch write methods.
    const res = await callAsSession(await signIn('analyst', VIEWER_PASSWORD), route)

    expect((res.json() as { error: { message: string } }).error.message).toBe(ADMIN_ONLY)
  })

  it('cannot read the administrator conversation', async () => {
    const res = await callAsSession(
      await signIn('analyst', VIEWER_PASSWORD),
      ['GET', '/projects/acme/agent/transcript'],
    )

    expect(res.statusCode).toBe(403)
    expect(res.body).not.toContain('messages')
  })

  it.each(labelled(AGENT_ROUTES))('still serves an administrator on %s', async (_label, route) => {
    const res = await callAsSession(await signIn('owner', ADMIN_PASSWORD), route)

    expect(res.statusCode).not.toBe(403)
  })

  it('leaves the install root key working, so the CLI and MCP are unaffected', async () => {
    for (const [method, url, payload] of AGENT_ROUTES) {
      const res = await app.inject({
        method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
        url: `/api/v1${url}`,
        headers: { authorization: `Bearer ${apiKey}` },
        ...(payload !== undefined ? { payload } : {}),
      })
      expect(res.statusCode, `root key on ${method} ${url}`).not.toBe(403)
    }
  })
})
