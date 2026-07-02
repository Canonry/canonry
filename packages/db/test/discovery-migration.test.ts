import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  queries,
  competitors,
  discoverySessions,
  discoveryProbes,
} from '../src/index.js'

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-discovery-test-'))
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

function columnExists(db: ReturnType<typeof createTempDb>['db'], table: string, column: string): boolean {
  const rows = db.all(
    sql.raw(`SELECT COUNT(*) as c FROM pragma_table_info('${table}') WHERE name = '${column}'`),
  ) as Array<{ c: number }>
  return (rows[0]?.c ?? 0) > 0
}

test('v55 adds projects.icp_description column', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  expect(columnExists(db, 'projects', 'icp_description')).toBe(true)
})

test('v55 adds queries.provenance column', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  expect(columnExists(db, 'queries', 'provenance')).toBe(true)
})

test('v55 adds competitors.provenance column', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  expect(columnExists(db, 'competitors', 'provenance')).toBe(true)
})

test('v55 creates discovery_sessions table', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(discoverySessions).values({
    id: 'sess_1',
    projectId: 'proj_1',
    status: 'queued',
    icpDescription: 'Boutique destination hotel in Williamsburg',
    seedProvider: 'gemini',
    dedupThreshold: 0.85,
    competitorMap: '[]',
    createdAt: now,
  }).run()

  const rows = db.select().from(discoverySessions).all()
  expect(rows).toHaveLength(1)
  expect(rows[0].status).toBe('queued')
  expect(rows[0].icpDescription).toBe('Boutique destination hotel in Williamsburg')
  expect(rows[0].dedupThreshold).toBe(0.85)
})

test('v56 adds discovery_sessions.run_id column for run ↔ session linking', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  expect(columnExists(db, 'discovery_sessions', 'run_id')).toBe(true)

  seedProject(db)
  const now = new Date().toISOString()
  db.insert(discoverySessions).values({
    id: 'sess_link',
    projectId: 'proj_1',
    runId: 'run_xyz',
    competitorMap: '[]',
    createdAt: now,
  }).run()

  const [row] = db.select().from(discoverySessions).all()
  expect(row.runId).toBe('run_xyz')
})

test('v55 creates discovery_probes table without (session_id, query) UNIQUE so v2 multi-provider can amplify', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(discoverySessions).values({
    id: 'sess_1',
    projectId: 'proj_1',
    status: 'completed',
    competitorMap: '[]',
    createdAt: now,
  }).run()

  // Two probes for the same query in the same session must be allowed (different providers in v2).
  db.insert(discoveryProbes).values({
    id: 'probe_1',
    sessionId: 'sess_1',
    projectId: 'proj_1',
    query: 'best boutique hotel williamsburg',
    citationState: 'cited',
    citedDomains: '["gjelinahotel.com","theyellowsign.com"]',
    bucket: 'cited',
    createdAt: now,
  }).run()
  db.insert(discoveryProbes).values({
    id: 'probe_2',
    sessionId: 'sess_1',
    projectId: 'proj_1',
    query: 'best boutique hotel williamsburg',
    citationState: 'not-cited',
    citedDomains: '[]',
    bucket: 'aspirational',
    createdAt: now,
  }).run()

  expect(db.select().from(discoveryProbes).all()).toHaveLength(2)
})

test('v79 adds discovery_probes.answer_mentioned column', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  expect(columnExists(db, 'discovery_probes', 'answer_mentioned')).toBe(true)
})

test('discovery_probes.answer_mentioned round-trips the tri-state (true / false / null)', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)

  const now = new Date().toISOString()
  db.insert(discoverySessions).values({
    id: 'sess_m', projectId: 'proj_1', status: 'completed', competitorMap: '[]', createdAt: now,
  }).run()
  // mentioned, not-mentioned, and unknown (the legacy/never-computed shape).
  db.insert(discoveryProbes).values({
    id: 'p_true', sessionId: 'sess_m', projectId: 'proj_1', query: 'mentioned q',
    citationState: 'not-cited', answerMentioned: true, createdAt: now,
  }).run()
  db.insert(discoveryProbes).values({
    id: 'p_false', sessionId: 'sess_m', projectId: 'proj_1', query: 'cited not mentioned q',
    citationState: 'cited', answerMentioned: false, createdAt: now,
  }).run()
  db.insert(discoveryProbes).values({
    id: 'p_null', sessionId: 'sess_m', projectId: 'proj_1', query: 'unknown q',
    citationState: 'not-cited', createdAt: now,
  }).run()

  const byId = Object.fromEntries(db.select().from(discoveryProbes).all().map((r) => [r.id, r]))
  expect(byId.p_true.answerMentioned).toBe(true)
  expect(byId.p_false.answerMentioned).toBe(false)
  // omitted => null (unknown), never coerced to false
  expect(byId.p_null.answerMentioned).toBeNull()
})

test('discovery_sessions cascades on project delete', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(discoverySessions).values({
    id: 'sess_cascade',
    projectId: 'proj_1',
    status: 'completed',
    competitorMap: '[]',
    createdAt: now,
  }).run()
  db.insert(discoveryProbes).values({
    id: 'probe_cascade',
    sessionId: 'sess_cascade',
    projectId: 'proj_1',
    query: 'q',
    citationState: 'cited',
    createdAt: now,
  }).run()

  db.delete(projects).run()

  expect(db.select().from(discoverySessions).all()).toHaveLength(0)
  expect(db.select().from(discoveryProbes).all()).toHaveLength(0)
})

test('migrate() is idempotent — running twice leaves schema intact', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  migrate(db) // second pass must not throw

  expect(columnExists(db, 'projects', 'icp_description')).toBe(true)
  expect(columnExists(db, 'queries', 'provenance')).toBe(true)
  expect(columnExists(db, 'competitors', 'provenance')).toBe(true)
})

test('queries.provenance round-trips', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)

  const now = new Date().toISOString()
  db.insert(queries).values({
    id: 'q_1',
    projectId: 'proj_1',
    query: 'best boutique hotel williamsburg',
    provenance: 'discovery:sess_1',
    createdAt: now,
  }).run()
  const [row] = db.select().from(queries).all()
  expect(row.provenance).toBe('discovery:sess_1')
})

test('competitors.provenance round-trips', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)

  const now = new Date().toISOString()
  db.insert(competitors).values({
    id: 'c_1',
    projectId: 'proj_1',
    domain: 'theyellowsign.com',
    provenance: 'discovery:sess_1',
    createdAt: now,
  }).run()
  const [row] = db.select().from(competitors).all()
  expect(row.provenance).toBe('discovery:sess_1')
})

test('v55 backfills queries/competitors provenance="cli" when re-applied to a DB with NULL rows', () => {
  // The backfill targets rows that existed when v55 ran. To test it, we
  // simulate a "pre-v55" state: insert a row, NULL its provenance, delete the
  // v55 record from _migrations, then call migrate() again. The runner re-runs
  // v55 (idempotent ALTER COLUMN swallows duplicate-column errors); the UPDATE
  // backfill fires and sets provenance='cli'.
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)

  const now = new Date().toISOString()
  db.insert(queries).values({ id: 'q_legacy', projectId: 'proj_1', query: 'legacy q', createdAt: now }).run()
  db.insert(competitors).values({ id: 'c_legacy', projectId: 'proj_1', domain: 'legacy.com', createdAt: now }).run()

  // Wipe provenance + remove every record at or after v55 so migrate() reruns
  // v55. Anything later than v55 has to be removed too, otherwise the runner
  // computes `MAX(version) >= 55` and skips v55 on the rerun.
  db.run(sql.raw(`UPDATE queries SET provenance = NULL`))
  db.run(sql.raw(`UPDATE competitors SET provenance = NULL`))
  db.run(sql.raw(`DELETE FROM _migrations WHERE version >= 55`))

  migrate(db)

  const [q] = db.select().from(queries).all()
  const [c] = db.select().from(competitors).all()
  expect(q.provenance).toBe('cli')
  expect(c.provenance).toBe('cli')
})

test('discovery_sessions.competitor_map default is an array, not an object (regression: must match DTO shape)', () => {
  // The DTO in `packages/contracts/src/discovery.ts` models competitorMap as
  // `Array<{domain, hits}>`. A DB default of '{}' would parse to an object
  // and Zod would reject it on the first read. Pin the default to '[]'.
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)

  const now = new Date().toISOString()
  db.insert(discoverySessions).values({
    id: 'sess_default',
    projectId: 'proj_1',
    createdAt: now,
  }).run()

  const [row] = db.select().from(discoverySessions).all()
  expect(row.status).toBe('queued')
  // Drizzle JSON-mode deserializes the stored '[]' default into a JS array.
  expect(row.competitorMap).toEqual([])
})

test('v88 adds discovery_sessions seed-source diagnostic columns', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  expect(columnExists(db, 'discovery_sessions', 'seed_from_answer_count')).toBe(true)
  expect(columnExists(db, 'discovery_sessions', 'seed_from_grounding_count')).toBe(true)
})

test('discovery_sessions seed-source counts round-trip, and legacy rows stay null', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)

  const now = new Date().toISOString()
  db.insert(discoverySessions).values({
    id: 'sess_split',
    projectId: 'proj_1',
    seedFromAnswerCount: 28,
    seedFromGroundingCount: 9,
    competitorMap: '[]',
    createdAt: now,
  }).run()
  // A writer that predates the columns simply omits them — null, never 0.
  db.insert(discoverySessions).values({
    id: 'sess_legacy',
    projectId: 'proj_1',
    competitorMap: '[]',
    createdAt: now,
  }).run()

  const rows = db.select().from(discoverySessions).all()
  const split = rows.find(r => r.id === 'sess_split')!
  const legacy = rows.find(r => r.id === 'sess_legacy')!
  expect(split.seedFromAnswerCount).toBe(28)
  expect(split.seedFromGroundingCount).toBe(9)
  expect(legacy.seedFromAnswerCount).toBeNull()
  expect(legacy.seedFromGroundingCount).toBeNull()
})

test('v88 is idempotent: re-running migrate() over an up-to-date database is a no-op', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  // createTempDb already ran migrate(); a second run must not throw on the
  // ALTER TABLE ADD COLUMN statements (versions are recorded and skipped).
  expect(() => migrate(db)).not.toThrow()
  expect(columnExists(db, 'discovery_sessions', 'seed_from_answer_count')).toBe(true)
  expect(columnExists(db, 'discovery_sessions', 'seed_from_grounding_count')).toBe(true)
})

test('v89 adds discovery_sessions.seed_brand_filtered_count column', () => {
  const { db, tmpDir } = createTempDb()
  try {
    const cols = db.$client.prepare(`PRAGMA table_info(discovery_sessions)`).all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'seed_brand_filtered_count')).toBe(true)
  } finally {
    cleanup(tmpDir)
  }
})
