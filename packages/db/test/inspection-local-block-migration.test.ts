import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  bingUrlInspections,
  createClient,
  gscUrlInspections,
  migrate,
  MIGRATION_VERSIONS,
  type DatabaseClient,
} from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

// v225 adds `local_blocked` / `local_block_reason` (issue #357) to both
// sitemap inspection tables. Both columns are nullable with no default, so
// every inspection stored before it reads as unchecked, and an older writer
// that omits the columns still inserts.

const LOCAL_BLOCK_VERSION = 225
const NOW = '2026-10-05T00:00:00.000Z'

function tempDb(versions = MIGRATION_VERSIONS): DatabaseClient {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-inspection-local-block-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  migrate(db, versions)
  return db
}

function columns(db: DatabaseClient, table: string) {
  return (db.all(sql.raw(`PRAGMA table_info('${table}')`)) as Array<{ name: string; notnull: number; dflt_value: string | null }>)
    .filter((entry) => entry.name === 'local_blocked' || entry.name === 'local_block_reason')
}

describe('inspection local block (v225)', () => {
  it('is registered under its name', () => {
    expect(MIGRATION_VERSIONS.find((mv) => mv.version === LOCAL_BLOCK_VERSION)?.name).toBe('inspection-local-block')
  })

  it('upgrades v224 inspections on both tables to unchecked', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter((mv) => mv.version < LOCAL_BLOCK_VERSION))
    expect(columns(db, 'gsc_url_inspections')).toEqual([])
    expect(columns(db, 'bing_url_inspections')).toEqual([])
    insertLegacyProject(db, { id: 'legacy-project', createdAt: NOW })
    insertLegacyRow(db, 'gsc_url_inspections', {
      id: 'legacy-gsc',
      project_id: 'legacy-project',
      url: 'https://example.com/page',
      inspected_at: NOW,
      created_at: NOW,
    })
    insertLegacyRow(db, 'bing_url_inspections', {
      id: 'legacy-bing',
      project_id: 'legacy-project',
      url: 'https://example.com/page',
      inspected_at: NOW,
      created_at: NOW,
    })

    migrate(db)

    expect(columns(db, 'gsc_url_inspections')).toMatchObject([
      { name: 'local_blocked', notnull: 0, dflt_value: null },
      { name: 'local_block_reason', notnull: 0, dflt_value: null },
    ])
    expect(columns(db, 'bing_url_inspections')).toMatchObject([
      { name: 'local_blocked', notnull: 0, dflt_value: null },
      { name: 'local_block_reason', notnull: 0, dflt_value: null },
    ])
    expect(db.select({ localBlocked: gscUrlInspections.localBlocked, localBlockReason: gscUrlInspections.localBlockReason })
      .from(gscUrlInspections).where(eq(gscUrlInspections.id, 'legacy-gsc')).get())
      .toEqual({ localBlocked: null, localBlockReason: null })
    expect(db.select({ localBlocked: bingUrlInspections.localBlocked, localBlockReason: bingUrlInspections.localBlockReason })
      .from(bingUrlInspections).where(eq(bingUrlInspections.id, 'legacy-bing')).get())
      .toEqual({ localBlocked: null, localBlockReason: null })
  })

  it('lets an older writer that omits the columns insert', () => {
    const db = tempDb()
    insertLegacyProject(db, { id: 'project-1', createdAt: NOW })
    insertLegacyRow(db, 'gsc_url_inspections', {
      id: 'old-writer',
      project_id: 'project-1',
      url: 'https://example.com/page',
      inspected_at: NOW,
      created_at: NOW,
    })
    expect(db.select({ localBlocked: gscUrlInspections.localBlocked, localBlockReason: gscUrlInspections.localBlockReason })
      .from(gscUrlInspections).where(eq(gscUrlInspections.id, 'old-writer')).get())
      .toEqual({ localBlocked: null, localBlockReason: null })
  })

  it('is idempotent when the statement runs again', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter((mv) => mv.version <= LOCAL_BLOCK_VERSION))
    insertLegacyProject(db, { id: 'project-1', createdAt: NOW })
    insertLegacyRow(db, 'bing_url_inspections', {
      id: 'b1',
      project_id: 'project-1',
      url: 'https://example.com/page',
      inspected_at: NOW,
      created_at: NOW,
    })
    db.update(bingUrlInspections)
      .set({ localBlocked: true, localBlockReason: 'robots-disallow' })
      .where(eq(bingUrlInspections.id, 'b1')).run()
    const migration = MIGRATION_VERSIONS.filter((mv) => mv.version === LOCAL_BLOCK_VERSION)
    // A retry after a crash between the ALTER and the `_migrations` row re-runs
    // the statement; the runner swallows the duplicate-column error.
    db.$client.prepare('DELETE FROM _migrations WHERE version = ?').run(LOCAL_BLOCK_VERSION)
    expect(() => migrate(db, migration)).not.toThrow()
    expect(() => migrate(db)).not.toThrow()
    expect(db.select({ localBlocked: bingUrlInspections.localBlocked, localBlockReason: bingUrlInspections.localBlockReason })
      .from(bingUrlInspections).where(eq(bingUrlInspections.id, 'b1')).get())
      .toEqual({ localBlocked: true, localBlockReason: 'robots-disallow' })
    expect(db.$client.prepare('SELECT COUNT(*) AS count FROM _migrations WHERE version = ?').get(LOCAL_BLOCK_VERSION))
      .toEqual({ count: 1 })
  })
})
