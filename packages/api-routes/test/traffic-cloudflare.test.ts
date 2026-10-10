import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHmac } from 'node:crypto'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  trafficSources,
  crawlerEventsHourly,
  crawlerVerificationManifestsHourly,
  aiUserFetchEventsHourly,
  aiReferralEventsHourly,
  rawEventSamples,
  auditLog,
  trafficEventReceipts,
} from '@ainyc/canonry-db'
import { TrafficSourceStatuses, TrafficSourceTypes } from '@ainyc/canonry-contracts'
import { canonicalizeCloudflareJson } from '@ainyc/canonry-integration-cloudflare-worker'
import { apiRoutes } from '../src/index.js'
import { CURRENT_CLOUDFLARE_WORKER_VERSION } from '../src/cloudflare-worker-version.js'
import type {
  CloudflareTrafficCredentialRecord,
  CloudflareTrafficCredentialStore,
  TrafficIngestedEvent,
} from '../src/traffic.js'
import type { OutcomeTelemetryEvent } from '../src/outcome-telemetry.js'
import { connectionOutcomes } from './outcome-capture.js'

const INGEST_URL = 'https://canonry.test/api/v1/projects/{name}/traffic/cloudflare/ingest'

async function buildHarness(opts: {
  ingestUrl?: string
  ingestRateLimitMax?: number
  ingestIpRateLimitMax?: number
  sampleLimit?: number
  canonicalDomain?: string
} = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-traffic-routes-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const cloudflareCredentials = new Map<string, CloudflareTrafficCredentialRecord>()
  const cloudflareTrafficCredentialStore: CloudflareTrafficCredentialStore = {
    getConnection: (projectName) => cloudflareCredentials.get(projectName),
    getConnectionBySourceId: (sourceId) => {
      for (const record of cloudflareCredentials.values()) {
        if (record.sourceId === sourceId) return record
      }
      return undefined
    },
    upsertConnection: (record) => {
      cloudflareCredentials.set(record.projectName, record)
      return record
    },
    deleteConnection: (projectName) => cloudflareCredentials.delete(projectName),
  }

  const ingested: TrafficIngestedEvent[] = []
  const outcomes: OutcomeTelemetryEvent[] = []
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    onTrafficIngested: event => { ingested.push(event) },
    onOutcome: event => { outcomes.push(event) },
    cloudflareTrafficCredentialStore,
    cloudflareTrafficIngestUrl: opts.ingestUrl ?? INGEST_URL,
    cloudflareIngestRateLimitMax: opts.ingestRateLimitMax,
    cloudflareIngestIpRateLimitMax: opts.ingestIpRateLimitMax,
    defaultTrafficSampleLimit: opts.sampleLimit,
  })
  await app.ready()

  // Seed a project.
  await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/test-project',
    payload: {
      displayName: 'Test Project',
      canonicalDomain: opts.canonicalDomain ?? 'example.com',
      country: 'US',
      language: 'en',
    },
  })

  return {
    app,
    db,
    cloudflareCredentials,
    ingested,
    connections: () => connectionOutcomes(outcomes),
    tmpDir,
    close: async () => {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

function sign(timestamp: number, body: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

function signPayload(timestamp: number, payload: unknown, secret: string): string {
  return sign(timestamp, canonicalizeCloudflareJson(payload), secret)
}

function buildIngestEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: `ray-${Math.random().toString(36).slice(2)}`,
    observedAt: new Date(Date.now() - 60_000).toISOString(),
    method: 'GET',
    host: 'example.com',
    path: '/blog/foo',
    queryString: null,
    status: 200,
    userAgent: 'GPTBot/1.2',
    remoteIp: '20.171.207.34',
    referer: null,
    cf: { verifiedBot: true, botScore: 30, country: 'US', asn: 8075, asOrganization: 'Microsoft Corporation' },
    ...overrides,
  }
}

describe('POST /traffic/connect/cloudflare', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>
  beforeEach(async () => { h = await buildHarness() })
  afterEach(async () => { await h.close() })

  it('creates a source row and persists per-source secrets in the credential store', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: { displayName: 'Cloudflare · example.com' },
    })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.payload) as Record<string, unknown>
    expect(body.sourceId).toMatch(/.+/)
    expect(body.deliveryMode).toBe('direct-push')
    expect(typeof body.workerScript).toBe('string')
    expect((body.workerScript as string)).toContain('export default')
    expect(body.wranglerToml).toContain('workers_dev = false')
    expect(body.wranglerToml).toContain('example.com/*')
    expect(body.workerVersion).toBe(CURRENT_CLOUDFLARE_WORKER_VERSION)
    expect(typeof body.instructions).toBe('string')
    expect(body.instructions).toMatch(/inspect existing Cloudflare Worker routes/i)
    expect(body.instructions).toContain('Request limit failure mode to Fail open')
    expect(body.instructions).toContain('Wrangler cannot set this toggle')
    expect(body.wranglerToml).not.toContain('[[routes]]')

    const rows = h.db.select().from(trafficSources).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sourceType).toBe(TrafficSourceTypes.cloudflare)
    expect(rows[0]!.status).toBe('connected')
    expect(rows[0]!.ingestTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0]!.lastSyncedAt).not.toBeNull()

    const credential = h.cloudflareCredentials.get('test-project')
    expect(credential).toBeDefined()
    expect(credential?.sourceId).toBe(body.sourceId)
    expect(credential?.deliveryMode).toBe('direct-push')
    expect(credential?.bearerToken).toMatch(/.+/)
    expect(credential?.hmacSecret).toMatch(/.+/)
  })

  it('keeps credentials out of generated Worker source and Wrangler config', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: { displayName: 'CF' },
    })
    const body = JSON.parse(res.payload) as { workerScript: string; wranglerToml: string; sourceId: string }
    const credential = h.cloudflareCredentials.get('test-project')!
    expect(body.workerScript).not.toContain(credential.bearerToken)
    expect(body.workerScript).not.toContain(credential.hmacSecret)
    expect(body.wranglerToml).not.toContain(credential.bearerToken)
    expect(body.wranglerToml).not.toContain(credential.hmacSecret)
    expect(body.wranglerToml).toContain(body.sourceId)
  })

  it('writes an audit log entry tagged traffic.cloudflare.connected', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {},
    })
    const audits = h.db.select().from(auditLog).all()
    const connect = audits.find((a) => a.action === 'traffic.cloudflare.connected')
    expect(connect).toBeDefined()
    expect(connect?.entityType).toBe('traffic_source')
  })

  it('is idempotent — reconnect reuses credentials, source row, and omitted metadata', async () => {
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: { displayName: 'CF production', zoneId: 'zone_1', accountId: 'account_1' },
    })
    const firstBody = JSON.parse(first.payload) as { sourceId: string }
    const firstCred = { ...h.cloudflareCredentials.get('test-project')! }
    const firstSource = h.db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.id, firstBody.sourceId))
      .get()!
    const { deliveryMode: _legacyMissingDeliveryMode, ...legacyConfig } = firstSource.configJson
    h.db
      .update(trafficSources)
      .set({ configJson: legacyConfig })
      .where(eq(trafficSources.id, firstBody.sourceId))
      .run()

    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {},
    })
    expect(second.statusCode).toBe(200)
    const secondBody = JSON.parse(second.payload) as { sourceId: string }
    expect(secondBody.sourceId).toBe(firstBody.sourceId)

    const secondCred = h.cloudflareCredentials.get('test-project')!
    expect(secondCred.bearerToken).toBe(firstCred.bearerToken)
    expect(secondCred.hmacSecret).toBe(firstCred.hmacSecret)
    expect(secondCred.zoneId).toBe('zone_1')
    expect(secondCred.accountId).toBe('account_1')

    const rows = h.db.select().from(trafficSources).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ displayName: 'CF production' })
    expect(rows[0]!.configJson).toMatchObject({
      deliveryMode: 'direct-push',
      zoneId: 'zone_1',
      accountId: 'account_1',
    })
  })

  it('persists the bot list version in the source config', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: { zoneId: 'zone_abc', accountId: 'acct_xyz' },
    })
    const body = JSON.parse(res.payload) as { sourceId: string; wranglerToml: string }
    const sourceId = body.sourceId
    expect(body.wranglerToml).toContain('#   example.com/*')
    expect(body.wranglerToml).toContain('# Target zone id: "zone_abc"')
    expect(body.wranglerToml).toContain('account_id = "acct_xyz"')
    const row = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
    expect(row.configJson).toMatchObject({
      schemaVersion: 1,
      deliveryMode: 'direct-push',
      workerVersion: expect.any(String),
      expectedBotListVersion: expect.any(String),
      zoneId: 'zone_abc',
      accountId: 'acct_xyz',
    })
  })

  it('refuses to reconnect credentials from another delivery mode', async () => {
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {},
    })
    expect(first.statusCode).toBe(200)
    const credential = h.cloudflareCredentials.get('test-project')!
    h.cloudflareCredentials.set('test-project', {
      ...credential,
      deliveryMode: 'queue-pull',
    } as unknown as CloudflareTrafficCredentialRecord)

    const reconnect = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {},
    })

    expect(reconnect.statusCode).toBe(400)
    expect(reconnect.payload).toMatch(/delivery mode/i)
  })

  it('rejects a loopback HTTP ingest URL that Cloudflare edge cannot reach', async () => {
    await h.close()
    h = await buildHarness({
      ingestUrl: 'http://localhost:4100/api/v1/projects/{name}/traffic/cloudflare/ingest',
    })

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(res.payload).toMatch(/public Cloudflare edge/i)
    expect(h.db.select().from(trafficSources).all()).toHaveLength(0)
  })

  it('rejects an ingest URL on the exact Worker route hostname before mutation', async () => {
    await h.close()
    h = await buildHarness({
      ingestUrl: 'https://EXAMPLE.com./api/v1/projects/{name}/traffic/cloudflare/ingest',
    })

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(res.payload).toMatch(/recursive ingestion/i)
    expect(h.db.select().from(trafficSources).all()).toHaveLength(0)
    expect(h.cloudflareCredentials.size).toBe(0)
  })

  it.each([
    ['userinfo', 'https://user@canonry.test/api/v1/projects/{name}/traffic/cloudflare/ingest'],
    ['a query', 'https://canonry.test/api/v1/projects/{name}/traffic/cloudflare/ingest?token=bad'],
    ['a fragment', 'https://canonry.test/api/v1/projects/{name}/traffic/cloudflare/ingest#secret'],
  ])('rejects ingest URLs with %s before mutation', async (_label, ingestUrl) => {
    await h.close()
    h = await buildHarness({ ingestUrl })

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(res.payload).toMatch(/credential-free public HTTPS URL/i)
    expect(h.db.select().from(trafficSources).all()).toHaveLength(0)
    expect(h.cloudflareCredentials.size).toBe(0)
  })

  it('normalizes a root URL into one exact route hostname and preserves www', async () => {
    await h.close()
    h = await buildHarness({ canonicalDomain: 'https://WWW.Example.com./' })

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: { zoneId: 'zone_www' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toMatchObject({
      wranglerToml: expect.stringContaining('www.example.com/*'),
    })
  })

  it('rejects a canonical domain with a non-root path before mutation', async () => {
    await h.close()
    h = await buildHarness({ canonicalDomain: 'https://example.com/site' })

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(res.payload).toMatch(/bare hostname or root HTTP/i)
    expect(h.db.select().from(trafficSources).all()).toHaveLength(0)
    expect(h.cloudflareCredentials.size).toBe(0)
  })

  it('rejects a canonical domain with a non-default port before mutation', async () => {
    await h.close()
    h = await buildHarness({ canonicalDomain: 'https://example.com:8443/' })

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(res.payload).toMatch(/non-default port/i)
    expect(h.db.select().from(trafficSources).all()).toHaveLength(0)
    expect(h.cloudflareCredentials.size).toBe(0)
  })

  it('rejects an IP address because Cloudflare routes require a zone hostname', async () => {
    await h.close()
    h = await buildHarness({ canonicalDomain: '203.0.113.10' })

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(res.payload).toMatch(/public hostname/i)
    expect(h.db.select().from(trafficSources).all()).toHaveLength(0)
    expect(h.cloudflareCredentials.size).toBe(0)
  })

  it('returns 404 for an unknown project', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/unknown/traffic/connect/cloudflare',
      payload: {},
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('Cloudflare connection outcomes', () => {
  it('reports a direct-push connect, and a reconnect of the same source as a reauth', async () => {
    const h = await buildHarness()
    try {
      for (let i = 0; i < 2; i += 1) {
        expect((await h.app.inject({ method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: {} })).statusCode).toBe(200)
      }
      expect(h.connections()).toEqual([
        { integration: 'traffic_cloudflare', action: 'connect', status: 'succeeded', durationBucket: 'under_1s' },
        { integration: 'traffic_cloudflare', action: 'reauth', status: 'succeeded', durationBucket: 'under_1s' },
      ])
    } finally {
      await h.close()
    }
  })
})

describe('POST /traffic/cloudflare/ingest', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>
  let sourceId: string
  let bearer: string
  let secret: string
  let projectId: string
  beforeEach(async () => {
    h = await buildHarness()
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {},
    })
    const body = JSON.parse(res.payload) as { sourceId: string }
    sourceId = body.sourceId
    const cred = h.cloudflareCredentials.get('test-project')!
    bearer = cred.bearerToken
    secret = cred.hmacSecret
    projectId = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!.projectId
  })
  afterEach(async () => { await h.close() })

  function ingest(opts: {
    body: Record<string, unknown>
    bearer?: string
    timestamp?: number
    signatureOverride?: string
    sourceIdHeader?: string
    rawBody?: string
    url?: string
    remoteAddress?: string
  }) {
    const bodyStr = opts.rawBody ?? JSON.stringify(opts.body)
    const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000)
    const signature = opts.signatureOverride ?? signPayload(timestamp, opts.body, secret)
    return h.app.inject({
      method: 'POST',
      url: opts.url ?? '/api/v1/projects/test-project/traffic/cloudflare/ingest',
      payload: bodyStr,
      remoteAddress: opts.remoteAddress,
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${opts.bearer ?? bearer}`,
        'X-Canonry-Timestamp': String(timestamp),
        'X-Canonry-Signature': signature,
        'X-Canonry-Source-Id': opts.sourceIdHeader ?? sourceId,
        'X-Canonry-Worker-Version': '1.0.0',
      },
    })
  }

  it('accepts a well-signed event and writes a crawler bucket', async () => {
    const res = await ingest({
      body: {
        schemaVersion: 1,
        workerVersion: CURRENT_CLOUDFLARE_WORKER_VERSION,
        events: [buildIngestEvent()],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as Record<string, unknown>
    expect(body.acceptedEvents).toBe(1)
    expect(body.droppedEvents).toBe(0)
    expect(body.workerVersionAck).toBe(CURRENT_CLOUDFLARE_WORKER_VERSION)

    const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
    expect(crawlerRows.length).toBeGreaterThanOrEqual(1)
    expect(crawlerRows[0]!.botId).toMatch(/.+/)
    expect(crawlerRows[0]!.sourceId).toBe(sourceId)
    expect(crawlerRows[0]!.projectId).toBe(projectId)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()?.lastWorkerVersion)
      .toBe(CURRENT_CLOUDFLARE_WORKER_VERSION)
    const manifests = h.db.select().from(crawlerVerificationManifestsHourly).all()
    expect(manifests).toHaveLength(1)
    expect(manifests[0]!.manifestJson).toEqual(expect.objectContaining({
      id: manifests[0]!.manifestId,
      source: expect.any(String),
      version: expect.any(String),
    }))
    expect(manifests[0]!.hits).toBe(1)
  })

  it('writes NO sidecar for a classifier with no published manifest, so the hit reads as unattributed', async () => {
    // 16 of the 26 crawler rules have no bundled ranges. A sentinel row here
    // would count toward `attributedHits`, driving verificationUnattributedHits
    // to 0 for the majority of traffic — the exact opposite of what the field
    // means. The hit must still land in the rollup.
    const res = await ingest({
      body: {
        schemaVersion: 1,
        workerVersion: '1.0.0',
        events: [buildIngestEvent({ userAgent: 'Bytespider/1.0', remoteIp: '192.0.2.1' })],
      },
    })
    expect(res.statusCode).toBe(200)

    expect(h.db.select().from(crawlerVerificationManifestsHourly).all()).toHaveLength(0)
    const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
    expect(crawlerRows).toHaveLength(1)
    expect(crawlerRows[0]!.botId).toBe('bytespider')
    expect(crawlerRows[0]!.hits).toBe(1)
  })

  it('writes NO sidecar when the source carried no IP, even for a bot that HAS a manifest', async () => {
    // The Vercel case: request logs expose no client IP, so nothing is compared
    // against Anthropic's manifest. Recording provenance would report
    // "Anthropic's manifest checked this and rejected it" for traffic that was
    // never checked at all.
    const res = await ingest({
      body: {
        schemaVersion: 1,
        workerVersion: '1.0.0',
        events: [buildIngestEvent({ userAgent: 'ClaudeBot/1.0', remoteIp: null })],
      },
    })
    expect(res.statusCode).toBe(200)

    expect(h.db.select().from(crawlerVerificationManifestsHourly).all()).toHaveLength(0)
    const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
    expect(crawlerRows).toHaveLength(1)
    expect(crawlerRows[0]!.verificationStatus).toBe('claimed_unverified')
    expect(crawlerRows[0]!.hits).toBe(1)
  })

  it('accepts an exact event hostname after case and trailing-dot normalization', async () => {
    const res = await ingest({
      body: {
        schemaVersion: 1,
        workerVersion: '1.0.0',
        events: [buildIngestEvent({ host: 'EXAMPLE.COM.' })],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toMatchObject({ acceptedEvents: 1 })
  })

  it('rejects a signed wrong-host batch before receipts or rollups are written', async () => {
    const res = await ingest({
      body: {
        schemaVersion: 1,
        workerVersion: '1.0.0',
        events: [
          buildIngestEvent({ eventId: 'right-host' }),
          buildIngestEvent({ eventId: 'wrong-host', host: 'www.example.com' }),
        ],
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.payload).toMatch(/does not belong to project domain/i)
    expect(h.db.select().from(trafficEventReceipts).all()).toHaveLength(0)
    expect(h.db.select().from(crawlerEventsHourly).all()).toHaveLength(0)
    expect(h.db.select().from(rawEventSamples).all()).toHaveLength(0)
  })

  it('verifies the canonical payload independent of JSON key order and whitespace', async () => {
    const body = {
      schemaVersion: 1,
      workerVersion: '1.0.0',
      events: [buildIngestEvent({ eventId: 'ray-canonical' })],
    }
    const rawBody = JSON.stringify({
      events: body.events,
      workerVersion: body.workerVersion,
      schemaVersion: body.schemaVersion,
    }, null, 2)

    const res = await ingest({ body, rawBody })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toMatchObject({ acceptedEvents: 1, droppedEvents: 0 })
  })

  it('updates last_worker_version on every successful ingest', async () => {
    await ingest({
      body: {
        schemaVersion: 1,
        workerVersion: '1.4.2',
        events: [buildIngestEvent()],
      },
    })
    const row = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
    expect(row.lastWorkerVersion).toBe('1.4.2')
  })

  it('rejects a missing Authorization header with 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/cloudflare/ingest',
      payload: JSON.stringify({ schemaVersion: 1, workerVersion: '1.0.0', events: [buildIngestEvent()] }),
      headers: {
        'content-type': 'application/json',
        'X-Canonry-Timestamp': String(Math.floor(Date.now() / 1000)),
        'X-Canonry-Signature': 'a'.repeat(64),
        'X-Canonry-Source-Id': sourceId,
      },
    })
    expect(res.statusCode).toBe(401)
  })

  it('authenticates before project resolution so unknown paths return the generic 401', async () => {
    const res = await ingest({
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [buildIngestEvent()] },
      bearer: 'wrong-token',
      url: '/api/v1/projects/unknown/traffic/cloudflare/ingest',
    })

    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.payload)).toMatchObject({
      error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
    })
  })

  it('rejects a wrong bearer token with 401', async () => {
    const res = await ingest({
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [buildIngestEvent()] },
      bearer: 'wrong-token',
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects when the DB ingest token hash no longer matches the presented bearer', async () => {
    h.db
      .update(trafficSources)
      .set({ ingestTokenHash: '0'.repeat(64) })
      .where(eq(trafficSources.id, sourceId))
      .run()

    const res = await ingest({
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [buildIngestEvent()] },
    })
    expect(res.statusCode).toBe(401)
    expect(h.db.select().from(crawlerEventsHourly).all()).toHaveLength(0)
  })

  it('rejects ingest for archived source rows', async () => {
    h.db
      .update(trafficSources)
      .set({ status: TrafficSourceStatuses.archived, archivedAt: new Date().toISOString() })
      .where(eq(trafficSources.id, sourceId))
      .run()

    const res = await ingest({
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [buildIngestEvent()] },
    })
    expect(res.statusCode).toBe(401)
    expect(h.db.select().from(crawlerEventsHourly).all()).toHaveLength(0)
  })

  it('rejects a source whose persisted delivery mode is not direct-push', async () => {
    const source = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
    h.db
      .update(trafficSources)
      .set({ configJson: { ...source.configJson, deliveryMode: 'queue-pull' } })
      .where(eq(trafficSources.id, sourceId))
      .run()

    const res = await ingest({
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [buildIngestEvent()] },
    })

    expect(res.statusCode).toBe(401)
    expect(h.db.select().from(crawlerEventsHourly).all()).toHaveLength(0)
  })

  it('defaults a legacy source with no delivery mode to direct-push', async () => {
    const source = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
    const { deliveryMode: _legacyMissingDeliveryMode, ...legacyConfig } = source.configJson
    h.db
      .update(trafficSources)
      .set({ configJson: legacyConfig })
      .where(eq(trafficSources.id, sourceId))
      .run()

    const res = await ingest({
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [buildIngestEvent()] },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toMatchObject({ acceptedEvents: 1, droppedEvents: 0 })
  })

  it('rejects a tampered body with 401', async () => {
    const tamperedBody = { schemaVersion: 1, workerVersion: '1.0.0', events: [buildIngestEvent()] }
    const ts = Math.floor(Date.now() / 1000)
    const sigForOriginal = sign(ts, JSON.stringify(tamperedBody), secret)
    const mutated = { ...tamperedBody, workerVersion: '9.9.9' }
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/cloudflare/ingest',
      payload: JSON.stringify(mutated),
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${bearer}`,
        'X-Canonry-Timestamp': String(ts),
        'X-Canonry-Signature': sigForOriginal,
        'X-Canonry-Source-Id': sourceId,
      },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects an expired timestamp (older than the 5-minute window) with 401', async () => {
    const old = Math.floor(Date.now() / 1000) - 400
    const res = await ingest({
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [buildIngestEvent()] },
      timestamp: old,
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects an unknown source id with 401', async () => {
    const res = await ingest({
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [buildIngestEvent()] },
      sourceIdHeader: 'src_unknown',
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects an empty events array with 400 validation error', async () => {
    const res = await ingest({
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a non-1 schemaVersion with 400 validation error', async () => {
    const res = await ingest({
      body: { schemaVersion: 2, workerVersion: '1.0.0', events: [buildIngestEvent()] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects ingest payloads larger than 256 KiB', async () => {
    const body = {
      schemaVersion: 1,
      workerVersion: 'x'.repeat(270 * 1024),
      events: [buildIngestEvent()],
    }
    const res = await ingest({ body })

    expect(res.statusCode).toBe(413)
  })

  it('reports each authenticated push with its counts, a refused batch with its reason, and nothing for an unauthenticated one', async () => {
    const pushed = await ingest({
      body: {
        schemaVersion: 1,
        workerVersion: '1.0.0',
        events: [
          buildIngestEvent(),
          buildIngestEvent({ userAgent: 'ChatGPT-User/1.0' }),
          buildIngestEvent({ userAgent: 'Mozilla/5.0', referer: 'https://chatgpt.com/' }),
        ],
      },
    })
    expect(pushed.statusCode).toBe(200)
    const wrongHost = await ingest({ body: { schemaVersion: 1, workerVersion: '1.0.0', events: [buildIngestEvent({ host: 'other.example' })] } })
    expect(wrongHost.statusCode).toBe(400)
    const forged = await ingest({ body: { schemaVersion: 1, workerVersion: '1.0.0', events: [buildIngestEvent()] }, signatureOverride: 'f'.repeat(64) })
    expect(forged.statusCode).toBe(401)

    expect(h.ingested).toEqual([
      { sourceType: 'cloudflare', status: 'succeeded', events: 3, crawlerHits: 1, aiUserFetchHits: 1, aiReferralHits: 1, durationMs: expect.any(Number) },
      { sourceType: 'cloudflare', status: 'failed', events: 0, crawlerHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, durationMs: expect.any(Number), reasonCode: 'VALIDATION' },
    ])
  })

  it('routes an AI-referral event into the referral bucket, not the crawler bucket', async () => {
    const res = await ingest({
      body: {
        schemaVersion: 1,
        workerVersion: '1.0.0',
        events: [
          buildIngestEvent({
            userAgent: 'Mozilla/5.0',
            referer: 'https://chatgpt.com/',
          }),
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const referralRows = h.db.select().from(aiReferralEventsHourly).all()
    expect(referralRows.length).toBeGreaterThanOrEqual(1)
    expect(referralRows[0]).toMatchObject({
      sessionsOrHits: 1,
      paidSessionsOrHits: 0,
      organicSessionsOrHits: 1,
    })
    const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
    expect(crawlerRows.length).toBe(0)
  })

  it('persists paid AI-referral attribution from request UTM parameters', async () => {
    const res = await ingest({
      body: {
        schemaVersion: 1,
        workerVersion: '1.0.0',
        events: [
          buildIngestEvent({
            userAgent: 'Mozilla/5.0',
            referer: null,
            queryString: 'utm_source=chatgpt&utm_medium=cpc&utm_campaign=openai_ads',
          }),
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    expect(h.db.select().from(aiReferralEventsHourly).all()[0]).toMatchObject({
      sessionsOrHits: 1,
      paidSessionsOrHits: 1,
      organicSessionsOrHits: 0,
    })
  })

  it('routes an AI-user-fetch UA into the ai-user-fetch bucket', async () => {
    const res = await ingest({
      body: {
        schemaVersion: 1,
        workerVersion: '1.0.0',
        events: [
          buildIngestEvent({
            userAgent: 'ChatGPT-User/1.0',
          }),
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const fetchRows = h.db.select().from(aiUserFetchEventsHourly).all()
    expect(fetchRows.length).toBeGreaterThanOrEqual(1)
  })

  it('writes a raw_event_samples row for inspection', async () => {
    await ingest({
      body: {
        schemaVersion: 1,
        workerVersion: '1.0.0',
        events: [buildIngestEvent()],
      },
    })
    const samples = h.db.select().from(rawEventSamples).all()
    expect(samples.length).toBeGreaterThanOrEqual(1)
  })

  it('caps raw samples source-wide per observed UTC hour across one-event pushes', async () => {
    await h.close()
    h = await buildHarness({ sampleLimit: 1 })
    const connect = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {},
    })
    sourceId = (JSON.parse(connect.payload) as { sourceId: string }).sourceId
    const credential = h.cloudflareCredentials.get('test-project')!
    bearer = credential.bearerToken
    secret = credential.hmacSecret

    const firstHour = new Date(Date.now() - 2 * 60 * 60_000)
    firstHour.setUTCMinutes(0, 0, 0)
    const firstSampleAt = new Date(firstHour.getTime() + 60_000).toISOString()
    const secondSampleAt = new Date(firstHour.getTime() + 59 * 60_000 + 59_000).toISOString()
    const nextHourSampleAt = new Date(firstHour.getTime() + 60 * 60_000).toISOString()
    for (const [eventId, observedAt] of [
      ['sample-hour-a', firstSampleAt],
      ['sample-hour-b', secondSampleAt],
      ['sample-next-hour', nextHourSampleAt],
    ] as const) {
      const res = await ingest({
        body: {
          schemaVersion: 1,
          workerVersion: '1.0.0',
          events: [buildIngestEvent({ eventId, observedAt })],
        },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload)).toMatchObject({ acceptedEvents: 1 })
    }

    expect(h.db.select().from(trafficEventReceipts).all()).toHaveLength(3)
    expect(h.db.select().from(crawlerEventsHourly).all().reduce((sum, row) => sum + row.hits, 0))
      .toBe(3)
    expect(h.db.select().from(rawEventSamples).all().map(row => row.ts).sort()).toEqual([
      firstSampleAt,
      nextHourSampleAt,
    ])
  })

  it('dedupes the 1,001st event after the legacy replay ring is cleared', async () => {
    const event = buildIngestEvent({ eventId: 'ray-replay' })
    const legacyReplayRing = Array.from({ length: 1_000 }, (_, index) => `pull-event-${index}`)
    h.db
      .update(trafficSources)
      .set({ lastEventIds: legacyReplayRing })
      .where(eq(trafficSources.id, sourceId))
      .run()
    const first = await ingest({
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [event] },
    })
    expect(first.statusCode).toBe(200)
    expect(JSON.parse(first.payload)).toMatchObject({ acceptedEvents: 1, droppedEvents: 0 })
    expect(
      h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!.lastEventIds,
    ).toEqual(legacyReplayRing)

    h.db
      .update(trafficSources)
      .set({ lastEventIds: [] })
      .where(eq(trafficSources.id, sourceId))
      .run()

    const second = await ingest({
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [event] },
    })
    expect(second.statusCode).toBe(200)
    expect(JSON.parse(second.payload)).toMatchObject({ acceptedEvents: 0, droppedEvents: 1 })

    const [crawlerRow] = h.db.select().from(crawlerEventsHourly).all()
    expect(crawlerRow?.hits).toBe(1)
    expect(
      h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!.lastEventIds,
    ).toEqual([])

    const receipts = h.db.select().from(trafficEventReceipts).all()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ sourceId, eventId: 'cloudflare-worker:ray-replay' })
    expect(Date.parse(receipts[0]!.expiresAt) - Date.parse(receipts[0]!.receivedAt))
      .toBe(10 * 60_000)
  })

  it('prunes expired durable receipts while claiming the next event', async () => {
    h.db.insert(trafficEventReceipts).values({
      sourceId,
      eventId: 'ray-expired',
      receivedAt: '2000-01-01T00:00:00.000Z',
      expiresAt: '2000-01-02T00:00:00.000Z',
    }).run()

    const res = await ingest({
      body: {
        schemaVersion: 1,
        workerVersion: '1.0.0',
        events: [buildIngestEvent({ eventId: 'ray-current' })],
      },
    })

    expect(res.statusCode).toBe(200)
    expect(h.db.select().from(trafficEventReceipts).all().map(row => row.eventId))
      .toEqual(['cloudflare-worker:ray-current'])
  })

  it('dedupes duplicate Cloudflare event ids inside one batch', async () => {
    const event = buildIngestEvent({ eventId: 'ray-batch-dup' })
    const res = await ingest({
      body: {
        schemaVersion: 1,
        workerVersion: '1.0.0',
        events: [event, { ...event }],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toMatchObject({ acceptedEvents: 1, droppedEvents: 1 })

    const [crawlerRow] = h.db.select().from(crawlerEventsHourly).all()
    expect(crawlerRow?.hits).toBe(1)
  })

  it('claims concurrent identical ingests once', async () => {
    const event = buildIngestEvent({ eventId: 'ray-concurrent' })
    const responses = await Promise.all([
      ingest({ body: { schemaVersion: 1, workerVersion: '1.0.0', events: [event] } }),
      ingest({ body: { schemaVersion: 1, workerVersion: '1.0.0', events: [event] } }),
    ])

    expect(responses.map(response => response.statusCode)).toEqual([200, 200])
    const acknowledgements = responses.map(response => JSON.parse(response.payload) as {
      acceptedEvents: number
      droppedEvents: number
    })
    expect(acknowledgements.reduce((sum, ack) => sum + ack.acceptedEvents, 0)).toBe(1)
    expect(acknowledgements.reduce((sum, ack) => sum + ack.droppedEvents, 0)).toBe(1)
    expect(h.db.select().from(trafficEventReceipts).all()).toHaveLength(1)
    expect(h.db.select().from(crawlerEventsHourly).all()[0]?.hits).toBe(1)
  })

  it('rate-limits valid traffic per source without charging invalid paths to that bucket', async () => {
    await h.close()
    h = await buildHarness({ ingestRateLimitMax: 1 })
    const connect = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {},
    })
    sourceId = (JSON.parse(connect.payload) as { sourceId: string }).sourceId
    const credential = h.cloudflareCredentials.get('test-project')!
    bearer = credential.bearerToken
    secret = credential.hmacSecret

    const invalid = await ingest({
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [buildIngestEvent()] },
      url: '/api/v1/projects/unknown/traffic/cloudflare/ingest',
    })
    expect(invalid.statusCode).toBe(401)

    const first = await ingest({
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [buildIngestEvent()] },
      remoteAddress: '203.0.113.10',
    })
    expect(first.statusCode).toBe(200)

    const second = await ingest({
      body: { schemaVersion: 1, workerVersion: '1.0.0', events: [buildIngestEvent()] },
      remoteAddress: '198.51.100.20',
    })
    expect(second.statusCode).toBe(429)
  })

  it('meters malformed JSON by caller IP before body parsing', async () => {
    await h.close()
    h = await buildHarness({ ingestIpRateLimitMax: 1 })

    const sendMalformed = () => h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/cloudflare/ingest',
      payload: '{"schemaVersion":',
      headers: { 'content-type': 'application/json' },
    })
    const first = await sendMalformed()
    const second = await sendMalformed()

    expect(first.statusCode).toBe(400)
    expect(second.statusCode).toBe(429)
  })
})
