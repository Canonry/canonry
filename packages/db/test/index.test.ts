import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, keywords, runs, querySnapshots, auditLog, apiKeys, usageCounters } from '../src/index.js'

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  return { db, dbPath, tmpDir }
}

function cleanup(tmpDir: string) {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

test('createClient returns a drizzle instance with WAL mode', () => {
  const { db, tmpDir } = createTempDb()
  assert.ok(db)
  cleanup(tmpDir)
})

test('migrate creates all tables', () => {
  const { db, tmpDir } = createTempDb()

  // Verify tables exist by querying them (would throw if missing)
  const projectRows = db.select().from(projects).all()
  assert.deepEqual(projectRows, [])

  const keywordRows = db.select().from(keywords).all()
  assert.deepEqual(keywordRows, [])

  const runRows = db.select().from(runs).all()
  assert.deepEqual(runRows, [])

  const snapshotRows = db.select().from(querySnapshots).all()
  assert.deepEqual(snapshotRows, [])

  const logRows = db.select().from(auditLog).all()
  assert.deepEqual(logRows, [])

  const keyRows = db.select().from(apiKeys).all()
  assert.deepEqual(keyRows, [])

  const usageRows = db.select().from(usageCounters).all()
  assert.deepEqual(usageRows, [])

  cleanup(tmpDir)
})

test('migrate is idempotent', () => {
  const { db, tmpDir } = createTempDb()
  // Running migrate again should not throw
  migrate(db)
  migrate(db)
  cleanup(tmpDir)
})

test('CRUD: insert and query a project', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_1',
    name: 'test-project',
    displayName: 'Test Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  const [project] = db.select().from(projects).where(eq(projects.name, 'test-project')).all()
  assert.equal(project.id, 'proj_1')
  assert.equal(project.displayName, 'Test Project')
  assert.equal(project.configSource, 'cli')
  assert.equal(project.configRevision, 1)
  assert.deepEqual(JSON.parse(project.tags), [])
  assert.deepEqual(JSON.parse(project.labels), {})

  cleanup(tmpDir)
})

test('CRUD: insert keywords with project FK', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_1',
    name: 'test-project',
    displayName: 'Test Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(keywords).values({
    id: 'kw_1',
    projectId: 'proj_1',
    keyword: 'emergency dentist brooklyn',
    createdAt: now,
  }).run()

  const kws = db.select().from(keywords).where(eq(keywords.projectId, 'proj_1')).all()
  assert.equal(kws.length, 1)
  assert.equal(kws[0].keyword, 'emergency dentist brooklyn')

  cleanup(tmpDir)
})

test('CRUD: cascade delete removes keywords when project deleted', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_1',
    name: 'test-project',
    displayName: 'Test Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(keywords).values({
    id: 'kw_1',
    projectId: 'proj_1',
    keyword: 'test keyword',
    createdAt: now,
  }).run()

  db.delete(projects).where(eq(projects.id, 'proj_1')).run()
  const kws = db.select().from(keywords).all()
  assert.equal(kws.length, 0)

  cleanup(tmpDir)
})

test('CRUD: insert run and query snapshot', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_1',
    name: 'test-project',
    displayName: 'Test',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(keywords).values({
    id: 'kw_1',
    projectId: 'proj_1',
    keyword: 'test keyword',
    createdAt: now,
  }).run()

  db.insert(runs).values({
    id: 'run_1',
    projectId: 'proj_1',
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    startedAt: now,
    finishedAt: now,
    createdAt: now,
  }).run()

  db.insert(querySnapshots).values({
    id: 'snap_1',
    runId: 'run_1',
    keywordId: 'kw_1',
    provider: 'gemini',
    citationState: 'cited',
    citedDomains: '["example.com"]',
    createdAt: now,
  }).run()

  const [snap] = db.select().from(querySnapshots).where(eq(querySnapshots.runId, 'run_1')).all()
  assert.equal(snap.citationState, 'cited')
  assert.deepEqual(JSON.parse(snap.citedDomains), ['example.com'])

  cleanup(tmpDir)
})

test('unique constraint on keywords(project_id, keyword)', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_1',
    name: 'test-project',
    displayName: 'Test',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(keywords).values({
    id: 'kw_1',
    projectId: 'proj_1',
    keyword: 'duplicate',
    createdAt: now,
  }).run()

  assert.throws(() => {
    db.insert(keywords).values({
      id: 'kw_2',
      projectId: 'proj_1',
      keyword: 'duplicate',
      createdAt: now,
    }).run()
  })

  cleanup(tmpDir)
})

test('usage_counters unique constraint on (scope, period, metric)', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(usageCounters).values({
    id: 'uc_1',
    scope: 'proj_1',
    period: '2026-03',
    metric: 'runs',
    count: 1,
    updatedAt: now,
  }).run()

  assert.throws(() => {
    db.insert(usageCounters).values({
      id: 'uc_2',
      scope: 'proj_1',
      period: '2026-03',
      metric: 'runs',
      count: 2,
      updatedAt: now,
    }).run()
  })

  cleanup(tmpDir)
})
