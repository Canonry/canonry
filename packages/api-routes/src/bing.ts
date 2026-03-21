import crypto from 'node:crypto'
import { eq, and, desc } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { bingUrlInspections } from '@ainyc/canonry-db'
import { validationError, notFound } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import {
  getSites,
  getUrlInfo,
  submitUrl,
  submitUrlBatch,
  getKeywordStats,
  BING_SUBMIT_URL_BATCH_LIMIT,
  BING_SUBMIT_URL_DAILY_LIMIT,
} from '@ainyc/canonry-integration-bing'

function bingLog(level: 'info' | 'warn' | 'error', action: string, ctx?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, module: 'BingRoutes', action, ...ctx }
  const stream = level === 'error' ? process.stderr : process.stdout
  stream.write(JSON.stringify(entry) + '\n')
}

export interface BingConnectionRecord {
  domain: string
  apiKey: string
  siteUrl?: string | null
  createdAt: string
  updatedAt: string
}

export interface BingConnectionStore {
  getConnection: (domain: string) => BingConnectionRecord | undefined
  upsertConnection: (connection: BingConnectionRecord) => BingConnectionRecord
  updateConnection: (
    domain: string,
    patch: Partial<Omit<BingConnectionRecord, 'domain' | 'createdAt'>>,
  ) => BingConnectionRecord | undefined
  deleteConnection: (domain: string) => boolean
}

export interface BingRoutesOptions {
  bingConnectionStore?: BingConnectionStore
}

export async function bingRoutes(app: FastifyInstance, opts: BingRoutesOptions) {
  function requireConnectionStore(reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
    if (opts.bingConnectionStore) return opts.bingConnectionStore
    const err = validationError('Bing connection storage is not configured for this deployment')
    reply.status(err.statusCode).send(err.toJSON())
    return null
  }

  function requireConnection(store: BingConnectionStore, domain: string, reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
    const conn = store.getConnection(domain)
    if (!conn) {
      const err = validationError('No Bing connection found for this domain. Run "canonry bing connect <project>" first.')
      reply.status(err.statusCode).send(err.toJSON())
      return null
    }
    return conn
  }

  // POST /projects/:name/bing/connect
  app.post<{
    Params: { name: string }
    Body: { apiKey: string }
  }>('/projects/:name/bing/connect', async (request, reply) => {
    const store = requireConnectionStore(reply)
    if (!store) return

    const { apiKey } = request.body ?? {}
    if (!apiKey || typeof apiKey !== 'string') {
      const err = validationError('apiKey is required')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const project = resolveProject(app.db, request.params.name)

    // Verify the API key by listing sites
    let sites
    try {
      sites = await getSites(apiKey)
      bingLog('info', 'connect.verify-key', { domain: project.canonicalDomain, siteCount: sites.length })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      bingLog('error', 'connect.verify-key-failed', { domain: project.canonicalDomain, error: msg })
      const err = validationError(`Failed to verify Bing API key: ${msg}`)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const now = new Date().toISOString()
    const existing = store.getConnection(project.canonicalDomain)
    store.upsertConnection({
      domain: project.canonicalDomain,
      apiKey,
      siteUrl: existing?.siteUrl ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'bing.connected',
      entityType: 'bing_connection',
      entityId: project.canonicalDomain,
    })

    return {
      connected: true,
      domain: project.canonicalDomain,
      siteUrl: existing?.siteUrl ?? null,
      availableSites: sites.map((s) => ({ url: s.Url, verified: s.Verified ?? false })),
    }
  })

  // DELETE /projects/:name/bing/disconnect
  app.delete<{ Params: { name: string } }>('/projects/:name/bing/disconnect', async (request, reply) => {
    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const deleted = store.deleteConnection(project.canonicalDomain)
    if (!deleted) {
      const err = notFound('Bing connection', project.canonicalDomain)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'bing.disconnected',
      entityType: 'bing_connection',
      entityId: project.canonicalDomain,
    })

    return reply.status(204).send()
  })

  // GET /projects/:name/bing/status
  app.get<{ Params: { name: string } }>('/projects/:name/bing/status', async (request, reply) => {
    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const conn = store.getConnection(project.canonicalDomain)

    return {
      connected: !!conn,
      domain: project.canonicalDomain,
      siteUrl: conn?.siteUrl ?? null,
      createdAt: conn?.createdAt ?? null,
      updatedAt: conn?.updatedAt ?? null,
    }
  })

  // GET /projects/:name/bing/sites
  app.get<{ Params: { name: string } }>('/projects/:name/bing/sites', async (request, reply) => {
    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const conn = requireConnection(store, project.canonicalDomain, reply)
    if (!conn) return

    const sites = await getSites(conn.apiKey)
    return { sites: sites.map((s) => ({ url: s.Url, verified: s.Verified ?? false })) }
  })

  // POST /projects/:name/bing/set-site
  app.post<{
    Params: { name: string }
    Body: { siteUrl: string }
  }>('/projects/:name/bing/set-site', async (request, reply) => {
    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const conn = requireConnection(store, project.canonicalDomain, reply)
    if (!conn) return

    const { siteUrl } = request.body ?? {}
    if (!siteUrl || typeof siteUrl !== 'string') {
      const err = validationError('siteUrl is required')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    store.updateConnection(project.canonicalDomain, {
      siteUrl,
      updatedAt: new Date().toISOString(),
    })

    return { siteUrl }
  })

  // GET /projects/:name/bing/coverage
  app.get<{ Params: { name: string } }>('/projects/:name/bing/coverage', async (request, reply) => {
    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const conn = requireConnection(store, project.canonicalDomain, reply)
    if (!conn) return

    // Get latest inspection per URL
    const allInspections = app.db
      .select()
      .from(bingUrlInspections)
      .where(eq(bingUrlInspections.projectId, project.id))
      .orderBy(desc(bingUrlInspections.inspectedAt))
      .all()

    const latestByUrl = new Map<string, typeof allInspections[number]>()
    for (const row of allInspections) {
      if (!latestByUrl.has(row.url)) {
        latestByUrl.set(row.url, row)
      }
    }

    const indexedUrls: typeof allInspections = []
    const notIndexedUrls: typeof allInspections = []
    let lastInspectedAt: string | null = null

    for (const [, row] of latestByUrl) {
      if (row.inIndex === 1) {
        indexedUrls.push(row)
      } else {
        notIndexedUrls.push(row)
      }
      if (!lastInspectedAt || row.inspectedAt > lastInspectedAt) {
        lastInspectedAt = row.inspectedAt
      }
    }

    const total = latestByUrl.size
    const indexed = indexedUrls.length
    const notIndexed = notIndexedUrls.length

    const formatRow = (r: typeof allInspections[number]) => ({
      id: r.id,
      url: r.url,
      httpCode: r.httpCode,
      inIndex: r.inIndex === 1 ? true : r.inIndex === 0 ? false : null,
      lastCrawledDate: r.lastCrawledDate,
      inIndexDate: r.inIndexDate,
      inspectedAt: r.inspectedAt,
    })

    return {
      summary: {
        total,
        indexed,
        notIndexed,
        percentage: total > 0 ? Math.round((indexed / total) * 1000) / 10 : 0,
      },
      lastInspectedAt,
      indexed: indexedUrls.map(formatRow),
      notIndexed: notIndexedUrls.map(formatRow),
    }
  })

  // GET /projects/:name/bing/inspections
  app.get<{
    Params: { name: string }
    Querystring: { url?: string; limit?: string }
  }>('/projects/:name/bing/inspections', async (request, reply) => {
    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const { url, limit } = request.query

    const whereClause = url
      ? and(eq(bingUrlInspections.projectId, project.id), eq(bingUrlInspections.url, url))
      : eq(bingUrlInspections.projectId, project.id)

    const filtered = app.db
      .select()
      .from(bingUrlInspections)
      .where(whereClause)
      .orderBy(desc(bingUrlInspections.inspectedAt))
      .limit(Math.max(1, Math.min(parseInt(limit ?? '100', 10) || 100, 1000)))
      .all()

    return filtered.map((r) => ({
      id: r.id,
      url: r.url,
      httpCode: r.httpCode,
      inIndex: r.inIndex === 1 ? true : r.inIndex === 0 ? false : null,
      lastCrawledDate: r.lastCrawledDate,
      inIndexDate: r.inIndexDate,
      inspectedAt: r.inspectedAt,
    }))
  })

  // POST /projects/:name/bing/inspect-url
  app.post<{
    Params: { name: string }
    Body: { url: string }
  }>('/projects/:name/bing/inspect-url', async (request, reply) => {
    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const conn = requireConnection(store, project.canonicalDomain, reply)
    if (!conn) return

    if (!conn.siteUrl) {
      const err = validationError('No Bing site configured. Run "canonry bing set-site <project> <url>" first.')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const { url } = request.body ?? {}
    if (!url) {
      const err = validationError('url is required')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    let result
    try {
      result = await getUrlInfo(conn.apiKey, conn.siteUrl, url)
      bingLog('info', 'inspect-url.result', { domain: project.canonicalDomain, url, httpCode: result.HttpCode ?? null, inIndex: result.InIndex ?? null, lastCrawledDate: result.LastCrawledDate ?? null })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      bingLog('error', 'inspect-url.failed', { domain: project.canonicalDomain, url, error: msg })
      throw e
    }

    const now = new Date().toISOString()
    const id = crypto.randomUUID()

    app.db.insert(bingUrlInspections).values({
      id,
      projectId: project.id,
      url,
      httpCode: result.HttpCode ?? null,
      inIndex: result.InIndex === true ? 1 : result.InIndex === false ? 0 : null,
      lastCrawledDate: result.LastCrawledDate ?? null,
      inIndexDate: result.InIndexDate ?? null,
      inspectedAt: now,
      createdAt: now,
    }).run()

    return {
      id,
      url,
      httpCode: result.HttpCode ?? null,
      inIndex: result.InIndex ?? null,
      lastCrawledDate: result.LastCrawledDate ?? null,
      inIndexDate: result.InIndexDate ?? null,
      inspectedAt: now,
    }
  })

  // POST /projects/:name/bing/request-indexing
  app.post<{
    Params: { name: string }
    Body: { urls?: string[]; allUnindexed?: boolean }
  }>('/projects/:name/bing/request-indexing', async (request, reply) => {
    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const conn = requireConnection(store, project.canonicalDomain, reply)
    if (!conn) return

    if (!conn.siteUrl) {
      const err = validationError('No Bing site configured. Run "canonry bing set-site <project> <url>" first.')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    let urlsToSubmit: string[] = request.body?.urls ?? []

    if (request.body?.allUnindexed) {
      const allInspections = app.db
        .select()
        .from(bingUrlInspections)
        .where(eq(bingUrlInspections.projectId, project.id))
        .orderBy(desc(bingUrlInspections.inspectedAt))
        .all()

      const latestByUrl = new Map<string, typeof allInspections[number]>()
      for (const row of allInspections) {
        if (!latestByUrl.has(row.url)) {
          latestByUrl.set(row.url, row)
        }
      }

      const unindexedUrls: string[] = []
      for (const [url, row] of latestByUrl) {
        if (row.inIndex !== 1) {
          unindexedUrls.push(url)
        }
      }

      if (unindexedUrls.length === 0) {
        const err = validationError('No unindexed URLs found. Run "canonry bing inspect <project> <url>" first.')
        return reply.status(err.statusCode).send(err.toJSON())
      }

      urlsToSubmit = unindexedUrls
    }

    if (urlsToSubmit.length === 0) {
      const err = validationError('At least one URL is required (or use allUnindexed: true)')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    if (urlsToSubmit.length > BING_SUBMIT_URL_DAILY_LIMIT) {
      const err = validationError(`Cannot submit more than ${BING_SUBMIT_URL_DAILY_LIMIT} URLs per day (got ${urlsToSubmit.length})`)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const results: Array<{
      url: string
      status: 'success' | 'error'
      submittedAt: string
      error?: string
    }> = []

    bingLog('info', 'index-submit.start', { domain: project.canonicalDomain, siteUrl: conn.siteUrl, urlCount: urlsToSubmit.length, allUnindexed: !!request.body?.allUnindexed })

    // Use batch submission for multiple URLs
    if (urlsToSubmit.length > 1) {
      for (let i = 0; i < urlsToSubmit.length; i += BING_SUBMIT_URL_BATCH_LIMIT) {
        const batch = urlsToSubmit.slice(i, i + BING_SUBMIT_URL_BATCH_LIMIT)
        try {
          await submitUrlBatch(conn.apiKey, conn.siteUrl, batch)
          const now = new Date().toISOString()
          for (const url of batch) {
            results.push({ url, status: 'success', submittedAt: now })
          }
          bingLog('info', 'index-submit.batch-ok', { domain: project.canonicalDomain, batchSize: batch.length, urls: batch })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          const now = new Date().toISOString()
          for (const url of batch) {
            results.push({ url, status: 'error', submittedAt: now, error: msg })
          }
          bingLog('error', 'index-submit.batch-failed', { domain: project.canonicalDomain, batchSize: batch.length, urls: batch, error: msg })
        }
      }
    } else {
      // Single URL submission
      const url = urlsToSubmit[0]!
      try {
        await submitUrl(conn.apiKey, conn.siteUrl, url)
        results.push({ url, status: 'success', submittedAt: new Date().toISOString() })
        bingLog('info', 'index-submit.ok', { domain: project.canonicalDomain, url })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        results.push({ url, status: 'error', submittedAt: new Date().toISOString(), error: msg })
        bingLog('error', 'index-submit.failed', { domain: project.canonicalDomain, url, error: msg })
      }
    }

    const succeeded = results.filter((r) => r.status === 'success').length
    const failed = results.filter((r) => r.status === 'error').length

    bingLog('info', 'index-submit.complete', { domain: project.canonicalDomain, total: results.length, succeeded, failed })

    return {
      summary: { total: results.length, succeeded, failed },
      results,
    }
  })

  // GET /projects/:name/bing/performance
  app.get<{
    Params: { name: string }
    Querystring: { limit?: string }
  }>('/projects/:name/bing/performance', async (request, reply) => {
    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const conn = requireConnection(store, project.canonicalDomain, reply)
    if (!conn) return

    if (!conn.siteUrl) {
      const err = validationError('No Bing site configured. Run "canonry bing set-site <project> <url>" first.')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const stats = await getKeywordStats(conn.apiKey, conn.siteUrl)

    return stats.map((s) => ({
      query: s.Query,
      impressions: s.Impressions,
      clicks: s.Clicks,
      ctr: s.Ctr,
      averagePosition: s.AverageClickPosition ?? s.AverageImpressionPosition ?? 0,
    }))
  })
}
