import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { operationInProgress, RunKinds, RunStatuses } from '@canonry/canonry-contracts'
import {
  bingCoverageSnapshots, bingCrawlStats, bingKeywordStats, bingPageStats, bingQueryStats,
  bingSiteSnapshots, bingSitemaps, bingTrafficDaily, bingUrlInspections,
  gscCoverageSnapshots, gscDailyTotals, gscDataWatermarks, gscQueryDailyTotals,
  gscSearchData, gscSitemaps, gscUrlInspections, projects, runs, sitemapListSyncs,
} from '@canonry/canonry-db'
import { writeAuditLog } from './helpers.js'

type Database = FastifyInstance['db']
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

const searchSites = {
  google: {
    tables: [gscSearchData, gscDailyTotals, gscQueryDailyTotals, gscDataWatermarks, gscUrlInspections, gscCoverageSnapshots, gscSitemaps],
    runs: [RunKinds['gsc-sync'], RunKinds['inspect-sitemap']],
  },
  bing: {
    // Keyword demand measures a query in a market independently of the site.
    tables: [bingTrafficDaily, bingKeywordStats, bingQueryStats, bingPageStats, bingCrawlStats, bingCoverageSnapshots, bingSiteSnapshots, bingSitemaps, bingUrlInspections],
    runs: [RunKinds['bing-sync'], RunKinds['bing-inspect'], RunKinds['bing-inspect-sitemap']],
  },
} as const

function siteIdentity(site: string | null | undefined): string | null {
  if (!site) return null
  if (/^sc-domain:/i.test(site)) return site.toLowerCase()
  return URL.parse(site)?.href ?? site
}

export function isSameSearchSite(left: string | null | undefined, right: string | null | undefined): boolean {
  return siteIdentity(left) === siteIdentity(right)
}

/** Site-specific evidence has no property ID. Retire it before persisting a different selection. */
export function changeSearchSite<T>(
  db: Database,
  engine: keyof typeof searchSites,
  canonicalDomain: string,
  previousSite: string | null | undefined,
  nextSite: string | null | undefined,
  write: (tx: Transaction) => T,
  actor = 'api',
): T {
  return db.transaction((tx) => {
    if (isSameSearchSite(previousSite, nextSite)) return write(tx)

    const sharing = tx.select({ id: projects.id }).from(projects).where(eq(projects.canonicalDomain, canonicalDomain))
    const active = tx.select({ id: runs.id }).from(runs).where(and(
      inArray(runs.projectId, sharing),
      inArray(runs.kind, searchSites[engine].runs),
      inArray(runs.status, [RunStatuses.running, RunStatuses.queued]),
    )).get()
    if (active) throw operationInProgress('A site sync or inspection is in progress. Retry the connection change when it finishes.', { runId: active.id })

    for (const project of sharing.all()) {
      let removed = tx.delete(sitemapListSyncs).where(and(
        eq(sitemapListSyncs.projectId, project.id), eq(sitemapListSyncs.engine, engine),
      )).run().changes
      for (const table of searchSites[engine].tables) {
        removed += tx.delete(table).where(eq(table.projectId, project.id)).run().changes
      }
      if (removed) writeAuditLog(tx, {
        projectId: project.id,
        actor,
        action: engine === 'google' ? 'gsc.data-cleared' : 'bing.data-cleared',
        entityType: engine === 'google' ? 'google_connection' : 'bing_connection',
        entityId: canonicalDomain,
        diff: { previousSite: previousSite ?? null, nextSite: nextSite ?? null, removed },
      })
    }
    return write(tx)
  })
}
