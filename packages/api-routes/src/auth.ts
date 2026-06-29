import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { apiKeys } from '@ainyc/canonry-db'
import { authRequired, authInvalid, forbidden, isReadOnlyKey } from '@ainyc/canonry-contracts'

/**
 * HTTP methods that mutate state. A read-only key is rejected on these; the
 * safe methods (GET / HEAD / OPTIONS) always pass so reads — and any future
 * CORS preflight — are never blocked.
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Resolved API key attached to every authenticated request. Used by scope
 * gates on sensitive routes — see `requireScope`.
 */
export interface AuthedApiKey {
  id: string
  name: string
  scopes: string[]
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The API key that authenticated the current request. Present on every
     * request that passed `authPlugin` (i.e. everything not in the
     * skip-paths list). Routes that need scope checks should call
     * `requireScope(request, '<scope>')`.
     */
    apiKey?: AuthedApiKey
  }
}

/**
 * Reject the request unless the authenticated key carries the named scope
 * (or the wildcard `'*'`). The wildcard is what `canonry init` writes for
 * the install's root key — operators don't have to opt in to existing
 * capabilities. Created delegate keys (when a key-management UI lands)
 * must declare their scopes explicitly to satisfy this gate.
 */
export function requireScope(request: FastifyRequest, scope: string): void {
  const key = request.apiKey
  // No key on the request means the auth plugin didn't run — happens when
  // `apiRoutes` is mounted with `skipAuth: true` (test harnesses, fixtures).
  // The deployable code path always registers `authPlugin` before routes,
  // so a real request without a key would have been rejected upstream.
  // Treat the absence as "auth not enforced" rather than as a deny — this
  // keeps the test harness ergonomic without weakening the prod gate.
  if (!key) return
  if (key.scopes.includes('*') || key.scopes.includes(scope)) return
  throw forbidden(`This action requires the "${scope}" scope on your API key.`)
}

/**
 * Hash a raw `cnry_…` bearer token to the value stored in `api_keys.key_hash`.
 * Plain SHA-256 is sufficient here because the tokens are 128-bit random, so a
 * 64-hex digest has no brute-force exposure. Exported so the key-management
 * routes (`keys.ts`) hash newly minted keys through the exact same function the
 * auth path verifies against — never duplicate the sha256 inline.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

const SKIP_PATHS = ['/health']

export function shouldSkipAuth(url: string): boolean {
  if (SKIP_PATHS.includes(url)) return true
  if (url.endsWith('/openapi.json')) return true
  // Both OAuth callback routes (`/google/callback` and
  // `/projects/:name/google/callback`) end with this suffix. `endsWith` (not
  // `includes`) so a future route that merely contains the substring — e.g.
  // `/google/callback/anything` — does not silently become unauthenticated.
  if (url.endsWith('/google/callback')) return true
  if (url.endsWith('/session') || url.endsWith('/session/setup')) return true
  // Cloudflare Worker ingest carries its own per-source bearer + HMAC
  // (verified inside the route handler). A canonry `cnry_*` key isn't
  // available to the Worker — that would defeat the per-source isolation.
  if (url.endsWith('/traffic/cloudflare/ingest')) return true
  return false
}

export interface AuthPluginOptions {
  sessionCookieName?: string
  resolveSessionApiKeyId?: (sessionId: string) => string | null | Promise<string | null>
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}

  return header
    .split(';')
    .map(part => part.trim())
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

export async function authPlugin(app: FastifyInstance, opts: AuthPluginOptions = {}) {
  app.addHook('onRequest', async (request) => {
    const url = request.url.split('?')[0]!
    if (shouldSkipAuth(url)) return

    const header = request.headers.authorization
    let key: typeof apiKeys.$inferSelect | undefined

    if (header) {
      const parts = header.split(' ')
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        throw authRequired()
      }

      const token = parts[1]!
      const hash = hashApiKey(token)

      key = app.db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, hash))
        .get()

      if (!key || key.revokedAt) {
        throw authInvalid()
      }
    } else if (opts.resolveSessionApiKeyId && opts.sessionCookieName) {
      const sessionId = parseCookies(request.headers.cookie)[opts.sessionCookieName]
      if (sessionId) {
        const apiKeyId = await opts.resolveSessionApiKeyId(sessionId)
        if (apiKeyId) {
          key = app.db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.id, apiKeyId))
            .get()
        }
      }

      if (!key || key.revokedAt) {
        throw authRequired()
      }
    } else {
      throw authRequired()
    }

    app.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, key.id))
      .run()

    // Attach the resolved key to the request so scope-gated routes can
    // inspect it without re-querying. `key.scopes` is a string[] from the
    // JSON column; the type assertion mirrors what Drizzle returns.
    const scopes = Array.isArray(key.scopes) ? key.scopes : []
    request.apiKey = { id: key.id, name: key.name, scopes }

    // Global read-only gate. A key that opted into read-only (`['read']`)
    // cannot perform any write — keyed off the HTTP method, NOT per-route
    // `requireScope` calls, so a newly added write route is protected
    // automatically. Safe methods (GET/HEAD/OPTIONS) always pass. This runs
    // after `shouldSkipAuth` (so public routes stay open) and does not gate
    // the `last_used_at` write above (infrastructural usage tracking).
    if (isReadOnlyKey(scopes) && WRITE_METHODS.has(request.method)) {
      throw forbidden('This API key is read-only and cannot perform write operations.')
    }
  })
}
