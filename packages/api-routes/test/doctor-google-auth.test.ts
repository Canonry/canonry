import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GOOGLE_AUTH_CHECK_BY_ID } from '../src/doctor/checks/google-auth.js'
import type { DoctorContext, ProjectInfo } from '../src/doctor/types.js'
import type { GoogleConnectionRecord, GoogleConnectionStore } from '../src/google.js'

// Mock the google integration so checks don't make real HTTP calls.
const refreshAccessTokenMock = vi.fn()
const listSitesMock = vi.fn()

vi.mock('@ainyc/canonry-integration-google', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google')>('@ainyc/canonry-integration-google')
  return {
    ...actual,
    refreshAccessToken: (...args: unknown[]) => refreshAccessTokenMock(...args),
    listSites: (...args: unknown[]) => listSitesMock(...args),
  }
})

const project: ProjectInfo = {
  id: 'p1',
  name: 'demo',
  canonicalDomain: 'example.com',
  displayName: 'Demo',
}

function buildStore(connection?: Partial<GoogleConnectionRecord>): GoogleConnectionStore {
  const conn: GoogleConnectionRecord | undefined = connection
    ? {
        domain: 'example.com',
        connectionType: 'gsc',
        propertyId: 'sc-domain:example.com',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: [
          'https://www.googleapis.com/auth/webmasters',
          'https://www.googleapis.com/auth/indexing',
        ],
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
    redirectUri: 'http://localhost:4100/api/v1/google/callback',
    ...overrides,
  }
}

beforeEach(() => {
  refreshAccessTokenMock.mockReset()
  listSitesMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('google.auth.connection', () => {
  const check = GOOGLE_AUTH_CHECK_BY_ID['google.auth.connection']!

  it('returns ok when refresh succeeds', async () => {
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'new', expires_in: 3600 })
    const result = await check.run(ctx({}))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('google.auth.connected')
  })

  it('returns oauth-not-configured when client credentials are missing', async () => {
    const result = await check.run(ctx({ getGoogleAuthConfig: () => ({}) }))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('google.auth.oauth-not-configured')
  })

  it('returns no-connection when project has no GSC connection', async () => {
    const result = await check.run(ctx({ googleConnectionStore: buildStore() }))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('google.auth.no-connection')
  })

  it('returns refresh-failed when refresh throws', async () => {
    refreshAccessTokenMock.mockRejectedValue(new Error('invalid_grant'))
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('google.auth.refresh-failed')
    expect(result.details).toMatchObject({ error: 'invalid_grant' })
  })

  it('returns refresh-unreachable, not a rejected token, when Google cannot be reached', async () => {
    // What Node's fetch rejects with when a DNS filter answers 0.0.0.0.
    refreshAccessTokenMock.mockRejectedValue(new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 0.0.0.0:443'), { code: 'ECONNREFUSED', syscall: 'connect', address: '0.0.0.0', port: 443 }),
    }))
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('google.auth.refresh-unreachable')
    const error = 'fetch failed (ECONNREFUSED connecting to oauth2.googleapis.com at 0.0.0.0:443)'
    expect(result.summary).toBe(`Could not reach Google to refresh the GSC token: ${error}`)
    expect(result.details).toMatchObject({ error })
    expect(result.remediation).not.toContain('re-authorize')
  })

  it('returns refresh-unreachable when the token request times out', async () => {
    refreshAccessTokenMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const result = await check.run(ctx({}))
    expect(result.code).toBe('google.auth.refresh-unreachable')
  })
})

describe('google.auth.property-access', () => {
  const check = GOOGLE_AUTH_CHECK_BY_ID['google.auth.property-access']!

  it('returns ok when property is in the accessible sites list', async () => {
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'tok', expires_in: 3600 })
    listSitesMock.mockResolvedValue([
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
    ])
    const result = await check.run(ctx({}))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('google.auth.property-accessible')
  })

  it('returns no-property-selected when the connection has no propertyId', async () => {
    const result = await check.run(ctx({ googleConnectionStore: buildStore({ propertyId: null }) }))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('google.auth.no-property-selected')
  })

  it('returns property-not-accessible when selected property is missing from accessible list', async () => {
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'tok', expires_in: 3600 })
    listSitesMock.mockResolvedValue([
      { siteUrl: 'sc-domain:other.com', permissionLevel: 'siteOwner' },
    ])
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('google.auth.property-not-accessible')
    expect(result.details).toMatchObject({
      selectedProperty: 'sc-domain:example.com',
      accessibleSites: ['sc-domain:other.com'],
    })
  })

  it('returns principal-forbidden when listSites returns 403', async () => {
    const { GoogleApiError } = await import('@ainyc/canonry-integration-google')
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'tok', expires_in: 3600 })
    listSitesMock.mockRejectedValue(new GoogleApiError('forbidden', 403))
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('google.auth.principal-forbidden')
  })

  it('returns list-sites-unreachable when the Search Console API cannot be reached', async () => {
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'tok', expires_in: 3600 })
    listSitesMock.mockRejectedValue(new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND www.googleapis.com'), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'www.googleapis.com' }),
    }))
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('google.auth.list-sites-unreachable')
    expect(result.summary).toContain('fetch failed (ENOTFOUND resolving www.googleapis.com)')
  })

  it('returns list-sites-failed when Search Console answers with an error', async () => {
    const { GoogleApiError } = await import('@ainyc/canonry-integration-google')
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'tok', expires_in: 3600 })
    listSitesMock.mockRejectedValue(new GoogleApiError('backend error', 503))
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('google.auth.list-sites-failed')
  })

  it('returns property-unverified when the property is present but the account is an unverified user', async () => {
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'tok', expires_in: 3600 })
    listSitesMock.mockResolvedValue([
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteUnverifiedUser' },
    ])
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('google.auth.property-unverified')
    expect(result.details).toMatchObject({
      selectedProperty: 'sc-domain:example.com',
      permissionLevel: 'siteUnverifiedUser',
    })
  })

  it('returns ok for a usable non-owner permission level (siteRestrictedUser)', async () => {
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'tok', expires_in: 3600 })
    listSitesMock.mockResolvedValue([
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteRestrictedUser' },
    ])
    const result = await check.run(ctx({}))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('google.auth.property-accessible')
  })
})

describe('google.auth.redirect-uri', () => {
  const check = GOOGLE_AUTH_CHECK_BY_ID['google.auth.redirect-uri']!

  it('returns ok with a valid configured redirect URI', async () => {
    const result = await check.run(ctx({}))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('google.auth.redirect-uri-configured')
    expect(result.details).toMatchObject({ redirectUri: 'http://localhost:4100/api/v1/google/callback' })
  })

  it('warns when no publicUrl is configured', async () => {
    const result = await check.run(ctx({ redirectUri: undefined }))
    expect(result.status).toBe('warn')
    expect(result.code).toBe('google.auth.redirect-uri-auto-detected')
  })

  it('fails when redirect URI is not http(s)', async () => {
    const result = await check.run(ctx({ redirectUri: 'ftp://example.com/callback' }))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('google.auth.redirect-uri-invalid')
  })
})

describe('google.auth.scopes', () => {
  const check = GOOGLE_AUTH_CHECK_BY_ID['google.auth.scopes']!

  it('returns ok when both required scopes are granted', async () => {
    const result = await check.run(ctx({}))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('google.auth.scopes-ok')
  })

  it('warns when the full scope lacks Indexing API access', async () => {
    const result = await check.run(
      ctx({
        googleConnectionStore: buildStore({
          scopes: ['https://www.googleapis.com/auth/webmasters'],
        }),
      }),
    )
    expect(result.status).toBe('warn')
    expect(result.code).toBe('google.auth.indexing-scope-missing')
  })

  it('warns existing read-only plus indexing installations to reconnect for sitemap writes', async () => {
    const result = await check.run(
      ctx({
        googleConnectionStore: buildStore({
          scopes: [
            'https://www.googleapis.com/auth/webmasters.readonly',
            'https://www.googleapis.com/auth/indexing',
          ],
        }),
      }),
    )
    expect(result.status).toBe('warn')
    expect(result.code).toBe('google.auth.sitemap-write-scope-missing')
    expect(result.remediation).toMatch(/full Search Console webmasters scope/)
  })

  it('warns when a read-only installation lacks optional write scopes', async () => {
    const result = await check.run(
      ctx({
        googleConnectionStore: buildStore({ scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] }),
      }),
    )
    expect(result.status).toBe('warn')
    expect(result.code).toBe('google.auth.sitemap-write-scope-missing')
    expect(result.summary).toMatch(/Indexing API are unavailable/)
  })

  it('fails only when neither full nor read-only Search Console access is granted', async () => {
    const result = await check.run(
      ctx({ googleConnectionStore: buildStore({ scopes: ['https://www.googleapis.com/auth/indexing'] }) }),
    )
    expect(result.status).toBe('fail')
    expect(result.code).toBe('google.auth.required-scope-missing')
    expect(result.summary).toMatch(/GSC reads will fail/)
  })
})
