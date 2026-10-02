import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import {
  createClient,
  migrate,
  projects,
  runs,
  siteAuditSnapshots,
  siteCrawlAttempts,
  siteCrawlPages,
  siteCrawlSnapshots,
} from '@ainyc/canonry-db'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'

const PROJECT = 'capped-site'
const PAGE_URL = 'https://capped.example/pricing'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

/**
 * A site larger than the default page budget: its newest scan stopped at the
 * cap (`partial`, with a crawl), and its only `completed` run is an older
 * scorecard-only audit that never published a crawl.
 */
async function cappedSiteServer(): Promise<{ origin: string; newestPartial: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-mcp-site-health-'))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const base = Date.now()
  const at = (offsetSeconds: number) => new Date(base + offsetSeconds * 1000).toISOString()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: PROJECT, displayName: 'Capped', canonicalDomain: 'capped.example',
    country: 'US', language: 'en', providers: [], locations: [], createdAt: at(-300), updatedAt: at(-300),
  }).run()

  const legacyRun = crypto.randomUUID()
  db.insert(runs).values({
    id: legacyRun, projectId, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt: at(-200), finishedAt: at(-200),
  }).run()
  db.insert(siteAuditSnapshots).values({
    id: crypto.randomUUID(), projectId, runId: legacyRun, sitemapUrl: 'https://capped.example/sitemap.xml', auditedAt: at(-200),
    aggregateScore: 55, aggregateGrade: 'D', pagesDiscovered: 1, pagesAudited: 1, pagesSkipped: 0, pagesErrored: 0,
    factorAverages: [], crossCuttingIssues: [], prioritizedFixes: [], createdAt: at(-200),
  }).run()

  const newestPartial = crypto.randomUUID()
  const attemptId = crypto.randomUUID()
  const createdAt = at(-100)
  db.insert(runs).values({
    id: newestPartial, projectId, kind: 'site-audit', status: 'partial', trigger: 'scheduled', createdAt, finishedAt: createdAt,
  }).run()
  db.insert(siteCrawlAttempts).values({
    id: attemptId, projectId, runId: newestPartial, attemptNumber: 1, state: 'partial',
    pagesDiscovered: 2, pagesFetched: 1, pagesEligible: 1, startedAt: createdAt, finishedAt: createdAt, createdAt, updatedAt: createdAt,
  }).run()
  db.insert(siteCrawlSnapshots).values({
    id: crypto.randomUUID(), projectId, runId: newestPartial, attemptId, rootUrl: 'https://capped.example/',
    complete: false, termination: 'max-pages', detailsAvailable: true,
    pagesDiscovered: 2, pagesFetched: 1, pagesEligible: 1, createdAt, updatedAt: createdAt,
  }).run()
  db.insert(siteCrawlPages).values({
    id: crypto.randomUUID(), projectId, runId: newestPartial, attemptId, nodeKey: 'pricing',
    url: PAGE_URL, finalUrl: PAGE_URL, path: '/pricing', parentPath: '/', discoverySource: 'sitemap',
    fetchState: 'html', httpStatus: 200, indexabilityState: 'indexable', auditState: 'complete', auditScore: 64,
    auditFields: {
      schemaVersion: '1.0',
      factors: [{
        id: 'content-depth', name: 'Content Depth', weight: 12, score: 64, status: 'partial', applicable: true,
        findings: [{ type: 'missing', code: 'content-depth.word-count.low', message: 'Low content depth.' }],
        recommendations: ['Expand the page.'],
      }],
      criticalDefects: [],
    },
    inventoryEligible: true, depth: 0, createdAt, updatedAt: createdAt,
  }).run()

  const app = Fastify()
  cleanup.push(async () => { await app.close(); db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  app.register(apiRoutes, { db, skipAuth: true })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test address')
  return { origin: `http://127.0.0.1:${address.port}`, newestPartial }
}

async function connect(origin: string): Promise<Client> {
  const api = new ApiClient(origin, 'cnry_site_health_test', { skipProbe: true })
  const server = createCanonryMcpServer({ eager: true, clientFactory: () => api })
  const client = new Client({ name: 'site-health-default-run-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanup.push(async () => { await client.close(); await server.close() })
  await client.listTools()
  return client
}

describe('Site Health MCP reads without a runId', () => {
  it('audits a page from the newest page-capped scan instead of answering no-crawl', async () => {
    const { origin, newestPartial } = await cappedSiteServer()
    const mcp = await connect(origin)

    const audit = await mcp.callTool({ name: 'canonry_site_health_page_audit', arguments: { project: PROJECT, url: PAGE_URL } })
    expect(audit.isError).not.toBe(true)
    expect(audit.structuredContent).toMatchObject({
      state: 'ready',
      runId: newestPartial,
      complete: false,
      termination: 'max-pages',
      nodeKey: 'pricing',
      auditScore: 64,
      evidenceState: 'complete',
      factors: [{ id: 'content-depth', findings: [{ code: 'content-depth.word-count.low' }] }],
    })
  })

  it.each(['canonry_site_health_overview', 'canonry_technical_aeo_crawl'])('%s reports that scan as the current crawl', async (tool) => {
    const { origin, newestPartial } = await cappedSiteServer()
    const mcp = await connect(origin)
    const result = await mcp.callTool({ name: tool, arguments: { project: PROJECT } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      hasCrawlData: true,
      legacyAuditAvailable: true,
      runId: newestPartial,
      runStatus: 'partial',
      complete: false,
      termination: 'max-pages',
    })
  })

  it('lists that scan\'s pages from canonry_technical_aeo_crawl_pages', async () => {
    const { origin, newestPartial } = await cappedSiteServer()
    const mcp = await connect(origin)
    const result = await mcp.callTool({ name: 'canonry_technical_aeo_crawl_pages', arguments: { project: PROJECT } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      hasCrawlData: true,
      runId: newestPartial,
      complete: false,
      termination: 'max-pages',
      total: 1,
      pages: [{ nodeKey: 'pricing', url: PAGE_URL, auditScore: 64 }],
    })
  })

  it('qualifies an empty neighbor list from canonry_technical_aeo_link_neighbors as partial', async () => {
    const { origin, newestPartial } = await cappedSiteServer()
    const mcp = await connect(origin)
    const result = await mcp.callTool({ name: 'canonry_technical_aeo_link_neighbors', arguments: { project: PROJECT, nodeKey: 'pricing' } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      hasCrawlData: true,
      runId: newestPartial,
      complete: false,
      termination: 'max-pages',
      inbound: [],
      inboundTruncated: false,
    })
  })
})
