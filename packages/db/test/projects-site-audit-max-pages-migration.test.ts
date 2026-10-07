import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createClient, migrate, MIGRATION_VERSIONS, projects, type DatabaseClient } from '../src/index.js'
import { insertLegacyProject } from './legacy-rows.js'

// v169 adds the saved Site Health page budget, `projects.site_audit_max_pages`.
// It is nullable with no default: null means the full site, so every project
// stored before it, and every row an older writer inserts without naming it,
// keeps scanning the full site.

const BUDGET_VERSION = 169
const NOW = '2026-10-06T00:00:00.000Z'

function tempDb(versions = MIGRATION_VERSIONS): DatabaseClient {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-site-audit-max-pages-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  migrate(db, versions)
  return db
}

function column(db: DatabaseClient) {
  return (db.all(sql.raw(`PRAGMA table_info('projects')`)) as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>)
    .find(entry => entry.name === 'site_audit_max_pages')
}

function budgetOf(db: DatabaseClient, id: string) {
  return db.select({ siteAuditMaxPages: projects.siteAuditMaxPages, displayName: projects.displayName })
    .from(projects).where(eq(projects.id, id)).get()
}

describe('projects site audit max pages (v169)', () => {
  it('is registered under its name', () => {
    expect(MIGRATION_VERSIONS.find(mv => mv.version === BUDGET_VERSION)?.name).toBe('projects-site-audit-max-pages')
  })

  it('upgrades a v168 project to a nullable column that reads as the full site', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version < BUDGET_VERSION))
    expect(column(db)).toBeUndefined()
    insertLegacyProject(db, { id: 'legacy-project', displayName: 'Legacy', createdAt: NOW })

    migrate(db)

    expect(column(db)).toMatchObject({ type: 'INTEGER', notnull: 0, dflt_value: null })
    expect(budgetOf(db, 'legacy-project')).toEqual({ siteAuditMaxPages: null, displayName: 'Legacy' })

    // An older writer that never names the column still inserts, as full site.
    insertLegacyProject(db, { id: 'older-writer', createdAt: NOW })
    expect(budgetOf(db, 'older-writer')?.siteAuditMaxPages).toBeNull()

    // A saved budget round-trips as the number written.
    db.update(projects).set({ siteAuditMaxPages: 2_500 }).where(eq(projects.id, 'legacy-project')).run()
    expect(budgetOf(db, 'legacy-project')?.siteAuditMaxPages).toBe(2_500)
  })

  it('is idempotent when the statement runs again', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version <= BUDGET_VERSION))
    insertLegacyProject(db, { id: 'project-1', createdAt: NOW })
    db.update(projects).set({ siteAuditMaxPages: 2_500 }).where(eq(projects.id, 'project-1')).run()
    const migration = MIGRATION_VERSIONS.filter(mv => mv.version === BUDGET_VERSION)
    // A retry after a crash between the ALTER and the `_migrations` row re-runs
    // the statement; the runner swallows the duplicate-column error.
    db.$client.prepare('DELETE FROM _migrations WHERE version = ?').run(BUDGET_VERSION)
    expect(() => migrate(db, migration)).not.toThrow()
    expect(() => migrate(db)).not.toThrow()
    expect(budgetOf(db, 'project-1')?.siteAuditMaxPages).toBe(2_500)
    expect(db.$client.prepare('SELECT COUNT(*) AS count FROM _migrations WHERE version = ?').get(BUDGET_VERSION))
      .toEqual({ count: 1 })
  })
})
