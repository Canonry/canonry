import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  backlinkDomains,
  backlinkSummaries,
  bingCoverageSnapshots,
  createClient,
  gscCoverageSnapshots,
  migrate,
  projects,
  runs,
  siteAuditSnapshots,
} from '@canonry/canonry-db'
import type { TrendsResponse } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'

interface Ctx {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  projectId: string
}

let ctx: Ctx

beforeEach(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-trends-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  const projectId = crypto.randomUUID()
  const at = '2026-11-01T12:00:00.000Z'
  db.insert(projects).values({
    id: projectId, name: 'trends', displayName: 'Trends', canonicalDomain: 'example.com',
    country: 'US', language: 'en', providers: [], locations: [], createdAt: at, updatedAt: at,
  }).run()
  await app.ready()
  ctx = { app, db, tmpDir, projectId }
})

afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

async function trends(query: string): Promise<{ status: number; body: TrendsResponse }> {
  const response = await ctx.app.inject(`/api/v1/projects/trends/trends?${query}`)
  return { status: response.statusCode, body: response.json() as TrendsResponse }
}

function seedCoverage(table: typeof gscCoverageSnapshots | typeof bingCoverageSnapshots, rows: Array<[string, number, number]>) {
  for (const [date, indexed, notIndexed] of rows) {
    ctx.db.insert(table).values({ id: crypto.randomUUID(), projectId: ctx.projectId, date, indexed, notIndexed, createdAt: `${date}T06:00:00.000Z` }).run()
  }
}

function seedScan(status: string, auditedAt: string, aggregateScore: number, pagesAudited: number) {
  const runId = crypto.randomUUID()
  ctx.db.insert(runs).values({ id: runId, projectId: ctx.projectId, kind: 'site-audit', status, trigger: 'manual', createdAt: auditedAt, finishedAt: auditedAt }).run()
  ctx.db.insert(siteAuditSnapshots).values({
    id: crypto.randomUUID(), projectId: ctx.projectId, runId, sitemapUrl: 'https://example.com/sitemap.xml', auditedAt,
    aggregateScore, aggregateGrade: 'C', pagesDiscovered: pagesAudited, pagesAudited, pagesSkipped: 0, pagesErrored: 0,
    factorAverages: [], crossCuttingIssues: [], prioritizedFixes: [], createdAt: auditedAt,
  }).run()
}

describe('GET /projects/:name/trends', () => {
  it('reads Google and Bing coverage into one card over the default 90 days, ending on the latest reading', async () => {
    seedCoverage(gscCoverageSnapshots, [['2026-07-01', 150, 20], ['2026-08-16', 215, 13], ['2026-11-01', 289, 5]])
    seedCoverage(bingCoverageSnapshots, [['2026-08-16', 19, 0], ['2026-10-31', 43, 0]])

    const { status, body } = await trends('surface=index-coverage')
    expect(status).toBe(200)
    expect(body).toMatchObject({ project: 'trends', surface: 'index-coverage', window: '90d', startDate: '2026-08-04', endDate: '2026-11-01' })
    expect(body.groups.map(group => [group.key, group.label, group.figures.map(figure => [figure.key, figure.value, figure.change?.difference ?? null])])).toEqual([
      ['google', 'Google', [['indexed', 289, 74], ['not-indexed', 5, -8]]],
      ['bing', 'Bing', [['indexed', 43, 24], ['not-indexed', 0, 0]]],
    ])
    // Not indexed is good news when it falls; the July reading sits before the window.
    expect(body.groups[0]!.figures[1]).toMatchObject({ better: 'lower', change: { tone: 'better', basis: { date: '2026-08-16' } }, recordedFrom: '2026-07-01' })
  })

  it('leaves out a search engine that never recorded coverage and honours an explicit window', async () => {
    seedCoverage(gscCoverageSnapshots, [['2026-10-20', 280, 6], ['2026-10-30', 286, 5], ['2026-11-01', 289, 5]])

    const { body } = await trends('surface=index-coverage&window=7d')
    expect(body.groups.map(group => group.key)).toEqual(['google'])
    expect(body).toMatchObject({ window: '7d', startDate: '2026-10-26', endDate: '2026-11-01' })
    expect(body.groups[0]!.figures[0]).toMatchObject({ value: 289, change: { difference: 3, basis: { date: '2026-10-30' } } })
  })

  it('charts completed and partial scans only, over all history by default', async () => {
    seedScan('completed', '2026-08-01T10:00:00.000Z', 61, 120)
    seedScan('failed', '2026-09-01T10:00:00.000Z', 12, 3)
    seedScan('partial', '2026-10-01T10:00:00.000Z', 70, 80)
    seedScan('running', '2026-10-30T10:00:00.000Z', 99, 1)

    const { body } = await trends('surface=site-health')
    expect(body).toMatchObject({ window: 'all', startDate: '2026-08-01', endDate: '2026-10-01' })
    expect(body.groups).toEqual([{
      key: 'site-health',
      label: 'Site Health',
      figures: [
        expect.objectContaining({
          key: 'score',
          unit: 'score',
          value: 70,
          // A scan is a moment: its time travels with it so a viewer sees their own day.
          series: [{ date: '2026-08-01', observedAt: '2026-08-01T10:00:00.000Z', label: null, value: 61 }, { date: '2026-10-01', observedAt: '2026-10-01T10:00:00.000Z', label: null, value: 70 }],
          change: expect.objectContaining({ difference: 9, tone: 'better' }),
        }),
        expect.objectContaining({ key: 'pages-checked', better: 'neither', value: 80, change: expect.objectContaining({ difference: -40, tone: 'neutral' }) }),
      ],
    }])
  })

  it('charts the crawler-excluded Common Crawl totals the Backlinks tab shows, one reading per release in crawl order', async () => {
    const release = (source: 'commoncrawl' | 'bing-webmaster', name: string, queriedAt: string, storedDomains: number, domains: Array<[string, number]>) => {
      ctx.db.insert(backlinkSummaries).values({
        id: crypto.randomUUID(), projectId: ctx.projectId, source, release: name, targetDomain: 'example.com',
        totalLinkingDomains: storedDomains, totalHosts: 999, top10HostsShare: '0.900000', queriedAt, createdAt: queriedAt,
      }).run()
      for (const [linkingDomain, numHosts] of domains) {
        ctx.db.insert(backlinkDomains).values({
          id: crypto.randomUUID(), projectId: ctx.projectId, source, release: name, targetDomain: 'example.com',
          linkingDomain, numHosts, createdAt: queriedAt,
        }).run()
      }
    }
    // Stored totals count crawler hosts; the tab and this card leave them out.
    release('commoncrawl', 'cc-main-2026-jun-jul-aug', '2026-09-01T00:00:00.000Z', 3, [['a.example', 40], ['b.example', 10], ['translate.google.com', 50]])
    // A release whose domain rows are missing is unknown, never zero.
    release('commoncrawl', 'cc-main-2026-jul-aug-sep', '2026-10-01T00:00:00.000Z', 5, [])
    // Twelve kept domains, so only the ten largest make the concentration.
    release('commoncrawl', 'cc-main-2026-aug-sep-oct', '2026-10-26T00:00:00.000Z', 13, [
      ...Array.from({ length: 12 }, (_, index): [string, number] => [`d${index}.example`, 12 - index]),
      ['scholar.google.com', 200],
    ])
    // An older release extracted last: it still reads as the oldest crawl.
    release('commoncrawl', 'cc-main-2026-may-jun-jul', '2026-11-01T00:00:00.000Z', 1, [['a.example', 30]])
    release('bing-webmaster', 'bing-2026-10', '2026-10-20T00:00:00.000Z', 900, [['d.example', 5]])

    const { body } = await trends('surface=backlinks')
    expect(body.endDate).toBe('2026-10-01')
    const [domains, hosts, concentration] = body.groups[0]!.figures
    // A release reads at its window's last month, named by its window.
    expect(domains!.series).toEqual([
      { date: '2026-07-01', observedAt: null, label: 'May-Jul 2026', value: 1 },
      { date: '2026-08-01', observedAt: null, label: 'Jun-Aug 2026', value: 2 },
      { date: '2026-10-01', observedAt: null, label: 'Aug-Oct 2026', value: 12 },
    ])
    expect(domains!.change).toMatchObject({ difference: 11, basis: { date: '2026-07-01', label: 'May-Jul 2026' } })
    expect(hosts!.series.map(point => point.value)).toEqual([30, 50, 78])

    // Every figure equals the Backlinks tab's own crawler-excluded summary for that release.
    for (const [index, name] of ['cc-main-2026-may-jun-jul', 'cc-main-2026-jun-jul-aug', 'cc-main-2026-aug-sep-oct'].entries()) {
      const summary = (await ctx.app.inject(`/api/v1/projects/trends/backlinks/summary?release=${name}&excludeCrawlers=1`)).json() as { totalLinkingDomains: number; totalHosts: number; top10HostsShare: string }
      expect([domains!.series[index]!.value, hosts!.series[index]!.value, concentration!.series[index]!.value], name)
        .toEqual([summary.totalLinkingDomains, summary.totalHosts, Number(summary.top10HostsShare)])
    }
    // (12 + 11 + … + 3) of 78 hosts sit in the ten largest kept domains.
    expect(concentration!.value).toBe(Number((75 / 78).toFixed(6)))
  })

  it('takes a caller\u2019s date range instead of a window', async () => {
    seedCoverage(gscCoverageSnapshots, [['2026-07-01', 150, 20], ['2026-08-16', 215, 13], ['2026-08-30', 230, 9], ['2026-11-01', 289, 5]])

    const { status, body } = await trends('surface=index-coverage&startDate=2026-08-01&endDate=2026-08-31')
    expect(status).toBe(200)
    expect(body).toMatchObject({ window: null, startDate: '2026-08-01', endDate: '2026-08-31' })
    expect(body.groups[0]!.figures[0]).toMatchObject({ value: 230, change: { difference: 15, basis: { date: '2026-08-16' } } })
  })

  it('returns no groups and no span for a surface with nothing recorded', async () => {
    const { status, body } = await trends('surface=backlinks')
    expect(status).toBe(200)
    expect(body).toEqual({ project: 'trends', surface: 'backlinks', window: 'all', startDate: null, endDate: null, groups: [] })
  })

  it.each([
    ['', 'surface'],
    ['surface=traffic', 'surface'],
    ['surface=index-coverage&window=14d', 'window'],
    ['surface=index-coverage&startDate=2026-13-01', 'startDate'],
    ['surface=index-coverage&window=30d&startDate=2026-08-01', 'window'],
    ['surface=index-coverage&startDate=2026-09-01&endDate=2026-08-01', 'startDate'],
  ])('rejects %s with a validation error naming the field', async (query, field) => {
    const response = await ctx.app.inject(`/api/v1/projects/trends/trends?${query}`)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', details: { field } } })
  })
})
