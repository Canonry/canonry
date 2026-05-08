import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  trafficSources,
  crawlerEventsHourly,
  aiReferralEventsHourly,
  rawEventSamples,
  runs,
} from '@ainyc/canonry-db'
import {
  TrafficSourceTypes,
  TrafficSourceStatuses,
  TrafficSourceAuthModes,
  RunKinds,
  RunStatuses,
} from '@ainyc/canonry-contracts'
import type { NormalizedTrafficRequest } from '@ainyc/canonry-contracts'
import type { CloudRunTrafficEventsPage } from '@ainyc/canonry-integration-cloud-run'
import { apiRoutes } from '../src/index.js'
import type { CloudRunCredentialRecord, CloudRunCredentialStore } from '../src/traffic.js'

function buildEvent(overrides: Partial<NormalizedTrafficRequest> = {}): NormalizedTrafficRequest {
  const base: NormalizedTrafficRequest = {
    sourceType: 'cloud-run',
    evidenceKind: 'raw-request',
    confidence: 'observed',
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    observedAt: '2026-05-07T17:32:00.000Z',
    method: 'GET',
    requestUrl: 'https://example.com/blog/foo',
    host: 'example.com',
    path: '/blog/foo',
    queryString: null,
    status: 200,
    userAgent: 'GPTBot/1.0',
    remoteIp: '1.2.3.4',
    referer: null,
    latencyMs: null,
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: { type: 'cloud_run_revision', labels: {} },
    providerLabels: {},
  }
  return { ...base, ...overrides }
}

async function buildHarness(events: NormalizedTrafficRequest[]) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-routes-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const credentials = new Map<string, CloudRunCredentialRecord>()
  const cloudRunCredentialStore: CloudRunCredentialStore = {
    getConnection: (projectName) => credentials.get(projectName),
    upsertConnection: (record) => {
      credentials.set(record.projectName, record)
      return record
    },
    deleteConnection: (projectName) => credentials.delete(projectName),
  }

  let pullInvocations = 0
  const observedWindows: Array<{ startTime: string; endTime: string }> = []
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    cloudRunCredentialStore,
    pullCloudRunEvents: async (_token, options): Promise<CloudRunTrafficEventsPage> => {
      pullInvocations += 1
      observedWindows.push({ startTime: options.startTime, endTime: options.endTime })
      // Mirror Cloud Logging's behavior: only return events inside the requested window.
      const startMs = new Date(options.startTime).getTime()
      const endMs = new Date(options.endTime).getTime()
      const filtered = events.filter((e) => {
        const t = new Date(e.observedAt).getTime()
        return t >= startMs && t <= endMs
      })
      return {
        events: filtered,
        rawEntryCount: filtered.length,
        skippedEntryCount: 0,
        nextPageToken: undefined,
        filter: 'mock',
      }
    },
    resolveCloudRunAccessToken: async () => 'mock-access-token',
  })
  await app.ready()

  // Seed a project
  await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/test-project',
    payload: {
      displayName: 'Test Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    },
  })

  return {
    app,
    db,
    credentials,
    tmpDir,
    getPullCount: () => pullInvocations,
    getObservedWindows: () => observedWindows,
    close: async () => {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

const SA_KEY = JSON.stringify({
  client_email: 'sa@openclaw-nyc.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake-key\n-----END PRIVATE KEY-----',
})

describe('POST /traffic/connect/cloud-run', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>
  beforeEach(async () => { h = await buildHarness([]) })
  afterEach(async () => { await h.close() })

  it('rejects requests without gcpProjectId', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { keyJson: SA_KEY },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error.message).toMatch(/gcpProjectId/)
  })

  it('rejects requests without keyJson', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'openclaw-nyc' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error.message).toMatch(/keyJson/)
  })

  it('rejects malformed keyJson', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'openclaw-nyc', keyJson: 'not-json' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error.message).toMatch(/Invalid JSON/i)
  })

  it('persists credentials and creates a connected source row', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: {
        gcpProjectId: 'openclaw-nyc',
        serviceName: 'openclaw-nyc',
        location: 'us-east1',
        keyJson: SA_KEY,
      },
    })
    expect(res.statusCode).toBe(200)
    const dto = JSON.parse(res.payload)
    expect(dto.sourceType).toBe(TrafficSourceTypes['cloud-run'])
    expect(dto.status).toBe(TrafficSourceStatuses.connected)
    expect(dto.config.gcpProjectId).toBe('openclaw-nyc')
    expect(dto.config.serviceName).toBe('openclaw-nyc')
    expect(dto.config.authMode).toBe(TrafficSourceAuthModes['service-account'])
    expect(dto.archivedAt).toBeNull()

    const stored = h.credentials.get('test-project')
    expect(stored).toBeDefined()
    expect(stored?.clientEmail).toBe('sa@openclaw-nyc.iam.gserviceaccount.com')
    expect(stored?.privateKey).toContain('PRIVATE KEY')

    const sourceRows = h.db.select().from(trafficSources).all()
    expect(sourceRows.length).toBe(1)
    expect(sourceRows[0].status).toBe(TrafficSourceStatuses.connected)
  })

  it('reuses the existing source row on reconnect rather than creating a duplicate', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'old-project', keyJson: SA_KEY },
    })

    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'new-project', serviceName: 'new-svc', keyJson: SA_KEY },
    })

    expect(second.statusCode).toBe(200)
    const sources = h.db.select().from(trafficSources).all()
    expect(sources.length).toBe(1)
    const config = JSON.parse(sources[0].configJson) as Record<string, unknown>
    expect(config.gcpProjectId).toBe('new-project')
    expect(config.serviceName).toBe('new-svc')
  })
})

describe('POST /traffic/sources/:id/sync', () => {
  it('returns 404 when the source does not belong to the project', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/sources/no-such-source/sync',
        payload: {},
      })
      expect(res.statusCode).toBe(404)
    } finally {
      await h.close()
    }
  })

  it('errors when no credentials are stored for the project', async () => {
    const h = await buildHarness([])
    try {
      const { projects } = await import('@ainyc/canonry-db')
      const projectRow = h.db.select().from(projects).all()[0]
      h.db.insert(trafficSources).values({
        id: 'src_orphan',
        projectId: projectRow.id,
        sourceType: TrafficSourceTypes['cloud-run'],
        displayName: 'orphan',
        status: TrafficSourceStatuses.connected,
        configJson: '{"gcpProjectId":"orphan-project","authMode":"service-account"}',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run()

      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/sources/src_orphan/sync',
        payload: {},
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toMatch(/credential/i)
    } finally {
      await h.close()
    }
  })

  it('pulls events, classifies, writes hourly buckets + samples + a completed run', async () => {
    // Anchor events inside the 120-min sync window the test requests below,
    // and snap to the top of an hour so the two crawler hits land in the
    // same hourly bucket regardless of when the test runs.
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      // Two crawler hits same hour same path → should accumulate to hits=2 in one bucket
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(30) }),
      // One AI referral via UTM
      buildEvent({
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(15),
      }),
      // One unclassified hit
      buildEvent({ userAgent: 'curl/7.x', path: '/anything', status: 404, observedAt: fromBase(32) }),
    ]

    const h = await buildHarness(events)
    try {
      // Connect first
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', serviceName: 'openclaw-nyc', location: 'us-east1', keyJson: SA_KEY },
      })
      expect(connectRes.statusCode).toBe(200)
      const sourceId = JSON.parse(connectRes.payload).id

      // Sync
      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 120 },
      })
      expect(syncRes.statusCode).toBe(200)
      const body = JSON.parse(syncRes.payload)
      expect(body.pulledEvents).toBe(4)
      expect(body.crawlerHits).toBe(2)
      expect(body.aiReferralHits).toBe(1)
      expect(body.unknownHits).toBe(1)
      expect(body.crawlerBucketRows).toBe(1)
      expect(body.aiReferralBucketRows).toBe(1)
      expect(body.sampleRows).toBe(4)
      expect(body.runId).toBeDefined()

      // Crawler bucket accumulated hits=2
      const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
      expect(crawlerRows.length).toBe(1)
      expect(crawlerRows[0].hits).toBe(2)
      expect(crawlerRows[0].botId).toBe('openai-gptbot')

      // AI referral bucket
      const aiRows = h.db.select().from(aiReferralEventsHourly).all()
      expect(aiRows.length).toBe(1)
      expect(aiRows[0].evidenceType).toBe('utm')
      expect(aiRows[0].sessionsOrHits).toBe(1)

      // Samples
      const samples = h.db.select().from(rawEventSamples).all()
      expect(samples.length).toBe(4)
      const types = samples.map((s) => s.eventType).sort()
      expect(types).toEqual(['ai_referral', 'crawler', 'crawler', 'unknown'])

      // Source updated
      const sources = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).all()
      expect(sources[0].lastSyncedAt).toBeTruthy()
      expect(sources[0].lastError).toBeNull()

      // Run row marked completed with kind=traffic-sync
      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].kind).toBe(RunKinds['traffic-sync'])
      expect(runRows[0].status).toBe(RunStatuses.completed)
    } finally {
      await h.close()
    }
  })

  it('clamps windowStart to lastSyncedAt so overlapping syncs do not double-count', async () => {
    // Event sits inside the default 60-min sync window for the first sync. After
    // the first sync, lastSyncedAt is "now-ish", so the second sync's window
    // collapses to roughly [lastSyncedAt, now] and no longer covers the event.
    const observedAt = new Date(Date.now() - 30 * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt }),
    ]
    const h = await buildHarness(events)
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const first = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(JSON.parse(first.payload).pulledEvents).toBe(1)

      const second = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(JSON.parse(second.payload).pulledEvents).toBe(0)

      const rows = h.db.select().from(crawlerEventsHourly).all()
      expect(rows.length).toBe(1)
      expect(rows[0].hits).toBe(1)

      // The second sync's startTime should have been clamped to the first sync's
      // lastSyncedAt — i.e. ≥ the first sync's endTime.
      const windows = h.getObservedWindows()
      expect(windows.length).toBe(2)
      expect(new Date(windows[1].startTime).getTime()).toBeGreaterThanOrEqual(
        new Date(windows[0].endTime).getTime(),
      )
    } finally {
      await h.close()
    }
  })

  it('marks the source as error and the run as failed when the pull throws', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-routes-test-'))
    const dbPath = path.join(tmpDir, 'test.db')
    const db = createClient(dbPath)
    migrate(db)

    const credentials = new Map<string, CloudRunCredentialRecord>()
    const cloudRunCredentialStore: CloudRunCredentialStore = {
      getConnection: (n) => credentials.get(n),
      upsertConnection: (r) => { credentials.set(r.projectName, r); return r },
      deleteConnection: (n) => credentials.delete(n),
    }

    const app = Fastify()
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      cloudRunCredentialStore,
      pullCloudRunEvents: async () => {
        throw new Error('Cloud Logging boom')
      },
      resolveCloudRunAccessToken: async () => 'mock-token',
    })
    await app.ready()

    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/test-project',
      payload: { displayName: 'Test', canonicalDomain: 'example.com', country: 'US', language: 'en' },
    })

    const connectRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
    })
    const sourceId = JSON.parse(connectRes.payload).id

    const syncRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
      payload: {},
    })
    // Upstream pull failure surfaces as PROVIDER_ERROR (502) so CLI exit code is
    // 2 (system error → retry) rather than 1 (user error). The DB transaction
    // for the failed run + source must commit before the error is thrown.
    expect(syncRes.statusCode).toBe(502)
    expect(JSON.parse(syncRes.payload).error.code).toBe('PROVIDER_ERROR')

    const sourceRow = db.select().from(trafficSources).all()[0]
    expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
    expect(sourceRow.lastError).toMatch(/boom/)

    const runRow = db.select().from(runs).all()[0]
    expect(runRow.status).toBe(RunStatuses.failed)
    expect(runRow.error).toMatch(/boom/)

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('marks the source as error and returns PROVIDER_ERROR (502) when access-token resolution fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-routes-test-'))
    const dbPath = path.join(tmpDir, 'test.db')
    const db = createClient(dbPath)
    migrate(db)

    const credentials = new Map<string, CloudRunCredentialRecord>()
    const cloudRunCredentialStore: CloudRunCredentialStore = {
      getConnection: (n) => credentials.get(n),
      upsertConnection: (r) => { credentials.set(r.projectName, r); return r },
      deleteConnection: (n) => credentials.delete(n),
    }

    const app = Fastify()
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      cloudRunCredentialStore,
      pullCloudRunEvents: async () => ({
        events: [], rawEntryCount: 0, skippedEntryCount: 0, nextPageToken: undefined, filter: 'mock',
      }),
      resolveCloudRunAccessToken: async () => {
        throw new Error('IAM signBlob denied')
      },
    })
    await app.ready()

    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/test-project',
      payload: { displayName: 'Test', canonicalDomain: 'example.com', country: 'US', language: 'en' },
    })
    const connectRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
    })
    const sourceId = JSON.parse(connectRes.payload).id

    const syncRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
      payload: {},
    })
    expect(syncRes.statusCode).toBe(502)
    expect(JSON.parse(syncRes.payload).error.code).toBe('PROVIDER_ERROR')
    expect(JSON.parse(syncRes.payload).error.message).toMatch(/IAM signBlob denied/)

    const sourceRow = db.select().from(trafficSources).all()[0]
    expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
    const runRow = db.select().from(runs).all()[0]
    expect(runRow.status).toBe(RunStatuses.failed)

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('GET /traffic/sources', () => {
  it('returns an empty list when no sources are connected', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/test-project/traffic/sources' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload)).toEqual({ sources: [] })
    } finally { await h.close() }
  })

  it('returns the connected source after connect', async () => {
    const h = await buildHarness([])
    try {
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/test-project/traffic/sources' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.sources.length).toBe(1)
      expect(body.sources[0].sourceType).toBe(TrafficSourceTypes['cloud-run'])
      expect(body.sources[0].status).toBe(TrafficSourceStatuses.connected)
    } finally { await h.close() }
  })

  it('omits archived sources', async () => {
    const h = await buildHarness([])
    try {
      const { projects } = await import('@ainyc/canonry-db')
      const projectRow = h.db.select().from(projects).all()[0]
      const now = new Date().toISOString()
      h.db.insert(trafficSources).values({
        id: 'src_archived',
        projectId: projectRow.id,
        sourceType: TrafficSourceTypes['cloud-run'],
        displayName: 'old',
        status: TrafficSourceStatuses.archived,
        archivedAt: now,
        configJson: '{}',
        createdAt: now,
        updatedAt: now,
      }).run()

      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/test-project/traffic/sources' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload).sources.length).toBe(0)
    } finally { await h.close() }
  })

  it('404s for an unknown project', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/no-such/traffic/sources' })
      expect(res.statusCode).toBe(404)
    } finally { await h.close() }
  })
})

describe('GET /traffic/sources/:id', () => {
  it('returns 404 when the source does not belong to the project', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/test-project/traffic/sources/no-such' })
      expect(res.statusCode).toBe(404)
    } finally { await h.close() }
  })

  it('returns the source detail with 24h totals after a sync', async () => {
    // Snap to top-of-hour inside a fresh window so all events count toward totals24h.
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(30) }),
      buildEvent({
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(15),
      }),
    ]

    const h = await buildHarness(events)
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 120 },
      })

      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.id).toBe(sourceId)
      expect(body.status).toBe(TrafficSourceStatuses.connected)
      expect(body.totals24h.crawlerHits).toBe(2)
      expect(body.totals24h.aiReferralHits).toBe(1)
      expect(body.totals24h.sampleCount).toBe(3)
      expect(body.latestRun).not.toBeNull()
      expect(body.latestRun.status).toBe(RunStatuses.completed)
    } finally { await h.close() }
  })

  it('returns null latestRun when the source has never synced', async () => {
    const h = await buildHarness([])
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.latestRun).toBeNull()
      expect(body.totals24h).toEqual({ crawlerHits: 0, aiReferralHits: 0, sampleCount: 0 })
    } finally { await h.close() }
  })
})

describe('GET /traffic/events', () => {
  async function syncedHarness() {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(30) }),
      buildEvent({
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(15),
      }),
    ]

    const h = await buildHarness(events)
    const connectRes = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
    })
    const sourceId = JSON.parse(connectRes.payload).id
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
      payload: { sinceMinutes: 120 },
    })
    return { h, sourceId }
  }

  it('returns crawler + AI-referral rollups within the default 24h window', async () => {
    const { h } = await syncedHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totals.crawlerHits).toBe(2)
      expect(body.totals.aiReferralHits).toBe(1)
      expect(body.events.length).toBe(2)
      const kinds = body.events.map((e: { kind: string }) => e.kind).sort()
      expect(kinds).toEqual(['ai-referral', 'crawler'])
    } finally { await h.close() }
  })

  it('filters by kind=crawler', async () => {
    const { h } = await syncedHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?kind=crawler',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totals.crawlerHits).toBe(2)
      expect(body.totals.aiReferralHits).toBe(0)
      expect(body.events.length).toBe(1)
      expect(body.events[0].kind).toBe('crawler')
      expect(body.events[0].hits).toBe(2)
    } finally { await h.close() }
  })

  it('filters by kind=ai-referral', async () => {
    const { h } = await syncedHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?kind=ai-referral',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totals.crawlerHits).toBe(0)
      expect(body.totals.aiReferralHits).toBe(1)
      expect(body.events.length).toBe(1)
      expect(body.events[0].kind).toBe('ai-referral')
    } finally { await h.close() }
  })

  it('rejects invalid kind', async () => {
    const { h } = await syncedHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?kind=bogus',
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toMatch(/kind/)
    } finally { await h.close() }
  })

  it('rejects invalid since/until and reversed windows', async () => {
    const { h } = await syncedHarness()
    try {
      const bad = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?since=not-a-date',
      })
      expect(bad.statusCode).toBe(400)

      const reversed = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?since=2026-05-07T00:00:00Z&until=2026-05-06T00:00:00Z',
      })
      expect(reversed.statusCode).toBe(400)
    } finally { await h.close() }
  })

  it('returns totals over the full window even when limit truncates the events array', async () => {
    const { h } = await syncedHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?limit=1',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      // limit=1 trims the events array but totals must still reflect the full window.
      expect(body.events.length).toBe(1)
      expect(body.totals.crawlerHits).toBe(2)
      expect(body.totals.aiReferralHits).toBe(1)
    } finally { await h.close() }
  })

  it('returns 404 for an unknown project', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/no-such/traffic/events',
      })
      expect(res.statusCode).toBe(404)
    } finally { await h.close() }
  })
})
