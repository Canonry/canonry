import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createClient,
  gaTrafficSnapshots,
  migrate,
  projects,
} from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'
import { backfillNormalizedPathsCommand } from '../src/commands/backfill.js'

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
})
