import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createClient, migrate, MIGRATION_VERSIONS, runs, type DatabaseClient } from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

// v175 adds `runs.skipped_providers`: the providers a run does not call because
// each keeps failing on its account, frozen at queue time. Nullable with no
// default, so every run stored before it, and every run an older writer
// queues without naming it, skips none.

const SKIPPED_VERSION = 175
const NOW = '2026-10-07T00:00:00.000Z'
const STREAK = { code: 'PROVIDER_BILLING', consecutiveRuns: 10, since: NOW, latestRunId: 'run-0', retryAfter: '2026-10-08T00:00:00.000Z' } as const

function tempDb(versions = MIGRATION_VERSIONS): DatabaseClient {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-runs-skipped-providers-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  migrate(db, versions)
  return db
}

function column(db: DatabaseClient) {
  return (db.all(sql.raw(`PRAGMA table_info('runs')`)) as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>)
    .find(entry => entry.name === 'skipped_providers')
}

const skippedOf = (db: DatabaseClient, id: string) =>
  db.select({ skippedProviders: runs.skippedProviders }).from(runs).where(eq(runs.id, id)).get()?.skippedProviders

describe('runs skipped providers (v175)', () => {
  it('upgrades a v174 run to a nullable column that reads as skipping none', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version < SKIPPED_VERSION))
    expect(column(db)).toBeUndefined()
    insertLegacyProject(db, { id: 'project', createdAt: NOW })
    insertLegacyRow(db, 'runs', { id: 'legacy-run', project_id: 'project', status: 'failed', created_at: NOW })

    migrate(db)

    expect(MIGRATION_VERSIONS.find(mv => mv.version === SKIPPED_VERSION)?.name).toBe('runs-skipped-providers')
    expect(column(db)).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
    expect(skippedOf(db, 'legacy-run')).toBeNull()

    // An older writer that never names the column still inserts, skipping none.
    insertLegacyRow(db, 'runs', { id: 'older-writer', project_id: 'project', status: 'queued', created_at: NOW })
    expect(skippedOf(db, 'older-writer')).toBeNull()

    // A frozen skip round-trips as the streak written.
    db.update(runs).set({ skippedProviders: { openai: STREAK } }).where(eq(runs.id, 'legacy-run')).run()
    expect(skippedOf(db, 'legacy-run')).toEqual({ openai: STREAK })
  })

  it('is idempotent when the statement runs again', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version <= SKIPPED_VERSION))
    insertLegacyProject(db, { id: 'project', createdAt: NOW })
    insertLegacyRow(db, 'runs', { id: 'run-1', project_id: 'project', status: 'partial', skipped_providers: { openai: STREAK }, created_at: NOW })
    // A retry after a crash between the ALTER and the `_migrations` row re-runs
    // the statement; the runner swallows the duplicate-column error.
    db.$client.prepare('DELETE FROM _migrations WHERE version = ?').run(SKIPPED_VERSION)
    expect(() => migrate(db, MIGRATION_VERSIONS.filter(mv => mv.version === SKIPPED_VERSION))).not.toThrow()
    expect(skippedOf(db, 'run-1')).toEqual({ openai: STREAK })
    expect(db.$client.prepare('SELECT COUNT(*) AS count FROM _migrations WHERE version = ?').get(SKIPPED_VERSION))
      .toEqual({ count: 1 })
  })
})
