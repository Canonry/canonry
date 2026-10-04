import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as contracts from '@ainyc/canonry-contracts'
import {
  createClient,
  gaTrafficSnapshots,
  migrate,
  projects,
} from '@ainyc/canonry-db'
import { eq, sql } from 'drizzle-orm'
import { backfillNormalizedPaths, backfillNormalizedPathsCommand } from '../src/commands/backfill.js'

describe('backfill normalized-paths', () => {
  let tmpDir: string
  let configDir: string
  let dbPath: string
  let db: ReturnType<typeof createClient>
  let originalConfigDir: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-backfill-paths-'))
    configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    dbPath = path.join(tmpDir, 'canonry.db')
    db = createClient(dbPath)
    migrate(db)

    originalConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = configDir
    fs.writeFileSync(
      path.join(configDir, 'config.yaml'),
      JSON.stringify({
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: 'cnry_test_key',
        providers: {},
      }),
      'utf-8',
    )

    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'proj_1',
      name: 'test-project',
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalConfigDir === undefined) {
      delete process.env.CANONRY_CONFIG_DIR
    } else {
      process.env.CANONRY_CONFIG_DIR = originalConfigDir
    }
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function insertSnapshot(opts: {
    id: string
    landingPage: string
    landingPageNormalized?: string | null
  }) {
    const now = new Date().toISOString()
    db.insert(gaTrafficSnapshots).values({
      id: opts.id,
      projectId: 'proj_1',
      date: '2026-04-29',
      landingPage: opts.landingPage,
      landingPageNormalized:
        opts.landingPageNormalized === undefined ? null : opts.landingPageNormalized,
      sessions: 1,
      organicSessions: 0,
      users: 1,
      syncedAt: now,
    }).run()
  }

  function readNormalized(id: string): string | null | undefined {
    const [row] = db
      .select({ landingPageNormalized: gaTrafficSnapshots.landingPageNormalized })
      .from(gaTrafficSnapshots)
      .where(eq(gaTrafficSnapshots.id, id))
      .all()
    return row?.landingPageNormalized
  }

  it('populates landing_page_normalized for rows where it is null', async () => {
    insertSnapshot({ id: 's1', landingPage: '/?fbclid=foo' })
    insertSnapshot({ id: 's2', landingPage: '/about/' })
    insertSnapshot({ id: 's3', landingPage: '/' })
    insertSnapshot({ id: 's4', landingPage: '(not set)' })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await backfillNormalizedPathsCommand({ format: 'json' })
    logSpy.mockRestore()

    expect(readNormalized('s1')).toBe('/')
    expect(readNormalized('s2')).toBe('/about')
    expect(readNormalized('s3')).toBe('/')
    expect(readNormalized('s4')).toBeNull() // (not set) normalizes to null
  })

  it('repairs stale normalized values and fills missing ones', async () => {
    insertSnapshot({ id: 's_stale', landingPage: '/about/', landingPageNormalized: '/sentinel' })
    insertSnapshot({ id: 's_null', landingPage: '/about/' })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await backfillNormalizedPathsCommand({ format: 'json' })
    logSpy.mockRestore()

    expect(readNormalized('s_stale')).toBe('/about')
    expect(readNormalized('s_null')).toBe('/about')
  })

  it('is idempotent — second run touches nothing', async () => {
    insertSnapshot({ id: 's1', landingPage: '/about/' })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await backfillNormalizedPathsCommand({ format: 'json' })
    const firstCall = logSpy.mock.calls.at(-1)?.[0] as string
    const firstResult = JSON.parse(firstCall)
    expect(firstResult.updated).toBe(1)

    logSpy.mockClear()
    await backfillNormalizedPathsCommand({ format: 'json' })
    const secondCall = logSpy.mock.calls.at(-1)?.[0] as string
    const secondResult = JSON.parse(secondCall)
    expect(secondResult.updated).toBe(0)
    expect(secondResult.examined).toBe(1)

    logSpy.mockRestore()
  })

  it('scopes to a project when --project flag is set', async () => {
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'proj_2',
      name: 'other-project',
      displayName: 'Other',
      canonicalDomain: 'other.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()
    db.insert(gaTrafficSnapshots).values({
      id: 's_other',
      projectId: 'proj_2',
      date: '2026-04-29',
      landingPage: '/?fbclid=skip',
      sessions: 1,
      organicSessions: 0,
      users: 1,
      syncedAt: now,
    }).run()
    insertSnapshot({ id: 's_in_scope', landingPage: '/?fbclid=touch' })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await backfillNormalizedPathsCommand({ project: 'test-project', format: 'json' })
    logSpy.mockRestore()

    expect(readNormalized('s_in_scope')).toBe('/')
    expect(readNormalized('s_other')).toBeNull()
  })

  it('bounds pages and commits, yields to other work, and stops at the initial final id', async () => {
    db.transaction(() => {
      for (let index = 0; index < 400; index++) {
        insertSnapshot({ id: `s_${String(index).padStart(4, '0')}`, landingPage: `/page-${index}/` })
      }
    })
    const prepare = vi.spyOn(db.$client, 'prepare')
    let committedAtYield = 0
    const otherWork = new Promise<void>(resolve => {
      setImmediate(() => {
        committedAtYield = db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM ga_traffic_snapshots WHERE landing_page_normalized IS NOT NULL`)!.count
        insertSnapshot({ id: 'z_arrived_during_backfill', landingPage: '/later/' })
        // Deleting a prior page must not shift the next page past an unread row.
        db.delete(gaTrafficSnapshots).where(eq(gaTrafficSnapshots.id, 's_0000')).run()
        resolve()
      })
    })

    const result = await backfillNormalizedPaths(db)
    await otherWork

    expect(committedAtYield).toBeGreaterThan(0)
    expect(committedAtYield).toBeLessThanOrEqual(128)
    expect(result).toEqual({ examined: 400, updated: 400, unchanged: 0 })
    expect(readNormalized('s_0399')).toBe('/page-399')
    expect(readNormalized('z_arrived_during_backfill')).toBeNull()
    const pageQueries = prepare.mock.calls.map(([query]) => query)
      .filter(query => query.startsWith('select') && query.includes('"landing_page"'))
    expect(pageQueries.length).toBeGreaterThan(1)
    expect(pageQueries.every(query => query.includes(' limit ?'))).toBe(true)
    expect(pageQueries.every(query => !query.includes('offset'))).toBe(true)
  })

  it('normalizes outside transactions and does not overwrite concurrent source or normalized changes', async () => {
    insertSnapshot({ id: 'changed_path', landingPage: '/old-path/' })
    insertSnapshot({ id: 'changed_normalized', landingPage: '/old-normalized/' })
    insertSnapshot({ id: 'deleted', landingPage: '/deleted/' })
    insertSnapshot({ id: 'unchanged', landingPage: '/correct/', landingPageNormalized: '/correct' })
    insertSnapshot({ id: 'writable', landingPage: '/repair/', landingPageNormalized: '/stale' })
    const writer = createClient(dbPath)
    writer.$client.pragma('busy_timeout = 0')
    const normalize = contracts.normalizeUrlPath
    const transactionStates: boolean[] = []
    vi.spyOn(contracts, 'normalizeUrlPath').mockImplementation(value => {
      transactionStates.push(db.$client.inTransaction)
      if (value === '/old-path/') {
        writer.update(gaTrafficSnapshots).set({ landingPage: '/new-path/', landingPageNormalized: '/new-path' })
          .where(eq(gaTrafficSnapshots.id, 'changed_path')).run()
      } else if (value === '/old-normalized/') {
        writer.update(gaTrafficSnapshots).set({ landingPageNormalized: '/concurrent-repair' })
          .where(eq(gaTrafficSnapshots.id, 'changed_normalized')).run()
      } else if (value === '/deleted/') {
        writer.delete(gaTrafficSnapshots).where(eq(gaTrafficSnapshots.id, 'deleted')).run()
      }
      return normalize(value)
    })
    try {
      expect(await backfillNormalizedPaths(db)).toEqual({ examined: 5, updated: 1, unchanged: 4 })
      expect(transactionStates).toEqual([false, false, false, false, false])
      expect(readNormalized('changed_path')).toBe('/new-path')
      expect(readNormalized('changed_normalized')).toBe('/concurrent-repair')
      expect(readNormalized('deleted')).toBeUndefined()
      expect(readNormalized('writable')).toBe('/repair')
    } finally {
      writer.$client.close()
    }
  })

  it('skips write transactions for unchanged or unnormalizable pages', async () => {
    insertSnapshot({ id: 'canonical', landingPage: '/about/', landingPageNormalized: '/about' })
    insertSnapshot({ id: 'unknown', landingPage: '(not set)' })
    const transaction = vi.spyOn(db, 'transaction')

    expect(await backfillNormalizedPaths(db)).toEqual({ examined: 2, updated: 0, unchanged: 2 })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('rolls back a failed page and safely resumes after previously committed pages', async () => {
    db.transaction(() => {
      for (let index = 0; index < 300; index++) {
        insertSnapshot({ id: `s_${String(index).padStart(4, '0')}`, landingPage: `/page-${index}/` })
      }
    })
    db.run(sql`CREATE TRIGGER reject_backfill_page BEFORE UPDATE ON ga_traffic_snapshots
      WHEN NEW.id = 's_0150' BEGIN SELECT RAISE(ABORT, 'simulated page failure'); END`)

    await expect(backfillNormalizedPaths(db)).rejects.toThrow('simulated page failure')
    expect(db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM ga_traffic_snapshots WHERE landing_page_normalized IS NOT NULL`))
      .toEqual({ count: 128 })
    expect(readNormalized('s_0127')).toBe('/page-127')
    expect(readNormalized('s_0128')).toBeNull()
    db.run(sql`DROP TRIGGER reject_backfill_page`)

    expect(await backfillNormalizedPaths(db)).toEqual({ examined: 300, updated: 172, unchanged: 128 })
    expect(readNormalized('s_0299')).toBe('/page-299')
  })

  it('returns exact zero totals for an empty project', async () => {
    expect(await backfillNormalizedPaths(db, { projectId: 'proj_1' })).toEqual({ examined: 0, updated: 0, unchanged: 0 })
  })
})
