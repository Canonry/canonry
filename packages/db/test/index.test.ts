import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../src/schema.js'
import { createClient, migrate, projects, keywords, runs, querySnapshots, auditLog, apiKeys, usageCounters, schedules, notifications } from '../src/index.js'

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

  const scheduleRows = db.select().from(schedules).all()
  assert.deepEqual(scheduleRows, [])

  const notifRows = db.select().from(notifications).all()
  assert.deepEqual(notifRows, [])

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

test('CRUD: insert and query a schedule', () => {
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

  db.insert(schedules).values({
    id: 'sched_1',
    projectId: 'proj_1',
    cronExpr: '0 6 * * *',
    preset: 'daily',
    timezone: 'UTC',
    enabled: 1,
    providers: '[]',
    createdAt: now,
    updatedAt: now,
  }).run()

  const [sched] = db.select().from(schedules).where(eq(schedules.projectId, 'proj_1')).all()
  assert.equal(sched.cronExpr, '0 6 * * *')
  assert.equal(sched.preset, 'daily')
  assert.equal(sched.enabled, 1)

  cleanup(tmpDir)
})

test('schedules unique constraint on project_id (one per project)', () => {
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

  db.insert(schedules).values({
    id: 'sched_1',
    projectId: 'proj_1',
    cronExpr: '0 6 * * *',
    createdAt: now,
    updatedAt: now,
  }).run()

  assert.throws(() => {
    db.insert(schedules).values({
      id: 'sched_2',
      projectId: 'proj_1',
      cronExpr: '0 12 * * *',
      createdAt: now,
      updatedAt: now,
    }).run()
  })

  cleanup(tmpDir)
})

test('CRUD: insert and query notifications', () => {
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

  db.insert(notifications).values({
    id: 'notif_1',
    projectId: 'proj_1',
    channel: 'webhook',
    config: JSON.stringify({ url: 'https://hooks.example.com/test', events: ['citation.lost'] }),
    enabled: 1,
    createdAt: now,
    updatedAt: now,
  }).run()

  const notifs = db.select().from(notifications).where(eq(notifications.projectId, 'proj_1')).all()
  assert.equal(notifs.length, 1)
  assert.equal(notifs[0].channel, 'webhook')
  const config = JSON.parse(notifs[0].config) as { url: string; events: string[] }
  assert.equal(config.url, 'https://hooks.example.com/test')
  assert.deepEqual(config.events, ['citation.lost'])

  cleanup(tmpDir)
})

test('cascade delete removes schedules and notifications when project deleted', () => {
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

  db.insert(schedules).values({
    id: 'sched_1',
    projectId: 'proj_1',
    cronExpr: '0 6 * * *',
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(notifications).values({
    id: 'notif_1',
    projectId: 'proj_1',
    channel: 'webhook',
    config: '{}',
    createdAt: now,
    updatedAt: now,
  }).run()

  db.delete(projects).where(eq(projects.id, 'proj_1')).run()

  assert.equal(db.select().from(schedules).all().length, 0)
  assert.equal(db.select().from(notifications).all().length, 0)

  cleanup(tmpDir)
})

test('v4 migration adds owned_domains column to existing DB', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-test-'))
  const dbPath = path.join(tmpDir, 'test.db')

  // Create a pre-v4 database without owned_domains column
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(`
    CREATE TABLE projects (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL UNIQUE,
      display_name      TEXT NOT NULL,
      canonical_domain  TEXT NOT NULL,
      country           TEXT NOT NULL,
      language          TEXT NOT NULL,
      tags              TEXT NOT NULL DEFAULT '[]',
      labels            TEXT NOT NULL DEFAULT '{}',
      providers         TEXT NOT NULL DEFAULT '[]',
      config_source     TEXT NOT NULL DEFAULT 'cli',
      config_revision   INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    )
  `)
  const now = new Date().toISOString()
  sqlite.exec(`
    INSERT INTO projects (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
    VALUES ('proj_1', 'test-project', 'Test', 'example.com', 'US', 'en', '${now}', '${now}')
  `)
  sqlite.close()

  // Now open with Drizzle and run migrate
  const db = drizzle(new Database(dbPath), { schema })
  migrate(db)

  const [project] = db.select().from(projects).where(eq(projects.name, 'test-project')).all()
  assert.equal(project.canonicalDomain, 'example.com')
  assert.equal(project.ownedDomains, '[]')

  cleanup(tmpDir)
})
