import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
import { bingCoverageSnapshots, bingUrlInspections, createClient, migrate, projects, runs } from '@ainyc/canonry-db'
import { executeBingInspectSitemap } from '../src/bing-inspect-sitemap.js'
import type { CanonryConfig } from '../src/config.js'

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
      resolve({ server, baseUrl: `http://localhost:${port}` })
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
      name: 'azcoatings',
      displayName: 'AZ Coatings',
      canonicalDomain: 'azcoatingsllc.com',
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
        url: 'https://azcoatingsllc.com/',
        httpCode: 200, inIndex: 1,
        lastCrawledDate: '2026-04-19T10:00:00Z', inIndexDate: null,
        inspectedAt: seededAt, syncRunId: null, createdAt: seededAt,
        documentSize: 5000, anchorCount: null, discoveryDate: null,
      },
      {
        id: crypto.randomUUID(), projectId,
        url: 'https://azcoatingsllc.com/about/',
        httpCode: 200, inIndex: 1,
        lastCrawledDate: '2026-04-19T10:00:00Z', inIndexDate: null,
        inspectedAt: seededAt, syncRunId: null, createdAt: seededAt,
        documentSize: 3000, anchorCount: null, discoveryDate: null,
      },
    ]).run()

    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://azcoatingsllc.com/</loc></url>
  <url><loc>https://azcoatingsllc.com/about/</loc></url>
  <url><loc>https://azcoatingsllc.com/michigan/</loc></url>
  <url><loc>https://azcoatingsllc.com/southeast-florida/</loc></url>
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
      config: buildConfig('azcoatingsllc.com'),
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
      'https://azcoatingsllc.com/',
      'https://azcoatingsllc.com/about/',
      'https://azcoatingsllc.com/michigan/',
      'https://azcoatingsllc.com/southeast-florida/',
    ])
    // Newly discovered URLs are now tracked + indexed
    for (const row of newInspections) {
      expect(row.inIndex).toBe(1)
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
  <url><loc>https://azcoatingsllc.com/ok</loc></url>
  <url><loc>https://azcoatingsllc.com/fail</loc></url>
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
      config: buildConfig('azcoatingsllc.com'),
    })

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe(RunStatuses.partial)

    const inspections = db.select().from(bingUrlInspections)
      .where(eq(bingUrlInspections.syncRunId, runId)).all()
    expect(inspections).toHaveLength(1)
    expect(inspections[0]!.url).toBe('https://azcoatingsllc.com/ok')
  })

  it('marks the run failed when sitemap is empty', async () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`
    const s = await startSitemapServer({ '/sitemap.xml': sitemapXml })
    server = s.server

    const runId = await queueRun()
    await expect(() => executeBingInspectSitemap(db, runId, projectId, {
      sitemapUrl: `${s.baseUrl}/sitemap.xml`,
      config: buildConfig('azcoatingsllc.com'),
    })).rejects.toThrow('No URLs found in sitemap')

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe(RunStatuses.failed)
    expect(run?.error).toContain('No URLs found in sitemap')
  })

  it('marks the run failed when no Bing connection exists for the project', async () => {
    const runId = await queueRun()
    await expect(() => executeBingInspectSitemap(db, runId, projectId, {
      sitemapUrl: 'https://azcoatingsllc.com/sitemap.xml',
      config: { apiUrl: 'http://localhost:4100', database: '/tmp/x', apiKey: 'cnry_test' },
    })).rejects.toThrow('No Bing connection')

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe(RunStatuses.failed)
  })

  it('marks the run failed when the Bing connection has no siteUrl', async () => {
    const runId = await queueRun()
    const noSite: CanonryConfig = {
      apiUrl: 'http://localhost:4100', database: '/tmp/x', apiKey: 'cnry_test',
      bing: { connections: [{
        domain: 'azcoatingsllc.com', apiKey: 'k', siteUrl: null,
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      }] },
    }
    await expect(() => executeBingInspectSitemap(db, runId, projectId, {
      sitemapUrl: 'https://azcoatingsllc.com/sitemap.xml',
      config: noSite,
    })).rejects.toThrow('No Bing site configured')

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe(RunStatuses.failed)
  })

  it('downgrades indexed URLs that GetCrawlIssues flags with a blocking issue', async () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://azcoatingsllc.com/blocked</loc></url>
  <url><loc>https://azcoatingsllc.com/ok</loc></url>
</urlset>`
    const s = await startSitemapServer({ '/sitemap.xml': sitemapXml })
    server = s.server

    const bingModule = await import('@ainyc/canonry-integration-bing')
    vi.spyOn(bingModule, 'getUrlInfo').mockImplementation(async (_apiKey, _site, url) => ({
      Url: url, HttpStatus: 200, DocumentSize: 1234,
    }))
    vi.spyOn(bingModule, 'getCrawlIssues').mockResolvedValue([
      { Url: 'https://azcoatingsllc.com/blocked', HttpCode: 403, Date: '2026-04-25', IssueType: 'BlockedByRobotsTxt' },
    ])

    const runId = await queueRun()
    await executeBingInspectSitemap(db, runId, projectId, {
      sitemapUrl: `${s.baseUrl}/sitemap.xml`,
      config: buildConfig('azcoatingsllc.com'),
    })

    const inspections = db.select().from(bingUrlInspections)
      .where(eq(bingUrlInspections.syncRunId, runId)).all()
    const blocked = inspections.find((r) => r.url.endsWith('/blocked'))
    const ok = inspections.find((r) => r.url.endsWith('/ok'))
    expect(blocked?.inIndex).toBe(0)
    expect(ok?.inIndex).toBe(1)
  })
})
