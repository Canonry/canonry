import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

beforeEach(() => {
  getSitesMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('bing.auth.connection', () => {
  const check = BING_AUTH_CHECKS.find(c => c.id === 'bing.auth.connection')!

  it('returns ok when API key is valid', async () => {
    getSitesMock.mockResolvedValue([{ Url: 'https://example.com/', Verified: true }])
    const result = await check.run(ctx({}))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('bing.auth.connected')
  })

  it('returns no-connection when project has no Bing connection', async () => {
    const result = await check.run(ctx({ bingConnectionStore: buildStore() }))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('bing.auth.no-connection')
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
    getSitesMock.mockResolvedValue([{ Url: 'https://example.com/', Verified: true }])
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
    getSitesMock.mockResolvedValue([{ Url: 'https://other.com/', Verified: true }])
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('bing.auth.site-not-found')
    expect(result.details).toMatchObject({
      configuredSite: 'https://example.com/',
      availableSites: ['https://other.com/'],
    })
  })

  it('returns site-not-verified when site is in list but not verified', async () => {
    getSitesMock.mockResolvedValue([{ Url: 'https://example.com/', Verified: false }])
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('bing.auth.site-not-verified')
  })
})
