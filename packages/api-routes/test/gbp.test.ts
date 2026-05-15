import crypto from 'node:crypto'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, gbpLocations, auditLog } from '@ainyc/canonry-db'
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
    locations?: Array<{ name: string; title?: string; websiteUri?: string; categories?: { primaryCategory?: { displayName?: string } } }>
  }) {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('mybusinessaccountmanagement.googleapis.com')) {
        return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ accounts: opts.accounts ?? [] }) })
      }
      if (url.includes('mybusinessbusinessinformation.googleapis.com')) {
        return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ locations: opts.locations ?? [] }) })
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

    it('maps RATE_LIMIT_EXCEEDED to a 429 QUOTA_EXCEEDED error', async () => {
      ctx.seedProject('hotels', 'hotels.example.com')
      ctx.seedGbpConnection('hotels.example.com', 'valid-access-token')
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { code: 429, message: "Quota exceeded for quota metric 'Requests'", status: 'RESOURCE_EXHAUSTED', details: [{ reason: 'RATE_LIMIT_EXCEEDED' }] } }),
      })

      const res = await ctx.app.inject({ method: 'POST', url: '/projects/hotels/gbp/locations/discover', payload: {} })
      expect(res.statusCode).toBe(429)
      expect(res.json()).toMatchObject({ error: { code: 'QUOTA_EXCEEDED' } })
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

      // Sanity: both locations persisted
      expect(ctx.db.select().from(gbpLocations).where(eq(gbpLocations.projectId, projectId)).all().length).toBe(2)
      // Sanity: connection exists
      expect(ctx.connections.find(c => c.domain === 'hotels.example.com' && c.connectionType === 'gbp')).toBeDefined()

      const res = await ctx.app.inject({ method: 'DELETE', url: '/projects/hotels/gbp/connection' })
      expect(res.statusCode).toBe(204)

      // gbp_locations rows for the project are gone
      expect(ctx.db.select().from(gbpLocations).where(eq(gbpLocations.projectId, projectId)).all().length).toBe(0)
      // Connection store entry is gone
      expect(ctx.connections.find(c => c.domain === 'hotels.example.com' && c.connectionType === 'gbp')).toBeUndefined()
    })
  })
})
