import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createClient, migrate, projects, runs, querySnapshots } from '../src/index.js'
import { backfillQuerySnapshotServedModel } from '../src/migrate.js'

// v105 promotes the model the PROVIDER reported serving out of the stored
// `raw_response` envelope and into a queryable `served_model` column.
// `model` is what we REQUESTED — the two diverge routinely (every stored
// OpenAI row asked for `gpt-5.4` and was served `gpt-5.4-2026-03-05`).
//
// The envelope shapes below mirror what `job-runner.ts` actually writes and
// what the production DB actually holds: a `{ model, groundingSources,
// searchQueries, apiResponse }` wrapper, with the served string at
// `$.apiResponse.model`. Gemini's `apiResponse` carries only `candidates` /
// `usageMetadata` — the pre-fix adapter dropped `modelVersion` before storage,
// so those rows have no recoverable served value.

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-served-model-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return db
}

function seedRun(db: ReturnType<typeof createClient>): string {
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId, name: `p-${projectId.slice(0, 8)}`, displayName: 'p',
    canonicalDomain: 'example.com', country: 'US', language: 'en',
    createdAt: now, updatedAt: now,
  }).run()
  db.insert(runs).values({
    id: runId, projectId, kind: 'answer-visibility', status: 'completed',
    trigger: 'manual', startedAt: now, createdAt: now,
  }).run()
  return runId
}

/** Seeds a snapshot with a raw `raw_response` string, bypassing Drizzle typing. */
function seedSnapshot(
  db: ReturnType<typeof createClient>,
  runId: string,
  provider: string,
  model: string | null,
  rawResponse: string | null,
): string {
  const id = crypto.randomUUID()
  db.insert(querySnapshots).values({
    id, runId, queryText: 'best widgets', provider, model,
    citationState: 'not-cited', rawResponse,
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

function envelope(configured: string, apiResponse: unknown): string {
  return JSON.stringify({
    model: configured, groundingSources: [], searchQueries: [], apiResponse,
  })
}

function servedModelOf(db: ReturnType<typeof createClient>, id: string): string | null {
  const rows = db.all(
    sql`SELECT served_model AS servedModel FROM query_snapshots WHERE id = ${id}`,
  ) as Array<{ servedModel: string | null }>
  return rows[0]?.servedModel ?? null
}

test('a freshly migrated DB has the served_model column', () => {
  const db = freshDb()
  const cols = db.all(sql`PRAGMA table_info(query_snapshots)`) as Array<{ name: string }>
  expect(cols.map((c) => c.name)).toContain('served_model')
})

test('backfill recovers the served model from the stored raw_response envelope', () => {
  const db = freshDb()
  const runId = seedRun(db)

  // The real production divergence: requested gpt-5.4, served a dated snapshot.
  const openai = seedSnapshot(db, runId, 'openai', 'gpt-5.4',
    envelope('gpt-5.4', { model: 'gpt-5.4-2026-03-05' }))
  // Anthropic-shaped: served string matches what was requested.
  const claude = seedSnapshot(db, runId, 'claude', 'claude-sonnet-4-6',
    envelope('claude-sonnet-4-6', { model: 'claude-sonnet-4-6' }))
  const perplexity = seedSnapshot(db, runId, 'perplexity', 'sonar',
    envelope('sonar', { model: 'sonar' }))
  // A tier suffix, not a date suffix — a genuinely different model.
  const tiered = seedSnapshot(db, runId, 'openai', 'gpt-5.6',
    envelope('gpt-5.6', { model: 'gpt-5.6-sol' }))

  backfillQuerySnapshotServedModel(db)

  expect(servedModelOf(db, openai)).toBe('gpt-5.4-2026-03-05')
  expect(servedModelOf(db, claude)).toBe('claude-sonnet-4-6')
  expect(servedModelOf(db, perplexity)).toBe('sonar')
  expect(servedModelOf(db, tiered)).toBe('gpt-5.6-sol')

  // The requested model is left untouched — the two columns are independent.
  const rows = db.all(
    sql`SELECT model FROM query_snapshots WHERE id = ${openai}`,
  ) as Array<{ model: string }>
  expect(rows[0].model).toBe('gpt-5.4')
})

test('rows with no recoverable served model stay NULL and do not throw', () => {
  const db = freshDb()
  const runId = seedRun(db)

  // Gemini: modelVersion was dropped before storage, so apiResponse has no
  // `model` key at all. Unrecoverable by design — must not fall back to config.
  const gemini = seedSnapshot(db, runId, 'gemini', 'gemini-3-flash-preview',
    envelope('gemini-3-flash-preview', { candidates: [], usageMetadata: {} }))
  const nullRaw = seedSnapshot(db, runId, 'openai', 'gpt-5.4', null)
  const invalidJson = seedSnapshot(db, runId, 'openai', 'gpt-5.4', '{truncated…')
  const emptyString = seedSnapshot(db, runId, 'openai', 'gpt-5.4', '')
  // A legacy envelope predating the `apiResponse` wrapper.
  const noApiResponse = seedSnapshot(db, runId, 'openai', 'gpt-5.4',
    JSON.stringify({ model: 'gpt-5.4', groundingSources: [] }))
  // JSON-valid but not an object — json_extract must not blow up.
  const scalarJson = seedSnapshot(db, runId, 'cdp', null, '"just a string"')

  expect(() => backfillQuerySnapshotServedModel(db)).not.toThrow()

  for (const id of [gemini, nullRaw, invalidJson, emptyString, noApiResponse, scalarJson]) {
    expect(servedModelOf(db, id)).toBeNull()
  }
})

test('backfill is idempotent and never overwrites an existing served_model', () => {
  const db = freshDb()
  const runId = seedRun(db)

  const recoverable = seedSnapshot(db, runId, 'openai', 'gpt-5.4',
    envelope('gpt-5.4', { model: 'gpt-5.4-2026-03-05' }))

  backfillQuerySnapshotServedModel(db)
  expect(servedModelOf(db, recoverable)).toBe('gpt-5.4-2026-03-05')

  // A second apply changes nothing (the `served_model IS NULL` guard).
  backfillQuerySnapshotServedModel(db)
  expect(servedModelOf(db, recoverable)).toBe('gpt-5.4-2026-03-05')

  // A row the live insert path already stamped must survive a later replay,
  // even when the envelope disagrees — the column, not the JSON, is truth.
  const live = seedSnapshot(db, runId, 'openai', 'gpt-5.4',
    envelope('gpt-5.4', { model: 'gpt-5.4-2026-03-05' }))
  db.run(sql`UPDATE query_snapshots SET served_model = 'stamped-at-insert' WHERE id = ${live}`)
  backfillQuerySnapshotServedModel(db)
  expect(servedModelOf(db, live)).toBe('stamped-at-insert')
})

test('re-running the full migration over an already-migrated DB is a no-op', () => {
  const db = freshDb()
  const runId = seedRun(db)
  const id = seedSnapshot(db, runId, 'openai', 'gpt-5.4',
    envelope('gpt-5.4', { model: 'gpt-5.4-2026-03-05' }))
  backfillQuerySnapshotServedModel(db)

  const before = db.all(sql`SELECT version, name FROM _migrations ORDER BY version`)
  expect(() => migrate(db)).not.toThrow()
  const after = db.all(sql`SELECT version, name FROM _migrations ORDER BY version`)

  expect(after).toEqual(before)
  expect(servedModelOf(db, id)).toBe('gpt-5.4-2026-03-05')
})
