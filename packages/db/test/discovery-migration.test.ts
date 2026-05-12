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
    competitorMap: '{}',
    createdAt: now,
  }).run()

  const rows = db.select().from(discoverySessions).all()
  expect(rows).toHaveLength(1)
  expect(rows[0].status).toBe('queued')
  expect(rows[0].icpDescription).toBe('Boutique destination hotel in Williamsburg')
  expect(rows[0].dedupThreshold).toBe(0.85)
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
    competitorMap: '{}',
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

test('discovery_sessions cascades on project delete', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(discoverySessions).values({
    id: 'sess_cascade',
    projectId: 'proj_1',
    status: 'completed',
    competitorMap: '{}',
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
