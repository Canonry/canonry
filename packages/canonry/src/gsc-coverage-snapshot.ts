import crypto from 'node:crypto'
import { and, desc, eq, gte } from 'drizzle-orm'
import type { DatabaseClient } from '@canonry/canonry-db'
import {
  gscCoverageSnapshots,
  gscSearchData,
  gscUrlInspections,
  siteAuditPages,
  siteAuditSnapshots,
  siteCrawlPages,
  siteCrawlSnapshots,
  runs,
} from '@canonry/canonry-db'
import { deriveIndexCoverage, normalizeUrlPath } from '@canonry/canonry-contracts'

/**
 * The ONE place a GSC index-coverage snapshot is written.
 *
 * Two runs produce coverage — `gsc-sync` and `inspect-sitemap` — and the server
 * chains the second off the first, both writing the same `(project, date)` row
 * with a delete-then-insert. When they computed it independently they drifted:
 * `gsc-sync` derived coverage across the whole property while `inspect-sitemap`
 * counted inspections alone, so the chained run silently overwrote the derived
 * figures minutes after they were written and reset the provenance columns to
 * their defaults. Same row, two meanings, last writer wins.
 *
 * Routing both through here removes the class of bug rather than the instance.
 * Callers supply only the run id; every input is read from the database, so
 * neither caller can pass a different view of the same facts.
 */

/** How far back to look for impressions when deciding a page is indexed. */
export const COVERAGE_IMPRESSION_WINDOW_DAYS = 30

export interface CoverageSnapshotResult {
  indexed: number
  notIndexed: number
  unknown: number
  verifiedByInspection: number
  derivedFromImpressions: number
}

/**
 * Reduce a URL from any of the three sources to a comparable key.
 *
 * The sources do not agree on spelling, and matching them raw invents facts:
 *
 *     sitemap    https://canonry.ai/privacy      no trailing slash
 *     GSC page   https://canonry.ai/             trailing slash
 *     inspection http://ainyc.ai/                pre-migration scheme AND host
 *
 * A raw union counts the same page two or three times and reports sitemap
 * pages as unmeasured purely because GSC spelled them differently. Keying on
 * the normalized PATH collapses scheme, host, and trailing-slash differences —
 * which is what we want here, because a project is one site and the legacy host
 * is the same pages under an old name.
 *
 * The trade: a project genuinely serving different content on two hosts would
 * have those paths merged. `canonicalDomain` is per project, so that is out of
 * scope today; revisit if multi-host projects arrive.
 */
function pageKey(raw: string): string | null {
  if (!raw) return null
  try {
    return normalizeUrlPath(new URL(raw).pathname)
  } catch {
    // Already a path, or unparseable — normalize what we were given.
    return normalizeUrlPath(raw)
  }
}

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().split('T')[0]!
}

/**
 * Recompute and persist today's coverage snapshot for a project.
 *
 * Impressions come from the stored search-analytics rows rather than from the
 * caller: `inspect-sitemap` never fetches analytics, and reading both signals
 * from the same place is what keeps the two writers in agreement.
 */
export function writeCoverageSnapshot(
  db: DatabaseClient,
  projectId: string,
  runId: string,
  opts: { windowDays?: number; now?: Date } = {},
): CoverageSnapshotResult {
  const windowDays = opts.windowDays ?? COVERAGE_IMPRESSION_WINDOW_DAYS
  const since = isoDaysAgo(windowDays)

  const pageRows = db
    .select({ page: gscSearchData.page, impressions: gscSearchData.impressions })
    .from(gscSearchData)
    .where(and(eq(gscSearchData.projectId, projectId), gte(gscSearchData.date, since)))
    .all()

  const allInspections = db
    .select()
    .from(gscUrlInspections)
    .where(eq(gscUrlInspections.projectId, projectId))
    .all()

  // Pages we know exist because we crawled them. Without this the `unknown`
  // state is unreachable: GSC only returns rows for pages that HAD an
  // impression, so every page in the other two sources already resolves. A
  // sitemap page that never ranked and was never inspected is precisely the
  // page nobody has measured, and it is invisible unless we seed it here.
  // The complete graph is the authoritative current inventory. A partial,
  // cancelled, or failed crawl never publishes a graph snapshot and therefore
  // cannot replace the last good page universe. Until the first complete graph
  // exists, retain the legacy scorecard fallback for backward compatibility.
  const latestCrawl = db
    .select({ runId: siteCrawlSnapshots.runId, attemptId: siteCrawlSnapshots.attemptId })
    .from(siteCrawlSnapshots)
    .innerJoin(runs, eq(siteCrawlSnapshots.runId, runs.id))
    .where(and(
      eq(siteCrawlSnapshots.projectId, projectId),
      eq(siteCrawlSnapshots.complete, true),
      eq(runs.status, 'completed'),
    ))
    .orderBy(desc(siteCrawlSnapshots.createdAt))
    .limit(1)
    .get()

  // Legacy audit pages predate the crawl graph. Once any v126 traversal has
  // been recorded, a partial snapshot must not fall through to its legacy
  // scorecard rows and silently become the GSC inventory.
  const hasCrawlHistory = Boolean(db
    .select({ id: siteCrawlSnapshots.id })
    .from(siteCrawlSnapshots)
    .where(eq(siteCrawlSnapshots.projectId, projectId))
    .limit(1)
    .get())

  // Latest audit only — an older run lists pages that may since have gone.
  const latestAudit = db
    .select({ runId: siteAuditSnapshots.runId })
    .from(siteAuditSnapshots)
    .where(eq(siteAuditSnapshots.projectId, projectId))
    .orderBy(desc(siteAuditSnapshots.createdAt))
    .limit(1)
    .get()

  const sitemapUrls = latestCrawl?.attemptId
    ? db.select({ url: siteCrawlPages.url })
      .from(siteCrawlPages)
      .where(and(
        eq(siteCrawlPages.projectId, projectId),
        eq(siteCrawlPages.runId, latestCrawl.runId),
        eq(siteCrawlPages.attemptId, latestCrawl.attemptId),
        eq(siteCrawlPages.inventoryEligible, true),
      ))
      .all()
    : !hasCrawlHistory && latestAudit
      ? db.select({ url: siteAuditPages.url }).from(siteAuditPages).where(eq(siteAuditPages.runId, latestAudit.runId)).all()
      : []

  // Impressions per page key, so differently-spelled rows for one page add up.
  const impressionsByKey = new Map<string, number>()
  for (const row of pageRows) {
    const key = pageKey(row.page)
    if (key) impressionsByKey.set(key, (impressionsByKey.get(key) ?? 0) + row.impressions)
  }
  // A crawled page contributes itself at zero impressions unless GSC saw it.
  for (const row of sitemapUrls) {
    const key = pageKey(row.url)
    if (key && !impressionsByKey.has(key)) impressionsByKey.set(key, 0)
  }

  // Latest verdict per page key — the table keeps history, and the same page
  // may have been inspected under the pre-migration host.
  const latestByKey = new Map<string, typeof allInspections[number]>()
  for (const row of allInspections) {
    const key = pageKey(row.url)
    if (!key) continue
    const existing = latestByKey.get(key)
    if (!existing || row.inspectedAt > existing.inspectedAt) latestByKey.set(key, row)
  }

  const coverage = deriveIndexCoverage({
    pages: [...impressionsByKey].map(([page, impressions]) => ({ page, impressions })),
    inspections: [...latestByKey].map(([key, r]) => ({
      url: key,
      indexingState: r.indexingState,
      coverageState: r.coverageState,
    })),
  })

  const now = opts.now ?? new Date()
  const snapshotDate = now.toISOString().split('T')[0]!

  db.delete(gscCoverageSnapshots)
    .where(and(eq(gscCoverageSnapshots.projectId, projectId), eq(gscCoverageSnapshots.date, snapshotDate)))
    .run()

  db.insert(gscCoverageSnapshots).values({
    id: crypto.randomUUID(),
    projectId,
    syncRunId: runId,
    date: snapshotDate,
    indexed: coverage.indexed,
    notIndexed: coverage.notIndexed,
    unknownPages: coverage.unknown,
    verifiedByInspection: coverage.verifiedByInspection,
    derivedFromImpressions: coverage.derivedFromImpressions,
    reasonBreakdown: coverage.reasonBreakdown,
    createdAt: now.toISOString(),
  }).run()

  return {
    indexed: coverage.indexed,
    notIndexed: coverage.notIndexed,
    unknown: coverage.unknown,
    verifiedByInspection: coverage.verifiedByInspection,
    derivedFromImpressions: coverage.derivedFromImpressions,
  }
}
