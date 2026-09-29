import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createClient, migrate, MIGRATION_VERSIONS, projects, type DatabaseClient } from '../src/index.js'
import { insertLegacyProject } from './legacy-rows.js'

// v166 adds the sentiment-only `projects.qualified_aliases` setting. It is
// defaulted, so every project stored before it reads as not opted in, and an
// older writer that omits the column still inserts.

const QUALIFIED_VERSION = 166
const NOW = '2026-09-29T00:00:00.000Z'

function tempDb(versions = MIGRATION_VERSIONS): DatabaseClient {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-qualified-aliases-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  migrate(db, versions)
  return db
}

function column(db: DatabaseClient) {
  return (db.all(sql.raw(`PRAGMA table_info('projects')`)) as Array<{ name: string; notnull: number; dflt_value: string | null }>)
    .find(entry => entry.name === 'qualified_aliases')
}

describe('projects qualified aliases (v166)', () => {
  it('is registered under its name', () => {
    expect(MIGRATION_VERSIONS.find(mv => mv.version === QUALIFIED_VERSION)?.name).toBe('projects-qualified-aliases')
  })

  it('upgrades a v165 project to the empty default', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version < QUALIFIED_VERSION))
    expect(column(db)).toBeUndefined()
    insertLegacyProject(db, { id: 'legacy-project', displayName: 'Legacy', createdAt: NOW })

    migrate(db)

    expect(column(db)).toMatchObject({ notnull: 1, dflt_value: "'[]'" })
    expect(db.select({ qualifiedAliases: projects.qualifiedAliases, displayName: projects.displayName })
      .from(projects).where(eq(projects.id, 'legacy-project')).get())
      .toEqual({ qualifiedAliases: [], displayName: 'Legacy' })
  })

  it('is idempotent when the statement runs again', () => {
    const db = tempDb()
    insertLegacyProject(db, { id: 'project-1', createdAt: NOW })
    db.update(projects).set({ qualifiedAliases: ['Former Name'] }).where(eq(projects.id, 'project-1')).run()
    const migration = MIGRATION_VERSIONS.filter(mv => mv.version === QUALIFIED_VERSION)
    // A retry after a crash between the ALTER and the `_migrations` row re-runs
    // the statement; the runner swallows the duplicate-column error.
    db.$client.prepare('DELETE FROM _migrations WHERE version = ?').run(QUALIFIED_VERSION)
    expect(() => migrate(db, migration)).not.toThrow()
    expect(() => migrate(db)).not.toThrow()
    expect(db.select({ qualifiedAliases: projects.qualifiedAliases }).from(projects).where(eq(projects.id, 'project-1')).get())
      .toEqual({ qualifiedAliases: ['Former Name'] })
    expect(db.$client.prepare('SELECT COUNT(*) AS count FROM _migrations WHERE version = ?').get(QUALIFIED_VERSION))
      .toEqual({ count: 1 })
  })
})
