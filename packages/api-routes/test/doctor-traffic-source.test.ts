import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {
  createClient,
  migrate,
  projects,
  runs,
  trafficSources,
  crawlerEventsHourly,
  aiUserFetchEventsHourly,
  aiReferralEventsHourly,
} from '@canonry/canonry-db'
import type { CloudflareQueueDrainStopReason } from '@canonry/canonry-contracts'
import { CURRENT_CLOUDFLARE_WORKER_VERSION } from '../src/cloudflare-worker-version.js'
import { TRAFFIC_SOURCE_CHECKS } from '../src/doctor/checks/traffic-source.js'
import type { CheckOutput, DoctorContext, ProjectInfo, TrafficSourceProbe, TrafficSourceValidator } from '../src/doctor/types.js'

// Bind by id, not position: positional destructuring silently rebinds every
// check to the wrong assertions the moment one is inserted into the array.
const checkById = (id: string) => {
  const found = TRAFFIC_SOURCE_CHECKS.find(check => check.id === id)
  if (!found) throw new Error(`No traffic source check registered with id "${id}"`)
  return found
}
const sourceConnectedCheck = checkById('traffic.source.connected')
const recentDataCheck = checkById('traffic.source.recent-data')
const credentialsCheck = checkById('traffic.source.credentials')
const scopesCheck = checkById('traffic.source.scopes')
const cacheBlindSpotCheck = checkById('traffic.source.cache-blindspot')
const workerVersionCheck = checkById('traffic.source.worker-version')
const queueBacklogCheck = checkById('traffic.source.queue-backlog')

interface Harness {
  db: ReturnType<typeof createClient>
  tmpDir: string
  project: ProjectInfo
  close: () => void
}

function buildHarness(): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-traffic-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'test-project',
    displayName: 'Test',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    queries: [],
    competitors: '[]',
    providers: '[]',
    createdAt: now,
    updatedAt: now,
  } as typeof projects.$inferInsert).run()
  return {
    db,
    tmpDir,
    project: { id: projectId, name: 'test-project', canonicalDomain: 'example.com', displayName: 'Test' },
    close: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  }
}

function isoMinusDays(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString()
}

function insertTrafficSource(
  h: Harness,
  args: {
    sourceType?: string
    status?: string
    displayName?: string
    lastSyncedAt?: string | null
    lastError?: string | null
    configJson?: Record<string, unknown>
    lastWorkerVersion?: string | null
    queueBacklogCount?: number | null
    queueBacklogObservedAt?: string | null
  } = {},
): string {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  h.db.insert(trafficSources).values({
    id,
    projectId: h.project.id,
    sourceType: args.sourceType ?? 'cloud-run',
    displayName: args.displayName ?? 'Source',
    status: args.status ?? 'connected',
    lastSyncedAt: args.lastSyncedAt ?? null,
    lastCursor: null,
    lastError: args.lastError ?? null,
    lastWorkerVersion: args.lastWorkerVersion ?? null,
    queueBacklogCount: args.queueBacklogCount ?? null,
    queueBacklogObservedAt: args.queueBacklogObservedAt ?? null,
    lastEventIds: null,
    archivedAt: args.status === 'archived' ? now : null,
    configJson: args.configJson ?? {},
    createdAt: now,
    updatedAt: now,
  }).run()
  return id
}

function insertCrawlerHit(h: Harness, sourceId: string, opts: { tsHour?: string; hits?: number } = {}) {
  h.db.insert(crawlerEventsHourly).values({
    projectId: h.project.id,
    sourceId,
    tsHour: opts.tsHour ?? isoMinusDays(1),
    botId: 'gptbot',
    operator: 'OpenAI',
    verificationStatus: 'verified',
    pathNormalized: '/blog',
    status: 200,
    hits: opts.hits ?? 1,
    sampledUserAgent: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run()
}

function insertReferralHit(h: Harness, sourceId: string, opts: { tsHour?: string; hits?: number } = {}) {
  h.db.insert(aiReferralEventsHourly).values({
    projectId: h.project.id,
    sourceId,
    tsHour: opts.tsHour ?? isoMinusDays(1),
    product: 'ChatGPT',
    operator: 'OpenAI',
    sourceDomain: 'chatgpt.com',
    evidenceType: 'referer',
    landingPathNormalized: '/blog',
    status: 200,
    sessionsOrHits: opts.hits ?? 1,
    usersEstimated: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run()
}

function insertUserFetchHit(h: Harness, sourceId: string, opts: { tsHour?: string; hits?: number } = {}) {
  h.db.insert(aiUserFetchEventsHourly).values({
    projectId: h.project.id,
    sourceId,
    tsHour: opts.tsHour ?? isoMinusDays(1),
    botId: 'chatgpt-user',
    operator: 'OpenAI',
    verificationStatus: 'self-declared',
    pathNormalized: '/blog',
    status: 200,
    hits: opts.hits ?? 1,
    sampledUserAgent: 'ChatGPT-User/1.0',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run()
}

function ctxFor(h: Harness, validators?: Record<string, TrafficSourceValidator>): DoctorContext {
  return {
    db: h.db,
    project: h.project,
    trafficSourceValidators: validators,
  }
}

let h: Harness

beforeEach(() => { h = buildHarness() })
afterEach(() => { h.close() })

describe('traffic.source.connected', () => {
  it('skips when no traffic source connected', async () => {
    const r = await sourceConnectedCheck.run(ctxFor(h))
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('traffic.source.none')
  })

  it('returns ok when at least one source is connected', async () => {
    insertTrafficSource(h)
    const r = await sourceConnectedCheck.run(ctxFor(h))
    expect(r.status).toBe('ok')
    expect(r.code).toBe('traffic.source.connected')
    expect(r.details?.sourceCount).toBe(1)
  })

  it('does not report a paused staged source as actively connected', async () => {
    insertTrafficSource(h, { status: 'paused', displayName: 'Queue staged' })
    const r = await sourceConnectedCheck.run(ctxFor(h))
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('traffic.source.paused')
  })

  it('warns when one of several sources is errored', async () => {
    insertTrafficSource(h, { displayName: 'A' })
    insertTrafficSource(h, { displayName: 'B', status: 'error', lastError: 'auth bad' })
    const r = await sourceConnectedCheck.run(ctxFor(h))
    expect(r.status).toBe('warn')
    expect(r.code).toBe('traffic.source.partially-errored')
  })

  it('fails when all sources are errored', async () => {
    insertTrafficSource(h, { status: 'error', lastError: 'auth bad' })
    const r = await sourceConnectedCheck.run(ctxFor(h))
    expect(r.status).toBe('fail')
    expect(r.code).toBe('traffic.source.all-errored')
    expect(r.remediation).toContain('auth bad')
  })

  // A source reads `error` after one failed sync, until its next success.
  it.each([
    { failed: 1, status: 'warn', code: 'traffic.source.all-errored-recently' },
    { failed: 3, status: 'fail', code: 'traffic.source.all-errored' },
  ])('is $status after $failed failed sync(s) in a row since the last success', async ({ failed, status, code }) => {
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60_000).toISOString()
    const lastSyncedAt = hoursAgo(failed + 1)
    const sourceId = insertTrafficSource(h, {
      sourceType: 'wordpress', status: 'error', lastError: 'hostname could not be resolved', lastSyncedAt,
    })
    const syncRun = (runStatus: string, hours: number) => h.db.insert(runs).values({
      id: crypto.randomUUID(), projectId: h.project.id, kind: 'traffic-sync', status: runStatus, trigger: 'manual',
      sourceId, createdAt: hoursAgo(hours), finishedAt: hoursAgo(hours - 0.01),
    }).run()
    syncRun('completed', failed + 1)
    for (let hours = failed; hours >= 1; hours--) syncRun('failed', hours)

    const r = await sourceConnectedCheck.run(ctxFor(h))

    expect(r).toMatchObject({ status, code })
    expect(r.summary).toContain(`No new data since ${lastSyncedAt}`)
  })

  it('treats archived-only sources as no source', async () => {
    insertTrafficSource(h, { status: 'archived' })
    const r = await sourceConnectedCheck.run(ctxFor(h))
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('traffic.source.none')
  })

  it('skips with helpful message when project context missing', async () => {
    const ctx: DoctorContext = { db: h.db, project: null }
    const r = await sourceConnectedCheck.run(ctx)
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('traffic.no-project')
  })
})

describe('traffic.source.recent-data', () => {
  it('returns ok when crawler hits exist in the last 7 days', async () => {
    const sourceId = insertTrafficSource(h)
    insertCrawlerHit(h, sourceId, { tsHour: isoMinusDays(2) })
    const r = await recentDataCheck.run(ctxFor(h))
    expect(r.status).toBe('ok')
    expect(r.code).toBe('traffic.recent-data.fresh')
  })

  it('returns ok when only AI user-fetch hits exist in the last 7 days', async () => {
    const sourceId = insertTrafficSource(h)
    insertUserFetchHit(h, sourceId, { tsHour: isoMinusDays(2), hits: 3 })
    const r = await recentDataCheck.run(ctxFor(h))
    expect(r.status).toBe('ok')
    expect(r.code).toBe('traffic.recent-data.fresh')
    expect(r.details).toMatchObject({ aiUserFetchHits: 3 })
  })

  it('warns when older data exists but recent window is empty', async () => {
    const sourceId = insertTrafficSource(h, { lastSyncedAt: isoMinusDays(15) })
    insertCrawlerHit(h, sourceId, { tsHour: isoMinusDays(15) })
    const r = await recentDataCheck.run(ctxFor(h))
    expect(r.status).toBe('warn')
    expect(r.code).toBe('traffic.recent-data.stale')
  })

  it('warns (not fails) when only older AI referrals exist and lastSyncedAt is null', async () => {
    // Regression: the older-data fallback used to count only crawler hits;
    // a project with AI-referral history but no crawler history and a
    // nulled-out lastSyncedAt (e.g. data inserted via backfill/migration
    // without advancing the cursor) would be misreported as `empty`.
    const sourceId = insertTrafficSource(h, { lastSyncedAt: null })
    insertReferralHit(h, sourceId, { tsHour: isoMinusDays(15) })
    const r = await recentDataCheck.run(ctxFor(h))
    expect(r.status).toBe('warn')
    expect(r.code).toBe('traffic.recent-data.stale')
  })

  it('warns when only older AI user-fetch data exists', async () => {
    const sourceId = insertTrafficSource(h, { lastSyncedAt: null })
    insertUserFetchHit(h, sourceId, { tsHour: isoMinusDays(15) })
    const r = await recentDataCheck.run(ctxFor(h))
    expect(r.status).toBe('warn')
    expect(r.code).toBe('traffic.recent-data.stale')
  })

  it('fails when source connected but never produced any data', async () => {
    insertTrafficSource(h)
    const r = await recentDataCheck.run(ctxFor(h))
    expect(r.status).toBe('fail')
    expect(r.code).toBe('traffic.recent-data.empty')
  })

  it('warns with Cloudflare-specific remediation when a push source has no data yet', async () => {
    insertTrafficSource(h, {
      sourceType: 'cloudflare',
      displayName: 'Cloudflare',
      lastSyncedAt: new Date().toISOString(),
    })
    const r = await recentDataCheck.run(ctxFor(h))
    expect(r.status).toBe('warn')
    expect(r.code).toBe('traffic.recent-data.stale')
    expect(r.remediation).toContain('Cloudflare Worker')
    expect(r.remediation).not.toContain('traffic sync')
  })

  it('skips a paused staged source instead of reporting its historical watermark as current', async () => {
    const sourceId = insertTrafficSource(h, {
      status: 'paused',
      lastSyncedAt: new Date().toISOString(),
      displayName: 'Queue staged',
    })
    insertCrawlerHit(h, sourceId)
    const r = await recentDataCheck.run(ctxFor(h))
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('traffic.recent-data.no-active-source')
  })
})

describe('traffic.source.credentials', () => {
  it('skips when no source connected', async () => {
    const r = await credentialsCheck.run(ctxFor(h))
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('traffic.credentials.no-source')
  })

  it('marks all-skipped when source has no validator registered', async () => {
    insertTrafficSource(h, { sourceType: 'unknown-future-adapter' })
    const r = await credentialsCheck.run(ctxFor(h, {}))
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('traffic.credentials.all-skipped')
  })

  it('returns ok when validator confirms credentials', async () => {
    insertTrafficSource(h)
    const validator: TrafficSourceValidator = {
      validateCredentials: () => ({
        status: 'ok',
        code: 'cloud-run.token-resolved',
        summary: 'token ok',
      }),
    }
    const r = await credentialsCheck.run(ctxFor(h, { 'cloud-run': validator }))
    expect(r.status).toBe('ok')
    expect(r.code).toBe('traffic.credentials.ok')
  })

  it('fails when validator returns a fail result', async () => {
    insertTrafficSource(h, { displayName: 'Prod' })
    const validator: TrafficSourceValidator = {
      validateCredentials: () => ({
        status: 'fail',
        code: 'cloud-run.token-missing',
        summary: 'no token',
        remediation: 're-connect',
      }),
    }
    const r = await credentialsCheck.run(ctxFor(h, { 'cloud-run': validator }))
    expect(r.status).toBe('fail')
    expect(r.code).toBe('traffic.credentials.failed')
    expect(r.summary).toContain('Prod')
  })

  it('catches validator exceptions and surfaces a fail result', async () => {
    insertTrafficSource(h)
    const validator: TrafficSourceValidator = {
      validateCredentials: () => { throw new Error('network down') },
    }
    const r = await credentialsCheck.run(ctxFor(h, { 'cloud-run': validator }))
    expect(r.status).toBe('fail')
    const detail = r.details as { sources: Array<{ code: string }> }
    expect(detail.sources[0]!.code).toBe('traffic.credentials.validator-error')
  })

  it('per-source dispatches by sourceType — only the matching adapter runs', async () => {
    insertTrafficSource(h, { sourceType: 'cloud-run', displayName: 'GCP' })
    insertTrafficSource(h, { sourceType: 'wp-plugin', displayName: 'WP' })
    let cloudRunCalled = 0
    let wpCalled = 0
    const validators = {
      'cloud-run': {
        validateCredentials: () => { cloudRunCalled++; return { status: 'ok' as const, code: 'cr.ok', summary: 'cr ok' } },
      },
      'wp-plugin': {
        validateCredentials: () => { wpCalled++; return { status: 'ok' as const, code: 'wp.ok', summary: 'wp ok' } },
      },
    } satisfies Record<string, TrafficSourceValidator>
    const r = await credentialsCheck.run(ctxFor(h, validators))
    expect(cloudRunCalled).toBe(1)
    expect(wpCalled).toBe(1)
    expect(r.status).toBe('ok')
    const detail = r.details as { sources: Array<{ sourceType: string }> }
    expect(detail.sources.map((s) => s.sourceType).sort()).toEqual(['cloud-run', 'wp-plugin'])
  })
})

describe('traffic.source.scopes', () => {
  it('skips when no source connected', async () => {
    const r = await scopesCheck.run(ctxFor(h))
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('traffic.scopes.no-source')
  })

  it('marks unsupported when validator returns null (e.g. Cloud Run without explicit scopes)', async () => {
    insertTrafficSource(h)
    const validator: TrafficSourceValidator = {
      validateScopes: () => null,
    }
    const r = await scopesCheck.run(ctxFor(h, { 'cloud-run': validator }))
    // null result becomes a per-source `unsupported` skipped — overall result is all-skipped.
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('traffic.scopes.all-skipped')
    const detail = r.details as { sources: Array<{ code: string }> }
    expect(detail.sources[0]!.code).toBe('traffic.scopes.unsupported')
  })
})

describe('traffic.source.cache-blindspot', () => {
  it('skips when no WordPress source is connected (cloud-run only)', async () => {
    insertTrafficSource(h, { sourceType: 'cloud-run' })
    const r = await cacheBlindSpotCheck.run(ctxFor(h))
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('traffic.cache-blindspot.no-wordpress-source')
  })

  it('skips when there is no traffic source at all', async () => {
    const r = await cacheBlindSpotCheck.run(ctxFor(h))
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('traffic.cache-blindspot.no-wordpress-source')
  })

  it('warns when a WordPress source is connected — cache-served views can be missed', async () => {
    insertTrafficSource(h, { sourceType: 'wordpress', displayName: 'WordPress · example.com' })
    const r = await cacheBlindSpotCheck.run(ctxFor(h))
    expect(r.status).toBe('warn')
    expect(r.code).toBe('traffic.cache-blindspot.wordpress-plugin')
    expect(r.remediation).toMatch(/user.?agent/i)
    expect((r.details as { wordpressSourceCount: number }).wordpressSourceCount).toBe(1)
  })

  it('counts multiple WordPress sources and ignores non-wordpress ones', async () => {
    insertTrafficSource(h, { sourceType: 'wordpress', displayName: 'A' })
    insertTrafficSource(h, { sourceType: 'wordpress', displayName: 'B' })
    insertTrafficSource(h, { sourceType: 'cloud-run', displayName: 'GCP' })
    const r = await cacheBlindSpotCheck.run(ctxFor(h))
    expect(r.status).toBe('warn')
    expect((r.details as { wordpressSourceCount: number }).wordpressSourceCount).toBe(2)
  })

  it('skips with the project-missing code when project context is absent', async () => {
    const ctx: DoctorContext = { db: h.db, project: null }
    const r = await cacheBlindSpotCheck.run(ctx)
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('traffic.no-project')
  })
})

describe('traffic.source.worker-version', () => {
  it('skips when no active Cloudflare Worker source is connected', async () => {
    insertTrafficSource(h, { sourceType: 'cloud-run' })
    insertTrafficSource(h, {
      sourceType: 'cloudflare',
      status: 'paused',
      configJson: { deliveryMode: 'queue-pull', workerVersion: '1.0.0' },
    })
    const r = await workerVersionCheck.run(ctxFor(h))
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('traffic.worker-version.not-applicable')
  })

  it.each(['direct-push', 'queue-pull'])('warns while a %s source waits for its first event', async (deliveryMode) => {
    insertTrafficSource(h, {
      sourceType: 'cloudflare',
      configJson: { deliveryMode, workerVersion: '1.0.0' },
    })
    const r = await workerVersionCheck.run(ctxFor(h))
    expect(r.status).toBe('warn')
    expect(r.code).toBe('traffic.worker-version.waiting-for-first-event')
    expect(r.remediation).toContain('smoke-test request')
    expect(r.details).toMatchObject({
      sources: [{
        deliveryMode,
        expectedVersion: CURRENT_CLOUDFLARE_WORKER_VERSION,
        observedVersion: null,
        state: 'waiting-for-first-event',
      }],
    })
  })

  it.each(['direct-push', 'queue-pull'])(
    'warns and requests redeployment when a %s source still reports its persisted old version',
    async (deliveryMode) => {
      insertTrafficSource(h, {
        sourceType: 'cloudflare',
        configJson: { deliveryMode, workerVersion: '1.0.0' },
        lastWorkerVersion: '1.0.0',
      })
      const r = await workerVersionCheck.run(ctxFor(h))
      expect(r.status).toBe('warn')
      expect(r.code).toBe('traffic.worker-version.stale')
      expect(r.remediation).toContain('traffic connect cloudflare')
      expect(r.details).toMatchObject({
        sources: [{
          deliveryMode,
          expectedVersion: CURRENT_CLOUDFLARE_WORKER_VERSION,
          observedVersion: '1.0.0',
          state: 'stale',
        }],
      })
    },
  )

  it.each([
    ['legacy direct-push', { workerVersion: '1.0.0' }],
    ['queue-pull', { deliveryMode: 'queue-pull', workerVersion: '1.0.0' }],
  ])('reports current for a %s source running the current generated version', async (label, configJson) => {
    insertTrafficSource(h, {
      sourceType: 'cloudflare',
      configJson,
      lastWorkerVersion: CURRENT_CLOUDFLARE_WORKER_VERSION,
    })
    const r = await workerVersionCheck.run(ctxFor(h))
    expect(r.status).toBe('ok')
    expect(r.code).toBe('traffic.worker-version.current')
    expect(r.details).toMatchObject({
      sources: [{
        deliveryMode: label === 'queue-pull' ? 'queue-pull' : 'direct-push',
        expectedVersion: CURRENT_CLOUDFLARE_WORKER_VERSION,
        state: 'current',
      }],
    })
  })

  it('expects the page-view version when a source forwards page views', async () => {
    const pageViewVersion = `${CURRENT_CLOUDFLARE_WORKER_VERSION}+page-views`
    insertTrafficSource(h, {
      sourceType: 'cloudflare',
      configJson: { deliveryMode: 'direct-push', workerVersion: pageViewVersion, forwardPageViews: true },
      lastWorkerVersion: CURRENT_CLOUDFLARE_WORKER_VERSION,
    })
    const stale = await workerVersionCheck.run(ctxFor(h))
    expect(stale.code).toBe('traffic.worker-version.stale')
    expect(stale.details).toMatchObject({ sources: [{ expectedVersion: pageViewVersion, observedVersion: CURRENT_CLOUDFLARE_WORKER_VERSION, state: 'stale' }] })

    h.db.update(trafficSources).set({ lastWorkerVersion: pageViewVersion }).run()
    const current = await workerVersionCheck.run(ctxFor(h))
    expect(current.code).toBe('traffic.worker-version.current')
  })
})

describe('traffic.source.queue-backlog', () => {
  const queueConfig = { deliveryMode: 'queue-pull' }

  it('skips when no active Queue pull source is connected', async () => {
    insertTrafficSource(h, { sourceType: 'cloud-run', queueBacklogCount: 50 })
    insertTrafficSource(h, {
      sourceType: 'cloudflare',
      status: 'paused',
      configJson: queueConfig,
      queueBacklogCount: 50,
    })

    const result = await queueBacklogCheck.run(ctxFor(h))
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('traffic.queue-backlog.not-applicable')
  })

  it('skips before a Queue backlog has been observed', async () => {
    insertTrafficSource(h, {
      sourceType: 'cloudflare',
      configJson: queueConfig,
      queueBacklogCount: null,
    })

    const result = await queueBacklogCheck.run(ctxFor(h))
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('traffic.queue-backlog.not-observed')
  })

  it('reports ok when the observed Queue backlog is empty', async () => {
    insertTrafficSource(h, {
      sourceType: 'cloudflare',
      configJson: queueConfig,
      queueBacklogCount: 0,
      queueBacklogObservedAt: '2026-08-11T12:00:00.000Z',
    })

    const result = await queueBacklogCheck.run(ctxFor(h))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('traffic.queue-backlog.empty')
    expect(result.details).toMatchObject({
      sources: [{ queueBacklogCount: 0, queueBacklogObservedAt: '2026-08-11T12:00:00.000Z' }],
    })
  })

  it('reports a residual Queue backlog of up to 1,000 as normal inflow during a drain', async () => {
    insertTrafficSource(h, {
      sourceType: 'cloudflare',
      displayName: 'Production Queue',
      configJson: queueConfig,
      queueBacklogCount: 1000,
      queueBacklogObservedAt: '2026-08-11T12:00:00.000Z',
    })

    const result = await queueBacklogCheck.run(ctxFor(h))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('traffic.queue-backlog.within-drain-budget')
    expect(result.summary).toContain('1,000')
    expect(result.remediation).toContain('next scheduled sync drains')
  })

  /** A finished Queue sync run that recorded why it stopped. */
  function recordQueueSync(sourceId: string, stopReason: CloudflareQueueDrainStopReason, minutesAgo: number) {
    const at = new Date(Date.now() - minutesAgo * 60_000).toISOString()
    h.db.insert(runs).values({
      id: crypto.randomUUID(), projectId: h.project.id, kind: 'traffic-sync', status: 'completed', trigger: 'scheduled',
      sourceId, createdAt: at, startedAt: at, finishedAt: at,
      syncSummary: {
        type: 'cloudflare-queue', stopReason, pulls: 8, emptyPulls: 2, messagesPulled: 600, messagesAcknowledged: 600,
        poisonMessages: 0, skippedUnleasedMessages: 0, acceptedEvents: 600, duplicateEvents: 0,
        backlogAtFirstPull: 3600, backlogAtLastPull: 3100, elapsedMs: 11_000,
      },
    }).run()
  }

  function insertResidualQueue(): string {
    return insertTrafficSource(h, {
      sourceType: 'cloudflare',
      displayName: 'Production Queue',
      configJson: queueConfig,
      queueBacklogCount: 1250,
      queueBacklogObservedAt: '2026-08-11T12:00:00.000Z',
    })
  }

  it('warns and points to the stored stop reason when no sync recorded one', async () => {
    insertResidualQueue()

    const result = await queueBacklogCheck.run(ctxFor(h))
    expect(result.status).toBe('warn')
    expect(result.code).toBe('traffic.queue-backlog.remaining')
    expect(result.summary).toContain('1,250')
    expect(result.summary).toContain('stopped before the Queue was empty')
    expect(result.summary).not.toContain('time limit')
    expect(result.remediation).toContain('canonry runs <project> --kind traffic-sync')
    expect(result.remediation).toContain('CANONRY_CLOUDFLARE_QUEUE_SYNC_DEADLINE_MS')
    expect(result.details).toMatchObject({ sources: [{ lastStopReason: null }] })
  })

  it.each(['deadline', 'batch-cap'] as const)('blames the drain limit when the last sync stopped at %s', async (stopReason) => {
    const sourceId = insertResidualQueue()
    recordQueueSync(sourceId, 'empty-pulls', 20)
    recordQueueSync(sourceId, stopReason, 10)

    const result = await queueBacklogCheck.run(ctxFor(h))
    expect(result.status).toBe('warn')
    expect(result.summary).toContain('stopped at its time limit or pull cap')
    expect(result.remediation).toContain('Shorten the traffic-sync schedule interval')
    expect(result.remediation).toContain('CANONRY_CLOUDFLARE_QUEUE_SYNC_DEADLINE_MS')
    expect(result.details).toMatchObject({ sources: [{ lastStopReason: stopReason }] })
  })

  it.each(['empty-pulls', 'unleased-only'] as const)('says the rest was not visible when the last sync stopped on %s', async (stopReason) => {
    const sourceId = insertResidualQueue()
    recordQueueSync(sourceId, 'deadline', 20)
    recordQueueSync(sourceId, stopReason, 10)

    const result = await queueBacklogCheck.run(ctxFor(h))
    expect(result.status).toBe('warn')
    expect(result.summary).toContain('leased or not yet visible')
    expect(result.summary).not.toContain('time limit or pull cap')
    expect(result.remediation).toContain('Later syncs pull them as they become visible')
    expect(result.remediation).not.toContain('CANONRY_CLOUDFLARE_QUEUE_SYNC_DEADLINE_MS')
  })

  it('points to the sync error when the last sync failed', async () => {
    const sourceId = insertResidualQueue()
    recordQueueSync(sourceId, 'error', 10)

    const result = await queueBacklogCheck.run(ctxFor(h))
    expect(result.summary).toContain('last sync failed')
    expect(result.remediation).toContain('Fix the sync error')
  })

  it('ignores stop reasons recorded for other sources', async () => {
    const sourceId = insertResidualQueue()
    const other = insertTrafficSource(h, { sourceType: 'cloudflare', status: 'paused', configJson: queueConfig })
    recordQueueSync(other, 'deadline', 5)
    recordQueueSync(sourceId, 'empty-pulls', 10)

    const result = await queueBacklogCheck.run(ctxFor(h))
    expect(result.summary).toContain('leased or not yet visible')
  })
})

describe('check definitions', () => {
  it('exports the checks at well-known IDs', () => {
    const ids = TRAFFIC_SOURCE_CHECKS.map((c) => c.id)
    expect(ids).toEqual([
      'traffic.source.connected',
      'traffic.source.recent-data',
      'traffic.source.sync-lag',
      'traffic.source.queue-backlog',
      'traffic.source.worker-version',
      'traffic.source.credentials',
      'traffic.source.scopes',
      'traffic.source.cache-blindspot',
    ])
  })

  it('all are project-scoped', () => {
    for (const c of TRAFFIC_SOURCE_CHECKS) expect(c.scope).toBe('project')
  })
})

// Suppress unused-warnings by referencing the type used in the validator factories.
export type _Suppress = TrafficSourceProbe extends infer T ? T : never
export type _CheckOutput = CheckOutput
