import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunKinds, RunStatuses, RunTriggers } from '@canonry/canonry-contracts'
import {
  bingCrawlStats,
  bingKeywordDemand,
  bingPageStats,
  bingQueryStats,
  bingSiteSnapshots,
  bingSitemaps,
  sitemapListSyncs,
  bingTrafficDaily,
  createClient,
  migrate,
  projects,
  queries,
  runs,
} from '@canonry/canonry-db'
import { BingApiError, __resetBingThrottleCooldownForTest } from '@canonry/canonry-integration-bing'
import { BING_KEYWORD_DEMAND_MAX_PER_SYNC, executeBingSync } from '../src/bing-sync.js'
import type { CanonryConfig } from '../src/config.js'

const trackEvent = vi.hoisted(() => vi.fn())
vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry.js')>()),
  trackEvent,
}))

// The integration package's fixtures are captured live Bing responses
// (anonymised), so the sync is exercised against Bing's real field names.
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../integration-bing/test/fixtures')
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

const DOMAIN = 'harborline-coatings.example.com'
const instantSleep = async (): Promise<void> => {}

function buildConfig(siteUrl: string | null = `https://${DOMAIN}/`): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: '/tmp/test.db',
    apiKey: 'cnry_test',
    bing: {
      connections: [{ domain: DOMAIN, apiKey: 'bing-sync-test-key', siteUrl, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
    },
  }
}

type Responder = (method: string, url: URL) => { status: number; body: string } | undefined

/** Serves each Bing method from its fixture; `override` replaces individual methods. */
function mockBing(override: Responder = () => undefined): string[] {
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    const method = url.pathname.split('/').pop()!
    calls.push(method)
    const custom = override(method, url)
    if (custom) return new Response(custom.body, { status: custom.status })
    if (method === 'GetConnectedPages' || method === 'GetSiteRoles') {
      return new Response(fixture(`${method}.error.json`), { status: 400 })
    }
    return new Response(fixture(`${method}.json`), { status: 200 })
  }) as typeof globalThis.fetch
  return calls
}

describe('executeBingSync', () => {
  let tmpDir: string
  let db: ReturnType<typeof createClient>
  let projectId: string
  let originalFetch: typeof globalThis.fetch

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bing-sync-test-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    projectId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: projectId,
      name: 'harborline-coatings',
      displayName: 'Harborline Coatings',
      canonicalDomain: DOMAIN,
      ownedDomains: '[]',
      country: 'US',
      language: 'en',
      tags: '[]',
      labels: '{}',
      providers: '[]',
      locations: '[]',
      defaultLocation: null,
      configSource: 'cli',
      configRevision: 1,
      createdAt: now,
      updatedAt: now,
    }).run()
    db.insert(queries).values([
      { id: crypto.randomUUID(), projectId, query: 'garage floor coating', createdAt: now },
      { id: crypto.randomUUID(), projectId, query: 'epoxy contractor near me', createdAt: now },
    ]).run()
  })

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    originalFetch = globalThis.fetch
    __resetBingThrottleCooldownForTest()
    for (const table of [bingTrafficDaily, bingQueryStats, bingPageStats, bingCrawlStats, bingSitemaps, sitemapListSyncs, bingSiteSnapshots, bingKeywordDemand, runs]) {
      db.delete(table).run()
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function queueRun(): string {
    const runId = crypto.randomUUID()
    db.insert(runs).values({ id: runId, projectId, kind: RunKinds['bing-sync'], status: RunStatuses.queued, trigger: RunTriggers.manual, createdAt: new Date().toISOString() }).run()
    return runId
  }

  function run(runId: string) {
    return db.select().from(runs).where(eq(runs.id, runId)).get()!
  }

  it('stores every section from the real response shapes and completes', async () => {
    mockBing()
    const runId = queueRun()
    await executeBingSync(db, runId, projectId, { config: buildConfig(), sleep: instantSleep })

    expect(run(runId)).toMatchObject({ status: RunStatuses.completed, error: null })

    const traffic = db.select().from(bingTrafficDaily).where(eq(bingTrafficDaily.projectId, projectId)).all()
    expect(traffic).toHaveLength(4)
    expect(traffic.find((row) => row.date === '2026-05-13')).toMatchObject({ clicks: 0, impressions: 1, syncRunId: runId })

    const queryRows = db.select().from(bingQueryStats).where(eq(bingQueryStats.projectId, projectId)).all()
    expect(queryRows).toHaveLength(3)
    // Bing sends AvgClickPosition -1 even on rows with clicks; it is stored as "no value".
    expect(queryRows.find((row) => row.query === 'example query 1')).toMatchObject({
      date: '2026-08-14', clicks: 71, impressions: 358, avgClickPosition: null, avgImpressionPosition: 5,
    })

    const pageRows = db.select().from(bingPageStats).where(eq(bingPageStats.projectId, projectId)).all()
    expect(pageRows.map((row) => row.page).sort()).toEqual(['https://example.com/', 'https://example.com/page-2/', 'https://example.com/page-3/'])

    const crawl = db.select().from(bingCrawlStats).where(eq(bingCrawlStats.projectId, projectId)).all()
    expect(crawl).toHaveLength(3)
    expect(crawl[0]).toMatchObject({ crawledPages: expect.any(Number), code2xx: expect.any(Number), inLinks: expect.any(Number) })

    const sitemaps = db.select().from(bingSitemaps).where(eq(bingSitemaps.projectId, projectId)).all()
    expect(sitemaps.map((row) => row.url)).toContain('https://example.com/sitemap_index.xml')
    expect(sitemaps.find((row) => row.url === 'https://example.com/sitemap_index.xml')).toMatchObject({
      type: 'Sitemap Index', status: 'Success', urlCount: 32, parentUrl: null, submittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })
    // The list counts as read, so an empty one would mean "Bing has none".
    expect(db.select().from(sitemapListSyncs).where(eq(sitemapListSyncs.projectId, projectId)).all()).toMatchObject([{ engine: 'bing', syncRunId: runId }])

    const snapshots = new Map(db.select().from(bingSiteSnapshots).where(eq(bingSiteSnapshots.projectId, projectId)).all().map((row) => [row.kind, row]))
    expect(snapshots.size).toBe(12)
    expect(snapshots.get('url-submission-quota')).toMatchObject({ status: 'ok', payload: { dailyQuota: 100, monthlyQuota: 2700 } })
    expect(snapshots.get('crawl-settings')?.payload).toMatchObject({ crawlBoostEnabled: false, crawlRate: expect.any(Array) })
    expect(snapshots.get('blocked-urls')).toMatchObject({ status: 'ok', payload: [] })
    // Owner-only reads with a delegated key are recorded, not failed.
    expect(snapshots.get('site-roles')).toMatchObject({ status: 'unauthorized', payload: null })
    expect(snapshots.get('connected-pages')).toMatchObject({ status: 'unauthorized' })

    const demand = db.select().from(bingKeywordDemand).where(eq(bingKeywordDemand.projectId, projectId)).all()
    expect(new Set(demand.map((row) => row.query))).toEqual(new Set(['garage floor coating', 'epoxy contractor near me']))
    expect(demand.every((row) => row.country === 'us' && row.language === 'en-US')).toBe(true)
    expect(demand.filter((row) => row.query === 'garage floor coating')).toHaveLength(3)
  })

  it('upserts on a re-sync and drops a sitemap Bing stopped listing', async () => {
    mockBing()
    await executeBingSync(db, queueRun(), projectId, { config: buildConfig(), sleep: instantSleep })
    const before = db.select().from(bingSitemaps).where(eq(bingSitemaps.projectId, projectId)).all().length

    const onlyIndex = JSON.stringify({ d: [JSON.parse(fixture('GetFeeds.json')).d[0]] })
    mockBing((method) => {
      if (method === 'GetFeeds') return { status: 200, body: onlyIndex }
      if (method === 'GetFeedDetails') return { status: 200, body: onlyIndex }
      return undefined
    })
    const second = queueRun()
    await executeBingSync(db, second, projectId, { config: buildConfig(), sleep: instantSleep })

    expect(db.select().from(bingTrafficDaily).where(eq(bingTrafficDaily.projectId, projectId)).all()).toHaveLength(4)
    expect(db.select().from(bingQueryStats).where(eq(bingQueryStats.projectId, projectId)).all()).toHaveLength(3)
    const after = db.select().from(bingSitemaps).where(eq(bingSitemaps.projectId, projectId)).all()
    expect(before).toBeGreaterThan(1)
    expect(after.map((row) => row.url)).toEqual(['https://example.com/sitemap_index.xml'])
    expect(after[0]!.syncRunId).toBe(second)
  })

  it('marks the run partial when one section fails and keeps the rest', async () => {
    mockBing((method) => (method === 'GetCrawlStats'
      ? { status: 400, body: '{"ErrorCode":2,"Message":"ERROR!!! InvalidParameter"}' }
      : undefined))
    const runId = queueRun()
    await executeBingSync(db, runId, projectId, { config: buildConfig(), sleep: instantSleep })

    expect(run(runId).status).toBe(RunStatuses.partial)
    expect(run(runId).error).toMatch(/crawl-stats/)
    expect(db.select().from(bingTrafficDaily).where(eq(bingTrafficDaily.projectId, projectId)).all()).toHaveLength(4)
    expect(db.select().from(bingCrawlStats).where(eq(bingCrawlStats.projectId, projectId)).all()).toHaveLength(0)
  })

  it('keeps the last good site setting when a later read fails', async () => {
    mockBing()
    await executeBingSync(db, queueRun(), projectId, { config: buildConfig(), sleep: instantSleep })
    mockBing((method) => (method === 'GetUrlSubmissionQuota'
      ? { status: 400, body: '{"ErrorCode":2,"Message":"ERROR!!! InvalidParameter"}' }
      : undefined))
    await executeBingSync(db, queueRun(), projectId, { config: buildConfig(), sleep: instantSleep })

    const quota = db.select().from(bingSiteSnapshots).where(eq(bingSiteSnapshots.kind, 'url-submission-quota')).get()
    expect(quota).toMatchObject({ status: 'failed', payload: { dailyQuota: 100, monthlyQuota: 2700 } })
    expect(quota?.error).toMatch(/InvalidParameter/)
  })

  it('stops calling Bing for the rest of the run once the account is throttled', async () => {
    // A throttle that outlasted the client's retries surfaces as a throttle
    // BingApiError; stub the first read so the test does not wait out real backoff.
    const bingModule = await import('@canonry/canonry-integration-bing')
    const spy = vi.spyOn(bingModule, 'getRankAndTrafficStats').mockRejectedValue(new BingApiError('Bing API rate limit exceeded', 429))
    const calls = mockBing()
    const runId = queueRun()
    try {
      await executeBingSync(db, runId, projectId, { config: buildConfig(), sleep: instantSleep })
    } finally {
      spy.mockRestore()
    }

    // No later section reached Bing.
    expect(calls).toEqual([])
    expect(run(runId).status).toBe(RunStatuses.failed)
    expect(run(runId).error).toMatch(/throttled/i)
  })

  it('refreshes keyword demand only for queries not read in the last week', async () => {
    const now = new Date('2026-11-04T12:00:00Z')
    db.insert(bingKeywordDemand).values({
      id: crypto.randomUUID(), projectId, query: 'garage floor coating', country: 'us', language: 'en-US',
      date: '2026-10-25', impressions: 10, broadImpressions: 20, syncRunId: null, syncedAt: '2026-11-01T00:00:00Z',
    }).run()
    const asked: string[] = []
    mockBing((method, url) => {
      if (method === 'GetKeywordStats') asked.push(url.searchParams.get('q') ?? '')
      return undefined
    })
    await executeBingSync(db, queueRun(), projectId, { config: buildConfig(), sleep: instantSleep, now: () => now })
    expect(asked).toEqual(['epoxy contractor near me'])
    expect(BING_KEYWORD_DEMAND_MAX_PER_SYNC).toBeGreaterThan(0)
  })

  it('fails the run with the setup step when no site is selected', async () => {
    const calls = mockBing()
    const runId = queueRun()
    await expect(executeBingSync(db, runId, projectId, { config: buildConfig(null), sleep: instantSleep })).rejects.toThrow(/set-site/)
    expect(run(runId)).toMatchObject({ status: RunStatuses.failed })
    expect(calls).toHaveLength(0)
  })
})
