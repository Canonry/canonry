import crypto from 'node:crypto'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, gbpLocations, gbpDailyMetrics, gbpKeywordImpressions, gbpKeywordMonthly, gbpPlaceActions, gbpLodgingSnapshots, gbpPlaceDetails, auditLog } from '@ainyc/canonry-db'
import { AppError, type GoogleConnectionType } from '@ainyc/canonry-contracts'
import { googleRoutes } from '../src/google.js'

interface StoredConnection {
  domain: string
  connectionType: GoogleConnectionType
  propertyId?: string | null
  sitemapUrl?: string | null
  accessToken?: string
  refreshToken?: string | null
  tokenExpiresAt?: string | null
  scopes?: string[]
  gbpAccountName?: string | null
  createdAt: string
  updatedAt: string
}

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbp-routes-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const connections: StoredConnection[] = []

  const app = Fastify()
  app.decorate('db', db)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(error.toJSON())
    }
    throw error
  })

  app.register(googleRoutes, {
    getGoogleAuthConfig: () => ({ clientId: 'client-id', clientSecret: 'client-secret' }),
    googleConnectionStore: {
      listConnections: (domain) => connections.filter(c => c.domain === domain),
      getConnection: (domain, connectionType) => connections.find(c => c.domain === domain && c.connectionType === connectionType),
      upsertConnection: (connection) => {
        const idx = connections.findIndex(c => c.domain === connection.domain && c.connectionType === connection.connectionType)
        if (idx === -1) connections.push(connection)
        else connections[idx] = connection
        return connection
      },
      updateConnection: (domain, connectionType, patch) => {
        const existing = connections.find(c => c.domain === domain && c.connectionType === connectionType)
        if (!existing) return undefined
        Object.assign(existing, patch)
        return existing
      },
      deleteConnection: (domain, connectionType) => {
        const idx = connections.findIndex(c => c.domain === domain && c.connectionType === connectionType)
        if (idx === -1) return false
        connections.splice(idx, 1)
        return true
      },
    },
    googleStateSecret: 'test-secret-32-bytes-long-enough!',
  })

  function seedProject(name: string, canonicalDomain: string): string {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    db.insert(projects).values({
      id, name,
      displayName: name,
      canonicalDomain,
      country: 'US',
      language: 'en',
      ownedDomains: '[]', tags: '[]', labels: '{}', providers: '[]', locations: '[]',
      defaultLocation: null,
      autoExtractBacklinks: 0,
      configSource: 'cli',
      configRevision: 1,
      createdAt: now, updatedAt: now,
    }).run()
    return id
  }

  function seedGbpConnection(domain: string, accessToken: string, expiresInSeconds = 3600) {
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString()
    connections.push({
      domain,
      connectionType: 'gbp',
      accessToken,
      refreshToken: 'refresh-token',
      tokenExpiresAt: expiresAt,
      scopes: ['https://www.googleapis.com/auth/business.manage'],
      createdAt: now,
      updatedAt: now,
    })
  }

  return { app, db, tmpDir, connections, seedProject, seedGbpConnection }
}

describe('GBP routes (Phase 1)', () => {
  let ctx: ReturnType<typeof buildApp>
  let fetchSpy: ReturnType<typeof vi.fn>
  let origFetch: typeof globalThis.fetch

  beforeEach(async () => {
    ctx = buildApp()
    await ctx.app.ready()
    origFetch = globalThis.fetch
    fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = origFetch
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  function mockGoogleResponses(opts: {
    accounts?: Array<{ name: string; accountName?: string }>
    locations?: Array<{
      name: string; title?: string; websiteUri?: string
      categories?: { primaryCategory?: { displayName?: string }; additionalCategories?: Array<{ displayName?: string }> }
      profile?: { description?: string }
      serviceArea?: Record<string, unknown>
      regularHours?: Record<string, unknown>
      phoneNumbers?: { primaryPhone?: string }
      openInfo?: { status?: string; openingDate?: { year?: number; month?: number; day?: number } }
      metadata?: { placeId?: string; mapsUri?: string }
    }>
  }) {
    fetchSpy.mockImplementation((url: string) => {
      // Route on the exact hostname, not a substring of the full URL — a
      // substring match would also accept a wrong host that merely carries the
      // API domain in its path (e.g. evil.example/mybusinessbusinessinformation.googleapis.com),
      // masking a production bug where the client builds a URL against the wrong host.
      let hostname: string
      try {
        hostname = new URL(url).hostname
      } catch {
        throw new Error(`Unexpected fetch URL: ${url}`)
      }
      if (hostname === 'mybusinessaccountmanagement.googleapis.com') {
        return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ accounts: opts.accounts ?? [] }) })
      }
      if (hostname === 'mybusinessbusinessinformation.googleapis.com') {
        return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ locations: opts.locations ?? [] }) })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
  }

  // Account-aware mock: routes the locations call by the account in its request
  // path ("…/accounts/{n}/locations") so account-selection tests can return a
  // different location set per account.
  function mockAccountsAndLocations(opts: {
    accounts: Array<{ name: string; accountName?: string }>
    locationsByAccount: Record<string, Array<{ name: string; title?: string }>>
  }) {
    fetchSpy.mockImplementation((url: string) => {
      let parsed: URL
      try { parsed = new URL(url) } catch { throw new Error(`Unexpected fetch URL: ${url}`) }
      if (parsed.hostname === 'mybusinessaccountmanagement.googleapis.com') {
        return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ accounts: opts.accounts }) })
      }
      if (parsed.hostname === 'mybusinessbusinessinformation.googleapis.com') {
        const account = parsed.pathname.match(/(accounts\/[^/]+)\/locations/)?.[1] ?? ''
        return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ locations: opts.locationsByAccount[account] ?? [] }) })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
  }

  describe('POST /gbp/locations/discover', () => {
    it('discovers locations and persists them with default selection=true', async () => {
      ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      mockGoogleResponses({
        accounts: [{ name: 'accounts/123', accountName: 'Hotel Group' }],
        locations: [
          { name: 'locations/1', title: 'Hotel One', websiteUri: 'https://one.example.com', categories: { primaryCategory: { displayName: 'Hotel' } } },
          { name: 'locations/2', title: 'Hotel Two', categories: { primaryCategory: { displayName: 'Resort' } } },
        ],
      })

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/projects/hotels/gbp/locations/discover',
        payload: {},
      })

      expect(res.statusCode).toBe(200)
      const body = res.json() as { locations: Array<{ locationName: string; selected: boolean; displayName: string }>; totalDiscovered: number; totalSelected: number }
      expect(body.totalDiscovered).toBe(2)
      expect(body.totalSelected).toBe(2)
      expect(body.locations.map(l => l.locationName).sort()).toEqual(['locations/1', 'locations/2'])
      expect(body.locations.every(l => l.selected)).toBe(true)
    })

    it('persists the Maps placeId + mapsUri from location metadata (#648)', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      mockGoogleResponses({
        accounts: [{ name: 'accounts/123' }],
        locations: [
          { name: 'locations/1', title: 'Hotel One', metadata: { placeId: 'ChIJoneplaceid', mapsUri: 'https://maps.google.com/?cid=1' } },
          { name: 'locations/2', title: 'Off-Maps Location' }, // no metadata → null
        ],
      })

      await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: {} })

      const rows = ctx.db.select().from(gbpLocations).where(eq(gbpLocations.projectId, projectId)).all()
      const one = rows.find(r => r.locationName === 'locations/1')!
      const two = rows.find(r => r.locationName === 'locations/2')!
      expect(one.placeId).toBe('ChIJoneplaceid')
      expect(one.mapsUri).toBe('https://maps.google.com/?cid=1')
      expect(two.placeId).toBeNull()
      expect(two.mapsUri).toBeNull()
    })

    it('persists the owner-content profile fields and surfaces them on the DTO', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      mockGoogleResponses({
        accounts: [{ name: 'accounts/123' }],
        locations: [{
          name: 'locations/1', title: 'AZ Coatings',
          categories: {
            primaryCategory: { displayName: 'Roofing contractor' },
            additionalCategories: [{ displayName: 'Insulation contractor' }, { displayName: 'Waterproofing service' }],
          },
          profile: { description: 'Commercial roof restoration and protective coatings.' },
          serviceArea: { businessType: 'CUSTOMER_LOCATION_ONLY' },
          regularHours: { periods: [{ openDay: 'MONDAY' }] },
          phoneNumbers: { primaryPhone: '(248) 925-7414' },
          openInfo: { status: 'OPEN', openingDate: { year: 2021, month: 12, day: 1 } },
        }],
      })

      const res = await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: {} })
      expect(res.statusCode).toBe(200)

      // The DB row carries the structured owner content (JSON columns parsed back).
      const row = ctx.db.select().from(gbpLocations).where(eq(gbpLocations.projectId, projectId)).all()[0]!
      expect(row.additionalCategories).toEqual(['Insulation contractor', 'Waterproofing service'])
      expect(row.description).toBe('Commercial roof restoration and protective coatings.')
      expect(row.serviceArea).toEqual({ businessType: 'CUSTOMER_LOCATION_ONLY' })
      expect(row.regularHours).toEqual({ periods: [{ openDay: 'MONDAY' }] })
      expect(row.primaryPhone).toBe('(248) 925-7414')
      expect(row.openStatus).toBe('OPEN')
      expect(row.openingDate).toBe('2021-12-01')

      // And the public location DTO surfaces them.
      const dto = (res.json() as { locations: Array<Record<string, unknown>> }).locations[0]!
      expect(dto.additionalCategories).toEqual(['Insulation contractor', 'Waterproofing service'])
      expect(dto.description).toBe('Commercial roof restoration and protective coatings.')
      expect(dto.primaryPhone).toBe('(248) 925-7414')
      expect(dto.openStatus).toBe('OPEN')
    })

    it('refreshes placeId on re-discover when Google later assigns one', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      // First discover: location not yet on Maps.
      mockGoogleResponses({ accounts: [{ name: 'accounts/123' }], locations: [{ name: 'locations/1', title: 'Hotel One' }] })
      await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: {} })
      expect(ctx.db.select().from(gbpLocations).where(eq(gbpLocations.projectId, projectId)).get()!.placeId).toBeNull()

      // Re-discover after Google assigns a Place ID.
      mockGoogleResponses({ accounts: [{ name: 'accounts/123' }], locations: [{ name: 'locations/1', title: 'Hotel One', metadata: { placeId: 'ChIJlater' } }] })
      await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: {} })
      expect(ctx.db.select().from(gbpLocations).where(eq(gbpLocations.projectId, projectId)).get()!.placeId).toBe('ChIJlater')
    })

    it('re-discover refreshes owner-content fields and clears ones Google no longer returns', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      // First discover: a location with full owner content.
      mockGoogleResponses({
        accounts: [{ name: 'accounts/123' }],
        locations: [{
          name: 'locations/1', title: 'AZ Coatings',
          categories: { primaryCategory: { displayName: 'Roofing contractor' }, additionalCategories: [{ displayName: 'Insulation contractor' }] },
          profile: { description: 'Original description.' },
          serviceArea: { businessType: 'CUSTOMER_LOCATION_ONLY' },
          phoneNumbers: { primaryPhone: '(248) 925-7414' },
          openInfo: { status: 'OPEN' },
        }],
      })
      await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: {} })

      // Re-discover: description + open state CHANGED; additionalCategories,
      // serviceArea, and phone REMOVED. Owner content is sync-not-merge (the
      // last Google response wins), so removed fields must clear, not linger.
      mockGoogleResponses({
        accounts: [{ name: 'accounts/123' }],
        locations: [{
          name: 'locations/1', title: 'AZ Coatings',
          categories: { primaryCategory: { displayName: 'Roofing contractor' } },
          profile: { description: 'Updated description.' },
          openInfo: { status: 'CLOSED_TEMPORARILY' },
        }],
      })
      await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: {} })

      const row = ctx.db.select().from(gbpLocations).where(eq(gbpLocations.projectId, projectId)).get()!
      // Changed fields refreshed:
      expect(row.description).toBe('Updated description.')
      expect(row.openStatus).toBe('CLOSED_TEMPORARILY')
      // Removed fields cleared:
      expect(row.additionalCategories).toEqual([])
      expect(row.serviceArea).toBeNull()
      expect(row.primaryPhone).toBeNull()
    })

    it('surfaces a pre-migration NULL owner-content row through the DTO defaults', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      // A row written before migration v81 — the 7 owner-content columns are NULL.
      const now = new Date().toISOString()
      ctx.db.insert(gbpLocations).values({
        id: 'loc-legacy', projectId, accountName: 'accounts/123', locationName: 'locations/9',
        displayName: 'Legacy Location', selected: true, createdAt: now, updatedAt: now,
      }).run()

      const res = await ctx.app.inject({ method: 'GET', url: '/projects/hotels/gbp/locations' })
      expect(res.statusCode).toBe(200)
      const dto = (res.json() as { locations: Array<Record<string, unknown>> }).locations.find(l => l.locationName === 'locations/9')!
      // The non-nullable array contract coalesces a NULL column to []; the rest stay null.
      expect(dto.additionalCategories).toEqual([])
      expect(dto.description).toBeNull()
      expect(dto.serviceArea).toBeNull()
      expect(dto.regularHours).toBeNull()
      expect(dto.primaryPhone).toBeNull()
      expect(dto.openStatus).toBeNull()
      expect(dto.openingDate).toBeNull()
    })

    it('respects selectAllNew=false for newly-discovered locations', async () => {
      ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      mockGoogleResponses({
        accounts: [{ name: 'accounts/123' }],
        locations: [{ name: 'locations/1', title: 'Hotel One' }],
      })

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/projects/hotels/gbp/locations/discover',
        payload: { selectAllNew: false },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json() as { totalSelected: number }
      expect(body.totalSelected).toBe(0)
    })

    it('preserves existing selection state on re-discover (idempotency)', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      mockGoogleResponses({
        accounts: [{ name: 'accounts/123' }],
        locations: [{ name: 'locations/1', title: 'Hotel One' }],
      })

      // First discover — selected=true by default
      await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: {} })
      // Manually deselect
      ctx.db.update(gbpLocations)
        .set({ selected: false, updatedAt: new Date().toISOString() })
        .where(eq(gbpLocations.projectId, projectId))
        .run()

      // Re-discover with selectAllNew=true should NOT overwrite the deselected location
      const res = await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: { selectAllNew: true } })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { locations: Array<{ selected: boolean }>; totalSelected: number }
      expect(body.totalSelected).toBe(0)
      expect(body.locations[0]!.selected).toBe(false)
    })

    it('returns 400 when no accounts are visible (instead of an unhandled crash)', async () => {
      ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      mockGoogleResponses({ accounts: [] })

      const res = await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: {} })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    })

    it('maps the 0-QPM access-form gate to a 429 QUOTA_EXCEEDED error (no retry)', async () => {
      ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      // `quota_limit_value: "0"` is the access-form gate. gbpFetchGet must
      // NOT retry this — the project hasn't been approved by Google, and
      // retrying just burns time. We verify that by mocking ONCE: if the
      // retry kicked in, the second fetch would resolve to undefined and
      // crash the test instead of producing a clean QUOTA_EXCEEDED.
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({
          error: {
            code: 429,
            message: "Quota exceeded for quota metric 'Requests'",
            status: 'RESOURCE_EXHAUSTED',
            details: [{
              reason: 'RATE_LIMIT_EXCEEDED',
              metadata: { quota_limit_value: '0', quota_unit: '1/min/{project}' },
            }],
          },
        }),
      })

      const res = await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: {} })
      expect(res.statusCode).toBe(429)
      expect(res.json()).toMatchObject({ error: { code: 'QUOTA_EXCEEDED' } })
      // The message must call out the access-form gate, not generic rate limiting.
      expect((res.json() as { error: { message: string } }).error.message).toMatch(/access form pending approval/i)
      // Single call — no retry burn.
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('writes an audit log entry on successful discover', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      mockGoogleResponses({
        accounts: [{ name: 'accounts/123' }],
        locations: [{ name: 'locations/1', title: 'Hotel One' }],
      })

      await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: {} })

      const logs = ctx.db.select().from(auditLog).where(eq(auditLog.projectId, projectId)).all() as { action: string }[]
      expect(logs.some(l => l.action === 'gbp.locations.discovered')).toBe(true)
    })
  })

  describe('PUT /gbp/locations/:locationName/selection', () => {
    it('toggles selection and writes audit log', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      mockGoogleResponses({
        accounts: [{ name: 'accounts/123' }],
        locations: [{ name: 'locations/1', title: 'Hotel One' }],
      })
      await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: {} })

      const res = await ctx.app.inject({
        method: 'PUT',
        url: `/projects/hotels/gbp/locations/${encodeURIComponent('locations/1')}/selection`,
        payload: { selected: false },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ locationName: 'locations/1', selected: false })

      const logs = ctx.db.select().from(auditLog).where(eq(auditLog.projectId, projectId)).all() as { action: string }[]
      expect(logs.some(l => l.action === 'gbp.location.deselected')).toBe(true)
    })

    it('returns 404 for an unknown location', async () => {
      ctx.seedProject('hotels', 'hotels.example.com')
      const res = await ctx.app.inject({
        method: 'PUT',
        url: `/projects/hotels/gbp/locations/${encodeURIComponent('locations/does-not-exist')}/selection`,
        payload: { selected: true },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('DELETE /gbp/connection', () => {
    it('removes the connection and all discovered locations', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      mockGoogleResponses({
        accounts: [{ name: 'accounts/123' }],
        locations: [
          { name: 'locations/1' },
          { name: 'locations/2' },
        ],
      })
      await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: {} })

      // Seed synced performance data across every GBP surface so we can prove
      // disconnect clears the whole footprint, not just the location rows.
      ctx.db.insert(gbpDailyMetrics).values({ id: crypto.randomUUID(), projectId, locationName: 'locations/1', date: '2026-05-01', metric: 'WEBSITE_CLICKS', value: 7, syncRunId: null }).run()
      ctx.db.insert(gbpKeywordImpressions).values({ id: crypto.randomUUID(), projectId, locationName: 'locations/1', periodStart: '2025-06', periodEnd: '2026-05', keyword: 'hotel', valueCount: 100, valueThreshold: null, syncRunId: null }).run()
      ctx.db.insert(gbpKeywordMonthly).values({ id: crypto.randomUUID(), projectId, locationName: 'locations/1', month: '2026-04', keyword: 'hotel', valueCount: 100, valueThreshold: null, syncRunId: null, syncedAt: '2026-05-01T00:00:00Z' }).run()
      ctx.db.insert(gbpPlaceActions).values({ id: crypto.randomUUID(), projectId, locationName: 'locations/1', placeActionLinkName: 'locations/1/placeActionLinks/x', placeActionType: 'BOOK', uri: 'https://book.example', isPreferred: true, providerType: 'MERCHANT', syncRunId: null }).run()
      ctx.db.insert(gbpLodgingSnapshots).values({ id: crypto.randomUUID(), projectId, locationName: 'locations/1', contentHash: 'h1', attributes: {}, populatedGroupCount: 0, syncedAt: '2026-05-01T00:00:00Z', syncRunId: null }).run()

      // Sanity: both locations persisted
      expect(ctx.db.select().from(gbpLocations).where(eq(gbpLocations.projectId, projectId)).all().length).toBe(2)
      // Sanity: connection exists
      expect(ctx.connections.find(c => c.domain === 'hotels.example.com' && c.connectionType === 'gbp')).toBeDefined()

      const res = await ctx.app.inject({ method: 'DELETE', url: '/projects/hotels/gbp/connection' })
      expect(res.statusCode).toBe(204)

      // gbp_locations rows for the project are gone
      expect(ctx.db.select().from(gbpLocations).where(eq(gbpLocations.projectId, projectId)).all().length).toBe(0)
      // Synced performance data is gone too — no stale rows survive a disconnect.
      expect(ctx.db.select().from(gbpDailyMetrics).where(eq(gbpDailyMetrics.projectId, projectId)).all().length).toBe(0)
      expect(ctx.db.select().from(gbpKeywordImpressions).where(eq(gbpKeywordImpressions.projectId, projectId)).all().length).toBe(0)
      expect(ctx.db.select().from(gbpKeywordMonthly).where(eq(gbpKeywordMonthly.projectId, projectId)).all().length).toBe(0)
      expect(ctx.db.select().from(gbpPlaceActions).where(eq(gbpPlaceActions.projectId, projectId)).all().length).toBe(0)
      expect(ctx.db.select().from(gbpLodgingSnapshots).where(eq(gbpLodgingSnapshots.projectId, projectId)).all().length).toBe(0)
      // Connection store entry is gone
      expect(ctx.connections.find(c => c.domain === 'hotels.example.com' && c.connectionType === 'gbp')).toBeUndefined()
    })
  })

  describe('account selection (per project)', () => {
    it('GET /gbp/accounts lists the accounts the connection can access', async () => {
      ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      mockAccountsAndLocations({
        accounts: [{ name: 'accounts/1', accountName: 'Hotel Group' }, { name: 'accounts/2', accountName: 'Other Biz' }],
        locationsByAccount: {},
      })
      const res = await ctx.app.inject({ method: 'GET', url: '/projects/hotels/gbp/accounts' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { accounts: { name: string; accountName: string | null }[]; total: number }
      expect(body.total).toBe(2)
      expect(body.accounts.map((a) => a.name)).toEqual(['accounts/1', 'accounts/2'])
      expect(body.accounts[0]!.accountName).toBe('Hotel Group')
    })

    it('discovers locations under an explicitly requested account (not just the first)', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      mockAccountsAndLocations({
        accounts: [{ name: 'accounts/1' }, { name: 'accounts/2' }],
        locationsByAccount: { 'accounts/2': [{ name: 'locations/9', title: 'Niche Hotel' }] },
      })
      const res = await ctx.app.inject({
        method: 'POST', url: '/projects/hotels/gbp/locations/discover',
        payload: { accountName: 'accounts/2' },
      })
      expect(res.statusCode).toBe(200)
      const rows = ctx.db.select().from(gbpLocations).where(eq(gbpLocations.projectId, projectId)).all()
      expect(rows.map((r) => r.locationName)).toEqual(['locations/9'])
      expect(rows.every((r) => r.accountName === 'accounts/2')).toBe(true)
    })

    it('rejects an account the connection cannot access', async () => {
      ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      mockAccountsAndLocations({ accounts: [{ name: 'accounts/1' }], locationsByAccount: {} })
      const res = await ctx.app.inject({
        method: 'POST', url: '/projects/hotels/gbp/locations/discover',
        payload: { accountName: 'accounts/999' },
      })
      expect(res.statusCode).toBe(400)
    })

    it('requires switchAccount to repoint a project, then clears the old account footprint', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      mockAccountsAndLocations({
        accounts: [{ name: 'accounts/1' }, { name: 'accounts/2' }],
        locationsByAccount: { 'accounts/1': [{ name: 'locations/1' }], 'accounts/2': [{ name: 'locations/2' }] },
      })
      // Initial discover under accounts/1, plus a synced metric for its location.
      await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: { accountName: 'accounts/1' } })
      ctx.db.insert(gbpDailyMetrics).values({ id: crypto.randomUUID(), projectId, locationName: 'locations/1', date: '2026-05-01', metric: 'WEBSITE_CLICKS', value: 5, syncRunId: null }).run()
      ctx.db.insert(gbpKeywordMonthly).values({ id: crypto.randomUUID(), projectId, locationName: 'locations/1', month: '2026-04', keyword: 'hotel', valueCount: 50, valueThreshold: null, syncRunId: null, syncedAt: '2026-05-01T00:00:00Z' }).run()

      // Re-pointing at accounts/2 without opting in is rejected; old data survives.
      const blocked = await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: { accountName: 'accounts/2' } })
      expect(blocked.statusCode).toBe(400)
      expect(ctx.db.select().from(gbpLocations).where(eq(gbpLocations.projectId, projectId)).all().map((r) => r.locationName)).toEqual(['locations/1'])
      expect(ctx.db.select().from(gbpDailyMetrics).where(eq(gbpDailyMetrics.projectId, projectId)).all().length).toBe(1)
      expect(ctx.db.select().from(gbpKeywordMonthly).where(eq(gbpKeywordMonthly.projectId, projectId)).all().length).toBe(1)

      // With switchAccount the old account's locations + data are replaced.
      const switched = await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: { accountName: 'accounts/2', switchAccount: true } })
      expect(switched.statusCode).toBe(200)
      const rows = ctx.db.select().from(gbpLocations).where(eq(gbpLocations.projectId, projectId)).all()
      expect(rows.map((r) => r.locationName)).toEqual(['locations/2'])
      expect(rows.every((r) => r.accountName === 'accounts/2')).toBe(true)
      expect(ctx.db.select().from(gbpDailyMetrics).where(eq(gbpDailyMetrics.projectId, projectId)).all().length).toBe(0)
      expect(ctx.db.select().from(gbpKeywordMonthly).where(eq(gbpKeywordMonthly.projectId, projectId)).all().length).toBe(0)
    })
  })

  describe('GET /gbp/summary scope', () => {
    it('covers only selected locations and reports a matching locationCount', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      const now = new Date().toISOString()
      // One selected location, one deselected — both carry synced metrics.
      for (const [loc, selected] of [['locations/1', true], ['locations/2', false]] as const) {
        ctx.db.insert(gbpLocations).values({
          id: crypto.randomUUID(), projectId, accountName: 'accounts/1', locationName: loc, displayName: loc,
          selected, createdAt: now, updatedAt: now,
        }).run()
      }
      ctx.db.insert(gbpDailyMetrics).values({ id: crypto.randomUUID(), projectId, locationName: 'locations/1', date: '2026-05-10', metric: 'WEBSITE_CLICKS', value: 10, syncRunId: null }).run()
      ctx.db.insert(gbpDailyMetrics).values({ id: crypto.randomUUID(), projectId, locationName: 'locations/2', date: '2026-05-10', metric: 'WEBSITE_CLICKS', value: 99, syncRunId: null }).run()

      const res = await ctx.app.inject({ method: 'GET', url: '/projects/hotels/gbp/summary' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { scope: { locationCount: number }; performance: { totals: Record<string, number> } }
      // The deselected location's 99 clicks must NOT count; only the selected 10.
      expect(body.performance.totals.WEBSITE_CLICKS).toBe(10)
      expect(body.scope.locationCount).toBe(1)
    })
  })

  describe('GET /gbp/places (#648)', () => {
    const mk = (projectId: string, id: string, loc: string, syncedAt: string, attrs: Record<string, unknown>, tier = 'atmosphere') =>
      ({ id, projectId, locationName: loc, placeId: `ChIJ${loc}`, contentHash: id, tier, attributes: attrs, syncedAt, syncRunId: null })

    it('returns the latest Place Details snapshot per location with derived amenities', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      ctx.db.insert(gbpPlaceDetails).values([
        mk(projectId, 'p_old', 'locations/1', '2026-05-01T00:00:00.000Z', { servesBreakfast: false }),
        mk(projectId, 'p_new', 'locations/1', '2026-05-20T00:00:00.000Z', { servesBreakfast: true, allowsDogs: true }),
        mk(projectId, 'p_2', 'locations/2', '2026-05-10T00:00:00.000Z', { parkingOptions: { freeParkingLot: true } }),
      ]).run()

      const res = await ctx.app.inject({ method: 'GET', url: '/projects/hotels/gbp/places' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { places: Array<{ locationName: string; placeId: string; tier: string; amenities: string[]; syncedAt: string }>; total: number }
      expect(body.total).toBe(2)
      const one = body.places.find((p) => p.locationName === 'locations/1')!
      // Latest snapshot wins; amenities are derived server-side (not in the row).
      expect(one.syncedAt).toBe('2026-05-20T00:00:00.000Z')
      expect(one.amenities).toEqual(['breakfast', 'pet-friendly'])
      expect(one.tier).toBe('atmosphere')
      expect(body.places.find((p) => p.locationName === 'locations/2')!.amenities).toEqual(['parking'])
    })

    it('filters to a single location via ?locationName', async () => {
      const projectId = ctx.seedProject('hotels', 'hotels.example.com')
      ctx.db.insert(gbpPlaceDetails).values([
        mk(projectId, 'a', 'locations/1', '2026-05-01T00:00:00.000Z', {}),
        mk(projectId, 'b', 'locations/2', '2026-05-01T00:00:00.000Z', {}),
      ]).run()
      const res = await ctx.app.inject({ method: 'GET', url: `/projects/hotels/gbp/places?locationName=${encodeURIComponent('locations/1')}` })
      const body = res.json() as { total: number; places: Array<{ locationName: string }> }
      expect(body.total).toBe(1)
      expect(body.places[0]!.locationName).toBe('locations/1')
    })

    it('returns an empty list for a project with no Places snapshots', async () => {
      ctx.seedProject('hotels', 'hotels.example.com')
      const res = await ctx.app.inject({ method: 'GET', url: '/projects/hotels/gbp/places' })
      expect(res.json()).toEqual({ places: [], total: 0 })
    })
  })
})
