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
import type {
  ListWordpressTrafficEventsOptions,
  WordpressTrafficEventsPage,
} from '@ainyc/canonry-integration-wordpress-traffic'
import { WordpressTrafficApiError } from '@ainyc/canonry-integration-wordpress-traffic'
import { apiRoutes } from '../src/index.js'
import type {
  CloudRunCredentialRecord,
  CloudRunCredentialStore,
  WordpressTrafficCredentialRecord,
  WordpressTrafficCredentialStore,
} from '../src/traffic.js'

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

function buildWpEvent(overrides: Partial<NormalizedTrafficRequest> = {}): NormalizedTrafficRequest {
  return buildEvent({
    sourceType: 'wordpress',
    eventId: `wordpress:${overrides.observedAt ?? '2026-05-07T17:32:00.000Z'}:${Math.floor(Math.random() * 1_000_000)}`,
    providerResource: { type: 'wordpress_site', labels: { host: 'example.com' } },
    ...overrides,
  })
}

async function buildHarness(
  events: NormalizedTrafficRequest[],
  options: {
    bypassTimeFilter?: boolean
    /** Force the access-token resolver to fail with this message. */
    failResolveAccessTokenWith?: string
    /** Force the Cloud Run pull to fail with this message. */
    failPullWith?: string
    /** Force the WordPress traffic pull (used for probe) to throw a `WordpressTrafficApiError`. */
    failWpProbeWith?: { status: number; message: string; body?: string }
    /** Force the WordPress traffic pull (used by sync) to throw an Error with this message. */
    failWpPullWith?: string
    /**
     * Programmable WordPress sync pull. When provided, replaces the default
     * empty-page probe stub for the WordPress pull function. Tests for WP
     * sync use this to model multi-page cursor pagination; the probe path
     * (limit=1, no cursor) is also routed through it.
     */
    wpPullPages?: (call: { cursor: string | undefined; pageSize: number }) => WordpressTrafficEventsPage
  } = {},
) {
  const trafficSyncedEvents: Array<unknown> = []
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

  const wpCredentials = new Map<string, WordpressTrafficCredentialRecord>()
  const wordpressTrafficCredentialStore: WordpressTrafficCredentialStore = {
    getConnection: (projectName) => wpCredentials.get(projectName),
    upsertConnection: (record) => {
      wpCredentials.set(record.projectName, record)
      return record
    },
    deleteConnection: (projectName) => wpCredentials.delete(projectName),
  }

  const wpProbeInvocations: ListWordpressTrafficEventsOptions[] = []

  let pullInvocations = 0
  const observedWindows: Array<{ startTime: string; endTime: string }> = []
  const observedFirstSync: Array<boolean | undefined> = []
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    cloudRunCredentialStore,
    pullCloudRunEvents: async (_token, pullOptions): Promise<CloudRunTrafficEventsPage> => {
      pullInvocations += 1
      observedWindows.push({ startTime: pullOptions.startTime, endTime: pullOptions.endTime })
      observedFirstSync.push(pullOptions.firstSync)
      if (options.failPullWith) throw new Error(options.failPullWith)
      // Default: mirror Cloud Logging's behavior and only return events inside the
      // requested window. Tests that exercise cross-sync boundary semantics
      // (where Cloud Logging may legitimately re-return the same event in two
      // adjacent pulls) opt out via `bypassTimeFilter`.
      const filtered = options.bypassTimeFilter
        ? events.slice()
        : events.filter((e) => {
          const t = new Date(e.observedAt).getTime()
          return t >= new Date(pullOptions.startTime).getTime()
            && t <= new Date(pullOptions.endTime).getTime()
        })
      return {
        events: filtered,
        rawEntryCount: filtered.length,
        skippedEntryCount: 0,
        nextPageToken: undefined,
        filter: 'mock',
      }
    },
    resolveCloudRunAccessToken: async () => {
      if (options.failResolveAccessTokenWith) throw new Error(options.failResolveAccessTokenWith)
      return 'mock-access-token'
    },
    wordpressTrafficCredentialStore,
    pullWordpressTrafficEvents: async (pullOptions): Promise<WordpressTrafficEventsPage> => {
      wpProbeInvocations.push(pullOptions)
      // Probe path: connect-route calls with pageSize=1, maxPages=1 — surface
      // the probe-failure injection here so the connect-route test still
      // works the same way it did before WP sync existed.
      if (pullOptions.pageSize === 1 && options.failWpProbeWith) {
        throw new WordpressTrafficApiError(
          options.failWpProbeWith.message,
          options.failWpProbeWith.status,
          options.failWpProbeWith.body,
        )
      }
      // `failWpPullWith` simulates a sync-time failure. The connect route
      // uses pageSize=1 for its up-front probe — gate the injection on
      // pageSize !== 1 so the same harness can still connect successfully
      // before the sync fails.
      if (pullOptions.pageSize !== 1 && options.failWpPullWith) throw new Error(options.failWpPullWith)
      if (options.wpPullPages) {
        const page = options.wpPullPages({
          cursor: pullOptions.cursor,
          pageSize: pullOptions.pageSize ?? 500,
        })
        return {
          ...page,
          endpoint: `${pullOptions.baseUrl}/wp-json/canonry/v1/events`,
        }
      }
      return {
        events: [],
        rawEntryCount: 0,
        skippedEntryCount: 0,
        nextCursor: undefined,
        endpoint: `${pullOptions.baseUrl}/wp-json/canonry/v1/events`,
      }
    },
    onTrafficSynced: (event) => { trafficSyncedEvents.push(event) },
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
    wpCredentials,
    tmpDir,
    getPullCount: () => pullInvocations,
    getObservedWindows: () => observedWindows,
    getObservedFirstSync: () => observedFirstSync,
    getTrafficSyncedEvents: () => trafficSyncedEvents,
    getWpProbeInvocations: () => wpProbeInvocations,
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

describe('POST /traffic/connect/wordpress', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>
  beforeEach(async () => { h = await buildHarness([]) })
  afterEach(async () => { await h.close() })

  const validBody = {
    baseUrl: 'https://example.com',
    username: 'canonry-bot',
    applicationPassword: 'xxxx xxxx xxxx xxxx xxxx xxxx',
  }

  it('rejects requests with an invalid baseUrl', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: { ...validBody, baseUrl: 'not-a-url' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects requests with empty applicationPassword', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: { ...validBody, applicationPassword: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('probes the plugin endpoint, persists credentials, and creates the source row', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: { ...validBody, displayName: 'Example WP' },
    })
    expect(res.statusCode).toBe(200)
    const dto = JSON.parse(res.payload)
    expect(dto.sourceType).toBe(TrafficSourceTypes.wordpress)
    expect(dto.status).toBe(TrafficSourceStatuses.connected)
    expect(dto.displayName).toBe('Example WP')
    expect(dto.config.baseUrl).toBe('https://example.com')
    expect(dto.config.username).toBe('canonry-bot')
    // Application password must never leak into the row config; it lives in
    // ~/.canonry/config.yaml only.
    expect(dto.config.applicationPassword).toBeUndefined()

    // Probe ran once before any persistence.
    const probes = h.getWpProbeInvocations()
    expect(probes.length).toBe(1)
    expect(probes[0]!.baseUrl).toBe('https://example.com')
    expect(probes[0]!.pageSize).toBe(1)

    const stored = h.wpCredentials.get('test-project')
    expect(stored?.applicationPassword).toBe('xxxx xxxx xxxx xxxx xxxx xxxx')

    const sourceRows = h.db.select().from(trafficSources).all()
    expect(sourceRows.length).toBe(1)
    expect(sourceRows[0].sourceType).toBe(TrafficSourceTypes.wordpress)
  })

  it('returns 502 and persists nothing when the probe fails with bad credentials', async () => {
    await h.close()
    h = await buildHarness([], {
      failWpProbeWith: { status: 401, message: 'Unauthorized', body: 'bad password' },
    })

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: validBody,
    })
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.payload).error.message).toMatch(/HTTP 401/)
    // Probe ran but neither credential nor source row was written.
    expect(h.wpCredentials.get('test-project')).toBeUndefined()
    expect(h.db.select().from(trafficSources).all().length).toBe(0)
  })

  it('reuses the existing source row on reconnect rather than creating a duplicate', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: validBody,
    })
    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: { ...validBody, baseUrl: 'https://example.com', username: 'new-bot' },
    })
    expect(second.statusCode).toBe(200)
    const sources = h.db.select().from(trafficSources).all()
    expect(sources.length).toBe(1)
    const config = JSON.parse(sources[0].configJson) as Record<string, unknown>
    expect(config.username).toBe('new-bot')
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

  it('advances lastSyncedAt to windowEnd (not finishedAt) so events in the processing gap survive into the next sync', async () => {
    // Regression: if lastSyncedAt rolled forward to the transaction's
    // finishedAt instead of the pull's windowEnd, then events with
    // observedAt in (windowEnd, finishedAt] would be lost forever — sync 1
    // didn't pull them (timestamp > endTime) and sync 2 would clamp past
    // them. Assert the cursor matches windowEnd exactly, and that a new
    // event at the boundary is picked up by the next sync.
    const observedAt = new Date(Date.now() - 30 * 60_000).toISOString()
    const events: NormalizedTrafficRequest[] = [
      buildEvent({ eventId: 'evt-1', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt }),
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
        payload: {},
      })
      const firstWindow = h.getObservedWindows()[0]!

      const sourceAfterFirst = h.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, sourceId))
        .get()!
      expect(sourceAfterFirst.lastSyncedAt).toBe(firstWindow.endTime)

      // Inject a new event AT the boundary timestamp — observable only by
      // sync 2 if its windowStart equals sync 1's windowEnd.
      events.push(buildEvent({
        eventId: 'evt-boundary',
        userAgent: 'GPTBot/1.0',
        path: '/blog/boundary',
        status: 200,
        observedAt: firstWindow.endTime,
      }))

      const second = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(JSON.parse(second.payload).pulledEvents).toBe(1)
      const paths = h.db
        .select()
        .from(crawlerEventsHourly)
        .all()
        .map((r) => r.pathNormalized)
        .sort()
      expect(paths).toEqual(['/blog/boundary', '/blog/foo'])
    } finally {
      await h.close()
    }
  })

  it('clamps windowStart to lastSyncedAt so overlapping syncs do not double-count', async () => {
    // Event sits inside the default sync window for the first sync. After
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

  it('flags the first sync to the Cloud Run pull and clears it on subsequent syncs', async () => {
    // The route signals "first-time backfill" via a semantic flag — the
    // adapter decides what pull strategy that implies (timestamp desc here,
    // larger budget tomorrow). Steady-state syncs reset the flag so the
    // adapter's incremental defaults apply.
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

      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })

      expect(h.getObservedFirstSync()).toEqual([true, false])
    } finally {
      await h.close()
    }
  })

  it('keeps firstSync=true after a failed first sync (lastSyncedAt still null)', async () => {
    // A first sync that fails before commit leaves `lastSyncedAt` null, so the
    // next attempt is still effectively the first sync and must keep the flag —
    // otherwise a busy site that fails once at boot would silently skip its
    // recent week on the retry.
    const h = await buildHarness([], { failPullWith: 'transient 503' })
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
        payload: {},
      })
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })

      expect(h.getObservedFirstSync()).toEqual([true, true])
    } finally {
      await h.close()
    }
  })

  it('dedupes by eventId across syncs when the boundary window re-returns the same event', async () => {
    // Cloud Logging can legitimately re-return events whose timestamp equals
    // the boundary lastSyncedAt second. Without insertId-based dedupe the
    // hourly rollup `hits + N` upsert would double-count those rows. We
    // bypass the harness's time-window filter to simulate that overlap and
    // assert the second sync drops the duplicate while accepting any genuinely
    // new event.
    const observedAt = new Date(Date.now() - 30 * 60_000).toISOString()
    const dup = buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt, eventId: 'cloud-run:dup-1' })
    const fresh = buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/bar', status: 200, observedAt, eventId: 'cloud-run:fresh-1' })

    const events: NormalizedTrafficRequest[] = [dup]
    const h = await buildHarness(events, { bypassTimeFilter: true })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      // First sync ingests the duplicate event for the first time.
      const first = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(JSON.parse(first.payload).pulledEvents).toBe(1)

      // The dup event ID should be persisted on the source row.
      const afterFirst = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).all()
      expect(JSON.parse(afterFirst[0].lastEventIds ?? '[]')).toContain('cloud-run:dup-1')

      // Push a new event into the harness's array — Cloud Logging's
      // bypass-time-filter mock will now return [dup, fresh]. The deduper
      // must drop dup and only roll up fresh.
      events.push(fresh)

      const second = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      // Only the genuinely-new event made it past dedupe.
      expect(JSON.parse(second.payload).pulledEvents).toBe(1)

      // The crawler rollup should now have exactly two distinct (path) rows,
      // each with hits=1 — proves the dup was not double-counted.
      const rows = h.db.select().from(crawlerEventsHourly).all()
      const byPath = Object.fromEntries(rows.map((r) => [r.pathNormalized, r.hits]))
      expect(byPath['/blog/foo']).toBe(1)
      expect(byPath['/blog/bar']).toBe(1)

      // Third sync with no new events: expect zero ingested, zero new rows.
      const third = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(JSON.parse(third.payload).pulledEvents).toBe(0)
      const finalRows = h.db.select().from(crawlerEventsHourly).all()
      expect(finalRows.length).toBe(2)
      expect(finalRows.find((r) => r.pathNormalized === '/blog/foo')?.hits).toBe(1)
      expect(finalRows.find((r) => r.pathNormalized === '/blog/bar')?.hits).toBe(1)
    } finally {
      await h.close()
    }
  })

  it('caps lastEventIds at MAX_TRACKED_EVENT_IDS so the ring buffer cannot grow unbounded', async () => {
    // Generate many distinct events; assert the persisted ring buffer
    // stays bounded and contains the most-recent IDs.
    const N = 1100
    const baseMs = Date.now() - 60 * 60_000
    const events: NormalizedTrafficRequest[] = []
    for (let i = 0; i < N; i++) {
      events.push(buildEvent({
        userAgent: 'GPTBot/1.0',
        path: `/p/${i}`,
        status: 200,
        observedAt: new Date(baseMs + i * 1_000).toISOString(),
        eventId: `cloud-run:bulk:${i.toString().padStart(4, '0')}`,
      }))
    }
    const h = await buildHarness(events, { bypassTimeFilter: true })
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
        payload: {},
      })

      const rows = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).all()
      const persisted: string[] = JSON.parse(rows[0].lastEventIds ?? '[]')
      // Ring buffer must be bounded.
      expect(persisted.length).toBeLessThanOrEqual(1_000)
      expect(persisted.length).toBeGreaterThan(0)
      // Must keep the most-recent IDs (highest indices), not the oldest.
      expect(persisted).toContain('cloud-run:bulk:1099')
      expect(persisted).not.toContain('cloud-run:bulk:0000')
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

  it('fires onTrafficSynced with status=completed and aggregated counts on success', async () => {
    const observedAt = new Date(Date.now() - 30 * 60_000).toISOString()
    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt }),
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/bar', status: 200, observedAt, eventId: 'evt-2' }),
    ]
    const h = await buildHarness(events)
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(200)

      const fired = h.getTrafficSyncedEvents()
      expect(fired.length).toBe(1)
      const ev = fired[0] as {
        status: string; sourceType: string; sourceId: string
        pulledEvents: number; crawlerHits: number; aiReferralHits: number
        durationMs: number; errorCode?: string
      }
      expect(ev.status).toBe('completed')
      expect(ev.sourceType).toBe('cloud-run')
      expect(ev.sourceId).toBe(sourceId)
      expect(ev.pulledEvents).toBe(2)
      expect(ev.crawlerHits).toBeGreaterThanOrEqual(2)
      expect(ev.aiReferralHits).toBe(0)
      expect(ev.durationMs).toBeGreaterThanOrEqual(0)
      expect(ev.errorCode).toBeUndefined()
    } finally {
      await h.close()
    }
  })

  it('fires onTrafficSynced with status=failed and errorCode=PROVIDER_AUTH when token resolution fails', async () => {
    const h = await buildHarness([], { failResolveAccessTokenWith: 'invalid_grant' })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(502)

      const fired = h.getTrafficSyncedEvents()
      expect(fired.length).toBe(1)
      const ev = fired[0] as {
        status: string; pulledEvents: number; errorCode?: string
      }
      expect(ev.status).toBe('failed')
      expect(ev.errorCode).toBe('PROVIDER_AUTH')
      expect(ev.pulledEvents).toBe(0)
    } finally {
      await h.close()
    }
  })

  it('fires onTrafficSynced with errorCode=PROVIDER_PULL when the pull throws', async () => {
    const h = await buildHarness([], { failPullWith: 'Cloud Logging 503 backend unavailable' })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id
      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(502)

      const fired = h.getTrafficSyncedEvents()
      expect(fired.length).toBe(1)
      expect((fired[0] as { errorCode: string }).errorCode).toBe('PROVIDER_PULL')
    } finally {
      await h.close()
    }
  })
})

describe('POST /traffic/sources/:id/sync — WordPress', () => {
  const wpConnectBody = {
    baseUrl: 'https://example.com',
    username: 'canonry-bot',
    applicationPassword: 'xxxx xxxx xxxx xxxx xxxx xxxx',
  }

  async function connectWp(h: Awaited<ReturnType<typeof buildHarness>>): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: wpConnectBody,
    })
    if (res.statusCode !== 200) throw new Error(`connect failed: ${res.statusCode} ${res.payload}`)
    return JSON.parse(res.payload).id
  }

  it('returns validationError pointing to `canonry traffic connect wordpress` when no WP credential is stored', async () => {
    // Seed a WP traffic source row WITHOUT going through the connect route,
    // so the credential store stays empty. Sync must surface a helpful 400
    // that points to the connect CLI rather than a 500.
    const h = await buildHarness([])
    try {
      const { projects } = await import('@ainyc/canonry-db')
      const projectRow = h.db.select().from(projects).all()[0]
      const now = new Date().toISOString()
      h.db.insert(trafficSources).values({
        id: 'src_wp_orphan',
        projectId: projectRow.id,
        sourceType: TrafficSourceTypes.wordpress,
        displayName: 'orphan wp',
        status: TrafficSourceStatuses.connected,
        configJson: JSON.stringify({ baseUrl: 'https://example.com', username: 'bot' }),
        createdAt: now,
        updatedAt: now,
      }).run()

      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/sources/src_wp_orphan/sync',
        payload: {},
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.payload)
      expect(body.error.message).toMatch(/canonry traffic connect wordpress/)
    } finally {
      await h.close()
    }
  })

  it('pulls multi-page events via opaque cursor, persists the final nextCursor, lands rollups, advances lastSyncedAt to windowEnd, and finalizes the run as completed', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    // Two pages of events, joined by cursor pagination. Page 1 returns
    // next_cursor=PAGE2, page 2 returns next_cursor=PAGE_DONE with has_more=false.
    // Sync must follow the cursor to exhaustion and persist PAGE_DONE on the row.
    const page1Events: NormalizedTrafficRequest[] = [
      buildWpEvent({ eventId: 'wordpress:p1:1', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildWpEvent({ eventId: 'wordpress:p1:2', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(20) }),
    ]
    const page2Events: NormalizedTrafficRequest[] = [
      buildWpEvent({
        eventId: 'wordpress:p2:3',
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(35),
      }),
    ]

    const cursorObservations: Array<string | undefined> = []
    const h = await buildHarness([], {
      wpPullPages: ({ cursor }) => {
        cursorObservations.push(cursor)
        if (cursor === undefined || cursor === '') {
          return { events: page1Events, rawEntryCount: 2, skippedEntryCount: 0, nextCursor: 'PAGE2', endpoint: '' }
        }
        if (cursor === 'PAGE2') {
          return { events: page2Events, rawEntryCount: 1, skippedEntryCount: 0, nextCursor: 'PAGE_DONE', endpoint: '' }
        }
        throw new Error(`Unexpected cursor: ${cursor}`)
      },
    })
    try {
      const sourceId = await connectWp(h)

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(200)
      const body = JSON.parse(syncRes.payload)
      expect(body.pulledEvents).toBe(3)
      expect(body.crawlerHits).toBe(2)
      expect(body.aiReferralHits).toBe(1)
      expect(body.crawlerBucketRows).toBe(1)
      expect(body.aiReferralBucketRows).toBe(1)
      expect(body.sampleRows).toBe(3)
      expect(body.runId).toBeDefined()

      // Pull was called once for connect probe (cursor=undefined, pageSize=1)
      // and then for both sync pages: page 1 (undefined cursor) + page 2 ('PAGE2').
      // The probe and page-1 are both `cursor=undefined` but happen in different
      // invocations — assert at minimum that PAGE2 was followed by the sync.
      expect(cursorObservations).toContain('PAGE2')

      // Final cursor is persisted on the row so the next sync resumes from there.
      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.lastCursor).toBe('PAGE_DONE')

      // lastSyncedAt advances to windowEnd (which the WP path defines as the
      // sync start moment) — not finishedAt. Asserting it is set + valid ISO is
      // enough; the Cloud Run path's regression test covers the precise gap
      // semantics and the same code path is reused.
      expect(sourceRow.lastSyncedAt).toBeTruthy()
      expect(new Date(sourceRow.lastSyncedAt!).getTime()).toBeGreaterThan(0)
      expect(sourceRow.lastError).toBeNull()

      // Crawler + AI referral rollups land in the same way as Cloud Run.
      const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
      expect(crawlerRows.length).toBe(1)
      expect(crawlerRows[0].hits).toBe(2)
      expect(crawlerRows[0].botId).toBe('openai-gptbot')

      const aiRows = h.db.select().from(aiReferralEventsHourly).all()
      expect(aiRows.length).toBe(1)
      expect(aiRows[0].evidenceType).toBe('utm')
      expect(aiRows[0].sessionsOrHits).toBe(1)

      const samples = h.db.select().from(rawEventSamples).all()
      expect(samples.length).toBe(3)

      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].kind).toBe(RunKinds['traffic-sync'])
      expect(runRows[0].status).toBe(RunStatuses.completed)
      expect(runRows[0].sourceId).toBe(sourceId)
    } finally {
      await h.close()
    }
  })

  it('resumes from the persisted cursor on the next sync (does not restart from undefined)', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)

    const cursorCalls: Array<string | undefined> = []
    let invocation = 0
    const h = await buildHarness([], {
      wpPullPages: ({ cursor }) => {
        cursorCalls.push(cursor)
        invocation += 1
        if (invocation === 1) {
          // Probe (pageSize=1, no cursor). Empty.
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, nextCursor: undefined, endpoint: '' }
        }
        if (invocation === 2) {
          // First sync: returns one event and a cursor for next time.
          return {
            events: [buildWpEvent({ eventId: 'wordpress:r:1', path: '/r1', observedAt: new Date(baseTime.getTime() + 5 * 60_000).toISOString() })],
            rawEntryCount: 1,
            skippedEntryCount: 0,
            nextCursor: 'RESUME_HERE',
            endpoint: '',
          }
        }
        // Second sync: cursor must equal what we returned, and we yield one new event.
        return {
          events: [buildWpEvent({ eventId: 'wordpress:r:2', path: '/r2', observedAt: new Date(baseTime.getTime() + 10 * 60_000).toISOString() })],
          rawEntryCount: 1,
          skippedEntryCount: 0,
          nextCursor: 'AFTER_RESUME',
          endpoint: '',
        }
      },
    })
    try {
      const sourceId = await connectWp(h)

      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      const firstRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(firstRow.lastCursor).toBe('RESUME_HERE')

      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })

      // The third pull invocation (first call of the second sync) MUST pass
      // cursor='RESUME_HERE' — proves the sync resumed from the persisted cursor.
      expect(cursorCalls[2]).toBe('RESUME_HERE')

      const secondRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(secondRow.lastCursor).toBe('AFTER_RESUME')
    } finally {
      await h.close()
    }
  })

  it('marks the source as error and returns PROVIDER_ERROR (502) when the WP pull throws', async () => {
    const h = await buildHarness([], { failWpPullWith: 'WordPress endpoint 500: gateway' })
    try {
      const sourceId = await connectWp(h)

      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(res.statusCode).toBe(502)
      const body = JSON.parse(res.payload)
      expect(body.error.code).toBe('PROVIDER_ERROR')
      expect(body.error.message).toMatch(/gateway/)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
      expect(sourceRow.lastError).toMatch(/gateway/)

      // No rollup writes should have happened — failing before commit.
      expect(h.db.select().from(crawlerEventsHourly).all().length).toBe(0)
      expect(h.db.select().from(aiReferralEventsHourly).all().length).toBe(0)
      expect(h.db.select().from(rawEventSamples).all().length).toBe(0)

      const runRow = h.db.select().from(runs).where(eq(runs.sourceId, sourceId)).all()[0]
      expect(runRow.status).toBe(RunStatuses.failed)
      expect(runRow.error).toMatch(/gateway/)

      const fired = h.getTrafficSyncedEvents()
      const wpEvent = fired.find((e) => (e as { sourceType: string }).sourceType === 'wordpress') as { status: string; errorCode: string } | undefined
      expect(wpEvent?.status).toBe('failed')
      expect(wpEvent?.errorCode).toBe('PROVIDER_PULL')
    } finally {
      await h.close()
    }
  })

  it('dedupes by eventId across syncs when the boundary cursor re-returns the same event', async () => {
    // Plugin (or upstream caching) may re-emit the same event on the next page
    // boundary — the sync must drop it via the cross-sync ring buffer and avoid
    // double-counting. Mirrors the cloud-run dedupe test.
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const dupEvent = buildWpEvent({
      eventId: 'wordpress:dup:1',
      userAgent: 'GPTBot/1.0',
      path: '/blog/foo',
      status: 200,
      observedAt: new Date(baseTime.getTime() + 5 * 60_000).toISOString(),
    })
    const freshEvent = buildWpEvent({
      eventId: 'wordpress:fresh:1',
      userAgent: 'GPTBot/1.0',
      path: '/blog/bar',
      status: 200,
      observedAt: new Date(baseTime.getTime() + 10 * 60_000).toISOString(),
    })

    let pullCall = 0
    const h = await buildHarness([], {
      wpPullPages: () => {
        pullCall += 1
        if (pullCall === 1) {
          // Probe — empty.
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, nextCursor: undefined, endpoint: '' }
        }
        if (pullCall === 2) {
          // First sync: just the dup, single page, has_more=false.
          return { events: [dupEvent], rawEntryCount: 1, skippedEntryCount: 0, nextCursor: 'CURSOR_AFTER_FIRST', endpoint: '' }
        }
        // Second sync: plugin re-emits dup AND emits the fresh event.
        return {
          events: [dupEvent, freshEvent],
          rawEntryCount: 2,
          skippedEntryCount: 0,
          nextCursor: 'CURSOR_AFTER_SECOND',
          endpoint: '',
        }
      },
    })
    try {
      const sourceId = await connectWp(h)

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
      // Only the genuinely new event made it past dedupe.
      expect(JSON.parse(second.payload).pulledEvents).toBe(1)

      const rows = h.db.select().from(crawlerEventsHourly).all()
      const byPath = Object.fromEntries(rows.map((r) => [r.pathNormalized, r.hits]))
      expect(byPath['/blog/foo']).toBe(1)
      expect(byPath['/blog/bar']).toBe(1)
    } finally {
      await h.close()
    }
  })
})

describe('POST /traffic/sources/:id/backfill', () => {
  // Helper that polls the run row until status moves off 'running' or
  // the timeout trips, so async tests don't depend on internal scheduling.
  async function waitForRunComplete(
    db: ReturnType<typeof createClient>,
    runId: string,
    timeoutMs = 2000,
  ): Promise<typeof runs.$inferSelect> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const row = db.select().from(runs).where(eq(runs.id, runId)).get()
      if (row && row.status !== RunStatuses.running) return row
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`)
  }

  it('returns runId + status=running synchronously, then replaces rollups in the window once the background task finishes', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(15) }),
      buildEvent({
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(30),
      }),
    ]
    const h = await buildHarness(events, { bypassTimeFilter: true })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)
      // Synchronous response: just the run handle, no counts yet.
      expect(submitted.status).toBe(RunStatuses.running)
      expect(submitted.runId).toBeDefined()
      expect(submitted.daysApplied).toBe(7)
      expect(submitted.daysRequested).toBe(7)

      // Wait for the background task to complete, then assert state.
      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.completed)
      expect(finalRun.trigger).toBe('backfill')
      expect(finalRun.kind).toBe(RunKinds['traffic-sync'])

      const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
      expect(crawlerRows.length).toBe(1)
      expect(crawlerRows[0].hits).toBe(2)

      const aiRows = h.db.select().from(aiReferralEventsHourly).all()
      expect(aiRows.length).toBe(1)
      expect(aiRows[0].sessionsOrHits).toBe(1)
      expect(aiRows[0].evidenceType).toBe('utm')
    } finally {
      await h.close()
    }
  })

  it('replaces existing buckets in the window rather than accumulating (no double-counting)', async () => {
    // Seed via a normal sync, then backfill the same window with the same
    // source events. Crawler hits must stay at 2, not 4.
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()
    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(15) }),
    ]
    const h = await buildHarness(events, { bypassTimeFilter: true })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      // Initial sync — accumulates hits=2.
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 120 },
      })
      const afterSync = h.db.select().from(crawlerEventsHourly).all()
      expect(afterSync[0].hits).toBe(2)

      // Backfill the same window. Replace mode should reset to hits=2,
      // not add to existing for hits=4.
      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 1 },
      })
      const submitted = JSON.parse(submitRes.payload)
      await waitForRunComplete(h.db, submitted.runId)

      const afterBackfill = h.db.select().from(crawlerEventsHourly).all()
      expect(afterBackfill.length).toBe(1)
      expect(afterBackfill[0].hits).toBe(2)
    } finally {
      await h.close()
    }
  })

  it('caps days at MAX_BACKFILL_DAYS (30) when a larger value is requested', async () => {
    const h = await buildHarness([])
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 365 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)
      expect(submitted.daysRequested).toBe(365)
      expect(submitted.daysApplied).toBe(30)
    } finally {
      await h.close()
    }
  })

  it('rejects non-positive days', async () => {
    const h = await buildHarness([])
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const zero = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 0 },
      })
      expect(zero.statusCode).toBe(400)
      const negative = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: -3 },
      })
      expect(negative.statusCode).toBe(400)
    } finally {
      await h.close()
    }
  })

  it('returns 404 when the source does not belong to the project', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/sources/no-such/backfill',
        payload: {},
      })
      expect(res.statusCode).toBe(404)
    } finally {
      await h.close()
    }
  })

  it('does not roll lastSyncedAt backward when the existing cursor is ahead of windowEnd', async () => {
    // First, seed a source with a lastSyncedAt that's > windowEnd (future).
    // The backfill must keep the existing cursor, not reset it to the older
    // backfill window — otherwise next incremental sync would re-pull a gap.
    const events: NormalizedTrafficRequest[] = [
      buildEvent({
        userAgent: 'GPTBot/1.0',
        path: '/blog/foo',
        status: 200,
        observedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      }),
    ]
    const h = await buildHarness(events, { bypassTimeFilter: true })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      // Manually advance lastSyncedAt to 1h in the future.
      const future = new Date(Date.now() + 60 * 60_000).toISOString()
      h.db
        .update(trafficSources)
        .set({ lastSyncedAt: future, updatedAt: future })
        .where(eq(trafficSources.id, sourceId))
        .run()

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      const submitted = JSON.parse(submitRes.payload)
      await waitForRunComplete(h.db, submitted.runId)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()
      expect(sourceRow?.lastSyncedAt).toBe(future)
    } finally {
      await h.close()
    }
  })

  it('treats an empty Cloud Run pull as a no-op and preserves existing rollup data', async () => {
    // Misconfigured serviceName, transient permission glitch, or genuinely
    // quiet site → pull returns 0 events. Backfill must NOT delete the
    // existing rollup buckets in the window (otherwise a misconfigured
    // backfill silently wipes historical data).
    const h = await buildHarness([])
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const source = JSON.parse(connectRes.payload)

      // Seed an existing crawler bucket inside what will become the backfill
      // window. If the empty-pull guard is wrong, this row gets deleted.
      const seedTime = new Date().toISOString()
      const seededHour = new Date(Date.now() - 2 * 60 * 60_000)
      seededHour.setUTCMinutes(0, 0, 0)
      h.db.insert(crawlerEventsHourly).values({
        projectId: source.projectId,
        sourceId: source.id,
        tsHour: seededHour.toISOString(),
        botId: 'openai-gptbot',
        operator: 'OpenAI',
        verificationStatus: 'claimed_unverified',
        pathNormalized: '/blog/foo',
        status: 200,
        hits: 7,
        sampledUserAgent: 'GPTBot/1.0',
        createdAt: seedTime,
        updatedAt: seedTime,
      }).run()

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${source.id}/backfill`,
        payload: { days: 1 },
      })
      const submitted = JSON.parse(submitRes.payload)
      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.completed)

      const buckets = h.db.select().from(crawlerEventsHourly).all()
      expect(buckets.length).toBe(1)
      expect(buckets[0].hits).toBe(7)
    } finally {
      await h.close()
    }
  })

  it('replaces the boundary-hour bucket cleanly when windowStart falls mid-hour', async () => {
    // Without hour-flooring, an existing bucket at floor(windowStart, hour)
    // has tsHour < raw windowStart so the delete misses it, but the new pull
    // re-emits a bucket at the same tsHour — the plain insert then trips the
    // composite primary key and rolls the whole transaction back.
    const now = Date.now()
    const rawWindowStart = new Date(now - 86_400_000) // matches days=1
    const boundaryHour = new Date(rawWindowStart)
    boundaryHour.setUTCMinutes(0, 0, 0)
    const boundaryHourIso = boundaryHour.toISOString()
    // New event sits inside the boundary hour, after raw windowStart.
    const eventInBoundaryHour = new Date(boundaryHour.getTime() + 35 * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({
        userAgent: 'GPTBot/1.0',
        path: '/blog/foo',
        status: 200,
        observedAt: eventInBoundaryHour,
      }),
    ]
    const h = await buildHarness(events, { bypassTimeFilter: true })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const source = JSON.parse(connectRes.payload)

      // Pre-seed an existing bucket at the boundary hour with the SAME
      // (bot, verification, path, status) tuple as what the new event
      // would produce — that's what triggers the PK conflict.
      const seedTime = new Date().toISOString()
      h.db.insert(crawlerEventsHourly).values({
        projectId: source.projectId,
        sourceId: source.id,
        tsHour: boundaryHourIso,
        botId: 'openai-gptbot',
        operator: 'OpenAI',
        verificationStatus: 'claimed_unverified',
        pathNormalized: '/blog/foo',
        status: 200,
        hits: 5,
        sampledUserAgent: 'GPTBot/1.0',
        createdAt: seedTime,
        updatedAt: seedTime,
      }).run()

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${source.id}/backfill`,
        payload: { days: 1 },
      })
      const submitted = JSON.parse(submitRes.payload)
      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.completed)

      const buckets = h.db.select().from(crawlerEventsHourly).all()
      expect(buckets.length).toBe(1)
      expect(buckets[0].tsHour).toBe(boundaryHourIso)
      // Replaced (1), not the seeded 5 nor the additive 6.
      expect(buckets[0].hits).toBe(1)
    } finally {
      await h.close()
    }
  })

  it('marks the run as failed when the pull throws and surfaces lastError on the source', async () => {
    const h = await buildHarness([], { failPullWith: 'Cloud Logging 503' })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      // Async — synchronous response is still 200; the failure shows up
      // on the run row and traffic_sources.last_error.
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)

      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.failed)
      expect(finalRun.error).toMatch(/503/)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()
      expect(sourceRow?.status).toBe(TrafficSourceStatuses.error)
      expect(sourceRow?.lastError).toMatch(/503/)
    } finally {
      await h.close()
    }
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

  it('isolates latestRun per source — source A does not see source B\'s sync runs', async () => {
    // Single Cloud Run source from connect, plus a manually-inserted second source for the same project.
    const h = await buildHarness([
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200 }),
    ])
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceAId = JSON.parse(connectRes.payload).id

      // Sync only against source A — this writes runs.source_id = sourceAId.
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceAId}/sync`,
        payload: { sinceMinutes: 120 },
      })

      // Seed a second non-archived source for the same project (manual insert; the API
      // doesn't currently support multi-source connect, but DB and reads must be correct).
      const { projects } = await import('@ainyc/canonry-db')
      const projectRow = h.db.select().from(projects).all()[0]
      const now = new Date().toISOString()
      const sourceBId = 'src_b_isolation_test'
      h.db.insert(trafficSources).values({
        id: sourceBId,
        projectId: projectRow.id,
        sourceType: TrafficSourceTypes['cloud-run'],
        displayName: 'second source',
        status: TrafficSourceStatuses.connected,
        configJson: '{}',
        createdAt: now,
        updatedAt: now,
      }).run()

      const detailA = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceAId}`,
      })
      const bodyA = JSON.parse(detailA.payload)
      expect(bodyA.latestRun).not.toBeNull()
      expect(bodyA.latestRun.status).toBe(RunStatuses.completed)

      // Source B has never synced — must surface null even though source A has a run on the same project.
      const detailB = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceBId}`,
      })
      const bodyB = JSON.parse(detailB.payload)
      expect(bodyB.latestRun).toBeNull()
    } finally { await h.close() }
  })
})

describe('GET /traffic/status', () => {
  it('returns an empty list when no sources are connected', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/test-project/traffic/status' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload)).toEqual({ sources: [] })
    } finally { await h.close() }
  })

  it('returns the same per-source detail shape as /traffic/sources/:id without a fan-out', async () => {
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

      const statusRes = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/status',
      })
      expect(statusRes.statusCode).toBe(200)
      const status = JSON.parse(statusRes.payload)
      expect(status.sources.length).toBe(1)
      expect(status.sources[0].id).toBe(sourceId)
      expect(status.sources[0].totals24h.crawlerHits).toBe(2)
      expect(status.sources[0].totals24h.aiReferralHits).toBe(1)
      expect(status.sources[0].latestRun.status).toBe(RunStatuses.completed)

      // Same shape as /traffic/sources/:id — entries should be byte-for-byte equivalent.
      const detailRes = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}`,
      })
      expect(JSON.parse(detailRes.payload)).toEqual(status.sources[0])
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

      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/test-project/traffic/status' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload).sources.length).toBe(0)
    } finally { await h.close() }
  })

  it('404s for an unknown project', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/no-such/traffic/status' })
      expect(res.statusCode).toBe(404)
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
