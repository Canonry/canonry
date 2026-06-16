import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  backlinkDomains,
  backlinkSummaries,
  ccReleaseSyncs,
  createClient,
  migrate,
  projects,
} from '../src/index.js'

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-backlinks-source-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return db
}

function seedProject(db: ReturnType<typeof createClient>) {
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'test-project',
    displayName: 'Test',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  return { projectId, now }
}

function seedCcSync(db: ReturnType<typeof createClient>, now: string) {
  const syncId = crypto.randomUUID()
  db.insert(ccReleaseSyncs).values({
    id: syncId,
    release: 'cc-main-2026-jan-feb-mar',
    status: 'ready',
    createdAt: now,
    updatedAt: now,
  }).run()
  return syncId
}

test('schema: source column present, release_sync_id nullable, unique includes source', () => {
  const db = freshDb()

  const cols = db.all<{ name: string; notnull: number }>(sql`PRAGMA table_info(backlink_domains)`)
  expect(cols.find((c) => c.name === 'source')).toBeDefined()
  const releaseSyncCol = cols.find((c) => c.name === 'release_sync_id')
  expect(releaseSyncCol).toBeDefined()
  expect(releaseSyncCol!.notnull).toBe(0) // nullable

  // The per-window UNIQUE must now key on (project_id, source, release, linking_domain).
  const idxCols = db.all<{ name: string }>(sql`PRAGMA index_info(idx_backlink_domains_unique)`)
  expect(idxCols.map((c) => c.name)).toEqual(['project_id', 'source', 'release', 'linking_domain'])
})

test('round-trip: Common Crawl row defaults source, Bing row stores null release_sync_id', () => {
  const db = freshDb()
  const { projectId, now } = seedProject(db)
  const syncId = seedCcSync(db, now)

  // Common Crawl row — omit `source`, expect the default.
  db.insert(backlinkDomains).values({
    id: crypto.randomUUID(),
    projectId,
    releaseSyncId: syncId,
    release: 'cc-main-2026-jan-feb-mar',
    targetDomain: 'example.com',
    linkingDomain: 'cc-linker.com',
    numHosts: 9,
    createdAt: now,
  }).run()

  // Bing row — explicit source, NO release sync (the whole point of nullable).
  db.insert(backlinkDomains).values({
    id: crypto.randomUUID(),
    projectId,
    releaseSyncId: null,
    source: 'bing-webmaster',
    release: 'bing-2026-06-15',
    targetDomain: 'example.com',
    linkingDomain: 'bing-linker.com',
    numHosts: 4,
    createdAt: now,
  }).run()

  const rows = db.select().from(backlinkDomains).all()
  const cc = rows.find((r) => r.linkingDomain === 'cc-linker.com')!
  const bing = rows.find((r) => r.linkingDomain === 'bing-linker.com')!
  expect(cc.source).toBe('commoncrawl')
  expect(cc.releaseSyncId).toBe(syncId)
  expect(bing.source).toBe('bing-webmaster')
  expect(bing.releaseSyncId).toBeNull()
})

test('unique index is source-aware: same (project, release, linking_domain) coexists across sources', () => {
  const db = freshDb()
  const { projectId, now } = seedProject(db)

  const base = {
    projectId,
    releaseSyncId: null,
    release: 'shared-window',
    targetDomain: 'example.com',
    linkingDomain: 'foo.com',
    numHosts: 1,
    createdAt: now,
  }
  // Two rows identical except for `source` must NOT collide.
  db.insert(backlinkDomains).values({ ...base, id: crypto.randomUUID(), source: 'commoncrawl' }).run()
  expect(() =>
    db.insert(backlinkDomains).values({ ...base, id: crypto.randomUUID(), source: 'bing-webmaster' }).run(),
  ).not.toThrow()

  // But a true duplicate (same source too) still collides.
  expect(() =>
    db.insert(backlinkDomains).values({ ...base, id: crypto.randomUUID(), source: 'commoncrawl' }).run(),
  ).toThrow()

  const rows = db.select().from(backlinkDomains).all()
  expect(rows).toHaveLength(2)
})

test('v78 rebuild backfills source=commoncrawl and preserves pre-v78 Common Crawl data', () => {
  const db = freshDb()
  const { projectId, now } = seedProject(db)
  const syncId = seedCcSync(db, now)

  // Simulate the pre-v78 (old-shape) tables: NOT NULL release_sync_id, no `source`.
  db.run(sql`DROP TABLE backlink_domains`)
  db.run(sql.raw(`CREATE TABLE backlink_domains (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    release_sync_id  TEXT NOT NULL REFERENCES cc_release_syncs(id) ON DELETE CASCADE,
    release          TEXT NOT NULL,
    target_domain    TEXT NOT NULL,
    linking_domain   TEXT NOT NULL,
    num_hosts        INTEGER NOT NULL,
    created_at       TEXT NOT NULL
  )`))
  db.run(sql`INSERT INTO backlink_domains
      (id, project_id, release_sync_id, release, target_domain, linking_domain, num_hosts, created_at)
    VALUES (${'bd-old'}, ${projectId}, ${syncId}, ${'cc-main-2026-jan-feb-mar'}, ${'example.com'}, ${'legacy.com'}, ${7}, ${now})`)

  // Force v78 to re-run over the reconstructed old shape.
  db.run(sql`DELETE FROM _migrations WHERE version >= 78`)
  expect(() => migrate(db)).not.toThrow()

  const rows = db.select().from(backlinkDomains).all()
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).toBe('bd-old')
  expect(rows[0]!.source).toBe('commoncrawl') // backfilled
  expect(rows[0]!.releaseSyncId).toBe(syncId) // preserved
  expect(rows[0]!.linkingDomain).toBe('legacy.com')
  expect(rows[0]!.numHosts).toBe(7)
})

test('v78 rebuild backfills source=commoncrawl and preserves pre-v78 summary data', () => {
  const db = freshDb()
  const { projectId, now } = seedProject(db)
  const syncId = seedCcSync(db, now)

  // Reconstruct the pre-v78 backlink_summaries shape: NOT NULL release_sync_id, no `source`.
  db.run(sql`DROP TABLE backlink_summaries`)
  db.run(sql.raw(`CREATE TABLE backlink_summaries (
    id                     TEXT PRIMARY KEY,
    project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    release_sync_id        TEXT NOT NULL REFERENCES cc_release_syncs(id) ON DELETE CASCADE,
    release                TEXT NOT NULL,
    target_domain          TEXT NOT NULL,
    total_linking_domains  INTEGER NOT NULL,
    total_hosts            INTEGER NOT NULL,
    top_10_hosts_share     TEXT NOT NULL,
    queried_at             TEXT NOT NULL,
    created_at             TEXT NOT NULL
  )`))
  db.run(sql`INSERT INTO backlink_summaries
      (id, project_id, release_sync_id, release, target_domain, total_linking_domains, total_hosts, top_10_hosts_share, queried_at, created_at)
    VALUES (${'bs-old'}, ${projectId}, ${syncId}, ${'cc-main-2026-jan-feb-mar'}, ${'example.com'}, ${12}, ${34}, ${'0.750000'}, ${now}, ${now})`)

  // Force v78 to re-run over the reconstructed old shape (domains already has
  // `source`, so only summaries rebuilds — exercising the summaries INSERT…SELECT).
  db.run(sql`DELETE FROM _migrations WHERE version >= 78`)
  expect(() => migrate(db)).not.toThrow()

  const rows = db.select().from(backlinkSummaries).all()
  expect(rows).toHaveLength(1)
  const r = rows[0]!
  expect(r.id).toBe('bs-old')
  expect(r.source).toBe('commoncrawl') // backfilled
  expect(r.releaseSyncId).toBe(syncId) // preserved
  expect(r.release).toBe('cc-main-2026-jan-feb-mar')
  expect(r.targetDomain).toBe('example.com')
  expect(r.totalLinkingDomains).toBe(12)
  expect(r.totalHosts).toBe(34)
  expect(r.top10HostsShare).toBe('0.750000')
  expect(r.queriedAt).toBe(now)
})

test('v78 is idempotent — a re-run with source present leaves bing rows untouched', () => {
  const db = freshDb()
  const { projectId, now } = seedProject(db)

  db.insert(backlinkDomains).values({
    id: 'bing-row',
    projectId,
    releaseSyncId: null,
    source: 'bing-webmaster',
    release: 'bing-2026-06-15',
    targetDomain: 'example.com',
    linkingDomain: 'bing-linker.com',
    numHosts: 4,
    createdAt: now,
  }).run()

  // Re-running v78 (guarded on the absent `source` column) must be a no-op and
  // must NOT clobber the bing row's source back to commoncrawl.
  db.run(sql`DELETE FROM _migrations WHERE version >= 78`)
  expect(() => migrate(db)).not.toThrow()

  const rows = db.select().from(backlinkSummaries).all()
  expect(rows).toHaveLength(0)
  const dom = db.select().from(backlinkDomains).all()
  expect(dom).toHaveLength(1)
  expect(dom[0]!.source).toBe('bing-webmaster')
})
