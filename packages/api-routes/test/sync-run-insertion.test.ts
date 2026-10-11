import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RunKinds,
  RunStatuses,
  RunTriggers,
  TrafficSourceStatuses,
  TrafficSourceTypes,
  type RunKind,
} from '@ainyc/canonry-contracts'
import {
  adsConnections,
  createClient,
  gbpLocations,
  googleAdsConnections,
  gtmConnections,
  migrate,
  projects,
  runs,
  trafficSources,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { syncRunClaimKey } from '../src/helpers.js'

const NOW = '2026-10-11T12:00:00.000Z'
const activeContexts: Array<{ app: ReturnType<typeof Fastify>; tmpDir: string }> = []

describe('scheduled sync trigger insertion boundary', () => {
  afterEach(async () => {
    for (const context of activeContexts.splice(0)) {
      await context.app.close()
      fs.rmSync(context.tmpDir, { recursive: true, force: true })
    }
  })

  it('stores scheduled on every sync insertion path when the host claim matches', async () => {
    const context = await buildApp()
    const { app, db, claims, projectId } = context

    seedConnections(db, projectId)
    const expected: Array<{ kind: RunKind; sourceId?: string; request: () => Promise<{ statusCode: number }> }> = [
      { kind: RunKinds['gsc-sync'], request: () => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/google/gsc/sync', payload: {} }) },
      { kind: RunKinds['bing-inspect-sitemap'], request: () => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/bing/inspect-sitemap', payload: {} }) },
      { kind: RunKinds['ga-sync'], request: () => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/ga/sync', payload: {} }) },
      { kind: RunKinds['gbp-sync'], request: () => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/gbp/sync', payload: {} }) },
      { kind: RunKinds['ads-sync'], request: () => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/ads/sync', payload: {} }) },
      { kind: RunKinds['google-ads-sync'], request: () => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/google-ads/sync', payload: {} }) },
      { kind: RunKinds['gtm-sync'], request: () => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/gtm/sync', payload: {} }) },
      { kind: RunKinds['traffic-sync'], sourceId: 'cloud-run-source', request: () => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/traffic/sources/cloud-run-source/sync', payload: {} }) },
      { kind: RunKinds['traffic-sync'], sourceId: 'queue-source', request: () => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/traffic/sources/queue-source/sync', payload: {} }) },
    ]

    for (const item of expected) {
      claims.add(syncRunClaimKey('status-project', item.kind, item.sourceId))
      const response = await item.request()
      const row = db.select().from(runs).all().find(candidate => candidate.kind === item.kind && candidate.sourceId === (item.sourceId ?? null))
      if (!row) throw new Error(`missing run for ${item.kind} ${item.sourceId ?? ''}, status ${response.statusCode} body ${response.body}`)
      expect(row?.trigger, item.kind).toBe(RunTriggers.scheduled)
    }
  })

  it('keeps forged request provenance manual and releases claims after refusal and dedupe', async () => {
    const context = await buildApp()
    const { app, db, claims } = context
    seedConnections(db, context.projectId)

    const scheduledKey = syncRunClaimKey('status-project', RunKinds['gsc-sync'])
    claims.add(scheduledKey)
    const refused = await app.inject({ method: 'POST', url: '/api/v1/projects/status-project/google/gsc/sync', headers: { 'x-canonry-surface': 'system' }, payload: {} })
    expect(refused.statusCode).toBe(200)
    expect(claims.has(scheduledKey)).toBe(false)

    const manual = await app.inject({ method: 'POST', url: '/api/v1/projects/status-project/google/gsc/sync', headers: { 'x-canonry-surface': 'system' }, payload: { trigger: 'scheduled' } })
    expect(manual.statusCode).toBe(200)
    const gscRows = db.select().from(runs).all().filter(row => row.kind === RunKinds['gsc-sync'])
    expect(gscRows.at(-1)?.trigger).toBe(RunTriggers.manual)

    const adsKey = syncRunClaimKey('status-project', RunKinds['ads-sync'])
    claims.add(adsKey)
    db.insert(runs).values({ id: crypto.randomUUID(), projectId: context.projectId, kind: RunKinds['ads-sync'], status: RunStatuses.running, trigger: RunTriggers.manual, createdAt: NOW }).run()
    const deduped = await app.inject({ method: 'POST', url: '/api/v1/projects/status-project/ads/sync', payload: {} })
    expect(deduped.statusCode).toBe(200)
    expect(claims.has(adsKey)).toBe(true)
    claims.delete(adsKey)
  })
})

async function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b3-sync-insertion-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'status-project', displayName: 'Status Project', canonicalDomain: 'example.com',
    country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()

  const claims = new Set<string>()
  const googleConnections = new Map<string, { domain: string; connectionType: string; createdAt: string; updatedAt: string; accessToken: string; refreshToken: string; tokenExpiresAt: string; propertyId?: string }>()
  googleConnections.set('example.com:gsc', { domain: 'example.com', connectionType: 'gsc', accessToken: 'token', refreshToken: 'refresh', tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(), propertyId: 'sc-domain:example.com', createdAt: NOW, updatedAt: NOW })
  googleConnections.set('example.com:gbp', { domain: 'example.com', connectionType: 'gbp', accessToken: 'token', refreshToken: 'refresh', tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: NOW, updatedAt: NOW })
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    googleConnectionStore: {
      getConnection: (domain: string, connectionType: string) => googleConnections.get(`${domain}:${connectionType}`),
      listConnections: (domain: string) => [...googleConnections.values()].filter(connection => connection.domain === domain),
      upsertConnection: (connection: never) => connection,
      updateConnection: () => undefined,
      deleteConnection: () => true,
    } as never,
    bingConnectionStore: {
      getConnection: () => ({ domain: 'example.com', apiKey: 'bing-key', siteUrl: 'https://example.com/', createdAt: NOW, updatedAt: NOW }),
      upsertConnection: (connection: never) => connection,
      updateConnection: () => undefined,
      deleteConnection: () => true,
    } as never,
    ga4CredentialStore: {
      getConnection: () => ({ projectName: 'status-project', propertyId: '123', clientEmail: 'test@example.com', privateKey: 'key', createdAt: NOW, updatedAt: NOW }),
      upsertConnection: (connection: never) => connection,
      deleteConnection: () => true,
    },
    adsCredentialStore: {
      getConnection: () => ({ projectName: 'status-project', apiKey: 'ads-key', adAccountId: 'account', createdAt: NOW, updatedAt: NOW }),
      upsertConnection: (entry: never) => entry,
      removeConnection: () => true,
    },
    googleMarketingCredentialStore: {
      get: (_project: { id: string; name: string }, _provider: string) => ({ accessToken: 'token', refreshToken: 'refresh', expiresAt: new Date(Date.now() + 3600000).toISOString(), scopes: ['*'], createdAt: NOW, updatedAt: NOW }),
      upsert: () => undefined,
      delete: () => true,
      hasGoogleAdsDeveloperToken: () => true,
    },
    onGscSyncRequested: () => undefined,
    onInspectSitemapRequested: () => undefined,
    onGbpSyncRequested: () => undefined,
    onAdsSyncRequested: () => undefined,
    onGoogleAdsSyncRequested: () => undefined,
    onGtmSyncRequested: () => undefined,
    cloudRunCredentialStore: {
      getConnection: () => ({ projectName: 'status-project', gcpProjectId: 'gcp', authMode: 'service-account', createdAt: NOW, updatedAt: NOW }),
      upsertConnection: (record: never) => record,
      deleteConnection: () => true,
    },
    pullCloudRunEvents: async () => ({ events: [], rawEntryCount: 0, skippedEntryCount: 0, filter: 'test' }),
    cloudflareTrafficCredentialStore: {
      getConnection: () => ({ projectName: 'status-project', sourceId: 'queue-source', deliveryMode: 'queue-pull', apiToken: 'token', accountId: 'account', queueId: 'queue', queueName: 'queue', retentionSeconds: 60, workerVersion: 'test', expectedBotListVersion: 'test', zoneId: null, createdAt: NOW, updatedAt: NOW }),
      getConnectionBySourceId: () => ({ projectName: 'status-project', sourceId: 'queue-source', deliveryMode: 'queue-pull', apiToken: 'token', accountId: 'account', queueId: 'queue', queueName: 'queue', retentionSeconds: 60, workerVersion: 'test', expectedBotListVersion: 'test', zoneId: null, createdAt: NOW, updatedAt: NOW }),
      upsertConnection: (record: never) => record,
      deleteConnection: () => true,
    },
    pullCloudflareQueueMessages: async () => ({ messageBacklogCount: 0, messages: [], skippedUnleasedMessageCount: 0 }),
    ackCloudflareQueueMessages: async () => ({ acknowledgedLeaseIds: [], retriedLeaseIds: [], warningCount: 0 }),
    claimScheduledSync: (projectName: string, kind: RunKind, sourceId?: string) => claims.delete(syncRunClaimKey(projectName, kind, sourceId)),
    googleStateSecret: 'b3-test-secret-32-bytes-long-enough',
  })
  await app.ready()
  activeContexts.push({ app, tmpDir })
  return { app, db, tmpDir, claims, projectId }
}

function seedConnections(db: ReturnType<typeof createClient>, projectId: string): void {
  db.insert(gbpLocations).values({ id: crypto.randomUUID(), projectId, accountName: 'accounts/1', locationName: 'locations/1', displayName: 'Status', selected: true, createdAt: NOW, updatedAt: NOW } as never).run()
  db.insert(adsConnections).values({ id: crypto.randomUUID(), projectId, adAccountId: 'account', createdAt: NOW, updatedAt: NOW }).run()
  db.insert(googleAdsConnections).values({ id: crypto.randomUUID(), projectId, scopes: [], selectionGeneration: 0, createdAt: NOW, updatedAt: NOW }).run()
  db.insert(gtmConnections).values({ id: crypto.randomUUID(), projectId, scopes: [], selectionGeneration: 0, createdAt: NOW, updatedAt: NOW }).run()
  db.insert(trafficSources).values([
    { id: 'cloud-run-source', projectId, sourceType: TrafficSourceTypes['cloud-run'], displayName: 'Cloud Run', status: TrafficSourceStatuses.connected, configJson: {}, createdAt: NOW, updatedAt: NOW },
    { id: 'queue-source', projectId, sourceType: TrafficSourceTypes.cloudflare, displayName: 'Queue', status: TrafficSourceStatuses.connected, configJson: { schemaVersion: 1, deliveryMode: 'queue-pull', accountId: 'account', queueId: 'queue', queueName: 'queue', retentionSeconds: 60, workerVersion: 'test', expectedBotListVersion: 'test', zoneId: null }, createdAt: NOW, updatedAt: NOW },
  ] as never).run()
}
