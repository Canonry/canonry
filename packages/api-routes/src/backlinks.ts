import crypto from 'node:crypto'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  backlinkDomains,
  backlinkSummaries,
  ccReleaseSyncs,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  CcReleaseSyncStatuses,
  RunKinds,
  RunStatuses,
  RunTriggers,
  missingDependency,
  parseRunError,
  validationError,
  type BacklinkHistoryEntry,
  type BacklinkListResponse,
  type BacklinkSummaryDto,
  type BacklinksInstallResultDto,
  type BacklinksInstallStatusDto,
  type CcAvailableRelease,
  type CcCachedRelease,
  type CcReleaseSyncDto,
  type CcReleaseSyncStatus,
  type RunDto,
} from '@ainyc/canonry-contracts'
import { isValidReleaseId } from '@ainyc/canonry-integration-commoncrawl'
import { resolveProject } from './helpers.js'

export interface BacklinksRoutesOptions {
  /**
   * Synchronous probe of whether `@duckdb/node-api` is installed in the plugin dir.
   * Omit in environments that can't host DuckDB (e.g. the cloud API): mutating
   * routes will then return `MISSING_DEPENDENCY`, while read routes still serve
   * whatever sync history exists in the database.
   */
  getBacklinksStatus?: () => BacklinksInstallStatusDto
  /** Callback that performs the install; must be idempotent. Optional in cloud. */
  onInstallBacklinks?: () => Promise<BacklinksInstallResultDto>
  /** Fired after a `cc_release_syncs` row is created or re-queued. */
  onReleaseSyncRequested?: (syncId: string, release: string) => void
  /** Fired after a `runs` row with `kind='backlink-extract'` is created. */
  onBacklinkExtractRequested?: (runId: string, projectId: string, release?: string) => void
  /** Fired when the user asks to prune a cached release. */
  onBacklinksPruneCache?: (release: string) => void
  /** Reports cached-release metadata from the filesystem. */
  listCachedReleases?: () => CcCachedRelease[]
  /**
   * Probes Common Crawl upstream to discover the latest published release.
   * Implementations should cache the result for a few minutes — this fires on
   * page loads. Returns `null` when no candidate slug responds 200.
   */
  discoverLatestRelease?: () => Promise<CcAvailableRelease | null>
}

const BACKLINKS_UNSUPPORTED_MESSAGE =
  'Backlinks sync and install are only available from a local canonry install. Run `canonry backlinks install` locally to use this feature.'

const NON_TERMINAL_SYNC_STATUSES: ReadonlySet<CcReleaseSyncStatus> = new Set([
  CcReleaseSyncStatuses.queued,
  CcReleaseSyncStatuses.downloading,
  CcReleaseSyncStatuses.querying,
])

function mapSyncRow(row: typeof ccReleaseSyncs.$inferSelect): CcReleaseSyncDto {
  return {
    id: row.id,
    release: row.release,
    status: row.status as CcReleaseSyncStatus,
    phaseDetail: row.phaseDetail ?? null,
    vertexPath: row.vertexPath ?? null,
    edgesPath: row.edgesPath ?? null,
    vertexSha256: row.vertexSha256 ?? null,
    edgesSha256: row.edgesSha256 ?? null,
    vertexBytes: row.vertexBytes ?? null,
    edgesBytes: row.edgesBytes ?? null,
    projectsProcessed: row.projectsProcessed ?? null,
    domainsDiscovered: row.domainsDiscovered ?? null,
    downloadStartedAt: row.downloadStartedAt ?? null,
    downloadFinishedAt: row.downloadFinishedAt ?? null,
    queryStartedAt: row.queryStartedAt ?? null,
    queryFinishedAt: row.queryFinishedAt ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function mapSummaryRow(row: typeof backlinkSummaries.$inferSelect): BacklinkSummaryDto {
  return {
    projectId: row.projectId,
    release: row.release,
    targetDomain: row.targetDomain,
    totalLinkingDomains: row.totalLinkingDomains,
    totalHosts: row.totalHosts,
    top10HostsShare: row.top10HostsShare,
    queriedAt: row.queriedAt,
  }
}

function mapRunRow(row: typeof runs.$inferSelect): RunDto {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as RunDto['kind'],
    status: row.status as RunDto['status'],
    trigger: row.trigger as RunDto['trigger'],
    location: row.location ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    error: parseRunError(row.error),
    createdAt: row.createdAt,
  }
}

function latestSummaryForProject(
  db: DatabaseClient,
  projectId: string,
  release?: string,
): typeof backlinkSummaries.$inferSelect | undefined {
  const condition = release
    ? and(eq(backlinkSummaries.projectId, projectId), eq(backlinkSummaries.release, release))
    : eq(backlinkSummaries.projectId, projectId)

  return db
    .select()
    .from(backlinkSummaries)
    .where(condition)
    .orderBy(desc(backlinkSummaries.queriedAt))
    .limit(1)
    .get()
}

export async function backlinksRoutes(app: FastifyInstance, opts: BacklinksRoutesOptions) {
  app.get('/backlinks/status', async (_request, reply) => {
    if (!opts.getBacklinksStatus) {
      throw missingDependency(BACKLINKS_UNSUPPORTED_MESSAGE)
    }
    return reply.send(opts.getBacklinksStatus())
  })

  app.post('/backlinks/install', async (_request, reply) => {
    if (!opts.onInstallBacklinks) {
      throw missingDependency(BACKLINKS_UNSUPPORTED_MESSAGE)
    }
    const result = await opts.onInstallBacklinks()
    return reply.status(200).send(result)
  })

  app.post<{ Body: { release?: string } }>('/backlinks/syncs', async (request, reply) => {
    let release = request.body?.release
    if (!release) {
      if (!opts.discoverLatestRelease) {
        throw validationError(
          'No `release` provided and auto-discovery is unavailable on this deployment. Pass an explicit release id (e.g., cc-main-2026-jan-feb-mar).',
        )
      }
      const discovered = await opts.discoverLatestRelease()
      if (!discovered) {
        throw validationError(
          'Could not auto-discover the latest Common Crawl release. Pass an explicit `release` body parameter.',
        )
      }
      release = discovered.release
    }
    if (!isValidReleaseId(release)) {
      throw validationError('Invalid release id. Expected form: cc-main-YYYY-{jan-feb-mar,apr-may-jun,jul-aug-sep,oct-nov-dec}')
    }

    if (!opts.getBacklinksStatus || !opts.onReleaseSyncRequested) {
      throw missingDependency(BACKLINKS_UNSUPPORTED_MESSAGE)
    }

    if (!opts.getBacklinksStatus().duckdbInstalled) {
      throw missingDependency(
        '@duckdb/node-api is not installed. Run `canonry backlinks install` to enable the backlinks feature.',
      )
    }

    const existing = app.db
      .select()
      .from(ccReleaseSyncs)
      .where(eq(ccReleaseSyncs.release, release))
      .get()

    const now = new Date().toISOString()

    if (existing) {
      if (NON_TERMINAL_SYNC_STATUSES.has(existing.status as CcReleaseSyncStatus)) {
        return reply.status(200).send(mapSyncRow(existing))
      }
      app.db.update(ccReleaseSyncs).set({
        status: CcReleaseSyncStatuses.queued,
        phaseDetail: null,
        error: null,
        updatedAt: now,
      }).where(eq(ccReleaseSyncs.id, existing.id)).run()
      opts.onReleaseSyncRequested(existing.id, release)
      const refreshed = app.db
        .select()
        .from(ccReleaseSyncs)
        .where(eq(ccReleaseSyncs.id, existing.id))
        .get()
      return reply.status(200).send(mapSyncRow(refreshed!))
    }

    const id = crypto.randomUUID()
    app.db.insert(ccReleaseSyncs).values({
      id,
      release,
      status: CcReleaseSyncStatuses.queued,
      createdAt: now,
      updatedAt: now,
    }).run()
    opts.onReleaseSyncRequested(id, release)
    const inserted = app.db
      .select()
      .from(ccReleaseSyncs)
      .where(eq(ccReleaseSyncs.id, id))
      .get()
    return reply.status(201).send(mapSyncRow(inserted!))
  })

  app.get('/backlinks/syncs/latest', async (_request, reply) => {
    const row = app.db
      .select()
      .from(ccReleaseSyncs)
      .orderBy(desc(ccReleaseSyncs.updatedAt))
      .limit(1)
      .get()
    return reply.send(row ? mapSyncRow(row) : null)
  })

  app.get('/backlinks/syncs', async (_request, reply) => {
    const rows = app.db
      .select()
      .from(ccReleaseSyncs)
      .orderBy(desc(ccReleaseSyncs.updatedAt))
      .all()
    return reply.send(rows.map(mapSyncRow))
  })

  app.get('/backlinks/releases', async (_request, reply) => {
    const releases = opts.listCachedReleases?.() ?? []
    return reply.send(releases)
  })

  app.get('/backlinks/latest-release', async (_request, reply) => {
    if (!opts.discoverLatestRelease) {
      throw missingDependency(BACKLINKS_UNSUPPORTED_MESSAGE)
    }
    const discovered = await opts.discoverLatestRelease()
    return reply.send(discovered)
  })

  app.delete<{ Params: { release: string } }>('/backlinks/cache/:release', async (request, reply) => {
    const release = request.params.release
    if (!isValidReleaseId(release)) {
      throw validationError('Invalid release id')
    }
    if (!opts.onBacklinksPruneCache) {
      throw missingDependency(BACKLINKS_UNSUPPORTED_MESSAGE)
    }
    opts.onBacklinksPruneCache(release)
    return reply.send({ ok: true })
  })

  app.post<{
    Params: { name: string }
    Body: { release?: string }
  }>('/projects/:name/backlinks/extract', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    if (!opts.getBacklinksStatus || !opts.onBacklinkExtractRequested) {
      throw missingDependency(BACKLINKS_UNSUPPORTED_MESSAGE)
    }

    if (!opts.getBacklinksStatus().duckdbInstalled) {
      throw missingDependency(
        '@duckdb/node-api is not installed. Run `canonry backlinks install` to enable the backlinks feature.',
      )
    }

    const release = request.body?.release
    if (release !== undefined && !isValidReleaseId(release)) {
      throw validationError('Invalid release id')
    }

    const now = new Date().toISOString()
    const runId = crypto.randomUUID()
    app.db.insert(runs).values({
      id: runId,
      projectId: project.id,
      kind: RunKinds['backlink-extract'],
      status: RunStatuses.queued,
      trigger: RunTriggers.manual,
      createdAt: now,
    }).run()

    opts.onBacklinkExtractRequested(runId, project.id, release)

    const run = app.db.select().from(runs).where(eq(runs.id, runId)).get()
    return reply.status(201).send(mapRunRow(run!))
  })

  app.get<{ Params: { name: string }; Querystring: { release?: string } }>(
    '/projects/:name/backlinks/summary',
    async (request, reply) => {
      const project = resolveProject(app.db, request.params.name)
      const row = latestSummaryForProject(app.db, project.id, request.query.release)
      return reply.send(row ? mapSummaryRow(row) : null)
    },
  )

  app.get<{
    Params: { name: string }
    Querystring: { limit?: string; offset?: string; release?: string }
  }>('/projects/:name/backlinks/domains', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const summaryRow = latestSummaryForProject(app.db, project.id, request.query.release)
    const targetRelease = request.query.release ?? summaryRow?.release

    if (!targetRelease) {
      const response: BacklinkListResponse = { summary: null, total: 0, rows: [] }
      return reply.send(response)
    }

    const limit = Math.min(Math.max(parseInt(request.query.limit ?? '50', 10) || 50, 1), 500)
    const offset = Math.max(parseInt(request.query.offset ?? '0', 10) || 0, 0)

    const domainCondition = and(
      eq(backlinkDomains.projectId, project.id),
      eq(backlinkDomains.release, targetRelease),
    )

    const totalRow = app.db
      .select({ count: sql<number>`count(*)` })
      .from(backlinkDomains)
      .where(domainCondition)
      .get()

    const rows = app.db
      .select({
        linkingDomain: backlinkDomains.linkingDomain,
        numHosts: backlinkDomains.numHosts,
      })
      .from(backlinkDomains)
      .where(domainCondition)
      .orderBy(desc(backlinkDomains.numHosts))
      .limit(limit)
      .offset(offset)
      .all()

    const response: BacklinkListResponse = {
      summary: summaryRow ? mapSummaryRow(summaryRow) : null,
      total: Number(totalRow?.count ?? 0),
      rows,
    }
    return reply.send(response)
  })

  app.get<{ Params: { name: string } }>(
    '/projects/:name/backlinks/history',
    async (request, reply) => {
      const project = resolveProject(app.db, request.params.name)
      const rows = app.db
        .select()
        .from(backlinkSummaries)
        .where(eq(backlinkSummaries.projectId, project.id))
        .orderBy(asc(backlinkSummaries.queriedAt))
        .all()
      const response: BacklinkHistoryEntry[] = rows.map((r) => ({
        release: r.release,
        totalLinkingDomains: r.totalLinkingDomains,
        totalHosts: r.totalHosts,
        top10HostsShare: r.top10HostsShare,
        queriedAt: r.queriedAt,
      }))
      return reply.send(response)
    },
  )
}
