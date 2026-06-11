import crypto from 'node:crypto'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'

import type { PlatformEnv } from '@ainyc/canonry-config'
import { parseBooleanFlag } from '@ainyc/canonry-contracts'
import { createClient, migrate, apiKeys, appSettings } from '@ainyc/canonry-db'
import {
  apiRoutes,
  createSessionStore,
  sessionRoutes,
  type DashboardPasswordStore,
} from '@ainyc/canonry-api-routes'

import { registerHealthRoutes } from './routes/health.js'

const SESSION_COOKIE_NAME = 'canonry_session'
const DASHBOARD_PASSWORD_KEY = 'dashboard_password_hash'

// Hashes the opaque `cnry_…` API key (a 128-bit random token, not a
// user password) for the api_keys lookup. Fast SHA-256 is correct here —
// there is no wordlist to brute-force a high-entropy token, so a slow KDF
// would only add per-request latency. Dashboard passwords use salted scrypt
// (packages/api-routes session plugin). (CodeQL flags this as weak password
// hashing — false positive for opaque tokens.)
function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

export function buildApp(env: PlatformEnv) {
  const app = Fastify({
    logger: true,
    // Cloud Run sits behind Google's front end, which appends the real
    // client IP as the rightmost X-Forwarded-For entry. Trusting exactly
    // that hop count (default 1, CANONRY_TRUST_PROXY_HOPS) makes
    // `request.ip` the per-client address, so the session + guest-report
    // rate limiters key per client instead of pooling everyone into the
    // proxy's single bucket. `trustProxy: true` would be wrong here — it
    // takes the leftmost XFF entry, which the client controls.
    trustProxy: env.trustProxyHops > 0 ? env.trustProxyHops : false,
  })

  // Connect to database and register shared API routes. Run migrations
  // up-front — apps/api is the entry point for cloud deployments, so the
  // operator has no prior CLI step that would have applied them.
  const db = createClient(env.databaseUrl)
  migrate(db)

  const providerSummary = (['gemini', 'openai', 'claude', 'perplexity'] as const).map(name => ({
    name,
    model: env.providers[name]?.model,
    configured: !!env.providers[name],
    quota: env.providers[name]?.quota,
  }))

  // Seed the install's default API key into the api_keys table when set.
  // The same pattern lives in `packages/canonry/src/server.ts`. Without this
  // row, dashboard-password sessions have no apiKey to bind to.
  if (env.apiKey) {
    const keyHash = hashApiKey(env.apiKey)
    const existing = db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).get()
    if (!existing) {
      const prefix = env.apiKey.slice(0, 12)
      db.insert(apiKeys).values({
        id: `key_${crypto.randomBytes(8).toString('hex')}`,
        name: 'default',
        keyHash,
        keyPrefix: prefix,
        scopes: ['*'],
        createdAt: new Date().toISOString(),
      }).run()
    }
  }

  // Cookie-backed browser session. Cloud Run instances have no writable
  // local config file, so the dashboard password hash lives in the
  // `app_settings` DB row instead of `~/.canonry/config.yaml`.
  const apiPrefix = env.basePath === '/' ? '/api/v1' : `${env.basePath.replace(/\/$/, '')}/api/v1`
  const sessionCookiePath = env.basePath === '/' ? '/' : env.basePath.replace(/\/?$/, '/')
  const sessionCookieSecure = Boolean(env.publicUrl?.startsWith('https://'))
  const sessionStore = createSessionStore()

  const dashboardPassword: DashboardPasswordStore = {
    get: () => {
      const row = db.select().from(appSettings).where(eq(appSettings.key, DASHBOARD_PASSWORD_KEY)).get()
      return row?.value
    },
    set: (hash) => {
      const now = new Date().toISOString()
      db.insert(appSettings)
        .values({ key: DASHBOARD_PASSWORD_KEY, value: hash, updatedAt: now })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: hash, updatedAt: now },
        })
        .run()
    },
  }

  // Register session routes BEFORE the main api-routes plugin so the
  // cookie can be issued before any auth-gated route runs. The
  // api-routes auth hook already skips /session* via shouldSkipAuth.
  app.register(async (scope) => {
    await sessionRoutes(scope, {
      db,
      store: sessionStore,
      cookieName: SESSION_COOKIE_NAME,
      cookiePath: sessionCookiePath,
      cookieSecure: sessionCookieSecure,
      ttlMs: sessionStore.ttlMs,
      dashboardPassword,
      getDefaultApiKey: () => {
        if (!env.apiKey) return undefined
        return db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.keyHash, hashApiKey(env.apiKey)))
          .get()
      },
      // Cloud Run is always network-reachable — and deliberately public for
      // the guest-report funnel — so the first-run password setup must
      // always demand a valid bearer key. Without this, any first visitor
      // to a fresh deployment could claim the dashboard password and mint
      // a full-access `*` session (#690).
      setupRequiresApiKey: true,
    })
  }, { prefix: apiPrefix })

  app.register(apiRoutes, {
    db,
    skipAuth: false,
    routePrefix: apiPrefix,
    sessionCookieName: SESSION_COOKIE_NAME,
    // Arrow-wrap so `this` stays bound when the auth plugin invokes it
    // detached from the store (eslint @typescript-eslint/unbound-method).
    resolveSessionApiKeyId: (sid) => sessionStore.resolveSessionApiKeyId(sid),
    openApiInfo: {
      title: 'Canonry API',
      version: '0.1.0',
    },
    providerSummary,
    googleStateSecret: env.googleStateSecret,
    // Reported by POST /cloud/bootstrap so the control plane records what
    // runtime it provisioned. apps/api versions independently of the
    // published @ainyc/canonry package.
    canonryVersion: '0.1.0',
    // The hosted control-plane callback typically resolves to a private
    // address (Docker bridge / VPC) — same env opt-in as `canonry serve`.
    allowPrivateNetworkWebhooks: parseBooleanFlag(process.env.CANONRY_ALLOW_PRIVATE_WEBHOOKS),
  })

  registerHealthRoutes(app, env)

  return app
}
