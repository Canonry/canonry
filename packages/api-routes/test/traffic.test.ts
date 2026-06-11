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
  aiUserFetchEventsHourly,
  aiReferralEventsHourly,
  rawEventSamples,
  runs,
  auditLog,
  schedules,
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
import type {
  ListVercelTrafficEventsOptions,
  VercelTrafficEventsPage,
} from '@ainyc/canonry-integration-vercel'
import { VercelLogsApiError } from '@ainyc/canonry-integration-vercel'
import { apiRoutes } from '../src/index.js'
import type {
  CloudRunCredentialRecord,
  CloudRunCredentialStore,
  WordpressTrafficCredentialRecord,
  WordpressTrafficCredentialStore,
  VercelTrafficCredentialRecord,
  VercelTrafficCredentialStore,
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

function buildVercelEvent(overrides: Partial<NormalizedTrafficRequest> = {}): NormalizedTrafficRequest {
  return buildEvent({
    sourceType: 'vercel',
    eventId: `vercel:${overrides.observedAt ?? '2026-05-07T17:32:00.000Z'}:${Math.floor(Math.random() * 1_000_000)}`,
    // The Vercel request-logs endpoint does not expose a client IP.
    remoteIp: null,
    providerResource: { type: 'vercel_deployment', labels: {} },
    ...overrides,
  })
}

function vercelRetentionError(): VercelLogsApiError {
  return new VercelLogsApiError(
    'Vercel request-logs endpoint returned HTTP 400',
    400,
    '{"error":{"name":"ExceedsBillingLimitError","message":"Requested window exceeds plan retention"}}',
  )
}

// Vercel `connect` seeds `lastSyncedAt = NOW` (the first-sync trap fix).
// Tests that need a non-zero sync window must backdate the row before
// triggering the sync; otherwise the drain short-circuits on a zero-width
// window and never exercises the pull. Use this helper instead of inlining
// the update so future first-sync tests can find the pattern.
function backdateLastSyncedAt(
  db: ReturnType<typeof createClient>,
  sourceId: string,
  ageMs: number,
): string {
  const stale = new Date(Date.now() - ageMs).toISOString()
  db.update(trafficSources)
    .set({ lastSyncedAt: stale })
    .where(eq(trafficSources.id, sourceId))
    .run()
  return stale
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
    wpPullPages?: (call: {
      cursor: string | undefined
      pageSize: number
      since: string | undefined
      until: string | undefined
    }) => WordpressTrafficEventsPage
    /** Force the Vercel traffic pull (used for the connect probe) to throw a `VercelLogsApiError`. */
    failVercelProbeWith?: { status: number; message: string; body?: string }
    /** Force the Vercel traffic pull (used by sync / backfill) to throw an Error with this message. */
    failVercelPullWith?: string
    /**
     * Programmable Vercel sync / backfill pull. When provided, replaces the
     * default empty-page stub. The probe path (maxPages=1) is also routed
     * through it unless `failVercelProbeWith` is set. A test exercises the
     * hasMore-overflow path by returning `hasMore: true` from this callback.
     */
    vercelPullPages?: (call: {
      startDate: number
      endDate: number
      maxPages: number | undefined
      environment: string | undefined
    }) => VercelTrafficEventsPage
    /** Wall-clock budget (ms) for the Vercel sync drain. Tests set a tiny/zero value to exercise the deadline path. */
    vercelSyncDeadlineMs?: number
  } = {},
) {
  const trafficSyncedEvents: Array<unknown> = []
  const scheduleUpdates: Array<{ action: string; projectId: string; kind: string }> = []
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

  const vercelCredentials = new Map<string, VercelTrafficCredentialRecord>()
  const vercelTrafficCredentialStore: VercelTrafficCredentialStore = {
    getConnection: (projectName) => vercelCredentials.get(projectName),
    upsertConnection: (record) => {
      vercelCredentials.set(record.projectName, record)
      return record
    },
    deleteConnection: (projectName) => vercelCredentials.delete(projectName),
  }

  const vercelProbeInvocations: ListVercelTrafficEventsOptions[] = []

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
          since: pullOptions.since,
          until: pullOptions.until,
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
        hasMore: false,
        endpoint: `${pullOptions.baseUrl}/wp-json/canonry/v1/events`,
      }
    },
    vercelTrafficCredentialStore,
    pullVercelTrafficEvents: async (pullOptions): Promise<VercelTrafficEventsPage> => {
      vercelProbeInvocations.push(pullOptions)
      const toMs = (v: number | string | Date): number =>
        typeof v === 'number' ? v : new Date(v).getTime()
      // Probe path: connect-route + doctor validator call with maxPages=1 —
      // surface the probe-failure injection here so the connect-route test
      // works the same way the WordPress one does.
      if (pullOptions.maxPages === 1 && options.failVercelProbeWith) {
        throw new VercelLogsApiError(
          options.failVercelProbeWith.message,
          options.failVercelProbeWith.status,
          options.failVercelProbeWith.body,
        )
      }
      // `failVercelPullWith` simulates a sync/backfill-time failure. The
      // connect route uses maxPages=1 for its probe — gate the injection on
      // maxPages !== 1 so the harness can still connect successfully first.
      if (pullOptions.maxPages !== 1 && options.failVercelPullWith) {
        throw new Error(options.failVercelPullWith)
      }
      if (options.vercelPullPages) {
        const page = options.vercelPullPages({
          startDate: toMs(pullOptions.startDate),
          endDate: toMs(pullOptions.endDate),
          maxPages: pullOptions.maxPages,
          environment: pullOptions.environment,
        })
        return { ...page, endpoint: 'https://vercel.com/api/logs/request-logs' }
      }
      return {
        events: [],
        rawEntryCount: 0,
        skippedEntryCount: 0,
        hasMore: false,
        endpoint: 'https://vercel.com/api/logs/request-logs',
      }
    },
    vercelSyncDeadlineMs: options.vercelSyncDeadlineMs,
    onTrafficSynced: (event) => { trafficSyncedEvents.push(event) },
    onScheduleUpdated: (action, projectId, kind) => { scheduleUpdates.push({ action, projectId, kind }) },
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
    vercelCredentials,
    tmpDir,
    getPullCount: () => pullInvocations,
    getObservedWindows: () => observedWindows,
    getObservedFirstSync: () => observedFirstSync,
    getTrafficSyncedEvents: () => trafficSyncedEvents,
    getScheduleUpdates: () => scheduleUpdates,
    getWpProbeInvocations: () => wpProbeInvocations,
    getVercelProbeInvocations: () => vercelProbeInvocations,
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
    const config = sources[0].configJson
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

  it('rejects baseUrl that resolves to a private / metadata address (SSRF guard)', async () => {
    // The probe attaches Basic-auth credentials, so an API-key holder could
    // otherwise coerce the server into reaching its own metadata service or
    // sidecar admin endpoints. The SSRF helper rejects RFC1918, link-local
    // (including 169.254.169.254), and loopback by default.
    const blocked = [
      'http://169.254.169.254/wp-json/',        // AWS / GCP metadata
      'http://10.0.0.5/wp-json/',               // RFC1918
      'http://192.168.1.1/wp-json/',            // RFC1918
      'http://127.0.0.1/wp-json/',              // loopback
      'http://[::1]/wp-json/',                  // IPv6 loopback
    ]
    for (const baseUrl of blocked) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/wordpress',
        payload: { ...validBody, baseUrl },
      })
      expect(res.statusCode, `expected ${baseUrl} to be blocked`).toBe(400)
      const err = JSON.parse(res.payload)
      expect(err.error?.code).toBe('VALIDATION_ERROR')
      expect(err.error?.message).toMatch(/WordPress baseUrl rejected/i)
    }
    // The SSRF guard must run BEFORE pullWordpressEvents — no probe should have
    // happened for any of the blocked targets.
    expect(h.getWpProbeInvocations().length).toBe(0)
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
    const config = sources[0].configJson
    expect(config.username).toBe('new-bot')
  })
})

describe('POST /traffic/connect/vercel', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>
  beforeEach(async () => { h = await buildHarness([]) })
  afterEach(async () => { await h.close() })

  const validBody = {
    projectId: 'prj_abc',
    teamId: 'team_xyz',
    token: 'vcp_test_token',
  }

  it('rejects requests with an empty projectId', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: { ...validBody, projectId: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects requests with an empty token', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: { ...validBody, token: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects requests with an invalid environment', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: { ...validBody, environment: 'staging' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('probes request-logs, persists the token, and creates the source row', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: { ...validBody, environment: 'preview', displayName: 'Example Vercel' },
    })
    expect(res.statusCode).toBe(200)
    const dto = JSON.parse(res.payload)
    expect(dto.sourceType).toBe(TrafficSourceTypes.vercel)
    expect(dto.status).toBe(TrafficSourceStatuses.connected)
    expect(dto.displayName).toBe('Example Vercel')
    expect(dto.config.projectId).toBe('prj_abc')
    expect(dto.config.teamId).toBe('team_xyz')
    expect(dto.config.environment).toBe('preview')
    // The API token must never leak into the row config; it lives in
    // ~/.canonry/config.yaml only.
    expect(dto.config.token).toBeUndefined()

    // Probe ran once (maxPages=1) before any persistence.
    const probes = h.getVercelProbeInvocations()
    expect(probes.length).toBe(1)
    expect(probes[0]!.projectId).toBe('prj_abc')
    expect(probes[0]!.maxPages).toBe(1)

    const stored = h.vercelCredentials.get('test-project')
    expect(stored?.token).toBe('vcp_test_token')
    expect(stored?.environment).toBe('preview')

    const sourceRows = h.db.select().from(trafficSources).all()
    expect(sourceRows.length).toBe(1)
    expect(sourceRows[0].sourceType).toBe(TrafficSourceTypes.vercel)
  })

  it('seeds lastSyncedAt to NOW so the first sync uses a tight window', async () => {
    // Regression: before this fix, lastSyncedAt was null on connect. The first
    // sync then read DEFAULT_SYNC_WINDOW_MINUTES (30 days) — which exceeds
    // Vercel's request-logs retention (~14d) and made the very first sync
    // throw a retention error, leaving the source permanently stuck.
    const before = Date.now()
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: validBody,
    })
    expect(res.statusCode).toBe(200)
    const after = Date.now()

    const row = h.db.select().from(trafficSources).all()[0]!
    expect(row.lastSyncedAt).not.toBeNull()
    const seededMs = new Date(row.lastSyncedAt!).getTime()
    expect(seededMs).toBeGreaterThanOrEqual(before)
    expect(seededMs).toBeLessThanOrEqual(after)
  })

  it('defaults environment to production when omitted', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: validBody,
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).config.environment).toBe('production')
    expect(h.vercelCredentials.get('test-project')?.environment).toBe('production')
  })

  it('returns 502 and persists nothing when the probe fails with a bad token', async () => {
    await h.close()
    h = await buildHarness([], {
      failVercelProbeWith: { status: 403, message: 'Forbidden', body: 'bad token' },
    })

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: validBody,
    })
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.payload).error.message).toMatch(/HTTP 403/)
    // Probe ran but neither credential nor source row was written.
    expect(h.vercelCredentials.get('test-project')).toBeUndefined()
    expect(h.db.select().from(trafficSources).all().length).toBe(0)
  })

  it('reuses the existing source row on reconnect rather than creating a duplicate', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: validBody,
    })
    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: { ...validBody, projectId: 'prj_new', teamId: 'team_new' },
    })
    expect(second.statusCode).toBe(200)
    const sources = h.db.select().from(trafficSources).all()
    expect(sources.length).toBe(1)
    const config = sources[0].configJson
    expect(config.projectId).toBe('prj_new')
    expect(config.teamId).toBe('team_new')
    // Credential record updated in place too.
    expect(h.vercelCredentials.get('test-project')?.projectId).toBe('prj_new')
  })

  it('auto-creates a traffic-sync schedule bound to the new source', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: validBody,
    })
    expect(res.statusCode).toBe(200)
    const sourceId = JSON.parse(res.payload).id as string

    // Without this schedule the watermark never advances and the next sync
    // pulls an unbounded window — the trap this closes.
    const schedRows = h.db.select().from(schedules).where(eq(schedules.kind, 'traffic-sync')).all()
    expect(schedRows).toHaveLength(1)
    const sched = schedRows[0]!
    expect(sched.cronExpr).toBe('*/30 * * * *')
    expect(sched.sourceId).toBe(sourceId)
    expect(sched.enabled).toBe(true)
    expect(sched.timezone).toBe('UTC')
  })

  it('registers the new schedule with the live scheduler via onScheduleUpdated', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: validBody,
    })
    const trafficUpdate = h.getScheduleUpdates().find((u) => u.kind === 'traffic-sync')
    expect(trafficUpdate).toBeDefined()
    expect(trafficUpdate?.action).toBe('upsert')
  })

  it('does not create or re-register a second schedule on reconnect (idempotent)', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: validBody,
    })
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: { ...validBody, projectId: 'prj_reconnect' },
    })
    expect(h.db.select().from(schedules).where(eq(schedules.kind, 'traffic-sync')).all()).toHaveLength(1)
    // onScheduleUpdated fires only on the first (creating) connect.
    expect(h.getScheduleUpdates().filter((u) => u.kind === 'traffic-sync')).toHaveLength(1)
  })
})

describe('POST /traffic/sources/:id/sync — Vercel', () => {
  const vercelConnectBody = {
    projectId: 'prj_abc',
    teamId: 'team_xyz',
    token: 'vcp_test_token',
  }

  async function connectVercel(h: Awaited<ReturnType<typeof buildHarness>>): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: vercelConnectBody,
    })
    if (res.statusCode !== 200) throw new Error(`connect failed: ${res.statusCode} ${res.payload}`)
    return JSON.parse(res.payload).id
  }

  it('returns validationError pointing to `canonry traffic connect vercel` when no Vercel credential is stored', async () => {
    // Seed a Vercel traffic source row WITHOUT going through the connect
    // route, so the credential store stays empty. Sync must surface a helpful
    // 400 that points to the connect CLI rather than a 500.
    const h = await buildHarness([])
    try {
      const { projects } = await import('@ainyc/canonry-db')
      const projectRow = h.db.select().from(projects).all()[0]
      const now = new Date().toISOString()
      h.db.insert(trafficSources).values({
        id: 'src_vercel_orphan',
        projectId: projectRow.id,
        sourceType: TrafficSourceTypes.vercel,
        displayName: 'orphan vercel',
        status: TrafficSourceStatuses.connected,
        configJson: { projectId: 'prj_abc', teamId: 'team_xyz', environment: 'production' },
        createdAt: now,
        updatedAt: now,
      }).run()

      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/sources/src_vercel_orphan/sync',
        payload: {},
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toMatch(/canonry traffic connect vercel/)
      // The run row must not linger as 'running'.
      expect(h.db.select().from(runs).all().length).toBe(0)
    } finally {
      await h.close()
    }
  })

  it('drains the window, lands rollups, advances lastSyncedAt to windowEnd, and finalizes the run as completed', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildVercelEvent({ eventId: 'vercel:s:1', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildVercelEvent({ eventId: 'vercel:s:2', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(20) }),
      buildVercelEvent({
        eventId: 'vercel:s:3',
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(35),
      }),
    ]

    const observedMaxPages: Array<number | undefined> = []
    const h = await buildHarness([], {
      vercelPullPages: ({ maxPages }) => {
        observedMaxPages.push(maxPages)
        // Probe call (maxPages=1) returns nothing; the real sync pull walks
        // the whole window in one drained page (hasMore=false).
        if (maxPages === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        }
        return { events, rawEntryCount: 3, skippedEntryCount: 0, hasMore: false, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      // Connect seeds lastSyncedAt = NOW; widen the sync window past the
      // test events (which sit ~25-59 min in the past) so they're inside it.
      backdateLastSyncedAt(h.db, sourceId, 90 * 60_000)

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

      // The sync pull used the generous default page budget — not the
      // probe's maxPages=1.
      expect(observedMaxPages).toContain(50)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      // Time-window adapter — no opaque cursor is persisted.
      expect(sourceRow.lastCursor).toBeNull()
      expect(sourceRow.lastSyncedAt).toBeTruthy()
      expect(new Date(sourceRow.lastSyncedAt!).getTime()).toBeGreaterThan(0)
      expect(sourceRow.lastError).toBeNull()
      expect(sourceRow.status).toBe(TrafficSourceStatuses.connected)

      const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
      expect(crawlerRows.length).toBe(1)
      expect(crawlerRows[0].hits).toBe(2)
      expect(crawlerRows[0].botId).toBe('openai-gptbot')

      const aiRows = h.db.select().from(aiReferralEventsHourly).all()
      expect(aiRows.length).toBe(1)
      expect(aiRows[0].evidenceType).toBe('utm')
      expect(aiRows[0].sessionsOrHits).toBe(1)

      expect(h.db.select().from(rawEventSamples).all().length).toBe(3)

      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].kind).toBe(RunKinds['traffic-sync'])
      expect(runRows[0].status).toBe(RunStatuses.completed)
      expect(runRows[0].sourceId).toBe(sourceId)
    } finally {
      await h.close()
    }
  })

  it('drains a window that overflows the per-sub-window page budget via sub-windows', async () => {
    // The first (full-window) pull reports hasMore=true; the drain halves the
    // span and the narrower slices drain cleanly, so the sync succeeds
    // instead of failing wholesale.
    const observedAt = new Date(Date.now() - 2 * 86_400_000).toISOString()
    let pullCount = 0
    const h = await buildHarness([], {
      vercelPullPages: ({ maxPages }) => {
        if (maxPages === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        }
        pullCount += 1
        if (pullCount === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: true, endpoint: '' }
        }
        return {
          events: [buildVercelEvent({ eventId: `vercel:sub:${pullCount}`, userAgent: 'GPTBot/1.0', path: '/x', observedAt })],
          rawEntryCount: 1,
          skippedEntryCount: 0,
          hasMore: false,
          endpoint: '',
        }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      // Connect seeds lastSyncedAt = NOW; widen past the 2-day-old test
      // events so the drain has a window worth subdividing.
      backdateLastSyncedAt(h.db, sourceId, 3 * 86_400_000)

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(200)
      // The drain made more than one sub-window pull to cover the window.
      expect(pullCount).toBeGreaterThan(1)

      // The cursor advanced and the sub-window events rolled up.
      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.lastSyncedAt).not.toBeNull()
      expect(sourceRow.status).toBe(TrafficSourceStatuses.connected)
      expect(h.db.select().from(crawlerEventsHourly).all().length).toBeGreaterThan(0)

      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].status).toBe(RunStatuses.completed)
    } finally {
      await h.close()
    }
  })

  it('samples-and-advances instead of wedging when a one-second slice is irreducibly dense', async () => {
    // Regression: a single second holding more log pages than even the floor
    // budget used to throw, failing the sync so lastSyncedAt never advanced and
    // the source re-failed forever on that second. The incremental sync is
    // additive, so it now ingests the sample, advances past the slice, and
    // stays healthy.
    const observedAt = new Date(Date.now() - 1_000).toISOString()
    const h = await buildHarness([], {
      vercelPullPages: ({ maxPages, startDate }) => {
        if (maxPages === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        }
        // hasMore stays true at every span and page budget — the slice cannot be
        // drained and time cannot be sliced below the one-second floor.
        return {
          events: [buildVercelEvent({ eventId: `vercel:dense:${startDate}`, userAgent: 'GPTBot/1.0', path: '/x', observedAt })],
          rawEntryCount: 1,
          skippedEntryCount: 0,
          hasMore: true,
          endpoint: '',
        }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      // A tight ~3s window so the second-by-second advance stays well under the
      // sub-window cap (a wide window would hit maxSubWindows — a different path).
      const stale = backdateLastSyncedAt(h.db, sourceId, 3_000)

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(200)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      // The source advanced past the dense second instead of wedging.
      expect(sourceRow.status).toBe(TrafficSourceStatuses.connected)
      expect(sourceRow.lastError).toBeNull()
      expect(new Date(sourceRow.lastSyncedAt!).getTime()).toBeGreaterThan(new Date(stale).getTime())

      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].status).toBe(RunStatuses.completed)
    } finally {
      await h.close()
    }
  })

  it('returns 502 and marks the run failed when the Vercel pull throws', async () => {
    const h = await buildHarness([], { failVercelPullWith: 'request-logs 500: gateway' })
    try {
      const sourceId = await connectVercel(h)
      const stale = backdateLastSyncedAt(h.db, sourceId, 60 * 60_000)

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(502)
      expect(JSON.parse(syncRes.payload).error.message).toMatch(/Vercel pull failed/)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
      // The failed sync must not advance lastSyncedAt past the value we set.
      expect(sourceRow.lastSyncedAt).toBe(stale)

      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].status).toBe(RunStatuses.failed)
    } finally {
      await h.close()
    }
  })

  it('fails without advancing lastSyncedAt when Vercel retention cannot cover the requested sync window', async () => {
    let enforceRetention = false
    const retentionBoundaryMs = Date.now() - 10 * 60_000
    const h = await buildHarness([], {
      vercelPullPages: ({ startDate }) => {
        if (enforceRetention && startDate < retentionBoundaryMs) {
          throw vercelRetentionError()
        }
        return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      // Backdate past the harness's retention boundary so the sync window
      // crosses retention and the drain hits the retention-clamp throw.
      const stale = backdateLastSyncedAt(h.db, sourceId, 48 * 60 * 60_000)
      enforceRetention = true

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(502)
      expect(JSON.parse(syncRes.payload).error.message).toMatch(/refusing to advance/)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
      // The failed sync must not advance lastSyncedAt past the value we set.
      expect(sourceRow.lastSyncedAt).toBe(stale)
      expect(h.db.select().from(crawlerEventsHourly).all()).toEqual([])

      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].status).toBe(RunStatuses.failed)
    } finally {
      await h.close()
    }
  })

  it('fails the run (not eternal running) when the drain budget elapses before any sub-window completes', async () => {
    // Regression for the production wedge: a dense/slow window made the
    // synchronous drain run for many minutes, timing out the caller and leaving
    // the run stuck 'running'. A zero budget trips the deadline before the first
    // pull, so the drain makes no progress — the route must fail the run rather
    // than complete an empty window or orphan a 'running' row.
    const h = await buildHarness([], {
      vercelSyncDeadlineMs: 0,
      vercelPullPages: ({ maxPages }) => {
        if (maxPages === 1) return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        // Never reached — the deadline trips before the first sub-window pull.
        return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: true, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      const stale = backdateLastSyncedAt(h.db, sourceId, 60 * 60_000)

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(502)
      expect(JSON.parse(syncRes.payload).error.message).toMatch(/drain budget without completing any sub-window/)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
      // Zero progress → the watermark must not advance.
      expect(sourceRow.lastSyncedAt).toBe(stale)

      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].status).toBe(RunStatuses.failed)
    } finally {
      await h.close()
    }
  })

  it('caps a drifted sync window to the last 24h instead of pulling from the stale watermark', async () => {
    // A watermark that drifted days back (schedule paused/missing) must not make
    // the drain request a multi-day window. The start is clamped forward to the
    // cap; the skipped span is surfaced and the watermark still advances to ~now.
    const observedStarts: number[] = []
    const h = await buildHarness([], {
      vercelPullPages: ({ startDate, maxPages }) => {
        if (maxPages !== 1) observedStarts.push(startDate)
        return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      backdateLastSyncedAt(h.db, sourceId, 5 * 86_400_000) // 5 days
      const beforeMs = Date.now()

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(200)

      // No real pull reached back past the 24h cap (with a minute of slack).
      expect(observedStarts.length).toBeGreaterThan(0)
      const earliestStart = Math.min(...observedStarts)
      expect(earliestStart).toBeGreaterThanOrEqual(beforeMs - 24 * 60 * 60_000 - 60_000)

      // The capped window drained and committed, advancing past the drift.
      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(new Date(sourceRow.lastSyncedAt!).getTime()).toBeGreaterThanOrEqual(beforeMs)
      expect(sourceRow.status).toBe(TrafficSourceStatuses.connected)
      expect(sourceRow.lastError).toBeNull()
    } finally {
      await h.close()
    }
  })
})

describe('POST /traffic/sources/:id/backfill — Vercel', () => {
  const vercelConnectBody = {
    projectId: 'prj_abc',
    teamId: 'team_xyz',
    token: 'vcp_test_token',
  }

  async function connectVercel(h: Awaited<ReturnType<typeof buildHarness>>): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: vercelConnectBody,
    })
    if (res.statusCode !== 200) throw new Error(`connect failed: ${res.statusCode} ${res.payload}`)
    return JSON.parse(res.payload).id
  }

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

  it('returns runId + status=running synchronously, then pulls the window and replaces rollups', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildVercelEvent({ eventId: 'vercel:bf:1', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildVercelEvent({ eventId: 'vercel:bf:2', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(20) }),
      buildVercelEvent({
        eventId: 'vercel:bf:3',
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(35),
      }),
    ]

    const observedWindows: Array<{ startDate: number; endDate: number; maxPages: number | undefined }> = []
    const h = await buildHarness([], {
      vercelPullPages: ({ startDate, endDate, maxPages }) => {
        observedWindows.push({ startDate, endDate, maxPages })
        if (maxPages === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        }
        const eventsInWindow = events.filter((event) => {
          const observedMs = new Date(event.observedAt).getTime()
          return observedMs >= startDate && observedMs < endDate
        })
        return {
          events: eventsInWindow,
          rawEntryCount: eventsInWindow.length,
          skippedEntryCount: 0,
          hasMore: false,
          endpoint: '',
        }
      },
    })
    try {
      const sourceId = await connectVercel(h)

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)
      expect(submitted.status).toBe(RunStatuses.running)
      expect(submitted.runId).toBeDefined()
      expect(submitted.daysApplied).toBe(7)

      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.completed)
      expect(finalRun.trigger).toBe('backfill')
      expect(finalRun.kind).toBe(RunKinds['traffic-sync'])

      // The backfill drains the requested window in contiguous hour chunks,
      // each with the larger one-shot backfill page budget.
      const backfillCalls = observedWindows.filter((c) => c.maxPages !== 1)
      expect(backfillCalls.length).toBeGreaterThan(1)
      expect(backfillCalls.every((c) => c.maxPages === 1000)).toBe(true)
      expect(backfillCalls[0]!.startDate).toBe(new Date(submitted.windowStart).getTime())
      expect(backfillCalls.at(-1)!.endDate).toBe(new Date(submitted.windowEnd).getTime())
      for (let i = 1; i < backfillCalls.length; i += 1) {
        expect(backfillCalls[i]!.startDate).toBe(backfillCalls[i - 1]!.endDate)
      }

      const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
      expect(crawlerRows.length).toBe(1)
      expect(crawlerRows[0].hits).toBe(2)

      const aiRows = h.db.select().from(aiReferralEventsHourly).all()
      expect(aiRows.length).toBe(1)
      expect(aiRows[0].sessionsOrHits).toBe(1)
      expect(aiRows[0].evidenceType).toBe('utm')

      expect(h.db.select().from(rawEventSamples).all().length).toBe(3)
    } finally {
      await h.close()
    }
  })

  it('drains a backfill window that overflows the per-sub-window budget via sub-windows', async () => {
    // The first (full-window) pull reports hasMore=true; the drain halves the
    // span so the backfill completes instead of failing wholesale.
    const observedAt = new Date(Date.now() - 2 * 86_400_000).toISOString()
    let pullCount = 0
    const h = await buildHarness([], {
      vercelPullPages: ({ maxPages }) => {
        if (maxPages === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        }
        pullCount += 1
        if (pullCount === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: true, endpoint: '' }
        }
        return {
          events: [buildVercelEvent({ eventId: `vercel:bf:${pullCount}`, userAgent: 'GPTBot/1.0', path: '/x', observedAt })],
          rawEntryCount: 1,
          skippedEntryCount: 0,
          hasMore: false,
          endpoint: '',
        }
      },
    })
    try {
      const sourceId = await connectVercel(h)

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)

      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.completed)
      expect(pullCount).toBeGreaterThan(1)
      expect(h.db.select().from(crawlerEventsHourly).all().length).toBeGreaterThan(0)
    } finally {
      await h.close()
    }
  })

  it('deduplicates Vercel backfill events repeated across hour chunk boundaries', async () => {
    const shared = buildVercelEvent({
      eventId: 'vercel:bf:shared-boundary',
      userAgent: 'GPTBot/1.0',
      path: '/chunk-boundary',
      observedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    })
    const h = await buildHarness([], {
      vercelPullPages: ({ maxPages }) => {
        if (maxPages === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        }
        return { events: [shared], rawEntryCount: 1, skippedEntryCount: 0, hasMore: false, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectVercel(h)

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 1 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)

      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.completed)

      const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
      expect(crawlerRows.length).toBe(1)
      expect(crawlerRows[0].hits).toBe(1)
      expect(h.db.select().from(rawEventSamples).all().length).toBe(1)
    } finally {
      await h.close()
    }
  })

  it('fails the backfill without replacing rollups when Vercel retention cannot cover the requested window', async () => {
    let enforceRetention = false
    const retentionBoundaryMs = Date.now() - 10 * 60_000
    const h = await buildHarness([], {
      vercelPullPages: ({ startDate }) => {
        if (enforceRetention && startDate < retentionBoundaryMs) {
          throw vercelRetentionError()
        }
        return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      enforceRetention = true

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)

      // Capture the connect-time lastSyncedAt before the failed backfill so
      // we can assert it stays put.
      const connectSyncedAt = h.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, sourceId))
        .get()!
        .lastSyncedAt

      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.failed)
      expect(finalRun.error).toMatch(/refusing to advance/)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
      // The failed backfill must not advance lastSyncedAt past the connect-time value.
      expect(sourceRow.lastSyncedAt).toBe(connectSyncedAt)
      expect(h.db.select().from(crawlerEventsHourly).all()).toEqual([])
      expect(h.db.select().from(rawEventSamples).all()).toEqual([])
    } finally {
      await h.close()
    }
  })

  it('fails fast (loud, no rollup replace) on an irreducibly dense one-second slice', async () => {
    // Backfill is replace mode: a truncated sample must never overwrite a full
    // window's rollup. The drain runs with abortOnTruncation, so it throws on
    // the FIRST irreducible second — it does not sample-and-advance through the
    // rest of a 7-day window it will reject anyway (a few bisecting pulls, not
    // thousands).
    let pullCount = 0
    const h = await buildHarness([], {
      vercelPullPages: ({ maxPages }) => {
        if (maxPages === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        }
        pullCount += 1
        return {
          events: [buildVercelEvent({ eventId: `vercel:bf:dense:${pullCount}`, userAgent: 'GPTBot/1.0', path: '/x' })],
          rawEntryCount: 1,
          skippedEntryCount: 0,
          hasMore: true,
          endpoint: '',
        }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      const connectSyncedAt = h.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, sourceId))
        .get()!
        .lastSyncedAt

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)

      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.failed)
      expect(finalRun.error).toMatch(/holds more than 1000 pages and cannot be drained further/)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
      // No rollup was replaced and the cursor never advanced.
      expect(sourceRow.lastSyncedAt).toBe(connectSyncedAt)
      expect(h.db.select().from(crawlerEventsHourly).all()).toEqual([])
      expect(h.db.select().from(rawEventSamples).all()).toEqual([])
      // Fail-fast: bisecting one hour chunk down to the floor is a handful of
      // pulls — nowhere near the thousands a full sample-and-advance would make.
      expect(pullCount).toBeLessThan(50)
    } finally {
      await h.close()
    }
  })

  it('returns validationError pointing to `canonry traffic connect vercel` when no Vercel credential is stored', async () => {
    const h = await buildHarness([])
    try {
      const { projects } = await import('@ainyc/canonry-db')
      const projectRow = h.db.select().from(projects).all()[0]
      const now = new Date().toISOString()
      h.db.insert(trafficSources).values({
        id: 'src_vercel_bf_orphan',
        projectId: projectRow.id,
        sourceType: TrafficSourceTypes.vercel,
        displayName: 'orphan vercel',
        status: TrafficSourceStatuses.connected,
        configJson: { projectId: 'prj_abc', teamId: 'team_xyz', environment: 'production' },
        createdAt: now,
        updatedAt: now,
      }).run()

      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/sources/src_vercel_bf_orphan/backfill',
        payload: { days: 7 },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toMatch(/canonry traffic connect vercel/)
    } finally {
      await h.close()
    }
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
        configJson: { gcpProjectId: 'orphan-project', authMode: 'service-account' },
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
      expect(body.selfTrafficExcluded).toBe(0)
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

  it('drops Canonry self-traffic before rollup and surfaces the count in the sync response', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      // Canonry's own AEO auditor crawling the client's sitemap — must not count.
      buildEvent({ userAgent: 'AINYC-AEO-Audit/1.0', path: '/sitemap.xml', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'AINYC-AEO-Audit/1.0', path: '/llms.txt', status: 200, observedAt: fromBase(2) }),
      // A real crawler + a real human visitor — these count.
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(10) }),
      buildEvent({ userAgent: 'Mozilla/5.0', path: '/', status: 200, observedAt: fromBase(15) }),
    ]

    const h = await buildHarness(events)
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', serviceName: 'openclaw-nyc', location: 'us-east1', keyJson: SA_KEY },
      })
      expect(connectRes.statusCode).toBe(200)
      const sourceId = JSON.parse(connectRes.payload).id

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 120 },
      })
      expect(syncRes.statusCode).toBe(200)
      const body = JSON.parse(syncRes.payload)
      // Two self-audit hits dropped; pulledEvents counts only the real crawler +
      // human, and the drop is surfaced (never silent).
      expect(body.selfTrafficExcluded).toBe(2)
      expect(body.pulledEvents).toBe(2)
      expect(body.crawlerHits).toBe(1)
      expect(body.unknownHits).toBe(1)

      // No self-audit UA leaked into the persisted sample tail.
      const samples = h.db.select().from(rawEventSamples).all()
      expect(samples.length).toBe(2)
      expect(samples.some((s) => s.userAgent === 'AINYC-AEO-Audit/1.0')).toBe(false)

      // Only the real crawler made it into the hourly bucket.
      const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
      expect(crawlerRows.length).toBe(1)
      expect(crawlerRows[0].botId).toBe('openai-gptbot')
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
      expect(afterFirst[0].lastEventIds ?? []).toContain('cloud-run:dup-1')

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
      const persisted: string[] = rows[0].lastEventIds ?? []
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
        configJson: { baseUrl: 'https://example.com', username: 'bot' },
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
          return { events: page1Events, rawEntryCount: 2, skippedEntryCount: 0, nextCursor: 'PAGE2', hasMore: true, endpoint: '' }
        }
        if (cursor === 'PAGE2') {
          return { events: page2Events, rawEntryCount: 1, skippedEntryCount: 0, nextCursor: 'PAGE_DONE', hasMore: false, endpoint: '' }
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
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, nextCursor: undefined, hasMore: false, endpoint: '' }
        }
        if (invocation === 2) {
          // First sync: returns one event and a cursor for next time.
          return {
            events: [buildWpEvent({ eventId: 'wordpress:r:1', path: '/r1', observedAt: new Date(baseTime.getTime() + 5 * 60_000).toISOString() })],
            rawEntryCount: 1,
            skippedEntryCount: 0,
            nextCursor: 'RESUME_HERE',
            hasMore: false,
            endpoint: '',
          }
        }
        // Second sync: cursor must equal what we returned, and we yield one new event.
        return {
          events: [buildWpEvent({ eventId: 'wordpress:r:2', path: '/r2', observedAt: new Date(baseTime.getTime() + 10 * 60_000).toISOString() })],
          rawEntryCount: 1,
          skippedEntryCount: 0,
          nextCursor: 'AFTER_RESUME',
          hasMore: false,
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
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, nextCursor: undefined, hasMore: false, endpoint: '' }
        }
        if (pullCall === 2) {
          // First sync: just the dup, single page, has_more=false.
          return { events: [dupEvent], rawEntryCount: 1, skippedEntryCount: 0, nextCursor: 'CURSOR_AFTER_FIRST', hasMore: false, endpoint: '' }
        }
        // Second sync: plugin re-emits dup AND emits the fresh event.
        return {
          events: [dupEvent, freshEvent],
          rawEntryCount: 2,
          skippedEntryCount: 0,
          nextCursor: 'CURSOR_AFTER_SECOND',
          hasMore: false,
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
      expect(submitted.daysApplied).toBe(90)
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

describe('POST /traffic/sources/:id/backfill — WordPress', () => {
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

  it('returns runId + status=running synchronously, then pages WP events in [windowStart, windowEnd) and replaces rollups', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    // Two pages of historical WP events, cursor-paginated by the plugin's
    // window endpoint. Page 1 returns next_cursor=BPAGE2 (has_more=true),
    // page 2 returns the final cursor with has_more=false. Backfill must
    // follow the cursor to exhaustion inside the requested [since, until)
    // window — the per-call `since`/`until` should be identical across
    // both invocations.
    const page1Events: NormalizedTrafficRequest[] = [
      buildWpEvent({ eventId: 'wp-bf:p1:1', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildWpEvent({ eventId: 'wp-bf:p1:2', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(20) }),
    ]
    const page2Events: NormalizedTrafficRequest[] = [
      buildWpEvent({
        eventId: 'wp-bf:p2:3',
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(35),
      }),
    ]

    const observedWindows: Array<{ since: string | undefined; until: string | undefined; pageSize: number }> = []
    const h = await buildHarness([], {
      wpPullPages: ({ cursor, since, until, pageSize }) => {
        observedWindows.push({ since, until, pageSize })
        if (cursor === undefined || cursor === '') {
          return { events: page1Events, rawEntryCount: 2, skippedEntryCount: 0, nextCursor: 'BPAGE2', hasMore: true, endpoint: '' }
        }
        if (cursor === 'BPAGE2') {
          return { events: page2Events, rawEntryCount: 1, skippedEntryCount: 0, nextCursor: 'BPAGE_DONE', hasMore: false, endpoint: '' }
        }
        throw new Error(`Unexpected cursor: ${cursor}`)
      },
    })
    try {
      const sourceId = await connectWp(h)

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)
      expect(submitted.status).toBe(RunStatuses.running)
      expect(submitted.runId).toBeDefined()
      expect(submitted.daysApplied).toBe(7)
      expect(submitted.daysRequested).toBe(7)
      // windowStart and windowEnd are ISO timestamps roughly 7 days apart.
      // windowStart is hour-floored upstream so the lower bound can sit up
      // to 59m59s earlier than (windowEnd - 7d); the span is therefore in
      // [7d, 7d + 1h].
      const span = new Date(submitted.windowEnd).getTime() - new Date(submitted.windowStart).getTime()
      const sevenDays = 7 * 86_400_000
      expect(span).toBeGreaterThanOrEqual(sevenDays)
      expect(span).toBeLessThanOrEqual(sevenDays + 60 * 60_000)

      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.completed)
      expect(finalRun.trigger).toBe('backfill')
      expect(finalRun.kind).toBe(RunKinds['traffic-sync'])

      // The backfill must page through cursors WITHOUT changing since/until
      // between requests — every call sees the same window so the plugin
      // returns events from that window only. Filter out the connect-time
      // probe (pageSize=1, no window) so the assertions only see backfill
      // pulls.
      const backfillCalls = observedWindows.filter((c) => c.pageSize !== 1)
      expect(backfillCalls.length).toBeGreaterThanOrEqual(2)
      for (const call of backfillCalls) {
        expect(call.since).toBe(submitted.windowStart)
        expect(call.until).toBe(submitted.windowEnd)
      }

      // Crawler + AI-referral rollups land the same way as Cloud Run backfill.
      const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
      expect(crawlerRows.length).toBe(1)
      expect(crawlerRows[0].hits).toBe(2)

      const aiRows = h.db.select().from(aiReferralEventsHourly).all()
      expect(aiRows.length).toBe(1)
      expect(aiRows[0].sessionsOrHits).toBe(1)
      expect(aiRows[0].evidenceType).toBe('utm')

      const samples = h.db.select().from(rawEventSamples).all()
      expect(samples.length).toBe(3)
    } finally {
      await h.close()
    }
  })

  it('does not roll lastSyncedAt backwards when the existing cursor is ahead of windowEnd', async () => {
    // Seed lastSyncedAt to a future timestamp (incremental sync already
    // ran ahead of the backfill window). Backfill replaces the rollup in
    // [windowStart, windowEnd) but must NOT clobber the forward cursor —
    // otherwise the next incremental sync would re-pull a gap.
    const h = await buildHarness([], {
      wpPullPages: ({ cursor }) => {
        if (cursor === undefined || cursor === '') {
          return {
            events: [
              buildWpEvent({
                eventId: 'wp-bf-future:1',
                userAgent: 'GPTBot/1.0',
                path: '/blog/foo',
                status: 200,
                observedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
              }),
            ],
            rawEntryCount: 1,
            skippedEntryCount: 0,
            nextCursor: 'AFTER_BACKFILL',
            hasMore: false,
            endpoint: '',
          }
        }
        throw new Error(`Unexpected cursor: ${cursor}`)
      },
    })
    try {
      const sourceId = await connectWp(h)

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

  it('caps days at MAX_BACKFILL_DAYS (30) when a larger value is requested', async () => {
    const h = await buildHarness([])
    try {
      const sourceId = await connectWp(h)

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 365 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)
      expect(submitted.daysRequested).toBe(365)
      expect(submitted.daysApplied).toBe(90)
    } finally {
      await h.close()
    }
  })

  it('returns validationError pointing to `canonry traffic connect wordpress` when no WP credential is stored', async () => {
    const h = await buildHarness([])
    try {
      const { projects } = await import('@ainyc/canonry-db')
      const projectRow = h.db.select().from(projects).all()[0]
      const now = new Date().toISOString()
      // Seed a connected WP source row without a credential record.
      h.db.insert(trafficSources).values({
        id: 'src_wp_bf_orphan',
        projectId: projectRow.id,
        sourceType: TrafficSourceTypes.wordpress,
        displayName: 'orphan wp',
        status: TrafficSourceStatuses.connected,
        configJson: { baseUrl: 'https://example.com', username: 'bot' },
        createdAt: now,
        updatedAt: now,
      }).run()

      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/sources/src_wp_bf_orphan/backfill',
        payload: { days: 7 },
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.payload)
      expect(body.error.message).toMatch(/canonry traffic connect wordpress/)
    } finally {
      await h.close()
    }
  })

  it('isolates rollups by sourceId — a WP backfill does not delete a parallel Cloud Run source\'s buckets', async () => {
    // Cross-source isolation: backfilling source A must not touch source B's
    // rollups. The replace-window delete is keyed by sourceId; if anyone ever
    // accidentally drops the sourceId predicate, this test trips.
    const h = await buildHarness([], {
      wpPullPages: () => ({
        events: [
          buildWpEvent({
            eventId: 'wp-bf-iso:1',
            userAgent: 'GPTBot/1.0',
            path: '/wp-only',
            status: 200,
            observedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
          }),
        ],
        rawEntryCount: 1,
        skippedEntryCount: 0,
        nextCursor: 'ISO_DONE',
        hasMore: false,
        endpoint: '',
      }),
    })
    try {
      const wpSourceId = await connectWp(h)
      // Connect a Cloud Run source in the SAME project — different sourceId.
      const crConnectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const crSourceId = JSON.parse(crConnectRes.payload).id

      // Seed a crawler bucket on the Cloud Run source inside what will be
      // the WP backfill window.
      const { projects } = await import('@ainyc/canonry-db')
      const projectRow = h.db.select().from(projects).all()[0]
      const sentinelHour = new Date(Date.now() - 30 * 60_000)
      sentinelHour.setUTCMinutes(0, 0, 0)
      const sentinelHourIso = sentinelHour.toISOString()
      const seedTime = new Date().toISOString()
      h.db.insert(crawlerEventsHourly).values({
        projectId: projectRow.id,
        sourceId: crSourceId,
        tsHour: sentinelHourIso,
        botId: 'openai-gptbot',
        operator: 'OpenAI',
        verificationStatus: 'claimed_unverified',
        pathNormalized: '/cloud-run-only',
        status: 200,
        hits: 42,
        sampledUserAgent: 'GPTBot/1.0',
        createdAt: seedTime,
        updatedAt: seedTime,
      }).run()

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${wpSourceId}/backfill`,
        payload: { days: 1 },
      })
      const submitted = JSON.parse(submitRes.payload)
      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.completed)

      // The Cloud Run bucket must still exist exactly as seeded.
      const crBuckets = h.db
        .select()
        .from(crawlerEventsHourly)
        .where(eq(crawlerEventsHourly.sourceId, crSourceId))
        .all()
      expect(crBuckets.length).toBe(1)
      expect(crBuckets[0].hits).toBe(42)
      expect(crBuckets[0].pathNormalized).toBe('/cloud-run-only')

      // And the WP source got its own bucket from the backfill pull.
      const wpBuckets = h.db
        .select()
        .from(crawlerEventsHourly)
        .where(eq(crawlerEventsHourly.sourceId, wpSourceId))
        .all()
      expect(wpBuckets.length).toBe(1)
      expect(wpBuckets[0].pathNormalized).toBe('/wp-only')
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
        configJson: {},
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
      expect(body.totals24h).toEqual({ crawlerHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, sampleCount: 0 })
    } finally { await h.close() }
  })

  it('counts ChatGPT-User hits as aiUserFetchHits (not crawlerHits) in totals24h', async () => {
    // The defining ai-user-fetch behavior at the read path: ChatGPT-User
    // arrives via UA evidence (same channel as GPTBot) but the operator
    // wants to see it as a human-in-the-loop fetch, not bulk crawl. The
    // detail endpoint MUST surface these in their own bucket so the
    // dashboard's "AI hits" tile is meaningful.
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'Mozilla/5.0 ChatGPT-User/1.0', path: '/', status: 200, observedAt: fromBase(5) }),
      buildEvent({ userAgent: 'Mozilla/5.0 ChatGPT-User/1.0', path: '/pricing', status: 200, observedAt: fromBase(10) }),
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
        payload: { sinceMinutes: 120 },
      })
      const syncBody = JSON.parse(syncRes.payload)
      expect(syncBody.crawlerHits).toBe(1)
      expect(syncBody.aiUserFetchHits).toBe(2)
      expect(syncBody.crawlerBucketRows).toBe(1)
      expect(syncBody.aiUserFetchBucketRows).toBe(2)

      // The new table holds the ChatGPT-User rows; the crawler table only
      // sees the GPTBot row.
      expect(h.db.select().from(crawlerEventsHourly).all().length).toBe(1)
      const userFetchRows = h.db.select().from(aiUserFetchEventsHourly).all()
      expect(userFetchRows.length).toBe(2)
      expect(userFetchRows.every(r => r.botId === 'openai-chatgpt-user')).toBe(true)

      const detail = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}`,
      })
      const body = JSON.parse(detail.payload)
      expect(body.totals24h.crawlerHits).toBe(1)
      expect(body.totals24h.aiUserFetchHits).toBe(2)
      expect(body.totals24h.aiReferralHits).toBe(0)
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
        configJson: {},
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
        configJson: {},
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
      expect(body.totals.aiUserFetchHits).toBe(0)
      expect(body.totals.aiReferralHits).toBe(1)
      expect(body.events.length).toBe(2)
      const kinds = body.events.map((e: { kind: string }) => e.kind).sort()
      expect(kinds).toEqual(['ai-referral', 'crawler'])
    } finally { await h.close() }
  })

  it('serializes ai-user-fetch entries alongside crawler + ai-referral', async () => {
    // End-to-end at the read path: when ChatGPT-User events were persisted
    // into ai_user_fetch_events_hourly, GET /traffic/events MUST return them
    // as kind=ai-user-fetch with the same crawler-shaped fields (botId,
    // operator, verificationStatus, pathNormalized, status, hits). This is
    // what an agent calling `canonry traffic events --format json` reads.
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'Mozilla/5.0 ChatGPT-User/1.0', path: '/', status: 200, observedAt: fromBase(5) }),
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
        url: '/api/v1/projects/test-project/traffic/events',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totals).toMatchObject({ crawlerHits: 1, aiUserFetchHits: 1, aiReferralHits: 1 })
      const kinds = body.events.map((e: { kind: string }) => e.kind).sort()
      expect(kinds).toEqual(['ai-referral', 'ai-user-fetch', 'crawler'])
      const userFetch = body.events.find((e: { kind: string }) => e.kind === 'ai-user-fetch')
      expect(userFetch).toMatchObject({
        kind: 'ai-user-fetch',
        botId: 'openai-chatgpt-user',
        operator: 'OpenAI',
        pathNormalized: '/',
        hits: 1,
      })
    } finally { await h.close() }
  })

  it('filters by kind=ai-user-fetch', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'Mozilla/5.0 ChatGPT-User/1.0', path: '/', status: 200, observedAt: fromBase(5) }),
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
        url: '/api/v1/projects/test-project/traffic/events?kind=ai-user-fetch',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totals.crawlerHits).toBe(0)
      expect(body.totals.aiUserFetchHits).toBe(1)
      expect(body.totals.aiReferralHits).toBe(0)
      expect(body.events.length).toBe(1)
      expect(body.events[0].kind).toBe('ai-user-fetch')
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

/**
 * Operator-recovery surface: `POST /traffic/sources/:id/reset` advances
 * lastSyncedAt to NOW, clears the error state, and lets the next scheduled
 * sync resume from a recent timestamp. This exists because a source whose
 * lastSyncedAt ages past the upstream's retention window (Vercel 14d, Cloud
 * Logging 30d) gets permanently stuck under the new retention-throw
 * behavior — the recovery path used to require a raw SQL UPDATE.
 */
describe('POST /traffic/sources/:id/reset', () => {
  async function connectVercel(h: Awaited<ReturnType<typeof buildHarness>>): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: { projectId: 'prj_abc', teamId: 'team_xyz', token: 'vcp_test' },
    })
    expect(res.statusCode).toBe(200)
    return JSON.parse(res.payload).id
  }

  it('advances lastSyncedAt to NOW, clears status and lastError', async () => {
    const h = await buildHarness([])
    try {
      const sourceId = await connectVercel(h)
      // Simulate a stuck source: aged lastSyncedAt + error state.
      backdateLastSyncedAt(h.db, sourceId, 36 * 60 * 60_000)
      h.db
        .update(trafficSources)
        .set({
          status: TrafficSourceStatuses.error,
          lastError: 'Vercel pull failed: ExceedsBillingLimitError',
        })
        .where(eq(trafficSources.id, sourceId))
        .run()

      const before = Date.now()
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/reset`,
        payload: { advanceToNow: true },
      })
      expect(res.statusCode).toBe(200)
      const after = Date.now()

      const dto = JSON.parse(res.payload)
      expect(dto.id).toBe(sourceId)
      expect(dto.status).toBe(TrafficSourceStatuses.connected)
      expect(dto.lastError).toBeNull()
      const dtoMs = new Date(dto.lastSyncedAt).getTime()
      expect(dtoMs).toBeGreaterThanOrEqual(before)
      expect(dtoMs).toBeLessThanOrEqual(after)

      const row = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(row.status).toBe(TrafficSourceStatuses.connected)
      expect(row.lastError).toBeNull()
      expect(new Date(row.lastSyncedAt!).getTime()).toBeGreaterThanOrEqual(before)
    } finally {
      await h.close()
    }
  })

  it('rejects requests missing the advanceToNow flag (no implicit reset)', async () => {
    const h = await buildHarness([])
    try {
      const sourceId = await connectVercel(h)
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/reset`,
        payload: {},
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toMatch(/advanceToNow/)
    } finally {
      await h.close()
    }
  })

  it('rejects requests with advanceToNow=false (no implicit reset)', async () => {
    const h = await buildHarness([])
    try {
      const sourceId = await connectVercel(h)
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/reset`,
        payload: { advanceToNow: false },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await h.close()
    }
  })

  it('returns 404 for an unknown source id', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${crypto.randomUUID()}/reset`,
        payload: { advanceToNow: true },
      })
      expect(res.statusCode).toBe(404)
    } finally {
      await h.close()
    }
  })

  it('writes an audit log entry', async () => {
    const h = await buildHarness([])
    try {
      const sourceId = await connectVercel(h)
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/reset`,
        payload: { advanceToNow: true },
      })
      expect(res.statusCode).toBe(200)
      const auditRows = h.db.select().from(auditLog).all()
      const resetEntry = auditRows.find((r) => r.action === 'traffic.source.reset')
      expect(resetEntry).toBeDefined()
      expect(resetEntry!.entityId).toBe(sourceId)
    } finally {
      await h.close()
    }
  })

  it('rejects reset on an archived source', async () => {
    // Archived rows are hidden from listing endpoints; allowing reset would
    // silently flip status back to `connected` and resurrect them. Force a
    // re-connect instead.
    const h = await buildHarness([])
    try {
      const sourceId = await connectVercel(h)
      h.db
        .update(trafficSources)
        .set({ status: TrafficSourceStatuses.archived, archivedAt: new Date().toISOString() })
        .where(eq(trafficSources.id, sourceId))
        .run()

      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/reset`,
        payload: { advanceToNow: true },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toMatch(/archived/i)

      // Status must not have flipped back to `connected`.
      const row = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(row.status).toBe(TrafficSourceStatuses.archived)
    } finally {
      await h.close()
    }
  })
})
