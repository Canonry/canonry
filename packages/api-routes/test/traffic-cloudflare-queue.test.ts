import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
import { createClient, migrate, projects, schedules, trafficEventReceipts, trafficSources } from '@ainyc/canonry-db'
import { SchedulableRunKinds, TrafficSourceStatuses, TrafficSourceTypes } from '@ainyc/canonry-contracts'
import { CloudflareQueueApiError } from '@ainyc/canonry-integration-cloudflare-queue'
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
    cloudflareQueueMaxBatches: options.queueMaxBatches,
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
    expect(ackSawCommittedReceipt).toBe(true)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()?.lastWorkerVersion)
      .toBe(CURRENT_CLOUDFLARE_WORKER_VERSION)
    const [receipt] = h.db.select().from(trafficEventReceipts).all()
    expect(receipt).toBeDefined()
    // Queue configuration is caller supplied and is not verified against
    // Cloudflare. Retain receipts for the platform maximum plus a replay
    // margin, rather than trusting a potentially lower claimed retention.
    expect(Date.parse(receipt!.expiresAt) - Date.parse(receipt!.receivedAt))
      .toBe(14 * 24 * 60 * 60_000 + 10 * 60_000)
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
    const messages = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`, timestampMs: 1_700_000_000_000, attempts: 1, leaseId: `${prefix}-lease-${index}`,
      metadata: {}, contentType: 'json' as const,
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [] },
    }))
    const h = await harness({
      queuePull: async () => {
        pulls += 1
        return pulls === 1
          ? { messageBacklogCount: 1, messages: messages(100, 'first'), skippedUnleasedMessageCount: 0 }
          : { messageBacklogCount: 0, messages: messages(1, 'second'), skippedUnleasedMessageCount: 0 }
      },
      queueAck: async (_client, options) => {
        acknowledgedBatchSizes.push(options.acks.length)
        return { acknowledgedLeaseIds: options.acks, retriedLeaseIds: [], warningCount: 0 }
      },
    })
    const connected = await h.app.inject({ method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queuePayload })
    const sourceId = JSON.parse(connected.payload).sourceId as string
    const synced = await h.app.inject({ method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {} })

    expect(synced.statusCode).toBe(200)
    expect(acknowledgedBatchSizes).toEqual([100, 1])
    expect(acknowledgedBatchSizes.every(size => size <= 100)).toBe(true)
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
    await h.app.close()
  })
})
