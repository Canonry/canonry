import crypto from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import {
  backlinkDomains,
  backlinkSummaries,
  ccReleaseSyncs,
  projects,
  runs,
} from '@ainyc/canonry-db'
import {
  queryBacklinks,
  loadDuckdb as defaultLoadDuckdb,
  type BacklinkRow,
} from '@ainyc/canonry-integration-commoncrawl'
import { CcReleaseSyncStatuses, RunStatuses } from '@ainyc/canonry-contracts'
import { createLogger } from './logger.js'

const log = createLogger('BacklinkExtract')

export interface BacklinkExtractDeps {
  queryBacklinks: typeof queryBacklinks
  loadDuckdb: () => unknown
  now: () => Date
}

export interface ExecuteBacklinkExtractOptions {
  release?: string
  deps?: Partial<BacklinkExtractDeps>
}

function defaultDeps(): BacklinkExtractDeps {
  return {
    queryBacklinks,
    loadDuckdb: defaultLoadDuckdb,
    now: () => new Date(),
  }
}

export async function executeBacklinkExtract(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  opts: ExecuteBacklinkExtractOptions = {},
): Promise<void> {
  const deps = { ...defaultDeps(), ...opts.deps }
  const startedAt = deps.now().toISOString()

  db.update(runs).set({ status: RunStatuses.running, startedAt }).where(eq(runs.id, runId)).run()

  try {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const sync = opts.release
      ? db.select().from(ccReleaseSyncs).where(eq(ccReleaseSyncs.release, opts.release)).get()
      : db.select().from(ccReleaseSyncs)
          .where(eq(ccReleaseSyncs.status, CcReleaseSyncStatuses.ready))
          .orderBy(desc(ccReleaseSyncs.createdAt))
          .limit(1)
          .get()

    if (!sync) {
      throw new Error('No ready release sync available — run `canonry backlinks sync` first')
    }
    if (sync.status !== CcReleaseSyncStatuses.ready) {
      throw new Error(`Release ${sync.release} is not ready (status=${sync.status})`)
    }
    if (!sync.vertexPath || !sync.edgesPath) {
      throw new Error(`Release ${sync.release} is missing cached file paths`)
    }

    const duckdb = deps.loadDuckdb()
    const rows = await deps.queryBacklinks({
      vertexPath: sync.vertexPath,
      edgesPath: sync.edgesPath,
      targets: [project.canonicalDomain],
      duckdb,
    })

    const queriedAt = deps.now().toISOString()
    const syncId = sync.id
    const release = sync.release
    const targetDomain = project.canonicalDomain

    db.transaction((tx) => {
      tx.delete(backlinkDomains).where(
        and(eq(backlinkDomains.projectId, projectId), eq(backlinkDomains.release, release)),
      ).run()

      if (rows.length > 0) {
        const values = rows.map((r) => ({
          id: crypto.randomUUID(),
          projectId,
          releaseSyncId: syncId,
          release,
          targetDomain,
          linkingDomain: r.linkingDomain,
          numHosts: r.numHosts,
          createdAt: queriedAt,
        }))
        tx.insert(backlinkDomains).values(values).run()
      }

      const summary = computeSummary(rows)
      tx.insert(backlinkSummaries).values({
        id: crypto.randomUUID(),
        projectId,
        releaseSyncId: syncId,
        release,
        targetDomain,
        totalLinkingDomains: summary.totalLinkingDomains,
        totalHosts: summary.totalHosts,
        top10HostsShare: summary.top10HostsShare,
        queriedAt,
        createdAt: queriedAt,
      }).onConflictDoUpdate({
        target: [backlinkSummaries.projectId, backlinkSummaries.release],
        set: {
          releaseSyncId: syncId,
          targetDomain,
          totalLinkingDomains: summary.totalLinkingDomains,
          totalHosts: summary.totalHosts,
          top10HostsShare: summary.top10HostsShare,
          queriedAt,
        },
      }).run()
    })

    const finishedAt = deps.now().toISOString()
    db.update(runs).set({ status: RunStatuses.completed, finishedAt }).where(eq(runs.id, runId)).run()

    log.info('extract.completed', { runId, projectId, release, rows: rows.length })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    const finishedAt = deps.now().toISOString()
    db.update(runs).set({
      status: RunStatuses.failed, error: errorMsg, finishedAt,
    }).where(eq(runs.id, runId)).run()
    log.error('extract.failed', { runId, projectId, error: errorMsg })
    throw err
  }
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
