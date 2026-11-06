import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import { RunKinds, RunStatuses, RunTriggers } from '@canonry/canonry-contracts'
import {
  createClient,
  gaMeasurementSyncStates,
  gaSearchLandingPages,
  gaSearchLandingWindows,
  migrate,
  MIGRATION_VERSIONS,
  projects,
  runs,
  type DatabaseClient,
} from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

// v176 stores GA4's "Google organic search traffic: Landing page + query
// string" report: a window table holding GA4's own Total, its page rows, and
// four defaulted sync-state columns.

const SEARCH_LANDING_VERSION = 176
const SEARCH_LANDING_180_VERSION = 212
const NOW = '2026-10-08T15:00:00.000Z'

function tempDb(versions = MIGRATION_VERSIONS): DatabaseClient {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ga-search-landing-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  migrate(db, versions)
  return db
}

function columns(db: DatabaseClient, table: string) {
  return db.all(sql.raw(`PRAGMA table_info('${table}')`)) as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
}

function indexNames(db: DatabaseClient, table: string): string[] {
  return (db.all(sql.raw(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}' AND name NOT LIKE 'sqlite_%'`)) as Array<{ name: string }>)
    .map(row => row.name)
    .sort()
}

function windowRow(projectId: string, overrides: Partial<typeof gaSearchLandingWindows.$inferInsert> = {}): typeof gaSearchLandingWindows.$inferInsert {
  return {
    id: crypto.randomUUID(),
    projectId,
    propertyId: '123456',
    windowKey: '28d',
    periodStart: '2026-09-10',
    periodEnd: '2026-10-07',
    timeZone: 'America/Los_Angeles',
    totalClicks: 837,
    totalImpressions: 41422,
    totalCtr: 0.020206653469170971,
    totalAveragePosition: 7.31567765921491,
    totalActiveUsers: 1093,
    reportRowCount: 87,
    rowsCapped: false,
    syncedAt: NOW,
    createdAt: NOW,
    ...overrides,
  }
}

function pageRow(projectId: string, overrides: Partial<typeof gaSearchLandingPages.$inferInsert> = {}): typeof gaSearchLandingPages.$inferInsert {
  return {
    id: crypto.randomUUID(),
    projectId,
    windowKey: '28d',
    landingPage: '/pricing?utm_source=newsletter',
    clicks: 57,
    impressions: 3120,
    ctr: 0.01826923076923077,
    averagePosition: 5.1301282051282051,
    activeUsers: 71,
    syncedAt: NOW,
    createdAt: NOW,
    ...overrides,
  }
}

function seedProject(db: DatabaseClient, id = 'project_1') {
  db.insert(projects).values({
    id,
    name: id,
    displayName: 'Example',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
}

describe('GA search landing pages (v176)', () => {
  it('upgrades and replays 180-day support without changing stored figures or sync provenance', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version < SEARCH_LANDING_180_VERSION))
    insertLegacyProject(db, { id: 'legacy', createdAt: NOW })
    insertLegacyRow(db, 'runs', {
      id: 'old-sync', project_id: 'legacy', kind: RunKinds['ga-sync'],
      status: RunStatuses.completed, trigger: RunTriggers.manual, created_at: NOW,
    })
    for (const [index, windowKey] of ['7d', '28d', '90d'].entries()) {
      insertLegacyRow(db, 'ga_search_landing_windows', {
        id: `window-${windowKey}`, project_id: 'legacy', property_id: '123456', window_key: windowKey,
        period_start: '2026-07-10', period_end: '2026-10-07', time_zone: 'America/Los_Angeles',
        total_clicks: 837 + index, total_impressions: 41422 + index, total_ctr: 0.020206653469170971,
        total_average_position: 7.31567765921491, total_active_users: 1093 + index, report_row_count: 87,
        rows_capped: 1, subject_to_thresholding: index === 0, data_loss_from_other_row: index === 1,
        synced_at: NOW, sync_run_id: 'old-sync', created_at: NOW,
      })
      insertLegacyRow(db, 'ga_search_landing_pages', {
        id: `page-${windowKey}`, project_id: 'legacy', window_key: windowKey,
        landing_page: '/members?ref=newsletter', clicks: 0, impressions: 0, ctr: null,
        average_position: null, active_users: 3 + index,
        synced_at: NOW, sync_run_id: 'old-sync', created_at: NOW,
      })
    }
    const oldWindows = db.all<Record<string, unknown>>(sql`SELECT * FROM ga_search_landing_windows ORDER BY id`)
    const oldPages = db.all(sql`SELECT * FROM ga_search_landing_pages ORDER BY id`)
    const windowIndexes = indexNames(db, 'ga_search_landing_windows')
    const pageIndexes = indexNames(db, 'ga_search_landing_pages')
    const migration = MIGRATION_VERSIONS.find(mv => mv.version === SEARCH_LANDING_180_VERSION)!

    migrate(db, [migration])

    expect(db.all(sql`SELECT * FROM ga_search_landing_windows ORDER BY id`))
      .toEqual(oldWindows.map(row => ({ ...row, report_definition: null })))
    expect(db.all(sql`SELECT * FROM ga_search_landing_pages ORDER BY id`)).toEqual(oldPages)
    expect(columns(db, 'ga_search_landing_windows').find(column => column.name === 'report_definition'))
      .toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
    expect(indexNames(db, 'ga_search_landing_windows')).toEqual(windowIndexes)
    expect(indexNames(db, 'ga_search_landing_pages')).toEqual(pageIndexes)

    db.insert(gaSearchLandingWindows).values(windowRow('legacy', {
      id: 'new-window', windowKey: '180d', periodStart: '2026-04-11', reportDefinition: 'search-landing-v1',
    })).run()
    db.insert(gaSearchLandingPages).values(pageRow('legacy', { id: 'new-page', windowKey: '180d' })).run()
    expect(() => db.insert(gaSearchLandingWindows).values(windowRow('legacy', { windowKey: '180d' })).run())
      .toThrow(/UNIQUE/)
    expect(() => db.insert(gaSearchLandingPages).values(pageRow('legacy', { windowKey: '180d' })).run())
      .toThrow(/UNIQUE/)
    const currentWindows = db.select().from(gaSearchLandingWindows).orderBy(gaSearchLandingWindows.id).all()
    const currentPages = db.select().from(gaSearchLandingPages).orderBy(gaSearchLandingPages.id).all()

    // A full replay retains even snapshots written under the new definition.
    db.run(sql`DELETE FROM _migrations WHERE version = ${SEARCH_LANDING_180_VERSION}`)
    migrate(db, [migration])
    expect(db.select().from(gaSearchLandingWindows).orderBy(gaSearchLandingWindows.id).all()).toEqual(currentWindows)
    expect(db.select().from(gaSearchLandingPages).orderBy(gaSearchLandingPages.id).all()).toEqual(currentPages)
    expect(db.all(sql`PRAGMA foreign_key_check`)).toEqual([])

    // Rebuilding must keep both original run cascades, without deleting the new window.
    db.delete(runs).where(eq(runs.id, 'old-sync')).run()
    expect(db.select({ id: gaSearchLandingWindows.id }).from(gaSearchLandingWindows).all()).toEqual([{ id: 'new-window' }])
    expect(db.select({ id: gaSearchLandingPages.id }).from(gaSearchLandingPages).all()).toEqual([{ id: 'new-page' }])
  })

  it('upgrades a v175 sync-state row to never-synced and adds both tables with their indexes', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version < SEARCH_LANDING_VERSION))
    insertLegacyProject(db, { id: 'legacy', createdAt: NOW })
    insertLegacyRow(db, 'ga_measurement_sync_state', {
      project_id: 'legacy',
      acquisition_status: 'ready',
      acquisition_synced_at: NOW,
      lead_status: 'error',
      lead_error: 'quota',
      updated_at: NOW,
    })
    expect(columns(db, 'ga_measurement_sync_state').map(c => c.name)).not.toContain('search_landing_status')

    migrate(db)

    expect(MIGRATION_VERSIONS.find(mv => mv.version === SEARCH_LANDING_VERSION)?.name).toBe('ga-search-landing-pages')
    expect(columns(db, 'ga_measurement_sync_state').find(c => c.name === 'search_landing_status'))
      .toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: `'never-synced'` })
    const state = db.select().from(gaMeasurementSyncStates).where(eq(gaMeasurementSyncStates.projectId, 'legacy')).get()
    expect(state).toMatchObject({
      acquisitionStatus: 'ready',
      leadStatus: 'error',
      leadError: 'quota',
      searchLandingStatus: 'never-synced',
      searchLandingError: null,
      searchLandingSyncedAt: null,
      searchLandingAttemptedAt: null,
    })

    // An older writer that names none of the new columns still upserts.
    insertLegacyProject(db, { id: 'older-writer', createdAt: NOW })
    insertLegacyRow(db, 'ga_measurement_sync_state', { project_id: 'older-writer', updated_at: NOW })
    expect(db.select().from(gaMeasurementSyncStates).where(eq(gaMeasurementSyncStates.projectId, 'older-writer')).get()?.searchLandingStatus)
      .toBe('never-synced')

    // The snapshot names the GA4 property it was read from.
    expect(columns(db, 'ga_search_landing_windows').find(c => c.name === 'property_id'))
      .toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(indexNames(db, 'ga_search_landing_windows')).toEqual([
      'idx_ga_search_landing_windows_project_window',
      'idx_ga_search_landing_windows_run',
    ])
    expect(indexNames(db, 'ga_search_landing_pages')).toEqual([
      'idx_ga_search_landing_pages_grain',
      'idx_ga_search_landing_pages_order',
      'idx_ga_search_landing_pages_run',
    ])
  })

  it('is idempotent when the version runs again', () => {
    const db = tempDb()
    const migration = MIGRATION_VERSIONS.find(mv => mv.version === SEARCH_LANDING_VERSION)!
    for (const statement of migration.statements.filter(s => !s.startsWith('ALTER TABLE'))) {
      expect(() => db.run(sql.raw(statement))).not.toThrow()
    }
  })

  it('round-trips a window with GA4 ratios and native booleans, and a page row with null ratios', () => {
    const db = tempDb()
    seedProject(db)
    db.insert(gaSearchLandingWindows).values(windowRow('project_1', { rowsCapped: true, subjectToThresholding: true })).run()
    db.insert(gaSearchLandingPages).values(pageRow('project_1', { landingPage: '/members', clicks: 0, impressions: 0, ctr: null, averagePosition: null, activeUsers: 3 })).run()

    expect(db.select().from(gaSearchLandingWindows).get()).toMatchObject({
      propertyId: '123456',
      windowKey: '28d',
      totalCtr: 0.020206653469170971,
      totalAveragePosition: 7.31567765921491,
      rowsCapped: true,
      subjectToThresholding: true,
      dataLossFromOtherRow: false,
    })
    expect(db.select().from(gaSearchLandingPages).get()).toMatchObject({ landingPage: '/members', ctr: null, averagePosition: null, activeUsers: 3 })
  })

  it('rejects an unknown window, an unknown status, a ratio outside 0..1 and negative counts', () => {
    const db = tempDb()
    seedProject(db)

    expect(() => db.insert(gaSearchLandingWindows).values(windowRow('project_1', { windowKey: '30d' as '28d' })).run()).toThrow(/CHECK/)
    expect(() => db.insert(gaSearchLandingPages).values(pageRow('project_1', { windowKey: '30d' as '28d' })).run()).toThrow(/CHECK/)
    expect(() => db.insert(gaSearchLandingWindows).values(windowRow('project_1', { totalCtr: 1.2 })).run()).toThrow(/CHECK/)
    expect(() => db.insert(gaSearchLandingPages).values(pageRow('project_1', { ctr: -0.1 })).run()).toThrow(/CHECK/)
    expect(() => db.insert(gaSearchLandingWindows).values(windowRow('project_1', { totalActiveUsers: -1 })).run()).toThrow(/CHECK/)
    expect(() => db.insert(gaSearchLandingPages).values(pageRow('project_1', { clicks: -1 })).run()).toThrow(/CHECK/)
    expect(() => db.insert(gaMeasurementSyncStates).values({
      projectId: 'project_1',
      searchLandingStatus: 'stale' as 'ready',
      updatedAt: NOW,
    }).run()).toThrow(/CHECK/)

    db.insert(gaMeasurementSyncStates).values({ projectId: 'project_1', searchLandingStatus: 'unavailable', searchLandingError: 'not linked', updatedAt: NOW }).run()
    expect(db.select().from(gaMeasurementSyncStates).get()?.searchLandingStatus).toBe('unavailable')
  })

  it('keeps one window per project and one row per page per window', () => {
    const db = tempDb()
    seedProject(db)
    db.insert(gaSearchLandingWindows).values(windowRow('project_1')).run()
    expect(() => db.insert(gaSearchLandingWindows).values(windowRow('project_1')).run()).toThrow(/UNIQUE/)
    db.insert(gaSearchLandingWindows).values(windowRow('project_1', { windowKey: '7d' })).run()

    db.insert(gaSearchLandingPages).values(pageRow('project_1')).run()
    expect(() => db.insert(gaSearchLandingPages).values(pageRow('project_1')).run()).toThrow(/UNIQUE/)
    // The raw landing page is the grain: a different query string is a different row.
    db.insert(gaSearchLandingPages).values(pageRow('project_1', { landingPage: '/pricing' })).run()
    db.insert(gaSearchLandingPages).values(pageRow('project_1', { windowKey: '90d' })).run()
    expect(db.select().from(gaSearchLandingPages).all()).toHaveLength(3)
  })

  it('cascades with the project', () => {
    const db = tempDb()
    seedProject(db)
    db.insert(gaSearchLandingWindows).values(windowRow('project_1')).run()
    db.insert(gaSearchLandingPages).values(pageRow('project_1')).run()

    db.delete(projects).where(eq(projects.id, 'project_1')).run()

    expect(db.select().from(gaSearchLandingWindows).all()).toEqual([])
    expect(db.select().from(gaSearchLandingPages).all()).toEqual([])
  })
})
