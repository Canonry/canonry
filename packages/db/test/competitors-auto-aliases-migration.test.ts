import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import { competitors, createClient, migrate, MIGRATION_VERSIONS, projects, type DatabaseClient } from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

// v171 adds answer-derived `competitors.auto_aliases` and operator
// `competitors.blocked_aliases`. Both are defaulted, so every competitor
// stored before reads as having none, curated aliases survive the upgrade,
// and an older writer that omits the columns still inserts. It also adds the
// per-project detection mode `projects.competitor_auto_aliases`, defaulted to
// `preview` so no project starts storing detected names on upgrade, and the
// nullable `projects.answer_fields_recompute` mark of an owed recompute.

const AUTO_ALIASES_VERSION = 171
const NOW = '2026-10-06T00:00:00.000Z'

function tempDb(versions = MIGRATION_VERSIONS): DatabaseClient {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-competitor-auto-aliases-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  migrate(db, versions)
  return db
}

function columns(db: DatabaseClient) {
  return (db.all(sql.raw(`PRAGMA table_info('competitors')`)) as Array<{ name: string; notnull: number; dflt_value: string | null }>)
    .filter(entry => entry.name === 'auto_aliases' || entry.name === 'blocked_aliases')
    .map(({ name, notnull, dflt_value }) => ({ name, notnull, dflt_value }))
}

function projectColumns(db: DatabaseClient) {
  return (db.all(sql.raw(`PRAGMA table_info('projects')`)) as Array<{ name: string; notnull: number; dflt_value: string | null }>)
    .filter(entry => entry.name === 'competitor_auto_aliases' || entry.name === 'answer_fields_recompute')
    .map(({ name, notnull, dflt_value }) => ({ name, notnull, dflt_value }))
}

describe('competitors auto aliases (v171)', () => {
  it('is registered under its name', () => {
    expect(MIGRATION_VERSIONS.find(mv => mv.version === AUTO_ALIASES_VERSION)?.name).toBe('competitors-auto-aliases')
  })

  it('upgrades a v170 competitor to empty defaults and keeps its curated aliases', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version < AUTO_ALIASES_VERSION))
    expect(columns(db)).toEqual([])
    insertLegacyProject(db, { id: 'legacy-project', createdAt: NOW })
    insertLegacyRow(db, 'competitors', {
      id: 'legacy-competitor',
      project_id: 'legacy-project',
      domain: 'spoketuneworks.example',
      provenance: 'cli',
      aliases: JSON.stringify(['TuneSpoke']),
      created_at: NOW,
    })

    migrate(db)

    expect(columns(db)).toEqual([
      { name: 'auto_aliases', notnull: 1, dflt_value: "'[]'" },
      { name: 'blocked_aliases', notnull: 1, dflt_value: "'[]'" },
    ])
    expect(db.select({
      aliases: competitors.aliases,
      autoAliases: competitors.autoAliases,
      blockedAliases: competitors.blockedAliases,
    }).from(competitors).where(eq(competitors.id, 'legacy-competitor')).get())
      .toEqual({ aliases: ['TuneSpoke'], autoAliases: [], blockedAliases: [] })
  })

  it('upgrades every existing project to preview with no recompute owed', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version < AUTO_ALIASES_VERSION))
    expect(projectColumns(db)).toEqual([])
    insertLegacyProject(db, { id: 'legacy-project', createdAt: NOW })

    migrate(db)

    expect(projectColumns(db)).toEqual([
      { name: 'competitor_auto_aliases', notnull: 1, dflt_value: "'preview'" },
      { name: 'answer_fields_recompute', notnull: 0, dflt_value: null },
    ])
    expect(db.select({ mode: projects.competitorAutoAliases, owed: projects.answerFieldsRecompute })
      .from(projects).where(eq(projects.id, 'legacy-project')).get())
      .toEqual({ mode: 'preview', owed: null })

    // An older writer that omits both columns still inserts, in preview.
    insertLegacyProject(db, { id: 'older-writer', createdAt: NOW })
    expect(db.select({ mode: projects.competitorAutoAliases }).from(projects).where(eq(projects.id, 'older-writer')).get())
      .toEqual({ mode: 'preview' })
  })

  it('lets an older writer that omits the columns insert, and round-trips evidence', () => {
    const db = tempDb()
    insertLegacyProject(db, { id: 'project-1', createdAt: NOW })
    insertLegacyRow(db, 'competitors', { id: 'old-writer', project_id: 'project-1', domain: 'qvx.example', created_at: NOW })
    const record = {
      name: 'QVX',
      directPairs: 3,
      cooccurrences: 1,
      namingAnswers: 4,
      precision: 0.75,
      runs: 2,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-10-01T00:00:00.000Z',
      addedAt: NOW,
    }
    db.update(competitors).set({ autoAliases: [record], blockedAliases: ['Qvx Tours'] }).where(eq(competitors.id, 'old-writer')).run()
    expect(db.select({ autoAliases: competitors.autoAliases, blockedAliases: competitors.blockedAliases })
      .from(competitors).where(eq(competitors.id, 'old-writer')).get())
      .toEqual({ autoAliases: [record], blockedAliases: ['Qvx Tours'] })
  })

  it('is idempotent when the statements run again', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version <= AUTO_ALIASES_VERSION))
    insertLegacyProject(db, { id: 'project-1', createdAt: NOW })
    insertLegacyRow(db, 'competitors', { id: 'c1', project_id: 'project-1', domain: 'qvx.example', created_at: NOW })
    db.update(competitors).set({ blockedAliases: ['QVX'] }).where(eq(competitors.id, 'c1')).run()
    db.$client.prepare('DELETE FROM _migrations WHERE version = ?').run(AUTO_ALIASES_VERSION)
    expect(() => migrate(db, MIGRATION_VERSIONS.filter(mv => mv.version === AUTO_ALIASES_VERSION))).not.toThrow()
    expect(() => migrate(db)).not.toThrow()
    expect(db.select({ blockedAliases: competitors.blockedAliases }).from(competitors).where(eq(competitors.id, 'c1')).get())
      .toEqual({ blockedAliases: ['QVX'] })
    expect(db.$client.prepare('SELECT COUNT(*) AS count FROM _migrations WHERE version = ?').get(AUTO_ALIASES_VERSION))
      .toEqual({ count: 1 })
  })
})
