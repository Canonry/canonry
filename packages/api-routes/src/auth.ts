import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { apiKeys, projects, runs } from '@ainyc/canonry-db'
import {
  ADS_WRITE_SCOPE,
  authRequired,
  authInvalid,
  forbidden,
  isReadOnlyKey,
  normalizeIdTokens,
  RunKinds,
  splitList,
} from '@ainyc/canonry-contracts'

/**
 * HTTP methods that mutate state. A read-only key is rejected on these; the
 * safe methods (GET / HEAD / OPTIONS) always pass so reads — and any future
 * CORS preflight — are never blocked.
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function isAdsWriteOnlyKey(scopes: readonly string[]): boolean {
  const writeGrants = scopes.filter((scope) =>
    scope === '*' || scope === 'write' || scope.endsWith('.write'))
  return writeGrants.length === 1 && writeGrants[0] === ADS_WRITE_SCOPE
}

function isAdsWriteRoute(url: string): boolean {
  const rest = projectRouteRest(url)
  return rest !== null && rest.startsWith('ads/')
}

/**
 * Resolved API key attached to every authenticated request. Used by scope
 * gates on sensitive routes — see `requireScope`.
 */
export interface AuthedApiKey {
  id: string
  name: string
  scopes: string[]
  /**
   * When set, the key is scoped to this single project id. The `authPlugin`
   * project gate + `assertProjectScope` enforce it. Absent/null = the
   * historical full-instance access.
   */
  projectId?: string | null
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
 * Enforce a project-scoped key against a project id resolved from an ENTITY
 * (a run, snapshot, …) rather than the URL. The `authPlugin` project gate
 * already covers every `/projects/<name>` route; call this in the handful of
 * routes that address an entity by id (e.g. `/runs/:id`, `/screenshots/:id`)
 * AFTER loading the entity, passing the entity's `projectId`. A full-instance
 * key (no `projectId`) or an unauthenticated request passes.
 */
export function assertProjectScope(request: FastifyRequest, projectId: string): void {
  const scoped = request.apiKey?.projectId
  if (scoped && scoped !== projectId) {
    throw forbidden('This API key is scoped to a different project.')
  }
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

function shouldSkipAuth(url: string): boolean {
  if (SKIP_PATHS.includes(url)) return true
  if (url.endsWith('/openapi.json')) return true
  // Both OAuth callback routes (`/google/callback` and
  // `/projects/:name/google/callback`) end with this suffix. `endsWith` (not
  // `includes`) so a future route that merely contains the substring — e.g.
  // `/google/callback/anything` — does not silently become unauthenticated.
  if (url.endsWith('/google/callback')) return true
  if (url.endsWith('/session') || url.endsWith('/session/setup')) return true
  return false
}

export interface AuthPluginOptions {
  sessionCookieName?: string
  resolveSessionApiKeyId?: (sessionId: string) => string | null | Promise<string | null>
  /**
   * When set, the server is running in embed mode and this is the effective
   * project-tab allowlist. It is a server-side data boundary layered on top of
   * the read-only/project-scoped key: hidden tabs' API reads are rejected even
   * if a client forges the URL.
   */
  embedProjectTabs?: readonly string[]
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

function queryValue(request: FastifyRequest, key: string): string | undefined {
  const raw = (request.query as Record<string, unknown> | undefined)?.[key]
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0]
  return undefined
}

function requestEmbedProjectTabs(request: FastifyRequest, fallback: readonly string[] | undefined): string[] | undefined {
  const headerTabs = normalizeIdTokens(splitList(request.headers['x-canonry-embed-tabs']))
  if (headerTabs) return headerTabs
  return fallback && fallback.length > 0 ? [...fallback] : undefined
}

function projectRouteRest(url: string): string | null {
  const match = url.match(/\/projects\/[^/]+(?:\/([^?#]*))?$/)
  if (!match) return null
  return match[1] ?? ''
}

function isGlobalAnswerVisibilityRunsList(request: FastifyRequest, url: string): boolean {
  if (!url.endsWith('/runs')) return false
  const kind = queryValue(request, 'kind')
  return kind === RunKinds['answer-visibility']
}

function isAnswerVisibilityRunsList(request: FastifyRequest, rest: string): boolean {
  if (rest !== 'runs') return false
  const kind = queryValue(request, 'kind')
  return kind === RunKinds['answer-visibility']
}

function isAnswerVisibilityRunDetail(request: FastifyRequest, url: string): boolean {
  const runMatch = url.match(/\/runs\/([^/?#]+)$/)
  if (!runMatch) return false
  const run = request.server.db
    .select({ kind: runs.kind })
    .from(runs)
    .where(eq(runs.id, decodeURIComponent(runMatch[1]!)))
    .get()
  // Unknown ids continue downstream to the route's normal 404. Existing
  // answer-visibility ids are safe for the project dashboard evidence drawer.
  return !run || run.kind === RunKinds['answer-visibility']
}

function isProjectShellRead(request: FastifyRequest, url: string): boolean {
  if (url.endsWith('/projects')) return true
  if (isGlobalAnswerVisibilityRunsList(request, url)) return true

  const rest = projectRouteRest(url)
  if (rest === null) return isAnswerVisibilityRunDetail(request, url)

  return rest === '' || isAnswerVisibilityRunsList(request, rest)
}

function isOverviewRead(url: string): boolean {
  const rest = projectRouteRest(url)
  if (rest === null) return false
  return new Set([
    'queries',
    'competitors',
    'timeline',
    'overview',
    'analytics/metrics',
    'google/gsc/coverage',
    'bing/coverage',
    'insights',
    'citations/visibility',
  ]).has(rest)
}

function isTechnicalAeoRead(url: string): boolean {
  const rest = projectRouteRest(url)
  return rest === 'technical-aeo' || rest === 'technical-aeo/pages' || rest === 'technical-aeo/trend'
}

function isReportRead(url: string): boolean {
  const rest = projectRouteRest(url)
  return rest === 'report' || rest === 'report.html'
}

function enforceEmbedProjectTabs(request: FastifyRequest, configuredTabs: readonly string[] | undefined): void {
  const tabs = requestEmbedProjectTabs(request, configuredTabs)
  if (!tabs || tabs.length === 0) return
  if (request.method === 'OPTIONS') return

  // In embed mode with a tab allowlist, the public iframe is a read surface.
  // The read-only key already blocks writes, but this makes the tab policy
  // independent of key shape and future write routes.
  if (WRITE_METHODS.has(request.method)) {
    throw forbidden('This endpoint is not available in embed mode.')
  }

  const url = request.url.split('?')[0]!
  if (isProjectShellRead(request, url)) return
  if (tabs.includes('overview') && isOverviewRead(url)) return
  if (tabs.includes('technical-aeo') && isTechnicalAeoRead(url)) return
  if (tabs.includes('report') && isReportRead(url)) return

  throw forbidden('This endpoint is not available for the configured embed tabs.')
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
    request.apiKey = { id: key.id, name: key.name, scopes, projectId: key.projectId ?? null }

    // Global read-only gate. A key that opted into read-only (`['read']`)
    // cannot perform any write — keyed off the HTTP method, NOT per-route
    // `requireScope` calls, so a newly added write route is protected
    // automatically. Safe methods (GET/HEAD/OPTIONS) always pass. This runs
    // after `shouldSkipAuth` (so public routes stay open) and does not gate
    // the `last_used_at` write above (infrastructural usage tracking).
    if (isReadOnlyKey(scopes) && WRITE_METHODS.has(request.method)) {
      throw forbidden('This API key is read-only and cannot perform write operations.')
    }

    // `ads.write` is the first delegated operator scope used by an autonomous
    // external client. Keep a key whose only write grant is ads.write inside
    // the project's `/ads/*` surface even though older write routes still rely
    // on the historical read-only-vs-write classifier. Every ads mutation also
    // calls requireScope(), so the route and the key must agree in both
    // directions. Wildcard/root keys retain the existing full-instance access.
    if (
      isAdsWriteOnlyKey(scopes) &&
      WRITE_METHODS.has(request.method) &&
      !isAdsWriteRoute(url)
    ) {
      throw forbidden('This API key can only perform OpenAI Ads write operations.')
    }

    enforceEmbedProjectTabs(request, opts.embedProjectTabs)

    // Project-scope gate. A key bound to a single project (`project_id` set) may
    // only touch THAT project. The project name is the first `/projects/<name>`
    // path segment (the project-scoped routes are all mounted there); resolve it
    // and 403 on a mismatch. NULL project_id — every historical key — skips this
    // and keeps full-instance access. Routes that address an entity by id (e.g.
    // `/runs/:id`) are not in the URL; they call `assertProjectScope()` after
    // loading the entity's project.
    if (key.projectId) {
      const match = url.match(/\/projects\/([^/?#]+)/)
      if (match) {
        const projectName = decodeURIComponent(match[1]!)
        const scoped = app.db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.name, projectName))
          .get()
        if (!scoped || scoped.id !== key.projectId) {
          throw forbidden('This API key is scoped to a different project.')
        }
      }
    }
  })
}
