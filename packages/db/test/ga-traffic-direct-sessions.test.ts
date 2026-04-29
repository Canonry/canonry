import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  gaTrafficSnapshots,
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

function seedProject(db: ReturnType<typeof createTempDb>['db']) {
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
}

test('ga_traffic_snapshots round-trips direct_sessions when set', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(gaTrafficSnapshots).values({
    id: 'snap_1',
    projectId: 'proj_1',
    date: '2026-04-29',
    landingPage: '/pricing',
    sessions: 25,
    organicSessions: 4,
    directSessions: 7,
    users: 18,
    syncedAt: now,
  }).run()

  const [row] = db
    .select()
    .from(gaTrafficSnapshots)
    .where(eq(gaTrafficSnapshots.id, 'snap_1'))
    .all()

  expect(row).toBeDefined()
  expect(row.directSessions).toBe(7)
  expect(row.sessions).toBe(25)
  expect(row.organicSessions).toBe(4)
})

test('ga_traffic_snapshots accepts a row without direct_sessions (nullable)', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(gaTrafficSnapshots).values({
    id: 'snap_2',
    projectId: 'proj_1',
    date: '2026-04-29',
    landingPage: '/about',
    sessions: 10,
    organicSessions: 2,
    users: 8,
    syncedAt: now,
  }).run()

  const [row] = db
    .select()
    .from(gaTrafficSnapshots)
    .where(eq(gaTrafficSnapshots.id, 'snap_2'))
    .all()

  expect(row).toBeDefined()
  expect(row.directSessions).toBeNull()
})

test('ga_traffic_snapshots can store directSessions = 0 distinctly from null', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(gaTrafficSnapshots).values({
    id: 'snap_zero',
    projectId: 'proj_1',
    date: '2026-04-29',
    landingPage: '/contact',
    sessions: 5,
    organicSessions: 5,
    directSessions: 0,
    users: 4,
    syncedAt: now,
  }).run()

  const [row] = db
    .select()
    .from(gaTrafficSnapshots)
    .where(eq(gaTrafficSnapshots.id, 'snap_zero'))
    .all()

  expect(row.directSessions).toBe(0)
  expect(row.directSessions).not.toBeNull()
})
