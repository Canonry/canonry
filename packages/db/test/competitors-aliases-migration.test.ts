import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import { competitors, createClient, migrate, MIGRATION_VERSIONS, type DatabaseClient } from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

// v168 adds operator-curated `competitors.aliases`. It is defaulted, so every
// competitor stored before it reads as having no curated alias, and an older
// writer that omits the column still inserts.

const ALIASES_VERSION = 168
const NOW = '2026-10-05T00:00:00.000Z'

function tempDb(versions = MIGRATION_VERSIONS): DatabaseClient {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-competitor-aliases-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  migrate(db, versions)
  return db
}

function column(db: DatabaseClient) {
  return (db.all(sql.raw(`PRAGMA table_info('competitors')`)) as Array<{ name: string; notnull: number; dflt_value: string | null }>)
    .find(entry => entry.name === 'aliases')
}

describe('competitors aliases (v168)', () => {
  it('is registered under its name', () => {
    expect(MIGRATION_VERSIONS.find(mv => mv.version === ALIASES_VERSION)?.name).toBe('competitors-aliases')
  })

  it('upgrades a v167 competitor to the empty default', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version < ALIASES_VERSION))
    expect(column(db)).toBeUndefined()
    insertLegacyProject(db, { id: 'legacy-project', createdAt: NOW })
    insertLegacyRow(db, 'competitors', {
      id: 'legacy-competitor',
      project_id: 'legacy-project',
      domain: 'sealfoamworks.example',
      provenance: 'cli',
      created_at: NOW,
    })

    migrate(db)

    expect(column(db)).toMatchObject({ notnull: 1, dflt_value: "'[]'" })
    expect(db.select({ domain: competitors.domain, aliases: competitors.aliases })
      .from(competitors).where(eq(competitors.id, 'legacy-competitor')).get())
      .toEqual({ domain: 'sealfoamworks.example', aliases: [] })
  })

  it('lets an older writer that omits the column insert', () => {
    const db = tempDb()
    insertLegacyProject(db, { id: 'project-1', createdAt: NOW })
    insertLegacyRow(db, 'competitors', {
      id: 'old-writer',
      project_id: 'project-1',
      domain: 'qvx.example',
      created_at: NOW,
    })
    expect(db.select({ aliases: competitors.aliases }).from(competitors).where(eq(competitors.id, 'old-writer')).get())
      .toEqual({ aliases: [] })
  })

  it('is idempotent when the statement runs again', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version <= ALIASES_VERSION))
    insertLegacyProject(db, { id: 'project-1', createdAt: NOW })
    insertLegacyRow(db, 'competitors', { id: 'c1', project_id: 'project-1', domain: 'qvx.example', created_at: NOW })
    db.update(competitors).set({ aliases: ['QVX'] }).where(eq(competitors.id, 'c1')).run()
    const migration = MIGRATION_VERSIONS.filter(mv => mv.version === ALIASES_VERSION)
    // A retry after a crash between the ALTER and the `_migrations` row re-runs
    // the statement; the runner swallows the duplicate-column error.
    db.$client.prepare('DELETE FROM _migrations WHERE version = ?').run(ALIASES_VERSION)
    expect(() => migrate(db, migration)).not.toThrow()
    expect(() => migrate(db)).not.toThrow()
    expect(db.select({ aliases: competitors.aliases }).from(competitors).where(eq(competitors.id, 'c1')).get())
      .toEqual({ aliases: ['QVX'] })
    expect(db.$client.prepare('SELECT COUNT(*) AS count FROM _migrations WHERE version = ?').get(ALIASES_VERSION))
      .toEqual({ count: 1 })
  })
})
