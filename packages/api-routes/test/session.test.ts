import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'
import {
  createSessionStore,
  sessionRoutes,
  hashDashboardPassword,
  verifyDashboardPassword,
  type DashboardPasswordStore,
} from '../src/index.js'

/**
 * Tests for the extracted session plugin. Covers:
 *
 *   1. Password hashing roundtrip (scrypt + legacy SHA-256 migration).
 *   2. In-memory session store TTL / lifecycle.
 *   3. The Fastify routes — status, setup, login (password + bearer), logout.
 *
 * The plugin previously lived inline in `packages/canonry/src/server.ts`
 * with no test coverage; extracting it is also the moment to lock the
 * invariants down so a future refactor can't silently break the dashboard
 * login or the Aero owner-view claim flow.
 */

function makeDashboardStore(initial?: string): DashboardPasswordStore & { current: () => string | undefined } {
  let value = initial
  return {
    get: () => value,
    set: (hash) => {
      value = hash
    },
    current: () => value,
  }
}

function makeApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-session-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  // Seed a default API key. Password sessions bind to this key.
  const keyId = `key_${crypto.randomBytes(8).toString('hex')}`
  const keyHash = crypto.createHash('sha256').update('cnry_test').digest('hex')
  db.insert(apiKeys).values({
    id: keyId,
    name: 'default',
    keyHash,
    keyPrefix: 'cnry_test',
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()

  const store = createSessionStore()
  const dashboardPassword = makeDashboardStore()

  const app = Fastify()
  app.register(async (scope) => {
    await sessionRoutes(scope, {
      db,
      store,
      cookieName: 'test_session',
      cookiePath: '/',
      cookieSecure: false,
      ttlMs: store.ttlMs,
      dashboardPassword,
      getDefaultApiKey: () => ({ id: keyId }),
    })
  }, { prefix: '/api/v1' })

  return { app, db, store, dashboardPassword, tmpDir, keyId, rawKey: 'cnry_test' }
}

describe('hashDashboardPassword / verifyDashboardPassword', () => {
  it('roundtrips a password via scrypt', () => {
    const hash = hashDashboardPassword('hunter2-correct-horse')
    expect(hash.startsWith('scrypt$1$')).toBe(true)
    expect(verifyDashboardPassword('hunter2-correct-horse', hash)).toEqual({ ok: true, needsRehash: false })
  })

  it('rejects the wrong password', () => {
    const hash = hashDashboardPassword('rightpw1')
    expect(verifyDashboardPassword('wrongpw1', hash)).toEqual({ ok: false, needsRehash: false })
  })

  it('verifies legacy SHA-256 hex hashes once, with needsRehash=true', () => {
    const legacyHash = crypto.createHash('sha256').update('legacy-pw-1234').digest('hex')
    expect(verifyDashboardPassword('legacy-pw-1234', legacyHash)).toEqual({ ok: true, needsRehash: true })
    expect(verifyDashboardPassword('wrong-pw', legacyHash)).toEqual({ ok: false, needsRehash: false })
  })

  it('rejects malformed scrypt entries without throwing', () => {
    expect(verifyDashboardPassword('anything', 'scrypt$1$broken')).toEqual({ ok: false, needsRehash: false })
    expect(verifyDashboardPassword('anything', 'totally-not-a-hash')).toEqual({ ok: false, needsRehash: false })
  })
})

describe('createSessionStore', () => {
  it('issues fresh ids and resolves them to the bound apiKey', () => {
    const store = createSessionStore()
    const sid = store.createSession('key_abc')
    expect(sid).toHaveLength(64) // 32-byte hex
    expect(store.resolveSessionApiKeyId(sid)).toBe('key_abc')
  })

  it('returns null for unknown sessions', () => {
    const store = createSessionStore()
    expect(store.resolveSessionApiKeyId('does-not-exist')).toBe(null)
  })

  it('drops sessions past TTL', async () => {
    const store = createSessionStore({ ttlMs: 10 })
    const sid = store.createSession('key_x')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(store.resolveSessionApiKeyId(sid)).toBe(null)
  })

  it('clearSession removes the record', () => {
    const store = createSessionStore()
    const sid = store.createSession('key_y')
    store.clearSession(sid)
    expect(store.resolveSessionApiKeyId(sid)).toBe(null)
  })

  it('clearSession with undefined is a no-op', () => {
    const store = createSessionStore()
    const sid = store.createSession('key_z')
    store.clearSession(undefined)
    expect(store.resolveSessionApiKeyId(sid)).toBe('key_z')
  })
})

describe('session routes', () => {
  let ctx: ReturnType<typeof makeApp>

  beforeEach(() => {
    ctx = makeApp()
  })

  afterEach(async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('GET /session reports setupRequired=true before a password is set', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/session' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ authenticated: false, setupRequired: true })
  })

  it('POST /session/setup rejects passwords under 8 chars', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      payload: { password: 'short' },
    })
    expect(res.statusCode).toBe(400)
    expect(ctx.dashboardPassword.current()).toBeUndefined()
  })

  it('POST /session/setup stores a scrypt hash, sets a cookie, and authenticates', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      payload: { password: 'a-real-password-1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ authenticated: true })

    const cookie = res.headers['set-cookie']
    expect(cookie).toMatch(/test_session=/)
    expect(cookie).toMatch(/HttpOnly/)
    expect(ctx.dashboardPassword.current()).toMatch(/^scrypt\$1\$/)
  })

  it('POST /session/setup refuses when a password already exists', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      payload: { password: 'first-password-1' },
    })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      payload: { password: 'second-password-2' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /session with a correct password issues a session cookie', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      payload: { password: 'login-test-pwd-1' },
    })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { password: 'login-test-pwd-1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ authenticated: true })
    expect(res.headers['set-cookie']).toMatch(/test_session=/)
  })

  it('POST /session returns 401 for a wrong password', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      payload: { password: 'correct-password-1' },
    })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { password: 'wrong-password-9' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('AUTH_INVALID')
  })

  it('POST /session accepts a valid cnry_ bearer token', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { apiKey: ctx.rawKey },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['set-cookie']).toMatch(/test_session=/)
  })

  it('POST /session rejects an unknown apiKey', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { apiKey: 'cnry_unknown_key' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('POST /session requires either password or apiKey', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('GET /session after login reports authenticated=true', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      payload: { password: 'auth-check-pwd-1' },
    })
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { password: 'auth-check-pwd-1' },
    })
    const cookie = login.headers['set-cookie']!
    const sessionCookie = (Array.isArray(cookie) ? cookie[0] : cookie).split(';')[0]

    const status = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: sessionCookie },
    })
    expect(status.json()).toEqual({ authenticated: true, setupRequired: false })
  })

  it('DELETE /session clears the cookie', async () => {
    const res = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/session' })
    expect(res.statusCode).toBe(204)
    const cookie = res.headers['set-cookie']
    expect(cookie).toMatch(/Max-Age=0/)
  })

  it('transparently rehashes a legacy SHA-256 password on first successful login', async () => {
    const legacyHash = crypto.createHash('sha256').update('legacy-login-pw-1').digest('hex')
    ctx.dashboardPassword.set(legacyHash)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { password: 'legacy-login-pw-1' },
    })
    expect(res.statusCode).toBe(200)
    // The stored hash should now be in scrypt format.
    expect(ctx.dashboardPassword.current()).toMatch(/^scrypt\$1\$/)
  })

  it('rate-limits repeated password-login attempts with 429 (brute-force guard)', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      payload: { password: 'brute-force-target-1' },
    })

    // The login limiter allows 10/min; the 11th wrong-password attempt from
    // the same IP must be rejected with 429 (QUOTA_EXCEEDED), not another 401.
    let saw429 = false
    let attempts = 0
    for (let i = 0; i < 15; i++) {
      attempts++
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { password: 'wrong-guess-xxxx' },
      })
      if (res.statusCode === 429) {
        // 429 = QUOTA_EXCEEDED (AppError.statusCode). The canonry
        // `{error:{code}}` envelope is applied by the global error handler
        // in the full apiRoutes plugin; this isolated harness uses Fastify's
        // default serializer, so we assert on the status code here.
        saw429 = true
        break
      }
      expect(res.statusCode).toBe(401)
    }
    expect(saw429).toBe(true)
    // The guard should trip right after the 10-request window, not let all 15 through.
    expect(attempts).toBeLessThanOrEqual(11)
  })

  it('does not rate-limit a normal login burst under the threshold', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      payload: { password: 'normal-usage-pwd-1' },
    })
    // 5 legitimate logins in a row stay well under the 10/min cap.
    for (let i = 0; i < 5; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { password: 'normal-usage-pwd-1' },
      })
      expect(res.statusCode).toBe(200)
    }
  })
})
