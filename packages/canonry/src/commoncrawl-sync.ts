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
import { CcReleaseSyncStatuses } from '@ainyc/canonry-contracts'
import { createLogger } from './logger.js'

const log = createLogger('CommonCrawlSync')

export interface ReleaseSyncDeps {
  downloadFile: typeof downloadFile
  queryBacklinks: typeof queryBacklinks
  loadDuckdb: () => unknown
  now: () => Date
  cacheDir: string
}

export interface ExecuteReleaseSyncOptions {
  release: string
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

  try {
    if (!isValidReleaseId(release)) {
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
    const targets = allProjects.map((p) => p.canonicalDomain)

    let rows: BacklinkRow[] = []
    if (targets.length > 0) {
      const duckdb = deps.loadDuckdb()
      rows = await deps.queryBacklinks({ vertexPath, edgesPath, targets, duckdb })
    }

    const projectByDomain = new Map<string, string>()
    for (const p of allProjects) projectByDomain.set(p.canonicalDomain, p.id)

    const queriedAt = deps.now().toISOString()

    db.transaction((tx) => {
      tx.delete(backlinkDomains).where(eq(backlinkDomains.releaseSyncId, syncId)).run()
      tx.delete(backlinkSummaries).where(eq(backlinkSummaries.releaseSyncId, syncId)).run()

      for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE)
        const values = chunk
          .map((r) => {
            const projectId = projectByDomain.get(r.targetDomain)
            if (!projectId) return null
            return {
              id: crypto.randomUUID(),
              projectId,
              releaseSyncId: syncId,
              release,
              targetDomain: r.targetDomain,
              linkingDomain: r.linkingDomain,
              numHosts: r.numHosts,
              createdAt: queriedAt,
            }
          })
          .filter((v): v is NonNullable<typeof v> => v !== null)
        if (values.length > 0) tx.insert(backlinkDomains).values(values).run()
      }

      const rowsByProject = groupByProject(rows, projectByDomain)
      for (const p of allProjects) {
        const projectRows = rowsByProject.get(p.id) ?? []
        const summary = computeSummary(projectRows)
        tx.insert(backlinkSummaries).values({
          id: crypto.randomUUID(),
          projectId: p.id,
          releaseSyncId: syncId,
          release,
          targetDomain: p.canonicalDomain,
          totalLinkingDomains: summary.totalLinkingDomains,
          totalHosts: summary.totalHosts,
          top10HostsShare: summary.top10HostsShare,
          queriedAt,
          createdAt: queriedAt,
        }).onConflictDoUpdate({
          target: [backlinkSummaries.projectId, backlinkSummaries.release],
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
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    const finishedAt = deps.now().toISOString()
    db.update(ccReleaseSyncs).set({
      status: CcReleaseSyncStatuses.failed,
      error: errorMsg,
      phaseDetail: null,
      updatedAt: finishedAt,
    }).where(eq(ccReleaseSyncs.id, syncId)).run()
    log.error('sync.failed', { syncId, release, error: errorMsg })
    throw err
  }
}

function groupByProject(rows: BacklinkRow[], projectByDomain: Map<string, string>): Map<string, BacklinkRow[]> {
  const out = new Map<string, BacklinkRow[]>()
  for (const row of rows) {
    const projectId = projectByDomain.get(row.targetDomain)
    if (!projectId) continue
    const bucket = out.get(projectId) ?? []
    bucket.push(row)
    out.set(projectId, bucket)
  }
  return out
}

interface SummaryMetrics {
  totalLinkingDomains: number
  totalHosts: number
  top10HostsShare: string
}

function computeSummary(rows: BacklinkRow[]): SummaryMetrics {
  if (rows.length === 0) {
    return { totalLinkingDomains: 0, totalHosts: 0, top10HostsShare: '0' }
  }
  const sorted = [...rows].sort((a, b) => b.numHosts - a.numHosts)
  const totalHosts = sorted.reduce((acc, r) => acc + r.numHosts, 0)
  const top10Hosts = sorted.slice(0, 10).reduce((acc, r) => acc + r.numHosts, 0)
  const share = totalHosts > 0 ? top10Hosts / totalHosts : 0
  return {
    totalLinkingDomains: rows.length,
    totalHosts,
    top10HostsShare: share.toFixed(6),
  }
}

// Referenced so drizzle's SQL tag is retained when this module is bundled; no-op in prod.
export const _sqlTag = sql
export const _andTag = and
