import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, gaAiReferrals, gaTrafficSnapshots, migrate, projects } from '@ainyc/canonry-db'
import { backfillAiReferralPaths, backfillNormalizedPaths } from '../src/commands/backfill.js'

const NOW = '2026-10-03T12:00:00.000Z'
const ROWS = 300
const PAGE_SIZE = 64

const TABLES = [
  { table: 'ga_traffic_snapshots', repair: backfillNormalizedPaths },
  { table: 'ga_ai_referrals', repair: backfillAiReferralPaths },
] as const

describe('stored path repair query plans', () => {
  let directory: string
  let db: ReturnType<typeof createClient>

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-path-repair-plan-'))
    db = createClient(path.join(directory, 'canonry.db'))
    migrate(db)
    for (const id of ['one', 'two']) {
      db.insert(projects).values({
        id, name: `project-${id}`, displayName: id, canonicalDomain: `${id}.example`,
        country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
      }).run()
    }
    db.transaction((tx) => {
      for (let index = 0; index < ROWS; index++) {
        const common = {
          id: `row_${String(index).padStart(4, '0')}`, projectId: index % 2 === 0 ? 'one' : 'two', date: '2026-10-01',
          landingPage: `/page-${index}/`, landingPageNormalized: null, sessions: 1, users: 1, syncedAt: NOW,
        }
        tx.insert(gaTrafficSnapshots).values({ ...common, organicSessions: 0 }).run()
        tx.insert(gaAiReferrals).values({ ...common, source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session' }).run()
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.$client.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  function planOf(query: string): string {
    const parameters = Array.from({ length: query.split('?').length - 1 }, () => null)
    return db.$client.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...parameters)
      .map(row => (row as { detail: string }).detail).join(' | ')
  }

  it.each(TABLES)('pages $table over its id index without sorting, scoped or not', async ({ table, repair }) => {
    const prepare = vi.spyOn(db.$client, 'prepare')

    // Scoped first, so the unscoped pass still has the other project's rows to repair.
    expect(await repair(db, { projectId: 'one', pageSize: PAGE_SIZE })).toEqual({ examined: ROWS / 2, updated: ROWS / 2, unchanged: 0 })
    const scoped = prepare.mock.calls.map(([query]) => query)
    prepare.mockClear()
    expect(await repair(db, { pageSize: PAGE_SIZE })).toEqual({ examined: ROWS, updated: ROWS / 2, unchanged: ROWS / 2 })
    const unscoped = prepare.mock.calls.map(([query]) => query)
    prepare.mockRestore()

    for (const queries of [scoped, unscoped]) {
      const reads = [...new Set(queries.filter(query => query.startsWith('select') && query.includes(`from "${table}"`)))]
      // The pass's upper bound, its first page and the cursor pages after it.
      expect(reads).toHaveLength(3)
      for (const read of reads) {
        const plan = planOf(read)
        // A plain project filter makes SQLite pick a project index and sort
        // that project's rows for every page; the pass walks ids instead.
        expect(plan).toContain(`INDEX sqlite_autoindex_${table}_1`)
        expect(plan).not.toContain('TEMP B-TREE')
      }
    }
    const rows = table === 'ga_traffic_snapshots'
      ? db.select({ value: gaTrafficSnapshots.landingPageNormalized }).from(gaTrafficSnapshots).where(eq(gaTrafficSnapshots.id, 'row_0299')).all()
      : db.select({ value: gaAiReferrals.landingPageNormalized }).from(gaAiReferrals).where(eq(gaAiReferrals.id, 'row_0299')).all()
    expect(rows).toEqual([{ value: '/page-299' }])
  })
})
