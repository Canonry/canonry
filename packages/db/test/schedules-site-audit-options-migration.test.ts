import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createClient, migrate, MIGRATION_VERSIONS, schedules, type DatabaseClient } from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

// v167 adds the nullable `schedules.site_audit_options` column: the crawl
// options a site-audit schedule runs with. Null means none are stored, and a
// scheduled audit then scans the full site, so every schedule that predates the
// column keeps working without a backfill.

const SITE_AUDIT_OPTIONS_VERSION = 167
const NOW = '2026-10-02T00:00:00.000Z'

function tempDb(versions = MIGRATION_VERSIONS): DatabaseClient {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-schedule-site-audit-options-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  migrate(db, versions)
  return db
}

function column(db: DatabaseClient) {
  return (db.all(sql.raw(`PRAGMA table_info('schedules')`)) as Array<{ name: string; notnull: number; dflt_value: string | null }>)
    .find(entry => entry.name === 'site_audit_options')
}

function seedLegacySchedule(db: DatabaseClient): void {
  insertLegacyProject(db, { id: 'project-1', createdAt: NOW })
  insertLegacyRow(db, 'schedules', {
    id: 'schedule-1',
    project_id: 'project-1',
    kind: 'site-audit',
    cron_expr: '0 5 1 * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    next_run_at: '2026-11-01T05:00:00.000Z',
    created_at: NOW,
    updated_at: NOW,
  })
}

describe('schedules site-audit options (v167)', () => {
  it('is registered under its name', () => {
    expect(MIGRATION_VERSIONS.find(mv => mv.version === SITE_AUDIT_OPTIONS_VERSION)?.name).toBe('schedules-site-audit-options')
  })

  it('upgrades a v166 site-audit schedule to no stored options without touching its timing', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version < SITE_AUDIT_OPTIONS_VERSION))
    expect(column(db)).toBeUndefined()
    seedLegacySchedule(db)

    migrate(db)

    expect(column(db)).toMatchObject({ notnull: 0, dflt_value: null })
    expect(db.select().from(schedules).where(eq(schedules.id, 'schedule-1')).get()).toMatchObject({
      kind: 'site-audit',
      cronExpr: '0 5 1 * *',
      nextRunAt: '2026-11-01T05:00:00.000Z',
      updatedAt: NOW,
      siteAuditOptions: null,
    })
  })

  it('round-trips stored options as JSON', () => {
    const db = tempDb()
    seedLegacySchedule(db)
    db.update(schedules).set({ siteAuditOptions: { maxPages: 25_000, checkDeadLinks: true } })
      .where(eq(schedules.id, 'schedule-1')).run()
    expect(db.select({ siteAuditOptions: schedules.siteAuditOptions }).from(schedules).where(eq(schedules.id, 'schedule-1')).get())
      .toEqual({ siteAuditOptions: { maxPages: 25_000, checkDeadLinks: true } })
  })

  it('is idempotent when the statement runs again', () => {
    const db = tempDb()
    seedLegacySchedule(db)
    db.update(schedules).set({ siteAuditOptions: { maxDepth: 4 } }).where(eq(schedules.id, 'schedule-1')).run()
    // A retry after a crash between the ALTER and the `_migrations` row re-runs
    // the statement; the runner swallows the duplicate-column error. A crash
    // there means no later version ran either, and the runner skips anything at
    // or below the highest recorded version, so forget those rows too.
    db.$client.prepare('DELETE FROM _migrations WHERE version >= ?').run(SITE_AUDIT_OPTIONS_VERSION)
    expect(() => migrate(db, MIGRATION_VERSIONS.filter(mv => mv.version === SITE_AUDIT_OPTIONS_VERSION))).not.toThrow()
    expect(() => migrate(db)).not.toThrow()
    expect(db.select({ siteAuditOptions: schedules.siteAuditOptions }).from(schedules).where(eq(schedules.id, 'schedule-1')).get())
      .toEqual({ siteAuditOptions: { maxDepth: 4 } })
    expect(db.$client.prepare('SELECT COUNT(*) AS count FROM _migrations WHERE version = ?').get(SITE_AUDIT_OPTIONS_VERSION))
      .toEqual({ count: 1 })
  })
})
