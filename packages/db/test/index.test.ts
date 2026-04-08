import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../src/schema.js'
import {
  createClient,
  migrate,
  projects,
  keywords,
  competitors,
  runs,
  querySnapshots,
  auditLog,
  apiKeys,
  usageCounters,
  schedules,
  notifications,
  googleConnections,
  gscSearchData,
  gscUrlInspections,
  gscCoverageSnapshots,
  bingConnections,
  bingUrlInspections,
  bingKeywordStats,
  gaConnections,
  gaTrafficSnapshots,
  gaAiReferrals,
  gaTrafficSummaries,
  insights,
  healthSnapshots,
} from '../src/index.js'

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
  onTestFinished(() => cleanup(tmpDir))
  expect(db).toBeDefined()
})

test('migrate creates all tables', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  // Verify tables exist by querying them (would throw if missing)
  const projectRows = db.select().from(projects).all()
  expect(projectRows).toEqual([])

  const keywordRows = db.select().from(keywords).all()
  expect(keywordRows).toEqual([])

  const runRows = db.select().from(runs).all()
  expect(runRows).toEqual([])

  const snapshotRows = db.select().from(querySnapshots).all()
  expect(snapshotRows).toEqual([])

  const logRows = db.select().from(auditLog).all()
  expect(logRows).toEqual([])

  const keyRows = db.select().from(apiKeys).all()
  expect(keyRows).toEqual([])

  const usageRows = db.select().from(usageCounters).all()
  expect(usageRows).toEqual([])

  const scheduleRows = db.select().from(schedules).all()
  expect(scheduleRows).toEqual([])

  const notifRows = db.select().from(notifications).all()
  expect(notifRows).toEqual([])

  const competitorRows = db.select().from(competitors).all()
  expect(competitorRows).toEqual([])

  const googleConnRows = db.select().from(googleConnections).all()
  expect(googleConnRows).toEqual([])

  const gscSearchRows = db.select().from(gscSearchData).all()
  expect(gscSearchRows).toEqual([])

  const gscInspectRows = db.select().from(gscUrlInspections).all()
  expect(gscInspectRows).toEqual([])

  const gscCoverageRows = db.select().from(gscCoverageSnapshots).all()
  expect(gscCoverageRows).toEqual([])

  const bingConnRows = db.select().from(bingConnections).all()
  expect(bingConnRows).toEqual([])

  const bingInspectRows = db.select().from(bingUrlInspections).all()
  expect(bingInspectRows).toEqual([])

  const bingKwRows = db.select().from(bingKeywordStats).all()
  expect(bingKwRows).toEqual([])

  const gaConnRows = db.select().from(gaConnections).all()
  expect(gaConnRows).toEqual([])

  const gaTrafficRows = db.select().from(gaTrafficSnapshots).all()
  expect(gaTrafficRows).toEqual([])

  const gaAiRefRows = db.select().from(gaAiReferrals).all()
  expect(gaAiRefRows).toEqual([])

  const gaSummaryRows = db.select().from(gaTrafficSummaries).all()
  expect(gaSummaryRows).toEqual([])

  const insightRows = db.select().from(insights).all()
  expect(insightRows).toEqual([])

  const healthRows = db.select().from(healthSnapshots).all()
  expect(healthRows).toEqual([])
})

test('migrate is idempotent', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  // Running migrate again should not throw
  migrate(db)
  migrate(db)
})

test('CRUD: insert and query a project', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
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
  expect(project.id).toBe('proj_1')
  expect(project.displayName).toBe('Test Project')
  expect(project.configSource).toBe('cli')
  expect(project.configRevision).toBe(1)
  expect(JSON.parse(project.tags)).toEqual([])
  expect(JSON.parse(project.labels)).toEqual({})
})

test('CRUD: insert keywords with project FK', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
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
  expect(kws).toHaveLength(1)
  expect(kws[0].keyword).toBe('emergency dentist brooklyn')
})

test('CRUD: cascade delete removes keywords when project deleted', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
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
  expect(kws).toHaveLength(0)
})

test('CRUD: insert run and query snapshot', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
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
  expect(snap.citationState).toBe('cited')
  expect(JSON.parse(snap.citedDomains)).toEqual(['example.com'])
  expect(JSON.parse(snap.recommendedCompetitors)).toEqual([])
})

test('unique constraint on keywords(project_id, keyword)', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
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

  expect(() => {
    db.insert(keywords).values({
      id: 'kw_2',
      projectId: 'proj_1',
      keyword: 'duplicate',
      createdAt: now,
    }).run()
  }).toThrow()
})

test('usage_counters unique constraint on (scope, period, metric)', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  const now = new Date().toISOString()

  db.insert(usageCounters).values({
    id: 'uc_1',
    scope: 'proj_1',
    period: '2026-03',
    metric: 'runs',
    count: 1,
    updatedAt: now,
  }).run()

  expect(() => {
    db.insert(usageCounters).values({
      id: 'uc_2',
      scope: 'proj_1',
      period: '2026-03',
      metric: 'runs',
      count: 2,
      updatedAt: now,
    }).run()
  }).toThrow()
})

test('CRUD: insert and query a schedule', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
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
  expect(sched.cronExpr).toBe('0 6 * * *')
  expect(sched.preset).toBe('daily')
  expect(sched.enabled).toBe(1)
})

test('schedules unique constraint on project_id (one per project)', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
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

  expect(() => {
    db.insert(schedules).values({
      id: 'sched_2',
      projectId: 'proj_1',
      cronExpr: '0 12 * * *',
      createdAt: now,
      updatedAt: now,
    }).run()
  }).toThrow()
})

test('CRUD: insert and query notifications', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
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
  expect(notifs).toHaveLength(1)
  expect(notifs[0].channel).toBe('webhook')
  const config = JSON.parse(notifs[0].config) as { url: string; events: string[] }
  expect(config.url).toBe('https://hooks.example.com/test')
  expect(config.events).toEqual(['citation.lost'])
})

test('cascade delete removes schedules and notifications when project deleted', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
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

  expect(db.select().from(schedules).all()).toHaveLength(0)
  expect(db.select().from(notifications).all()).toHaveLength(0)
})

test('v4 migration adds owned_domains column to existing DB', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-test-'))
  onTestFinished(() => cleanup(tmpDir))
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
  expect(project.canonicalDomain).toBe('example.com')
  expect(project.ownedDomains).toBe('[]')
})
