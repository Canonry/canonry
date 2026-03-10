import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { apiRoutes } from '@ainyc/aeo-platform-api-routes'
import type { DatabaseClient } from '@ainyc/aeo-platform-db'
import { geminiAdapter } from '@ainyc/aeo-platform-provider-gemini'
import { openaiAdapter } from '@ainyc/aeo-platform-provider-openai'
import { claudeAdapter } from '@ainyc/aeo-platform-provider-claude'
import type { ProviderName } from '@ainyc/aeo-platform-contracts'
import type { CanonryConfig } from './config.js'
import { saveConfig } from './config.js'
import { JobRunner } from './job-runner.js'
import { ProviderRegistry } from './provider-registry.js'

const DEFAULT_QUOTA = {
  maxConcurrency: 2,
  maxRequestsPerMinute: 10,
  maxRequestsPerDay: 1000,
}

export async function createServer(opts: {
  config: CanonryConfig
  db: DatabaseClient
  open?: boolean
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true })

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

  console.log('[Server] Provider config keys:', Object.keys(providers).filter(k => providers[k as keyof typeof providers]?.apiKey))

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

  const jobRunner = new JobRunner(opts.db, registry)

  // Build provider summary for API routes
  const providerSummary = (['gemini', 'openai', 'claude'] as const).map(name => ({
    name,
    model: registry.get(name)?.config.model,
    configured: !!registry.get(name),
    quota: registry.get(name)?.config.quotaPolicy,
  }))

  const adapterMap = { gemini: geminiAdapter, openai: openaiAdapter, claude: claudeAdapter } as const

  // Register API routes
  await app.register(apiRoutes, {
    db: opts.db,
    skipAuth: false,
    providerSummary,
    onRunCreated: (runId: string, projectId: string, providers?: string[]) => {
      // Fire and forget — run executes in background
      jobRunner.executeRun(runId, projectId, providers as ProviderName[] | undefined).catch((err: unknown) => {
        app.log.error({ runId, err }, 'Job runner failed')
      })
    },
    onProviderUpdate: (providerName: string, apiKey: string, model?: string) => {
      const name = providerName as keyof typeof adapterMap
      if (!(name in adapterMap)) return null

      // Update config and persist
      if (!opts.config.providers) opts.config.providers = {}
      const existing = opts.config.providers[name]
      opts.config.providers[name] = {
        apiKey,
        model: model || existing?.model,
        quota: existing?.quota,
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
        apiKey,
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

      return {
        name,
        model: entry?.model,
        configured: true,
        quota,
      }
    },
  })

  // Try to serve static SPA assets
  const dirname = path.dirname(fileURLToPath(import.meta.url))
  const assetsDir = path.join(dirname, '..', 'assets')
  if (fs.existsSync(assetsDir)) {
    const indexPath = path.join(assetsDir, 'index.html')

    const injectConfig = (html: string): string => {
      const configScript = `<script>window.__CANONRY_CONFIG__=${JSON.stringify({ apiKey: opts.config.apiKey })}</script>`
      return html.replace('</head>', `${configScript}</head>`)
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
    version: '0.1.0',
  }))

  return app
}
