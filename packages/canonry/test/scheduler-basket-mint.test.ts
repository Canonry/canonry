import { test, expect, onTestFinished } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, queries, queryBasketVersions } from '@ainyc/canonry-db'
import { Scheduler } from '../src/scheduler.js'

// Basket revisions are normally minted when a sweep is queued. That left a gap:
// a project whose sweeps are manual (the real cadence is about twice a month)
// shipped the basket feature and then sat on the pre-basket date heuristic for
// weeks, with its chart still hiding exactly the history the basket recovers.
// Nothing was broken, but the fix everyone deployed for was inert.
//
// These tests pin the boot-time mint that closes the gap: start() records the
// current set for every project that has one, without churning revisions on
// restart and without touching projects that have nothing to record.

function harness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-basket-mint-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  return db
}

function seedProject(db: ReturnType<typeof createClient>, name: string, queryTexts: string[]) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id, name, displayName: name, canonicalDomain: `${name}.com`,
    country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
  for (const text of queryTexts) {
    db.insert(queries).values({ id: crypto.randomUUID(), projectId: id, query: text, createdAt: now }).run()
  }
  return id
}

function startScheduler(db: ReturnType<typeof createClient>) {
  const scheduler = new Scheduler(db, { onRunCreated: () => {} })
  scheduler.start()
  onTestFinished(() => scheduler.stop())
  return scheduler
}

function revisions(db: ReturnType<typeof createClient>, projectId: string) {
  // Explicit order: SQLite is free to walk the (project_id, revision) PK in
  // either direction, and this helper's callers index into the result.
  return db.select().from(queryBasketVersions)
    .where(eq(queryBasketVersions.projectId, projectId))
    .orderBy(queryBasketVersions.revision).all()
}

test('start() records revision 1 for every project with queries', () => {
  const db = harness()
  const withQueries = seedProject(db, 'swept-manually', ['best roof coating', 'acme coatings reviews'])
  const alsoQueries = seedProject(db, 'another', ['some question'])

  startScheduler(db)

  expect(revisions(db, withQueries)).toHaveLength(1)
  expect(revisions(db, alsoQueries)).toHaveLength(1)
  const members = JSON.parse(revisions(db, withQueries)[0]!.membersJson) as string[]
  expect(members).toEqual(['acme coatings reviews', 'best roof coating'])
})

test('a restart mints nothing new, so revision numbers keep counting real changes', () => {
  const db = harness()
  const projectId = seedProject(db, 'stable', ['unchanged query'])

  startScheduler(db)
  startScheduler(db)
  startScheduler(db)

  expect(revisions(db, projectId)).toHaveLength(1)
  expect(revisions(db, projectId)[0]!.revision).toBe(1)
})

test('a query edit made while the server was down is picked up as a new revision on boot', () => {
  const db = harness()
  const projectId = seedProject(db, 'edited-offline', ['original query'])
  startScheduler(db)

  // Server "down": operator edits queries directly (apply, replace, etc).
  db.insert(queries).values({
    id: crypto.randomUUID(), projectId, query: 'added while down',
    createdAt: new Date().toISOString(),
  }).run()

  startScheduler(db)

  const revs = revisions(db, projectId)
  expect(revs).toHaveLength(2)
  expect(JSON.parse(revs[1]!.membersJson)).toContain('added while down')
})

test('a project with no queries is left unversioned', () => {
  // An empty basket would make "not configured yet" look like a deliberate
  // measurement set of size zero.
  const db = harness()
  const emptyProject = seedProject(db, 'empty', [])

  startScheduler(db)

  expect(revisions(db, emptyProject)).toHaveLength(0)
})
