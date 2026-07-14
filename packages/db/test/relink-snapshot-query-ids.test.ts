import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  queries,
  runs,
  querySnapshots,
} from '../src/index.js'
import { relinkOrphanedSnapshotQueryIds } from '../src/migrate.js'

// v98 self-heal: snapshots orphaned by the historical delete-all + reinsert
// replace paths (query_id nulled by the FK) are re-linked to the tracked query
// whose normalized text matches, scoped to the snapshot's own project. The
// migration runs once per install; the exported statement is idempotent, so
// the test exercises it directly against seeded orphans.

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-relink-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return db
}

function seedProject(db: ReturnType<typeof createClient>, name: string): string {
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId, name, displayName: name, canonicalDomain: `${name}.example`,
    country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
  return projectId
}

function seedQuery(db: ReturnType<typeof createClient>, projectId: string, query: string): string {
  const id = crypto.randomUUID()
  db.insert(queries).values({ id, projectId, query, createdAt: new Date().toISOString() }).run()
  return id
}

function seedOrphanSnapshot(
  db: ReturnType<typeof createClient>,
  projectId: string,
  queryText: string | null,
): string {
  const runId = crypto.randomUUID()
  const snapId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(runs).values({
    id: runId, projectId, kind: 'answer-visibility', status: 'completed',
    trigger: 'manual', createdAt: now, finishedAt: now,
  }).run()
  db.insert(querySnapshots).values({
    id: snapId, runId, queryId: null, queryText, provider: 'gemini', citationState: 'cited',
    citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: now,
  }).run()
  return snapId
}

function relink(db: ReturnType<typeof createClient>) {
  relinkOrphanedSnapshotQueryIds(db)
}

function queryIdOf(db: ReturnType<typeof createClient>, snapId: string): string | null {
  return db.select().from(querySnapshots).where(eq(querySnapshots.id, snapId)).get()!.queryId
}

test('relinks an orphaned snapshot to the same-project query with matching normalized text', () => {
  const db = freshDb()
  const projectId = seedProject(db, 'alpha')
  const queryId = seedQuery(db, projectId, 'Best AEO Agency')
  // stored snapshot text differs in case + whitespace — normalizeQueryText semantics
  const snapId = seedOrphanSnapshot(db, projectId, '  best aeo agency ')

  relink(db)
  expect(queryIdOf(db, snapId)).toBe(queryId)
})

test('relinks non-ASCII case variants the shared normalizer folds but SQLite lower() cannot', () => {
  // SQLite lower() is ASCII-only: a pure-SQL match would strand ÉCOLE/école
  // forever (v98 runs once). The TS relink uses normalizeQueryText, which
  // lowercases Unicode.
  const db = freshDb()
  const projectId = seedProject(db, 'alpha')
  const queryId = seedQuery(db, projectId, 'école de commerce paris')
  const snapId = seedOrphanSnapshot(db, projectId, 'ÉCOLE DE COMMERCE PARIS')

  relink(db)
  expect(queryIdOf(db, snapId)).toBe(queryId)
})

test('never cross-links between projects sharing the same query text', () => {
  const db = freshDb()
  const alphaId = seedProject(db, 'alpha')
  const betaId = seedProject(db, 'beta')
  const alphaQueryId = seedQuery(db, alphaId, 'best aeo agency')
  const betaQueryId = seedQuery(db, betaId, 'best aeo agency')
  const alphaSnap = seedOrphanSnapshot(db, alphaId, 'best aeo agency')
  const betaSnap = seedOrphanSnapshot(db, betaId, 'best aeo agency')

  relink(db)
  expect(queryIdOf(db, alphaSnap)).toBe(alphaQueryId)
  expect(queryIdOf(db, betaSnap)).toBe(betaQueryId)
})

test('leaves retired-query orphans (no matching current text) and text-less orphans unlinked', () => {
  const db = freshDb()
  const projectId = seedProject(db, 'alpha')
  seedQuery(db, projectId, 'best aeo agency')
  const retiredSnap = seedOrphanSnapshot(db, projectId, 'an old retired query')
  const textlessSnap = seedOrphanSnapshot(db, projectId, null)

  relink(db)
  expect(queryIdOf(db, retiredSnap)).toBeNull()
  expect(queryIdOf(db, textlessSnap)).toBeNull()
})

test('does not touch snapshots that already have a query_id, and re-running is a no-op', () => {
  const db = freshDb()
  const projectId = seedProject(db, 'alpha')
  const queryId = seedQuery(db, projectId, 'best aeo agency')
  const otherQueryId = seedQuery(db, projectId, 'another tracked query')

  // already-linked snapshot pointing at a DIFFERENT query than its text —
  // deliberate: the relink must never second-guess an existing FK.
  const runId = crypto.randomUUID()
  const linkedSnap = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(runs).values({
    id: runId, projectId, kind: 'answer-visibility', status: 'completed',
    trigger: 'manual', createdAt: now, finishedAt: now,
  }).run()
  db.insert(querySnapshots).values({
    id: linkedSnap, runId, queryId: otherQueryId, queryText: 'best aeo agency', provider: 'gemini',
    citationState: 'cited', citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: now,
  }).run()
  const orphanSnap = seedOrphanSnapshot(db, projectId, 'best aeo agency')

  relink(db)
  relink(db) // idempotent
  expect(queryIdOf(db, linkedSnap)).toBe(otherQueryId)
  expect(queryIdOf(db, orphanSnap)).toBe(queryId)
})
