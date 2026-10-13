import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
import { bingCoverageSnapshots, bingUrlInspections, createClient, migrate, projects, runs } from '@ainyc/canonry-db'
import { BingApiError } from '@ainyc/canonry-integration-bing'
import { executeBingInspectSitemap } from '../src/bing-inspect-sitemap.js'
import type { CanonryConfig } from '../src/config.js'

const trackEvent = vi.hoisted(() => vi.fn())
vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry.js')>()),
  trackEvent,
}))

function startSitemapServer(routes: Record<string, string | undefined>): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = routes[req.url ?? '/']
      if (body == null) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/xml' })
      res.end(body)
    })
    server.listen(0, () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` })
    })
  })
}

function buildConfig(domain: string): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: '/tmp/test.db',
    apiKey: 'cnry_test',
    bing: {
      connections: [
        {
          domain,
          apiKey: 'bing-test-key',
          siteUrl: `https://${domain}/`,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    },
  }
}

describe('executeBingInspectSitemap', () => {
  let tmpDir: string
  let db: ReturnType<typeof createClient>
  let projectId: string
  let server: http.Server | null = null

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bing-inspect-sitemap-test-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)

    projectId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: projectId,
      name: 'harborline-coatings',
      displayName: 'Harborline Coatings',
      canonicalDomain: 'harborline-coatings.example.com',
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
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    db.delete(bingUrlInspections).run()
    db.delete(bingCoverageSnapshots).run()
    db.delete(runs).run()

    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getCrawlIssues').mockResolvedValue([])
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
    vi.restoreAllMocks()
  })

  async function queueRun(): Promise<string> {
    const runId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(runs).values({
      id: runId,
      projectId,
      kind: RunKinds['bing-inspect-sitemap'],
      status: RunStatuses.queued,
      trigger: RunTriggers.manual,
      createdAt: now,
    }).run()
    return runId
  }

  it('discovers sitemap URLs missing from the tracked set, inspects each, and writes a coverage snapshot', async () => {
    // Seed: only 2 of the 4 sitemap URLs are tracked (issue #352 scenario —
    // newer sitemap URLs were silently absent from Bing tracking).
    const seededAt = '2026-04-20T10:00:00Z'
    db.insert(bingUrlInspections).values([
      {
        id: crypto.randomUUID(), projectId,
        url: 'https://harborline-coatings.example.com/',
        httpCode: 200, inIndex: true,
        lastCrawledDate: '2026-04-19T10:00:00Z', inIndexDate: null,
        inspectedAt: seededAt, syncRunId: null, createdAt: seededAt,
        documentSize: 5000, anchorCount: null, discoveryDate: null,
      },
      {
        id: crypto.randomUUID(), projectId,
        url: 'https://harborline-coatings.example.com/about/',
        httpCode: 200, inIndex: true,
        lastCrawledDate: '2026-04-19T10:00:00Z', inIndexDate: null,
        inspectedAt: seededAt, syncRunId: null, createdAt: seededAt,
        documentSize: 3000, anchorCount: null, discoveryDate: null,
      },
    ]).run()

    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://harborline-coatings.example.com/</loc></url>
  <url><loc>https://harborline-coatings.example.com/about/</loc></url>
  <url><loc>https://harborline-coatings.example.com/michigan/</loc></url>
  <url><loc>https://harborline-coatings.example.com/southeast-florida/</loc></url>
</urlset>`
    const s = await startSitemapServer({ '/sitemap.xml': sitemapXml })
    server = s.server

    const bingModule = await import('@ainyc/canonry-integration-bing')
    const lastCrawledMs = new Date('2026-04-25T10:00:00Z').getTime()
    vi.spyOn(bingModule, 'getUrlInfo').mockImplementation(async (_apiKey, _site, url) => ({
      Url: url,
      HttpStatus: 200,
      DocumentSize: 4096,
      LastCrawledDate: `/Date(${lastCrawledMs})/`,
    }))

    const runId = await queueRun()
    await executeBingInspectSitemap(db, runId, projectId, {
      sitemapUrl: `${s.baseUrl}/sitemap.xml`,
      config: buildConfig('harborline-coatings.example.com'),
      // Instant pacing — the sweep now runs through inspectUrlsPaced, whose
      // real ~1s spacing plus retry backoff outruns the default timeout.
      pacedDeps: { sleep: async () => {}, jitter: () => 0 },
    })

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe(RunStatuses.completed)
    expect(run?.startedAt).toBeTruthy()
    expect(run?.finishedAt).toBeTruthy()

    // 4 fresh inspections from this run on top of the 2 seed rows
    const newInspections = db.select().from(bingUrlInspections)
      .where(eq(bingUrlInspections.syncRunId, runId)).all()
    expect(newInspections).toHaveLength(4)
    const newUrls = newInspections.map((r) => r.url).sort()
    expect(newUrls).toEqual([
      'https://harborline-coatings.example.com/',
      'https://harborline-coatings.example.com/about/',
      'https://harborline-coatings.example.com/michigan/',
      'https://harborline-coatings.example.com/southeast-florida/',
    ])
    // Newly discovered URLs are now tracked + indexed
    for (const row of newInspections) {
      expect(row.inIndex).toBe(true)
    }

    // Coverage snapshot covers the full discovered set, not just the originally
    // tracked subset — this is the bug fix.
    const snapshots = db.select().from(bingCoverageSnapshots)
      .where(eq(bingCoverageSnapshots.projectId, projectId)).all()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.indexed).toBe(4)
    expect(snapshots[0]!.notIndexed).toBe(0)
    expect(snapshots[0]!.unknown).toBe(0)
    expect(snapshots[0]!.syncRunId).toBe(runId)
  })

  it('marks the run partial when some URLs fail to inspect', async () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://harborline-coatings.example.com/ok</loc></url>
  <url><loc>https://harborline-coatings.example.com/fail</loc></url>
</urlset>`
    const s = await startSitemapServer({ '/sitemap.xml': sitemapXml })
    server = s.server

    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getUrlInfo').mockImplementation(async (_apiKey, _site, url) => {
      if (url.endsWith('/fail')) throw new Error('Bing API error')
      return { Url: url, HttpStatus: 200, DocumentSize: 1000 }
    })

    const runId = await queueRun()
    await executeBingInspectSitemap(db, runId, projectId, {
      sitemapUrl: `${s.baseUrl}/sitemap.xml`,
      config: buildConfig('harborline-coatings.example.com'),
      // Instant pacing — the sweep now runs through inspectUrlsPaced, whose
      // real ~1s spacing plus retry backoff outruns the default timeout.
      pacedDeps: { sleep: async () => {}, jitter: () => 0 },
    })

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe(RunStatuses.partial)

    const inspections = db.select().from(bingUrlInspections)
      .where(eq(bingUrlInspections.syncRunId, runId)).all()
    expect(inspections).toHaveLength(1)
    expect(inspections[0]!.url).toBe('https://harborline-coatings.example.com/ok')
  })

  /**
   * A sweep that measured NOTHING must not look like a successful one.
   *
   * On 2026-08-06 a throttled sweep inspected 0 of 45 URLs, tripped the
   * circuit breaker after 5 consecutive failures, and was recorded `partial`
   * with a NULL error — because the status test compared `errors` (capped at 5
   * by the breaker) against the whole 45-URL sitemap. It then rewrote the
   * coverage snapshot from months-old stored inspections with a fresh
   * `created_at`, so the dashboard showed freshly-dated coverage that no
   * request had contributed to. Nothing in the product could tell that apart
   * from a healthy refresh.
   */
  it('fails the run and leaves coverage untouched when every URL is throttled', async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `  <url><loc>https://harborline-coatings.example.com/p${i}</loc></url>`).join('\n')
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${urls}\n</urlset>`
    const s = await startSitemapServer({ '/sitemap.xml': sitemapXml })
    server = s.server

    // A pre-existing snapshot standing in for "what the dashboard shows now".
    const earlierRunId = await queueRun()
    const staleDate = new Date().toISOString().split('T')[0]!
    db.insert(bingCoverageSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      syncRunId: earlierRunId,
      date: staleDate,
      indexed: 65,
      notIndexed: 0,
      unknown: 12,
      createdAt: '2026-08-01T00:00:00.000Z',
    }).run()

    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getUrlInfo').mockImplementation(async () => {
      throw Object.assign(new Error('Bing API error (400): {"ErrorCode":4,"Message":"ERROR!!! ThrottleUser"}'), {
        status: 429,
      })
    })

    const runId = await queueRun()
    await expect(
      executeBingInspectSitemap(db, runId, projectId, {
        sitemapUrl: `${s.baseUrl}/sitemap.xml`,
        config: buildConfig('harborline-coatings.example.com'),
        pacedDeps: { sleep: async () => {}, jitter: () => 0 },
      }),
    ).rejects.toThrow(/failed for every URL/i)

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe(RunStatuses.failed)
    // The reason has to be legible; a NULL error is what hid this for a day.
    expect(run?.error).toBeTruthy()

    // The stale snapshot must be exactly as it was — not re-dated.
    const snap = db.select().from(bingCoverageSnapshots)
      .where(eq(bingCoverageSnapshots.projectId, projectId)).all()
    expect(snap).toHaveLength(1)
    expect(snap[0]!.createdAt).toBe('2026-08-01T00:00:00.000Z')
    expect(snap[0]!.syncRunId).toBe(earlierRunId)
  })

  it('records WHY a degraded run was degraded', async () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://harborline-coatings.example.com/ok</loc></url>
  <url><loc>https://harborline-coatings.example.com/fail</loc></url>
</urlset>`
    const s = await startSitemapServer({ '/sitemap.xml': sitemapXml })
    server = s.server

    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getUrlInfo').mockImplementation(async (_apiKey, _site, url) => {
      if (url.endsWith('/fail')) throw new Error('Bing API error')
      return { Url: url, HttpStatus: 200, DocumentSize: 1000 }
    })

    const runId = await queueRun()
    await executeBingInspectSitemap(db, runId, projectId, {
      sitemapUrl: `${s.baseUrl}/sitemap.xml`,
      config: buildConfig('harborline-coatings.example.com'),
      pacedDeps: { sleep: async () => {}, jitter: () => 0 },
    })

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe(RunStatuses.partial)
    expect(run?.error).toMatch(/1 of 2/)
  })

  it('marks the run failed when sitemap is empty', async () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`
    const s = await startSitemapServer({ '/sitemap.xml': sitemapXml })
    server = s.server

    const runId = await queueRun()
    await expect(() => executeBingInspectSitemap(db, runId, projectId, {
      sitemapUrl: `${s.baseUrl}/sitemap.xml`,
      config: buildConfig('harborline-coatings.example.com'),
      // Instant pacing — the sweep now runs through inspectUrlsPaced, whose
      // real ~1s spacing plus retry backoff outruns the default timeout.
      pacedDeps: { sleep: async () => {}, jitter: () => 0 },
    })).rejects.toThrow('No URLs found in sitemap')

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe(RunStatuses.failed)
    expect(run?.error).toContain('No URLs found in sitemap')
  })

  it('marks the run failed when no Bing connection exists for the project', async () => {
    const runId = await queueRun()
    await expect(() => executeBingInspectSitemap(db, runId, projectId, {
      sitemapUrl: 'https://harborline-coatings.example.com/sitemap.xml',
      config: { apiUrl: 'http://localhost:4100', database: '/tmp/x', apiKey: 'cnry_test' },
      // Instant pacing: the sweep now goes through inspectUrlsPaced, whose
      // real ~1s spacing plus retry backoff would otherwise outrun the
      // default test timeout on a fixture with a failing URL.
      pacedDeps: { sleep: async () => {}, jitter: () => 0 },
    })).rejects.toThrow('No Bing connection')

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe(RunStatuses.failed)
  })

  it('marks the run failed when the Bing connection has no siteUrl', async () => {
    const runId = await queueRun()
    const noSite: CanonryConfig = {
      apiUrl: 'http://localhost:4100', database: '/tmp/x', apiKey: 'cnry_test',
      bing: { connections: [{
        domain: 'harborline-coatings.example.com', apiKey: 'k', siteUrl: null,
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      }] },
    }
    await expect(() => executeBingInspectSitemap(db, runId, projectId, {
      sitemapUrl: 'https://harborline-coatings.example.com/sitemap.xml',
      config: noSite,
    })).rejects.toThrow('No Bing site configured')

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe(RunStatuses.failed)
  })

  it('downgrades indexed URLs that GetCrawlIssues flags with a blocking issue', async () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://harborline-coatings.example.com/blocked</loc></url>
  <url><loc>https://harborline-coatings.example.com/ok</loc></url>
</urlset>`
    const s = await startSitemapServer({ '/sitemap.xml': sitemapXml })
    server = s.server

    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getUrlInfo').mockImplementation(async (_apiKey, _site, url) => ({
      Url: url, HttpStatus: 200, DocumentSize: 1234,
    }))
    vi.spyOn(bingModule, 'getCrawlIssues').mockResolvedValue([
      { Url: 'https://harborline-coatings.example.com/blocked', HttpCode: 403, Date: '2026-04-25', IssueType: 'BlockedByRobotsTxt' },
    ])

    const runId = await queueRun()
    await executeBingInspectSitemap(db, runId, projectId, {
      sitemapUrl: `${s.baseUrl}/sitemap.xml`,
      config: buildConfig('harborline-coatings.example.com'),
      // Instant pacing — the sweep now runs through inspectUrlsPaced, whose
      // real ~1s spacing plus retry backoff outruns the default timeout.
      pacedDeps: { sleep: async () => {}, jitter: () => 0 },
    })

    const inspections = db.select().from(bingUrlInspections)
      .where(eq(bingUrlInspections.syncRunId, runId)).all()
    const blocked = inspections.find((r) => r.url.endsWith('/blocked'))
    const ok = inspections.find((r) => r.url.endsWith('/ok'))
    expect(blocked?.inIndex).toBe(false)
    expect(ok?.inIndex).toBe(true)
  })

  describe('outcome telemetry', () => {
    const instant = { sleep: async () => {}, jitter: () => 0 }
    const sitemapOf = (count: number) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${
      Array.from({ length: count }, (_, i) => `  <url><loc>https://harborline-coatings.example.com/p${i}</loc></url>`).join('\n')
    }\n</urlset>`
    const throttled = () => new BingApiError('Bing API error (400): {"ErrorCode":5,"Message":"ERROR!!! ThrottleHost"}', 400, 5)

    function featureCompleted() {
      const calls = trackEvent.mock.calls.filter((call) => call[0] === 'feature.completed')
      expect(calls).toHaveLength(1)
      return calls[0]!.slice(1)
    }

    beforeEach(() => trackEvent.mockReset())

    it('reports the coverage sweep as the bing sync, with URL counts, after it is saved', async () => {
      const s = await startSitemapServer({ '/sitemap.xml': sitemapOf(2) })
      server = s.server
      const bingModule = await import('@ainyc/canonry-integration-bing')
      vi.spyOn(bingModule, 'getUrlInfo').mockImplementation(async (_apiKey, _site, url) => ({ Url: url, HttpStatus: 200, DocumentSize: 1000 }))

      const runId = await queueRun()
      await executeBingInspectSitemap(db, runId, projectId, {
        sitemapUrl: `${s.baseUrl}/sitemap.xml`, config: buildConfig('harborline-coatings.example.com'), pacedDeps: instant,
      })

      expect(featureCompleted()).toEqual([
        {
          feature: 'bing', operation: 'sync', trigger: 'manual', status: 'succeeded',
          durationBucket: 'under_1s', counts: { urls: 2, failures: 0, skipped: 0 },
        },
        undefined,
      ])
    })

    it('reports a URL Bing throttled as partial on rate limit, not as a client error', async () => {
      const s = await startSitemapServer({ '/sitemap.xml': sitemapOf(2) })
      server = s.server
      const bingModule = await import('@ainyc/canonry-integration-bing')
      vi.spyOn(bingModule, 'getUrlInfo').mockImplementation(async (_apiKey, _site, url) => {
        if (url.endsWith('/p1')) throw throttled()
        return { Url: url, HttpStatus: 200, DocumentSize: 1000 }
      })

      const runId = await queueRun()
      await executeBingInspectSitemap(db, runId, projectId, {
        sitemapUrl: `${s.baseUrl}/sitemap.xml`, config: buildConfig('harborline-coatings.example.com'), pacedDeps: instant,
      })

      expect(featureCompleted()).toEqual([
        {
          feature: 'bing', operation: 'sync', trigger: 'manual', status: 'partial', reasonCode: 'RATE_LIMITED',
          errorName: 'BingApiError', durationBucket: 'under_1s', counts: { urls: 1, failures: 1, skipped: 0 },
        },
        { errorCode: 'RATE_LIMITED' },
      ])
    })

    it('reports a sweep that inspected nothing by the throttle behind it', async () => {
      const s = await startSitemapServer({ '/sitemap.xml': sitemapOf(6) })
      server = s.server
      const bingModule = await import('@ainyc/canonry-integration-bing')
      vi.spyOn(bingModule, 'getUrlInfo').mockImplementation(async () => { throw throttled() })

      const runId = await queueRun()
      await expect(executeBingInspectSitemap(db, runId, projectId, {
        sitemapUrl: `${s.baseUrl}/sitemap.xml`, config: buildConfig('harborline-coatings.example.com'), pacedDeps: instant,
      })).rejects.toThrow(/failed for every URL/i)

      expect(featureCompleted()).toEqual([
        {
          feature: 'bing', operation: 'sync', trigger: 'manual', status: 'failed', reasonCode: 'RATE_LIMITED',
          errorName: 'BingApiError', durationBucket: 'under_1s',
        },
        { errorCode: 'RATE_LIMITED' },
      ])
    })

    it('reports a missing connection and a missing site by reason', async () => {
      const noConnection = await queueRun()
      await expect(executeBingInspectSitemap(db, noConnection, projectId, {
        config: { apiUrl: 'http://localhost:4100', database: '/tmp/x', apiKey: 'cnry_test' }, pacedDeps: instant,
      })).rejects.toThrow('No Bing connection')
      const noSite = await queueRun()
      await expect(executeBingInspectSitemap(db, noSite, projectId, {
        config: {
          apiUrl: 'http://localhost:4100', database: '/tmp/x', apiKey: 'cnry_test',
          bing: { connections: [{
            domain: 'harborline-coatings.example.com', apiKey: 'k', siteUrl: null,
            createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
          }] },
        },
        pacedDeps: instant,
      })).rejects.toThrow('No Bing site configured')

      expect(trackEvent.mock.calls.map((call) => call.slice(1))).toEqual([
        [
          { feature: 'bing', operation: 'sync', trigger: 'manual', status: 'failed', reasonCode: 'NOT_CONNECTED', errorName: 'Error', durationBucket: 'under_1s' },
          { errorCode: 'NOT_CONNECTED' },
        ],
        [
          { feature: 'bing', operation: 'sync', trigger: 'manual', status: 'failed', reasonCode: 'PROPERTY_NOT_FOUND', errorName: 'Error', durationBucket: 'under_1s' },
          { errorCode: 'PROPERTY_NOT_FOUND' },
        ],
      ])
    })
  })
})
