import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createClient, migrate, projects, runs } from '@ainyc/canonry-db'
import { GoogleApiError, GoogleAuthError } from '@ainyc/canonry-integration-google'
import type { CanonryConfig } from '../src/config.js'

const trackEvent = vi.hoisted(() => vi.fn())
const fetchSearchAnalyticsMock = vi.hoisted(() => vi.fn())
const inspectUrlMock = vi.hoisted(() => vi.fn())
const refreshAccessTokenMock = vi.hoisted(() => vi.fn())
const fetchAndParseSitemapMock = vi.hoisted(() => vi.fn())

vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry.js')>()),
  trackEvent,
}))
vi.mock('@ainyc/canonry-integration-google', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ainyc/canonry-integration-google')>()),
  fetchSearchAnalytics: fetchSearchAnalyticsMock,
  inspectUrl: inspectUrlMock,
  refreshAccessToken: refreshAccessTokenMock,
}))
vi.mock('../src/sitemap-parser.js', () => ({ fetchAndParseSitemap: fetchAndParseSitemapMock }))
// Instant pacing and a five-URL budget, so a sweep, its retries and an over-budget sitemap run in milliseconds.
vi.mock('../src/gsc-inspect-paced.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/gsc-inspect-paced.js')>()
  return {
    ...actual,
    INSPECT_SWEEP_MAX_URLS: 5,
    inspectUrlsPaced: ((urls, callbacks, deps) =>
      actual.inspectUrlsPaced(urls, callbacks, { ...deps, sleep: async () => {}, jitter: () => 0 })) as typeof actual.inspectUrlsPaced,
  }
})

const { executeGscSync } = await import('../src/gsc-sync.js')
const { executeInspectSitemap } = await import('../src/gsc-inspect-sitemap.js')

const DOMAIN = 'harborline.example.com'
const PROPERTY = 'sc-domain:harborline.example.com'
const NOW = '2026-10-09T12:00:00.000Z'

function setup(options: { trigger?: 'manual' | 'scheduled'; kind?: 'gsc-sync' | 'inspect-sitemap' } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-gsc-outcome-test-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: 'proj_gsc', name: 'harborline', displayName: 'Harborline', canonicalDomain: DOMAIN,
    country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'run_1', projectId: 'proj_gsc', kind: options.kind ?? 'gsc-sync', status: 'queued',
    trigger: options.trigger ?? 'manual', createdAt: NOW,
  }).run()
  return db
}

function config(connection: { propertyId?: string | null; tokenExpiresAt?: string } = {}): CanonryConfig {
  return {
    google: {
      clientId: 'cid',
      clientSecret: 'csec',
      connections: [{
        domain: DOMAIN,
        connectionType: 'gsc',
        accessToken: 'tok',
        refreshToken: 'rt',
        tokenExpiresAt: connection.tokenExpiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
        propertyId: connection.propertyId === undefined ? PROPERTY : connection.propertyId,
        scopes: [],
        createdAt: NOW,
        updatedAt: NOW,
      }],
    },
  } as unknown as CanonryConfig
}

function searchRow(page: string) {
  return { keys: ['harborline coatings', page, 'usa', 'DESKTOP', '2026-10-01'], clicks: 3, impressions: 40, ctr: 0.075, position: 4.2 }
}

function featureCompleted() {
  const calls = trackEvent.mock.calls.filter((call) => call[0] === 'feature.completed')
  expect(calls).toHaveLength(1)
  return calls[0]!.slice(1)
}

beforeEach(() => {
  trackEvent.mockReset()
  fetchSearchAnalyticsMock.mockReset()
  inspectUrlMock.mockReset()
  refreshAccessTokenMock.mockReset()
  fetchAndParseSitemapMock.mockReset()
})

describe('search_console sync outcome', () => {
  it('reports rows and distinct pages after the sync is saved', async () => {
    const db = setup()
    fetchSearchAnalyticsMock.mockImplementation(async (_token: string, _property: string, opts: { dimensions?: string[] }) =>
      opts.dimensions ? [] : [searchRow('https://harborline.example.com/'), searchRow('https://harborline.example.com/'), searchRow('https://harborline.example.com/decks')])

    await executeGscSync(db, 'run_1', 'proj_gsc', { config: config() })

    expect(featureCompleted()).toEqual([
      {
        feature: 'search_console', operation: 'sync', trigger: 'manual', status: 'succeeded',
        durationBucket: 'under_1s', counts: { rows: 3, urls: 2 },
      },
      undefined,
    ])
  })

  it('reports a property with no search data as skipped', async () => {
    const db = setup({ trigger: 'scheduled' })
    fetchSearchAnalyticsMock.mockResolvedValue([])

    await executeGscSync(db, 'run_1', 'proj_gsc', { config: config() })

    expect(featureCompleted()).toEqual([
      {
        feature: 'search_console', operation: 'sync', trigger: 'scheduled', surface: 'system', status: 'skipped',
        reasonCode: 'NO_DATA', durationBucket: 'under_1s', counts: { rows: 0, urls: 0 },
      },
      { errorCode: 'NO_DATA' },
    ])
  })

  it('reports an unselected property, a revoked grant and a refused property by reason', async () => {
    const cases: Array<{ config: CanonryConfig; arrange?: () => void; reasonCode: string; errorName: string }> = [
      { config: config({ propertyId: null }), reasonCode: 'PROPERTY_NOT_FOUND', errorName: 'Error' },
      {
        config: config({ tokenExpiresAt: '2026-01-01T00:00:00.000Z' }),
        arrange: () => refreshAccessTokenMock.mockRejectedValue(new GoogleAuthError('Token refresh failed (400): invalid_grant')),
        reasonCode: 'INVALID_CREDENTIALS',
        errorName: 'GoogleAuthError',
      },
      {
        config: config(),
        arrange: () => fetchSearchAnalyticsMock.mockRejectedValue(new GoogleApiError('GSC API error (403): no access', 403)),
        reasonCode: 'PERMISSION_MISSING',
        errorName: 'GoogleApiError',
      },
    ]
    for (const testCase of cases) {
      trackEvent.mockReset()
      const db = setup()
      testCase.arrange?.()
      await expect(executeGscSync(db, 'run_1', 'proj_gsc', { config: testCase.config })).rejects.toThrow()
      expect(featureCompleted()).toEqual([
        {
          feature: 'search_console', operation: 'sync', trigger: 'manual', status: 'failed',
          reasonCode: testCase.reasonCode, errorName: testCase.errorName, durationBucket: 'under_1s',
        },
        { errorCode: testCase.reasonCode },
      ])
    }
  })
})

describe('search_console inspect outcome', () => {
  const urls = (count: number) => Array.from({ length: count }, (_, i) => `https://harborline.example.com/p${i}`)
  const indexed = { inspectionResult: { indexStatusResult: { verdict: 'PASS', indexingState: 'INDEXING_ALLOWED' } } }

  it('reports every sitemap URL inspected', async () => {
    const db = setup({ kind: 'inspect-sitemap', trigger: 'scheduled' })
    fetchAndParseSitemapMock.mockResolvedValue(urls(3))
    inspectUrlMock.mockResolvedValue(indexed)

    await executeInspectSitemap(db, 'run_1', 'proj_gsc', { config: config() })

    expect(featureCompleted()).toEqual([
      {
        feature: 'search_console', operation: 'inspect', trigger: 'scheduled', surface: 'system', status: 'succeeded',
        durationBucket: 'under_1s', counts: { urls: 3, failures: 0, skipped: 0 },
      },
      undefined,
    ])
  })

  it('reports URLs Google refused as partial with the refusal class', async () => {
    const db = setup({ kind: 'inspect-sitemap' })
    fetchAndParseSitemapMock.mockResolvedValue(urls(3))
    inspectUrlMock.mockImplementation(async (_token: string, url: string) => {
      if (url.endsWith('/p1')) throw new GoogleApiError('GSC API error (400): invalid url', 400)
      return indexed
    })

    await executeInspectSitemap(db, 'run_1', 'proj_gsc', { config: config() })

    expect(featureCompleted()).toEqual([
      {
        feature: 'search_console', operation: 'inspect', trigger: 'manual', status: 'partial', reasonCode: 'HTTP_4XX',
        errorName: 'GoogleApiError', durationBucket: 'under_1s', counts: { urls: 2, failures: 1, skipped: 0 },
      },
      { errorCode: 'HTTP_4XX' },
    ])
  })

  it('reports a sitemap past the daily inspection budget as partial on quota', async () => {
    const db = setup({ kind: 'inspect-sitemap' })
    fetchAndParseSitemapMock.mockResolvedValue(urls(6))
    inspectUrlMock.mockResolvedValue(indexed)

    await executeInspectSitemap(db, 'run_1', 'proj_gsc', { config: config() })

    expect(featureCompleted()).toEqual([
      {
        feature: 'search_console', operation: 'inspect', trigger: 'manual', status: 'partial', reasonCode: 'QUOTA_EXCEEDED',
        durationBucket: 'under_1s', counts: { urls: 5, failures: 0, skipped: 1 },
      },
      { errorCode: 'QUOTA_EXCEEDED' },
    ])
  })

  it('reports a throttled sweep the breaker stopped by the throttle, not the wrapper error', async () => {
    const db = setup({ kind: 'inspect-sitemap' })
    fetchAndParseSitemapMock.mockResolvedValue(urls(5))
    inspectUrlMock.mockRejectedValue(new GoogleApiError('Google API rate limit exceeded', 429))

    await expect(executeInspectSitemap(db, 'run_1', 'proj_gsc', { config: config() })).rejects.toThrow(/aborted/)

    expect(featureCompleted()).toEqual([
      {
        feature: 'search_console', operation: 'inspect', trigger: 'manual', status: 'failed', reasonCode: 'RATE_LIMITED',
        errorName: 'GoogleApiError', durationBucket: 'under_1s',
      },
      { errorCode: 'RATE_LIMITED' },
    ])
  })

  it('reports an empty sitemap as skipped for lack of data', async () => {
    const db = setup({ kind: 'inspect-sitemap' })
    fetchAndParseSitemapMock.mockResolvedValue([])

    await expect(executeInspectSitemap(db, 'run_1', 'proj_gsc', { config: config() })).rejects.toThrow(/No URLs/)

    expect(featureCompleted()).toEqual([
      {
        feature: 'search_console', operation: 'inspect', trigger: 'manual', status: 'skipped', reasonCode: 'NO_DATA',
        errorName: 'Error', durationBucket: 'under_1s',
      },
      { errorCode: 'NO_DATA' },
    ])
  })
})
