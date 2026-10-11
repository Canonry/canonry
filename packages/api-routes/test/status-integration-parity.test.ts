import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import tls from 'node:tls'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { adsConnections, createClient, gbpLocations, migrate, projects, runs, trafficSources } from '@ainyc/canonry-db'
import { instanceStatusDtoSchema, type RunKind } from '@ainyc/canonry-contracts'
import { statusRoutes, type StatusRoutesOptions } from '../src/status.js'
import { INTEGRATION_SYNC_CHECKS } from '../src/doctor/checks/integration-sync.js'
import type { GoogleMarketingDoctorInput } from '../src/doctor/checks/google-marketing.js'

const DAY = 86_400_000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString()
afterEach(() => vi.restoreAllMocks())

async function fixture() {
  const db = createClient(':memory:')
  migrate(db)
  const project = { id: 'p', name: 'demo', displayName: 'Demo', canonicalDomain: 'demo.example' }
  db.insert(projects).values({ ...project, country: 'US', language: 'en', createdAt: daysAgo(60), updatedAt: daysAgo(60) }).run()
  db.insert(gbpLocations).values({ id: 'location', projectId: 'p', accountName: 'accounts/1', locationName: 'locations/1', displayName: 'Demo', selected: true, createdAt: daysAgo(60), updatedAt: daysAgo(60) }).run()
  db.insert(adsConnections).values({ id: 'ads', projectId: 'p', adAccountId: 'account-1', createdAt: daysAgo(60), updatedAt: daysAgo(60) }).run()
  for (const id of ['fresh', 'lagged', 'archived']) db.insert(trafficSources).values({ id, projectId: 'p', sourceType: 'cloudflare', displayName: id, status: 'active', lastSyncedAt: daysAgo(id === 'fresh' ? 0 : 4 / 24), archivedAt: id === 'archived' ? daysAgo(1) : null, createdAt: daysAgo(60), updatedAt: daysAgo(60) }).run()
  const marketing: GoogleMarketingDoctorInput = {
    googleAds: { credentialsPresent: true, grantedScopes: [], selectedLoginCustomerId: null, selectedCustomerId: '1', latestSnapshotAt: null },
    gtm: { credentialsPresent: true, grantedScopes: [], selectedAccountId: '1', selectedContainerId: '1', selectedWorkspaceId: '1', latestSnapshotAt: null },
  }
  const options: StatusRoutesOptions = {
    db,
    googleConnectionStore: { getConnection: () => ({ createdAt: daysAgo(60) }) } as unknown as StatusRoutesOptions['googleConnectionStore'],
    bingConnectionStore: { getConnection: () => ({}) } as unknown as StatusRoutesOptions['bingConnectionStore'],
    getGoogleMarketingDoctorInput: () => marketing,
  }
  const app = Fastify()
  await app.register(statusRoutes, options)
  const addRun = (kind: RunKind, status: string, days: number, sourceId: string | null = null) => db.insert(runs).values({ id: crypto.randomUUID(), projectId: 'p', kind, status, sourceId, trigger: 'scheduled', createdAt: daysAgo(days), finishedAt: daysAgo(days), error: status === 'failed' ? 'Synthetic DNS failure' : null }).run()
  const read = async () => {
    const result = await app.inject({ url: '/status' })
    expect(result.statusCode).toBe(200)
    return instanceStatusDtoSchema.parse(result.json()).projects[0]!.integrations
  }
  const close = async () => { await app.close(); db.$client.close() }
  return { db, app, project, options, addRun, read, close }
}

describe('stored status integration parity', () => {
  it('matches all five doctor streak readers without any provider or host probe', async () => {
    const f = await fixture()
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected provider call'))
    const lookup = vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('unexpected DNS call'))
    const connect = vi.spyOn(tls, 'connect').mockImplementation(() => { throw new Error('unexpected TLS call') })
    try {
      for (const kind of ['gsc-sync', 'ga-sync', 'gbp-sync', 'google-ads-sync', 'gtm-sync'] as const) {
        f.addRun(kind, 'completed', 10)
        for (const days of [4, 3, 2, 1]) f.addRun(kind, 'failed', days)
      }
      const rows = await f.read()
      for (const integration of ['gsc', 'ga', 'gbp', 'google-ads', 'gtm']) {
        const row = rows.find(value => value.integration === integration)!
        const check = INTEGRATION_SYNC_CHECKS.find(value => value.id === `${integration}.sync.recent-failures`)!
        const verdict = await check.run({ ...f.options, project: f.project })
        expect(row.state).toBe('failing')
        expect(verdict.details).toMatchObject({ consecutiveFailures: row.consecutiveFailures, latestRunAt: row.latestRunAt, lastSuccessAt: row.lastSuccessAt, latestError: row.latestError })
      }
      expect(fetch).not.toHaveBeenCalled()
      expect(lookup).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled()
    } finally { await f.close() }
  })

  it('keeps integration freshness thresholds and each traffic source independent', async () => {
    const f = await fixture()
    try {
      for (const kind of ['gsc-sync', 'ga-sync', 'gbp-sync', 'ads-sync', 'google-ads-sync', 'gtm-sync', 'bing-inspect-sitemap'] as const) f.addRun(kind, 'completed', 3.5)
      for (const sourceId of ['fresh', 'lagged', 'archived']) f.addRun('traffic-sync', 'completed', 0, sourceId)
      const rows = await f.read()
      expect(Object.fromEntries(rows.filter(row => row.integration !== 'traffic').map(row => [row.integration, row.state]))).toEqual({ gsc: 'stale', ga: 'stale', gbp: 'ok', bing: 'ok', ads: 'ok', 'google-ads': 'ok', gtm: 'ok' })
      expect(rows.filter(row => row.integration === 'traffic').map(row => ({ sourceId: row.sourceId, state: row.state })).sort((a, b) => a.sourceId!.localeCompare(b.sourceId!))).toEqual([{ sourceId: 'fresh', state: 'ok' }, { sourceId: 'lagged', state: 'stale' }])
      dbAgeAllRuns(f.db, daysAgo(8))
      const oldRows = await f.read()
      expect(oldRows.filter(row => !['bing', 'traffic'].includes(row.integration)).every(row => row.state === 'stale')).toBe(true)
    } finally { await f.close() }
  })

  it('reports never-synced connections and hides disconnected integrations with old failures', async () => {
    const f = await fixture()
    try {
      expect((await f.read()).every(row => row.state === 'never-synced')).toBe(true)
      f.addRun('gsc-sync', 'failed', 1)
      f.options.googleConnectionStore!.getConnection = () => undefined
      expect((await f.read()).some(row => ['gsc', 'ga', 'gbp'].includes(row.integration))).toBe(false)
    } finally { await f.close() }
  })
})

function dbAgeAllRuns(db: ReturnType<typeof createClient>, time: string) {
  db.update(runs).set({ createdAt: time, finishedAt: time }).where(eq(runs.projectId, 'p')).run()
}
