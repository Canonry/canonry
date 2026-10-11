import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { auditLog, bingCoverageSnapshots, bingKeywordStats, bingUrlInspections, createClient, migrate, projects } from '@ainyc/canonry-db'
import { BING_AUTH_CHECKS } from '../src/doctor/checks/bing-auth.js'
import type { DoctorContext, ProjectInfo } from '../src/doctor/types.js'
import type { BingConnectionRecord, BingConnectionStore } from '../src/bing.js'

// Mock the bing integration
const getSitesMock = vi.fn()

vi.mock('@ainyc/canonry-integration-bing', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-bing')>('@ainyc/canonry-integration-bing')
  return {
    ...actual,
    getSites: (...args: unknown[]) => getSitesMock(...args),
  }
})

const project: ProjectInfo = {
  id: 'p1',
  name: 'demo',
  canonicalDomain: 'example.com',
  displayName: 'Demo',
}

function buildStore(connection?: Partial<BingConnectionRecord>): BingConnectionStore {
  const conn: BingConnectionRecord | undefined = connection
    ? {
        domain: 'example.com',
        apiKey: 'bing-api-key',
        siteUrl: 'https://example.com/',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        ...connection,
      } as BingConnectionRecord
    : undefined

  return {
    getConnection: () => conn,
    upsertConnection: (record) => record,
    updateConnection: () => conn,
    deleteConnection: () => true,
  }
}

function ctx(overrides: Partial<DoctorContext>): DoctorContext {
  return {
    db: {} as DoctorContext['db'],
    project,
    bingConnectionStore: buildStore({}),
    ...overrides,
  }
}

/**
 * A migrated database holding project `p1`, `p2` on another domain, and `p3`
 * on the same domain as `p1`, removed when the test ends.
 */
function projectDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-bing-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const now = '2026-04-01T00:00:00.000Z'
  db.insert(projects).values({ id: 'p1', name: 'demo', displayName: 'Demo', canonicalDomain: 'example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  db.insert(projects).values({ id: 'p2', name: 'sibling', displayName: 'Sibling', canonicalDomain: 'sibling.example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  db.insert(projects).values({ id: 'p3', name: 'twin', displayName: 'Twin', canonicalDomain: 'example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  return db
}

type Db = ReturnType<typeof projectDb>

/** Each kind of Bing data a connected project stores, as its route or sync writes it. */
const STORED_BING_DATA: Record<string, (db: Db, projectId: string) => void> = {
  'a coverage snapshot': (db, projectId) => {
    db.insert(bingCoverageSnapshots).values({ id: `cov-${projectId}`, projectId, date: '2026-04-02', indexed: 3, notIndexed: 1, unknown: 0, createdAt: '2026-04-02T00:00:00.000Z' }).run()
  },
  'a URL inspection': (db, projectId) => {
    db.insert(bingUrlInspections).values({ id: `insp-${projectId}`, projectId, url: 'https://example.com/', inIndex: true, inspectedAt: '2026-04-02T00:00:00.000Z', createdAt: '2026-04-02T00:00:00.000Z' }).run()
  },
  'keyword stats': (db, projectId) => {
    db.insert(bingKeywordStats).values({ id: `kw-${projectId}`, projectId, query: 'example query', syncedAt: '2026-04-02T00:00:00.000Z', createdAt: '2026-04-02T00:00:00.000Z' }).run()
  },
}

/** The audit row the Bing connect and disconnect routes write: the acting project, and the connection's domain. */
function auditBing(db: Db, projectId: string, action: 'bing.connected' | 'bing.disconnected', createdAt: string, domain = 'example.com') {
  db.insert(auditLog).values({ id: `${action}-${projectId}-${createdAt}`, projectId, actor: 'api', action, entityType: 'bing_connection', entityId: domain, createdAt }).run()
}

beforeEach(() => {
  getSitesMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('bing.auth.connection', () => {
  const check = BING_AUTH_CHECKS.find(c => c.id === 'bing.auth.connection')!

  it('returns ok when API key is valid', async () => {
    getSitesMock.mockResolvedValue([{ Url: 'https://example.com/', IsVerified: true }])
    const result = await check.run(ctx({}))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('bing.auth.connected')
  })

  // Bing is optional. A project that never connected it used to fail this
  // check on every pass, so every such project was permanently degraded.
  it('skips as not-connected when the project has no connection and no stored Bing data', async () => {
    const db = projectDb()
    // Another project's Bing data is not this project's footprint.
    STORED_BING_DATA['a coverage snapshot']!(db, 'p2')
    const result = await check.run(ctx({ db, bingConnectionStore: buildStore() }))
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('bing.auth.not-connected')
    expect(result.summary).toBe('demo has not connected Bing Webmaster Tools.')
    expect(result.remediation).toContain('canonry bing connect demo --api-key')
  })

  it.each(Object.keys(STORED_BING_DATA))('fails as no-connection when the connection is gone but the project stored %s', async (kind) => {
    const db = projectDb()
    STORED_BING_DATA[kind]!(db, 'p1')
    const result = await check.run(ctx({ db, bingConnectionStore: buildStore() }))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('bing.auth.no-connection')
    expect(result.remediation).toContain('canonry bing connect demo --api-key')
  })

  it('skips as not-connected after an explicit disconnect, which keeps the stored data', async () => {
    const db = projectDb()
    STORED_BING_DATA['a coverage snapshot']!(db, 'p1')
    auditBing(db, 'p1', 'bing.connected', '2026-04-01T00:00:00.000Z')
    auditBing(db, 'p1', 'bing.disconnected', '2026-04-03T00:00:00.000Z')
    const result = await check.run(ctx({ db, bingConnectionStore: buildStore() }))
    expect(result).toMatchObject({ status: 'skipped', code: 'bing.auth.not-connected' })
  })

  it('fails as no-connection when the project reconnected after a disconnect and then lost the connection', async () => {
    const db = projectDb()
    STORED_BING_DATA['a coverage snapshot']!(db, 'p1')
    auditBing(db, 'p1', 'bing.disconnected', '2026-04-03T00:00:00.000Z')
    auditBing(db, 'p1', 'bing.connected', '2026-04-04T00:00:00.000Z')
    // A later disconnect of another domain's connection does not speak for this one.
    auditBing(db, 'p2', 'bing.disconnected', '2026-04-05T00:00:00.000Z', 'sibling.example.com')
    const result = await check.run(ctx({ db, bingConnectionStore: buildStore() }))
    expect(result).toMatchObject({ status: 'fail', code: 'bing.auth.no-connection' })
  })

  // The connection is keyed by domain, so every project on the domain stores
  // Bing data through it, while the audit row names only the project that ran
  // the command. Read per project, the others failed forever after a
  // deliberate disconnect, and could not clear it: with no connection left,
  // their own disconnect is refused before it writes anything.
  it('skips as not-connected for another project on the domain after its owner disconnected', async () => {
    const db = projectDb()
    const twin: ProjectInfo = { id: 'p3', name: 'twin', canonicalDomain: 'example.com', displayName: 'Twin' }
    STORED_BING_DATA['a URL inspection']!(db, 'p3')
    auditBing(db, 'p1', 'bing.connected', '2026-04-01T00:00:00.000Z')
    auditBing(db, 'p1', 'bing.disconnected', '2026-04-03T00:00:00.000Z')
    const result = await check.run(ctx({ db, project: twin, bingConnectionStore: buildStore() }))
    expect(result).toMatchObject({ status: 'skipped', code: 'bing.auth.not-connected', summary: 'twin has not connected Bing Webmaster Tools.' })
  })

  it('fails as no-connection for another project on the domain when the connection was lost, not disconnected', async () => {
    const db = projectDb()
    const twin: ProjectInfo = { id: 'p3', name: 'twin', canonicalDomain: 'example.com', displayName: 'Twin' }
    STORED_BING_DATA['a URL inspection']!(db, 'p3')
    auditBing(db, 'p1', 'bing.connected', '2026-04-01T00:00:00.000Z')
    const result = await check.run(ctx({ db, project: twin, bingConnectionStore: buildStore() }))
    expect(result).toMatchObject({ status: 'fail', code: 'bing.auth.no-connection' })
  })

  it('returns verification-failed when Bing API returns error', async () => {
    getSitesMock.mockRejectedValue(new Error('Invalid API Key'))
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('bing.auth.verification-failed')
    expect(result.details).toMatchObject({ error: 'Invalid API Key' })
  })
})

describe('bing.auth.site-access', () => {
  const check = BING_AUTH_CHECKS.find(c => c.id === 'bing.auth.site-access')!

  it('returns ok when site is verified and matches', async () => {
    getSitesMock.mockResolvedValue([{ Url: 'https://example.com/', IsVerified: true }])
    const result = await check.run(ctx({}))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('bing.auth.site-verified')
  })

  it('returns no-site-selected when siteUrl is missing', async () => {
    const result = await check.run(ctx({ bingConnectionStore: buildStore({ siteUrl: null }) }))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('bing.auth.no-site-selected')
  })

  it('returns site-not-found when site is missing from Bing list', async () => {
    getSitesMock.mockResolvedValue([{ Url: 'https://other.com/', IsVerified: true }])
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('bing.auth.site-not-found')
    expect(result.details).toMatchObject({
      configuredSite: 'https://example.com/',
      availableSites: ['https://other.com/'],
    })
  })

  it('returns site-not-verified when site is in list but not verified', async () => {
    getSitesMock.mockResolvedValue([{ Url: 'https://example.com/', IsVerified: false }])
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('bing.auth.site-not-verified')
  })
})
