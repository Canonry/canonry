import crypto from 'node:crypto'
import { eq, and, desc } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { bingUrlInspections, bingCoverageSnapshots, runs } from '@ainyc/canonry-db'
import { validationError, notFound, RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
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

/**
 * Convert Bing's /Date(epoch-offset)/ format to an ISO 8601 string.
 * Returns null if the value is absent or represents the epoch-zero sentinel
 * (-62135568000000) that Bing uses for "never".
 */
function parseBingDate(value: string | undefined | null): string | null {
  if (!value) return null
  const match = /\/Date\((-?\d+)[^)]*\)\//.exec(value)
  if (!match) return null
  const ms = parseInt(match[1], 10)
  // Bing uses -62135568000000 as a sentinel for "unknown / never"
  if (ms <= 0) return null
  return new Date(ms).toISOString()
}

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
  function requireConnectionStore(): BingConnectionStore {
    if (opts.bingConnectionStore) return opts.bingConnectionStore
    throw validationError('Bing connection storage is not configured for this deployment')
  }

  function requireConnection(store: BingConnectionStore, domain: string): BingConnectionRecord {
    const conn = store.getConnection(domain)
    if (!conn) {
      throw validationError('No Bing connection found for this domain. Run "canonry bing connect <project>" first.')
    }
    return conn
  }

  // POST /projects/:name/bing/connect
  app.post<{
    Params: { name: string }
    Body: { apiKey: string }
  }>('/projects/:name/bing/connect', async (request) => {
    const store = requireConnectionStore()

    const { apiKey } = request.body ?? {}
    if (!apiKey || typeof apiKey !== 'string') {
      throw validationError('apiKey is required')
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
      throw validationError(`Failed to verify Bing API key: ${msg}`)
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
    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const deleted = store.deleteConnection(project.canonicalDomain)
    if (!deleted) {
      throw notFound('Bing connection', project.canonicalDomain)
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
  app.get<{ Params: { name: string } }>('/projects/:name/bing/status', async (request) => {
    const store = requireConnectionStore()

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
  app.get<{ Params: { name: string } }>('/projects/:name/bing/sites', async (request) => {
    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const conn = requireConnection(store, project.canonicalDomain)

    const sites = await getSites(conn.apiKey)
    return { sites: sites.map((s) => ({ url: s.Url, verified: s.Verified ?? false })) }
  })

  // POST /projects/:name/bing/set-site
  app.post<{
    Params: { name: string }
    Body: { siteUrl: string }
  }>('/projects/:name/bing/set-site', async (request) => {
    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    requireConnection(store, project.canonicalDomain)

    const { siteUrl } = request.body ?? {}
    if (!siteUrl || typeof siteUrl !== 'string') {
      throw validationError('siteUrl is required')
    }

    store.updateConnection(project.canonicalDomain, {
      siteUrl,
      updatedAt: new Date().toISOString(),
    })

    return { siteUrl }
  })

  // GET /projects/:name/bing/coverage
  app.get<{ Params: { name: string } }>('/projects/:name/bing/coverage', async (request) => {
    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    requireConnection(store, project.canonicalDomain)

    // Get latest inspection per URL
    const allInspections = app.db
      .select()
      .from(bingUrlInspections)
      .where(eq(bingUrlInspections.projectId, project.id))
      .orderBy(desc(bingUrlInspections.inspectedAt))
      .all()

    // Pick the best inspection per URL: prefer the latest one that has a
    // definitive inIndex value (0 or 1).  If the most recent inspection is
    // inconclusive (inIndex === null — common with Bing API inconsistencies),
    // fall back to the most recent inspection that DID have a definitive answer.
    const latestByUrl = new Map<string, typeof allInspections[number]>()
    const definitiveByUrl = new Map<string, typeof allInspections[number]>()
    for (const row of allInspections) {
      if (!latestByUrl.has(row.url)) {
        latestByUrl.set(row.url, row)
      }
      if (!definitiveByUrl.has(row.url) && row.inIndex != null) {
        definitiveByUrl.set(row.url, row)
      }
    }
    // Merge: use definitive answer when latest is inconclusive
    for (const [url, latest] of latestByUrl) {
      if (latest.inIndex == null) {
        const definitive = definitiveByUrl.get(url)
        if (definitive) {
          latestByUrl.set(url, definitive)
        }
      }
    }

    const indexedUrls: typeof allInspections = []
    const notIndexedUrls: typeof allInspections = []
    const unknownUrls: typeof allInspections = []
    let lastInspectedAt: string | null = null
    let snapshotRunId: string | null = null

    for (const [, row] of latestByUrl) {
      if (row.inIndex === 1) {
        indexedUrls.push(row)
      } else if (row.inIndex === 0) {
        notIndexedUrls.push(row)
      } else {
        unknownUrls.push(row)
      }
      if (!lastInspectedAt || row.inspectedAt > lastInspectedAt) {
        lastInspectedAt = row.inspectedAt
        snapshotRunId = row.syncRunId ?? null
      }
    }

    const indexed = indexedUrls.length
    const notIndexed = notIndexedUrls.length
    const unknown = unknownUrls.length
    const total = indexed + notIndexed + unknown

    const formatRow = (r: typeof allInspections[number]) => ({
      id: r.id,
      url: r.url,
      httpCode: r.httpCode,
      inIndex: r.inIndex === 1 ? true : r.inIndex === 0 ? false : null,
      lastCrawledDate: r.lastCrawledDate,
      inIndexDate: r.inIndexDate,
      inspectedAt: r.inspectedAt,
      documentSize: r.documentSize ?? null,
      anchorCount: r.anchorCount ?? null,
      discoveryDate: r.discoveryDate ?? null,
    })

    // Save a daily coverage snapshot (idempotent per day via upsert)
    if (total > 0) {
      const snapshotDate = new Date().toISOString().split('T')[0]!
      const now = new Date().toISOString()
      app.db.insert(bingCoverageSnapshots).values({
        id: crypto.randomUUID(),
        projectId: project.id,
        syncRunId: snapshotRunId,
        date: snapshotDate,
        indexed,
        notIndexed,
        unknown,
        createdAt: now,
      }).onConflictDoUpdate({
        target: [bingCoverageSnapshots.projectId, bingCoverageSnapshots.date],
        set: { indexed, notIndexed, unknown, createdAt: now, syncRunId: snapshotRunId },
      }).run()
    }

    return {
      summary: {
        total,
        indexed,
        notIndexed,
        unknown,
        percentage: total > 0 ? Math.round((indexed / total) * 1000) / 10 : 0,
      },
      lastInspectedAt,
      indexed: indexedUrls.map(formatRow),
      notIndexed: notIndexedUrls.map(formatRow),
      unknown: unknownUrls.map(formatRow),
    }
  })

  // GET /projects/:name/bing/coverage/history
  app.get<{
    Params: { name: string }
    Querystring: { limit?: string }
  }>('/projects/:name/bing/coverage/history', async (request) => {
    requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const parsed = parseInt(request.query.limit ?? '90', 10)
    const limit = Number.isNaN(parsed) || parsed <= 0 ? 90 : parsed

    const rows = app.db
      .select()
      .from(bingCoverageSnapshots)
      .where(eq(bingCoverageSnapshots.projectId, project.id))
      .orderBy(desc(bingCoverageSnapshots.date))
      .limit(limit)
      .all()

    return rows.map((r) => ({
      date: r.date,
      indexed: r.indexed,
      notIndexed: r.notIndexed,
      unknown: r.unknown,
    }))
  })

  // GET /projects/:name/bing/inspections
  app.get<{
    Params: { name: string }
    Querystring: { url?: string; limit?: string }
  }>('/projects/:name/bing/inspections', async (request) => {
    requireConnectionStore()

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
      documentSize: r.documentSize ?? null,
      anchorCount: r.anchorCount ?? null,
      discoveryDate: r.discoveryDate ?? null,
    }))
  })

  // POST /projects/:name/bing/inspect-url
  app.post<{
    Params: { name: string }
    Body: { url: string }
  }>('/projects/:name/bing/inspect-url', async (request) => {
    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const conn = requireConnection(store, project.canonicalDomain)

    if (!conn.siteUrl) {
      throw validationError('No Bing site configured. Run "canonry bing set-site <project> <url>" first.')
    }

    const { url } = request.body ?? {}
    if (!url) {
      throw validationError('url is required')
    }

    const startedAt = new Date().toISOString()
    const runId = crypto.randomUUID()
    app.db.insert(runs).values({
      id: runId,
      projectId: project.id,
      kind: RunKinds['bing-inspect'],
      status: RunStatuses.running,
      trigger: RunTriggers.manual,
      startedAt,
      createdAt: startedAt,
    }).run()

    try {
      const result = await getUrlInfo(conn.apiKey, conn.siteUrl, url)
      bingLog('info', 'inspect-url.result', {
        domain: project.canonicalDomain,
        url,
        httpStatus: result.HttpStatus ?? result.HttpCode ?? null,
        inIndex: result.InIndex ?? null,
        documentSize: result.DocumentSize ?? null,
        lastCrawledDate: result.LastCrawledDate ?? null,
      })
      const now = new Date().toISOString()
      const id = crypto.randomUUID()
      const httpCode = result.HttpStatus ?? result.HttpCode ?? null

      // Bing's published GetUrlInfo contract documents UrlInfo via:
      // https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi.geturlinfo?view=bing-webmaster-dotnet
      // WSDL: https://ssl.bing.com/webmaster/api.svc?singleWsdl
      // Use any explicit legacy InIndex flag if it is present. Otherwise, only a
      // positive DocumentSize is strong enough to treat the URL as indexed.
      // Zero-byte responses stay unknown instead of being forced to "not indexed".
      let derivedInIndex: boolean | null = null
      if (result.InIndex != null) {
        derivedInIndex = result.InIndex
      } else if (result.DocumentSize != null && result.DocumentSize > 0) {
        derivedInIndex = true
      }

      const lastCrawledDate = parseBingDate(result.LastCrawledDate)
      const inIndexDate = parseBingDate(result.InIndexDate)
      const discoveryDate = parseBingDate(result.DiscoveryDate)

      app.db.insert(bingUrlInspections).values({
        id,
        projectId: project.id,
        url,
        httpCode,
        inIndex: derivedInIndex === true ? 1 : derivedInIndex === false ? 0 : null,
        lastCrawledDate,
        inIndexDate,
        inspectedAt: now,
        syncRunId: runId,
        createdAt: now,
        documentSize: result.DocumentSize ?? null,
        anchorCount: result.AnchorCount ?? null,
        discoveryDate,
      }).run()

      app.db.update(runs)
        .set({ status: RunStatuses.completed, finishedAt: now })
        .where(eq(runs.id, runId))
        .run()

      return {
        id,
        url,
        httpCode,
        inIndex: derivedInIndex,
        lastCrawledDate,
        inIndexDate,
        inspectedAt: now,
        documentSize: result.DocumentSize ?? null,
        anchorCount: result.AnchorCount ?? null,
        discoveryDate,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      bingLog('error', 'inspect-url.failed', { domain: project.canonicalDomain, url, error: msg })
      app.db.update(runs)
        .set({ status: RunStatuses.failed, error: msg, finishedAt: new Date().toISOString() })
        .where(eq(runs.id, runId))
        .run()
      throw e
    }
  })

  // POST /projects/:name/bing/request-indexing
  app.post<{
    Params: { name: string }
    Body: { urls?: string[]; allUnindexed?: boolean }
  }>('/projects/:name/bing/request-indexing', async (request) => {
    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const conn = requireConnection(store, project.canonicalDomain)

    if (!conn.siteUrl) {
      throw validationError('No Bing site configured. Run "canonry bing set-site <project> <url>" first.')
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
        if (row.inIndex === 0 || row.inIndex === null) {
          unindexedUrls.push(url)
        }
      }

      if (unindexedUrls.length === 0) {
        throw validationError('No unindexed or unknown URLs found. Run "canonry bing inspect <project> <url>" first.')
      }

      urlsToSubmit = unindexedUrls
    }

    if (urlsToSubmit.length === 0) {
      throw validationError('At least one URL is required (or use allUnindexed: true)')
    }

    if (urlsToSubmit.length > BING_SUBMIT_URL_DAILY_LIMIT) {
      throw validationError(`Cannot submit more than ${BING_SUBMIT_URL_DAILY_LIMIT} URLs per day (got ${urlsToSubmit.length})`)
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
  }>('/projects/:name/bing/performance', async (request) => {
    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const conn = requireConnection(store, project.canonicalDomain)

    if (!conn.siteUrl) {
      throw validationError('No Bing site configured. Run "canonry bing set-site <project> <url>" first.')
    }

    const stats = await getKeywordStats(conn.apiKey, conn.siteUrl)

    return stats.map((s) => ({
      query: s.Query,
      impressions: s.Impressions,
      clicks: s.Clicks,
      ctr: s.Impressions > 0 ? s.Clicks / s.Impressions : 0,
      averagePosition: s.AverageClickPosition ?? s.AverageImpressionPosition ?? 0,
    }))
  })
}
