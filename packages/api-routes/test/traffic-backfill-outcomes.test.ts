import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  aiReferralEventsHourly,
  aiUserFetchEventsHourly,
  crawlerEventsHourly,
  createClient,
  migrate,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import type { NormalizedTrafficRequest } from '@ainyc/canonry-contracts'
import { apiRoutes, type OutcomeTelemetryEvent } from '../src/index.js'
import type { CloudRunCredentialRecord } from '../src/traffic.js'
import { featureOutcomes } from './feature-outcome-capture.js'

// What a server-side traffic backfill and reset report through
// `feature.completed`. Their effects on the rollups are covered in traffic.test.ts.

const SA_KEY = JSON.stringify({
  client_email: 'sa@example-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake-key\n-----END PRIVATE KEY-----',
})

function trafficEvent(id: string, overrides: Partial<NormalizedTrafficRequest>): NormalizedTrafficRequest {
  return {
    sourceType: 'cloud-run', evidenceKind: 'raw-request', confidence: 'observed', eventId: id,
    observedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    method: 'GET', requestUrl: 'https://example.com/guide', host: 'example.com', path: '/guide', queryString: null,
    status: 200, userAgent: 'Mozilla/5.0', remoteIp: '1.2.3.4', referer: null, latencyMs: null,
    requestSizeBytes: null, responseSizeBytes: null, providerResource: { type: 'cloud_run_revision', labels: {} }, providerLabels: {},
    ...overrides,
  }
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())) })

async function harness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-backfill-outcomes-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const credentials = new Map<string, CloudRunCredentialRecord>()
  const pull: { events: NormalizedTrafficRequest[]; error?: Error; gate?: Promise<void> } = { events: [] }
  const outcomes: OutcomeTelemetryEvent[] = []
  const app: FastifyInstance = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    cloudRunCredentialStore: {
      getConnection: name => credentials.get(name),
      upsertConnection: record => { credentials.set(record.projectName, record); return record },
      deleteConnection: name => credentials.delete(name),
    },
    pullCloudRunEvents: async () => {
      await pull.gate
      if (pull.error) throw pull.error
      return { events: pull.events, rawEntryCount: pull.events.length, skippedEntryCount: 0, nextPageToken: undefined, filter: 'mock' }
    },
    resolveCloudRunAccessToken: async () => 'mock-access-token',
    onOutcome: event => { outcomes.push(event) },
  })
  await app.ready()
  closers.push(async () => { await app.close(); fs.rmSync(tmpDir, { recursive: true, force: true }) })
  await app.inject({
    method: 'PUT', url: '/api/v1/projects/test-project',
    payload: { displayName: 'Test Project', canonicalDomain: 'example.com', country: 'US', language: 'en' },
  })
  const connected = await app.inject({
    method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
    payload: { gcpProjectId: 'gcp-outcomes', keyJson: SA_KEY },
  })
  const sourceId = (connected.json() as { id: string }).id
  const backfill = (id = sourceId) => app.inject({
    method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${id}/backfill`, payload: { days: 1 },
    headers: { 'x-canonry-surface': 'cli', 'x-canonry-agent': 'codex' },
  })
  /** The `feature.completed` outcomes so far, once at least `count` have arrived. */
  const settled = async (count: number) => {
    await vi.waitFor(() => expect(featureOutcomes(outcomes).length).toBeGreaterThanOrEqual(count))
    return featureOutcomes(outcomes)
  }
  return { app, db, pull, sourceId, backfill, settled, outcomes }
}

function storedHits(db: DatabaseClient) {
  const sum = (table: typeof crawlerEventsHourly | typeof aiUserFetchEventsHourly) =>
    Number(db.select({ total: sql<number>`COALESCE(SUM(${table.hits}), 0)` }).from(table).get()!.total)
  const referrals = db.select({ total: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)` }).from(aiReferralEventsHourly).get()!
  return { crawlerHits: sum(crawlerEventsHourly), aiUserFetchHits: sum(aiUserFetchEventsHourly), aiReferralHits: Number(referrals.total) }
}

const backfilled = { feature: 'server_traffic', operation: 'backfill', durationBucket: expect.any(String) }

describe('server traffic backfill and reset outcomes', () => {
  it('reports a backfill when its background task has written the rollups, with what it wrote', async () => {
    const h = await harness()
    h.pull.events = [
      trafficEvent('crawl-1', { userAgent: 'GPTBot/1.0' }),
      trafficEvent('crawl-2', { userAgent: 'GPTBot/1.0', path: '/pricing', requestUrl: 'https://example.com/pricing' }),
      trafficEvent('fetch-1', { userAgent: 'ChatGPT-User/1.0' }),
      trafficEvent('visit-1', { referer: 'https://chatgpt.com/' }),
    ]
    // Hold the pull until the response has gone, as a real window does.
    let release!: () => void
    h.pull.gate = new Promise(resolve => { release = resolve })
    expect((await h.backfill()).statusCode).toBe(200)
    release()

    const [outcome] = await h.settled(1)
    // The counts are the hits the replace wrote, as the rollups store them.
    expect(storedHits(h.db)).toEqual({ crawlerHits: 2, aiUserFetchHits: 1, aiReferralHits: 1 })
    expect(outcome).toEqual({ ...backfilled, status: 'succeeded', counts: { events: 4, ...storedHits(h.db) } })
    // Reported after its request, so it carries who asked, read while the request was still active.
    expect(h.outcomes.find(e => e.event === 'feature.completed')?.attribution).toMatchObject({ surfaceLabel: 'cli', agentLabel: 'codex' })
  })

  it('reports an empty window as skipped, a refused pull by its status, and a refused request from the route', async () => {
    const h = await harness()
    await h.backfill()
    await h.settled(1)
    h.pull.error = Object.assign(new Error('Cloud Logging denied sa@example-project for projects/gcp-outcomes'), { status: 403 })
    await h.backfill()
    await h.settled(2)
    expect((await h.backfill('no-such-source')).statusCode).toBe(404)

    expect(await h.settled(3)).toEqual([
      { ...backfilled, status: 'skipped', reasonCode: 'NO_DATA' },
      { ...backfilled, status: 'failed', reasonCode: 'PERMISSION_MISSING', errorName: 'Error' },
      { ...backfilled, status: 'failed', reasonCode: 'NOT_FOUND', errorName: 'AppError' },
    ])
  })

  it('reports a reset, and a reset refused for its input', async () => {
    const h = await harness()
    const reset = (payload: object) => h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${h.sourceId}/reset`, payload,
    })
    expect((await reset({ advanceToNow: true })).statusCode).toBe(200)
    expect((await reset({})).statusCode).toBe(400)
    const reported = { feature: 'server_traffic', operation: 'reset', durationBucket: expect.any(String) }
    expect(await h.settled(2)).toEqual([
      { ...reported, status: 'succeeded' },
      { ...reported, status: 'failed', reasonCode: 'VALIDATION', errorName: 'AppError' },
    ])
  })
})
