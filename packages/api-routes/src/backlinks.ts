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
  BacklinkSources,
  CcReleaseSyncStatuses,
  RunKinds,
  RunStatuses,
  RunTriggers,
  backlinkSourceSchema,
  missingDependency,
  parseRunError,
  validationError,
  type BacklinkHistoryEntry,
  type BacklinkListResponse,
  type BacklinkSource,
  type BacklinkSourceAvailabilityDto,
  type BacklinkSourcesResponseDto,
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
import { backlinkCrawlerExclusionClause } from './backlinks-filter.js'
import type { BingConnectionStore } from './bing.js'

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
  /**
   * Resolves the Bing Webmaster connection for a project's canonical domain.
   * Used to report Bing availability and to gate the per-project Bing inbound-
   * links sync. Omit in deployments that don't host Bing connections (Bing then
   * reports as not connected and the surface degrades gracefully).
   */
  bingConnectionStore?: BingConnectionStore
  /**
   * Fired after a `runs` row is created for a per-project Bing inbound-links
   * sync. The handler pulls inbound links live from the connected Bing account
   * and writes `source='bing-webmaster'` backlink rows.
   */
  onBingBacklinkSyncRequested?: (runId: string, projectId: string) => void
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
    source: row.source,
  }
}

// Default to Common Crawl when the caller omits `?source` so every existing
// backlinks contract (which predates the discriminator) keeps its behavior.
function parseSourceParam(value: string | undefined): BacklinkSource {
  if (value === undefined || value === '') return BacklinkSources.commoncrawl
  const parsed = backlinkSourceSchema.safeParse(value)
  if (!parsed.success) {
    throw validationError(`Invalid source "${value}". Expected one of: ${Object.values(BacklinkSources).join(', ')}.`)
  }
  return parsed.data
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
  source: BacklinkSource,
  release?: string,
): typeof backlinkSummaries.$inferSelect | undefined {
  const conditions = [
    eq(backlinkSummaries.projectId, projectId),
    eq(backlinkSummaries.source, source),
  ]
  if (release) conditions.push(eq(backlinkSummaries.release, release))

  return db
    .select()
    .from(backlinkSummaries)
    .where(and(...conditions))
    .orderBy(desc(backlinkSummaries.queriedAt))
    .limit(1)
    .get()
}

function parseExcludeCrawlers(value: string | undefined): boolean {
  if (!value) return false
  const lower = value.toLowerCase()
  return lower === '1' || lower === 'true' || lower === 'yes'
}

// Recomputes a project+release summary over the rows that survive the crawler
// filter. Queries the domains table directly (rather than subtracting from the
// stored summary) so excluded counts stay consistent if the stored summary
// drifts from the underlying rows.
function computeFilteredSummary(
  db: DatabaseClient,
  base: typeof backlinkSummaries.$inferSelect,
): BacklinkSummaryDto {
  const baseDomainCondition = and(
    eq(backlinkDomains.projectId, base.projectId),
    eq(backlinkDomains.source, base.source),
    eq(backlinkDomains.release, base.release),
  )
  const filteredCondition = and(baseDomainCondition, backlinkCrawlerExclusionClause())

  const unfilteredAgg = db
    .select({
      count: sql<number>`count(*)`,
      total: sql<number>`coalesce(sum(${backlinkDomains.numHosts}), 0)`,
    })
    .from(backlinkDomains)
    .where(baseDomainCondition)
    .get()

  const filteredAgg = db
    .select({
      count: sql<number>`count(*)`,
      total: sql<number>`coalesce(sum(${backlinkDomains.numHosts}), 0)`,
    })
    .from(backlinkDomains)
    .where(filteredCondition)
    .get()

  const top10Rows = db
    .select({ numHosts: backlinkDomains.numHosts })
    .from(backlinkDomains)
    .where(filteredCondition)
    .orderBy(desc(backlinkDomains.numHosts))
    .limit(10)
    .all()

  const totalLinkingDomains = Number(filteredAgg?.count ?? 0)
  const totalHosts = Number(filteredAgg?.total ?? 0)
  const unfilteredLinkingDomains = Number(unfilteredAgg?.count ?? 0)
  const unfilteredHosts = Number(unfilteredAgg?.total ?? 0)
  const top10Sum = top10Rows.reduce((sum, r) => sum + r.numHosts, 0)
  const top10Share = totalHosts > 0 ? top10Sum / totalHosts : 0

  return {
    projectId: base.projectId,
    release: base.release,
    targetDomain: base.targetDomain,
    totalLinkingDomains,
    totalHosts,
    top10HostsShare: top10Share.toFixed(6),
    queriedAt: base.queriedAt,
    source: base.source,
    excludedLinkingDomains: Math.max(0, unfilteredLinkingDomains - totalLinkingDomains),
    excludedHosts: Math.max(0, unfilteredHosts - totalHosts),
  }
}

// Per-source availability for a project's backlinks surface — drives the
// onboarding/empty state and the source switcher. Connectivity rules differ:
// Common Crawl is "available" when auto-extract is on AND a release sync has
// reached `ready`; Bing is "available" when a Bing Webmaster connection exists
// for the project's canonical domain.
function buildSourceAvailability(
  db: DatabaseClient,
  projectId: string,
  source: BacklinkSource,
  connected: boolean,
  excludeCrawlers: boolean,
): BacklinkSourceAvailabilityDto {
  const summary = db
    .select()
    .from(backlinkSummaries)
    .where(and(eq(backlinkSummaries.projectId, projectId), eq(backlinkSummaries.source, source)))
    .orderBy(desc(backlinkSummaries.queriedAt))
    .limit(1)
    .get()
  // Default to the stored (unfiltered) summary total so this matches what the
  // summary/domains endpoints return by default. When `excludeCrawlers` is set
  // (the dashboard always does), recount the latest window without crawler/proxy
  // hosts so the switcher pill matches the summary metric card.
  let totalLinkingDomains = summary?.totalLinkingDomains ?? 0
  if (summary && excludeCrawlers) {
    const filtered = db
      .select({ count: sql<number>`count(*)` })
      .from(backlinkDomains)
      .where(and(
        eq(backlinkDomains.projectId, projectId),
        eq(backlinkDomains.source, source),
        eq(backlinkDomains.release, summary.release),
        backlinkCrawlerExclusionClause(),
      ))
      .get()
    totalLinkingDomains = Number(filtered?.count ?? 0)
  }
  return {
    source,
    connected,
    hasData: !!summary,
    latestRelease: summary?.release ?? null,
    totalLinkingDomains,
    lastSyncedAt: summary?.queriedAt ?? null,
  }
}

function computeSourceAvailability(
  db: DatabaseClient,
  project: { id: string; canonicalDomain: string; autoExtractBacklinks: boolean },
  bingStore: BingConnectionStore | undefined,
  excludeCrawlers: boolean,
): BacklinkSourcesResponseDto {
  const ccReadySync = db
    .select({ id: ccReleaseSyncs.id })
    .from(ccReleaseSyncs)
    .where(eq(ccReleaseSyncs.status, CcReleaseSyncStatuses.ready))
    .limit(1)
    .get()
  const ccConnected = project.autoExtractBacklinks === true && !!ccReadySync
  const bingConnected = !!bingStore?.getConnection(project.canonicalDomain)

  const sources = [
    buildSourceAvailability(db, project.id, BacklinkSources.commoncrawl, ccConnected, excludeCrawlers),
    buildSourceAvailability(db, project.id, BacklinkSources['bing-webmaster'], bingConnected, excludeCrawlers),
  ]
  return {
    projectId: project.id,
    targetDomain: project.canonicalDomain,
    sources,
    anyConnected: sources.some((s) => s.connected),
    anyData: sources.some((s) => s.hasData),
  }
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
          'No `release` provided and auto-discovery is unavailable on this deployment. Pass an explicit release id (e.g., cc-main-2026-mar-apr-may).',
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
      throw validationError('Invalid release id. Expected form: cc-main-YYYY-<mon>-<mon>-<mon> (a rolling 3-month window, e.g. cc-main-2026-mar-apr-may).')
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

  app.get<{
    Params: { name: string }
    Querystring: { release?: string; excludeCrawlers?: string; source?: string }
  }>(
    '/projects/:name/backlinks/summary',
    async (request, reply) => {
      const project = resolveProject(app.db, request.params.name)
      const source = parseSourceParam(request.query.source)
      const row = latestSummaryForProject(app.db, project.id, source, request.query.release)
      if (!row) return reply.send(null)
      const excludeCrawlers = parseExcludeCrawlers(request.query.excludeCrawlers)
      return reply.send(excludeCrawlers ? computeFilteredSummary(app.db, row) : mapSummaryRow(row))
    },
  )

  app.get<{
    Params: { name: string }
    Querystring: { limit?: string; offset?: string; release?: string; excludeCrawlers?: string; source?: string }
  }>('/projects/:name/backlinks/domains', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const source = parseSourceParam(request.query.source)

    const summaryRow = latestSummaryForProject(app.db, project.id, source, request.query.release)
    const targetRelease = request.query.release ?? summaryRow?.release

    if (!targetRelease) {
      const response: BacklinkListResponse = { source, summary: null, total: 0, rows: [] }
      return reply.send(response)
    }

    const limit = Math.min(Math.max(parseInt(request.query.limit ?? '50', 10) || 50, 1), 500)
    const offset = Math.max(parseInt(request.query.offset ?? '0', 10) || 0, 0)
    const excludeCrawlers = parseExcludeCrawlers(request.query.excludeCrawlers)

    const baseDomainCondition = and(
      eq(backlinkDomains.projectId, project.id),
      eq(backlinkDomains.source, source),
      eq(backlinkDomains.release, targetRelease),
    )
    const domainCondition = excludeCrawlers
      ? and(baseDomainCondition, backlinkCrawlerExclusionClause())
      : baseDomainCondition

    const totalRow = app.db
      .select({ count: sql<number>`count(*)` })
      .from(backlinkDomains)
      .where(domainCondition)
      .get()

    const rows = app.db
      .select({
        linkingDomain: backlinkDomains.linkingDomain,
        numHosts: backlinkDomains.numHosts,
        source: backlinkDomains.source,
      })
      .from(backlinkDomains)
      .where(domainCondition)
      .orderBy(desc(backlinkDomains.numHosts))
      .limit(limit)
      .offset(offset)
      .all()

    let summary: BacklinkSummaryDto | null = null
    if (summaryRow) {
      summary = excludeCrawlers ? computeFilteredSummary(app.db, summaryRow) : mapSummaryRow(summaryRow)
    }

    const response: BacklinkListResponse = {
      source,
      summary,
      total: Number(totalRow?.count ?? 0),
      rows,
    }
    return reply.send(response)
  })

  app.get<{
    Params: { name: string }
    Querystring: { source?: string }
  }>(
    '/projects/:name/backlinks/history',
    async (request, reply) => {
      const project = resolveProject(app.db, request.params.name)
      const source = parseSourceParam(request.query.source)
      const rows = app.db
        .select()
        .from(backlinkSummaries)
        .where(and(eq(backlinkSummaries.projectId, project.id), eq(backlinkSummaries.source, source)))
        .orderBy(asc(backlinkSummaries.queriedAt))
        .all()
      const response: BacklinkHistoryEntry[] = rows.map((r) => ({
        release: r.release,
        totalLinkingDomains: r.totalLinkingDomains,
        totalHosts: r.totalHosts,
        top10HostsShare: r.top10HostsShare,
        queriedAt: r.queriedAt,
        source: r.source,
      }))
      return reply.send(response)
    },
  )

  // Per-source availability — lets the UI/CLI/agent see which backlink sources
  // are set up (CC-only / Bing-only / both / neither) and degrade gracefully.
  app.get<{
    Params: { name: string }
    Querystring: { excludeCrawlers?: string }
  }>(
    '/projects/:name/backlinks/sources',
    async (request, reply) => {
      const project = resolveProject(app.db, request.params.name)
      const excludeCrawlers = parseExcludeCrawlers(request.query.excludeCrawlers)
      const response = computeSourceAvailability(app.db, project, opts.bingConnectionStore, excludeCrawlers)
      return reply.send(response)
    },
  )

  // Manual per-project Bing inbound-links sync. Creates a tracking run (reusing
  // the `backlink-extract` kind — the work is "extract this project's backlinks"
  // and `source` on the rows is the source of truth) and fires the executor.
  app.post<{ Params: { name: string } }>(
    '/projects/:name/backlinks/bing-sync',
    async (request, reply) => {
      const project = resolveProject(app.db, request.params.name)
      if (!opts.onBingBacklinkSyncRequested) {
        throw missingDependency(
          'Bing backlinks sync is only available from a local canonry install with Bing Webmaster connected.',
        )
      }
      const conn = opts.bingConnectionStore?.getConnection(project.canonicalDomain)
      if (!conn) {
        throw validationError(
          `No Bing Webmaster connection for "${project.name}". Run \`canonry bing connect ${project.name} --api-key <key>\` first.`,
        )
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

      opts.onBingBacklinkSyncRequested(runId, project.id)

      const run = app.db.select().from(runs).where(eq(runs.id, runId)).get()
      return reply.status(201).send(mapRunRow(run!))
    },
  )
}
