import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const _require = createRequire(import.meta.url)
const { version: PKG_VERSION } = _require('../package.json') as { version: string }
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { auditLog, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { geminiAdapter } from '@ainyc/canonry-provider-gemini'
import { openaiAdapter } from '@ainyc/canonry-provider-openai'
import { claudeAdapter } from '@ainyc/canonry-provider-claude'
import { localAdapter } from '@ainyc/canonry-provider-local'
import type { ProviderName } from '@ainyc/canonry-contracts'
import type { CanonryConfig, ProviderConfigEntry } from './config.js'
import { saveConfig, loadConfig } from './config.js'
import {
  getGoogleAuthConfig,
  getGoogleConnection,
  listGoogleConnections,
  patchGoogleConnection,
  removeGoogleConnection,
  setGoogleAuthConfig,
  upsertGoogleConnection,
} from './google-config.js'
import { isTelemetryEnabled, getOrCreateAnonymousId } from './telemetry.js'
import { JobRunner } from './job-runner.js'
import { executeGscSync } from './gsc-sync.js'
import { executeInspectSitemap } from './gsc-inspect-sitemap.js'
import { ProviderRegistry } from './provider-registry.js'
import { Scheduler } from './scheduler.js'
import { Notifier } from './notifier.js'
import { fetchSiteText } from './site-fetch.js'

const DEFAULT_QUOTA = {
  maxConcurrency: 2,
  maxRequestsPerMinute: 10,
  maxRequestsPerDay: 1000,
}

function summarizeProviderConfig(
  provider: ProviderName,
  config: ProviderConfigEntry | undefined,
) {
  return {
    configured: Boolean(config?.apiKey || config?.baseUrl),
    model: config?.model ?? null,
    baseUrl: provider === 'local' ? config?.baseUrl ?? null : null,
    quota: { ...(config?.quota ?? DEFAULT_QUOTA) },
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

  console.log('[Server] Configured providers:', Object.keys(providers).filter(k => {
    const p = providers[k as keyof typeof providers]
    return p?.apiKey || p?.baseUrl
  }))

  if (providers.gemini?.apiKey) {
    registry.register(geminiAdapter, {
      provider: 'gemini',
      apiKey: providers.gemini.apiKey,
      model: providers.gemini.model,
      quotaPolicy: providers.gemini.quota ?? DEFAULT_QUOTA,
    })
  }
  if (providers.openai?.apiKey) {
    registry.register(openaiAdapter, {
      provider: 'openai',
      apiKey: providers.openai.apiKey,
      model: providers.openai.model,
      quotaPolicy: providers.openai.quota ?? DEFAULT_QUOTA,
    })
  }
  if (providers.claude?.apiKey) {
    registry.register(claudeAdapter, {
      provider: 'claude',
      apiKey: providers.claude.apiKey,
      model: providers.claude.model,
      quotaPolicy: providers.claude.quota ?? DEFAULT_QUOTA,
    })
  }
  if (providers.local?.baseUrl) {
    registry.register(localAdapter, {
      provider: 'local',
      apiKey: providers.local.apiKey,
      baseUrl: providers.local.baseUrl,
      model: providers.local.model,
      quotaPolicy: providers.local.quota ?? DEFAULT_QUOTA,
    })
  }

  const port = opts.config.port ?? 4100
  const serverUrl = `http://localhost:${port}`

  const jobRunner = new JobRunner(opts.db, registry)
  jobRunner.recoverStaleRuns()
  const notifier = new Notifier(opts.db, serverUrl)
  jobRunner.onRunCompleted = (runId, projectId) => notifier.onRunCompleted(runId, projectId)

  const scheduler = new Scheduler(opts.db, {
    onRunCreated: (runId, projectId, providers) => {
      jobRunner.executeRun(runId, projectId, providers).catch((err: unknown) => {
        app.log.error({ runId, err }, 'Scheduled job runner failed')
      })
    },
  })

  // Build provider summary for API routes
  const providerSummary = (['gemini', 'openai', 'claude', 'local'] as const).map(name => ({
    name,
    model: registry.get(name)?.config.model,
    configured: !!registry.get(name),
    quota: registry.get(name)?.config.quotaPolicy,
  }))
  const googleSettingsSummary = {
    configured: Boolean(opts.config.google?.clientId && opts.config.google?.clientSecret),
  }

  const adapterMap = { gemini: geminiAdapter, openai: openaiAdapter, claude: claudeAdapter, local: localAdapter } as const

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
      saveConfig(opts.config)
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
      if (updated) saveConfig(opts.config)
      return updated
    },
    deleteConnection: (domain: string, connectionType: 'gsc' | 'ga4') => {
      const removed = removeGoogleConnection(opts.config, domain, connectionType)
      if (removed) saveConfig(opts.config)
      return removed
    },
  } as const

  // Register API routes
  await app.register(apiRoutes, {
    db: opts.db,
    skipAuth: false,
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
    openApiInfo: {
      title: 'Canonry API',
      version: PKG_VERSION,
    },
    providerSummary,
    googleSettingsSummary,
    onRunCreated: (runId: string, projectId: string, providers?: string[], location?: import('@ainyc/canonry-contracts').LocationContext | null) => {
      // Fire and forget — run executes in background
      jobRunner.executeRun(runId, projectId, providers as ProviderName[] | undefined, location).catch((err: unknown) => {
        app.log.error({ runId, err }, 'Job runner failed')
      })
    },
    onProviderUpdate: (providerName: string, apiKey: string, model?: string, baseUrl?: string, incomingQuota?: Partial<import('@ainyc/canonry-contracts').ProviderQuotaPolicy>) => {
      const name = providerName as keyof typeof adapterMap
      if (!(name in adapterMap)) return null

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
      }

      try {
        saveConfig(opts.config)
      } catch (err) {
        app.log.error({ err }, 'Failed to save config')
        return null
      }

      // Re-register in the live registry (use preserved model if none was passed)
      const quota = opts.config.providers[name]!.quota ?? DEFAULT_QUOTA
      registry.register(adapterMap[name], {
        provider: name,
        apiKey: apiKey || existing?.apiKey,
        baseUrl: baseUrl || existing?.baseUrl,
        model: model || existing?.model,
        quotaPolicy: quota,
      })

      // Update the providerSummary array in-place
      const entry = providerSummary.find(p => p.name === name)
      if (entry) {
        entry.configured = true
        entry.model = model || registry.get(name)?.config.model
        entry.quota = quota
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
            try {
              const configuredProviders = JSON.parse(project.providers || '[]') as string[]
              return configuredProviders.length === 0 || configuredProviders.includes(name)
            } catch {
              return false
            }
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
        saveConfig(opts.config)
        googleSettingsSummary.configured = true
        return { ...googleSettingsSummary }
      } catch (err) {
        app.log.error({ err }, 'Failed to save Google OAuth config')
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
      saveConfig(config)
      // Keep in-memory config in sync
      opts.config.telemetry = enabled
    },
    onGenerateKeywords: async (providerName, count, project) => {
      const provider = registry.get(providerName as ProviderName)
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
  })

  // Try to serve static SPA assets
  const dirname = path.dirname(fileURLToPath(import.meta.url))
  const assetsDir = path.join(dirname, '..', 'assets')
  if (fs.existsSync(assetsDir)) {
    const indexPath = path.join(assetsDir, 'index.html')

    // Read base path from env (set by --base-path CLI flag) or config.
    // Normalize: ensure it starts and ends with '/' (e.g. '/canonry/').
    const rawBasePath = process.env.CANONRY_BASE_PATH ?? opts.config.basePath
    const basePath: string | undefined = rawBasePath
      ? ('/' + rawBasePath.replace(/^\//, '').replace(/\/?$/, '/'))
      : undefined

    const injectConfig = (html: string): string => {
      const clientConfig: Record<string, unknown> = { apiKey: opts.config.apiKey }
      if (basePath) clientConfig.basePath = basePath

      const configScript = `<script>window.__CANONRY_CONFIG__=${JSON.stringify(clientConfig)}</script>`
      // Inject <base href> so relative asset paths resolve correctly at any sub-path.
      // This must come before other resource tags in <head>.
      const baseTag = basePath ? `<base href="${basePath}">` : ''
      return html.replace('<head>', `<head>${baseTag}`).replace('</head>', `${configScript}</head>`)
    }

    const fastifyStatic = await import('@fastify/static')
    await app.register(fastifyStatic.default, {
      root: assetsDir,
      prefix: '/',
      wildcard: false,
      // Don't serve index.html automatically — we handle it with config injection
      serve: true,
      index: false,
    })

    // Serve index.html with injected API key for the root route
    app.get('/', (_request, reply) => {
      if (fs.existsSync(indexPath)) {
        const html = fs.readFileSync(indexPath, 'utf-8')
        return reply.type('text/html').send(injectConfig(html))
      }
      return reply.status(404).send({ error: 'Dashboard not built' })
    })

    // SPA fallback: serve index.html for unmatched non-API routes
    app.setNotFoundHandler((request, reply) => {
      // Never serve HTML for API routes — return proper JSON 404
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'Not found', path: request.url })
      }

      if (fs.existsSync(indexPath)) {
        const html = fs.readFileSync(indexPath, 'utf-8')
        return reply.type('text/html').send(injectConfig(html))
      }
      return reply.status(404).send({ error: 'Not found' })
    })
  }

  // Health endpoint
  app.get('/health', async () => ({
    status: 'ok',
    service: 'canonry',
    version: PKG_VERSION,
  }))

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
