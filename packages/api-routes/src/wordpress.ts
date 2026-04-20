import type { FastifyInstance } from 'fastify'
import { AppError, notFound, providerError, validationError } from '@ainyc/canonry-contracts'
import type { WordpressEnv } from '@ainyc/canonry-contracts'
import {
  buildManualLlmsTxtUpdate,
  buildManualSchemaUpdate,
  buildManualStagingPush,
  bulkSetSeoMeta,
  createPage,
  deploySchemaFromProfile,
  diffPageAcrossEnvironments,
  getLlmsTxt,
  getPageDetail,
  getPageSchema,
  getSchemaStatus,
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
import type { SchemaProfileFile, WordpressConnectionRecord } from '@ainyc/canonry-integration-wordpress'
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
  routePrefix?: string
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

function toAppError(error: WordpressApiError): AppError {
  switch (error.code) {
    case 'AUTH_INVALID':
      return new AppError('AUTH_INVALID', error.message, error.statusCode)
    case 'NOT_FOUND':
      return new AppError('NOT_FOUND', error.message, error.statusCode)
    case 'UNSUPPORTED':
    case 'VALIDATION_ERROR':
      return validationError(error.message)
    case 'UPSTREAM_ERROR':
    default:
      return providerError(error.message, { statusCode: error.statusCode })
  }
}

async function withWordpressErrorHandling<T>(handler: () => Promise<T>): Promise<T> {
  try {
    return await handler()
  } catch (error) {
    if (error instanceof WordpressApiError) throw toAppError(error)
    throw error
  }
}

export async function wordpressRoutes(app: FastifyInstance, opts: WordpressRoutesOptions) {
  function requireStore(): WordpressConnectionStore {
    if (opts.wordpressConnectionStore) return opts.wordpressConnectionStore
    throw validationError('WordPress connection storage is not configured for this deployment')
  }

  function requireConnection(store: WordpressConnectionStore, projectName: string): WordpressConnectionRecord {
    const connection = store.getConnection(projectName)
    if (!connection) {
      throw validationError(`No WordPress connection found for project "${projectName}". Run "canonry wordpress connect ${projectName}" first.`)
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
  }>('/projects/:name/wordpress/connect', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()

      const project = resolveProject(app.db, request.params.name)
      const { url, stagingUrl, username, appPassword } = request.body ?? {}
      if (!url || !username || !appPassword) {
        throw validationError('url, username, and appPassword are required')
      }

      const defaultEnv = parseEnvInput(request.body?.defaultEnv, 'defaultEnv')
        ?? (stagingUrl ? 'staging' : 'live')
      if (defaultEnv === 'staging' && !stagingUrl) {
        throw validationError('defaultEnv "staging" requires stagingUrl')
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
    const store = requireStore()

    const project = resolveProject(app.db, request.params.name)
    const deleted = store.deleteConnection(project.name)
    if (!deleted) {
      throw notFound('WordPress connection', project.name)
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
  }>('/projects/:name/wordpress/pages', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)
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
  }>('/projects/:name/wordpress/page', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)
      const slug = request.query?.slug?.trim()
      if (!slug) {
        throw validationError('slug is required')
      }
      const env = parseEnvInput(request.query?.env)
      return getPageDetail(connection, slug, env)
    })
  })

  app.post<{
    Params: { name: string }
    Body: { title: string; slug: string; content: string; status?: string; env?: WordpressEnv }
  }>('/projects/:name/wordpress/pages', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)
      const { title, slug, content, status } = request.body ?? {}
      const env = parseEnvInput(request.body?.env)
      if (!title || !slug || !content) {
        throw validationError('title, slug, and content are required')
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
  }>('/projects/:name/wordpress/page', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)
      const currentSlug = request.body?.currentSlug?.trim()
      if (!currentSlug) {
        throw validationError('currentSlug is required')
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
  }>('/projects/:name/wordpress/page/meta', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)
      const slug = request.body?.slug?.trim()
      if (!slug) {
        throw validationError('slug is required')
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

  app.post<{
    Params: { name: string }
    Body: {
      entries: Array<{ slug: string; title?: string; description?: string; noindex?: boolean }>
      env?: WordpressEnv
    }
  }>('/projects/:name/wordpress/pages/meta/bulk', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)
      const entries = request.body?.entries
      if (!Array.isArray(entries) || entries.length === 0) {
        throw validationError('entries array is required and must not be empty')
      }
      for (const entry of entries) {
        if (!entry.slug?.trim()) {
          throw validationError('each entry must have a slug')
        }
      }
      const env = parseEnvInput(request.body?.env)
      const result = await bulkSetSeoMeta(connection, entries, env)
      const applied = result.results.filter((r) => r.status === 'applied')
      if (applied.length > 0) {
        writeAuditLog(app.db, {
          projectId: project.id,
          actor: 'api',
          action: 'wordpress.page-meta-updated',
          entityType: 'wordpress_page',
          entityId: `bulk(${applied.map((r) => r.slug).join(',')})`,
        })
      }
      return result
    })
  })

  app.get<{
    Params: { name: string }
    Querystring: { slug?: string; env?: string }
  }>('/projects/:name/wordpress/schema', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)
      const slug = request.query?.slug?.trim()
      if (!slug) {
        throw validationError('slug is required')
      }
      const env = parseEnvInput(request.query?.env)
      return getPageSchema(connection, slug, env)
    })
  })

  app.post<{
    Params: { name: string }
    Body: { slug: string; type?: string; json: string; env?: WordpressEnv }
  }>('/projects/:name/wordpress/schema/manual', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)
      const slug = request.body?.slug?.trim()
      const json = request.body?.json
      if (!slug || !json) {
        throw validationError('slug and json are required')
      }
      const env = parseEnvInput(request.body?.env)
      return buildManualSchemaUpdate(connection, slug, { type: request.body?.type, json }, env)
    })
  })

  app.post<{
    Params: { name: string }
    Body: { profile: SchemaProfileFile; env?: WordpressEnv }
  }>('/projects/:name/wordpress/schema/deploy', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)
      const profile = request.body?.profile
      if (!profile?.business?.name || !profile?.pages || Object.keys(profile.pages).length === 0) {
        throw validationError('profile with business.name and non-empty pages is required')
      }
      const env = parseEnvInput(request.body?.env)
      return deploySchemaFromProfile(connection, profile, env)
    })
  })

  app.get<{
    Params: { name: string }
    Querystring: { env?: string }
  }>('/projects/:name/wordpress/schema/status', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)
      const env = parseEnvInput(request.query?.env)
      return getSchemaStatus(connection, env)
    })
  })

  app.get<{
    Params: { name: string }
    Querystring: { env?: string }
  }>('/projects/:name/wordpress/llms-txt', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)
      const env = parseEnvInput(request.query?.env)
      return getLlmsTxt(connection, env)
    })
  })

  app.post<{
    Params: { name: string }
    Body: { content: string; env?: WordpressEnv }
  }>('/projects/:name/wordpress/llms-txt/manual', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)
      const content = request.body?.content
      if (!content) {
        throw validationError('content is required')
      }
      const env = parseEnvInput(request.body?.env)
      return buildManualLlmsTxtUpdate(connection, content, env)
    })
  })

  app.get<{
    Params: { name: string }
    Querystring: { env?: string }
  }>('/projects/:name/wordpress/audit', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)
      const env = parseEnvInput(request.query?.env)
      return runAudit(connection, env)
    })
  })

  app.get<{ Params: { name: string }; Querystring: { slug?: string } }>('/projects/:name/wordpress/diff', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)
      const slug = request.query?.slug?.trim()
      if (!slug) {
        throw validationError('slug is required')
      }
      return diffPageAcrossEnvironments(connection, slug)
    })
  })

  app.get<{ Params: { name: string } }>('/projects/:name/wordpress/staging/status', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)

      const plugins = await listActivePlugins(connection, 'live')
      return {
        stagingConfigured: Boolean(connection.stagingUrl),
        stagingUrl: connection.stagingUrl ?? null,
        wpStagingActive: Boolean(plugins?.some((plugin: string) => plugin.includes('wp-staging'))),
        adminUrl: getWpStagingAdminUrl(connection.url),
      }
    })
  })

  app.post<{ Params: { name: string } }>('/projects/:name/wordpress/staging/push', async (request) => {
    return withWordpressErrorHandling(async () => {
      const store = requireStore()
      const project = resolveProject(app.db, request.params.name)
      const connection = requireConnection(store, project.name)
      if (!connection.stagingUrl) {
        throw validationError('No staging URL configured for this project. Reconnect with --staging-url before using staging push.')
      }
      return buildManualStagingPush(connection)
    })
  })

  // POST /projects/:name/wordpress/onboard — compound onboarding command
  app.post<{
    Params: { name: string }
    Body: {
      url: string
      username: string
      appPassword: string
      stagingUrl?: string
      defaultEnv?: WordpressEnv
      profile?: SchemaProfileFile
      skipSchema?: boolean
      skipSubmit?: boolean
    }
  }>('/projects/:name/wordpress/onboard', async (request) => {
    return withWordpressErrorHandling(async () => {
    const store = requireStore()

    const project = resolveProject(app.db, request.params.name)
    const { url, username, appPassword, stagingUrl, profile, skipSchema, skipSubmit } = request.body ?? {}

    if (!url || !username || !appPassword) {
      throw validationError('url, username, and appPassword are required')
    }

    const defaultEnv = parseEnvInput(request.body?.defaultEnv, 'defaultEnv')
      ?? (stagingUrl ? 'staging' : 'live')

    if (defaultEnv === 'staging' && !stagingUrl) {
      throw validationError('defaultEnv "staging" requires stagingUrl')
    }

    type StepResult = { name: string; status: 'completed' | 'skipped' | 'failed'; summary?: string; error?: string }
    const steps: StepResult[] = []
    let connection: WordpressConnectionRecord | null = null
    let pageUrls: string[] = []

    // Step 1: Connect
    try {
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
      connection = store.upsertConnection(nextConnection)
      writeAuditLog(app.db, {
        projectId: project.id,
        actor: 'api',
        action: 'wordpress.connected',
        entityType: 'wordpress_connection',
        entityId: project.name,
      })
      steps.push({ name: 'connect', status: 'completed', summary: `Connected to ${url}` })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      steps.push({ name: 'connect', status: 'failed', error: msg })
      return { projectName: project.name, steps }
    }

    // Step 2: Audit
    let auditIssues: Array<{ slug: string; code: string }> = []
    let auditPages: Array<{ slug: string; title: string }> = []
    try {
      const audit = await runAudit(connection)
      const issueCount = audit.issues?.length ?? 0
      const pageCount = audit.pages?.length ?? 0
      auditIssues = audit.issues
      auditPages = audit.pages

      // Get proper permalink URLs from listPages (handles hierarchical slugs + custom permalinks)
      const pageSummaries = await listPages(connection)
      pageUrls = pageSummaries
        .map((p) => p.link)
        .filter((link): link is string => typeof link === 'string' && link.length > 0)

      steps.push({ name: 'audit', status: 'completed', summary: `${pageCount} pages audited, ${issueCount} issues` })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      steps.push({ name: 'audit', status: 'failed', error: msg })
      return { projectName: project.name, steps }
    }

    // Step 3: Set meta (bulk, for pages missing title/description)
    // Build entries with the page title as a fallback value for missing SEO fields
    try {
      const metaEntries: Array<{ slug: string; title?: string; description?: string }> = []
      for (const issue of auditIssues) {
        if (issue.code === 'missing-meta-description' || issue.code === 'missing-seo-title') {
          const existing = metaEntries.find((e) => e.slug === issue.slug)
          const page = auditPages.find((p) => p.slug === issue.slug)
          if (!existing) {
            metaEntries.push({
              slug: issue.slug,
              title: issue.code === 'missing-seo-title' ? (page?.title ?? issue.slug) : undefined,
              description: issue.code === 'missing-meta-description' ? (page?.title ?? issue.slug) : undefined,
            })
          } else {
            if (issue.code === 'missing-seo-title' && !existing.title) {
              existing.title = page?.title ?? issue.slug
            }
            if (issue.code === 'missing-meta-description' && !existing.description) {
              existing.description = page?.title ?? issue.slug
            }
          }
        }
      }
      if (metaEntries.length === 0) {
        steps.push({ name: 'set-meta', status: 'skipped', summary: 'No pages with missing meta found' })
      } else {
        const result = await bulkSetSeoMeta(connection, metaEntries)
        const applied = result.results.filter((r) => r.status === 'applied').length
        const manual = result.results.filter((r) => r.status === 'manual').length
        const skipped = result.results.filter((r) => r.status === 'skipped').length
        steps.push({
          name: 'set-meta',
          status: 'completed',
          summary: `${applied} applied, ${manual} manual-assist, ${skipped} skipped`,
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      steps.push({ name: 'set-meta', status: 'failed', error: msg })
      return { projectName: project.name, steps }
    }

    // Step 4: Schema deploy (if profile provided and not skipped)
    if (skipSchema || !profile) {
      steps.push({
        name: 'schema-deploy',
        status: 'skipped',
        summary: skipSchema ? 'Skipped via --skip-schema' : 'No --profile provided',
      })
    } else {
      try {
        if (!profile.business?.name || !profile.pages || Object.keys(profile.pages).length === 0) {
          steps.push({ name: 'schema-deploy', status: 'skipped', summary: 'Profile missing business.name or pages' })
        } else {
          const result = await deploySchemaFromProfile(connection, profile)
          const deployed = result.results.filter((r) => r.status === 'deployed').length
          const stripped = result.results.filter((r) => r.status === 'stripped').length
          const skipped = result.results.filter((r) => r.status === 'skipped').length
          steps.push({
            name: 'schema-deploy',
            status: 'completed',
            summary: `${deployed} deployed, ${stripped} stripped (manual-assist), ${skipped} skipped`,
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        steps.push({ name: 'schema-deploy', status: 'failed', error: msg })
        return { projectName: project.name, steps }
      }
    }

    // Step 5 & 6: Submit URLs to Google/Bing (via app.inject)
    if (skipSubmit || pageUrls.length === 0) {
      const reason = skipSubmit ? 'Skipped via --skip-submit' : 'No page URLs to submit'
      steps.push({ name: 'google-submit', status: 'skipped', summary: reason })
      steps.push({ name: 'bing-submit', status: 'skipped', summary: reason })
    } else {
      // Step 5: Google submit
      try {
        const authHeader = request.headers.authorization
        const googleRes = await app.inject({
          method: 'POST',
          url: `${opts.routePrefix ?? '/api/v1'}/projects/${encodeURIComponent(project.name)}/google/indexing/request`,
          payload: { urls: pageUrls },
          headers: authHeader ? { authorization: authHeader } : {},
        })
        if (googleRes.statusCode === 200) {
          const body = JSON.parse(googleRes.body)
          const succeeded = body.results?.filter((r: { status: string }) => r.status === 'success').length ?? 0
          steps.push({ name: 'google-submit', status: 'completed', summary: `${succeeded}/${pageUrls.length} URLs submitted` })
        } else {
          const body = JSON.parse(googleRes.body)
          const msg = body.message || body.error || `HTTP ${googleRes.statusCode}`
          // Treat "not configured" as skipped, not failed
          if (googleRes.statusCode === 400 || googleRes.statusCode === 404) {
            steps.push({ name: 'google-submit', status: 'skipped', summary: msg })
          } else {
            steps.push({ name: 'google-submit', status: 'failed', error: msg })
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        steps.push({ name: 'google-submit', status: 'skipped', summary: `Google not available: ${msg}` })
      }

      // Step 6: Bing submit
      try {
        const authHeader = request.headers.authorization
        const bingRes = await app.inject({
          method: 'POST',
          url: `${opts.routePrefix ?? '/api/v1'}/projects/${encodeURIComponent(project.name)}/bing/request-indexing`,
          payload: { urls: pageUrls },
          headers: authHeader ? { authorization: authHeader } : {},
        })
        if (bingRes.statusCode === 200) {
          const body = JSON.parse(bingRes.body)
          const succeeded = body.results?.filter((r: { status: string }) => r.status === 'success').length ?? 0
          steps.push({ name: 'bing-submit', status: 'completed', summary: `${succeeded}/${pageUrls.length} URLs submitted` })
        } else {
          const body = JSON.parse(bingRes.body)
          const msg = body.message || body.error || `HTTP ${bingRes.statusCode}`
          if (bingRes.statusCode === 400 || bingRes.statusCode === 404) {
            steps.push({ name: 'bing-submit', status: 'skipped', summary: msg })
          } else {
            steps.push({ name: 'bing-submit', status: 'failed', error: msg })
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        steps.push({ name: 'bing-submit', status: 'skipped', summary: `Bing not available: ${msg}` })
      }
    }

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'wordpress.onboarded',
      entityType: 'wordpress_connection',
      entityId: project.name,
    })

    return { projectName: project.name, steps }
    }) // end withWordpressErrorHandling
  })
}
