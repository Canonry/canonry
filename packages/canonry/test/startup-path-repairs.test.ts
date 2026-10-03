import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as contracts from '@ainyc/canonry-contracts'
import {
  createClient, dataRepairCompletions, gaAiReferrals, gaTrafficSnapshots, migrate, projects,
} from '@ainyc/canonry-db'
import {
  backfillAiReferralPaths, backfillAiReferralPathsCommand,
  backfillNormalizedPaths, backfillNormalizedPathsCommand,
} from '../src/commands/backfill.js'
import { repairAiReferralPathsOnStartup, repairNormalizedPathsOnStartup } from '../src/startup-path-repairs.js'

const NOW = '2026-10-03T12:00:00.000Z'
const TRAFFIC_REPAIR = 'ga-traffic-paths'
const REFERRAL_REPAIR = 'ga-ai-referral-paths'
const REPAIRS = [
  { kind: 'traffic' as const, name: TRAFFIC_REPAIR, table: 'ga_traffic_snapshots', repair: repairNormalizedPathsOnStartup },
  { kind: 'referral' as const, name: REFERRAL_REPAIR, table: 'ga_ai_referrals', repair: repairAiReferralPathsOnStartup },
]

describe('durable startup path repairs', () => {
  let directory: string
  let databasePath: string
  let db: ReturnType<typeof createClient>
  let previousConfigDir: string | undefined

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-startup-paths-'))
    databasePath = path.join(directory, 'canonry.db')
    db = createClient(databasePath)
    migrate(db)
    const configDir = path.join(directory, 'config')
    fs.mkdirSync(configDir)
    fs.writeFileSync(path.join(configDir, 'config.yaml'), JSON.stringify({
      apiUrl: 'http://localhost:4100', database: databasePath, apiKey: 'cnry_test_key', providers: {},
    }))
    previousConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = configDir
    seedProject('one')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (previousConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = previousConfigDir
    db.$client.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  function seedProject(id: string): void {
    db.insert(projects).values({
      id, name: `project-${id}`, displayName: id, canonicalDomain: `${id}.example`,
      country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
    }).run()
  }

  function seed(kind: 'traffic' | 'referral', id: string, landingPage = '/about/', projectId = 'one'): void {
    const common = { id, projectId, date: '2026-10-01', landingPage, landingPageNormalized: null, sessions: 1, users: 1, syncedAt: NOW }
    if (kind === 'traffic') db.insert(gaTrafficSnapshots).values({ ...common, organicSessions: 0 }).run()
    else db.insert(gaAiReferrals).values({ ...common, source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session' }).run()
  }

  function normalized(kind: 'traffic' | 'referral', id: string): string | null | undefined {
    return kind === 'traffic'
      ? db.select({ value: gaTrafficSnapshots.landingPageNormalized }).from(gaTrafficSnapshots).where(eq(gaTrafficSnapshots.id, id)).get()?.value
      : db.select({ value: gaAiReferrals.landingPageNormalized }).from(gaAiReferrals).where(eq(gaAiReferrals.id, id)).get()?.value
  }

  function marker(name: string) {
    return db.select().from(dataRepairCompletions).where(eq(dataRepairCompletions.name, name)).get()
  }

  function reopen(): void {
    db.$client.close()
    db = createClient(databasePath)
  }

  it.each(REPAIRS)('persists $kind completion across reopen and skips equal-version data reads', async ({ kind, name, table, repair }) => {
    seed(kind, 'legacy')
    expect(await repair(db)).toEqual({ examined: 1, updated: 1, unchanged: 0 })
    expect(normalized(kind, 'legacy')).toBe('/about')
    const completed = marker(name)
    expect(completed).toMatchObject({ name, version: contracts.URL_PATH_NORMALIZATION_VERSION })
    expect(Number.isNaN(Date.parse(completed!.completedAt))).toBe(false)
    reopen()
    expect(marker(name)).toEqual(completed)
    const prepare = vi.spyOn(db.$client, 'prepare')
    const normalize = vi.spyOn(contracts, 'normalizeUrlPath')

    expect(await repair(db)).toBeNull()

    expect(normalize).not.toHaveBeenCalled()
    expect(prepare.mock.calls.map(([query]) => query).filter(query => query.includes(table))).toEqual([])
  })

  it('reruns an older completion version and records the current version only after success', async () => {
    seed('traffic', 'legacy')
    db.insert(dataRepairCompletions).values({ name: TRAFFIC_REPAIR, version: contracts.URL_PATH_NORMALIZATION_VERSION - 1, completedAt: NOW }).run()

    expect(await repairNormalizedPathsOnStartup(db)).toEqual({ examined: 1, updated: 1, unchanged: 0 })

    expect(normalized('traffic', 'legacy')).toBe('/about')
    expect(marker(TRAFFIC_REPAIR)?.version).toBe(contracts.URL_PATH_NORMALIZATION_VERSION)
  })

  it('does not downgrade a newer completion version or scan its source table', async () => {
    seed('traffic', 'legacy')
    const newer = { name: TRAFFIC_REPAIR, version: contracts.URL_PATH_NORMALIZATION_VERSION + 1, completedAt: NOW }
    db.insert(dataRepairCompletions).values(newer).run()
    const prepare = vi.spyOn(db.$client, 'prepare')

    expect(await repairNormalizedPathsOnStartup(db)).toBeNull()

    expect(prepare.mock.calls.map(([query]) => query).filter(query => query.includes('ga_traffic_snapshots'))).toEqual([])
    expect(marker(TRAFFIC_REPAIR)).toEqual(newer)
    expect(normalized('traffic', 'legacy')).toBeNull()
  })

  it('withholds completion after a late-page failure and safely retries after reopening', async () => {
    db.transaction(() => {
      for (let index = 0; index < 300; index++) seed('traffic', `row_${String(index).padStart(4, '0')}`, `/page-${index}/`)
    })
    db.run(sql`CREATE TRIGGER reject_startup_path_page BEFORE UPDATE ON ga_traffic_snapshots
      WHEN NEW.id = 'row_0150' BEGIN SELECT RAISE(ABORT, 'startup page failed'); END`)

    await expect(repairNormalizedPathsOnStartup(db)).rejects.toThrow('startup page failed')

    expect(marker(TRAFFIC_REPAIR)).toBeUndefined()
    expect(db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM ga_traffic_snapshots WHERE landing_page_normalized IS NOT NULL`))
      .toEqual({ count: 128 })
    reopen()
    expect(marker(TRAFFIC_REPAIR)).toBeUndefined()
    db.run(sql`DROP TRIGGER reject_startup_path_page`)

    expect(await repairNormalizedPathsOnStartup(db)).toEqual({ examined: 300, updated: 172, unchanged: 128 })
    expect(normalized('traffic', 'row_0299')).toBe('/page-299')
    expect(marker(TRAFFIC_REPAIR)?.version).toBe(contracts.URL_PATH_NORMALIZATION_VERSION)
  })

  it('retries after a failed completion write even when the data repair already committed', async () => {
    seed('traffic', 'legacy')
    db.run(sql`CREATE TRIGGER reject_repair_completion BEFORE INSERT ON data_repair_completions
      BEGIN SELECT RAISE(ABORT, 'completion write failed'); END`)

    await expect(repairNormalizedPathsOnStartup(db)).rejects.toThrow('completion write failed')

    expect(normalized('traffic', 'legacy')).toBe('/about')
    expect(marker(TRAFFIC_REPAIR)).toBeUndefined()
    db.run(sql`DROP TRIGGER reject_repair_completion`)
    reopen()
    expect(await repairNormalizedPathsOnStartup(db)).toEqual({ examined: 1, updated: 0, unchanged: 1 })
    expect(marker(TRAFFIC_REPAIR)?.version).toBe(contracts.URL_PATH_NORMALIZATION_VERSION)
  })

  it('preserves a newer completion written while an older repair is in progress', async () => {
    seed('traffic', 'legacy')
    const newer = { name: TRAFFIC_REPAIR, version: contracts.URL_PATH_NORMALIZATION_VERSION + 1, completedAt: NOW }
    const writer = createClient(databasePath)
    const originalNormalize = contracts.normalizeUrlPath
    const normalize = vi.spyOn(contracts, 'normalizeUrlPath').mockImplementation(value => {
      writer.insert(dataRepairCompletions).values(newer).run()
      return originalNormalize(value)
    })
    try {
      expect(await repairNormalizedPathsOnStartup(db)).toEqual({ examined: 1, updated: 1, unchanged: 0 })
      expect(marker(TRAFFIC_REPAIR)).toEqual(newer)
    } finally {
      normalize.mockRestore()
      writer.$client.close()
    }
  })

  it.each(REPAIRS)('withholds $kind completion after a concurrent source change until a later pass repairs it', async ({ kind, name, repair }) => {
    seed(kind, 'raced', '/old/')
    const writer = createClient(databasePath)
    writer.$client.pragma('busy_timeout = 0')
    const transactionStates: boolean[] = []
    const originalNormalize = contracts.normalizeUrlPath
    const normalize = vi.spyOn(contracts, 'normalizeUrlPath').mockImplementation(value => {
      transactionStates.push(db.$client.inTransaction)
      if (value === '/old/') {
        if (kind === 'traffic') writer.update(gaTrafficSnapshots).set({ landingPage: '/new/' }).where(eq(gaTrafficSnapshots.id, 'raced')).run()
        else writer.update(gaAiReferrals).set({ landingPage: '/new/' }).where(eq(gaAiReferrals.id, 'raced')).run()
      }
      return originalNormalize(value)
    })
    try {
      expect(await repair(db)).toEqual({ examined: 1, updated: 0, unchanged: 1 })
      expect(marker(name)).toBeUndefined()
      expect(transactionStates).toEqual([false])
      expect(normalized(kind, 'raced')).toBeNull()
    } finally {
      normalize.mockRestore()
      writer.$client.close()
    }
    reopen()

    expect(await repair(db)).toEqual({ examined: 1, updated: 1, unchanged: 0 })
    expect(normalized(kind, 'raced')).toBe('/new')
    expect(marker(name)?.version).toBe(contracts.URL_PATH_NORMALIZATION_VERSION)
  })

  it.each([false, true])('completes empty or legitimately null data independently for both tables (null rows: %s)', async (withRows) => {
    if (withRows) {
      seed('traffic', 'traffic-null', '(not set)')
      seed('referral', 'referral-null', '(not set)')
    }
    const totals = { examined: withRows ? 1 : 0, updated: 0, unchanged: withRows ? 1 : 0 }

    expect(await repairNormalizedPathsOnStartup(db)).toEqual(totals)
    expect(marker(TRAFFIC_REPAIR)?.version).toBe(contracts.URL_PATH_NORMALIZATION_VERSION)
    expect(marker(REFERRAL_REPAIR)).toBeUndefined()
    expect(await repairAiReferralPathsOnStartup(db)).toEqual(totals)
    expect(marker(REFERRAL_REPAIR)?.version).toBe(contracts.URL_PATH_NORMALIZATION_VERSION)
    if (withRows) {
      expect(normalized('traffic', 'traffic-null')).toBeNull()
      expect(normalized('referral', 'referral-null')).toBeNull()
    }
  })

  it('keeps explicit CLI repairs active after startup completion without rewriting the markers', async () => {
    await repairNormalizedPathsOnStartup(db)
    await repairAiReferralPathsOnStartup(db)
    const markers = db.select().from(dataRepairCompletions).orderBy(dataRepairCompletions.name).all()
    seed('traffic', 'manual-traffic')
    seed('referral', 'manual-referral', '/pricing/?utm_source=chatgpt')
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await backfillNormalizedPathsCommand({ format: 'json' })
    await backfillAiReferralPathsCommand({ format: 'json' })

    expect(output.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { project: null, examined: 1, updated: 1, unchanged: 0 },
      { project: null, examined: 1, updated: 1, unchanged: 0 },
    ])
    expect(normalized('traffic', 'manual-traffic')).toBe('/about')
    expect(normalized('referral', 'manual-referral')).toBe('/pricing')
    expect(db.select().from(dataRepairCompletions).orderBy(dataRepairCompletions.name).all()).toEqual(markers)
  })

  it('never marks global startup completion from scoped or unscoped manual helpers', async () => {
    seedProject('two')
    for (const kind of ['traffic', 'referral'] as const) {
      seed(kind, `${kind}-one`)
      seed(kind, `${kind}-two`, '/other/', 'two')
    }

    expect(await backfillNormalizedPaths(db, { projectId: 'one' })).toEqual({ examined: 1, updated: 1, unchanged: 0 })
    expect(await backfillAiReferralPaths(db, { projectId: 'one' })).toEqual({ examined: 1, updated: 1, unchanged: 0 })
    expect(normalized('traffic', 'traffic-two')).toBeNull()
    expect(normalized('referral', 'referral-two')).toBeNull()
    expect(db.select().from(dataRepairCompletions).all()).toEqual([])

    expect(await backfillNormalizedPaths(db)).toEqual({ examined: 2, updated: 1, unchanged: 1 })
    expect(await backfillAiReferralPaths(db)).toEqual({ examined: 2, updated: 1, unchanged: 1 })
    expect(db.select().from(dataRepairCompletions).all()).toEqual([])
  })
})
