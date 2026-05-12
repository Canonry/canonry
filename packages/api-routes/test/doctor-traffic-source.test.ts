import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {
  createClient,
  migrate,
  projects,
  trafficSources,
  crawlerEventsHourly,
  aiReferralEventsHourly,
} from '@ainyc/canonry-db'
import { TRAFFIC_SOURCE_CHECKS } from '../src/doctor/checks/traffic-source.js'
import type { CheckOutput, DoctorContext, ProjectInfo, TrafficSourceProbe, TrafficSourceValidator } from '../src/doctor/types.js'

const [
  sourceConnectedCheck,
  recentDataCheck,
  credentialsCheck,
  scopesCheck,
] = TRAFFIC_SOURCE_CHECKS

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
    queries: '[]',
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
    lastEventIds: null,
    archivedAt: args.status === 'archived' ? now : null,
    configJson: '{}',
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

  it('fails when source connected but never produced any data', async () => {
    insertTrafficSource(h)
    const r = await recentDataCheck.run(ctxFor(h))
    expect(r.status).toBe('fail')
    expect(r.code).toBe('traffic.recent-data.empty')
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

describe('check definitions', () => {
  it('exports four checks at well-known IDs', () => {
    const ids = TRAFFIC_SOURCE_CHECKS.map((c) => c.id)
    expect(ids).toEqual([
      'traffic.source.connected',
      'traffic.source.recent-data',
      'traffic.source.credentials',
      'traffic.source.scopes',
    ])
  })

  it('all are project-scoped', () => {
    for (const c of TRAFFIC_SOURCE_CHECKS) expect(c.scope).toBe('project')
  })
})

// Suppress unused-warnings by referencing the type used in the validator factories.
export type _Suppress = TrafficSourceProbe extends infer T ? T : never
export type _CheckOutput = CheckOutput
