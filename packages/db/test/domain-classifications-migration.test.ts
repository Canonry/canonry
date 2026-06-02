import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  domainClassifications,
} from '../src/index.js'

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-domclass-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  return { db, dbPath, tmpDir }
}

function cleanup(tmpDir: string) {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function seedProject(db: ReturnType<typeof createTempDb>['db'], id = 'proj_1', name = 'test-project') {
  const now = new Date().toISOString()
  db.insert(projects).values({
    id,
    name,
    displayName: 'Test Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
}

test('v73 creates domain_classifications and a row round-trips with a typed competitorType', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)

  const now = new Date().toISOString()
  db.insert(domainClassifications).values({
    id: 'dc_1',
    projectId: 'proj_1',
    domain: 'booking.com',
    competitorType: 'ota-aggregator',
    hits: 7,
    sessionId: 'sess_1',
    updatedAt: now,
  }).run()

  const [row] = db.select().from(domainClassifications).all()
  expect(row.domain).toBe('booking.com')
  // Stored as bare text (not JSON-quoted) and read back as the typed union.
  expect(row.competitorType).toBe('ota-aggregator')
  expect(row.hits).toBe(7)
  expect(row.sessionId).toBe('sess_1')
})

test('v73 unique index on (project_id, domain) makes re-classification an upsert, not a duplicate', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)

  const t0 = '2026-01-01T00:00:00.000Z'
  const t1 = '2026-02-01T00:00:00.000Z'
  const upsert = (competitorType: string, hits: number, updatedAt: string, sessionId: string) =>
    db.insert(domainClassifications).values({
      id: crypto.randomUUID(),
      projectId: 'proj_1',
      domain: 'expedia.com',
      competitorType,
      hits,
      sessionId,
      updatedAt,
    }).onConflictDoUpdate({
      target: [domainClassifications.projectId, domainClassifications.domain],
      set: { competitorType, hits, sessionId, updatedAt },
    }).run()

  upsert('unknown', 1, t0, 'sess_old')
  upsert('ota-aggregator', 9, t1, 'sess_new') // last write wins

  const rows = db.select().from(domainClassifications).all()
  expect(rows).toHaveLength(1)
  expect(rows[0].competitorType).toBe('ota-aggregator')
  expect(rows[0].hits).toBe(9)
  expect(rows[0].sessionId).toBe('sess_new')
})

test('two projects may carry the same domain with different classifications', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db, 'proj_1', 'p1')
  seedProject(db, 'proj_2', 'p2')

  const now = new Date().toISOString()
  db.insert(domainClassifications).values([
    { id: 'a', projectId: 'proj_1', domain: 'shared.com', competitorType: 'direct-competitor', updatedAt: now },
    { id: 'b', projectId: 'proj_2', domain: 'shared.com', competitorType: 'editorial-media', updatedAt: now },
  ]).run()

  expect(db.select().from(domainClassifications).all()).toHaveLength(2)
})

test('domain_classifications cascades on project delete', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)

  const now = new Date().toISOString()
  db.insert(domainClassifications).values({
    id: 'dc_cascade',
    projectId: 'proj_1',
    domain: 'booking.com',
    competitorType: 'ota-aggregator',
    updatedAt: now,
  }).run()

  db.delete(projects).run()
  expect(db.select().from(domainClassifications).all()).toHaveLength(0)
})

test('migrate() is idempotent for v73 (running twice leaves domain_classifications intact)', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  migrate(db) // second pass must not throw

  const rows = db.all(
    sql.raw(`SELECT COUNT(*) as c FROM pragma_table_info('domain_classifications')`),
  ) as Array<{ c: number }>
  expect((rows[0]?.c ?? 0)).toBeGreaterThan(0)
})
