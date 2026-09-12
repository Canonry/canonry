/**
 * Security review findings, each with the hole demonstrated before the fix.
 *
 * Every test here starts from "what can somebody who should not be able to do
 * this actually do", not from "does the happy path still work". The happy paths
 * live in `session-auth-users.test.ts`.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  apiKeys,
  createClient,
  migrate,
  projects,
  users,
  userSessions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { UserStatuses } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { USER_SESSION_COOKIE_NAME } from '../src/user-session.js'

const ROOT_KEY = 'cnry_hardening_root'
const SCOPED_KEY = 'cnry_hardening_scoped'
const ADMIN_PASSWORD = 'a-long-enough-admin-password'
const VIEWER_PASSWORD = 'a-long-enough-viewer-password'
const ORIGIN = 'http://localhost:4100'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let projectId: string

function seedKey(name: string, token: string, scopes: string[], scopedProjectId?: string) {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name,
    keyHash: hashApiKey(token),
    keyPrefix: token.slice(0, 9),
    scopes,
    projectId: scopedProjectId ?? null,
    createdAt: new Date().toISOString(),
  }).run()
}

function withKey(token: string) {
  return { authorization: `Bearer ${token}` }
}

/** A browser's headers: the session cookie plus the origin it was served from. */
function asBrowser(sessionToken: string) {
  return {
    cookie: `${USER_SESSION_COOKIE_NAME}=${sessionToken}`,
    origin: ORIGIN,
    host: 'localhost:4100',
  }
}

async function createAccount(name: string, password: string, role: 'admin' | 'viewer', headers = withKey(ROOT_KEY)) {
  return app.inject({ method: 'POST', url: '/api/v1/users', headers, payload: { name, password, role } })
}

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
  return decodeURIComponent(raw.split(';')[0]!.split('=')[1]!)
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-auth-hardening-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

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

  seedKey('root', ROOT_KEY, ['*'])
  // A key bound to ONE project, but carrying the wildcard scope inside it.
  seedKey('scoped', SCOPED_KEY, ['*'], projectId)

  app = Fastify()
  app.register(apiRoutes, { db })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── P1.1 project-scope escape ─────────────────────────────────────────────

test('a project-scoped key cannot create an account and escape its project', async () => {
  // The escape: accounts are instance-wide, so minting one would hand the
  // holder of a single-project key an administrator who can reach every
  // project. The key's own boundary has to survive the account it creates.
  const created = await createAccount('owner', ADMIN_PASSWORD, 'admin', withKey(SCOPED_KEY))

  expect(created.statusCode).toBe(403)
  expect(db.select().from(users).all()).toEqual([])
})

test('a project-scoped key cannot read or delete accounts either', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')

  const listed = await app.inject({ method: 'GET', url: '/api/v1/users', headers: withKey(SCOPED_KEY) })
  expect(listed.statusCode).toBe(403)

  const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/users/owner', headers: withKey(SCOPED_KEY) })
  expect(deleted.statusCode).toBe(403)
  expect(db.select().from(users).all()).toHaveLength(1)
})

test('a full-instance key still manages accounts normally', async () => {
  expect((await createAccount('owner', ADMIN_PASSWORD, 'admin')).statusCode).toBe(201)
  expect((await app.inject({ method: 'GET', url: '/api/v1/users', headers: withKey(ROOT_KEY) })).statusCode).toBe(200)
})

// ─── P1.3 replayable sessions at rest ──────────────────────────────────────

test('a stolen database does not contain anything that can be replayed as a cookie', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const cookieToken = await signIn('owner', ADMIN_PASSWORD)

  // What an attacker who copies the database file actually gets.
  const storedRows = db.select().from(userSessions).all()
  expect(storedRows).toHaveLength(1)

  const everyStoredValue = storedRows.flatMap(row => Object.values(row).map(String))
  expect(everyStoredValue).not.toContain(cookieToken)

  // And the file on disk carries no copy of it either.
  const wholeDb = fs.readFileSync(path.join(tmpDir, 'test.db'))
  expect(wholeDb.includes(Buffer.from(cookieToken))).toBe(false)

  // The real cookie still works, so this is storage, not a broken session.
  const authed = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${cookieToken}` },
  })
  expect(authed.statusCode).toBe(200)
})

test('the value stored for a session is the digest of the cookie, nothing else', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const cookieToken = await signIn('owner', ADMIN_PASSWORD)

  const stored = db.select().from(userSessions).all()[0]!
  expect(stored.tokenHash).toBe(crypto.createHash('sha256').update(cookieToken).digest('hex'))

  // Presenting the stored value instead of the cookie gets nowhere: it is not
  // the credential, it is the record that one existed.
  const replay = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${stored.tokenHash}` },
  })
  expect(replay.statusCode).toBe(401)
})

test('suspending an account invalidates its existing browser session immediately', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const session = await signIn('owner', ADMIN_PASSWORD)
  const account = db.select().from(users).where(eq(users.nameKey, 'owner')).get()!

  db.update(users).set({ status: UserStatuses.suspended }).where(eq(users.id, account.id)).run()

  const denied = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${session}` },
  })
  expect(denied.statusCode).toBe(401)
  expect(db.select().from(userSessions).where(eq(userSessions.userId, account.id)).all()).toEqual([])
})

test('an authorization-version change invalidates a browser session without relying on deletion', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const session = await signIn('owner', ADMIN_PASSWORD)
  const account = db.select().from(users).where(eq(users.nameKey, 'owner')).get()!

  db.update(users).set({ authVersion: account.authVersion + 1 }).where(eq(users.id, account.id)).run()

  const denied = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${session}` },
  })
  expect(denied.statusCode).toBe(401)
  expect(db.select().from(userSessions).where(eq(userSessions.userId, account.id)).all()).toEqual([])
})

test('delegated credentials require an active account at their issued authorization version', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const account = db.select().from(users).where(eq(users.nameKey, 'owner')).get()!
  const delegatedToken = 'cnry_delegated_fixture'
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'delegated fixture',
    keyHash: hashApiKey(delegatedToken),
    keyPrefix: delegatedToken.slice(0, 9),
    scopes: ['*'],
    delegatedUserId: account.id,
    delegatedUserAuthVersion: account.authVersion,
    createdAt: new Date().toISOString(),
  }).run()

  expect((await app.inject({ method: 'GET', url: '/api/v1/projects', headers: withKey(delegatedToken) })).statusCode).toBe(200)

  db.update(users).set({ authVersion: account.authVersion + 1 }).where(eq(users.id, account.id)).run()
  expect((await app.inject({ method: 'GET', url: '/api/v1/projects', headers: withKey(delegatedToken) })).statusCode).toBe(401)
})

// ─── P2.4 cross-origin writes ──────────────────────────────────────────────

test('a write driven from another origin is refused even with a valid cookie', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const session = await signIn('owner', ADMIN_PASSWORD)

  // A sibling origin that shares the cookie: SameSite=Lax sends the cookie,
  // so the request arrives fully authenticated. Only the origin says it is not
  // the dashboard.
  const fromSibling = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/sample/runs',
    headers: {
      cookie: `${USER_SESSION_COOKIE_NAME}=${session}`,
      origin: 'http://other.localhost:4100',
      host: 'localhost:4100',
    },
    payload: {},
  })
  expect(fromSibling.statusCode).toBe(403)

  const fromDashboard = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/sample/runs',
    headers: asBrowser(session),
    payload: {},
  })
  expect(fromDashboard.statusCode).toBe(201)
})

test('a write with no origin at all is refused for a cookie, allowed for a key', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const session = await signIn('owner', ADMIN_PASSWORD)

  const cookieOnly = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/sample/runs',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${session}` },
    payload: {},
  })
  expect(cookieOnly.statusCode).toBe(403)

  // An API key is not a browser credential — nothing can be ridden through it,
  // so the origin rule must not touch it. This is the whole point of keeping
  // the two principals separate.
  const withApiKey = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/sample/runs',
    headers: withKey(ROOT_KEY),
    payload: {},
  })
  expect(withApiKey.statusCode).toBe(201)
})

test('reads are never blocked by the origin rule', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const session = await signIn('owner', ADMIN_PASSWORD)

  const read = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${session}`, origin: 'http://elsewhere.example' },
  })
  expect(read.statusCode).toBe(200)
})

test('a referer stands in when the origin header is absent', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const session = await signIn('owner', ADMIN_PASSWORD)

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/sample/runs',
    headers: {
      cookie: `${USER_SESSION_COOKIE_NAME}=${session}`,
      referer: 'http://localhost:4100/projects/sample',
      host: 'localhost:4100',
    },
    payload: {},
  })
  expect(res.statusCode).toBe(201)
})

// ─── P2.6 sliding sessions ─────────────────────────────────────────────────

test('the status poll that renews a session also refreshes the browser cookie', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const session = await signIn('owner', ADMIN_PASSWORD)
  const tokenHash = crypto.createHash('sha256').update(session).digest('hex')

  // Wind the session down past its halfway point, which is when a session
  // still in use should be extended.
  const nearlyDone = new Date(Date.now() + 60_000).toISOString()
  db.update(userSessions).set({ expiresAt: nearlyDone }).where(eq(userSessions.tokenHash, tokenHash)).run()

  const polled = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${session}` },
  })

  expect(polled.statusCode).toBe(200)
  // Without this, a dashboard left open all day keeps a live server-side
  // session behind a cookie the browser drops at the original expiry.
  expect(String(polled.headers['set-cookie'])).toContain(USER_SESSION_COOKIE_NAME)

  const after = db.select().from(userSessions).where(eq(userSessions.tokenHash, tokenHash)).get()!
  expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.parse(nearlyDone))
})

// ─── P2.8 zero-admin state ─────────────────────────────────────────────────

test('the first account has to be an administrator', async () => {
  // A viewer-only install turns sign-in on and then has nobody who can turn
  // anything back on from the dashboard.
  const viewerFirst = await createAccount('watcher', VIEWER_PASSWORD, 'viewer')
  expect(viewerFirst.statusCode).toBe(400)
  expect(String(JSON.parse(viewerFirst.body).error.message)).toMatch(/first account/i)
  expect(db.select().from(users).all()).toEqual([])

  expect((await createAccount('owner', ADMIN_PASSWORD, 'admin')).statusCode).toBe(201)
  // Once an administrator exists, viewers are ordinary.
  expect((await createAccount('watcher', VIEWER_PASSWORD, 'viewer')).statusCode).toBe(201)
})
