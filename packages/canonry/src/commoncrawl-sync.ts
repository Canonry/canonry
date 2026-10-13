import crypto from 'node:crypto'
import path from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import {
  backlinkDomains,
  backlinkSummaries,
  ccReleaseSyncs,
  projects,
} from '@ainyc/canonry-db'
import {
  CC_CACHE_DIR,
  ccReleasePaths,
  downloadFile,
  isValidReleaseId,
  loadDuckdb as defaultLoadDuckdb,
  queryBacklinks,
  type BacklinkRow,
} from '@ainyc/canonry-integration-commoncrawl'
import {
  BacklinkSources,
  CcReleaseSyncStatuses,
  computeBacklinkSummaryMetrics,
  describeError,
  OutcomeReasonCodes,
  OutcomeStatuses,
  OutcomeSurfaces,
  OutcomeTriggers,
  type FeatureCompletedProperties,
  type OutcomeTrigger,
} from '@ainyc/canonry-contracts'
import { createLogger } from './logger.js'
import { currentOutcomeOrigin, outcomeFailure, startOutcomeTimer, trackFeatureCompleted } from './outcome-telemetry.js'

const log = createLogger('CommonCrawlSync')

export interface ReleaseSyncDeps {
  downloadFile: typeof downloadFile
  queryBacklinks: typeof queryBacklinks
  loadDuckdb: () => unknown
  now: () => Date
  cacheDir: string
  enqueueAutoExtract?: (info: { projectId: string; release: string }) => void
}

export interface ExecuteReleaseSyncOptions {
  release: string
  /** What asked for the sync, for its outcome event. Defaults to `manual`. */
  trigger?: OutcomeTrigger
  deps?: Partial<ReleaseSyncDeps>
}

const INSERT_CHUNK_SIZE = 10_000

function defaultDeps(): ReleaseSyncDeps {
  return {
    downloadFile,
    queryBacklinks,
    loadDuckdb: defaultLoadDuckdb,
    now: () => new Date(),
    cacheDir: CC_CACHE_DIR,
  }
}

export async function executeReleaseSync(
  db: DatabaseClient,
  syncId: string,
  opts: ExecuteReleaseSyncOptions,
): Promise<void> {
  const deps = { ...defaultDeps(), ...opts.deps }
  const release = opts.release
  const outcome = {
    feature: 'backlinks',
    operation: 'sync',
    ...(opts.trigger && opts.trigger !== OutcomeTriggers.manual
      ? { trigger: opts.trigger, surface: OutcomeSurfaces.system }
      : currentOutcomeOrigin() ?? { trigger: OutcomeTriggers.manual }),
  } as const
  const elapsed = startOutcomeTimer()
  let invalidRelease = false

  try {
    if (!isValidReleaseId(release)) {
      invalidRelease = true
      throw new Error(`Invalid release id: ${release}`)
    }

    const downloadStartedAt = deps.now().toISOString()
    db.update(ccReleaseSyncs).set({
      status: CcReleaseSyncStatuses.downloading,
      downloadStartedAt,
      phaseDetail: 'downloading vertices + edges',
      updatedAt: downloadStartedAt,
      error: null,
    }).where(eq(ccReleaseSyncs.id, syncId)).run()

    const paths = ccReleasePaths(release)
    const releaseCacheDir = path.join(deps.cacheDir, release)
    const vertexPath = path.join(releaseCacheDir, paths.vertexFilename)
    const edgesPath = path.join(releaseCacheDir, paths.edgesFilename)

    const [vertex, edges] = await Promise.all([
      deps.downloadFile({ url: paths.vertexUrl, destPath: vertexPath }),
      deps.downloadFile({ url: paths.edgesUrl, destPath: edgesPath }),
    ])

    const downloadFinishedAt = deps.now().toISOString()
    const queryStartedAt = downloadFinishedAt
    db.update(ccReleaseSyncs).set({
      status: CcReleaseSyncStatuses.querying,
      downloadFinishedAt,
      queryStartedAt,
      phaseDetail: 'querying backlinks',
      vertexPath, edgesPath,
      vertexBytes: vertex.bytes, edgesBytes: edges.bytes,
      vertexSha256: vertex.sha256, edgesSha256: edges.sha256,
      updatedAt: downloadFinishedAt,
    }).where(eq(ccReleaseSyncs.id, syncId)).run()

    const allProjects = db.select().from(projects).all()
    // Deduplicate domains for the DuckDB query so we don't scan for the same
    // target twice, but keep each project around for fan-out on insert.
    const targets = Array.from(new Set(allProjects.map((p) => p.canonicalDomain)))

    let rows: BacklinkRow[] = []
    if (targets.length > 0) {
      const duckdb = deps.loadDuckdb()
      rows = await deps.queryBacklinks({ vertexPath, edgesPath, targets, duckdb })
    }

    // A single canonical domain can be tracked by multiple projects (e.g., a
    // US/EN project and a UK/EN project for the same marketing site). Fan out
    // each backlink row to every project on that domain so none get zero data.
    const projectsByDomain = new Map<string, string[]>()
    for (const p of allProjects) {
      const ids = projectsByDomain.get(p.canonicalDomain) ?? []
      ids.push(p.id)
      projectsByDomain.set(p.canonicalDomain, ids)
    }

    const queriedAt = deps.now().toISOString()

    db.transaction((tx) => {
      tx.delete(backlinkDomains).where(eq(backlinkDomains.releaseSyncId, syncId)).run()
      tx.delete(backlinkSummaries).where(eq(backlinkSummaries.releaseSyncId, syncId)).run()

      // Fan a single backlink row out to one insert per matching project.
      const expanded: Array<{
        id: string
        projectId: string
        releaseSyncId: string
        release: string
        targetDomain: string
        linkingDomain: string
        numHosts: number
        createdAt: string
      }> = []
      for (const r of rows) {
        const projectIds = projectsByDomain.get(r.targetDomain)
        if (!projectIds) continue
        for (const projectId of projectIds) {
          expanded.push({
            id: crypto.randomUUID(),
            projectId,
            releaseSyncId: syncId,
            release,
            targetDomain: r.targetDomain,
            linkingDomain: r.linkingDomain,
            numHosts: r.numHosts,
            createdAt: queriedAt,
          })
        }
      }
      for (let i = 0; i < expanded.length; i += INSERT_CHUNK_SIZE) {
        const chunk = expanded.slice(i, i + INSERT_CHUNK_SIZE)
        if (chunk.length > 0) tx.insert(backlinkDomains).values(chunk).run()
      }

      const rowsByProject = groupByProject(rows, projectsByDomain)
      for (const p of allProjects) {
        const projectRows = rowsByProject.get(p.id) ?? []
        const summary = computeBacklinkSummaryMetrics(projectRows)
        tx.insert(backlinkSummaries).values({
          id: crypto.randomUUID(),
          projectId: p.id,
          releaseSyncId: syncId,
          source: BacklinkSources.commoncrawl,
          release,
          targetDomain: p.canonicalDomain,
          totalLinkingDomains: summary.totalLinkingDomains,
          totalHosts: summary.totalHosts,
          top10HostsShare: summary.top10HostsShare,
          queriedAt,
          createdAt: queriedAt,
        }).onConflictDoUpdate({
          target: [backlinkSummaries.projectId, backlinkSummaries.source, backlinkSummaries.release],
          set: {
            releaseSyncId: syncId,
            targetDomain: p.canonicalDomain,
            totalLinkingDomains: summary.totalLinkingDomains,
            totalHosts: summary.totalHosts,
            top10HostsShare: summary.top10HostsShare,
            queriedAt,
          },
        }).run()
      }
    })

    const finishedAt = deps.now().toISOString()
    db.update(ccReleaseSyncs).set({
      status: CcReleaseSyncStatuses.ready,
      queryFinishedAt: finishedAt,
      phaseDetail: null,
      projectsProcessed: allProjects.length,
      domainsDiscovered: rows.length,
      updatedAt: finishedAt,
      error: null,
    }).where(eq(ccReleaseSyncs.id, syncId)).run()

    log.info('sync.completed', {
      syncId, release,
      projectsProcessed: allProjects.length,
      domainsDiscovered: rows.length,
    })
    trackFeatureCompleted({
      ...outcome,
      status: OutcomeStatuses.succeeded,
      durationBucket: elapsed(),
      counts: { domains: rows.length, links: computeBacklinkSummaryMetrics(rows).totalHosts },
    })

    if (deps.enqueueAutoExtract) {
      const autoExtractProjects = allProjects.filter((p) => p.autoExtractBacklinks)
      for (const p of autoExtractProjects) {
        try {
          deps.enqueueAutoExtract({ projectId: p.id, release })
        } catch (err) {
          log.error('auto-extract.enqueue-failed', {
            syncId, release, projectId: p.id,
            error: describeError(err),
          })
        }
      }
    }
  } catch (err) {
    const errorMsg = describeError(err)
    const finishedAt = deps.now().toISOString()
    db.update(ccReleaseSyncs).set({
      status: CcReleaseSyncStatuses.failed,
      error: errorMsg,
      phaseDetail: null,
      updatedAt: finishedAt,
    }).where(eq(ccReleaseSyncs.id, syncId)).run()
    log.error('sync.failed', { syncId, release, error: errorMsg })
    trackFeatureCompleted({
      ...outcome,
      status: OutcomeStatuses.failed,
      durationBucket: elapsed(),
      ...outcomeFailure(err, invalidRelease ? OutcomeReasonCodes.VALIDATION : undefined),
    })
    throw err
  }
}

export interface ScheduledReleaseSyncDeps {
  db: DatabaseClient
  /** The newest published release, or null when no candidate answers. */
  probe: () => Promise<{ release: string } | null>
  /** POST /backlinks/syncs, which owns insert/dedupe (UNIQUE release + non-terminal check) and the per-project auto-extract fan-out. */
  requestSync: (release: string) => Promise<unknown>
  /** Releases a scheduled request is in flight for, so the release sync it starts reports a scheduled trigger. */
  scheduledReleases: Set<string>
  log: {
    info: (fields: object, message: string) => void
    warn: (fields: object, message: string) => void
    error: (fields: object, message: string) => void
  }
}

/**
 * One backlinks-sync schedule tick. Re-probe Common Crawl for the newest
 * rolling window. The release sync is workspace-GLOBAL, so we gate on
 * freshness: skip when the latest published release is already synced READY
 * (avoids re-downloading a ~4 GB/~13 GB near-identical window every tick). We
 * match on (release, status) directly rather than the most-recently-updated
 * ready row, so re-syncing an older release out of band doesn't make us
 * re-trigger an already-synced latest. Outcomes that never reach the release
 * sync are reported here; a triggered sync reports its own.
 */
export async function syncLatestReleaseOnSchedule(projectName: string, deps: ScheduledReleaseSyncDeps): Promise<void> {
  const elapsed = startOutcomeTimer()
  const report = (outcome: Pick<FeatureCompletedProperties, 'status' | 'reasonCode' | 'errorName'>) => trackFeatureCompleted({
    feature: 'backlinks',
    operation: 'sync',
    trigger: OutcomeTriggers.scheduled,
    surface: OutcomeSurfaces.system,
    durationBucket: elapsed(),
    ...outcome,
  })
  const probed = await deps.probe().catch((err: unknown) => {
    deps.log.warn({ projectName, err }, 'Scheduled backlinks sync: latest-release probe failed')
    report({ status: OutcomeStatuses.failed, ...outcomeFailure(err) })
    return undefined
  })
  if (!probed) {
    // null: the probe ran and no published release answered it.
    if (probed === null) report({ status: OutcomeStatuses.failed, reasonCode: OutcomeReasonCodes.NOT_FOUND })
    return
  }
  const alreadySynced = deps.db
    .select()
    .from(ccReleaseSyncs)
    .where(and(eq(ccReleaseSyncs.release, probed.release), eq(ccReleaseSyncs.status, CcReleaseSyncStatuses.ready)))
    .limit(1)
    .get()
  if (alreadySynced) {
    deps.log.info({ projectName, release: probed.release }, 'Scheduled backlinks sync: already up to date, skipping')
    report({ status: OutcomeStatuses.skipped, reasonCode: OutcomeReasonCodes.NOT_DUE })
    return
  }
  deps.scheduledReleases.add(probed.release)
  try {
    await deps.requestSync(probed.release)
  } catch (err: unknown) {
    deps.log.error({ projectName, release: probed.release, err: describeError(err) }, 'Scheduled backlinks sync failed')
    // MISSING_DEPENDENCY: the backlinks DuckDB plugin is not installed.
    const missingPlugin = typeof err === 'object' && err !== null && 'code' in err && err.code === 'MISSING_DEPENDENCY'
    report({ status: OutcomeStatuses.failed, ...outcomeFailure(err, missingPlugin ? OutcomeReasonCodes.NOT_CONNECTED : undefined) })
  } finally {
    deps.scheduledReleases.delete(probed.release)
  }
}

function groupByProject(
  rows: BacklinkRow[],
  projectsByDomain: Map<string, string[]>,
): Map<string, BacklinkRow[]> {
  const out = new Map<string, BacklinkRow[]>()
  for (const row of rows) {
    const projectIds = projectsByDomain.get(row.targetDomain)
    if (!projectIds) continue
    for (const projectId of projectIds) {
      const bucket = out.get(projectId) ?? []
      bucket.push(row)
      out.set(projectId, bucket)
    }
  }
  return out
}

// Referenced so drizzle's SQL tag is retained when this module is bundled; no-op in prod.
export const _sqlTag = sql
export const _andTag = and
