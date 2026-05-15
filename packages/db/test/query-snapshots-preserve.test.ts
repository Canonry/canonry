import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  queries,
  runs,
  querySnapshots,
} from '../src/index.js'

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-snapshot-preserve-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return db
}

function seedProjectRunQuery(db: ReturnType<typeof createClient>) {
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const queryId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'test-project',
    displayName: 'Test',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(runs).values({
    id: runId,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    location: null,
    createdAt: now,
  }).run()
  db.insert(queries).values({
    id: queryId,
    projectId,
    query: 'best polyurea roof coating',
    provenance: 'cli',
    createdAt: now,
  }).run()
  return { projectId, runId, queryId, now }
}

test('deleting a tracked query keeps its snapshots (query_id=NULL, query_text intact)', () => {
  const db = freshDb()
  const { runId, queryId, now } = seedProjectRunQuery(db)

  // Snapshot written by the production job-runner path includes queryText.
  const snapshotId = crypto.randomUUID()
  db.insert(querySnapshots).values({
    id: snapshotId,
    runId,
    queryId,
    queryText: 'best polyurea roof coating',
    provider: 'openai',
    citationState: 'cited',
    answerMentioned: true,
    answerText: 'azcoatings is one option…',
    citedDomains: '["azcoatingsllc.com"]',
    competitorOverlap: '[]',
    recommendedCompetitors: '[]',
    location: null,
    rawResponse: null,
    createdAt: now,
  }).run()

  // Routine basket edit — operator removes the tracked query.
  db.delete(queries).where(eq(queries.id, queryId)).run()

  // Pre-v58 the snapshot would be gone. Now it survives, with the FK NULLed
  // out and the denormalized text preserved so it stays readable.
  const after = db.select().from(querySnapshots).where(eq(querySnapshots.id, snapshotId)).all()
  expect(after).toHaveLength(1)
  expect(after[0]!.queryId).toBeNull()
  expect(after[0]!.queryText).toBe('best polyurea roof coating')
  expect(after[0]!.citationState).toBe('cited')
  expect(after[0]!.citedDomains).toBe('["azcoatingsllc.com"]')
})

test('deleting the run still cascades and removes its snapshots', () => {
  // run_id keeps ON DELETE CASCADE — deleting a run legitimately means its
  // observations go too. Regression guard so the v58 rebuild doesn't
  // accidentally weaken this side of the FK.
  const db = freshDb()
  const { runId, queryId, now } = seedProjectRunQuery(db)

  const snapshotId = crypto.randomUUID()
  db.insert(querySnapshots).values({
    id: snapshotId,
    runId,
    queryId,
    queryText: 'best polyurea roof coating',
    provider: 'openai',
    citationState: 'cited',
    citedDomains: '[]',
    competitorOverlap: '[]',
    recommendedCompetitors: '[]',
    createdAt: now,
  }).run()

  db.delete(runs).where(eq(runs.id, runId)).run()

  const after = db.select().from(querySnapshots).where(eq(querySnapshots.id, snapshotId)).all()
  expect(after).toHaveLength(0)
})

test('PUT-queries-style replace (DELETE+INSERT) no longer destroys snapshot history', () => {
  // The exact pattern `packages/api-routes/src/queries.ts` runs on
  // `PUT /projects/:name/queries`: delete every queries row for the
  // project, insert the new set. Pre-v58 this wiped every snapshot for
  // those queries via the cascade.
  const db = freshDb()
  const { projectId, runId, queryId, now } = seedProjectRunQuery(db)

  const snapshotId = crypto.randomUUID()
  db.insert(querySnapshots).values({
    id: snapshotId,
    runId,
    queryId,
    queryText: 'best polyurea roof coating',
    provider: 'gemini',
    citationState: 'not-cited',
    citedDomains: '[]',
    competitorOverlap: '[]',
    recommendedCompetitors: '[]',
    createdAt: now,
  }).run()

  // Simulate the replace handler's transaction shape.
  db.transaction((tx) => {
    tx.delete(queries).where(eq(queries.projectId, projectId)).run()
    tx.insert(queries).values({
      id: crypto.randomUUID(),
      projectId,
      query: 'commercial flat roof coating',
      provenance: 'cli',
      createdAt: now,
    }).run()
  })

  const after = db.select().from(querySnapshots).where(eq(querySnapshots.id, snapshotId)).all()
  expect(after).toHaveLength(1)
  expect(after[0]!.queryId).toBeNull()
  expect(after[0]!.queryText).toBe('best polyurea roof coating')
})

test('schema declares query_id nullable with ON DELETE SET NULL', () => {
  // PRAGMA-level guard so a future migration that forgets the rebuild can't
  // silently re-introduce the cascade without failing the suite.
  const db = freshDb()
  const fks = db.all<{ table: string; from: string; to: string; on_delete: string }>(
    sql`PRAGMA foreign_key_list(query_snapshots)`,
  )
  const queryFk = fks.find(fk => fk.from === 'query_id')
  expect(queryFk).toBeDefined()
  expect(queryFk!.table).toBe('queries')
  expect(queryFk!.on_delete).toBe('SET NULL')

  const cols = db.all<{ name: string; notnull: number }>(
    sql`PRAGMA table_info(query_snapshots)`,
  )
  const queryIdCol = cols.find(c => c.name === 'query_id')
  expect(queryIdCol).toBeDefined()
  expect(queryIdCol!.notnull).toBe(0) // nullable
  expect(cols.some(c => c.name === 'query_text')).toBe(true)
})
