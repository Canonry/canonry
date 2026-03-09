import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { apiRoutes } from '@ainyc/aeo-platform-api-routes'
import type { DatabaseClient } from '@ainyc/aeo-platform-db'
import type { CanonryConfig } from './config.js'
import { JobRunner } from './job-runner.js'

export async function createServer(opts: {
  config: CanonryConfig
  db: DatabaseClient
  open?: boolean
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true })

  const jobRunner = new JobRunner(opts.db, opts.config.geminiApiKey)

  // Register API routes
  await app.register(apiRoutes, {
    db: opts.db,
    skipAuth: false,
    onRunCreated: (runId: string, projectId: string) => {
      // Fire and forget — run executes in background
      jobRunner.executeRun(runId, projectId).catch((err: unknown) => {
        app.log.error({ runId, err }, 'Job runner failed')
      })
    },
  })

  // Try to serve static SPA assets
  const dirname = path.dirname(fileURLToPath(import.meta.url))
  const assetsDir = path.join(dirname, '..', 'assets')
  if (fs.existsSync(assetsDir)) {
    const fastifyStatic = await import('@fastify/static')
    await app.register(fastifyStatic.default, {
      root: assetsDir,
      prefix: '/',
      wildcard: false,
    })

    // SPA fallback: serve index.html for unmatched routes
    app.setNotFoundHandler((_request, reply) => {
      const indexPath = path.join(assetsDir, 'index.html')
      if (fs.existsSync(indexPath)) {
        return reply.type('text/html').sendFile('index.html')
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
