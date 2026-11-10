import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createClient, migrate, MIGRATION_VERSIONS, type DatabaseClient } from '../src/index.js'
import { insertLegacyProject } from './legacy-rows.js'

// v214 (`site_health_notify_state`) shipped while this release's
// provider-connection-tests, run-provider-failures and run-planned-answers
// migrations were still numbered 214-216; they run as 215-217 now. A database
// that applied them under those numbers has 216 as its highest version, and the
// runner only applies versions above it, so v214 never runs there. v218 creates
// the table again.

type MigrationVersion = (typeof MIGRATION_VERSIONS)[number]

function tempDb(versions: ReadonlyArray<MigrationVersion>): DatabaseClient {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-site-health-notify-repair-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  migrate(db, versions)
  return db
}

function named(name: string): MigrationVersion {
  const found = MIGRATION_VERSIONS.find(mv => mv.name === name)
  if (!found) throw new Error(`no migration named ${name}`)
  return found
}

function hasTable(db: DatabaseClient, table: string): boolean {
  return db.all(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`).length === 1
}

function runColumns(db: DatabaseClient): string[] {
  return (db.all(sql.raw(`PRAGMA table_info('runs')`)) as Array<{ name: string }>).map(column => column.name)
}

describe('site_health_notify_state repair (v218)', () => {
  it('creates the table on a database that applied 215-217 under their earlier numbers 214-216', () => {
    const db = tempDb([
      ...MIGRATION_VERSIONS.filter(mv => mv.version <= 213),
      { ...named('provider-connection-tests'), version: 214 },
      { ...named('run-provider-failures'), version: 215 },
      { ...named('run-planned-answers'), version: 216 },
    ])
    expect(hasTable(db, 'site_health_notify_state')).toBe(false)

    migrate(db)

    expect(hasTable(db, 'site_health_notify_state')).toBe(true)
    expect(hasTable(db, 'provider_connection_tests')).toBe(true)
    expect(runColumns(db)).toEqual(expect.arrayContaining(['provider_failures', 'planned_answers']))
  })

  it('keeps the rows of a database that ran v214 in order', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version <= 214))
    insertLegacyProject(db, { id: 'project-1', createdAt: '2026-11-10T00:00:00.000Z' })
    db.run(sql`INSERT INTO site_health_notify_state (project_id, reported_keys, run_id, updated_at)
      VALUES ('project-1', '["missing-title|0123456789abcdef"]', 'run-1', '2026-11-10T00:00:00.000Z')`)

    migrate(db)

    expect(db.all(sql`SELECT project_id, reported_keys, run_id FROM site_health_notify_state`)).toEqual([
      { project_id: 'project-1', reported_keys: '["missing-title|0123456789abcdef"]', run_id: 'run-1' },
    ])
    expect(runColumns(db)).toEqual(expect.arrayContaining(['provider_failures', 'planned_answers']))
  })
})
