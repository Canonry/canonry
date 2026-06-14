import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, migrate, projects, adsConnections } from '@ainyc/canonry-db'
import { ADS_CHECKS } from '../src/doctor/checks/ads.js'
import type { DoctorContext, ProjectInfo } from '../src/doctor/types.js'

const project: ProjectInfo = { id: 'p1', name: 'demo', canonicalDomain: 'example.com', displayName: 'Demo' }

const NOW = Date.now()
const DAY_MS = 24 * 60 * 60 * 1000

function check(id: string) {
  const def = ADS_CHECKS.find((c) => c.id === id)
  if (!def) throw new Error(`check not registered: ${id}`)
  return def
}

describe('ads doctor checks', () => {
  let tmpDir: string
  let db: ReturnType<typeof createClient>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-ads-test-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    db.insert(projects).values({
      id: 'p1', name: 'demo', displayName: 'Demo', canonicalDomain: 'example.com',
      country: 'US', language: 'en',
      createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
    }).run()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function ctx(overrides: Partial<DoctorContext> = {}): DoctorContext {
    return {
      db,
      project,
      adsCredentialStore: {
        getConnection: () => ({
          projectName: 'demo', apiKey: 'sk-test', adAccountId: 'adacct_aaa',
          createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
        }),
        upsertConnection: (entry) => entry,
        removeConnection: () => true,
      },
      ...overrides,
    } as DoctorContext
  }

  function seedConnection(lastSyncedAt: string | null) {
    db.insert(adsConnections).values({
      id: 'conn_1', projectId: 'p1', adAccountId: 'adacct_aaa', lastSyncedAt,
      createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
    }).run()
  }

  it('ads.auth.connection skips when no connection row exists', async () => {
    const result = await check('ads.auth.connection').run(ctx())
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('ads.auth.not-connected')
  })

  it('ads.auth.connection fails when the row exists but the config key is missing', async () => {
    seedConnection(null)
    const result = await check('ads.auth.connection').run(ctx({
      adsCredentialStore: {
        getConnection: () => undefined,
        upsertConnection: (entry) => entry,
        removeConnection: () => false,
      },
    }))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('ads.auth.missing-key')
  })

  it('ads.auth.connection skips when no credential store is configured', async () => {
    seedConnection(null)
    const result = await check('ads.auth.connection').run(ctx({ adsCredentialStore: undefined }))
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('ads.auth.store-unavailable')
  })

  it('ads.auth.connection passes when row and key agree', async () => {
    seedConnection(null)
    const result = await check('ads.auth.connection').run(ctx())
    expect(result.status).toBe('ok')
  })

  it('ads.data.recent-sync skips when not connected and warns when never synced', async () => {
    let result = await check('ads.data.recent-sync').run(ctx())
    expect(result.status).toBe('skipped')

    seedConnection(null)
    result = await check('ads.data.recent-sync').run(ctx())
    expect(result.status).toBe('warn')
    expect(result.code).toBe('ads.data.never-synced')
  })

  it('ads.data.recent-sync grades freshness: ok < 7d, warn < 30d, fail beyond', async () => {
    seedConnection(new Date(NOW - 1 * DAY_MS).toISOString())
    expect((await check('ads.data.recent-sync').run(ctx())).status).toBe('ok')

    db.delete(adsConnections).run()
    seedConnection(new Date(NOW - 10 * DAY_MS).toISOString())
    expect((await check('ads.data.recent-sync').run(ctx())).status).toBe('warn')

    db.delete(adsConnections).run()
    seedConnection(new Date(NOW - 40 * DAY_MS).toISOString())
    const stale = await check('ads.data.recent-sync').run(ctx())
    expect(stale.status).toBe('fail')
    expect(stale.code).toBe('ads.data.stale')
  })
})
