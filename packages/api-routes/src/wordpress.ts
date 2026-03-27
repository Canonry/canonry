import type { FastifyInstance, FastifyReply } from 'fastify'
import { AppError, notFound, providerError, validationError } from '@ainyc/canonry-contracts'
import type { WordpressEnv } from '@ainyc/canonry-contracts'
import {
  buildManualLlmsTxtUpdate,
  buildManualSchemaUpdate,
  buildManualStagingPush,
  createPage,
  diffPageAcrossEnvironments,
  getLlmsTxt,
  getPageDetail,
  getPageSchema,
  getSiteStatus,
  getWpStagingAdminUrl,
  listActivePlugins,
  listPages,
  parseEnv,
  runAudit,
  setSeoMeta,
  updatePageBySlug,
  verifyWordpressConnection,
  WordpressApiError,
} from '@ainyc/canonry-integration-wordpress'
import type { WordpressConnectionRecord } from '@ainyc/canonry-integration-wordpress'
import { resolveProject, writeAuditLog } from './helpers.js'

export interface WordpressConnectionStore {
  getConnection: (projectName: string) => WordpressConnectionRecord | undefined
  upsertConnection: (connection: WordpressConnectionRecord) => WordpressConnectionRecord
  updateConnection: (
    projectName: string,
    patch: Partial<Omit<WordpressConnectionRecord, 'projectName' | 'createdAt'>>,
  ) => WordpressConnectionRecord | undefined
  deleteConnection: (projectName: string) => boolean
}

export interface WordpressRoutesOptions {
  wordpressConnectionStore?: WordpressConnectionStore
}

function parseEnvInput(
  value: unknown,
  fieldName = 'env',
): WordpressEnv | undefined {
  const env = parseEnv(value)
  if (!env && value != null) {
    throw validationError(`${fieldName} must be "live" or "staging"`)
  }
  return env
}

function sendWordpressError(reply: FastifyReply, error: unknown): boolean {
  if (!(error instanceof WordpressApiError)) return false

  let appError: AppError
  switch (error.code) {
    case 'AUTH_INVALID':
      appError = new AppError('AUTH_INVALID', error.message, error.statusCode)
      break
    case 'NOT_FOUND':
      appError = new AppError('NOT_FOUND', error.message, error.statusCode)
      break
    case 'UPSTREAM_ERROR':
      appError = providerError(error.message, { statusCode: error.statusCode })
      break
    case 'UNSUPPORTED':
    case 'VALIDATION_ERROR':
      appError = validationError(error.message)
      break
    default:
      appError = providerError(error.message, { statusCode: error.statusCode })
      break
  }

  reply.status(appError.statusCode).send(appError.toJSON())
  return true
}

async function withWordpressErrorHandling<T>(
  reply: FastifyReply,
  handler: () => Promise<T>,
): Promise<T | void> {
  try {
    return await handler()
  } catch (error) {
    if (sendWordpressError(reply, error)) return
    throw error
  }
}

export async function wordpressRoutes(app: FastifyInstance, opts: WordpressRoutesOptions) {
  function requireStore(reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
    if (opts.wordpressConnectionStore) return opts.wordpressConnectionStore
    const err = validationError('WordPress connection storage is not configured for this deployment')
    reply.status(err.statusCode).send(err.toJSON())
    return null
  }

  function requireConnection(
    store: WordpressConnectionStore,
    projectName: string,
    reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  ) {
    const connection = store.getConnection(projectName)
    if (!connection) {
      const err = validationError(`No WordPress connection found for project "${projectName}". Run "canonry wordpress connect ${projectName}" first.`)
      reply.status(err.statusCode).send(err.toJSON())
      return null
    }
    return connection
  }

  app.post<{
    Params: { name: string }
    Body: {
      url: string
      stagingUrl?: string
      username: string
      appPassword: string
      defaultEnv?: WordpressEnv
    }
  }>('/projects/:name/wordpress/connect', async (request, reply) => {
    return withWordpressErrorHandling(reply, async () => {
      const store = requireStore(reply)
      if (!store) return

      const project = resolveProject(app.db, request.params.name)
      const { url, stagingUrl, username, appPassword } = request.body ?? {}
      if (!url || !username || !appPassword) {
        const err = validationError('url, username, and appPassword are required')
        return reply.status(err.statusCode).send(err.toJSON())
      }

      const defaultEnv = parseEnvInput(request.body?.defaultEnv, 'defaultEnv')
        ?? (stagingUrl ? 'staging' : 'live')
      if (defaultEnv === 'staging' && !stagingUrl) {
        const err = validationError('defaultEnv "staging" requires stagingUrl')
        return reply.status(err.statusCode).send(err.toJSON())
      }

      const now = new Date().toISOString()
      const existing = store.getConnection(project.name)
      const nextConnection: WordpressConnectionRecord = {
        projectName: project.name,
        url,
        stagingUrl,
        username,
        appPassword,
        defaultEnv,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }

      await verifyWordpressConnection(nextConnection)
      const connection = store.upsertConnection(nextConnection)
      const live = await getSiteStatus(connection, 'live')
      const staging = connection.stagingUrl ? await getSiteStatus(connection, 'staging') : null

      writeAuditLog(app.db, {
        projectId: project.id,
        actor: 'api',
        action: 'wordpress.connected',
        entityType: 'wordpress_connection',
        entityId: project.name,
      })

      return {
        connected: true,
        projectName: project.name,
        defaultEnv: connection.defaultEnv,
        live,
        staging,
        adminUrl: getWpStagingAdminUrl(connection.url),
      }
    })
  })

  app.delete<{ Params: { name: string } }>('/projects/:name/wordpress/disconnect', async (request, reply) => {
    const store = requireStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const deleted = store.deleteConnection(project.name)
    if (!deleted) {
      const err = notFound('WordPress connection', project.name)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'wordpress.disconnected',
      entityType: 'wordpress_connection',
      entityId: project.name,
    })

    return reply.status(204).send()
  })

  app.get<{ Params: { name: string } }>('/projects/:name/wordpress/status', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const connection = opts.wordpressConnectionStore?.getConnection(project.name)
    if (!connection) {
      return {
        connected: false,
        projectName: project.name,
        defaultEnv: 'live',
        live: null,
        staging: null,
        adminUrl: null,
      }
    }

    const live = await getSiteStatus(connection, 'live')
    const staging = connection.stagingUrl ? await getSiteStatus(connection, 'staging') : null
    return {
      connected: true,
      projectName: project.name,
      defaultEnv: connection.defaultEnv,
      live,
      staging,
      adminUrl: getWpStagingAdminUrl(connection.url),
    }
  })

  app.get<{
    Params: { name: string }
    Querystring: { env?: string }
  }>('/projects/:name/wordpress/pages', async (request, reply) => {
    return withWordpressErrorHandling(reply, async () => {
      const store = requireStore(reply)
      if (!store) return
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name, reply)
      if (!connection) return
      const env = parseEnvInput(request.query?.env)
      return {
        env: env ?? connection.defaultEnv,
        pages: await listPages(connection, env),
      }
    })
  })

  app.get<{
    Params: { name: string }
    Querystring: { slug?: string; env?: string }
  }>('/projects/:name/wordpress/page', async (request, reply) => {
    return withWordpressErrorHandling(reply, async () => {
      const store = requireStore(reply)
      if (!store) return
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name, reply)
      if (!connection) return
      const slug = request.query?.slug?.trim()
      if (!slug) {
        const err = validationError('slug is required')
        return reply.status(err.statusCode).send(err.toJSON())
      }
      const env = parseEnvInput(request.query?.env)
      return getPageDetail(connection, slug, env)
    })
  })

  app.post<{
    Params: { name: string }
    Body: { title: string; slug: string; content: string; status?: string; env?: WordpressEnv }
  }>('/projects/:name/wordpress/pages', async (request, reply) => {
    return withWordpressErrorHandling(reply, async () => {
      const store = requireStore(reply)
      if (!store) return
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name, reply)
      if (!connection) return
      const { title, slug, content, status } = request.body ?? {}
      const env = parseEnvInput(request.body?.env)
      if (!title || !slug || !content) {
        const err = validationError('title, slug, and content are required')
        return reply.status(err.statusCode).send(err.toJSON())
      }
      const created = await createPage(connection, { title, slug, content, status }, env)
      writeAuditLog(app.db, {
        projectId: project.id,
        actor: 'api',
        action: 'wordpress.page-created',
        entityType: 'wordpress_page',
        entityId: created.slug,
      })
      return created
    })
  })

  app.put<{
    Params: { name: string }
    Body: { currentSlug: string; title?: string; slug?: string; content?: string; status?: string; env?: WordpressEnv }
  }>('/projects/:name/wordpress/page', async (request, reply) => {
    return withWordpressErrorHandling(reply, async () => {
      const store = requireStore(reply)
      if (!store) return
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name, reply)
      if (!connection) return
      const currentSlug = request.body?.currentSlug?.trim()
      if (!currentSlug) {
        const err = validationError('currentSlug is required')
        return reply.status(err.statusCode).send(err.toJSON())
      }
      const env = parseEnvInput(request.body?.env)
      const updated = await updatePageBySlug(connection, currentSlug, {
        title: request.body?.title,
        slug: request.body?.slug,
        content: request.body?.content,
        status: request.body?.status,
      }, env)
      writeAuditLog(app.db, {
        projectId: project.id,
        actor: 'api',
        action: 'wordpress.page-updated',
        entityType: 'wordpress_page',
        entityId: currentSlug,
      })
      return updated
    })
  })

  app.post<{
    Params: { name: string }
    Body: { slug: string; title?: string; description?: string; noindex?: boolean; env?: WordpressEnv }
  }>('/projects/:name/wordpress/page/meta', async (request, reply) => {
    return withWordpressErrorHandling(reply, async () => {
      const store = requireStore(reply)
      if (!store) return
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name, reply)
      if (!connection) return
      const slug = request.body?.slug?.trim()
      if (!slug) {
        const err = validationError('slug is required')
        return reply.status(err.statusCode).send(err.toJSON())
      }
      const env = parseEnvInput(request.body?.env)
      const updated = await setSeoMeta(connection, slug, {
        title: request.body?.title,
        description: request.body?.description,
        noindex: request.body?.noindex,
      }, env)
      writeAuditLog(app.db, {
        projectId: project.id,
        actor: 'api',
        action: 'wordpress.page-meta-updated',
        entityType: 'wordpress_page',
        entityId: slug,
      })
      return updated
    })
  })

  app.get<{
    Params: { name: string }
    Querystring: { slug?: string; env?: string }
  }>('/projects/:name/wordpress/schema', async (request, reply) => {
    return withWordpressErrorHandling(reply, async () => {
      const store = requireStore(reply)
      if (!store) return
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name, reply)
      if (!connection) return
      const slug = request.query?.slug?.trim()
      if (!slug) {
        const err = validationError('slug is required')
        return reply.status(err.statusCode).send(err.toJSON())
      }
      const env = parseEnvInput(request.query?.env)
      return getPageSchema(connection, slug, env)
    })
  })

  app.post<{
    Params: { name: string }
    Body: { slug: string; type?: string; json: string; env?: WordpressEnv }
  }>('/projects/:name/wordpress/schema/manual', async (request, reply) => {
    return withWordpressErrorHandling(reply, async () => {
      const store = requireStore(reply)
      if (!store) return
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name, reply)
      if (!connection) return
      const slug = request.body?.slug?.trim()
      const json = request.body?.json
      if (!slug || !json) {
        const err = validationError('slug and json are required')
        return reply.status(err.statusCode).send(err.toJSON())
      }
      const env = parseEnvInput(request.body?.env)
      return buildManualSchemaUpdate(connection, slug, { type: request.body?.type, json }, env)
    })
  })

  app.get<{
    Params: { name: string }
    Querystring: { env?: string }
  }>('/projects/:name/wordpress/llms-txt', async (request, reply) => {
    return withWordpressErrorHandling(reply, async () => {
      const store = requireStore(reply)
      if (!store) return
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name, reply)
      if (!connection) return
      const env = parseEnvInput(request.query?.env)
      return getLlmsTxt(connection, env)
    })
  })

  app.post<{
    Params: { name: string }
    Body: { content: string; env?: WordpressEnv }
  }>('/projects/:name/wordpress/llms-txt/manual', async (request, reply) => {
    return withWordpressErrorHandling(reply, async () => {
      const store = requireStore(reply)
      if (!store) return
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name, reply)
      if (!connection) return
      const content = request.body?.content
      if (!content) {
        const err = validationError('content is required')
        return reply.status(err.statusCode).send(err.toJSON())
      }
      const env = parseEnvInput(request.body?.env)
      return buildManualLlmsTxtUpdate(connection, content, env)
    })
  })

  app.get<{
    Params: { name: string }
    Querystring: { env?: string }
  }>('/projects/:name/wordpress/audit', async (request, reply) => {
    return withWordpressErrorHandling(reply, async () => {
      const store = requireStore(reply)
      if (!store) return
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name, reply)
      if (!connection) return
      const env = parseEnvInput(request.query?.env)
      return runAudit(connection, env)
    })
  })

  app.get<{ Params: { name: string }; Querystring: { slug?: string } }>('/projects/:name/wordpress/diff', async (request, reply) => {
    return withWordpressErrorHandling(reply, async () => {
      const store = requireStore(reply)
      if (!store) return
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name, reply)
      if (!connection) return
      const slug = request.query?.slug?.trim()
      if (!slug) {
        const err = validationError('slug is required')
        return reply.status(err.statusCode).send(err.toJSON())
      }
      return diffPageAcrossEnvironments(connection, slug)
    })
  })

  app.get<{ Params: { name: string } }>('/projects/:name/wordpress/staging/status', async (request, reply) => {
    return withWordpressErrorHandling(reply, async () => {
      const store = requireStore(reply)
      if (!store) return
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name, reply)
      if (!connection) return

      const plugins = await listActivePlugins(connection, 'live')
      return {
        stagingConfigured: Boolean(connection.stagingUrl),
        stagingUrl: connection.stagingUrl ?? null,
        wpStagingActive: Boolean(plugins?.some((plugin: string) => plugin.includes('wp-staging'))),
        adminUrl: getWpStagingAdminUrl(connection.url),
      }
    })
  })

  app.post<{ Params: { name: string } }>('/projects/:name/wordpress/staging/push', async (request, reply) => {
    return withWordpressErrorHandling(reply, async () => {
      const store = requireStore(reply)
      if (!store) return
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name, reply)
      if (!connection) return
      if (!connection.stagingUrl) {
        const err = validationError('No staging URL configured for this project. Reconnect with --staging-url before using staging push.')
        return reply.status(err.statusCode).send(err.toJSON())
      }
      return buildManualStagingPush(connection)
    })
  })
}
