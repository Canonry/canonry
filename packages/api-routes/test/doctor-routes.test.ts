import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, projects, trafficSources } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'
import type { GoogleConnectionRecord, GoogleConnectionStore } from '../src/google.js'
import type { Ga4CredentialStore } from '../src/ga.js'
import type { VercelTrafficCredentialRecord, VercelTrafficCredentialStore } from '../src/traffic.js'
import { VercelLogsApiError } from '@ainyc/canonry-integration-vercel'
import { TrafficSourceStatuses, TrafficSourceTypes } from '@ainyc/canonry-contracts'
import type { DoctorReportDto } from '@ainyc/canonry-contracts'

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

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
  refreshAccessTokenMock.mockReset()
  listSitesMock.mockReset()
})

function makeStore(record?: Partial<GoogleConnectionRecord>): GoogleConnectionStore {
  const conn: GoogleConnectionRecord | undefined = record
    ? {
        domain: 'example.com',
        connectionType: 'gsc',
        propertyId: 'sc-domain:example.com',
        accessToken: 'access',
        refreshToken: 'refresh',
        tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: [
          'https://www.googleapis.com/auth/webmasters.readonly',
          'https://www.googleapis.com/auth/indexing',
        ],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        ...record,
      }
    : undefined
  return {
    listConnections: () => (conn ? [conn] : []),
    getConnection: () => conn,
    upsertConnection: (r) => r,
    updateConnection: () => conn,
    deleteConnection: () => true,
  }
}

function gaStoreEmpty(): Ga4CredentialStore {
  return {
    getConnection: () => undefined,
    upsertConnection: (r) => r,
    deleteConnection: () => true,
  }
}

function buildApp(opts: Partial<ApiRoutesOptions> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-doctor-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  db.insert(projects).values({
    id: crypto.randomUUID(),
    name: 'demo',
    displayName: 'Demo',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    ownedDomains: '[]',
    tags: '[]',
    providers: '[]',
    createdAt: '2026-04-18T14:00:00.000Z',
    updatedAt: '2026-04-18T14:00:00.000Z',
  }).run()

  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    ...opts,
  } satisfies ApiRoutesOptions)
  return { app, db }
}

describe('GET /api/v1/projects/:name/doctor', () => {
  it('returns 404 when the project does not exist', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/missing/doctor' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('runs all project-scoped checks when no filter is provided', async () => {
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'tok', expires_in: 3600 })
    listSitesMock.mockResolvedValue([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])
    const { app } = buildApp({
      googleConnectionStore: makeStore({}),
      ga4CredentialStore: gaStoreEmpty(),
      getGoogleAuthConfig: () => ({ clientId: 'client', clientSecret: 'secret' }),
      publicUrl: 'http://localhost:4100',
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/doctor' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as DoctorReportDto
    expect(body.scope).toBe('project')
    expect(body.project).toBe('demo')
    const ids = body.checks.map((c) => c.id).sort()
    expect(ids).toContain('google.auth.connection')
    expect(ids).toContain('google.auth.property-access')
    expect(ids).toContain('google.auth.redirect-uri')
    expect(ids).toContain('google.auth.scopes')
    expect(ids).toContain('ga.auth.connection')
    expect(ids).not.toContain('config.providers') // global-only
    await app.close()
  })

  it('filters checks via ?check=', async () => {
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'tok', expires_in: 3600 })
    listSitesMock.mockResolvedValue([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])
    const { app } = buildApp({
      googleConnectionStore: makeStore({}),
      getGoogleAuthConfig: () => ({ clientId: 'client', clientSecret: 'secret' }),
      publicUrl: 'http://localhost:4100',
    })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo/doctor?check=google.auth.connection',
    })
    const body = JSON.parse(res.payload) as DoctorReportDto
    expect(body.checks).toHaveLength(1)
    expect(body.checks[0]!.id).toBe('google.auth.connection')
    expect(body.checks[0]!.status).toBe('ok')
    await app.close()
  })

  it('supports wildcard filters via ?check=google.*', async () => {
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'tok', expires_in: 3600 })
    listSitesMock.mockResolvedValue([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])
    const { app } = buildApp({
      googleConnectionStore: makeStore({}),
      getGoogleAuthConfig: () => ({ clientId: 'client', clientSecret: 'secret' }),
      publicUrl: 'http://localhost:4100',
    })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo/doctor?check=google.*',
    })
    const body = JSON.parse(res.payload) as DoctorReportDto
    expect(body.checks.map((c) => c.id).every((id) => id.startsWith('google.'))).toBe(true)
    expect(body.checks.length).toBeGreaterThanOrEqual(4)
    await app.close()
  })

  it('builds redirect URI from publicUrl alone, ignoring routePrefix basePath', async () => {
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'tok', expires_in: 3600 })
    listSitesMock.mockResolvedValue([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])
    // Simulate a deployment behind a basePath proxy: publicUrl already includes
    // the basePath, and routePrefix also includes it. The redirect URI must
    // match what google.ts uses (publicUrl + /api/v1/google/callback) — not
    // double the basePath.
    const { app } = buildApp({
      googleConnectionStore: makeStore({}),
      getGoogleAuthConfig: () => ({ clientId: 'client', clientSecret: 'secret' }),
      publicUrl: 'https://example.com/canonry',
      routePrefix: '/canonry/api/v1',
    })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/canonry/api/v1/projects/demo/doctor?check=google.auth.redirect-uri',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as DoctorReportDto
    expect(body.checks).toHaveLength(1)
    expect(body.checks[0]!.details).toMatchObject({
      redirectUri: 'https://example.com/canonry/api/v1/google/callback',
    })
    await app.close()
  })
})

describe('traffic.source.credentials — Vercel validator', () => {
  function vercelStore(record?: VercelTrafficCredentialRecord): VercelTrafficCredentialStore {
    return {
      getConnection: (projectName) => (record && record.projectName === projectName ? record : undefined),
      upsertConnection: (r) => r,
      deleteConnection: () => true,
    }
  }

  const validRecord: VercelTrafficCredentialRecord = {
    projectName: 'demo',
    projectId: 'prj_abc',
    teamId: 'team_xyz',
    token: 'vcp_test_token',
    environment: 'production',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
  }

  function seedVercelSource(db: ReturnType<typeof createClient>) {
    const projectRow = db.select().from(projects).all()[0]!
    const now = new Date().toISOString()
    db.insert(trafficSources).values({
      id: 'src_vercel_doctor',
      projectId: projectRow.id,
      sourceType: TrafficSourceTypes.vercel,
      displayName: 'Vercel · prj_abc',
      status: TrafficSourceStatuses.connected,
      configJson: JSON.stringify({ projectId: 'prj_abc', teamId: 'team_xyz', environment: 'production' }),
      createdAt: now,
      updatedAt: now,
    }).run()
  }

  async function runCredentialsCheck(opts: Partial<ApiRoutesOptions>): Promise<DoctorReportDto> {
    const { app, db } = buildApp(opts)
    seedVercelSource(db)
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo/doctor?check=traffic.source.credentials',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as DoctorReportDto
    await app.close()
    return body
  }

  it('returns ok when the request-logs probe succeeds', async () => {
    const body = await runCredentialsCheck({
      vercelTrafficCredentialStore: vercelStore(validRecord),
      pullVercelTrafficEvents: async () => ({
        events: [],
        rawEntryCount: 0,
        skippedEntryCount: 0,
        hasMore: false,
        endpoint: 'https://vercel.com/api/logs/request-logs',
      }),
    })
    const check = body.checks.find((c) => c.id === 'traffic.source.credentials')!
    expect(check.status).toBe('ok')
    expect(check.code).toBe('traffic.credentials.ok')
  })

  it('fails with traffic.credentials.unauthorized on a 403 from request-logs', async () => {
    const body = await runCredentialsCheck({
      vercelTrafficCredentialStore: vercelStore(validRecord),
      pullVercelTrafficEvents: async () => {
        throw new VercelLogsApiError('Forbidden', 403, 'bad token')
      },
    })
    const check = body.checks.find((c) => c.id === 'traffic.source.credentials')!
    expect(check.status).toBe('fail')
    const detail = check.details as { sources: Array<{ code: string }> }
    expect(detail.sources[0]!.code).toBe('traffic.credentials.unauthorized')
  })

  it('fails with traffic.credentials.missing when no credential is stored', async () => {
    const body = await runCredentialsCheck({
      // Store has no record for this project.
      vercelTrafficCredentialStore: vercelStore(),
      pullVercelTrafficEvents: async () => ({
        events: [],
        rawEntryCount: 0,
        skippedEntryCount: 0,
        hasMore: false,
        endpoint: 'https://vercel.com/api/logs/request-logs',
      }),
    })
    const check = body.checks.find((c) => c.id === 'traffic.source.credentials')!
    expect(check.status).toBe('fail')
    const detail = check.details as { sources: Array<{ code: string }> }
    expect(detail.sources[0]!.code).toBe('traffic.credentials.missing')
  })
})

describe('GET /api/v1/doctor', () => {
  it('runs global checks and excludes project-scoped ones', async () => {
    const { app } = buildApp({
      providerSummary: [
        { name: 'gemini', configured: true },
        { name: 'openai', configured: false },
      ],
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/v1/doctor' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as DoctorReportDto
    expect(body.scope).toBe('global')
    expect(body.project).toBeNull()
    const ids = body.checks.map((c) => c.id)
    expect(ids).toContain('config.providers')
    expect(ids).not.toContain('google.auth.connection')
    await app.close()
  })
})
