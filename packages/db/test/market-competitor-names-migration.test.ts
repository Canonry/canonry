import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createClient, marketCompetitorNames, migrate, MIGRATION_VERSIONS, projects, type DatabaseClient } from '../src/index.js'
import { insertLegacyProject } from './legacy-rows.js'

// v172 adds `market_competitor_names`: answer-derived names of a competitor an
// Advanced market pins without a project competitors row. One row per project
// and registrable domain, removed with its project.

const MARKET_NAMES_VERSION = 172
const NOW = '2026-10-06T00:00:00.000Z'

function tempDb(versions = MIGRATION_VERSIONS): DatabaseClient {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-market-competitor-names-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  migrate(db, versions)
  return db
}

describe('market competitor names (v172)', () => {
  it('is registered under its name and upgrades a v171 database with an empty table', () => {
    expect(MIGRATION_VERSIONS.find(mv => mv.version === MARKET_NAMES_VERSION)?.name).toBe('market-competitor-names')
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version < MARKET_NAMES_VERSION))
    insertLegacyProject(db, { id: 'legacy-project', createdAt: NOW })
    expect(db.$client.prepare(`SELECT name FROM sqlite_master WHERE name = 'market_competitor_names'`).get()).toBeUndefined()
    migrate(db)
    expect(db.select().from(marketCompetitorNames).all()).toEqual([])
  })

  it('defaults both name lists, keeps one row per project and domain, and goes with its project', () => {
    const db = tempDb()
    insertLegacyProject(db, { id: 'project-1', createdAt: NOW })
    db.insert(marketCompetitorNames).values({ id: 'names-1', projectId: 'project-1', domain: 'spoketuneworks.example', createdAt: NOW, updatedAt: NOW }).run()
    expect(db.select({ autoAliases: marketCompetitorNames.autoAliases, blockedAliases: marketCompetitorNames.blockedAliases })
      .from(marketCompetitorNames).get()).toEqual({ autoAliases: [], blockedAliases: [] })
    expect(() => db.insert(marketCompetitorNames).values({ id: 'names-2', projectId: 'project-1', domain: 'spoketuneworks.example', createdAt: NOW, updatedAt: NOW }).run())
      .toThrow(/UNIQUE/)

    db.$client.pragma('foreign_keys = ON')
    db.delete(projects).where(eq(projects.id, 'project-1')).run()
    expect(db.select().from(marketCompetitorNames).all()).toEqual([])
  })

  it('is idempotent when the statements run again', () => {
    const db = tempDb()
    db.$client.prepare('DELETE FROM _migrations WHERE version = ?').run(MARKET_NAMES_VERSION)
    expect(() => migrate(db)).not.toThrow()
    expect(db.$client.prepare('SELECT COUNT(*) AS count FROM _migrations WHERE version = ?').get(MARKET_NAMES_VERSION))
      .toEqual({ count: 1 })
  })
})
