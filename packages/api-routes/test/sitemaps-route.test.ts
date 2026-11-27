import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  bingSitemaps, createClient, gscSitemaps, migrate, projects, runs, siteCrawlAttempts, siteCrawlPages, siteCrawlSnapshots, sitemapListSyncs,
} from '@canonry/canonry-db'
import { sitemapCoverageResponseDtoSchema } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import type { GoogleConnectionRecord, GoogleConnectionStore } from '../src/google.js'

const SITE = 'https://sm.example'
let app: ReturnType<typeof Fastify>
let db: ReturnType<typeof createClient>
let tmp: string
let projectId: string

function googleStore(propertyId: string): GoogleConnectionStore {
  const record = { domain: 'sm.example', connectionType: 'gsc', propertyId, createdAt: '', updatedAt: '' } as GoogleConnectionRecord
  return {
    listConnections: () => [record],
    getConnection: (_domain, type) => (type === 'gsc' ? record : undefined),
    upsertConnection: (connection) => connection,
    updateConnection: () => record,
    deleteConnection: () => false,
  } as GoogleConnectionStore
}

/** A Site Health scan whose pages came from the given sitemap files. */
function scan(createdAt: string, sources: string[][], options: { status?: string; trigger?: string } = {}) {
  const runId = crypto.randomUUID()
  const attemptId = crypto.randomUUID()
  db.insert(runs).values({ id: runId, projectId, kind: 'site-audit', status: options.status ?? 'completed', trigger: options.trigger ?? 'manual', createdAt, finishedAt: createdAt }).run()
  db.insert(siteCrawlAttempts).values({ id: attemptId, projectId, runId, attemptNumber: 1, state: 'completed', startedAt: createdAt, finishedAt: createdAt, createdAt, updatedAt: createdAt }).run()
  db.insert(siteCrawlSnapshots).values({ id: crypto.randomUUID(), projectId, runId, attemptId, rootUrl: `${SITE}/`, complete: true, termination: 'completed', detailsAvailable: true, createdAt, updatedAt: createdAt }).run()
  sources.forEach((pageSources, i) => {
    db.insert(siteCrawlPages).values({ id: crypto.randomUUID(), projectId, runId, attemptId, nodeKey: `p${i}`, url: `${SITE}/p${i}`, path: `/p${i}`, parentPath: '/', discoverySource: 'sitemap', sitemapMetadata: { sources: pageSources }, fetchState: 'html', createdAt, updatedAt: createdAt }).run()
  })
  return runId
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-sitemaps-route-'))
  db = createClient(path.join(tmp, 'test.db'))
  migrate(db)
  projectId = crypto.randomUUID()
  db.insert(projects).values({ id: projectId, name: 'sm', displayName: 'sm', canonicalDomain: 'sm.example', country: 'US', language: 'en', providers: [], locations: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }).run()
  app = Fastify()
  app.register(apiRoutes, {
    db, skipAuth: true, googleConnectionStore: googleStore('sc-domain:sm.example'),
    bingConnectionStore: {
      getConnection: () => ({ domain: 'sm.example', apiKey: 'k', siteUrl: `${SITE}/`, createdAt: '', updatedAt: '' }),
      upsertConnection: (connection) => connection,
      updateConnection: () => undefined,
      deleteConnection: () => false,
    },
  })
})
afterEach(async () => { await app.close(); db.$client.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

const read = async () => {
  const res = await app.inject('/api/v1/projects/sm/sitemaps')
  expect(res.statusCode).toBe(200)
  return sitemapCoverageResponseDtoSchema.parse(res.json())
}

it('compares the latest surfaced scan with the stored engine lists', async () => {
  const runId = scan('2026-11-01T00:00:00.000Z', [[`${SITE}/pages.xml`], [`${SITE}/pages.xml`, `${SITE}/posts.xml`], []])
  // Neither a newer probe scan nor a newer failed one replaces it.
  scan('2026-11-03T00:00:00.000Z', [[`${SITE}/probe.xml`]], { trigger: 'probe' })
  scan('2026-11-04T00:00:00.000Z', [[`${SITE}/failed.xml`]], { status: 'failed' })
  const synced = '2026-11-04T06:00:00.000Z'
  db.insert(gscSitemaps).values([
    { id: crypto.randomUUID(), projectId, url: `${SITE}/index.xml`, parentUrl: null, isIndex: true, isPending: false, type: 'sitemap', urlCount: 40, warnings: 0, errors: 0, submittedAt: '2026-10-01T00:00:00.000Z', lastDownloadedAt: '2026-11-03T00:00:00.000Z', syncedAt: synced },
    { id: crypto.randomUUID(), projectId, url: `${SITE}/pages.xml`, parentUrl: `${SITE}/index.xml`, isIndex: false, isPending: false, type: 'sitemap', urlCount: 30, warnings: 2, errors: 0, submittedAt: null, lastDownloadedAt: '2026-11-03T00:00:00.000Z', syncedAt: synced },
  ]).run()
  db.insert(sitemapListSyncs).values({ projectId, engine: 'google', syncedAt: synced }).run()
  // Bing rows without a completed list read stay out of the comparison.
  db.insert(bingSitemaps).values({ id: crypto.randomUUID(), projectId, url: `${SITE}/old.xml`, parentUrl: null, type: 'Sitemap', status: 'Success', urlCount: 1, fileSize: 0, compressed: false, submittedAt: null, lastCrawledAt: null, syncedAt: synced }).run()

  const body = await read()
  expect(body.site).toEqual({ scannedAt: '2026-11-01T00:00:00.000Z', runId, sitemaps: [`${SITE}/pages.xml`, `${SITE}/posts.xml`] })
  expect(body.bing).toBeNull()
  expect(body.google!.syncedAt).toBe(synced)
  expect(body.google!.sitemaps.map((row) => [row.url.slice(SITE.length), row.parentUrl?.slice(SITE.length) ?? null, row.state, row.statusLabel, row.urlCount])).toEqual([
    ['/index.xml', null, 'ok', 'Success', 40],
    ['/pages.xml', '/index.xml', 'warnings', 'Warnings', 30],
  ])
  // pages.xml is in Google through its index; posts.xml is not.
  expect(body.google!.missing).toEqual([{ url: `${SITE}/posts.xml`, foundIn: ['site'] }])
})

it('reads an empty engine list as "has none" once it was read, and leaves out sitemaps an engine cannot take', async () => {
  scan('2026-11-01T00:00:00.000Z', [[`${SITE}/sitemap.xml`, 'https://elsewhere.example/sitemap.xml']])
  db.insert(sitemapListSyncs).values([
    { projectId, engine: 'google', syncedAt: '2026-11-04T00:00:00.000Z' },
    { projectId, engine: 'bing', syncedAt: '2026-11-04T00:00:00.000Z' },
  ]).run()
  const body = await read()
  expect(body.google).toEqual({ syncedAt: '2026-11-04T00:00:00.000Z', sitemaps: [], missing: [{ url: `${SITE}/sitemap.xml`, foundIn: ['site'] }] })
  // Bing takes only its own site's host, so the other domain is not offered either.
  expect(body.bing!.missing).toEqual([{ url: `${SITE}/sitemap.xml`, foundIn: ['site'] }])
})

it('answers before any scan or sync with nothing to compare', async () => {
  expect(await read()).toEqual({ site: { scannedAt: null, runId: null, sitemaps: [] }, google: null, bing: null })
})
