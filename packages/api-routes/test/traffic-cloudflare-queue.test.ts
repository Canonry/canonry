import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
import { createClient, migrate, projects, runs, schedules, trafficEventReceipts, trafficSources } from '@canonry/canonry-db'
import { RunStatuses, SchedulableRunKinds, TrafficSourceStatuses, TrafficSourceTypes } from '@canonry/canonry-contracts'
import { CloudflareQueueApiError } from '@canonry/canonry-integration-cloudflare-queue'
import { apiRoutes } from '../src/index.js'
import { CURRENT_CLOUDFLARE_WORKER_VERSION } from '../src/cloudflare-worker-version.js'
import type { CloudflareTrafficCredentialRecord, CloudflareTrafficCredentialStore, TrafficSyncedEvent } from '../src/traffic.js'
import { tryClaimTrafficSyncLease } from '../src/traffic-sync-lease.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

async function harness(options: {
  queuePull?: Parameters<typeof apiRoutes>[1]['pullCloudflareQueueMessages']
  queueAck?: Parameters<typeof apiRoutes>[1]['ackCloudflareQueueMessages']
  includeDirectIngestUrl?: boolean
  queueMaxBatches?: number
  /** Live Queue retention read; by default it fails, as if Cloudflare were unreachable. */
  queueRetention?: Parameters<typeof apiRoutes>[1]['getCloudflareQueueRetentionSeconds']
  queueSyncDeadlineMs?: number
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-cloudflare-queue-'))
  directories.push(directory)
  const db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  const credentials = new Map<string, CloudflareTrafficCredentialRecord>()
  const store: CloudflareTrafficCredentialStore = {
    getConnection: projectName => [...credentials.values()].find(record => record.projectName === projectName),
    getConnectionBySourceId: sourceId => credentials.get(sourceId),
    upsertConnection: record => { credentials.set(record.sourceId, record); return record },
    deleteConnection: projectName => {
      const record = [...credentials.values()].find(value => value.projectName === projectName)
      return record ? credentials.delete(record.sourceId) : false
    },
    deleteConnectionBySourceId: sourceId => credentials.delete(sourceId),
  }
  const synced: TrafficSyncedEvent[] = []
  const app = Fastify()
  app.register(apiRoutes, {
    db, skipAuth: true, cloudflareTrafficCredentialStore: store, onTrafficSynced: event => { synced.push(event) },
    ...(options.includeDirectIngestUrl === false ? {} : {
      cloudflareTrafficIngestUrl: 'https://canonry.test/api/v1/projects/{name}/traffic/cloudflare/ingest',
    }),
    pullCloudflareQueueMessages: options.queuePull,
    ackCloudflareQueueMessages: options.queueAck,
    getCloudflareQueueRetentionSeconds: options.queueRetention ?? (async () => { throw new Error('retention read unavailable in tests') }),
    cloudflareQueueMaxBatches: options.queueMaxBatches,
    cloudflareQueueSyncDeadlineMs: options.queueSyncDeadlineMs,
  })
  await app.ready()
  await app.inject({ method: 'PUT', url: '/api/v1/projects/test-project', payload: {
    displayName: 'Test', canonicalDomain: 'example.com', country: 'US', language: 'en',
  } })
  return { app, db, credentials, synced }
}

const queuePayload = {
  deliveryMode: 'queue-pull', accountId: 'account-1', queueId: 'queue-1', queueName: 'canonry-events',
  retentionSeconds: 86_400, apiToken: 'cf-secret-queue-token',
}

/** Queue envelopes from the generated Worker; `valid: false` gives batches the route drops as poison. */
function queueMessages(count: number, prefix: string, options: { valid?: boolean } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`, timestampMs: 1_700_000_000_000, attempts: 1, leaseId: `${prefix}-lease-${index}`,
    metadata: {}, contentType: 'json' as const,
    body: {
      schemaVersion: 1,
      workerVersion: CURRENT_CLOUDFLARE_WORKER_VERSION,
      events: options.valid === false ? [] : [{
        eventId: `${prefix}-ray-${index}`, observedAt: '2026-08-11T12:00:00.000Z', method: 'GET', host: 'example.com',
        path: '/queue', queryString: null, status: 200, userAgent: 'GPTBot/1.0', remoteIp: null, referer: null,
        cf: { verifiedBot: true, botScore: null, country: null, asn: null, asOrganization: null },
      }],
    },
  }))
}

/** The drain summary stored on the source's latest sync run. */
function storedDrain(h: Awaited<ReturnType<typeof harness>>, sourceId: string) {
  return h.db.select().from(runs).where(eq(runs.sourceId, sourceId)).all().at(-1)?.syncSummary
}

/** A drain summary with zero counts, overridden per test. */
function drain(fields: Record<string, unknown>) {
  return {
    type: 'cloudflare-queue', pulls: 0, emptyPulls: 0, messagesPulled: 0, messagesAcknowledged: 0, poisonMessages: 0,
    skippedUnleasedMessages: 0, acceptedEvents: 0, duplicateEvents: 0, backlogAtFirstPull: null, backlogAtLastPull: null,
    elapsedMs: expect.any(Number), ...fields,
  }
}

async function connectAndSync(h: Awaited<ReturnType<typeof harness>>) {
  const connected = await h.app.inject({ method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload })
  const sourceId = JSON.parse(connected.payload).sourceId as string
  const synced = await h.app.inject({ method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {} })
  return { sourceId, synced }
}

describe('Cloudflare Queue pull lifecycle', () => {
  it('stages a second delivery mode and activates it atomically without leaking the Queue token', async () => {
    const h = await harness()
    const direct = await h.app.inject({ method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: {} })
    const directId = JSON.parse(direct.payload).sourceId as string
    const staged = await h.app.inject({ method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload })

    expect(staged.statusCode).toBe(200)
    expect(staged.payload).not.toContain(queuePayload.apiToken)
    const stagedBody = JSON.parse(staged.payload) as { sourceId: string; activationRequired: boolean; workerScript: string; wranglerToml: string }
    expect(stagedBody.activationRequired).toBe(true)
    expect(stagedBody.workerScript).not.toContain(queuePayload.apiToken)
    expect(stagedBody.wranglerToml).not.toContain(queuePayload.apiToken)
    expect(JSON.parse(staged.payload).instructions).toContain(
      'wrangler queues consumer http add canonry-events',
    )
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, stagedBody.sourceId)).get()?.status).toBe('paused')
    const resetStaged = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${stagedBody.sourceId}/reset`,
      payload: { advanceToNow: true },
    })
    expect(resetStaged.statusCode).toBe(400)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, stagedBody.sourceId)).get()?.status).toBe('paused')
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, directId)).get()?.status).toBe('connected')
    const pausedSync = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${stagedBody.sourceId}/sync`, payload: {},
    })
    expect(pausedSync.statusCode).toBe(400)

    const stagedCredential = h.credentials.get(stagedBody.sourceId)!
    expect(stagedCredential.deliveryMode).toBe('queue-pull')
    if (stagedCredential.deliveryMode !== 'queue-pull') throw new Error('expected Queue credential')
    h.credentials.set(stagedBody.sourceId, { ...stagedCredential, apiToken: '' })
    const missingCredential = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${stagedBody.sourceId}/activate`,
    })
    expect(missingCredential.statusCode).toBe(400)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, stagedBody.sourceId)).get()?.status).toBe('paused')
    h.credentials.set(stagedBody.sourceId, stagedCredential)

    const activated = await h.app.inject({ method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${stagedBody.sourceId}/activate` })
    expect(activated.statusCode).toBe(200)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, directId)).get()?.status).toBe('paused')
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, stagedBody.sourceId)).get()?.status).toBe('connected')
    expect(h.db.select().from(schedules).where(and(
      eq(schedules.kind, SchedulableRunKinds['traffic-sync']),
      eq(schedules.sourceId, stagedBody.sourceId),
    )).get()?.enabled).toBe(true)

    h.db.update(trafficSources).set({ status: TrafficSourceStatuses.error })
      .where(eq(trafficSources.id, directId)).run()
    const resetFormerSource = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${directId}/reset`,
      payload: { advanceToNow: true },
    })
    expect(resetFormerSource.statusCode).toBe(400)
    const reconnectedDirect = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: {},
    })
    expect(reconnectedDirect.statusCode).toBe(200)
    expect(JSON.parse(reconnectedDirect.payload).activationRequired).toBe(true)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, directId)).get()?.status).toBe('paused')
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, stagedBody.sourceId)).get()?.status).toBe('connected')

    const directActivated = await h.app.inject({ method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${directId}/activate` })
    expect(directActivated.statusCode).toBe(200)
    expect(h.db.select().from(schedules).where(eq(schedules.kind, SchedulableRunKinds['traffic-sync'])).all()).toHaveLength(0)

    const directCredential = h.credentials.get(directId)!
    h.credentials.delete(directId)
    h.db.update(trafficSources).set({ status: TrafficSourceStatuses.error })
      .where(eq(trafficSources.id, directId)).run()
    const resetWithoutCredential = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${directId}/reset`,
      payload: { advanceToNow: true },
    })
    expect(resetWithoutCredential.statusCode).toBe(400)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, directId)).get()?.status)
      .toBe(TrafficSourceStatuses.error)
    h.credentials.set(directId, directCredential)
    await h.app.close()
  })

  it('stages Queue pull behind an active non-Cloudflare source', async () => {
    const h = await harness()
    const project = h.db.select().from(projects).where(eq(projects.name, 'test-project')).get()!
    const now = new Date().toISOString()
    h.db.insert(trafficSources).values({
      id: crypto.randomUUID(), projectId: project.id, sourceType: TrafficSourceTypes.vercel,
      displayName: 'Vercel', status: TrafficSourceStatuses.connected, configJson: {}, createdAt: now, updatedAt: now,
    }).run()

    const staged = await h.app.inject({ method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload })
    const sourceId = JSON.parse(staged.payload).sourceId as string
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()?.status).toBe('paused')
    await h.app.close()
  })

  it('generates a page-view Queue Worker and keeps the setting on reconnect', async () => {
    const h = await harness({ includeDirectIngestUrl: false })
    const connect = (payload: Record<string, unknown>) => h.app.inject({ method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload })
    const on = JSON.parse((await connect({ ...queuePayload, forwardPageViews: true })).payload) as Record<string, unknown>
    expect(on).toMatchObject({ deliveryMode: 'queue-pull', forwardPageViews: true })
    expect(String(on.workerVersion)).toMatch(/\+page-views$/)
    expect(on.workerScript).toContain('function isPageView')
    expect(on.wranglerToml).toContain(`CANONRY_WORKER_VERSION = "${String(on.workerVersion)}"`)
    expect(on.instructions).toContain('Each sync drains for up to 4 minutes by default')
    expect(JSON.parse((await connect(queuePayload)).payload)).toMatchObject({ forwardPageViews: true })
    expect(h.db.select().from(trafficSources).get()!.configJson).toMatchObject({ forwardPageViews: true })
    await h.app.close()
  })

  it('connects Queue pull without configuring the direct-push ingest URL', async () => {
    const h = await harness({ includeDirectIngestUrl: false })
    const connected = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload,
    })
    expect(connected.statusCode).toBe(200)
    expect(JSON.parse(connected.payload)).toMatchObject({ deliveryMode: 'queue-pull' })
    await h.app.close()
  })

  it('recovers an errored Queue source on reconnect when no sibling is active', async () => {
    const h = await harness()
    const connected = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: queuePayload,
    })
    const sourceId = JSON.parse(connected.payload).sourceId as string
    h.db.update(trafficSources).set({
      status: TrafficSourceStatuses.error,
      lastError: 'prior pull failed',
    }).where(eq(trafficSources.id, sourceId)).run()

    const reconnected = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: queuePayload,
    })

    expect(reconnected.statusCode).toBe(200)
    expect(JSON.parse(reconnected.payload)).toMatchObject({ sourceId, activationRequired: false })
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()).toMatchObject({
      status: TrafficSourceStatuses.connected,
      lastError: null,
    })
    await h.app.close()
  })

  it('clears observed backlog when reconnect points the source at a different Queue', async () => {
    const h = await harness()
    const connected = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload,
    })
    const sourceId = JSON.parse(connected.payload).sourceId as string
    const observedAt = '2026-08-11T12:00:00.000Z'
    h.db.update(trafficSources).set({
      queueBacklogCount: 321,
      queueBacklogObservedAt: observedAt,
    }).where(eq(trafficSources.id, sourceId)).run()

    const unchanged = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload,
    })
    expect(unchanged.statusCode).toBe(200)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()).toMatchObject({
      queueBacklogCount: 321,
      queueBacklogObservedAt: observedAt,
    })

    const replaced = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: { ...queuePayload, queueId: 'queue-2', queueName: 'canonry-events-2' },
    })
    expect(replaced.statusCode).toBe(200)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()).toMatchObject({
      queueBacklogCount: null,
      queueBacklogObservedAt: null,
    })
    await h.app.close()
  })

  it('refuses to pull when an active Queue source loses its local API token', async () => {
    let pullCalled = false
    const h = await harness({
      queuePull: async () => {
        pullCalled = true
        return { messageBacklogCount: 0, messages: [], skippedUnleasedMessageCount: 0 }
      },
    })
    const connected = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload,
    })
    const sourceId = JSON.parse(connected.payload).sourceId as string
    const credential = h.credentials.get(sourceId)!
    if (credential.deliveryMode !== 'queue-pull') throw new Error('expected Queue credential')
    h.credentials.set(sourceId, { ...credential, apiToken: '' })

    const sync = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {},
    })

    expect(sync.statusCode).toBe(400)
    expect(pullCalled).toBe(false)
    await h.app.close()
  })

  it('commits receipts before Queue ACK and dedupes a redelivery', async () => {
    let ackSawCommittedReceipt = false
    const body = {
      schemaVersion: 1,
      workerVersion: CURRENT_CLOUDFLARE_WORKER_VERSION,
      events: [{
        eventId: 'ray-queue-redelivery', observedAt: '2026-08-11T12:00:00.000Z', method: 'GET', host: 'example.com',
        path: '/queue', queryString: null, status: 200, userAgent: 'GPTBot/1.0', remoteIp: null, referer: null,
        cf: { verifiedBot: true, botScore: null, country: null, asn: null, asOrganization: null },
      }],
    }
    const message = {
      id: 'queue-message-1', timestampMs: 1_700_000_000_000, attempts: 1, leaseId: 'lease-1', metadata: {},
      contentType: 'json' as const, body,
    }
    const h = await harness({
      queuePull: async () => ({ messageBacklogCount: 0, messages: [message], skippedUnleasedMessageCount: 0 }),
      queueAck: async () => {
        ackSawCommittedReceipt = h.db.select().from(trafficEventReceipts).all().length === 1
        return { acknowledgedLeaseIds: ['lease-1'], retriedLeaseIds: [], warningCount: 0 }
      },
    })
    const connected = await h.app.inject({ method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload })
    const sourceId = JSON.parse(connected.payload).sourceId as string

    const first = await h.app.inject({ method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {} })
    const second = await h.app.inject({ method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {} })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(JSON.parse(first.payload)).toMatchObject({ pulledEvents: 1, crawlerHits: 1 })
    expect(JSON.parse(second.payload)).toMatchObject({ pulledEvents: 0, crawlerHits: 0 })
    // The redelivery is pulled and acknowledged again, and counted as a duplicate.
    const redelivery = drain({
      stopReason: 'backlog-empty', pulls: 1, messagesPulled: 1, messagesAcknowledged: 1, duplicateEvents: 1,
      backlogAtFirstPull: 0, backlogAtLastPull: 0,
    })
    expect(JSON.parse(second.payload).queueDrain).toEqual(redelivery)
    expect(storedDrain(h, sourceId)).toEqual(redelivery)
    expect(ackSawCommittedReceipt).toBe(true)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()?.lastWorkerVersion)
      .toBe(CURRENT_CLOUDFLARE_WORKER_VERSION)
    const [receipt] = h.db.select().from(trafficEventReceipts).all()
    expect(receipt).toBeDefined()
    // The live retention read failed in this harness. Receipts keep the
    // platform maximum plus a replay margin rather than trusting the
    // connect-time retention, which may be stale.
    expect(Date.parse(receipt!.expiresAt) - Date.parse(receipt!.receivedAt))
      .toBe(14 * 24 * 60 * 60_000 + 10 * 60_000)
    await h.app.close()
  })

  it.each([
    ['the live retention', async () => 345_600, 345_600_000 + 10 * 60_000],
    ['the 14-day maximum when Cloudflare reports no usable retention', async () => null, 14 * 24 * 60 * 60_000 + 10 * 60_000],
  ] as const)('keeps receipts for %s plus the replay margin', async (_label, queueRetention, expectedTtlMs) => {
    const retentionReads: Array<{ maxRetries?: number; timeoutMs?: number; queueId: string }> = []
    const message = {
      id: 'queue-message-ttl', timestampMs: 1_700_000_000_000, attempts: 1, leaseId: 'lease-ttl', metadata: {},
      contentType: 'json' as const,
      body: {
        schemaVersion: 1,
        workerVersion: CURRENT_CLOUDFLARE_WORKER_VERSION,
        events: [{
          eventId: 'ray-queue-ttl', observedAt: '2026-08-11T12:00:00.000Z', method: 'GET', host: 'example.com',
          path: '/queue', queryString: null, status: 200, userAgent: 'GPTBot/1.0', remoteIp: null, referer: null,
          cf: { verifiedBot: true, botScore: null, country: null, asn: null, asOrganization: null },
        }],
      },
    }
    const h = await harness({
      queuePull: async () => ({ messageBacklogCount: 0, messages: [message], skippedUnleasedMessageCount: 0 }),
      queueAck: async () => ({ acknowledgedLeaseIds: ['lease-ttl'], retriedLeaseIds: [], warningCount: 0 }),
      queueRetention: async client => { retentionReads.push(client); return queueRetention() },
    })
    const connected = await h.app.inject({ method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload })
    const sourceId = JSON.parse(connected.payload).sourceId as string
    const sync = await h.app.inject({ method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {} })
    expect(sync.statusCode).toBe(200)
    // One quick attempt per sync, so the read never eats into the sync lease.
    expect(retentionReads).toMatchObject([{ queueId: queuePayload.queueId, maxRetries: 0, timeoutMs: 10_000 }])
    const [receipt] = h.db.select().from(trafficEventReceipts).all()
    expect(Date.parse(receipt!.expiresAt) - Date.parse(receipt!.receivedAt)).toBe(expectedTtlMs)
    await h.app.close()
  })

  describe('receipt lifetimes across retention changes', () => {
    const HOUR = 60 * 60_000
    const MARGIN = 10 * 60_000
    async function syncWithSeededReceipt(seedLifetimeMs: number, liveRetentionSeconds: number) {
      const h = await harness({
        queuePull: async () => ({ messageBacklogCount: 0, messages: queueMessages(1, 'fresh'), skippedUnleasedMessageCount: 0 }),
        queueAck: async (_client, options) => ({ acknowledgedLeaseIds: options.acks, retriedLeaseIds: [], warningCount: 0 }),
        queueRetention: async () => liveRetentionSeconds,
      })
      const connected = await h.app.inject({ method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload })
      const sourceId = JSON.parse(connected.payload).sourceId as string
      const seededAt = new Date(Date.now() - HOUR).toISOString()
      const seededExpiry = new Date(Date.parse(seededAt) + seedLifetimeMs).toISOString()
      h.db.insert(trafficEventReceipts).values({ sourceId, eventId: 'seeded', receivedAt: seededAt, expiresAt: seededExpiry }).run()
      const synced = await h.app.inject({ method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {} })
      expect(synced.statusCode).toBe(200)
      const receipt = (eventId: string) => h.db.select().from(trafficEventReceipts)
        .where(and(eq(trafficEventReceipts.sourceId, sourceId), eq(trafficEventReceipts.eventId, eventId))).get()!
      const lifetime = (row: { receivedAt: string; expiresAt: string }) => Date.parse(row.expiresAt) - Date.parse(row.receivedAt)
      return { h, seeded: receipt('seeded'), fresh: receipt('cloudflare-worker:fresh-ray-0'), seededExpiry, lifetime }
    }

    it('extends live receipts when the retention went up', async () => {
      const { h, seeded, lifetime } = await syncWithSeededReceipt(24 * HOUR, 345_600)
      expect(Math.abs(lifetime(seeded) - (345_600_000 + MARGIN))).toBeLessThanOrEqual(2)
      await h.app.close()
    })

    it('keeps new receipts until the newest receipt from a longer retention expires', async () => {
      const { h, fresh, seededExpiry } = await syncWithSeededReceipt(345_600_000 + MARGIN, 3_600)
      expect(fresh.expiresAt).toBe(seededExpiry)
      await h.app.close()
    })

    it('takes no floor from receipts written by the maximum-retention fallback', async () => {
      const { h, fresh, lifetime } = await syncWithSeededReceipt(14 * 24 * HOUR + MARGIN, 3_600)
      expect(lifetime(fresh)).toBe(3_600_000 + MARGIN)
      await h.app.close()
    })
  })

  it.each([
    ['a failed read with its status', async () => { throw new CloudflareQueueApiError('Cloudflare Queue read failed with HTTP 403', 403) },
      { status: 403, error: 'Cloudflare Queue read failed with HTTP 403' }, 'Could not read Cloudflare Queue retention'],
    ['an unusable value separately', async () => null, {}, 'Cloudflare reported no usable Queue retention'],
  ] as const)('logs %s', async (_label, queueRetention, fields, message) => {
    const h = await harness({
      queuePull: async () => ({ messageBacklogCount: 0, messages: queueMessages(1, 'logged'), skippedUnleasedMessageCount: 0 }),
      queueAck: async (_client, options) => ({ acknowledgedLeaseIds: options.acks, retriedLeaseIds: [], warningCount: 0 }),
      queueRetention,
    })
    const warnings: Array<{ fields: Record<string, unknown>; message: string }> = []
    h.app.log.warn = ((logged: Record<string, unknown>, text: string) => { warnings.push({ fields: logged, message: text }) }) as typeof h.app.log.warn
    const { synced, sourceId } = await connectAndSync(h)
    expect(synced.statusCode).toBe(200)
    expect(warnings).toContainEqual({ fields: { sourceId, ...fields }, message: expect.stringContaining(message) })
    await h.app.close()
  })

  it('poison-ACKs text payloads because the generated Worker contract is JSON-only', async () => {
    const acknowledged: string[][] = []
    const textMessage = {
      id: 'queue-text-message', timestampMs: 1_700_000_000_000, attempts: 1,
      leaseId: 'queue-text-lease', metadata: { 'CF-Content-Type': 'text' },
      contentType: 'text' as const,
      // The injected seam deliberately supplies a schema-valid object under a
      // text discriminator. The route must reject by declared content type,
      // not accidentally accept based on body shape.
      body: {
        schemaVersion: 1,
        workerVersion: '1.0.0',
        events: [{
          eventId: 'text-event', observedAt: '2026-08-11T12:00:00.000Z', method: 'GET',
          host: 'example.com', path: '/text', queryString: null, status: 200,
          userAgent: 'GPTBot/1.0', remoteIp: null, referer: null,
          cf: { verifiedBot: true, botScore: null, country: null, asn: null, asOrganization: null },
        }],
      } as unknown as string,
    }
    const h = await harness({
      queuePull: async () => ({ messageBacklogCount: 0, messages: [textMessage], skippedUnleasedMessageCount: 0 }),
      queueAck: async (_client, options) => {
        acknowledged.push([...options.acks])
        return { acknowledgedLeaseIds: options.acks, retriedLeaseIds: [], warningCount: 0 }
      },
    })
    const connected = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload,
    })
    const sourceId = JSON.parse(connected.payload).sourceId as string

    const synced = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {},
    })

    expect(synced.statusCode).toBe(200)
    expect(JSON.parse(synced.payload)).toMatchObject({ pulledEvents: 0 })
    expect(acknowledged).toEqual([['queue-text-lease']])
    expect(h.db.select().from(trafficEventReceipts).all()).toHaveLength(0)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()?.lastWorkerVersion)
      .toBeNull()
    await h.app.close()
  })

  it('continues after skipped unleased entries fill a pull batch and logs only their count', async () => {
    let pulls = 0
    const validMessage = {
      id: 'valid-after-unleased', timestampMs: 1_700_000_000_000, attempts: 1,
      leaseId: 'valid-after-unleased-lease', metadata: {}, contentType: 'json' as const,
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [] },
    }
    const h = await harness({
      queuePull: async () => {
        pulls += 1
        return pulls === 1
          ? { messageBacklogCount: 1, messages: [], skippedUnleasedMessageCount: 100 }
          : { messageBacklogCount: 0, messages: [validMessage], skippedUnleasedMessageCount: 0 }
      },
      queueAck: async (_client, options) => ({
        acknowledgedLeaseIds: options.acks, retriedLeaseIds: [], warningCount: 0,
      }),
    })
    const warnings: Array<Record<string, unknown>> = []
    h.app.log.warn = ((fields: Record<string, unknown>) => { warnings.push(fields) }) as typeof h.app.log.warn
    const connected = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload,
    })
    const sourceId = JSON.parse(connected.payload).sourceId as string

    const synced = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {},
    })

    expect(synced.statusCode).toBe(200)
    expect(pulls).toBe(2)
    expect(warnings).toContainEqual(expect.objectContaining({
      sourceId,
      skippedUnleasedMessageCount: 100,
    }))
    await h.app.close()
  })

  it('logs successful Queue ACK warning counts without failing the sync', async () => {
    const validMessage = {
      id: 'ack-warning', timestampMs: 1_700_000_000_000, attempts: 1,
      leaseId: 'ack-warning-lease', metadata: {}, contentType: 'json' as const,
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [] },
    }
    const h = await harness({
      queuePull: async () => ({
        messageBacklogCount: 0, messages: [validMessage], skippedUnleasedMessageCount: 0,
      }),
      queueAck: async (_client, options) => ({
        acknowledgedLeaseIds: options.acks, retriedLeaseIds: [], warningCount: 2,
      }),
    })
    const warnings: Array<Record<string, unknown>> = []
    h.app.log.warn = ((fields: Record<string, unknown>) => { warnings.push(fields) }) as typeof h.app.log.warn
    const connected = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload,
    })
    const sourceId = JSON.parse(connected.payload).sourceId as string

    const synced = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {},
    })

    expect(synced.statusCode).toBe(200)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()?.lastError)
      .toBeNull()
    expect(warnings).toContainEqual(expect.objectContaining({ sourceId, warningCount: 2 }))
    await h.app.close()
  })

  it('renews the source lease immediately before Queue acknowledgement', async () => {
    let sourceId = ''
    let ackSawRenewedLease = false
    const message = {
      id: 'queue-message-renew', timestampMs: 1_700_000_000_000, attempts: 1, leaseId: 'lease-renew', metadata: {},
      contentType: 'json' as const, body: { schemaVersion: 1, workerVersion: '1.0.0', events: [] },
    }
    const h = await harness({
      queuePull: async () => {
        h.db.update(trafficSources).set({ syncLeaseExpiresAt: new Date(0).toISOString() })
          .where(eq(trafficSources.id, sourceId)).run()
        return { messageBacklogCount: 0, messages: [message], skippedUnleasedMessageCount: 0 }
      },
      queueAck: async () => {
        const source = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
        ackSawRenewedLease = Date.parse(source.syncLeaseExpiresAt ?? '') > Date.now() + 4 * 60_000
        return { acknowledgedLeaseIds: ['lease-renew'], retriedLeaseIds: [], warningCount: 0 }
      },
    })
    const connected = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload,
    })
    sourceId = JSON.parse(connected.payload).sourceId as string

    const synced = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {},
    })

    expect(synced.statusCode).toBe(200)
    expect(ackSawRenewedLease).toBe(true)
    await h.app.close()
  })

  it('does not commit or acknowledge a Queue batch after its source reconnects to another Queue', async () => {
    let sourceId = ''
    let acknowledged = false
    const message = {
      id: 'old-queue-message', timestampMs: 1_700_000_000_000, attempts: 1, leaseId: 'old-queue-lease', metadata: {},
      contentType: 'json' as const,
      body: {
        schemaVersion: 1, workerVersion: '1.0.0', events: [{
          eventId: 'old-queue-event', observedAt: '2026-08-11T12:00:00.000Z', method: 'GET', host: 'example.com',
          path: '/old-queue', queryString: null, status: 200, userAgent: 'GPTBot/1.0', remoteIp: null, referer: null,
          cf: { verifiedBot: true, botScore: null, country: null, asn: null, asOrganization: null },
        }],
      },
    }
    const h = await harness({
      queuePull: async () => {
        const reconnected = await h.app.inject({
          method: 'POST',
          url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
          payload: { ...queuePayload, queueId: 'queue-2', queueName: 'canonry-events-2', apiToken: 'new-queue-token' },
        })
        expect(reconnected.statusCode).toBe(200)
        return { messageBacklogCount: 0, messages: [message], skippedUnleasedMessageCount: 0 }
      },
      queueAck: async () => {
        acknowledged = true
        return { acknowledgedLeaseIds: ['old-queue-lease'], retriedLeaseIds: [], warningCount: 0 }
      },
    })
    const connected = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload,
    })
    sourceId = JSON.parse(connected.payload).sourceId as string

    const synced = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {},
    })

    expect(synced.statusCode).toBe(502)
    expect(acknowledged).toBe(false)
    expect(h.db.select().from(trafficEventReceipts).where(eq(trafficEventReceipts.sourceId, sourceId)).all()).toHaveLength(0)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()).toMatchObject({
      configJson: expect.objectContaining({ queueId: 'queue-2', queueName: 'canonry-events-2' }),
      lastError: null,
    })
    await h.app.close()
  })

  it('returns 409 when a Queue source lease is already live and rejects archived activation', async () => {
    const h = await harness()
    const connected = await h.app.inject({ method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload })
    const sourceId = JSON.parse(connected.payload).sourceId as string
    expect(tryClaimTrafficSyncLease({
      db: h.db, sourceId, owner: 'other-worker', now: new Date().toISOString(), ttlMs: 60_000,
    })).toBe(true)
    const conflict = await h.app.inject({ method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {} })
    expect(conflict.statusCode).toBe(409)
    h.db.update(trafficSources).set({ status: TrafficSourceStatuses.archived }).where(eq(trafficSources.id, sourceId)).run()
    const archived = await h.app.inject({ method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/activate` })
    expect(archived.statusCode).toBe(404)
    await h.app.close()
  })

  it('commits and acknowledges each Queue lease batch before pulling the next one', async () => {
    const acknowledgedBatchSizes: number[] = []
    let pulls = 0
    const h = await harness({
      queuePull: async () => {
        pulls += 1
        return pulls === 1
          ? { messageBacklogCount: 1, messages: queueMessages(100, 'first', { valid: false }), skippedUnleasedMessageCount: 0 }
          : { messageBacklogCount: 0, messages: queueMessages(1, 'second', { valid: false }), skippedUnleasedMessageCount: 0 }
      },
      queueAck: async (_client, options) => {
        acknowledgedBatchSizes.push(options.acks.length)
        return { acknowledgedLeaseIds: options.acks, retriedLeaseIds: [], warningCount: 0 }
      },
    })
    const { synced, sourceId } = await connectAndSync(h)

    expect(synced.statusCode).toBe(200)
    expect(acknowledgedBatchSizes).toEqual([100, 1])
    expect(acknowledgedBatchSizes.every(size => size <= 100)).toBe(true)
    expect(storedDrain(h, sourceId)).toEqual(drain({
      stopReason: 'backlog-empty', pulls: 2, messagesPulled: 101, messagesAcknowledged: 101, poisonMessages: 101,
      backlogAtFirstPull: 1, backlogAtLastPull: 0,
    }))
    await h.app.close()
  })

  it('keeps draining through partial batches while a backlog remains, up to the pull cap', async () => {
    const pullSizes = [37, 52, 100, 8, 61]
    const acknowledged: number[] = []
    let pulls = 0
    const h = await harness({
      queueMaxBatches: 4,
      queuePull: async () => {
        const size = pullSizes[pulls]!
        pulls += 1
        return { messageBacklogCount: 60_000, messages: queueMessages(size, `pull-${pulls}`), skippedUnleasedMessageCount: 0 }
      },
      queueAck: async (_client, options) => {
        acknowledged.push(options.acks.length)
        return { acknowledgedLeaseIds: options.acks, retriedLeaseIds: [], warningCount: 0 }
      },
    })
    const { synced, sourceId } = await connectAndSync(h)
    expect(synced.statusCode).toBe(200)
    // Partial batches (37, 52, 8) no longer end the drain; the cap of 4 does.
    expect(acknowledged).toEqual([37, 52, 100, 8])
    expect(JSON.parse(synced.payload)).toMatchObject({ pulledEvents: 197, remainingBacklogCount: 60_000 })
    expect(h.db.select().from(trafficEventReceipts).all()).toHaveLength(197)
    const capped = drain({
      stopReason: 'batch-cap', pulls: 4, messagesPulled: 197, messagesAcknowledged: 197, acceptedEvents: 197,
      backlogAtFirstPull: 60_000, backlogAtLastPull: 60_000,
    })
    expect(JSON.parse(synced.payload).queueDrain).toEqual(capped)
    expect(storedDrain(h, sourceId)).toEqual(capped)
    // Readable later from the runs list and the source status.
    const listed = JSON.parse((await h.app.inject({ method: 'GET', url: '/api/v1/projects/test-project/runs' })).payload) as Array<Record<string, unknown>>
    expect(listed.find(run => run.kind === 'traffic-sync')?.syncSummary).toEqual(capped)
    const status = JSON.parse((await h.app.inject({ method: 'GET', url: '/api/v1/projects/test-project/traffic/status' })).payload)
    expect(status.sources[0].latestRun.syncSummary).toEqual(capped)
    await h.app.close()
  })

  it('stops at the drain deadline even while a backlog remains', async () => {
    let pulls = 0
    const h = await harness({
      queueSyncDeadlineMs: 1,
      queuePull: async () => {
        pulls += 1
        await new Promise(resolve => setTimeout(resolve, 5))
        return { messageBacklogCount: 60_000, messages: queueMessages(10, `deadline-${pulls}`), skippedUnleasedMessageCount: 0 }
      },
      queueAck: async (_client, options) => ({ acknowledgedLeaseIds: options.acks, retriedLeaseIds: [], warningCount: 0 }),
    })
    const { synced, sourceId } = await connectAndSync(h)
    expect(synced.statusCode).toBe(200)
    expect(pulls).toBe(1)
    expect(JSON.parse(synced.payload)).toMatchObject({ pulledEvents: 10, remainingBacklogCount: 60_000 })
    expect(storedDrain(h, sourceId)).toEqual(drain({
      stopReason: 'deadline', pulls: 1, messagesPulled: 10, messagesAcknowledged: 10, acceptedEvents: 10,
      backlogAtFirstPull: 60_000, backlogAtLastPull: 60_000,
    }))
    await h.app.close()
  })

  it('keeps draining past one empty pull and stops after two in a row', async () => {
    const script = [10, 0, 10, 0, 0, 10]
    let pulls = 0
    const h = await harness({
      queuePull: async () => {
        const size = script[pulls]!
        pulls += 1
        return { messageBacklogCount: 500, messages: queueMessages(size, `empty-${pulls}`), skippedUnleasedMessageCount: 0 }
      },
      queueAck: async (_client, options) => ({ acknowledgedLeaseIds: options.acks, retriedLeaseIds: [], warningCount: 0 }),
    })
    const { synced, sourceId } = await connectAndSync(h)
    expect(synced.statusCode).toBe(200)
    expect(pulls).toBe(5)
    expect(JSON.parse(synced.payload)).toMatchObject({ pulledEvents: 20 })
    expect(storedDrain(h, sourceId)).toEqual(drain({
      stopReason: 'empty-pulls', pulls: 5, emptyPulls: 3, messagesPulled: 20, messagesAcknowledged: 20, acceptedEvents: 20,
      backlogAtFirstPull: 500, backlogAtLastPull: 500,
    }))
    await h.app.close()
  })

  it('stops after a partial pull of only unacknowledgeable entries', async () => {
    let pulls = 0
    const h = await harness({
      queuePull: async () => {
        pulls += 1
        return { messageBacklogCount: 3, messages: [], skippedUnleasedMessageCount: 3 }
      },
    })
    const { synced, sourceId } = await connectAndSync(h)
    expect(synced.statusCode).toBe(200)
    expect(pulls).toBe(1)
    expect(storedDrain(h, sourceId)).toEqual(drain({
      stopReason: 'unleased-only', pulls: 1, emptyPulls: 1, skippedUnleasedMessages: 3,
      backlogAtFirstPull: 3, backlogAtLastPull: 3,
    }))
    await h.app.close()
  })

  it('keeps saved batches and ends the run partial when a later pull fails', async () => {
    const acknowledged: number[] = []
    let pulls = 0
    const h = await harness({
      queuePull: async () => {
        pulls += 1
        if (pulls === 2) throw new CloudflareQueueApiError('Cloudflare Queue pull failed with HTTP 503', 503)
        return { messageBacklogCount: 100, messages: queueMessages(5, 'saved'), skippedUnleasedMessageCount: 0 }
      },
      queueAck: async (_client, options) => {
        acknowledged.push(options.acks.length)
        return { acknowledgedLeaseIds: options.acks, retriedLeaseIds: [], warningCount: 0 }
      },
    })
    const { synced, sourceId } = await connectAndSync(h)
    expect(synced.statusCode).toBe(200)
    expect(JSON.parse(synced.payload)).toMatchObject({ pulledEvents: 5, crawlerHits: 5 })
    expect(acknowledged).toEqual([5])
    expect(h.synced.at(-1)).toMatchObject({ status: 'completed', pulledEvents: 5 })
    const run = h.db.select().from(runs).where(eq(runs.sourceId, sourceId)).all().at(-1)
    expect(run).toMatchObject({ status: RunStatuses.partial, error: 'Cloudflare Queue pull failed with HTTP 503' })
    // The failed pull is not counted; the saved batch is.
    expect(run?.syncSummary).toEqual(drain({
      stopReason: 'error', pulls: 1, messagesPulled: 5, messagesAcknowledged: 5, acceptedEvents: 5,
      backlogAtFirstPull: 100, backlogAtLastPull: 100,
    }))
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()?.lastError).toBeNull()
    await h.app.close()
  })

  it('reads the retention only when a batch carries events', async () => {
    let reads = 0
    const h = await harness({
      queuePull: async () => ({ messageBacklogCount: 0, messages: [], skippedUnleasedMessageCount: 0 }),
      queueRetention: async () => { reads += 1; return 345_600 },
    })
    const { synced } = await connectAndSync(h)
    expect(synced.statusCode).toBe(200)
    expect(reads).toBe(0)
    await h.app.close()
  })

  it('uses a visibility timeout beyond the ACK retry budget and persists residual backlog', async () => {
    let visibilityTimeoutMs: number | undefined
    const messages = Array.from({ length: 100 }, (_, index) => ({
      id: `backlog-${index}`, timestampMs: 1_700_000_000_000, attempts: 1,
      leaseId: `backlog-lease-${index}`, metadata: {}, contentType: 'json' as const,
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [] },
    }))
    const h = await harness({
      queueMaxBatches: 1,
      queuePull: async (_client, options) => {
        visibilityTimeoutMs = options?.visibilityTimeoutMs
        return { messageBacklogCount: 900, messages, skippedUnleasedMessageCount: 0 }
      },
      queueAck: async (_client, options) => ({
        acknowledgedLeaseIds: options.acks, retriedLeaseIds: [], warningCount: 0,
      }),
    })
    const connected = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload,
    })
    const sourceId = JSON.parse(connected.payload).sourceId as string

    const synced = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {},
    })

    expect(synced.statusCode).toBe(200)
    expect(visibilityTimeoutMs).toBe(5 * 60_000)
    expect(JSON.parse(synced.payload)).toMatchObject({ remainingBacklogCount: 900 })
    const source = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
    expect(source.queueBacklogCount).toBe(900)
    expect(source.queueBacklogObservedAt).not.toBeNull()
    await h.app.close()
  })

  it('surfaces safe Queue API causes without overwriting state after lease ownership changes', async () => {
    let sourceId = ''
    const newerUpdatedAt = '2099-01-01T00:00:00.000Z'
    const h = await harness({
      queuePull: async () => {
        h.db.update(trafficSources).set({
          syncLeaseOwner: 'replacement-owner',
          syncLeaseExpiresAt: '2099-01-01T00:05:00.000Z',
          lastError: 'newer authority state',
          updatedAt: newerUpdatedAt,
        }).where(eq(trafficSources.id, sourceId)).run()
        throw new CloudflareQueueApiError('Cloudflare Queue pull failed with HTTP 403', 403)
      },
    })
    const connected = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload,
    })
    sourceId = JSON.parse(connected.payload).sourceId as string

    const synced = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {},
    })

    expect(synced.statusCode).toBe(502)
    expect(JSON.parse(synced.payload).error.message).toContain('HTTP 403')
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()).toMatchObject({
      syncLeaseOwner: 'replacement-owner',
      lastError: 'newer authority state',
      updatedAt: newerUpdatedAt,
    })
    await h.app.close()
  })

  it('reports every failed Queue sync to telemetry with the reason it can name', async () => {
    const failures: Error[] = [
      new CloudflareQueueApiError('Cloudflare Queue pull failed with HTTP 403', 403),
      new CloudflareQueueApiError('Cloudflare Queue pull failed with HTTP 500', 500),
      new TypeError('fetch failed'),
    ]
    const h = await harness({ queuePull: async () => { throw failures.shift()! } })
    const connected = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload,
    })
    const sourceId = JSON.parse(connected.payload).sourceId as string
    for (let i = 0; i < 3; i += 1) {
      const synced = await h.app.inject({ method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {} })
      expect(synced.statusCode).toBe(502)
    }

    const failed = { status: 'failed', sourceType: TrafficSourceTypes.cloudflare, sourceId, pulledEvents: 0, selfTrafficExcluded: 0, crawlerHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, durationMs: expect.any(Number) }
    expect(h.synced).toEqual([
      { ...failed, errorCode: 'PROVIDER_AUTH' },
      { ...failed, errorCode: 'PROVIDER_PULL' },
      { ...failed, errorCode: 'INTERNAL' },
    ])
    // A sync that failed before any pull returned still records why it stopped.
    const failedRuns = h.db.select().from(runs).where(eq(runs.sourceId, sourceId)).all()
    expect(failedRuns.map(run => [run.status, run.syncSummary])).toEqual(
      Array.from({ length: 3 }, () => [RunStatuses.failed, drain({ stopReason: 'error' })]),
    )
    await h.app.close()
  })
})
