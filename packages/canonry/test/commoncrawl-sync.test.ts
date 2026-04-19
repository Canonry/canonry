import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  backlinkDomains,
  backlinkSummaries,
  ccReleaseSyncs,
  createClient,
  migrate,
  projects,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { executeReleaseSync, type ReleaseSyncDeps } from '../src/commoncrawl-sync.js'

let tmpDir: string
let db: DatabaseClient

function iso(n: number): string {
  return new Date(n).toISOString()
}

function makeDeps(overrides: Partial<ReleaseSyncDeps> = {}): ReleaseSyncDeps {
  let t = 1_700_000_000_000
  const now = overrides.now ?? (() => new Date(t++ * 1))
  return {
    downloadFile: overrides.downloadFile ?? (async ({ destPath }) => {
      await fs.mkdir(path.dirname(destPath), { recursive: true })
      await fs.writeFile(destPath, 'fake')
      return { bytes: 4, sha256: 'fake-sha', cached: false, elapsedMs: 0 }
    }),
    queryBacklinks: overrides.queryBacklinks ?? (async () => []),
    loadDuckdb: overrides.loadDuckdb ?? (() => ({ DuckDBInstance: {} })),
    now,
    cacheDir: overrides.cacheDir ?? path.join(tmpDir, 'cache'),
  }
}

function insertProject(id: string, name: string, domain: string): void {
  const now = new Date().toISOString()
  db.insert(projects).values({
    id, name, displayName: name, canonicalDomain: domain,
    country: 'US', language: 'en', providers: '[]',
    createdAt: now, updatedAt: now,
  }).run()
}

function insertSyncRow(id: string, release: string): void {
  const now = new Date().toISOString()
  db.insert(ccReleaseSyncs).values({
    id, release, status: 'queued', createdAt: now, updatedAt: now,
  }).run()
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-sync-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('executeReleaseSync', () => {
  it('fails the sync row when the release id is invalid — no download attempted', async () => {
    const syncId = crypto.randomUUID()
    insertSyncRow(syncId, 'not-a-release')
    await expect(
      executeReleaseSync(db, syncId, { release: 'not-a-release', deps: makeDeps() }),
    ).rejects.toThrow(/Invalid release id/)
    const row = db.select().from(ccReleaseSyncs).where(eq(ccReleaseSyncs.id, syncId)).get()
    expect(row?.status).toBe('failed')
    expect(row?.error).toMatch(/Invalid release id/)
  })

  it('drives status downloading → querying → ready and populates rows per project', async () => {
    insertProject('p1', 'roots', 'roots.io')
    insertProject('p2', 'laravel', 'laravel.com')

    const syncId = crypto.randomUUID()
    const release = 'cc-main-2026-jan-feb-mar'
    insertSyncRow(syncId, release)

    const statusesSeen: string[] = []
    const deps = makeDeps({
      downloadFile: async ({ destPath }) => {
        const row = db.select().from(ccReleaseSyncs).where(eq(ccReleaseSyncs.id, syncId)).get()
        if (row) statusesSeen.push(row.status)
        await fs.mkdir(path.dirname(destPath), { recursive: true })
        await fs.writeFile(destPath, 'fake')
        return { bytes: destPath.includes('vertices') ? 111 : 222, sha256: destPath.includes('vertices') ? 'vsha' : 'esha', cached: false, elapsedMs: 10 }
      },
      queryBacklinks: async ({ targets }) => {
        const row = db.select().from(ccReleaseSyncs).where(eq(ccReleaseSyncs.id, syncId)).get()
        if (row) statusesSeen.push(row.status)
        expect(new Set(targets)).toEqual(new Set(['roots.io', 'laravel.com']))
        return [
          { targetDomain: 'roots.io', linkingDomain: 'github.com', numHosts: 20000 },
          { targetDomain: 'roots.io', linkingDomain: 'reddit.com', numHosts: 8000 },
          { targetDomain: 'laravel.com', linkingDomain: 'stackoverflow.com', numHosts: 15000 },
        ]
      },
    })

    await executeReleaseSync(db, syncId, { release, deps })

    expect(statusesSeen).toContain('downloading')
    expect(statusesSeen).toContain('querying')

    const row = db.select().from(ccReleaseSyncs).where(eq(ccReleaseSyncs.id, syncId)).get()
    expect(row?.status).toBe('ready')
    expect(row?.vertexBytes).toBe(111)
    expect(row?.edgesBytes).toBe(222)
    expect(row?.vertexSha256).toBe('vsha')
    expect(row?.edgesSha256).toBe('esha')
    expect(row?.projectsProcessed).toBe(2)
    expect(row?.domainsDiscovered).toBe(3)
    expect(row?.downloadStartedAt).toBeTruthy()
    expect(row?.downloadFinishedAt).toBeTruthy()
    expect(row?.queryStartedAt).toBeTruthy()
    expect(row?.queryFinishedAt).toBeTruthy()

    const rootsDomains = db.select().from(backlinkDomains)
      .where(eq(backlinkDomains.projectId, 'p1')).all()
    expect(rootsDomains).toHaveLength(2)
    expect(rootsDomains.map((r) => r.linkingDomain).sort()).toEqual(['github.com', 'reddit.com'])
    expect(rootsDomains.every((r) => r.release === release)).toBe(true)
    expect(rootsDomains.every((r) => r.releaseSyncId === syncId)).toBe(true)
    expect(rootsDomains.every((r) => r.targetDomain === 'roots.io')).toBe(true)

    const laravelDomains = db.select().from(backlinkDomains)
      .where(eq(backlinkDomains.projectId, 'p2')).all()
    expect(laravelDomains).toHaveLength(1)

    const rootsSummary = db.select().from(backlinkSummaries)
      .where(eq(backlinkSummaries.projectId, 'p1')).get()
    expect(rootsSummary?.totalLinkingDomains).toBe(2)
    expect(rootsSummary?.totalHosts).toBe(28000)
    expect(rootsSummary?.targetDomain).toBe('roots.io')
    expect(rootsSummary?.release).toBe(release)

    const laravelSummary = db.select().from(backlinkSummaries)
      .where(eq(backlinkSummaries.projectId, 'p2')).get()
    expect(laravelSummary?.totalLinkingDomains).toBe(1)
    expect(laravelSummary?.totalHosts).toBe(15000)
  })

  it('computes top10HostsShare as the share of hosts from the 10 largest linking domains', async () => {
    insertProject('p1', 'big', 'big.example')
    const syncId = crypto.randomUUID()
    const release = 'cc-main-2026-jan-feb-mar'
    insertSyncRow(syncId, release)

    const rows = Array.from({ length: 12 }, (_, i) => ({
      targetDomain: 'big.example',
      linkingDomain: `linker${i}.test`,
      numHosts: 12 - i, // 12, 11, ..., 1
    }))
    await executeReleaseSync(db, syncId, {
      release,
      deps: makeDeps({ queryBacklinks: async () => rows }),
    })
    const summary = db.select().from(backlinkSummaries)
      .where(eq(backlinkSummaries.projectId, 'p1')).get()
    const top10Hosts = 12 + 11 + 10 + 9 + 8 + 7 + 6 + 5 + 4 + 3
    const totalHosts = top10Hosts + 2 + 1
    const expectedShare = top10Hosts / totalHosts
    expect(Number(summary!.top10HostsShare)).toBeCloseTo(expectedShare, 4)
  })

  it('marks the sync failed and rethrows when a download fails', async () => {
    insertProject('p1', 'roots', 'roots.io')
    const syncId = crypto.randomUUID()
    const release = 'cc-main-2026-jan-feb-mar'
    insertSyncRow(syncId, release)

    await expect(
      executeReleaseSync(db, syncId, {
        release,
        deps: makeDeps({
          downloadFile: async () => { throw new Error('boom') },
        }),
      }),
    ).rejects.toThrow(/boom/)

    const row = db.select().from(ccReleaseSyncs).where(eq(ccReleaseSyncs.id, syncId)).get()
    expect(row?.status).toBe('failed')
    expect(row?.error).toMatch(/boom/)
  })

  it('is idempotent under re-run: wipes prior rows and re-inserts under the same sync id', async () => {
    insertProject('p1', 'roots', 'roots.io')
    const syncId = crypto.randomUUID()
    const release = 'cc-main-2026-jan-feb-mar'
    insertSyncRow(syncId, release)

    const firstRows = [{ targetDomain: 'roots.io', linkingDomain: 'a.com', numHosts: 5 }]
    await executeReleaseSync(db, syncId, {
      release,
      deps: makeDeps({ queryBacklinks: async () => firstRows }),
    })
    expect(db.select().from(backlinkDomains).all()).toHaveLength(1)

    const secondRows = [
      { targetDomain: 'roots.io', linkingDomain: 'b.com', numHosts: 7 },
      { targetDomain: 'roots.io', linkingDomain: 'c.com', numHosts: 3 },
    ]
    await executeReleaseSync(db, syncId, {
      release,
      deps: makeDeps({ queryBacklinks: async () => secondRows }),
    })
    const all = db.select().from(backlinkDomains).all()
    expect(all).toHaveLength(2)
    expect(all.map((r) => r.linkingDomain).sort()).toEqual(['b.com', 'c.com'])

    const summary = db.select().from(backlinkSummaries).all()
    expect(summary).toHaveLength(1)
    expect(summary[0]!.totalLinkingDomains).toBe(2)
  })

  it('fans a single domain row out to every project that tracks the same canonical domain', async () => {
    insertProject('p-us', 'site-us', 'example.com')
    insertProject('p-uk', 'site-uk', 'example.com')

    const syncId = crypto.randomUUID()
    const release = 'cc-main-2026-jan-feb-mar'
    insertSyncRow(syncId, release)

    let duckdbTargets: string[] = []
    await executeReleaseSync(db, syncId, {
      release,
      deps: makeDeps({
        queryBacklinks: async ({ targets }) => {
          duckdbTargets = targets
          return [
            { targetDomain: 'example.com', linkingDomain: 'github.com', numHosts: 100 },
            { targetDomain: 'example.com', linkingDomain: 'reddit.com', numHosts: 50 },
          ]
        },
      }),
    })

    // DuckDB should only see the domain once (dedup for cheaper scans).
    expect(duckdbTargets).toEqual(['example.com'])

    const usRows = db.select().from(backlinkDomains)
      .where(eq(backlinkDomains.projectId, 'p-us')).all()
    const ukRows = db.select().from(backlinkDomains)
      .where(eq(backlinkDomains.projectId, 'p-uk')).all()
    expect(usRows).toHaveLength(2)
    expect(ukRows).toHaveLength(2)
    expect(usRows.map((r) => r.linkingDomain).sort()).toEqual(['github.com', 'reddit.com'])
    expect(ukRows.map((r) => r.linkingDomain).sort()).toEqual(['github.com', 'reddit.com'])

    const usSummary = db.select().from(backlinkSummaries)
      .where(eq(backlinkSummaries.projectId, 'p-us')).get()
    const ukSummary = db.select().from(backlinkSummaries)
      .where(eq(backlinkSummaries.projectId, 'p-uk')).get()
    expect(usSummary?.totalLinkingDomains).toBe(2)
    expect(usSummary?.totalHosts).toBe(150)
    expect(ukSummary?.totalLinkingDomains).toBe(2)
    expect(ukSummary?.totalHosts).toBe(150)

    const syncRow = db.select().from(ccReleaseSyncs).where(eq(ccReleaseSyncs.id, syncId)).get()
    expect(syncRow?.projectsProcessed).toBe(2)
    // domainsDiscovered counts pre-fan-out rows, not the expanded inserts.
    expect(syncRow?.domainsDiscovered).toBe(2)
  })

  it('succeeds with zero projects — marks ready with projectsProcessed=0 and no query invocation', async () => {
    const syncId = crypto.randomUUID()
    const release = 'cc-main-2026-jan-feb-mar'
    insertSyncRow(syncId, release)

    let queryCalls = 0
    await executeReleaseSync(db, syncId, {
      release,
      deps: makeDeps({
        queryBacklinks: async () => { queryCalls++; return [] },
      }),
    })
    expect(queryCalls).toBe(0)
    const row = db.select().from(ccReleaseSyncs).where(eq(ccReleaseSyncs.id, syncId)).get()
    expect(row?.status).toBe('ready')
    expect(row?.projectsProcessed).toBe(0)
    expect(row?.domainsDiscovered).toBe(0)
    expect(iso(0)).toMatch(/^1970/)
  })
})
