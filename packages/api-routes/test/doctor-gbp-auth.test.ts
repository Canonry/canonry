import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, migrate, projects, gbpLocations } from '@canonry/canonry-db'
import { GbpApiError } from '@canonry/canonry-integration-google-business-profile'
import { GBP_AUTH_CHECK_BY_ID } from '../src/doctor/checks/gbp-auth.js'
import type { DoctorContext, ProjectInfo } from '../src/doctor/types.js'
import type { GoogleConnectionRecord, GoogleConnectionStore } from '../src/google.js'

const refreshAccessTokenMock = vi.fn()
const listAccountsMock = vi.fn()

vi.mock('@canonry/canonry-integration-google', async () => {
  const actual = await vi.importActual<typeof import('@canonry/canonry-integration-google')>('@canonry/canonry-integration-google')
  return { ...actual, refreshAccessToken: (...args: unknown[]) => refreshAccessTokenMock(...args) }
})
vi.mock('@canonry/canonry-integration-google-business-profile', async () => {
  const actual = await vi.importActual<typeof import('@canonry/canonry-integration-google-business-profile')>(
    '@canonry/canonry-integration-google-business-profile',
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

/** A migrated database holding project `p1` (and a sibling `p2`) with the given GBP locations. */
function dbWithLocations(rows: Array<{ id: string; selected: boolean; syncedAt: string | null; projectId?: string }>) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-gbp-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({ id: 'p1', name: 'demo', displayName: 'Demo', canonicalDomain: 'example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  db.insert(projects).values({ id: 'p2', name: 'sibling', displayName: 'Sibling', canonicalDomain: 'sibling.example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  for (const r of rows) {
    db.insert(gbpLocations).values({
      id: r.id, projectId: r.projectId ?? 'p1', accountName: 'accounts/123', locationName: `locations/${r.id}`,
      displayName: r.id, selected: r.selected, syncedAt: r.syncedAt, createdAt: now, updatedAt: now,
    }).run()
  }
  return { db, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) }
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
  // GBP is optional. A project that never connected it used to fail this check
  // on every pass, so every such project was permanently degraded.
  it('skipped as not-connected when the project has no connection and no selected location', async () => {
    const { db, cleanup } = dbWithLocations([])
    try {
      const result = await check.run(ctx({ db, googleConnectionStore: buildStore() }))
      expect(result.status).toBe('skipped')
      expect(result.code).toBe('gbp.auth.not-connected')
      expect(result.summary).toBe('demo has not connected Google Business Profile.')
      expect(result.remediation).toContain('canonry gbp connect demo')
    } finally { cleanup() }
  })
  it('skipped as not-connected when its locations are all deselected, or belong to another project', async () => {
    const { db, cleanup } = dbWithLocations([
      { id: 'a', selected: false, syncedAt: null },
      { id: 'b', selected: true, syncedAt: null, projectId: 'p2' },
    ])
    try {
      const result = await check.run(ctx({ db, googleConnectionStore: buildStore() }))
      expect(result).toMatchObject({ status: 'skipped', code: 'gbp.auth.not-connected' })
    } finally { cleanup() }
  })
  it('skipped as not-connected before the OAuth client is asked for, since an unused integration needs none', async () => {
    const { db, cleanup } = dbWithLocations([])
    try {
      const result = await check.run(ctx({ db, googleConnectionStore: buildStore(), getGoogleAuthConfig: () => ({}) }))
      expect(result).toMatchObject({ status: 'skipped', code: 'gbp.auth.not-connected' })
    } finally { cleanup() }
  })
  it('fail when the connection is gone but the project still has a selected location', async () => {
    const { db, cleanup } = dbWithLocations([{ id: 'a', selected: true, syncedAt: null }])
    try {
      const result = await check.run(ctx({ db, googleConnectionStore: buildStore() }))
      expect(result.status).toBe('fail')
      expect(result.code).toBe('gbp.auth.no-connection')
      expect(result.remediation).toContain('canonry gbp connect demo')
    } finally { cleanup() }
  })
  it('fail on a missing OAuth client when a lost connection left selected locations', async () => {
    const { db, cleanup } = dbWithLocations([{ id: 'a', selected: true, syncedAt: null }])
    try {
      const result = await check.run(ctx({ db, googleConnectionStore: buildStore(), getGoogleAuthConfig: () => ({}) }))
      expect(result).toMatchObject({ status: 'fail', code: 'gbp.auth.oauth-not-configured' })
    } finally { cleanup() }
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
  it('fail as refresh-unreachable, not a rejected token, when Google cannot be reached', async () => {
    refreshAccessTokenMock.mockRejectedValue(new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'oauth2.googleapis.com' }),
    }))
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('gbp.auth.refresh-unreachable')
    expect(result.summary).toBe('Could not reach Google to refresh the GBP token: fetch failed (ENOTFOUND resolving oauth2.googleapis.com)')
    expect(result.remediation).not.toContain('re-authorize')
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
  it('fail as list-unreachable when the Business Profile API cannot be reached', async () => {
    // The GBP client aborts a request on its own timer, which rejects as an AbortError.
    listAccountsMock.mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'))
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('gbp.account.list-unreachable')
    expect(result.summary).toBe('Could not reach the Business Profile API to list GBP accounts: This operation was aborted')
  })
  it('skipped when there is no connection', async () => {
    const result = await check.run(ctx({ googleConnectionStore: buildStore() }))
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('gbp.auth.no-connection')
  })
})

describe('gbp.data.recent-sync', () => {
  const check = GBP_AUTH_CHECK_BY_ID['gbp.data.recent-sync']!

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
  it('warn when the newest sync is aging (> 4d)', () => {
    const { db, cleanup } = dbWithLocations([
      { id: 'a', selected: true, syncedAt: daysAgoIso(40) },
      { id: 'b', selected: true, syncedAt: daysAgoIso(10) },
    ])
    try {
      const result = check.run(ctx({ db }))
      expect(result).toMatchObject({ status: 'warn', code: 'gbp.data.aging' })
    } finally { cleanup() }
  })
  it('warns at 5 days, which the previous 7d threshold reported as fresh', () => {
    // This is the case that pins the new number. Every other fixture here sits
    // far enough either side of both thresholds to pass under each, so without
    // it the constant could drift back to 7 with a green suite.
    const { db, cleanup } = dbWithLocations([{ id: 'a', selected: true, syncedAt: daysAgoIso(5) }])
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
