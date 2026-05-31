/**
 * Cookie-backed browser session plugin.
 *
 * Extracted from `packages/canonry/src/server.ts` so both the local
 * `canonry serve` daemon and the cloud `apps/api` Fastify server can
 * share the same routes and in-memory store. The plugin owns:
 *
 *   - `GET /session`         — session status + whether setup is required
 *   - `POST /session/setup`  — first-time password setup (single-tenant)
 *   - `POST /session`        — login with password or `cnry_…` bearer
 *   - `DELETE /session`      — logout (clear cookie + session record)
 *
 * The dashboard password storage differs between deployments — local
 * canonry serve keeps it in `~/.canonry/config.yaml`; apps/api keeps it
 * in the `app_settings` DB row. The plugin takes a `DashboardPasswordStore`
 * adapter so the storage strategy is the caller's concern.
 *
 * Sessions are deliberately in-process — that matches the existing
 * single-tenant deployment posture (one Cloud Run service per team,
 * one local daemon per operator). A restart logs everyone out, which
 * is exactly the right behavior for a single-tenant CLI tool. If we
 * ever move to multi-instance, sessions move into the DB.
 */

import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply } from 'fastify'

import rateLimit from '@fastify/rate-limit'
import { apiKeys, type DatabaseClient } from '@ainyc/canonry-db'
import { authInvalid, validationError } from '@ainyc/canonry-contracts'

// ─── Session store ───────────────────────────────────────────────────────────

interface SessionRecord {
  apiKeyId: string
  expiresAt: number
}

export interface SessionStore {
  /** Look up the apiKey bound to a session id, or null if expired/missing. */
  resolveSessionApiKeyId(sessionId: string): string | null
  /** Mint a fresh session id bound to the given apiKey, returning it. */
  createSession(apiKeyId: string): string
  /** Drop a session record. No-op if missing. */
  clearSession(sessionId: string | undefined): void
}

export interface CreateSessionStoreOptions {
  /** TTL for new sessions. Defaults to 12 hours. */
  ttlMs?: number
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000

export function createSessionStore(opts: CreateSessionStoreOptions = {}): SessionStore & { ttlMs: number } {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const sessions = new Map<string, SessionRecord>()

  const pruneExpired = () => {
    const now = Date.now()
    for (const [id, record] of sessions.entries()) {
      if (record.expiresAt <= now) sessions.delete(id)
    }
  }

  return {
    ttlMs,
    createSession(apiKeyId: string) {
      pruneExpired()
      const id = crypto.randomBytes(32).toString('hex')
      sessions.set(id, { apiKeyId, expiresAt: Date.now() + ttlMs })
      return id
    },
    resolveSessionApiKeyId(sessionId: string) {
      pruneExpired()
      const record = sessions.get(sessionId)
      if (!record) return null
      if (record.expiresAt <= Date.now()) {
        sessions.delete(sessionId)
        return null
      }
      return record.apiKeyId
    },
    clearSession(sessionId: string | undefined) {
      if (sessionId) sessions.delete(sessionId)
    },
  }
}

// ─── Password hashing ────────────────────────────────────────────────────────
//
// Dashboard passwords are user-chosen and may be reused from elsewhere, so a
// leaked config file must not be trivially cracked against a wordlist. We
// use salted scrypt (N=32768, ~80ms on a modern laptop) with a version field
// in the stored format so we can rotate to a stronger KDF later without
// breaking existing installs.
//
// Stored format: `scrypt$1$<base64-salt>$<base64-hash>`.
//
// Legacy unsalted SHA-256 hex hashes (from before this rewrite) are still
// accepted at login time; when one matches, the caller rewrites the config
// with a fresh scrypt hash so the next login no longer needs the legacy
// fallback path.

const DASHBOARD_SCRYPT_KEYLEN = 64
const DASHBOARD_SCRYPT_COST = 1 << 15
// Node's default scrypt `maxmem` is 32 MiB which is exactly at the boundary
// for our chosen N (128 * 32768 * 8 ≈ 32 MiB). Bump to 64 MiB to leave
// headroom and keep the derivation comfortably within the limit.
const DASHBOARD_SCRYPT_MAXMEM = 64 * 1024 * 1024

// `cnry_…` API keys are 128-bit cryptographically-random tokens (see
// `canonry init`), NOT user-chosen passwords. Fast SHA-256 is the correct
// choice for hashing high-entropy tokens — a slow KDF (scrypt/argon2) would
// add latency to every authenticated request for zero security gain, since
// there is no wordlist to brute-force against a 128-bit random value. User
// *passwords* use salted scrypt instead — see `hashDashboardPassword`.
// (CodeQL "insufficient computational effort" flags this as password
// hashing; it is a false positive for opaque tokens.)
function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

export function hashDashboardPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const derived = crypto.scryptSync(password, salt, DASHBOARD_SCRYPT_KEYLEN, {
    N: DASHBOARD_SCRYPT_COST,
    maxmem: DASHBOARD_SCRYPT_MAXMEM,
  })
  return `scrypt$1$${salt.toString('base64')}$${derived.toString('base64')}`
}

interface DashboardPasswordVerifyResult {
  ok: boolean
  /** True when the stored hash used the legacy SHA-256 format and the caller should rewrite. */
  needsRehash: boolean
}

export function verifyDashboardPassword(password: string, storedHash: string): DashboardPasswordVerifyResult {
  // New format: scrypt with salt.
  if (storedHash.startsWith('scrypt$1$')) {
    const parts = storedHash.split('$')
    if (parts.length !== 4) return { ok: false, needsRehash: false }
    const saltB64 = parts[2]
    const hashB64 = parts[3]
    if (!saltB64 || !hashB64) return { ok: false, needsRehash: false }
    let salt: Buffer
    let expected: Buffer
    try {
      salt = Buffer.from(saltB64, 'base64')
      expected = Buffer.from(hashB64, 'base64')
    } catch {
      return { ok: false, needsRehash: false }
    }
    const derived = crypto.scryptSync(password, salt, expected.length, {
      N: DASHBOARD_SCRYPT_COST,
      maxmem: DASHBOARD_SCRYPT_MAXMEM,
    })
    if (derived.length !== expected.length) return { ok: false, needsRehash: false }
    return { ok: crypto.timingSafeEqual(derived, expected), needsRehash: false }
  }

  // Legacy SHA-256 hex format — accept once for migration, then rehash.
  if (/^[a-f0-9]{64}$/i.test(storedHash)) {
    const candidate = Buffer.from(hashApiKey(password), 'hex')
    const expected = Buffer.from(storedHash, 'hex')
    if (candidate.length !== expected.length) return { ok: false, needsRehash: false }
    const ok = crypto.timingSafeEqual(candidate, expected)
    return { ok, needsRehash: ok }
  }

  return { ok: false, needsRehash: false }
}

// ─── Cookie helpers ──────────────────────────────────────────────────────────

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}

  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((cookies, part) => {
      const eqIdx = part.indexOf('=')
      if (eqIdx <= 0) return cookies
      const name = part.slice(0, eqIdx).trim()
      const value = part.slice(eqIdx + 1).trim()
      if (!name) return cookies
      try {
        cookies[name] = decodeURIComponent(value)
      } catch {
        cookies[name] = value
      }
      return cookies
    }, {})
}

interface SerializeCookieOpts {
  name: string
  value: string | null
  path: string
  secure: boolean
  ttlMs: number
}

function serializeSessionCookie(opts: SerializeCookieOpts): string {
  const parts = [
    `${opts.name}=${opts.value ? encodeURIComponent(opts.value) : ''}`,
    `Path=${opts.path}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  parts.push(opts.value ? `Max-Age=${Math.floor(opts.ttlMs / 1000)}` : 'Max-Age=0')
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

/**
 * Pluggable storage for the single dashboard password hash. Local canonry
 * serve wires this to `~/.canonry/config.yaml`; apps/api wires it to the
 * `app_settings` DB row. The plugin doesn't care which.
 */
export interface DashboardPasswordStore {
  /** Current scrypt-format (or legacy SHA-256) hash, or undefined if unconfigured. */
  get(): string | undefined
  /** Persist a freshly-computed hash. May be async for DB-backed stores. */
  set(hash: string): void | Promise<void>
}

export interface SessionRoutesOptions {
  db: DatabaseClient
  store: SessionStore
  /** Cookie name (must match what the api-routes auth plugin reads). */
  cookieName: string
  /** Cookie Path attribute. Use `basePath` so cookies scope to the install. */
  cookiePath: string
  /** Set `Secure` on the cookie. Should be true for HTTPS deployments. */
  cookieSecure: boolean
  /** Same TTL the store was created with. Used for the cookie's Max-Age. */
  ttlMs: number
  /** Where the dashboard password hash lives. */
  dashboardPassword: DashboardPasswordStore
  /**
   * Lookup the install's default API key — the one bound to password
   * sessions. Local canonry maps this to `config.apiKey`; apps/api can
   * either pin a single key or use the first non-revoked apiKey row.
   */
  getDefaultApiKey: () => { id: string; revokedAt?: string | null } | undefined
}

/**
 * Mount /session, /session/setup, DELETE /session under the registering
 * Fastify scope. Caller is responsible for the API prefix and for excluding
 * these paths from the auth hook (the api-routes auth plugin already
 * does that via `shouldSkipAuth`).
 */
export async function sessionRoutes(app: FastifyInstance, opts: SessionRoutesOptions) {
  // Brute-force guard. `@fastify/rate-limit` is scoped to THIS encapsulated
  // plugin instance, which contains only the (sensitive) /session routes —
  // so it never throttles the main dashboard/API surface. In-memory store
  // matches the single-tenant deployment posture. The 30/min default covers
  // status + logout; login + setup tighten to 10/min via per-route config.
  await app.register(rateLimit, { global: true, max: 30, timeWindow: '1 minute' })

  const createPasswordSession = (reply: FastifyReply): boolean => {
    const key = opts.getDefaultApiKey()
    if (!key || key.revokedAt) return false

    const sessionId = opts.store.createSession(key.id)
    reply.header('set-cookie', serializeSessionCookie({
      name: opts.cookieName,
      value: sessionId,
      path: opts.cookiePath,
      secure: opts.cookieSecure,
      ttlMs: opts.ttlMs,
    }))
    return true
  }

  app.get('/session', async (request, reply) => {
    const sessionId = parseCookies(request.headers.cookie)[opts.cookieName]
    return reply.send({
      authenticated: Boolean(sessionId && opts.store.resolveSessionApiKeyId(sessionId)),
      setupRequired: !opts.dashboardPassword.get(),
    })
  })

  // First-time password setup. Only works when no password is configured yet.
  app.post<{
    Body: { password?: string }
  }>('/session/setup', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (opts.dashboardPassword.get()) {
      throw validationError('Dashboard password is already configured')
    }

    const password = request.body?.password?.trim()
    if (!password || password.length < 8) {
      throw validationError('Password must be at least 8 characters')
    }

    await opts.dashboardPassword.set(hashDashboardPassword(password))

    if (!createPasswordSession(reply)) {
      throw authInvalid()
    }
    return reply.send({ authenticated: true })
  })

  // Login with dashboard password or `cnry_…` bearer.
  app.post<{
    Body: { password?: string; apiKey?: string }
  }>('/session', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const password = request.body?.password?.trim()
    const apiKey = request.body?.apiKey?.trim()

    if (password) {
      const stored = opts.dashboardPassword.get()
      if (!stored) {
        throw validationError('No dashboard password configured — use /session/setup first')
      }
      const verification = verifyDashboardPassword(password, stored)
      if (!verification.ok) {
        return reply.status(401).send({ error: { code: 'AUTH_INVALID', message: 'Incorrect password' } })
      }
      // Transparent migration: a successful login against the legacy
      // unsalted SHA-256 hash rewrites the store with a fresh scrypt hash
      // so the next login no longer needs the legacy fallback path.
      if (verification.needsRehash) {
        await opts.dashboardPassword.set(hashDashboardPassword(password))
      }
      if (!createPasswordSession(reply)) {
        return reply.status(401).send({ error: { code: 'AUTH_INVALID', message: 'Server API key not found — re-run canonry init' } })
      }
      return reply.send({ authenticated: true })
    }

    if (apiKey) {
      const key = opts.db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, hashApiKey(apiKey)))
        .get()

      if (!key || key.revokedAt) {
        throw authInvalid()
      }

      opts.db
        .update(apiKeys)
        .set({ lastUsedAt: new Date().toISOString() })
        .where(eq(apiKeys.id, key.id))
        .run()

      const sessionId = opts.store.createSession(key.id)
      reply.header('set-cookie', serializeSessionCookie({
        name: opts.cookieName,
        value: sessionId,
        path: opts.cookiePath,
        secure: opts.cookieSecure,
        ttlMs: opts.ttlMs,
      }))
      return reply.send({ authenticated: true })
    }

    throw validationError('Either password or apiKey is required')
  })

  // Logout uses the plugin's 30/min default (no per-route override needed).
  app.delete('/session', async (request, reply) => {
    const sessionId = parseCookies(request.headers.cookie)[opts.cookieName]
    opts.store.clearSession(sessionId)
    reply.header('set-cookie', serializeSessionCookie({
      name: opts.cookieName,
      value: null,
      path: opts.cookiePath,
      secure: opts.cookieSecure,
      ttlMs: opts.ttlMs,
    }))
    return reply.status(204).send()
  })
}
