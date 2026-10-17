/**
 * Second panel. Every one of these is a defence that was ONE step from off:
 * a budget an attacker could opt out of with a header, a gate that read
 * "administrators only" but asked the wrong question of a key, and a lockout
 * pointed at the victim instead of the attacker.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { apiKeys, createClient, migrate, projects, type DatabaseClient } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { USER_SESSION_COOKIE_NAME } from '../src/user-session.js'

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

const ROOT_KEY = 'cnry_panel2_root'
const ADS_KEY = 'cnry_panel2_ads'
const EMPTY_SCOPE_KEY = 'cnry_panel2_empty'
const ADMIN_PASSWORD = 'a-long-enough-admin-password'
const ORIGIN = 'http://localhost:4100'
const HOST = 'localhost:4100'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

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

async function createAccount(name: string, password: string, role: 'admin' | 'viewer') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: withKey(ROOT_KEY),
    payload: { name, password, role },
  })
}

/** One sign-in attempt, from a stated address, optionally claiming a forwarded one. */
function attempt(opts: {
  server?: ReturnType<typeof Fastify>
  name: string
  password: string
  from: string
  forwardedFor?: string
}) {
  return (opts.server ?? app).inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: opts.from,
    headers: {
      origin: ORIGIN,
      host: HOST,
      ...(opts.forwardedFor ? { 'x-forwarded-for': opts.forwardedFor } : {}),
    },
    payload: { name: opts.name, password: opts.password },
  })
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-panel2-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const now = new Date().toISOString()
  db.insert(projects).values({
    id: crypto.randomUUID(),
    name: 'sample',
    displayName: 'Sample',
    canonicalDomain: 'sample.example',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  seedKey('root', ROOT_KEY, ['*'])
  // Neither of these is read-only and neither is project-scoped, so a gate that
  // only asks those two questions lets them both through.
  seedKey('ads-writer', ADS_KEY, ['ads.write'])
  seedKey('no-scopes', EMPTY_SCOPE_KEY, [])

  app = Fastify()
  app.register(apiRoutes, { db })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── 1. the budget an attacker could opt out of ────────────────────────────

test('a direct caller cannot switch off its own budget with a header', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')

  // No proxy anywhere. The attacker simply asserts one, and on the default
  // configuration that was enough to be classified "unidentifiable" and have
  // every per-caller budget skipped.
  const statuses: number[] = []
  for (let i = 0; i < 40; i++) {
    statuses.push((await attempt({
      name: `nobody-${i}`,
      password: 'a-wrong-guess',
      from: '203.0.113.7',
      forwardedFor: 'totally-made-up',
    })).statusCode)
  }

  expect(statuses).toContain(429)
})

test('the same caller is budgeted whether or not it invents a forwarded header', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')

  // Alternating the header must not buy a fresh allowance either.
  const statuses: number[] = []
  for (let i = 0; i < 40; i++) {
    statuses.push((await attempt({
      name: `nobody-${i}`,
      password: 'a-wrong-guess',
      from: '203.0.113.7',
      ...(i % 2 === 0 ? { forwardedFor: `10.0.0.${i}` } : {}),
    })).statusCode)
  }

  expect(statuses).toContain(429)
})

// ─── 2. the account list behind a gate that asked the wrong question ───────

test('a key with unrelated write scopes cannot enumerate accounts', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')

  // Not read-only, not project-scoped — so the old gate waved it through, and
  // the account list is exactly the input the lockout attack below needs.
  const listed = await app.inject({ method: 'GET', url: '/api/v1/users', headers: withKey(ADS_KEY) })
  expect(listed.statusCode).toBe(403)
})

test('a key with no scopes at all cannot enumerate accounts', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')

  const listed = await app.inject({ method: 'GET', url: '/api/v1/users', headers: withKey(EMPTY_SCOPE_KEY) })
  expect(listed.statusCode).toBe(403)
})

test('the root key still manages accounts', async () => {
  expect((await createAccount('owner', ADMIN_PASSWORD, 'admin')).statusCode).toBe(201)
  expect((await app.inject({ method: 'GET', url: '/api/v1/users', headers: withKey(ROOT_KEY) })).statusCode).toBe(200)
})

// ─── 3. a lockout pointed at the victim ────────────────────────────────────

test('a slow attacker cannot hold a known account locked out', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')

  // The attack is cheap and endless: a handful of wrong guesses at a name the
  // attacker read off the account list, forever. The real administrator is
  // somewhere else entirely and has done nothing wrong.
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 15; i++) {
      await attempt({ name: 'owner', password: 'a-wrong-guess', from: '203.0.113.7' })
    }

    const realAdmin = await attempt({ name: 'owner', password: ADMIN_PASSWORD, from: '198.51.100.4' })
    expect(realAdmin.statusCode, `round ${round}`).toBe(200)
  }
})

test('the attacker itself is still stopped', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')

  const statuses: number[] = []
  for (let i = 0; i < 15; i++) {
    statuses.push((await attempt({ name: 'owner', password: 'a-wrong-guess', from: '203.0.113.7' })).statusCode)
  }
  expect(statuses).toContain(429)

  // And even holding the right password does not release the attacker early.
  const attackerWithPassword = await attempt({
    name: 'owner', password: ADMIN_PASSWORD, from: '203.0.113.7',
  })
  expect(attackerWithPassword.statusCode).toBe(429)
})

test('guessing from many sources is still slowed at every one of them', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')

  // Distributed guessing must not become free just because the budget moved to
  // being per-source: each source still spends its own allowance.
  const perSource: number[] = []
  for (const source of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
    let refused = 0
    for (let i = 0; i < 15; i++) {
      const res = await attempt({ name: 'owner', password: 'a-wrong-guess', from: source })
      if (res.statusCode === 429) refused++
    }
    perSource.push(refused)
  }
  expect(perSource.every(refused => refused > 0)).toBe(true)
})

// ─── the two the panel called optional ─────────────────────────────────────

test('another origin cannot sign somebody out', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const signedIn = await attempt({ name: 'owner', password: ADMIN_PASSWORD, from: '198.51.100.4' })
  const raw = Array.isArray(signedIn.headers['set-cookie'])
    ? signedIn.headers['set-cookie'][0]!
    : String(signedIn.headers['set-cookie'])
  const token = decodeURIComponent(raw.split(';')[0]!.split('=')[1]!)

  const forced = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: {
      cookie: `${USER_SESSION_COOKIE_NAME}=${token}`,
      origin: 'http://evil.localhost:4100',
      host: HOST,
    },
  })
  expect(forced.statusCode).toBe(403)

  const stillSignedIn = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${token}` },
  })
  expect(stillSignedIn.statusCode).toBe(200)
})

test('being readable by a viewer does not make a route safe to drive from elsewhere', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await createAccount('watcher', 'a-long-enough-viewer-password', 'viewer')
  // A VIEWER specifically: the exemption was keyed on the same flag that grants
  // viewers access to these routes, so it only ever fired for them.
  const signedIn = await attempt({ name: 'watcher', password: 'a-long-enough-viewer-password', from: '198.51.100.4' })
  const raw = Array.isArray(signedIn.headers['set-cookie'])
    ? signedIn.headers['set-cookie'][0]!
    : String(signedIn.headers['set-cookie'])
  const token = decodeURIComponent(raw.split(';')[0]!.split('=')[1]!)

  // "A viewer may call it" and "another site may cause it to be called" are
  // different questions. Discovery reaches out to a URL from the request body.
  const fromElsewhere = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/sample/measurement-plan/compile-preview',
    headers: {
      cookie: `${USER_SESSION_COOKIE_NAME}=${token}`,
      origin: 'http://evil.localhost:4100',
      host: HOST,
    },
    payload: { schemaVersion: 1, targets: [], groups: [], targetQuerySelections: [] },
  })
  expect(fromElsewhere.statusCode).toBe(403)
})
