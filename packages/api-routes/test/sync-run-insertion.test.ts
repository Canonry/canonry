import { eq } from 'drizzle-orm'
import type { GoogleConnectionRecord } from '../src/google.js'
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
} from '@canonry/canonry-contracts'
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
} from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'
import { syncRunClaimKey } from '../src/helpers.js'

const NOW = '2026-10-11T12:00:00.000Z'
const activeContexts: Array<{ app: ReturnType<typeof Fastify>; tmpDir: string; db: ReturnType<typeof createClient> }> = []

describe('scheduled sync trigger insertion boundary', () => {
  afterEach(async () => {
    for (const context of activeContexts.splice(0)) {
      await context.app.close()
      context.db.$client.close()
      fs.rmSync(context.tmpDir, { recursive: true, force: true })
    }
  })

  it('stores scheduled on every sync insertion path when the host claim matches', async () => {
    const context = await buildApp()
    const { app, db, claims, projectId } = context

    seedConnections(db, projectId)
    const expected: Array<{ kind: RunKind; sourceId?: string; request: SyncRequest }> = [
      { kind: RunKinds['gsc-sync'], request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/google/gsc/sync', headers, payload }) },
      { kind: RunKinds['bing-inspect-sitemap'], request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/bing/inspect-sitemap', headers, payload }) },
      { kind: RunKinds['ga-sync'], request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/ga/sync', headers, payload }) },
      { kind: RunKinds['gbp-sync'], request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/gbp/sync', headers, payload }) },
      { kind: RunKinds['ads-sync'], request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/ads/sync', headers, payload }) },
      { kind: RunKinds['google-ads-sync'], request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/google-ads/sync', headers, payload }) },
      { kind: RunKinds['gtm-sync'], request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/gtm/sync', headers, payload }) },
      { kind: RunKinds['traffic-sync'], sourceId: 'cloud-run-source', request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/traffic/sources/cloud-run-source/sync', headers, payload }) },
      { kind: RunKinds['traffic-sync'], sourceId: 'queue-source', request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/traffic/sources/queue-source/sync', headers, payload }) },
    ]

    for (const item of expected) {
      claims.add(syncRunClaimKey('status-project', item.kind, item.sourceId))
      const response = await item.request()
      const row = db.select().from(runs).all().find(candidate => candidate.kind === item.kind && candidate.sourceId === (item.sourceId ?? null))
      if (!row) throw new Error(`missing run for ${item.kind} ${item.sourceId ?? ''}, status ${response.statusCode} body ${response.body}`)
      expect(row?.trigger, item.kind).toBe(RunTriggers.scheduled)
    }
  })

  it('keeps every unclaimed forged request manual across all insertion paths', async () => {
    const context = await buildApp()
    const { app, db, claims } = context
    seedConnections(db, context.projectId)
    for (const item of syncRequests(app)) {
      const response = await item.request({ 'x-canonry-surface': 'system' }, { trigger: 'scheduled' })
      expect(response.statusCode, item.kind).toBeGreaterThanOrEqual(200)
      expect(response.statusCode, item.kind).toBeLessThan(600)
      const row = db.select().from(runs).all().find(candidate => candidate.kind === item.kind && candidate.sourceId === (item.sourceId ?? null))
      expect(row?.trigger, item.kind).toBe(RunTriggers.manual)
      expect(claims.has(syncRunClaimKey('status-project', item.kind, item.sourceId)), item.kind).toBe(false)
    }
  })

  it('allows a manual request after a pre-insert refusal', async () => {
    const context = await buildApp()
    const { app, db, claims, googleConnections } = context
    const key = syncRunClaimKey('status-project', RunKinds['gsc-sync'])
    claims.add(key)
    const saved = googleConnections.get('example.com:gsc')
    googleConnections.delete('example.com:gsc')
    try {
      const refused = await app.inject({ method: 'POST', url: '/api/v1/projects/status-project/google/gsc/sync', payload: {} })
      expect(refused.statusCode).toBe(400)
    } finally {
      googleConnections.set('example.com:gsc', saved!)
      claims.delete(key)
    }
    const manual = await app.inject({ method: 'POST', url: '/api/v1/projects/status-project/google/gsc/sync', payload: {} })
    expect(manual.statusCode).toBe(200)
    expect(db.select().from(runs).all().filter(row => row.kind === RunKinds['gsc-sync']).at(-1)?.trigger).toBe(RunTriggers.manual)
  })

  it('preserves a consolidated run and admits a new manual run after it completes', async () => {
    const context = await buildApp()
    const { app, db, claims } = context
    seedConnections(db, context.projectId)
    const key = syncRunClaimKey('status-project', RunKinds['ads-sync'])
    claims.add(key)
    const existingId = crypto.randomUUID()
    db.insert(runs).values({ id: existingId, projectId: context.projectId, kind: RunKinds['ads-sync'], status: RunStatuses.running, trigger: RunTriggers.manual, createdAt: NOW }).run()
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/status-project/ads/sync', payload: {} })).statusCode).toBe(200)
    expect(claims.has(key)).toBe(true)
    expect(db.select().from(runs).all()).toHaveLength(1)
    expect(db.select().from(runs).get()).toMatchObject({ id: existingId, trigger: RunTriggers.manual })
    claims.delete(key)
    db.update(runs).set({ status: RunStatuses.completed, finishedAt: NOW }).where(eq(runs.id, existingId)).run()
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/status-project/ads/sync', payload: {} })).statusCode).toBe(200)
    const rows = db.select().from(runs).all().filter(row => row.kind === RunKinds['ads-sync'])
    expect(rows).toHaveLength(2)
    expect(rows.find(row => row.id !== existingId)?.trigger).toBe(RunTriggers.manual)
  })
})

type SyncRequest = (headers?: Record<string, string>, payload?: Record<string, unknown>) => Promise<{ statusCode: number; body: string }>

function syncRequests(app: ReturnType<typeof Fastify>): Array<{ kind: RunKind; sourceId?: string; request: SyncRequest }> {
  return [
    { kind: RunKinds['gsc-sync'], request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/google/gsc/sync', headers, payload }) },
    { kind: RunKinds['bing-inspect-sitemap'], request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/bing/inspect-sitemap', headers, payload }) },
    { kind: RunKinds['ga-sync'], request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/ga/sync', headers, payload }) },
    { kind: RunKinds['gbp-sync'], request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/gbp/sync', headers, payload }) },
    { kind: RunKinds['ads-sync'], request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/ads/sync', headers, payload }) },
    { kind: RunKinds['google-ads-sync'], request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/google-ads/sync', headers, payload }) },
    { kind: RunKinds['gtm-sync'], request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/gtm/sync', headers, payload }) },
    { kind: RunKinds['traffic-sync'], sourceId: 'cloud-run-source', request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/traffic/sources/cloud-run-source/sync', headers, payload }) },
    { kind: RunKinds['traffic-sync'], sourceId: 'queue-source', request: (headers, payload) => app.inject({ method: 'POST', url: '/api/v1/projects/status-project/traffic/sources/queue-source/sync', headers, payload }) },
  ]
}

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
  const googleConnections = new Map<string, GoogleConnectionRecord>()
  googleConnections.set('example.com:gsc', { domain: 'example.com', connectionType: 'gsc', accessToken: 'token', refreshToken: 'refresh', tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(), propertyId: 'sc-domain:example.com', createdAt: NOW, updatedAt: NOW })
  googleConnections.set('example.com:gbp', { domain: 'example.com', connectionType: 'gbp', accessToken: 'token', refreshToken: 'refresh', tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: NOW, updatedAt: NOW })
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    googleConnectionStore: {
      getConnection: (domain: string, connectionType: string) => googleConnections.get(`${domain}:${connectionType}`),
      listConnections: (domain: string) => [...googleConnections.values()].filter(connection => connection.domain === domain),
      upsertConnection: connection => connection,
      updateConnection: () => undefined,
      deleteConnection: () => true,
    },
    bingConnectionStore: {
      getConnection: () => ({ domain: 'example.com', apiKey: 'bing-key', siteUrl: 'https://example.com/', createdAt: NOW, updatedAt: NOW }),
      upsertConnection: connection => connection,
      updateConnection: () => undefined,
      deleteConnection: () => true,
    },
    ga4CredentialStore: {
      getConnection: () => ({ projectName: 'status-project', propertyId: '123', clientEmail: 'test@example.com', privateKey: 'key', createdAt: NOW, updatedAt: NOW }),
      upsertConnection: connection => connection,
      deleteConnection: () => true,
    },
    adsCredentialStore: {
      getConnection: () => ({ projectName: 'status-project', apiKey: 'ads-key', adAccountId: 'account', createdAt: NOW, updatedAt: NOW }),
      upsertConnection: entry => entry,
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
    getCloudflareQueueRetentionSeconds: async () => null,
    claimScheduledSync: (projectName: string, kind: RunKind, sourceId?: string) => claims.delete(syncRunClaimKey(projectName, kind, sourceId)),
    googleStateSecret: 'b3-test-secret-32-bytes-long-enough',
  })
  await app.ready()
  activeContexts.push({ app, tmpDir, db })
  return { app, db, tmpDir, claims, projectId, googleConnections }
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
