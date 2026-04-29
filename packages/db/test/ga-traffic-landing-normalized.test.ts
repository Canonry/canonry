import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
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

test('ga_traffic_snapshots round-trips landingPageNormalized when set', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(gaTrafficSnapshots).values({
    id: 'snap_1',
    projectId: 'proj_1',
    date: '2026-04-29',
    landingPage: '/?fbclid=foo',
    landingPageNormalized: '/',
    sessions: 5,
    organicSessions: 0,
    users: 4,
    syncedAt: now,
  }).run()

  const [row] = db
    .select()
    .from(gaTrafficSnapshots)
    .where(eq(gaTrafficSnapshots.id, 'snap_1'))
    .all()

  expect(row.landingPage).toBe('/?fbclid=foo')
  expect(row.landingPageNormalized).toBe('/')
})

test('ga_traffic_snapshots accepts a row without landingPageNormalized (nullable, legacy rows)', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(gaTrafficSnapshots).values({
    id: 'snap_legacy',
    projectId: 'proj_1',
    date: '2026-04-29',
    landingPage: '/legacy',
    sessions: 1,
    organicSessions: 0,
    users: 1,
    syncedAt: now,
  }).run()

  const [row] = db
    .select()
    .from(gaTrafficSnapshots)
    .where(eq(gaTrafficSnapshots.id, 'snap_legacy'))
    .all()

  expect(row.landingPageNormalized).toBeNull()
})

test('aggregating with COALESCE collapses fbclid variants of the same page', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  // Three rows that should collapse to the same canonical "/" via the
  // normalized column (and a fourth with a different page).
  db.insert(gaTrafficSnapshots).values([
    {
      id: 'r1',
      projectId: 'proj_1',
      date: '2026-04-29',
      landingPage: '/?fbclid=A',
      landingPageNormalized: '/',
      sessions: 4,
      organicSessions: 0,
      users: 4,
      syncedAt: now,
    },
    {
      id: 'r2',
      projectId: 'proj_1',
      date: '2026-04-29',
      landingPage: '/?fbclid=B',
      landingPageNormalized: '/',
      sessions: 1,
      organicSessions: 0,
      users: 1,
      syncedAt: now,
    },
    {
      id: 'r3',
      projectId: 'proj_1',
      date: '2026-04-29',
      landingPage: '/',
      landingPageNormalized: '/',
      sessions: 75,
      organicSessions: 12,
      users: 60,
      syncedAt: now,
    },
    {
      id: 'r4',
      projectId: 'proj_1',
      date: '2026-04-29',
      landingPage: '/about',
      landingPageNormalized: '/about',
      sessions: 6,
      organicSessions: 1,
      users: 5,
      syncedAt: now,
    },
  ]).run()

  // The migration boundary contract: read queries use
  //   GROUP BY COALESCE(landing_page_normalized, landing_page)
  // so partial-backfill states aggregate correctly. Verify with raw SQL.
  const rows = db
    .select({
      page: sql<string>`COALESCE(${gaTrafficSnapshots.landingPageNormalized}, ${gaTrafficSnapshots.landingPage})`,
      sessions: sql<number>`SUM(${gaTrafficSnapshots.sessions})`,
    })
    .from(gaTrafficSnapshots)
    .groupBy(sql`COALESCE(${gaTrafficSnapshots.landingPageNormalized}, ${gaTrafficSnapshots.landingPage})`)
    .orderBy(sql`SUM(${gaTrafficSnapshots.sessions}) DESC`)
    .all()

  expect(rows).toHaveLength(2)
  expect(rows[0].page).toBe('/')
  expect(rows[0].sessions).toBe(80) // 4 + 1 + 75
  expect(rows[1].page).toBe('/about')
  expect(rows[1].sessions).toBe(6)
})

test('aggregating with COALESCE handles a mix of populated and legacy null rows', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  // r1 written under the new code (normalized populated).
  // r2 is a legacy row from before the migration (normalized null).
  // Both reference the same canonical /pricing page; COALESCE means
  // r2's raw landingPage is what gets compared, so they only collapse
  // if their raw matches the normalized form. This documents the
  // expected behavior of partial backfill.
  db.insert(gaTrafficSnapshots).values([
    {
      id: 'new',
      projectId: 'proj_1',
      date: '2026-04-29',
      landingPage: '/pricing/?utm=foo',
      landingPageNormalized: '/pricing',
      sessions: 5,
      organicSessions: 0,
      users: 5,
      syncedAt: now,
    },
    {
      id: 'legacy',
      projectId: 'proj_1',
      date: '2026-04-29',
      landingPage: '/pricing',
      landingPageNormalized: null,
      sessions: 3,
      organicSessions: 1,
      users: 3,
      syncedAt: now,
    },
  ]).run()

  // After backfill, the legacy row's normalized would also be '/pricing'
  // and they'd collapse. With COALESCE they collapse already because
  // the new row's normalized form matches the legacy row's raw form.
  const rows = db
    .select({
      page: sql<string>`COALESCE(${gaTrafficSnapshots.landingPageNormalized}, ${gaTrafficSnapshots.landingPage})`,
      sessions: sql<number>`SUM(${gaTrafficSnapshots.sessions})`,
    })
    .from(gaTrafficSnapshots)
    .groupBy(sql`COALESCE(${gaTrafficSnapshots.landingPageNormalized}, ${gaTrafficSnapshots.landingPage})`)
    .all()

  expect(rows).toHaveLength(1)
  expect(rows[0].page).toBe('/pricing')
  expect(rows[0].sessions).toBe(8)
})
