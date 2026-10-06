import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createClient, migrate, gscSearchData, gscUrlInspections, gscCoverageSnapshots, projects, runs, siteAuditPages, siteAuditSnapshots, siteCrawlAttempts, siteCrawlPages, siteCrawlSnapshots } from '@ainyc/canonry-db'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
import { writeCoverageSnapshot } from '../src/gsc-coverage-snapshot.js'

/**
 * The bug this exists for: `gsc-sync` and `inspect-sitemap` both write the same
 * `(project, date)` coverage row with a delete-then-insert, and the server
 * chains the second off the first. When they computed coverage independently,
 * the chained run overwrote the derived figures minutes after they were written
 * and reset the provenance columns to their defaults — so whole-property
 * coverage silently degraded to inspection-only coverage on the live path.
 *
 * Each writer was individually correct and individually tested. The defect only
 * appears when they run in sequence, which is exactly how they run.
 */
describe('coverage snapshot has a single writer', () => {
  let tmpDir: string
  let db: ReturnType<typeof createClient>
  const projectId = 'proj-cov'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-cov-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)

    const now = new Date().toISOString()
    db.insert(projects).values({
      id: projectId, name: 'cov', displayName: 'Cov', canonicalDomain: 'example.com',
      country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()

    // The snapshot's syncRunId is a real FK into runs.
    for (const id of ['seed-run', 'run-sync', 'run-sitemap', 'run-1', 'run-2', 'run-3']) {
      db.insert(runs).values({
        id, projectId, kind: 'gsc-sync', status: 'completed',
        trigger: 'manual', startedAt: now, createdAt: now,
      }).run()
    }

    const today = new Date().toISOString().split('T')[0]!
    const seedPage = (page: string, impressions: number) => {
      db.insert(gscSearchData).values({
        id: crypto.randomUUID(), projectId, date: today, query: 'q', page,
        clicks: 0, impressions, position: '5', createdAt: now, syncRunId: 'seed-run',
      }).run()
    }
    // Two pages Google actually served, one that appeared with no impressions.
    seedPage('https://example.com/a', 90)
    seedPage('https://example.com/b', 3)
    seedPage('https://example.com/quiet', 0)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function snapshot() {
    return db.select().from(gscCoverageSnapshots).where(eq(gscCoverageSnapshots.projectId, projectId)).all()
  }

  it('produces the same row whichever run writes it', () => {
    const fromSync = writeCoverageSnapshot(db, projectId, 'run-sync')
    const fromSitemap = writeCoverageSnapshot(db, projectId, 'run-sitemap')

    expect(fromSitemap).toEqual(fromSync)
  })

  it('a chained inspect-sitemap does not erase what gsc-sync derived', () => {
    // The live sequence: sync writes, then the chained sitemap run rewrites.
    writeCoverageSnapshot(db, projectId, 'run-sync')
    writeCoverageSnapshot(db, projectId, 'run-sitemap')

    const rows = snapshot()
    expect(rows).toHaveLength(1)
    const row = rows[0]!

    // Two pages proven indexed by impressions, one unmeasured.
    expect(row.indexed).toBe(2)
    expect(row.unknownPages).toBe(1)
    expect(row.notIndexed).toBe(0)
    // The provenance columns survive the rewrite. Before the single writer,
    // the chained run reset all three to their DEFAULT 0.
    expect(row.derivedFromImpressions).toBe(2)
    expect(row.syncRunId).toBe('run-sitemap')
  })

  it('keeps derived coverage when inspections exist for only some pages', () => {
    const now = new Date().toISOString()
    db.insert(gscUrlInspections).values({
      id: crypto.randomUUID(), projectId, syncRunId: null,
      url: 'https://example.com/quiet', indexingState: 'BLOCKED_BY_ROBOTS_TXT',
      coverageState: 'Blocked by robots.txt', inspectedAt: now, createdAt: now,
    }).run()

    writeCoverageSnapshot(db, projectId, 'run-sync')
    writeCoverageSnapshot(db, projectId, 'run-sitemap')

    const row = snapshot()[0]!
    // The inspected page resolves to not-indexed; the two ranked pages stay
    // indexed from impressions alone. Nothing regressed to unknown.
    expect(row.indexed).toBe(2)
    expect(row.notIndexed).toBe(1)
    expect(row.unknownPages).toBe(0)
    expect(row.verifiedByInspection).toBe(1)
    expect(row.derivedFromImpressions).toBe(2)
  })

  it('replaces only today\'s project row with the latest facts and provenance', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-05-04T10:00:00.000Z'))
    try {
      db.delete(gscSearchData).where(eq(gscSearchData.projectId, projectId)).run()
      db.insert(gscSearchData).values([
        { id: 'writer-page-a', projectId, syncRunId: 'seed-run', date: '2026-05-04', query: 'q', page: 'https://example.com/a', clicks: 0, impressions: 90, position: '5', createdAt: '2026-05-04T10:00:00.000Z' },
        { id: 'writer-page-b', projectId, syncRunId: 'seed-run', date: '2026-05-04', query: 'q', page: 'https://example.com/b', clicks: 0, impressions: 3, position: '5', createdAt: '2026-05-04T10:00:00.000Z' },
        { id: 'writer-page-quiet', projectId, syncRunId: 'seed-run', date: '2026-05-04', query: 'q', page: 'https://example.com/quiet', clicks: 0, impressions: 0, position: '5', createdAt: '2026-05-04T10:00:00.000Z' },
      ]).run()
      db.insert(projects).values({
        id: 'proj-other', name: 'other-coverage', displayName: 'Other coverage', canonicalDomain: 'other.example',
        country: 'US', language: 'en', createdAt: '2026-05-04T09:00:00.000Z', updatedAt: '2026-05-04T09:00:00.000Z',
      }).run()
      db.insert(runs).values({
        id: 'other-run', projectId: 'proj-other', kind: RunKinds['gsc-sync'], status: RunStatuses.completed,
        trigger: RunTriggers.manual, createdAt: '2026-05-04T09:00:00.000Z',
      }).run()
      const preservedRows: (typeof gscCoverageSnapshots.$inferInsert)[] = [
        { id: 'snapshot-foreign', projectId: 'proj-other', syncRunId: 'other-run', date: '2026-05-04', indexed: 9, notIndexed: 3, unknownPages: 4, verifiedByInspection: 6, derivedFromImpressions: 5, reasonBreakdown: { 'Foreign reason': 3 }, createdAt: '2026-05-04T09:00:00.000Z' },
        { id: 'snapshot-prior', projectId, syncRunId: 'seed-run', date: '2026-05-03', indexed: 7, notIndexed: 2, unknownPages: 1, verifiedByInspection: 4, derivedFromImpressions: 3, reasonBreakdown: { 'Prior reason': 2 }, createdAt: '2026-05-03T08:00:00.000Z' },
      ]
      db.insert(gscCoverageSnapshots).values(preservedRows).run()

      const assertStored = (expected: Omit<typeof gscCoverageSnapshots.$inferSelect, 'id'>) => {
        const targetRows = db.select().from(gscCoverageSnapshots)
          .where(and(eq(gscCoverageSnapshots.projectId, projectId), eq(gscCoverageSnapshots.date, '2026-05-04')))
          .all()
        expect(targetRows.map(({ id: _id, ...row }) => row)).toEqual([expected])
        const controls = db.select().from(gscCoverageSnapshots)
          .where(inArray(gscCoverageSnapshots.id, ['snapshot-foreign', 'snapshot-prior']))
          .orderBy(asc(gscCoverageSnapshots.id)).all()
        expect(controls).toEqual(preservedRows)
      }

      expect(writeCoverageSnapshot(db, projectId, 'run-1')).toEqual({
        indexed: 2, notIndexed: 0, unknown: 1, verifiedByInspection: 0, derivedFromImpressions: 2,
      })
      assertStored({
        projectId, syncRunId: 'run-1', date: '2026-05-04', indexed: 2, notIndexed: 0, unknownPages: 1,
        verifiedByInspection: 0, derivedFromImpressions: 2, reasonBreakdown: {}, createdAt: '2026-05-04T10:00:00.000Z',
      })

      vi.setSystemTime(new Date('2026-05-04T10:30:00.000Z'))
      db.insert(gscUrlInspections).values({
        id: 'writer-quiet-inspection', projectId, syncRunId: 'run-2', url: 'https://example.com/quiet',
        indexingState: 'BLOCKED_BY_ROBOTS_TXT', coverageState: 'Blocked by robots.txt',
        inspectedAt: '2026-05-04T10:30:00.000Z', createdAt: '2026-05-04T10:30:00.000Z',
      }).run()
      expect(writeCoverageSnapshot(db, projectId, 'run-2')).toEqual({
        indexed: 2, notIndexed: 1, unknown: 0, verifiedByInspection: 1, derivedFromImpressions: 2,
      })
      assertStored({
        projectId, syncRunId: 'run-2', date: '2026-05-04', indexed: 2, notIndexed: 1, unknownPages: 0,
        verifiedByInspection: 1, derivedFromImpressions: 2, reasonBreakdown: { 'Blocked by robots.txt': 1 }, createdAt: '2026-05-04T10:30:00.000Z',
      })

      vi.setSystemTime(new Date('2026-05-04T11:00:00.000Z'))
      db.update(gscSearchData).set({ impressions: 0 }).where(eq(gscSearchData.id, 'writer-page-a')).run()
      db.insert(gscUrlInspections).values({
        id: 'writer-a-inspection', projectId, syncRunId: 'run-3', url: 'https://example.com/a',
        indexingState: 'INDEXING_ALLOWED', coverageState: 'Submitted and indexed',
        inspectedAt: '2026-05-04T11:00:00.000Z', createdAt: '2026-05-04T11:00:00.000Z',
      }).run()
      expect(writeCoverageSnapshot(db, projectId, 'run-3')).toEqual({
        indexed: 2, notIndexed: 1, unknown: 0, verifiedByInspection: 2, derivedFromImpressions: 1,
      })
      assertStored({
        projectId, syncRunId: 'run-3', date: '2026-05-04', indexed: 2, notIndexed: 1, unknownPages: 0,
        verifiedByInspection: 2, derivedFromImpressions: 1, reasonBreakdown: { 'Blocked by robots.txt': 1 }, createdAt: '2026-05-04T11:00:00.000Z',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * The three sources spell the same page differently. Real values observed in
   * production:
   *
   *     sitemap    https://canonry.ai/privacy   no trailing slash
   *     GSC page   https://canonry.ai/          trailing slash
   *     inspection http://ainyc.ai/             pre-migration scheme AND host
   *
   * Matching them raw counts one page two or three times and reports crawled
   * pages as unmeasured purely because GSC spelled them differently.
   */
  it('matches the same page across differing scheme, host and trailing slash', () => {
    const now = new Date().toISOString()
    db.insert(gscUrlInspections).values({
      id: crypto.randomUUID(), projectId, syncRunId: null,
      // Same page as the seeded https://example.com/a, under a legacy host.
      url: 'http://legacy.example.com/a', indexingState: 'INDEXING_ALLOWED',
      coverageState: null, inspectedAt: now, createdAt: now,
    }).run()

    const c = writeCoverageSnapshot(db, projectId, 'run-sync')

    // 3 seeded pages, not 4 — the legacy-host inspection is the same page.
    expect(c.indexed + c.notIndexed + c.unknown).toBe(3)
    expect(c.verifiedByInspection).toBe(1)
  })

  it('seeds crawled pages so an uninspected one is unknown, not invisible', () => {
    const now = new Date().toISOString()
    db.insert(runs).values({
      id: 'audit-run', projectId, kind: 'site-audit', status: 'completed',
      trigger: 'manual', startedAt: now, createdAt: now,
    }).run()
    db.insert(siteAuditSnapshots).values({
      id: crypto.randomUUID(), projectId, runId: 'audit-run',
      sitemapUrl: 'https://example.com/sitemap.xml', auditedAt: now, createdAt: now,
    }).run()
    for (const url of ['https://example.com/a', 'https://example.com/brand-new']) {
      db.insert(siteAuditPages).values({
        id: crypto.randomUUID(), projectId, runId: 'audit-run', url, status: 'success', createdAt: now,
      }).run()
    }

    const c = writeCoverageSnapshot(db, projectId, 'run-sync')

    // /brand-new is crawled but has no impressions and no inspection. Without
    // seeding the sitemap it would not be counted at all; the denominator would
    // quietly exclude the one page we actually know nothing about.
    expect(c.unknown).toBe(2) // /brand-new and the seeded /quiet
    expect(c.indexed + c.notIndexed + c.unknown).toBe(4)
  })

  it('uses only inventory-eligible pages from the latest complete graph once a graph exists', () => {
    const now = new Date().toISOString()
    db.insert(runs).values({
      id: 'legacy-audit', projectId, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt: now,
    }).run()
    db.insert(siteAuditSnapshots).values({
      id: crypto.randomUUID(), projectId, runId: 'legacy-audit', sitemapUrl: 'https://example.com/sitemap.xml', auditedAt: now, createdAt: now,
    }).run()
    db.insert(siteAuditPages).values({
      id: crypto.randomUUID(), projectId, runId: 'legacy-audit', url: 'https://example.com/legacy-only', status: 'success', createdAt: now,
    }).run()

    db.insert(runs).values({
      id: 'graph-audit', projectId, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt: now,
    }).run()
    db.insert(siteCrawlAttempts).values({
      id: 'graph-attempt', projectId, runId: 'graph-audit', attemptNumber: 1, state: 'completed', createdAt: now, updatedAt: now,
    }).run()
    db.insert(siteCrawlSnapshots).values({
      id: crypto.randomUUID(), projectId, runId: 'graph-audit', attemptId: 'graph-attempt', rootUrl: 'https://example.com/', complete: true, detailsAvailable: true, createdAt: now, updatedAt: now,
    }).run()
    for (const [url, eligible] of [['https://example.com/live-new', true], ['https://example.com/redirect', false]] as const) {
      db.insert(siteCrawlPages).values({
        id: crypto.randomUUID(), projectId, runId: 'graph-audit', attemptId: 'graph-attempt', nodeKey: `node:${url}`, url,
        path: new URL(url).pathname, parentPath: '/', fetchState: eligible ? 'html' : 'redirect',
        indexabilityState: eligible ? 'indexable' : 'unknown', inventoryEligible: eligible, createdAt: now, updatedAt: now,
      }).run()
    }

    const c = writeCoverageSnapshot(db, projectId, 'run-sync')

    // GSC supplies /a, /b and /quiet; the graph supplies /live-new. Neither
    // the old scorecard page nor a redirect/error node may inflate inventory.
    expect(c.indexed + c.notIndexed + c.unknown).toBe(4)
    expect(c.unknown).toBe(2) // /quiet and /live-new
  })

  it('does not fall back to a partial v126 crawl legacy scorecard', () => {
    const now = new Date().toISOString()
    db.insert(runs).values({
      id: 'partial-audit', projectId, kind: 'site-audit', status: 'partial', trigger: 'manual', createdAt: now,
    }).run()
    db.insert(siteCrawlAttempts).values({
      id: 'partial-attempt', projectId, runId: 'partial-audit', attemptNumber: 1, state: 'partial', createdAt: now, updatedAt: now,
    }).run()
    db.insert(siteCrawlSnapshots).values({
      id: crypto.randomUUID(), projectId, runId: 'partial-audit', attemptId: 'partial-attempt',
      rootUrl: 'https://example.com/', complete: false, termination: 'max-pages', detailsAvailable: true, createdAt: now, updatedAt: now,
    }).run()
    // The compatibility scorecard exists for this partial run, but its pages
    // are not a published inventory and must not affect GSC coverage.
    db.insert(siteAuditSnapshots).values({
      id: crypto.randomUUID(), projectId, runId: 'partial-audit', sitemapUrl: 'https://example.com/sitemap.xml', auditedAt: now, createdAt: now,
    }).run()
    db.insert(siteAuditPages).values({
      id: crypto.randomUUID(), projectId, runId: 'partial-audit', url: 'https://example.com/partial-only', status: 'success', createdAt: now,
    }).run()

    const c = writeCoverageSnapshot(db, projectId, 'run-sync')

    // Only the three GSC-observed paths remain. /partial-only cannot seed
    // unknown coverage until a complete graph has published it.
    expect(c.indexed + c.notIndexed + c.unknown).toBe(3)
  })
})
