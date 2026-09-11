/**
 * T2-T7 — what changes once an install has accounts.
 *
 * The shape of every test here is the same: the SAME request, made three ways
 * (an admin who is signed in, a viewer who is signed in, and an API key), and
 * the three answers have to be the ones the feature promises. That is the only
 * way to show that adding sign-in did not quietly move the API key's ground.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  apiKeys,
  createClient,
  migrate,
  projects,
  queries,
  runs,
  users,
  userSessions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { USER_PASSWORD_MIN_LENGTH } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { hashSessionToken, UNKNOWN_ACCOUNT_DIGEST, USER_SESSION_COOKIE_NAME, USER_SESSION_TTL_MS } from '../src/user-session.js'
import { hashUserPassword, verifyUserPassword } from '../src/user-password.js'

/**
 * Every sign-in in this file pays a REAL scrypt derivation (N=32768,
 * `user-password.ts`), and the tests that exercise the per-caller budget
 * deliberately pay thirty of them in sequence, because thirty is where the
 * budget trips. Measured on an idle 12-core box: 111ms per derivation, and
 * 4.0-5.1s for the worst tests here — one of them already over vitest's 5000ms
 * default. On slower CI hardware they would fail outright, and the failure
 * would look like a hang rather than the arithmetic it is.
 *
 * The cost is the point: these tests assert that an expensive, unauthenticated
 * derivation is admitted under a budget and kept off the event loop, and a
 * cheaper hash would not exercise either property. The cost factor is also not
 * recorded in the stored digest (`scrypt$1$<salt>$<digest>`), so it is a global
 * invariant every stored password depends on — not something to make
 * environment-dependent for a faster suite.
 *
 * So: raise the ceiling for this file only. 30s still surfaces a real hang,
 * and every other suite keeps the 5s default.
 */
vi.setConfig({ testTimeout: 30_000 })

const ROOT_KEY = 'cnry_users_root'
const READ_KEY = 'cnry_users_read'
const ADMIN_PASSWORD = 'a-long-enough-admin-password'
const VIEWER_PASSWORD = 'a-long-enough-viewer-password'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let projectId: string
let trackedQueryIds: string[]

function seedKey(name: string, token: string, scopes: string[]) {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name,
    keyHash: hashApiKey(token),
    keyPrefix: token.slice(0, 9),
    scopes,
    createdAt: new Date().toISOString(),
  }).run()
}

function withKey(token: string) {
  return { authorization: `Bearer ${token}` }
}

const ORIGIN = 'http://localhost:4100'

/**
 * A browser's headers. The cookie alone is not what a browser sends — it also
 * names the origin it was served from, and the server requires that on a write.
 */
function withCookie(sessionId: string) {
  return {
    cookie: `${USER_SESSION_COOKIE_NAME}=${sessionId}`,
    origin: ORIGIN,
    host: 'localhost:4100',
  }
}

/** Create an account through the API, exactly as the CLI does. */
async function createAccount(name: string, password: string, role: 'admin' | 'viewer', headers = withKey(ROOT_KEY)) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers,
    payload: { name, password, role },
  })
}

/** Sign in and return the session cookie value. */
async function signIn(name: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN, host: 'localhost:4100' },
    payload: { name, password },
  })
  expect(res.statusCode).toBe(200)
  const setCookie = res.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)
  const value = raw.split(';')[0]!.split('=')[1]!
  expect(value).not.toBe('')
  return decodeURIComponent(value)
}

/** Publishing now pins the revision the caller believed was active. */
function publishRequest(targetKeys: string[], expectedActiveRevision: number | null) {
  return { expectedActiveRevision, plan: samplePlan(targetKeys) }
}

/** The discovery request the setup wizard's first step makes. */
function discoveryRequest() {
  return {
    sitemapUrl: 'https://sample.example/sitemap.xml',
    rule: { primary: { host: 'sample.example', pathTemplate: '/north/{slug}' } },
  }
}

/** A plan the compiler accepts, built from this fixture's own tracked queries. */
function samplePlan(targetKeys: string[] = ['north']) {
  return {
    schemaVersion: 1,
    targets: targetKeys.map(key => ({
      stableKey: key,
      label: key === 'north' ? 'North' : 'South',
      urls: [{ kind: 'prefix', host: 'sample.example', pathPrefix: `/${key}`, pathCase: 'insensitive' }],
      aliases: [key === 'north' ? 'North Branch' : 'South Branch'],
    })),
    groups: [],
    targetQuerySelections: targetKeys.map(key => ({ targetKey: key, queryIds: trackedQueryIds })),
  }
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-session-auth-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  seedKey('root', ROOT_KEY, ['*'])
  seedKey('reader', READ_KEY, ['read'])

  projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'sample',
    displayName: 'Sample',
    canonicalDomain: 'sample.example',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  trackedQueryIds = ['best north option', 'north option reviews'].map((text) => {
    const id = crypto.randomUUID()
    db.insert(queries).values({ id, projectId, query: text, createdAt: now }).run()
    return id
  })

  app = Fastify()
  app.register(apiRoutes, {
    db,
    // The run-trigger path now refuses a roster that resolves empty
    // (post-review runner semantics), so the admin's 201 needs a
    // runnable provider to exist.
    getRunnableProviderNames: () => ['openai'],
    googleSettingsSummary: { configured: false },
    onGoogleSettingsUpdate: () => ({ configured: true }),
    // Stubbed so the discovery route classifies a fixed list instead of
    // reaching the network. What is under test is who may call it.
    fetchMeasurementSitemap: async () => ({
      urls: ['https://sample.example/north/one', 'https://sample.example/north/two'],
      fetchedAt: new Date().toISOString(),
    }),
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── T2 ────────────────────────────────────────────────────────────────────

test('T2: creating the first account turns sign-in on for the whole install', async () => {
  const before = await app.inject({ method: 'GET', url: '/api/v1/auth/session' })
  expect(JSON.parse(before.body)).toEqual({ authRequired: false, user: null })

  const created = await createAccount('owner', ADMIN_PASSWORD, 'admin')
  expect(created.statusCode).toBe(201)

  const after = await app.inject({ method: 'GET', url: '/api/v1/auth/session' })
  expect(JSON.parse(after.body)).toEqual({ authRequired: true, user: null })

  // Every unauthenticated request is now refused, reads included.
  const read = await app.inject({ method: 'GET', url: '/api/v1/projects' })
  expect(read.statusCode).toBe(401)
  expect(JSON.parse(read.body).error.code).toBe('AUTH_REQUIRED')

  const write = await app.inject({ method: 'POST', url: '/api/v1/projects/sample/runs', payload: {} })
  expect(write.statusCode).toBe(401)
})

test('T2: the shared dashboard password stops opening the door once accounts exist', async () => {
  // The older shared-password session hands out the root key's authority. Left
  // live, it would let anyone who knows one password walk past the roles that
  // were just set up.
  const legacySessions = new Map<string, string>()
  const rootKeyId = db.select().from(apiKeys).where(eq(apiKeys.name, 'root')).get()!.id
  legacySessions.set('legacy-session-id', rootKeyId)

  await app.close()
  app = Fastify()
  app.register(apiRoutes, {
    db,
    sessionCookieName: 'canonry_session',
    resolveSessionApiKeyId: (id: string) => legacySessions.get(id) ?? null,
  })
  await app.ready()

  const beforeAccounts = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { cookie: 'canonry_session=legacy-session-id' },
  })
  expect(beforeAccounts.statusCode).toBe(200)

  await createAccount('owner', ADMIN_PASSWORD, 'admin')

  const afterAccounts = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { cookie: 'canonry_session=legacy-session-id' },
  })
  expect(afterAccounts.statusCode).toBe(401)
})

test('T2: a signed-in admin sees exactly what the root key sees', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const session = await signIn('owner', ADMIN_PASSWORD)

  const viaSession = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: withCookie(session) })
  const viaKey = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: withKey(ROOT_KEY) })

  expect(viaSession.statusCode).toBe(200)
  expect(JSON.parse(viaSession.body)).toEqual(JSON.parse(viaKey.body))

  const whoami = await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: withCookie(session) })
  expect(JSON.parse(whoami.body)).toMatchObject({
    authRequired: true,
    user: {
      name: 'owner',
      role: 'admin',
      status: 'active',
      authVersion: 0,
      hasPassword: true,
    },
  })
})

// ─── T3 ────────────────────────────────────────────────────────────────────

test('T3: every administrative action is refused for a viewer and works for an admin', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await createAccount('watcher', VIEWER_PASSWORD, 'viewer')
  const admin = await signIn('owner', ADMIN_PASSWORD)
  const viewer = await signIn('watcher', VIEWER_PASSWORD)

  // Publish a plan carrying both targets first, so the publish action below
  // has a revision to supersede and the retire action has a target that is no
  // longer in the active plan.
  const publish = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/sample/measurement-plan',
    headers: withCookie(admin),
    payload: publishRequest(['north', 'south'], null),
  })
  expect(publish.statusCode).toBe(201)

  const actions = [
    {
      label: 'publish a plan',
      method: 'PUT' as const,
      url: '/api/v1/projects/sample/measurement-plan',
      payload: publishRequest(['north'], 1),
      adminStatus: 201,
    },
    {
      label: 'retire a target',
      method: 'POST' as const,
      url: '/api/v1/projects/sample/measurement-plan/segments/south/retire',
      payload: {},
      adminStatus: 200,
    },
    {
      label: 'trigger a run',
      method: 'POST' as const,
      url: '/api/v1/projects/sample/runs',
      payload: {},
      adminStatus: 201,
    },
    {
      label: 'change settings',
      method: 'PUT' as const,
      url: '/api/v1/settings/google',
      payload: { clientId: 'sample-client-id', clientSecret: 'sample-client-secret' },
      adminStatus: 200,
    },
    {
      label: 'mint an API key',
      method: 'POST' as const,
      url: '/api/v1/keys',
      payload: { name: 'minted-in-test' },
      adminStatus: 200,
    },
  ]

  const viewerResults: Array<{ label: string; status: number }> = []
  for (const action of actions) {
    const res = await app.inject({
      method: action.method,
      url: action.url,
      headers: withCookie(viewer),
      payload: action.payload,
    })
    viewerResults.push({ label: action.label, status: res.statusCode })
  }
  expect(viewerResults).toEqual(actions.map(a => ({ label: a.label, status: 403 })))

  const adminResults: Array<{ label: string; status: number }> = []
  for (const action of actions) {
    const res = await app.inject({
      method: action.method,
      url: action.url,
      headers: withCookie(admin),
      payload: action.payload,
    })
    adminResults.push({ label: action.label, status: res.statusCode })
  }
  expect(adminResults).toEqual(actions.map(a => ({ label: a.label, status: a.adminStatus })))
})

test('T3: a viewer is told plainly why, without jargon about scopes or keys', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await createAccount('watcher', VIEWER_PASSWORD, 'viewer')
  const viewer = await signIn('watcher', VIEWER_PASSWORD)

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/sample/runs',
    headers: withCookie(viewer),
    payload: {},
  })

  const message = JSON.parse(res.body).error.message as string
  expect(message).toBe('Your account has view-only access, so it cannot make this change.')
  expect(message).not.toMatch(/scope|API key|403/i)
})

test('T3: administrator-only reads are refused at the server, not merely hidden', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await createAccount('watcher', VIEWER_PASSWORD, 'viewer')
  const admin = await signIn('owner', ADMIN_PASSWORD)
  const viewer = await signIn('watcher', VIEWER_PASSWORD)

  const adminOnlyReads = ['/api/v1/keys', '/api/v1/users', '/api/v1/settings']

  for (const url of adminOnlyReads) {
    const asViewer = await app.inject({ method: 'GET', url, headers: withCookie(viewer) })
    expect(asViewer.statusCode, url).toBe(403)
    expect(JSON.parse(asViewer.body).error.message).toBe('Only an administrator account can use this.')

    const asAdmin = await app.inject({ method: 'GET', url, headers: withCookie(admin) })
    expect(asAdmin.statusCode, url).toBe(200)
  }
})

test('T3: a viewer can still read everything a project has measured', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await createAccount('watcher', VIEWER_PASSWORD, 'viewer')
  const viewer = await signIn('watcher', VIEWER_PASSWORD)

  for (const url of ['/api/v1/projects', '/api/v1/projects/sample', '/api/v1/projects/sample/queries']) {
    const res = await app.inject({ method: 'GET', url, headers: withCookie(viewer) })
    expect(res.statusCode, url).toBe(200)
  }
})

// ─── T4 ────────────────────────────────────────────────────────────────────

test('T4: a viewer can ask what a plan would do, because asking changes nothing', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await createAccount('watcher', VIEWER_PASSWORD, 'viewer')
  const viewer = await signIn('watcher', VIEWER_PASSWORD)

  for (const url of [
    '/api/v1/projects/sample/measurement-plan/compile-preview',
    '/api/v1/projects/sample/measurement-plan/diff-preview',
  ]) {
    const res = await app.inject({ method: 'POST', url, headers: withCookie(viewer), payload: samplePlan() })
    expect(res.statusCode, url).toBe(200)
  }

  // Sorting a fetched sitemap is the wizard's first step and writes nothing.
  const discovery = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/sample/measurement-discovery',
    headers: withCookie(viewer),
    payload: discoveryRequest(),
  })
  expect(discovery.statusCode).toBe(200)

  // And nothing was published by looking.
  const plan = await app.inject({
    method: 'GET',
    url: '/api/v1/projects/sample/measurement-plan',
    headers: withCookie(viewer),
  })
  expect(JSON.parse(plan.body)).toEqual({ active: null })
})

test('T4: the allowance is exactly those previews and nothing adjacent', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await createAccount('watcher', VIEWER_PASSWORD, 'viewer')
  const viewer = await signIn('watcher', VIEWER_PASSWORD)

  // Same router prefix, same body, but this one publishes.
  const publish = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/sample/measurement-plan',
    headers: withCookie(viewer),
    payload: publishRequest(['north'], null),
  })
  expect(publish.statusCode).toBe(403)

  // A discovery run is a run: it costs money and writes rows.
  const discover = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/sample/discover/run',
    headers: withCookie(viewer),
    payload: {},
  })
  expect(discover.statusCode).toBe(403)
})

// ─── T5 ────────────────────────────────────────────────────────────────────

test('T5: API keys behave identically whether or not accounts exist', async () => {
  const probe = async () => {
    const rootRead = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: withKey(ROOT_KEY) })
    const rootWrite = await app.inject({
      method: 'POST', url: '/api/v1/projects/sample/runs', headers: withKey(ROOT_KEY), payload: {},
    })
    const readerRead = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: withKey(READ_KEY) })
    const readerWrite = await app.inject({
      method: 'POST', url: '/api/v1/projects/sample/runs', headers: withKey(READ_KEY), payload: {},
    })
    const readerPreview = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/sample/measurement-plan/compile-preview',
      headers: withKey(READ_KEY),
      payload: samplePlan(),
    })
    const readerDiscovery = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/sample/measurement-discovery',
      headers: withKey(READ_KEY),
      payload: discoveryRequest(),
    })
    // A queued run blocks the next trigger for the same project, which would
    // make the second pass differ for a reason that has nothing to do with
    // accounts. Clear it so both passes start from the same place.
    db.delete(runs).where(eq(runs.projectId, projectId)).run()
    return {
      rootRead: rootRead.statusCode,
      rootWrite: rootWrite.statusCode,
      readerRead: readerRead.statusCode,
      readerWrite: readerWrite.statusCode,
      readerPreview: readerPreview.statusCode,
      readerDiscovery: readerDiscovery.statusCode,
    }
  }

  const withoutAccounts = await probe()
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await createAccount('watcher', VIEWER_PASSWORD, 'viewer')
  const withAccounts = await probe()

  expect(withAccounts).toEqual(withoutAccounts)
  expect(withoutAccounts).toEqual({
    rootRead: 200,
    rootWrite: 201,
    readerRead: 200,
    // A read-only key is refused writes, and the preview annotation does not
    // change that: the annotation only ever relaxes a signed-in viewer.
    readerWrite: 403,
    readerPreview: 403,
    readerDiscovery: 403,
  })
})

test('T5: a key and a session are peers, and a bad session never blocks a good key', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { ...withKey(ROOT_KEY), ...withCookie('a-session-that-does-not-exist') },
  })
  expect(res.statusCode).toBe(200)
})

// ─── T6 ────────────────────────────────────────────────────────────────────

test('T6: an expired session stops working and is cleaned up', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const session = await signIn('owner', ADMIN_PASSWORD)

  const live = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: withCookie(session) })
  expect(live.statusCode).toBe(200)

  db.update(userSessions)
    .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    .where(eq(userSessions.tokenHash, hashSessionToken(session)))
    .run()

  const dead = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: withCookie(session) })
  expect(dead.statusCode).toBe(401)
  expect(db.select().from(userSessions).where(eq(userSessions.tokenHash, hashSessionToken(session))).get()).toBeUndefined()
})

test('T6: a session in use is extended rather than dropped mid-task', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const session = await signIn('owner', ADMIN_PASSWORD)

  // Wind it down to just under the halfway mark — the point at which a session
  // still in use should be extended.
  const nearlyDone = new Date(Date.now() + USER_SESSION_TTL_MS / 4).toISOString()
  db.update(userSessions).set({ expiresAt: nearlyDone }).where(eq(userSessions.tokenHash, hashSessionToken(session))).run()

  const res = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: withCookie(session) })
  expect(res.statusCode).toBe(200)

  const after = db.select().from(userSessions).where(eq(userSessions.tokenHash, hashSessionToken(session))).get()!
  expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.parse(nearlyDone))
  expect(String(res.headers['set-cookie'])).toContain(USER_SESSION_COOKIE_NAME)
})

test('T6: the session cookie cannot be read by page scripts or ridden from another site', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { name: 'owner', password: ADMIN_PASSWORD },
  })

  const cookie = String(res.headers['set-cookie'])
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Lax')
})

test('T6: signing out ends the session on the server, not just in the browser', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const session = await signIn('owner', ADMIN_PASSWORD)

  const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: withCookie(session) })
  expect(out.statusCode).toBe(204)
  expect(String(out.headers['set-cookie'])).toContain('Max-Age=0')

  // A browser that kept the cookie anyway gets nowhere.
  const replay = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: withCookie(session) })
  expect(replay.statusCode).toBe(401)
})

test('T6: repeated wrong passwords pause that name instead of allowing an endless guess', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')

  const statuses: number[] = []
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { name: 'owner', password: 'not-the-right-password' },
    })
    statuses.push(res.statusCode)
  }

  expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401))
  expect(statuses.slice(10)).toEqual([429, 429])

  // Even the correct password waits: the pause is on the name, not on the guess.
  const correct = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { name: 'owner', password: ADMIN_PASSWORD },
  })
  expect(correct.statusCode).toBe(429)
})

test('T6: a failed sign-in never reveals whether the name exists', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')

  const wrongPassword = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { name: 'owner', password: 'not-the-right-password' },
  })
  const unknownName = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { name: 'nobody', password: 'not-the-right-password' },
  })

  expect(wrongPassword.statusCode).toBe(unknownName.statusCode)
  expect(JSON.parse(wrongPassword.body)).toEqual(JSON.parse(unknownName.body))
})

// ─── T7 ────────────────────────────────────────────────────────────────────

test('T7: the password is stored salted and hashed, and the plaintext is nowhere', async () => {
  const logLines: string[] = []
  await app.close()
  app = Fastify({
    logger: {
      level: 'trace',
      // Capture the log stream instead of writing it, so the assertion below
      // is about what WOULD have been written on a real install.
      stream: { write: (line: string) => { logLines.push(line) } },
    },
  })
  app.register(apiRoutes, { db })
  await app.ready()

  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await signIn('owner', ADMIN_PASSWORD)

  const stored = db.select().from(users).where(eq(users.nameKey, 'owner')).get()!

  expect(stored.passwordHash).not.toContain(ADMIN_PASSWORD)
  expect(stored.passwordHash.startsWith('scrypt$1$')).toBe(true)
  expect(await verifyUserPassword(ADMIN_PASSWORD, stored.passwordHash)).toBe(true)
  expect(await verifyUserPassword('not-the-right-password', stored.passwordHash)).toBe(false)

  // The same password stored twice must not produce the same digest, or a
  // stolen table would show which accounts share a password.
  await createAccount('second', ADMIN_PASSWORD, 'viewer')
  const other = db.select().from(users).where(eq(users.nameKey, 'second')).get()!
  expect(other.passwordHash).not.toBe(stored.passwordHash)

  // Nothing anywhere on disk or in the log carries the plaintext.
  const wholeDb = fs.readFileSync(path.join(tmpDir, 'test.db'))
  expect(wholeDb.includes(Buffer.from(ADMIN_PASSWORD))).toBe(false)
  expect(logLines.join('\n')).not.toContain(ADMIN_PASSWORD)
  expect(logLines.length).toBeGreaterThan(0)
})

test('T7: a password too short to be worth storing is refused before it is stored', async () => {
  const res = await createAccount('owner', 'short', 'admin')
  expect(res.statusCode).toBe(400)
  expect(db.select().from(users).all()).toEqual([])
  expect(USER_PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(12)
})

// ─── account management ────────────────────────────────────────────────────

test('accounts cannot be created without the authority to create them', async () => {
  const withReadOnlyKey = await createAccount('owner', ADMIN_PASSWORD, 'admin', withKey(READ_KEY))
  expect(withReadOnlyKey.statusCode).toBe(403)

  const anonymous = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    payload: { name: 'owner', password: ADMIN_PASSWORD, role: 'admin' },
  })
  expect(anonymous.statusCode).toBe(401)
  expect(db.select().from(users).all()).toEqual([])
})

test('two accounts cannot share a name, whatever the capitalisation', async () => {
  expect((await createAccount('Owner', ADMIN_PASSWORD, 'admin')).statusCode).toBe(201)
  const duplicate = await createAccount('owner', VIEWER_PASSWORD, 'viewer')
  expect(duplicate.statusCode).toBe(409)
})

test('the last administrator cannot be deleted', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await createAccount('watcher', VIEWER_PASSWORD, 'viewer')
  const admin = await signIn('owner', ADMIN_PASSWORD)

  const refused = await app.inject({ method: 'DELETE', url: '/api/v1/users/owner', headers: withCookie(admin) })
  expect(refused.statusCode).toBe(400)
  expect(JSON.parse(refused.body).error.code).toBe('VALIDATION_ERROR')

  const allowed = await app.inject({ method: 'DELETE', url: '/api/v1/users/watcher', headers: withCookie(admin) })
  expect(allowed.statusCode).toBe(200)
})

test('deleting an account ends its sessions immediately', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await createAccount('watcher', VIEWER_PASSWORD, 'viewer')
  const admin = await signIn('owner', ADMIN_PASSWORD)
  const viewer = await signIn('watcher', VIEWER_PASSWORD)

  expect((await app.inject({ method: 'GET', url: '/api/v1/projects', headers: withCookie(viewer) })).statusCode).toBe(200)

  await app.inject({ method: 'DELETE', url: '/api/v1/users/watcher', headers: withCookie(admin) })

  expect((await app.inject({ method: 'GET', url: '/api/v1/projects', headers: withCookie(viewer) })).statusCode).toBe(401)
})

test('the session cookie is marked Secure when the request arrived over https', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')

  const plain = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN, host: 'localhost:4100' },
    payload: { name: 'owner', password: ADMIN_PASSWORD },
  })
  expect(String(plain.headers['set-cookie'])).not.toContain('Secure')

  const behindProxy = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-proto': 'https', origin: ORIGIN, host: 'localhost:4100' },
    payload: { name: 'owner', password: ADMIN_PASSWORD },
  })
  expect(String(behindProxy.headers['set-cookie'])).toContain('Secure')
})

test('the stand-in digest for an unknown name is a real one, not a shortcut', async () => {
  // The sign-in route verifies against this when the name is unknown, so that
  // an unknown name costs the same as a wrong password. If it ever stopped
  // being a well-formed digest, `verifyUserPassword` would bail out on the
  // format check and the form would quietly become an account-name oracle.
  expect(UNKNOWN_ACCOUNT_DIGEST.startsWith('scrypt$1$')).toBe(true)
  expect(UNKNOWN_ACCOUNT_DIGEST.split('$')).toHaveLength(4)
  expect(await verifyUserPassword('anything at all', UNKNOWN_ACCOUNT_DIGEST)).toBe(false)

  const realDigest = await hashUserPassword('a-long-enough-admin-password')
  const started = process.hrtime.bigint()
  await verifyUserPassword('a-guess', UNKNOWN_ACCOUNT_DIGEST)
  const unknownCost = process.hrtime.bigint() - started

  const startedReal = process.hrtime.bigint()
  await verifyUserPassword('a-guess', realDigest)
  const realCost = process.hrtime.bigint() - startedReal

  // Same order of magnitude — a format bail-out would be orders faster.
  expect(Number(unknownCost)).toBeGreaterThan(Number(realCost) / 10)
})
