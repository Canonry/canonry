import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'

const _require = createRequire(import.meta.url)
const { version: PKG_VERSION } = _require('../package.json') as { version: string }
import Fastify from 'fastify'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { apiKeys, auditLog, projects, parseJsonColumn, extractLegacyCredentials, dropLegacyCredentialColumns, type DatabaseClient, type LegacyCredentialRows } from '@ainyc/canonry-db'
import os from 'node:os'
import { geminiAdapter } from '@ainyc/canonry-provider-gemini'
import { openaiAdapter } from '@ainyc/canonry-provider-openai'
import { claudeAdapter } from '@ainyc/canonry-provider-claude'
import { localAdapter } from '@ainyc/canonry-provider-local'
import { cdpChatgptAdapter } from '@ainyc/canonry-provider-cdp'
import { perplexityAdapter } from '@ainyc/canonry-provider-perplexity'
import { authInvalid, validationError, type ProviderAdapter } from '@ainyc/canonry-contracts'
import type { CanonryConfig, ProviderConfigEntry } from './config.js'
import { saveConfigPatch, loadConfig } from './config.js'
import {
  getGoogleAuthConfig,
  getGoogleConnection,
  listGoogleConnections,
  patchGoogleConnection,
  removeGoogleConnection,
  setGoogleAuthConfig,
  upsertGoogleConnection,
} from './google-config.js'
import {
  getGa4Connection,
  upsertGa4Connection,
  removeGa4Connection,
} from './ga4-config.js'
import {
  getWordpressConnection,
  patchWordpressConnection,
  removeWordpressConnection,
  upsertWordpressConnection,
} from './wordpress-config.js'
import { isTelemetryEnabled, getOrCreateAnonymousId } from './telemetry.js'
import { JobRunner } from './job-runner.js'
import { executeGscSync } from './gsc-sync.js'
import { executeInspectSitemap } from './gsc-inspect-sitemap.js'
import { executeReleaseSync } from './commoncrawl-sync.js'
import { executeBacklinkExtract } from './backlink-extract.js'
import {
  DUCKDB_SPEC,
  PLUGIN_DIR,
  installDuckdb,
  isDuckdbInstalled,
  listCachedReleases as listCachedReleasesFromDisk,
  pruneCachedRelease,
  readInstalledVersion,
} from '@ainyc/canonry-integration-commoncrawl'
import { ccReleaseSyncs as ccReleaseSyncsTable } from '@ainyc/canonry-db'
import { ProviderRegistry } from './provider-registry.js'
import { Scheduler } from './scheduler.js'
import { Notifier } from './notifier.js'
import { IntelligenceService } from './intelligence-service.js'
import { RunCoordinator } from './run-coordinator.js'
import { SessionRegistry } from './agent/session-registry.js'
import { registerAgentRoutes } from './agent/agent-routes.js'
import { ApiClient } from './client.js'
import { SnapshotService } from './snapshot-service.js'
import { fetchSiteText } from './site-fetch.js'
import { createLogger } from './logger.js'

const log = createLogger('Server')

const DEFAULT_QUOTA = {
  maxConcurrency: 2,
  maxRequestsPerMinute: 10,
  maxRequestsPerDay: 1000,
}

const SESSION_COOKIE_NAME = 'canonry_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000

interface SessionRecord {
  apiKeyId: string
  expiresAt: number
}

/** All known API adapters — add new providers here */
const API_ADAPTERS: ProviderAdapter[] = [
  geminiAdapter, openaiAdapter, claudeAdapter, localAdapter, perplexityAdapter,
]

/** All known browser (CDP) adapters */
const BROWSER_ADAPTERS: ProviderAdapter[] = [
  cdpChatgptAdapter,
]

const ALL_ADAPTERS: ProviderAdapter[] = [...API_ADAPTERS, ...BROWSER_ADAPTERS]

const adapterMap = Object.fromEntries(
  API_ADAPTERS.map(a => [a.name, a]),
) as Record<string, ProviderAdapter>

function summarizeProviderConfig(
  provider: string,
  config: ProviderConfigEntry | undefined,
) {
  return {
    configured: Boolean(config?.apiKey || config?.baseUrl),
    model: config?.model ?? null,
    baseUrl: provider === 'local' ? config?.baseUrl ?? null : null,
    quota: { ...(config?.quota ?? DEFAULT_QUOTA) },
  }
}

function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
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

function serializeSessionCookie(opts: {
  name: string
  value: string | null
  path: string
  secure: boolean
  ttlMs: number
}): string {
  const parts = [
    `${opts.name}=${opts.value ? encodeURIComponent(opts.value) : ''}`,
    `Path=${opts.path}`,
    'HttpOnly',
    'SameSite=Lax',
  ]

  if (opts.value) {
    parts.push(`Max-Age=${Math.floor(opts.ttlMs / 1000)}`)
  } else {
    parts.push('Max-Age=0')
  }

  if (opts.secure) {
    parts.push('Secure')
  }

  return parts.join('; ')
}

/**
 * One-time migration: persist Google OAuth tokens and GA4 service account keys
 * extracted from the legacy DB columns into config.yaml. Skips any connection
 * that already exists in config to avoid overwriting refreshed tokens.
 *
 * Pair with `extractLegacyCredentials(db)` + `dropLegacyCredentialColumns(db)`
 * from `@ainyc/canonry-db`: extract first, call this, and only drop the columns
 * once this returns — a failed config write must be retryable on next boot.
 */
export function applyLegacyCredentials(rows: LegacyCredentialRows, config: CanonryConfig): void {
  let migratedGoogle = 0
  for (const row of rows.google) {
    const existing = getGoogleConnection(config, row.domain, row.connectionType)
    if (existing?.refreshToken) continue
    upsertGoogleConnection(config, {
      domain: row.domain,
      connectionType: row.connectionType,
      propertyId: row.propertyId,
      sitemapUrl: row.sitemapUrl,
      accessToken: row.accessToken ?? undefined,
      refreshToken: row.refreshToken,
      tokenExpiresAt: row.tokenExpiresAt,
      scopes: row.scopes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
    migratedGoogle++
  }
  if (migratedGoogle > 0) {
    saveConfigPatch({ google: config.google })
    log.info('credentials.migrated', { type: 'google', count: migratedGoogle })
  }

  let migratedGa4 = 0
  for (const row of rows.ga4) {
    const existing = getGa4Connection(config, row.projectName)
    if (existing?.privateKey) continue
    upsertGa4Connection(config, {
      projectName: row.projectName,
      propertyId: row.propertyId,
      clientEmail: row.clientEmail,
      privateKey: row.privateKey,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
    migratedGa4++
  }
  if (migratedGa4 > 0) {
    saveConfigPatch({ ga4: config.ga4 })
    log.info('credentials.migrated', { type: 'ga4', count: migratedGa4 })
  }
}

export async function createServer(opts: {
  config: CanonryConfig
  db: DatabaseClient
  open?: boolean
  logger?: boolean
}): Promise<FastifyInstance> {
  const logger = opts.logger === false
    ? false
    : process.stdout.isTTY
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss',
              ignore: 'pid,hostname,reqId',
              messageFormat: '{msg} {req.method} {req.url}',
            },
          },
        }
      : true

  const app = Fastify({
    logger,
  })

  // Build provider registry from config (with legacy field migration)
  const registry = new ProviderRegistry()
  const providers = opts.config.providers ?? {}

  // Migrate legacy geminiApiKey if providers.gemini is not set
  if (opts.config.geminiApiKey && !providers.gemini) {
    providers.gemini = {
      apiKey: opts.config.geminiApiKey,
      model: opts.config.geminiModel,
      quota: opts.config.geminiQuota,
    }
  }

  // One-time upgrade for pre-1.45.1 installs. Order is load-bearing: extract
  // into memory, persist to config.yaml, and only then drop the legacy columns.
  // Dropping before a successful config write would lose credentials if the
  // disk write fails. Best-effort — any failure is logged and retried next
  // boot rather than blocking server startup.
  try {
    const legacyRows = extractLegacyCredentials(opts.db)
    applyLegacyCredentials(legacyRows, opts.config)
    dropLegacyCredentialColumns(opts.db)
  } catch (err) {
    log.warn('credentials.migration.failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  log.info('providers.configured', { providers: Object.keys(providers).filter(k => {
    const p = providers[k]
    return p?.apiKey || p?.baseUrl || p?.vertexProject
  }) })

  // Register API providers from config
  for (const adapter of API_ADAPTERS) {
    const entry = providers[adapter.name]
    if (!entry) continue
    // Local provider requires baseUrl; Gemini can use apiKey OR vertexProject; others require apiKey
    const isConfigured = adapter.name === 'local'
      ? !!entry.baseUrl
      : adapter.name === 'gemini'
        ? !!(entry.apiKey || entry.vertexProject)
        : !!entry.apiKey
    if (isConfigured) {
      registry.register(adapter, {
        provider: adapter.name,
        apiKey: entry.apiKey,
        baseUrl: entry.baseUrl,
        model: entry.model,
        quotaPolicy: entry.quota ?? DEFAULT_QUOTA,
        vertexProject: entry.vertexProject,
        vertexRegion: entry.vertexRegion,
        vertexCredentials: entry.vertexCredentials,
      })
    }
  }

  // CDP browser provider — connects to user's Chrome via CDP
  const cdpConfig = opts.config.cdp
  if (cdpConfig?.host || cdpConfig?.port) {
    const CDP_DEFAULT_QUOTA = { maxConcurrency: 1, maxRequestsPerMinute: 4, maxRequestsPerDay: 200 }
    const cdpEndpoint = `ws://${cdpConfig.host ?? 'localhost'}:${cdpConfig.port ?? 9222}`
    registry.register(cdpChatgptAdapter, {
      provider: 'cdp:chatgpt',
      cdpEndpoint,
      quotaPolicy: cdpConfig.quota ?? CDP_DEFAULT_QUOTA,
    })
  }

  const port = opts.config.port ?? 4100
  const serverUrl = `http://localhost:${port}`

  const jobRunner = new JobRunner(opts.db, registry)
  jobRunner.recoverStaleRuns()
  const notifier = new Notifier(opts.db, serverUrl)
  const intelligenceService = new IntelligenceService(opts.db)
  // Build the Aero ApiClient from the in-memory server config rather than
  // loadConfig() so tests that set CANONRY_CONFIG_DIR after spawning the
  // server don't fail at construction time.
  const aeroClient = new ApiClient(opts.config.apiUrl, opts.config.apiKey, { skipProbe: true })
  const sessionRegistry = new SessionRegistry({
    db: opts.db,
    client: aeroClient,
    config: opts.config,
  })

  const runCoordinator = new RunCoordinator(
    notifier,
    intelligenceService,
    (runId, projectId, result) => notifier.dispatchInsightWebhooks(runId, projectId, result),
    async ({ runId, projectId, insightCount, criticalOrHigh }) => {
      const project = opts.db
        .select({ name: projects.name })
        .from(projects)
        .where(eq(projects.id, projectId))
        .get()
      if (!project) return
      sessionRegistry.queueFollowUp(project.name, {
        role: 'user',
        content:
          `[system] Run ${runId} completed for project ${project.name}. ` +
          `${insightCount} insights generated (${criticalOrHigh} critical/high). ` +
          `Use get_run to inspect the run and get_insights to review new findings. ` +
          `Surface anything notable briefly — skip chit-chat.`,
        timestamp: Date.now(),
      })
      // Fire-and-forget drain — the registry logs drain errors internally.
      void sessionRegistry.drainNow(project.name)
    },
  )
  jobRunner.onRunCompleted = (runId, projectId) => runCoordinator.onRunCompleted(runId, projectId)
  const snapshotService = new SnapshotService(registry)

  // OpenClaw gateway was removed in the native-agent-loop rewrite. If the user
  // previously ran `canonry agent setup`, warn once so they know the state dir
  // is orphaned and safe to delete.
  const orphanedOpenClawDir = path.join(os.homedir(), '.openclaw-aero')
  if (fs.existsSync(orphanedOpenClawDir)) {
    app.log.warn(
      { path: orphanedOpenClawDir },
      'OpenClaw gateway is no longer used. Remove ~/.openclaw-aero/ manually to reclaim the directory.',
    )
  }

  const scheduler = new Scheduler(opts.db, {
    onRunCreated: (runId, projectId, providers, location) => {
      jobRunner.executeRun(runId, projectId, providers, location).catch((err: unknown) => {
        app.log.error({ runId, err }, 'Scheduled job runner failed')
      })
    },
  })

  // Build provider summary for API routes (dynamic from adapter list)
  const providerSummary = API_ADAPTERS.map(adapter => ({
    name: adapter.name,
    displayName: adapter.displayName,
    keyUrl: adapter.keyUrl,
    modelHint: `e.g. ${adapter.modelRegistry.defaultModel}`,
    model: registry.get(adapter.name)?.config.model,
    configured: !!registry.get(adapter.name),
    quota: registry.get(adapter.name)?.config.quotaPolicy,
    vertexConfigured: adapter.name === 'gemini' ? !!opts.config.providers?.gemini?.vertexProject : undefined,
  }))
  const googleSettingsSummary = {
    configured: Boolean(opts.config.google?.clientId && opts.config.google?.clientSecret),
  }
  const bingSettingsSummary = {
    // Treat Bing as configured if there is at least one connection with an API key,
    // OR if a global bing.apiKey is set. The CLI stores keys per-connection
    // (bing.connections[].apiKey), so checking only bing.apiKey missed existing connections.
    configured: Boolean(
      opts.config.bing?.apiKey ||
      opts.config.bing?.connections?.some((c) => c.apiKey)
    ),
  }

  // Bing connection store — stores connections in ~/.canonry/config.yaml
  const bingConnectionStore = {
    getConnection: (domain: string) => {
      return opts.config.bing?.connections?.find((c) => c.domain === domain)
    },
    upsertConnection: (connection: {
      domain: string
      apiKey: string
      siteUrl?: string | null
      createdAt: string
      updatedAt: string
    }) => {
      if (!opts.config.bing) opts.config.bing = {}
      if (!opts.config.bing.connections) opts.config.bing.connections = []
      const idx = opts.config.bing.connections.findIndex((c) => c.domain === connection.domain)
      if (idx >= 0) {
        opts.config.bing.connections[idx] = connection
      } else {
        opts.config.bing.connections.push(connection)
      }
      saveConfigPatch(opts.config)
      return connection
    },
    updateConnection: (
      domain: string,
      patch: Partial<{ apiKey: string; siteUrl: string | null; updatedAt: string }>,
    ) => {
      const conn = opts.config.bing?.connections?.find((c) => c.domain === domain)
      if (!conn) return undefined
      Object.assign(conn, patch)
      saveConfigPatch(opts.config)
      return conn
    },
    deleteConnection: (domain: string) => {
      if (!opts.config.bing?.connections) return false
      const idx = opts.config.bing.connections.findIndex((c) => c.domain === domain)
      if (idx < 0) return false
      opts.config.bing.connections.splice(idx, 1)
      saveConfigPatch(opts.config)
      return true
    },
  } as const

  // GA4 credential store — stores service account keys in ~/.canonry/config.yaml
  const ga4CredentialStore = {
    getConnection: (projectName: string) => {
      return getGa4Connection(opts.config, projectName)
    },
    upsertConnection: (connection: {
      projectName: string
      propertyId: string
      clientEmail: string
      privateKey: string
      createdAt: string
      updatedAt: string
    }) => {
      const updated = upsertGa4Connection(opts.config, connection)
      saveConfigPatch(opts.config)
      return updated
    },
    deleteConnection: (projectName: string) => {
      const removed = removeGa4Connection(opts.config, projectName)
      if (removed) saveConfigPatch(opts.config)
      return removed
    },
  } as const

  const googleStateSecret = process.env.GOOGLE_STATE_SECRET ?? crypto.randomBytes(32).toString('hex')

  const googleConnectionStore = {
    listConnections: (domain: string) => listGoogleConnections(opts.config, domain),
    getConnection: (domain: string, connectionType: 'gsc' | 'ga4') => getGoogleConnection(opts.config, domain, connectionType),
    upsertConnection: (connection: {
      domain: string
      connectionType: 'gsc' | 'ga4'
      propertyId?: string | null
      sitemapUrl?: string | null
      accessToken?: string
      refreshToken?: string | null
      tokenExpiresAt?: string | null
      scopes?: string[]
      createdAt: string
      updatedAt: string
    }) => {
      const updated = upsertGoogleConnection(opts.config, connection)
      saveConfigPatch(opts.config)
      return updated
    },
    updateConnection: (
      domain: string,
      connectionType: 'gsc' | 'ga4',
      patch: Partial<{
        propertyId?: string | null
        sitemapUrl?: string | null
        accessToken?: string
        refreshToken?: string | null
        tokenExpiresAt?: string | null
        scopes?: string[]
        updatedAt: string
      }>,
    ) => {
      const updated = patchGoogleConnection(opts.config, domain, connectionType, patch)
      if (updated) saveConfigPatch(opts.config)
      return updated
    },
    deleteConnection: (domain: string, connectionType: 'gsc' | 'ga4') => {
      const removed = removeGoogleConnection(opts.config, domain, connectionType)
      if (removed) saveConfigPatch(opts.config)
      return removed
    },
  } as const

  const wordpressConnectionStore = {
    getConnection: (projectName: string) => {
      return getWordpressConnection(opts.config, projectName)
    },
    upsertConnection: (connection: {
      projectName: string
      url: string
      stagingUrl?: string
      username: string
      appPassword: string
      defaultEnv: 'live' | 'staging'
      createdAt: string
      updatedAt: string
    }) => {
      const updated = upsertWordpressConnection(opts.config, connection)
      saveConfigPatch(opts.config)
      return updated
    },
    updateConnection: (
      projectName: string,
      patch: Partial<{
        url: string
        stagingUrl?: string
        username: string
        appPassword: string
        defaultEnv: 'live' | 'staging'
        updatedAt: string
      }>,
    ) => {
      const updated = patchWordpressConnection(opts.config, projectName, patch)
      if (updated) saveConfigPatch(opts.config)
      return updated
    },
    deleteConnection: (projectName: string) => {
      const removed = removeWordpressConnection(opts.config, projectName)
      if (removed) saveConfigPatch(opts.config)
      return removed
    },
  } as const

  // Resolve base path early so API route prefix and SPA handler both use it.
  // Normalize: ensure it starts and ends with '/' (e.g. '/canonry/').
  // A value that normalises to bare '/' is treated as no base path to avoid
  // a duplicate-route error with fastify-static (which also registers '/').
  const rawBasePath = process.env.CANONRY_BASE_PATH ?? opts.config.basePath
  const normalizedBasePath = rawBasePath
    ? ('/' + rawBasePath.replace(/^\//, '').replace(/\/?$/, '/'))
    : undefined
  const basePath: string | undefined =
    normalizedBasePath === '/' ? undefined : normalizedBasePath

  // Register API routes.
  // When a basePath is set, routes are registered at `${basePath}api/v1` so they
  // match requests forwarded by a reverse proxy that does NOT strip the prefix
  // (e.g. Caddy `reverse_proxy localhost:4100` without `uri strip_prefix`).
  // If the proxy does strip the prefix, set CANONRY_BASE_PATH to empty/unset and
  // let the proxy handle path rewriting instead.
  const apiPrefix = basePath ? `${basePath}api/v1` : '/api/v1'
  // Ensure the configured API key exists in the DB — handles upgrades from
  // older versions that stored the key in config.yaml but never inserted it
  // into the api_keys table (or used a different DB file).
  if (opts.config.apiKey) {
    const keyHash = hashApiKey(opts.config.apiKey)
    const existing = opts.db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).get()
    if (!existing) {
      const prefix = opts.config.apiKey.slice(0, 12)
      opts.db.insert(apiKeys).values({
        id: `key_${crypto.randomBytes(8).toString('hex')}`,
        name: 'default',
        keyHash,
        keyPrefix: prefix,
        scopes: JSON.stringify(['*']),
        createdAt: new Date().toISOString(),
      }).run()
    }
  }

  const sessionCookiePath = basePath ?? '/'
  const sessionCookieSecure = Boolean(
    opts.config.publicUrl?.startsWith('https://')
      || opts.config.apiUrl?.startsWith('https://'),
  )
  const sessions = new Map<string, SessionRecord>()

  const pruneExpiredSessions = () => {
    const now = Date.now()
    for (const [sessionId, session] of sessions.entries()) {
      if (session.expiresAt <= now) {
        sessions.delete(sessionId)
      }
    }
  }

  const createSession = (apiKeyId: string) => {
    pruneExpiredSessions()
    const sessionId = crypto.randomBytes(32).toString('hex')
    sessions.set(sessionId, {
      apiKeyId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    })
    return sessionId
  }

  const resolveSessionApiKeyId = (sessionId: string) => {
    pruneExpiredSessions()
    const session = sessions.get(sessionId)
    if (!session) return null
    if (session.expiresAt <= Date.now()) {
      sessions.delete(sessionId)
      return null
    }
    return session.apiKeyId
  }

  const clearSession = (sessionId: string | undefined) => {
    if (sessionId) {
      sessions.delete(sessionId)
    }
  }

  // Resolve the default API key record once — used by password-based sessions
  // to bind the session to the server's configured key.
  const getDefaultApiKey = () => {
    if (!opts.config.apiKey) return undefined
    return opts.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hashApiKey(opts.config.apiKey)))
      .get()
  }

  const createPasswordSession = (reply: FastifyReply) => {
    const key = getDefaultApiKey()
    if (!key || key.revokedAt) return false

    const sessionId = createSession(key.id)
    reply.header('set-cookie', serializeSessionCookie({
      name: SESSION_COOKIE_NAME,
      value: sessionId,
      path: sessionCookiePath,
      secure: sessionCookieSecure,
      ttlMs: SESSION_TTL_MS,
    }))
    return true
  }

  app.get(apiPrefix + '/session', async (request, reply) => {
    const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME]
    return reply.send({
      authenticated: Boolean(sessionId && resolveSessionApiKeyId(sessionId)),
      setupRequired: !opts.config.dashboardPasswordHash,
    })
  })

  // One-time password setup — only works when no password is configured yet.
  app.post<{
    Body: { password?: string }
  }>(apiPrefix + '/session/setup', async (request, reply) => {
    if (opts.config.dashboardPasswordHash) {
      const err = validationError('Dashboard password is already configured')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const password = request.body?.password?.trim()
    if (!password || password.length < 8) {
      const err = validationError('Password must be at least 8 characters')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    opts.config.dashboardPasswordHash = hashApiKey(password)
    saveConfigPatch(opts.config)

    if (!createPasswordSession(reply)) {
      const err = authInvalid()
      return reply.status(err.statusCode).send(err.toJSON())
    }
    return reply.send({ authenticated: true })
  })

  // Login with dashboard password or API key.
  app.post<{
    Body: { password?: string; apiKey?: string }
  }>(apiPrefix + '/session', async (request, reply) => {
    const password = request.body?.password?.trim()
    const apiKey = request.body?.apiKey?.trim()

    if (password) {
      if (!opts.config.dashboardPasswordHash) {
        const err = validationError('No dashboard password configured — use /session/setup first')
        return reply.status(err.statusCode).send(err.toJSON())
      }
      if (hashApiKey(password) !== opts.config.dashboardPasswordHash) {
        return reply.status(401).send({ error: { code: 'AUTH_INVALID', message: 'Incorrect password' } })
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
        const err = authInvalid()
        return reply.status(err.statusCode).send(err.toJSON())
      }

      opts.db
        .update(apiKeys)
        .set({ lastUsedAt: new Date().toISOString() })
        .where(eq(apiKeys.id, key.id))
        .run()

      const sessionId = createSession(key.id)
      reply.header('set-cookie', serializeSessionCookie({
        name: SESSION_COOKIE_NAME,
        value: sessionId,
        path: sessionCookiePath,
        secure: sessionCookieSecure,
        ttlMs: SESSION_TTL_MS,
      }))
      return reply.send({ authenticated: true })
    }

    const err = validationError('Either password or apiKey is required')
    return reply.status(err.statusCode).send(err.toJSON())
  })

  app.delete(apiPrefix + '/session', async (request, reply) => {
    const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME]
    clearSession(sessionId)
    reply.header('set-cookie', serializeSessionCookie({
      name: SESSION_COOKIE_NAME,
      value: null,
      path: sessionCookiePath,
      secure: sessionCookieSecure,
      ttlMs: SESSION_TTL_MS,
    }))
    return reply.status(204).send()
  })

  await app.register(apiRoutes, {
    db: opts.db,
    routePrefix: apiPrefix,
    skipAuth: false,
    sessionCookieName: SESSION_COOKIE_NAME,
    resolveSessionApiKeyId,
    // Local-only Aero agent routes. Registered here so they inherit api-routes'
    // auth plugin — bare `registerAgentRoutes(app, ...)` would skip auth.
    registerAuthenticatedRoutes: async (scope) => {
      registerAgentRoutes(scope, { db: opts.db, sessionRegistry })
    },
    getGoogleAuthConfig: () => getGoogleAuthConfig(opts.config),
    googleConnectionStore,
    googleStateSecret,
    publicUrl: opts.config.publicUrl,
    onGscSyncRequested: (runId: string, projectId: string, syncOpts?: { days?: number; full?: boolean }) => {
      const { clientId: googleClientId, clientSecret: googleClientSecret } = getGoogleAuthConfig(opts.config)
      if (!googleClientId || !googleClientSecret) {
        app.log.error('GSC sync requested but Google OAuth credentials are not configured in the local config')
        return
      }
      executeGscSync(opts.db, runId, projectId, {
        ...syncOpts,
        config: opts.config,
      }).catch((err: unknown) => {
        app.log.error({ runId, err }, 'GSC sync failed')
      })
    },
    onInspectSitemapRequested: (runId: string, projectId: string, inspectOpts?: { sitemapUrl?: string }) => {
      const { clientId: googleClientId, clientSecret: googleClientSecret } = getGoogleAuthConfig(opts.config)
      if (!googleClientId || !googleClientSecret) {
        app.log.error('Inspect sitemap requested but Google OAuth credentials are not configured')
        return
      }
      executeInspectSitemap(opts.db, runId, projectId, {
        ...inspectOpts,
        config: opts.config,
      }).catch((err: unknown) => {
        app.log.error({ runId, err }, 'Inspect sitemap failed')
      })
    },
    getBacklinksStatus: () => ({
      duckdbInstalled: isDuckdbInstalled(),
      duckdbVersion: readInstalledVersion() ?? undefined,
      duckdbSpec: DUCKDB_SPEC,
      pluginDir: PLUGIN_DIR,
    }),
    onInstallBacklinks: async () => {
      const result = await installDuckdb({ onLog: (line) => app.log.info({ line }, 'duckdb install') })
      return {
        installed: true,
        version: result.version,
        path: result.path,
        alreadyPresent: result.alreadyPresent,
      }
    },
    onReleaseSyncRequested: (syncId: string, release: string) => {
      executeReleaseSync(opts.db, syncId, { release }).catch((err: unknown) => {
        app.log.error({ syncId, err }, 'Common Crawl release sync failed')
      })
    },
    onBacklinkExtractRequested: (runId: string, projectId: string, release?: string) => {
      executeBacklinkExtract(opts.db, runId, projectId, { release }).catch((err: unknown) => {
        app.log.error({ runId, err }, 'Backlink extract failed')
      })
    },
    onBacklinksPruneCache: (release: string) => {
      try {
        pruneCachedRelease(release)
      } catch (err) {
        app.log.error({ release, err }, 'Failed to prune cached release')
      }
    },
    listCachedReleases: () => {
      const cached = listCachedReleasesFromDisk()
      const syncByRelease = new Map<string, { status: string; updatedAt: string }>()
      for (const row of opts.db.select().from(ccReleaseSyncsTable).all()) {
        syncByRelease.set(row.release, { status: row.status, updatedAt: row.updatedAt })
      }
      return cached.map((entry) => {
        const sync = syncByRelease.get(entry.release)
        return {
          release: entry.release,
          syncStatus: (sync?.status ?? null) as import('@ainyc/canonry-contracts').CcCachedRelease['syncStatus'],
          bytes: entry.bytes,
          lastUsedAt: entry.lastUsedAt,
        }
      })
    },
    openApiInfo: {
      title: 'Canonry API',
      version: PKG_VERSION,
      includeCanonryLocal: true,
    },
    providerSummary,
    providerAdapters: [...API_ADAPTERS, ...BROWSER_ADAPTERS].map(a => ({
      name: a.name,
      displayName: a.displayName,
      mode: a.mode,
      modelValidationPattern: a.modelRegistry.validationPattern,
      modelValidationHint: a.modelRegistry.validationHint,
    })),
    googleSettingsSummary,
    bingSettingsSummary,
    bingConnectionStore,
    wordpressConnectionStore,
    ga4CredentialStore,
    onRunCreated: (runId: string, projectId: string, providers?: string[], location?: import('@ainyc/canonry-contracts').LocationContext | null) => {
      // Fire and forget — run executes in background
      jobRunner.executeRun(runId, projectId, providers, location).catch((err: unknown) => {
        app.log.error({ runId, err }, 'Job runner failed')
      })
    },
    onProviderUpdate: (providerName: string, apiKey: string, model?: string, baseUrl?: string, incomingQuota?: Partial<import('@ainyc/canonry-contracts').ProviderQuotaPolicy>) => {
      const name = providerName
      if (!adapterMap[name]) return null

      // Update config and persist
      if (!opts.config.providers) opts.config.providers = {}
      const existing = opts.config.providers[name]
      const beforeConfig = summarizeProviderConfig(name, existing)
      const mergedQuota = incomingQuota
        ? { ...(existing?.quota ?? DEFAULT_QUOTA), ...incomingQuota }
        : existing?.quota
      opts.config.providers[name] = {
        apiKey: apiKey || existing?.apiKey,
        baseUrl: baseUrl || existing?.baseUrl,
        model: model || existing?.model,
        quota: mergedQuota,
        // Preserve Vertex AI config (Gemini provider) — these are set via
        // config file or env vars, not through the dashboard update payload
        vertexProject: existing?.vertexProject,
        vertexRegion: existing?.vertexRegion,
        vertexCredentials: existing?.vertexCredentials,
      }

      try {
        saveConfigPatch(opts.config)
      } catch (err) {
        app.log.error({ err }, 'Failed to save config')
        return null
      }

      // Re-register in the live registry (use preserved model if none was passed)
      const quota = opts.config.providers[name]!.quota ?? DEFAULT_QUOTA
      registry.register(adapterMap[name]!, {
        provider: name,
        apiKey: apiKey || existing?.apiKey,
        baseUrl: baseUrl || existing?.baseUrl,
        model: model || existing?.model,
        quotaPolicy: quota,
        vertexProject: existing?.vertexProject,
        vertexRegion: existing?.vertexRegion,
        vertexCredentials: existing?.vertexCredentials,
      })

      // Update the providerSummary array in-place
      const entry = providerSummary.find(p => p.name === name)
      if (entry) {
        entry.configured = true
        entry.model = model || registry.get(name)?.config.model
        entry.quota = quota
        if (name === 'gemini') {
          entry.vertexConfigured = !!opts.config.providers?.[name]?.vertexProject
        }
      }

      const afterConfig = summarizeProviderConfig(name, opts.config.providers[name])
      if (JSON.stringify(beforeConfig) !== JSON.stringify(afterConfig)) {
        const diff = JSON.stringify({
          before: existing ? beforeConfig : null,
          after: afterConfig,
        })
        const affectedProjectIds = opts.db
          .select({ id: projects.id, providers: projects.providers })
          .from(projects)
          .all()
          .filter((project) => {
            const configuredProviders = parseJsonColumn<string[]>(project.providers, [])
            return configuredProviders.length === 0 || configuredProviders.includes(name)
          })
          .map((project) => project.id)
        const targetProjectIds = affectedProjectIds.length > 0 ? affectedProjectIds : [null]
        const createdAt = new Date().toISOString()

        opts.db.insert(auditLog).values(targetProjectIds.map((projectId) => ({
          id: crypto.randomUUID(),
          projectId,
          actor: 'api',
          action: existing ? 'provider.updated' : 'provider.created',
          entityType: 'provider',
          entityId: name,
          diff,
          createdAt,
        }))).run()
      }

      return {
        name,
        model: entry?.model,
        configured: true,
        quota,
      }
    },
    onGoogleSettingsUpdate: (clientId: string, clientSecret: string) => {
      try {
        setGoogleAuthConfig(opts.config, { clientId, clientSecret })
        saveConfigPatch(opts.config)
        googleSettingsSummary.configured = true
        return { ...googleSettingsSummary }
      } catch (err) {
        app.log.error({ err }, 'Failed to save Google OAuth config')
        return null
      }
    },
    onBingSettingsUpdate: (apiKey: string) => {
      try {
        if (!opts.config.bing) opts.config.bing = {}
        opts.config.bing.apiKey = apiKey
        saveConfigPatch(opts.config)
        bingSettingsSummary.configured = true
        return { ...bingSettingsSummary }
      } catch (err) {
        app.log.error({ err }, 'Failed to save Bing API key config')
        return null
      }
    },
    onScheduleUpdated: (action: 'upsert' | 'delete', projectId: string) => {
      if (action === 'upsert') scheduler.upsert(projectId)
      if (action === 'delete') scheduler.remove(projectId)
    },
    onProjectDeleted: (projectId: string) => {
      scheduler.remove(projectId)
    },
    getTelemetryStatus: () => {
      const enabled = isTelemetryEnabled()
      return {
        enabled,
        // Only read/create the anonymous ID if telemetry is enabled.
        // Don't mutate config for opted-out users.
        anonymousId: enabled ? getOrCreateAnonymousId() : undefined,
      }
    },
    setTelemetryEnabled: (enabled: boolean) => {
      const config = loadConfig()
      config.telemetry = enabled
      saveConfigPatch(config)
      // Keep in-memory config in sync
      opts.config.telemetry = enabled
    },
    onCdpConfigure: async (host: string, port: number) => {
      if (!opts.config.cdp) opts.config.cdp = {}
      opts.config.cdp.host = host
      opts.config.cdp.port = port
      try {
        saveConfigPatch(opts.config)
      } catch (err) {
        app.log.error({ err }, 'Failed to save CDP config')
        throw err
      }
      // Re-register CDP adapter with the new endpoint
      const CDP_DEFAULT_QUOTA = { maxConcurrency: 1, maxRequestsPerMinute: 4, maxRequestsPerDay: 200 }
      registry.register(cdpChatgptAdapter, {
        provider: 'cdp:chatgpt',
        cdpEndpoint: `ws://${host}:${port}`,
        quotaPolicy: opts.config.cdp.quota ?? CDP_DEFAULT_QUOTA,
      })
    },
    getCdpStatus: async () => {
      const conn = registry.get('cdp:chatgpt')
      if (!conn) {
        return {
          connected: false,
          endpoint: opts.config.cdp
            ? `ws://${opts.config.cdp.host ?? 'localhost'}:${opts.config.cdp.port ?? 9222}`
            : '',
          targets: [],
        }
      }
      const health = await conn.adapter.healthcheck(conn.config)
      return {
        connected: health.ok,
        endpoint: conn.config.cdpEndpoint ?? '',
        browserVersion: health.message,
        targets: [],
      }
    },
    onCdpScreenshot: async (query: string, targets?: string[]) => {
      const conn = registry.get('cdp:chatgpt')
      if (!conn) throw new Error('CDP provider not configured')
      const result = await conn.adapter.executeTrackedQuery(
        { keyword: query, canonicalDomains: [], competitorDomains: [] },
        conn.config,
      )
      const raw = result.rawResponse as { answerText?: string; groundingSources?: { uri: string; title: string }[] }
      return [{
        target: targets?.[0] ?? 'chatgpt',
        screenshotPath: result.screenshotPath ?? '',
        answerText: raw.answerText ?? '',
        citations: (raw.groundingSources ?? []),
      }]
    },
    onGenerateKeywords: async (providerName, count, project) => {
      const provider = registry.get(providerName)
      if (!provider) throw new Error(`Provider "${providerName}" is not configured`)

      const siteText = await fetchSiteText(project.domain)

      const prompt = buildKeywordGenerationPrompt({
        domain: project.domain,
        displayName: project.displayName,
        country: project.country,
        language: project.language,
        existingKeywords: project.existingKeywords,
        siteText,
        count,
      })

      const raw = await provider.adapter.generateText(prompt, provider.config)
      return parseKeywordResponse(raw, count)
    },
    onSnapshotRequested: async (input) => {
      return snapshotService.createReport(input)
    },
  })

  // Try to serve static SPA assets
  const dirname = path.dirname(fileURLToPath(import.meta.url))
  const assetsDir = path.join(dirname, '..', 'assets')
  if (fs.existsSync(assetsDir)) {
    const indexPath = path.join(assetsDir, 'index.html')

    // basePath is already resolved above. Used here for SPA serving.
    const injectConfig = (html: string): string => {
      const clientConfig: Record<string, unknown> = {}
      if (basePath) clientConfig.basePath = basePath

      const configScript = `<script>window.__CANONRY_CONFIG__=${JSON.stringify(clientConfig)}</script>`
      // Inject <base href> unconditionally so relative asset paths (`./assets/…`)
      // resolve against the mount point instead of the current URL. Without this,
      // deep-links like `/projects/ainyc` request `/projects/assets/…js`, hit the
      // SPA fallback, and receive HTML where the browser expects JS.
      const baseTag = `<base href="${basePath ?? '/'}">`
      return html.replace('<head>', `<head>${baseTag}`).replace('</head>', `${configScript}</head>`)
    }

    const fastifyStatic = await import('@fastify/static')
    await app.register(fastifyStatic.default, {
      root: assetsDir,
      prefix: basePath ?? '/',
      wildcard: true,
      // Don't serve index.html automatically — we handle it with config injection
      serve: true,
      index: false,
    })

    // Serve index.html with injected config for the root/base-path route.
    // Register both the trailing-slash form ('/canonry/') and the bare form
    // ('/canonry') so either URL shape hits the handler without a 404.
    const serveIndex = (_request: FastifyRequest, reply: FastifyReply) => {
      if (fs.existsSync(indexPath)) {
        const html = fs.readFileSync(indexPath, 'utf-8')
        return reply.type('text/html').send(injectConfig(html))
      }
      return reply.status(404).send({ error: 'Dashboard not built' })
    }
    const rootRouteTrailing = basePath ?? '/'
    app.get(rootRouteTrailing, serveIndex)
    // Also register the no-trailing-slash variant when base path is set
    // (e.g. '/canonry' in addition to '/canonry/') to avoid a 404 on bare navigation.
    if (basePath) {
      const rootRouteBare = basePath.replace(/\/$/, '')
      if (rootRouteBare) app.get(rootRouteBare, serveIndex)
    }

    // SPA fallback: serve index.html for unmatched routes that belong to this app.
    // - With no base path: serve for any non-API path (existing behaviour).
    // - With base path: only serve for paths under basePath to avoid hijacking
    //   other apps co-hosted on the same origin outside the base path.
    app.setNotFoundHandler((request, reply) => {
      const url = request.url.split('?')[0]!

      // Never serve HTML for API routes — return proper JSON 404.
      // Check both the bare /api/ prefix and the basePath-prefixed form so the
      // SPA catch-all never intercepts API calls regardless of proxy config.
      const isApiRoute =
        url.startsWith('/api/') ||
        (basePath !== undefined && url.startsWith(`${basePath}api/`))
      if (isApiRoute) {
        return reply.status(404).send({ error: 'Not found', path: request.url })
      }

      // When a base path is configured, only serve the SPA for paths under it.
      if (basePath && !url.startsWith(basePath)) {
        return reply.status(404).send({ error: 'Not found', path: request.url })
      }

      if (fs.existsSync(indexPath)) {
        const html = fs.readFileSync(indexPath, 'utf-8')
        return reply.type('text/html').send(injectConfig(html))
      }
      return reply.status(404).send({ error: 'Not found' })
    })
  }

  // Health endpoint — registered at both /health and <basePath>health when base path is set,
  // so load-balancer probes work regardless of whether the proxy strips the prefix.
  const healthHandler = async () => ({
    status: 'ok',
    service: 'canonry',
    version: PKG_VERSION,
    ...(basePath ? { basePath: basePath.replace(/\/$/, '') } : {}),
  })
  app.get('/health', healthHandler)
  if (basePath) {
    app.get(`${basePath}health`, healthHandler)
  }

  // Start scheduler after setup
  scheduler.start()

  // Graceful shutdown
  app.addHook('onClose', async () => {
    scheduler.stop()
  })

  return app
}

function buildKeywordGenerationPrompt(ctx: {
  domain: string
  displayName?: string
  country: string
  language: string
  existingKeywords: string[]
  siteText: string
  count: number
}): string {
  const lines: string[] = [
    'You are an SEO and AEO (Answer Engine Optimization) expert. Given a website\'s content, generate search queries that potential users would type into AI answer engines (ChatGPT, Gemini, Claude) to find services, products, or information like what this site offers.',
    '',
    `Website: ${ctx.domain}`,
  ]
  if (ctx.displayName) lines.push(`Business: ${ctx.displayName}`)
  lines.push(`Country: ${ctx.country}`)
  lines.push(`Language: ${ctx.language}`)

  if (ctx.siteText) {
    lines.push('', '--- Site Content ---', ctx.siteText, '--- End Site Content ---')
  }

  if (ctx.existingKeywords.length > 0) {
    lines.push('', `Already tracking (do NOT duplicate): ${ctx.existingKeywords.join(', ')}`)
  }

  lines.push(
    '',
    `Generate exactly ${ctx.count} key phrases that:`,
    '- Are short and concise (2-5 words each, like "best dentist brooklyn" not "what is the best dentist office in the brooklyn area for families")',
    '- Are natural phrases people would type into AI answer engines',
    '- Cover different intents (informational, transactional, navigational)',
    `- Are relevant to the ${ctx.country} market in ${ctx.language}`,
    '- Reflect the actual services/products/content found on the site',
    '',
    'Return ONLY the key phrases, one per line, no numbering or bullets.',
  )

  return lines.join('\n')
}

function parseKeywordResponse(raw: string, count: number): string[] {
  const seen = new Set<string>()
  const results: string[] = []

  for (const line of raw.split('\n')) {
    // Strip leading numbering, bullets, dashes
    let cleaned = line.replace(/^\s*(?:\d+[.)]\s*|[-*•]\s*)/, '').trim()
    // Remove surrounding quotes
    cleaned = cleaned.replace(/^["']|["']$/g, '').trim()

    if (!cleaned) continue
    // Skip meta-text lines
    if (/^(here are|sure|certainly|of course|i've|these are|below are)/i.test(cleaned)) continue
    // Enforce max 8 words
    if (cleaned.split(/\s+/).length > 8) continue

    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    results.push(cleaned)

    if (results.length >= count) break
  }

  return results
}
