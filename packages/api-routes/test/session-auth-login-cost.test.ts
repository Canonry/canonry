/**
 * P1.2 — the sign-in route is public, and verifying a password is deliberately
 * expensive. Those two facts together are a denial-of-service unless the cost
 * is both OFF the event loop and admitted under a budget.
 *
 * The per-name counter alone does not do it: an attacker who never repeats a
 * name never trips it, and every one of those attempts still costs a full
 * derivation. These tests hold both halves.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { apiKeys, createClient, migrate, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
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

const ROOT_KEY = 'cnry_login_cost_root'
const ADMIN_PASSWORD = 'a-long-enough-admin-password'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

function login(name: string, remoteAddress = '203.0.113.7') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress,
    headers: { origin: 'http://localhost:4100', host: 'localhost:4100' },
    payload: { name, password: 'whatever-they-guessed' },
  })
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-login-cost-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'root',
    keyHash: hashApiKey(ROOT_KEY),
    keyPrefix: ROOT_KEY.slice(0, 9),
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()

  app = Fastify()
  app.register(apiRoutes, { db })
  await app.ready()

  await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: { authorization: `Bearer ${ROOT_KEY}` },
    payload: { name: 'owner', password: ADMIN_PASSWORD, role: 'admin' },
  })
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('verifying a password does not hold the event loop', async () => {
  const digest = await hashUserPassword(ADMIN_PASSWORD)

  // A timer queued immediately before the derivation. If the derivation runs
  // on the loop, this callback cannot possibly fire until it is finished.
  let timerFired = false
  setTimeout(() => { timerFired = true }, 0)

  await verifyUserPassword('a-wrong-guess', digest)

  expect(timerFired).toBe(true)
})

test('hashing a password does not hold the event loop either', async () => {
  let timerFired = false
  setTimeout(() => { timerFired = true }, 0)

  await hashUserPassword(ADMIN_PASSWORD)

  expect(timerFired).toBe(true)
})

test('a caller who never repeats a name still runs out of budget', async () => {
  // The per-name counter is useless here on purpose: every attempt is a name
  // nobody has ever used. What has to stop it is the budget for the CALLER.
  const statuses: number[] = []
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await login(`nobody-${attempt}-${crypto.randomUUID()}`)
    statuses.push(res.statusCode)
  }

  expect(statuses).toContain(429)
  // And it has to bite well before 40 full derivations have been paid for.
  expect(statuses.indexOf(429)).toBeLessThan(35)
})

test('one exhausted caller does not lock everybody else out', async () => {
  for (let attempt = 0; attempt < 40; attempt++) {
    await login(`nobody-${attempt}`, '203.0.113.7')
  }
  expect((await login('nobody-again', '203.0.113.7')).statusCode).toBe(429)

  // A different caller has spent nothing and is unaffected.
  const other = await login('someone-else', '198.51.100.4')
  expect(other.statusCode).toBe(401)
})

test('the server still answers an unrelated request during a burst of sign-ins', async () => {
  // This asserted `elapsed < 400` for a while. That is a claim about how fast
  // the machine is, not about the server, and it flaked on any loaded or slower
  // one. It also never earned its name: forcing the derivation back onto the
  // event loop (`scryptSync`) leaves this test green in every formulation I
  // tried — a wall-clock bound, a settled-before-me ordering check, and the same
  // with the handlers given a tick to start. The two tests above are what
  // actually hold that property, and they DO fail under that mutation, because
  // they assert on a timer queued around the derivation rather than on a clock.
  //
  // So this is an integration smoke check and is written as one: 24 concurrent
  // unauthenticated derivations are in flight, and an unrelated route still
  // answers. No timing claim, nothing that can rot into a false guarantee.
  const burst = Promise.all(Array.from({ length: 24 }, (_, index) =>
    login(`nobody-${index}`, `198.51.100.${index % 200}`)))

  const health = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
  expect(health.statusCode).toBe(200)

  // And the burst itself still resolves — every attempt gets an answer rather
  // than hanging behind the budget.
  const statuses = (await burst).map(response => response.statusCode)
  expect(statuses).toHaveLength(24)
  expect(statuses.every(status => status === 401 || status === 429)).toBe(true)
})

test('a correct password still signs in once the guessing stops', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: '192.0.2.55',
    headers: { origin: 'http://localhost:4100', host: 'localhost:4100' },
    payload: { name: 'owner', password: ADMIN_PASSWORD },
  })
  expect(res.statusCode).toBe(200)
})
