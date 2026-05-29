import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, migrate, projects, gbpLocations } from '@ainyc/canonry-db'
import { GbpApiError } from '@ainyc/canonry-integration-google-business-profile'
import { GBP_AUTH_CHECK_BY_ID } from '../src/doctor/checks/gbp-auth.js'
import type { DoctorContext, ProjectInfo } from '../src/doctor/types.js'
import type { GoogleConnectionRecord, GoogleConnectionStore } from '../src/google.js'

const refreshAccessTokenMock = vi.fn()
const listAccountsMock = vi.fn()

vi.mock('@ainyc/canonry-integration-google', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google')>('@ainyc/canonry-integration-google')
  return { ...actual, refreshAccessToken: (...args: unknown[]) => refreshAccessTokenMock(...args) }
})
vi.mock('@ainyc/canonry-integration-google-business-profile', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google-business-profile')>(
    '@ainyc/canonry-integration-google-business-profile',
  )
  return { ...actual, listAccounts: (...args: unknown[]) => listAccountsMock(...args) }
})

const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage'

const project: ProjectInfo = { id: 'p1', name: 'demo', canonicalDomain: 'example.com', displayName: 'Demo' }

function buildStore(connection?: Partial<GoogleConnectionRecord>): GoogleConnectionStore {
  const conn: GoogleConnectionRecord | undefined = connection
    ? {
        domain: 'example.com',
        connectionType: 'gbp',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: [GBP_SCOPE],
        gbpAccountName: 'accounts/123',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        ...connection,
      } as GoogleConnectionRecord
    : undefined
  return {
    listConnections: () => (conn ? [conn] : []),
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
    getGoogleAuthConfig: () => ({ clientId: 'client', clientSecret: 'secret' }),
    googleConnectionStore: buildStore({}),
    ...overrides,
  }
}

beforeEach(() => {
  refreshAccessTokenMock.mockReset()
  listAccountsMock.mockReset()
  refreshAccessTokenMock.mockResolvedValue({ access_token: 'new', expires_in: 3600 })
})
afterEach(() => vi.clearAllMocks())

describe('gbp.auth.connection', () => {
  const check = GBP_AUTH_CHECK_BY_ID['gbp.auth.connection']!

  it('ok when the refresh token works', async () => {
    const result = await check.run(ctx({}))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('gbp.auth.connected')
  })
  it('skipped when no project context', async () => {
    const result = await check.run(ctx({ project: null }))
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('gbp.auth.no-project')
  })
  it('fail when OAuth client credentials are missing', async () => {
    const result = await check.run(ctx({ getGoogleAuthConfig: () => ({}) }))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('gbp.auth.oauth-not-configured')
  })
  it('fail when there is no GBP connection', async () => {
    const result = await check.run(ctx({ googleConnectionStore: buildStore() }))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('gbp.auth.no-connection')
  })
  it('fail when the connection has no refresh token', async () => {
    const result = await check.run(ctx({ googleConnectionStore: buildStore({ refreshToken: null }) }))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('gbp.auth.no-refresh-token')
  })
  it('fail when the refresh token is rejected', async () => {
    refreshAccessTokenMock.mockRejectedValue(new Error('invalid_grant'))
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('gbp.auth.refresh-failed')
  })
})

describe('gbp.auth.scopes', () => {
  const check = GBP_AUTH_CHECK_BY_ID['gbp.auth.scopes']!

  it('ok when business.manage is granted', async () => {
    const result = await check.run(ctx({}))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('gbp.auth.scopes-ok')
  })
  it('fail when business.manage is missing', async () => {
    const result = await check.run(ctx({ googleConnectionStore: buildStore({ scopes: ['https://www.googleapis.com/auth/userinfo.email'] }) }))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('gbp.auth.required-scope-missing')
  })
  it('skipped when there is no connection', async () => {
    const result = await check.run(ctx({ googleConnectionStore: buildStore() }))
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('gbp.auth.no-connection')
  })
})

describe('gbp.account.access', () => {
  const check = GBP_AUTH_CHECK_BY_ID['gbp.account.access']!

  it('ok when the tracked account is listable', async () => {
    listAccountsMock.mockResolvedValue([{ name: 'accounts/123', accountName: 'Demo', type: null, role: null }])
    const result = await check.run(ctx({}))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('gbp.account.accessible')
  })
  it('fail when no account is selected for the project', async () => {
    const result = await check.run(ctx({ googleConnectionStore: buildStore({ gbpAccountName: null }) }))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('gbp.account.none-selected')
  })
  it('fail when the tracked account is not accessible', async () => {
    listAccountsMock.mockResolvedValue([{ name: 'accounts/999', accountName: 'Other', type: null, role: null }])
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('gbp.account.not-accessible')
  })
  it('fail with scope-insufficient when the token lacks business.manage', async () => {
    listAccountsMock.mockRejectedValue(new GbpApiError('scope', 403, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', {}))
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('gbp.account.scope-insufficient')
  })
  it('warn when the API access form is still pending (0 QPM)', async () => {
    listAccountsMock.mockRejectedValue(new GbpApiError('rate', 429, 'RATE_LIMIT_EXCEEDED', {}, 0))
    const result = await check.run(ctx({}))
    expect(result.status).toBe('warn')
    expect(result.code).toBe('gbp.account.quota-pending')
  })
  it('fail with list-failed on other API errors', async () => {
    listAccountsMock.mockRejectedValue(new GbpApiError('disabled', 403, 'API_DISABLED', {}))
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('gbp.account.list-failed')
  })
  it('skipped when there is no connection', async () => {
    const result = await check.run(ctx({ googleConnectionStore: buildStore() }))
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('gbp.auth.no-connection')
  })
})

describe('gbp.data.recent-sync', () => {
  const check = GBP_AUTH_CHECK_BY_ID['gbp.data.recent-sync']!

  function dbWithLocations(rows: Array<{ id: string; selected: boolean; syncedAt: string | null }>) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-gbp-recent-'))
    const db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    const now = new Date().toISOString()
    db.insert(projects).values({ id: 'p1', name: 'demo', displayName: 'Demo', canonicalDomain: 'example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
    for (const r of rows) {
      db.insert(gbpLocations).values({
        id: r.id, projectId: 'p1', accountName: 'accounts/123', locationName: `locations/${r.id}`,
        displayName: r.id, selected: r.selected, syncedAt: r.syncedAt, createdAt: now, updatedAt: now,
      }).run()
    }
    return { db, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) }
  }

  function daysAgoIso(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  }

  it('skipped when no selected locations', () => {
    const { db, cleanup } = dbWithLocations([{ id: 'a', selected: false, syncedAt: daysAgoIso(1) }])
    try {
      const result = check.run(ctx({ db }))
      expect(result).toMatchObject({ status: 'skipped', code: 'gbp.data.no-selected-locations' })
    } finally { cleanup() }
  })
  it('warn when selected locations have never synced', () => {
    const { db, cleanup } = dbWithLocations([{ id: 'a', selected: true, syncedAt: null }])
    try {
      const result = check.run(ctx({ db }))
      expect(result).toMatchObject({ status: 'warn', code: 'gbp.data.never-synced' })
    } finally { cleanup() }
  })
  it('ok when a sync is recent', () => {
    const { db, cleanup } = dbWithLocations([{ id: 'a', selected: true, syncedAt: daysAgoIso(1) }])
    try {
      const result = check.run(ctx({ db }))
      expect(result).toMatchObject({ status: 'ok', code: 'gbp.data.fresh' })
    } finally { cleanup() }
  })
  it('warn when the newest sync is aging (> 7d)', () => {
    const { db, cleanup } = dbWithLocations([
      { id: 'a', selected: true, syncedAt: daysAgoIso(40) },
      { id: 'b', selected: true, syncedAt: daysAgoIso(10) },
    ])
    try {
      const result = check.run(ctx({ db }))
      expect(result).toMatchObject({ status: 'warn', code: 'gbp.data.aging' })
    } finally { cleanup() }
  })
  it('fail when the newest sync is stale (> 30d)', () => {
    const { db, cleanup } = dbWithLocations([{ id: 'a', selected: true, syncedAt: daysAgoIso(45) }])
    try {
      const result = check.run(ctx({ db }))
      expect(result).toMatchObject({ status: 'fail', code: 'gbp.data.stale' })
    } finally { cleanup() }
  })
})
