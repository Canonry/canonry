import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunKinds, RunStatuses, RunTriggers } from '@canonry/canonry-contracts'
import {
  bingKeywordDemand, bingQueryStats, createClient, gscDataWatermarks, gscDailyTotals, gscUrlInspections,
  migrate, projects, runs, sitemapListSyncs,
} from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { GoogleConnectionRecord } from '../src/google.js'
import type { BingConnectionRecord } from '../src/bing.js'

const date = '2026-04-01'
const now = date + 'T00:00:00Z'
const domain = 'example.com'
const oldSite = 'https://example.com/'
const newSite = 'https://example.com/new/'
const sitemap = 'https://example.com/custom-map.xml'

function fixture() {
  const db = createClient(':memory:')
  migrate(db)
  const app = Fastify()
  let google: GoogleConnectionRecord | undefined = {
    domain, connectionType: 'gsc', propertyId: oldSite, sitemapUrl: sitemap, accessToken: 'test', refreshToken: 'test',
    tokenExpiresAt: '2099-01-01T00:00:00Z', createdAt: now, updatedAt: now,
  }
  let bing: BingConnectionRecord | undefined = { domain, apiKey: 'test', siteUrl: oldSite, createdAt: now, updatedAt: now }
  app.register(apiRoutes, {
    db, skipAuth: true, googleStateSecret: 'test-google-state-secret',
    getGoogleAuthConfig: () => ({ clientId: 'test', clientSecret: 'test' }),
    googleConnectionStore: {
      getConnection: () => google,
      listConnections: () => google ? [google] : [],
      upsertConnection: record => google = record,
      updateConnection: (_domain, _type, patch) => google && Object.assign(google, patch),
      deleteConnection: () => {
        google = undefined
        return true
      },
    },
    bingConnectionStore: {
      getConnection: () => bing,
      upsertConnection: record => bing = record,
      updateConnection: (_domain, patch) => bing && Object.assign(bing, patch),
      deleteConnection: () => {
        bing = undefined
        return true
      },
    },
  })
  for (const id of ['owner', 'sibling', 'unrelated']) {
    db.insert(projects).values({ id, name: id, displayName: id, canonicalDomain: id === 'unrelated' ? 'elsewhere.test' : domain, country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
    db.insert(gscDailyTotals).values({ id, projectId: id, date, clicks: 7, impressions: 9, position: '2', createdAt: now }).run()
    db.insert(gscDataWatermarks).values({ projectId: id, dataThroughDate: date, updatedAt: now }).run()
    db.insert(bingQueryStats).values({ id, projectId: id, date, query: 'old site', clicks: 7, impressions: 9, syncedAt: now }).run()
    db.insert(bingKeywordDemand).values({ id, projectId: id, date, query: 'market demand', country: 'US', language: 'en', impressions: 11, broadImpressions: 15, syncedAt: now }).run()
    for (const engine of ['google', 'bing']) db.insert(sitemapListSyncs).values({ projectId: id, engine, syncedAt: now }).run()
  }
  return { app, db }
}

describe('stored evidence after selecting a search property', () => {
  let context: ReturnType<typeof fixture>
  beforeEach(async () => {
    context = fixture()
    await context.app.ready()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await context.app.close()
    context.db.$client.close()
  })

  it.each(['google', 'bing'] as const)('replacing the %s site waits for a shared sync and clears only evidence from the former site', async engine => {
    const { app, db } = context
    const isGoogle = engine === 'google'
    const select = (site: string) => isGoogle
      ? app.inject({ method: 'PUT', url: '/api/v1/projects/owner/google/connections/gsc/property', payload: { propertyId: site } })
      : app.inject({ method: 'POST', url: '/api/v1/projects/owner/bing/set-site', payload: { siteUrl: site } })
    const table = isGoogle ? gscDailyTotals : bingQueryStats
    const storedProjects = () => db.select({ id: table.projectId }).from(table).orderBy(table.projectId).all().map(row => row.id)
    db.insert(runs).values({ id: 'active', projectId: 'sibling', kind: isGoogle ? RunKinds['gsc-sync'] : RunKinds['bing-sync'], status: RunStatuses.running, trigger: RunTriggers.manual, createdAt: now }).run()
    expect((await select('https://EXAMPLE.com')).statusCode).toBe(200)
    expect((await select(newSite)).statusCode).toBe(409)
    expect(storedProjects()).toEqual(['owner', 'sibling', 'unrelated'])
    db.update(runs).set({ status: RunStatuses.completed }).where(eq(runs.id, 'active')).run()
    expect((await select(newSite)).statusCode).toBe(200)
    expect(storedProjects()).toEqual(['unrelated'])
    expect(db.select().from(sitemapListSyncs).where(eq(sitemapListSyncs.engine, engine)).all().map(row => row.projectId)).toEqual(['unrelated'])
    expect(db.select().from(sitemapListSyncs).where(eq(sitemapListSyncs.engine, isGoogle ? 'bing' : 'google')).all()).toHaveLength(3)
    expect(db.select().from(gscDataWatermarks).all()).toHaveLength(isGoogle ? 1 : 3)
    expect(db.select().from(bingKeywordDemand).all()).toHaveLength(3)
  })

  it('discards a single URL inspection returned after the Google property changed', async () => {
    const { app, db } = context
    const started = Promise.withResolvers<void>()
    const result = Promise.withResolvers<Response>()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      started.resolve()
      return result.promise
    })
    const inspection = app.inject({ method: 'POST', url: '/api/v1/projects/owner/google/gsc/inspect', payload: { url: oldSite } }).then(response => response)
    await started.promise
    expect((await app.inject({ method: 'PUT', url: '/api/v1/projects/owner/google/connections/gsc/property', payload: { propertyId: newSite } })).statusCode).toBe(200)
    result.resolve(Response.json({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } }))
    expect((await inspection).statusCode).toBe(409)
    expect(db.select().from(gscUrlInspections).all()).toEqual([])
  })

  it('keeps an authorized sitemap across Google consent and drops it when the selected property excludes it', async () => {
    const { app } = context
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ access_token: 'fresh', refresh_token: 'fresh', expires_in: 3600 }))
    const projectUrl = '/api/v1/projects/owner/google'
    const start = await app.inject({ method: 'POST', url: projectUrl + '/connect', payload: { type: 'gsc' } })
    const authorization = start.json<{ authUrl: string; redirectUri: string }>()
    const state = new URL(authorization.authUrl).searchParams.get('state')!
    const callback = new URL(authorization.redirectUri)
    callback.search = new URLSearchParams({ state, code: 'test' }).toString()
    expect((await app.inject({ method: 'GET', url: callback.pathname + callback.search })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: projectUrl + '/connections' })).json()).toMatchObject([{ propertyId: oldSite, sitemapUrl: sitemap }])
    const select = (propertyId: string) => app.inject({ method: 'PUT', url: projectUrl + '/connections/gsc/property', payload: { propertyId } })
    expect((await select('sc-domain:example.com')).json()).toMatchObject({ sitemapUrl: sitemap })
    expect((await select(newSite)).json()).toMatchObject({ sitemapUrl: null })
  })
})
