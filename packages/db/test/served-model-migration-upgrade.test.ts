import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  runs,
  MIGRATION_VERSIONS,
  type MigrationVersion,
} from '../src/index.js'

// The PRODUCTION upgrade path for v105, end to end: an existing DB sitting at
// v104 (no `served_model` column, ~2,562 snapshots already written) boots a
// binary carrying v105 and must come back with the served model recovered.
//
// `served-model-migration.test.ts` covers the backfill FUNCTION. This file
// covers the WIRING: that `migrate()` — the only entry point production calls —
// actually invokes it. Detach v105's `run` hook and every assertion below that
// expects a non-NULL `served_model` fails, which the last test in this file
// demonstrates directly rather than asserting on faith.

const V105 = 105

type Db = ReturnType<typeof createClient>

/** A DB migrated only as far as v104 — i.e. the state a real upgrade starts from. */
function preV105Db(): Db {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-served-model-upgrade-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  // The documented downgrade/upgrade test seam: a truncated version list is
  // exactly what an older binary would have applied.
  migrate(db, MIGRATION_VERSIONS.filter((mv) => mv.version < V105))
  return db
}

function seedRun(db: Db): string {
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const now = '2026-06-01T00:00:00.000Z'
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

/**
 * Inserts through raw SQL naming only the pre-v105 columns. Drizzle's
 * `querySnapshots` already declares `servedModel`, so it cannot write a row
 * into a table that does not have the column yet — which is precisely the
 * state a real upgrade finds.
 */
function seedPreV105Snapshot(
  db: Db,
  runId: string,
  provider: string,
  model: string | null,
  rawResponse: string | null,
): string {
  const id = crypto.randomUUID()
  db.run(sql`
    INSERT INTO query_snapshots
      (id, run_id, query_text, provider, model, citation_state, raw_response, created_at)
    VALUES
      (${id}, ${runId}, ${'best widgets'}, ${provider}, ${model}, ${'not-cited'},
       ${rawResponse}, ${'2026-06-01T00:00:00.000Z'})
  `)
  return id
}

/** The `{ model, groundingSources, searchQueries, apiResponse }` wrapper job-runner writes. */
function envelope(configured: string, apiResponse: unknown): string {
  return JSON.stringify({
    model: configured, groundingSources: [], searchQueries: [], apiResponse,
  })
}

function snapshotRow(db: Db, id: string): { model: string | null; servedModel: string | null } {
  const rows = db.all(
    sql`SELECT model, served_model AS servedModel FROM query_snapshots WHERE id = ${id}`,
  ) as Array<{ model: string | null; servedModel: string | null }>
  expect(rows).toHaveLength(1)
  return rows[0]!
}

function columnNames(db: Db, table: string): string[] {
  return (db.all(sql.raw(`PRAGMA table_info(${table})`)) as Array<{ name: string }>)
    .map((c) => c.name)
}

/** Seeds one row of every shape the production table actually holds. */
function seedProductionShapes(db: Db, runId: string) {
  return {
    // The 889-row divergence: requested `gpt-5.4`, served a dated snapshot.
    // The SERVED value must win; the configured echo must never be written.
    diverged: seedPreV105Snapshot(db, runId, 'openai', 'gpt-5.4',
      envelope('gpt-5.4', { model: 'gpt-5.4-2026-03-05' })),
    // Requested and served agree — still recorded, not skipped.
    matching: seedPreV105Snapshot(db, runId, 'claude', 'claude-sonnet-4-6',
      envelope('claude-sonnet-4-6', { model: 'claude-sonnet-4-6' })),
    // Gemini: `modelVersion` was dropped before storage, so `apiResponse` holds
    // only candidates/usageMetadata. No honest served value exists.
    gemini: seedPreV105Snapshot(db, runId, 'gemini', 'gemini-3-flash-preview',
      envelope('gemini-3-flash-preview', { candidates: [], usageMetadata: {} })),
    nullRaw: seedPreV105Snapshot(db, runId, 'openai', 'gpt-5.4', null),
    truncatedJson: seedPreV105Snapshot(db, runId, 'openai', 'gpt-5.4', '{truncated…'),
    scalarJson: seedPreV105Snapshot(db, runId, 'cdp', null, '"just a string"'),
  }
}

test('migrate() upgrades a v104 DB and backfills served_model from stored raw responses', () => {
  const db = preV105Db()
  const runId = seedRun(db)

  // Precondition: this really is a pre-v105 database.
  expect(columnNames(db, 'query_snapshots')).not.toContain('served_model')
  expect(
    db.all(sql`SELECT version FROM _migrations WHERE version = ${V105}`),
  ).toHaveLength(0)

  const ids = seedProductionShapes(db, runId)

  // The real production entry point — no direct call to the backfill function.
  migrate(db)

  expect(columnNames(db, 'query_snapshots')).toContain('served_model')
  expect(
    db.all(sql`SELECT version FROM _migrations WHERE version = ${V105}`),
  ).toHaveLength(1)

  // The divergence case: the provider's string wins outright.
  const diverged = snapshotRow(db, ids.diverged)
  expect(diverged.servedModel).toBe('gpt-5.4-2026-03-05')
  expect(diverged.servedModel).not.toBe('gpt-5.4')
  // …and the requested model is left exactly as it was.
  expect(diverged.model).toBe('gpt-5.4')

  expect(snapshotRow(db, ids.matching).servedModel).toBe('claude-sonnet-4-6')

  // Unrecoverable rows stay NULL — never '' and never the configured echo.
  for (const id of [ids.gemini, ids.nullRaw, ids.truncatedJson, ids.scalarJson]) {
    const row = snapshotRow(db, id)
    expect(row.servedModel).toBeNull()
    expect(row.servedModel).not.toBe('')
  }
  // Specifically: gemini did not inherit its configured model.
  expect(snapshotRow(db, ids.gemini).servedModel).not.toBe('gemini-3-flash-preview')
})

test('a second migrate() over the upgraded DB changes nothing', () => {
  const db = preV105Db()
  const runId = seedRun(db)
  const ids = seedProductionShapes(db, runId)

  migrate(db)

  const snapshotState = () => db.all(
    sql`SELECT id, model, served_model FROM query_snapshots ORDER BY id`,
  )
  const migrationsBefore = db.all(sql`SELECT version, name FROM _migrations ORDER BY version`)
  const rowsBefore = snapshotState()

  expect(() => migrate(db)).not.toThrow()

  expect(db.all(sql`SELECT version, name FROM _migrations ORDER BY version`)).toEqual(migrationsBefore)
  expect(snapshotState()).toEqual(rowsBefore)
  expect(snapshotRow(db, ids.diverged).servedModel).toBe('gpt-5.4-2026-03-05')
})

test('the run hook is what populates served_model — detaching it leaves the column NULL', () => {
  // The control for the two tests above: same DB, same rows, same migrate()
  // call, with v105's `run` hook removed from the definition. If this ever
  // starts passing with a populated value, the assertions above have stopped
  // proving anything about the wiring.
  const db = preV105Db()
  const runId = seedRun(db)
  const ids = seedProductionShapes(db, runId)

  const withoutRunHook: MigrationVersion[] = MIGRATION_VERSIONS.map((mv) =>
    mv.version === V105
      ? { version: mv.version, name: mv.name, statements: mv.statements }
      : mv,
  )
  migrate(db, withoutRunHook)

  // The ALTER still lands — the column exists but nothing filled it in.
  expect(columnNames(db, 'query_snapshots')).toContain('served_model')
  expect(snapshotRow(db, ids.diverged).servedModel).toBeNull()
  expect(snapshotRow(db, ids.matching).servedModel).toBeNull()
})
