import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createClient, gscSitemaps, migrate, projects, runs, sitemapListSyncs } from '@canonry/canonry-db'
import type { GscSitemap } from '@canonry/canonry-integration-google'

const listSitemapsMock = vi.fn<(token: string, property: string, index?: string) => Promise<GscSitemap[]>>()
vi.mock('@canonry/canonry-integration-google', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@canonry/canonry-integration-google')>()),
  listSitemaps: (token: string, property: string, index?: string) => listSitemapsMock(token, property, index),
}))
const { syncGscSitemaps, GSC_SITEMAP_INDEX_MAX_PER_SYNC } = await import('../src/gsc-sync.js')

const S = 'https://example.com'
let db: ReturnType<typeof createClient>
let tmp: string
const projectId = 'proj-sitemaps'

/** Search Console's sitemaps.list entry shape, as the live route has always shown it. */
const entry = (pathname: string, extra: Partial<GscSitemap> = {}): GscSitemap => ({
  path: `${S}${pathname}`, lastSubmitted: '2026-10-01T09:00:00.000Z', isPending: false, isSitemapsIndex: false,
  lastDownloaded: '2026-11-01T10:00:00.000Z', warnings: '0', errors: '0', contents: [{ type: 'web', submitted: '12', indexed: '0' }], ...extra,
})

function run(): string {
  const id = crypto.randomUUID()
  db.insert(runs).values({ id, projectId, kind: 'gsc-sync', status: 'running', trigger: 'manual', createdAt: new Date().toISOString() }).run()
  return id
}
const stored = () => db.select().from(gscSitemaps).where(eq(gscSitemaps.projectId, projectId)).all()
  .map((row) => [row.url.slice(S.length), row.parentUrl?.slice(S.length) ?? null, row.isIndex, row.urlCount, row.warnings, row.isPending])
  .sort((a, b) => String(a[0]).localeCompare(String(b[0])))

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-gsc-sitemaps-'))
  db = createClient(path.join(tmp, 'test.db'))
  migrate(db)
  db.insert(projects).values({ id: projectId, name: 'sitemaps', displayName: 'Sitemaps', canonicalDomain: 'example.com', country: 'US', language: 'en', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }).run()
  listSitemapsMock.mockReset()
})
afterEach(() => { db.$client.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

it('stores each sitemap and the files inside each index, with counts summed over content types', async () => {
  listSitemapsMock.mockImplementation(async (_token, _property, index) => index
    ? [entry('/pages.xml', { lastSubmitted: undefined }), entry('/posts.xml', { warnings: '2', contents: [{ type: 'web', submitted: '30', indexed: '0' }, { type: 'image', submitted: '5', indexed: '0' }] })]
    : [entry('/index.xml', { isSitemapsIndex: true, contents: [] }), entry('/news.xml', { isPending: true, contents: undefined })])
  const runId = run()
  expect(await syncGscSitemaps(db, projectId, runId, 'token', 'sc-domain:example.com')).toEqual({ sitemaps: 4, indexesRead: 1 })
  expect(listSitemapsMock.mock.calls.map((call) => call[2] ?? null)).toEqual([null, `${S}/index.xml`])
  expect(stored()).toEqual([
    ['/index.xml', null, true, null, 0, false],
    ['/news.xml', null, false, null, 0, true],
    ['/pages.xml', '/index.xml', false, 12, 0, false],
    ['/posts.xml', '/index.xml', false, 35, 2, false],
  ])
  const sync = db.select().from(sitemapListSyncs).where(eq(sitemapListSyncs.projectId, projectId)).all()
  expect(sync).toMatchObject([{ engine: 'google', syncRunId: runId }])
})

it('removes what Google stopped listing but keeps the files of an index past the per-sync cap', async () => {
  const indexes = Array.from({ length: GSC_SITEMAP_INDEX_MAX_PER_SYNC + 1 }, (_, i) => entry(`/index-${String(i).padStart(2, '0')}.xml`, { isSitemapsIndex: true }))
  const last = indexes.at(-1)!.path
  // A first sync that could read the last index stored one file for it.
  listSitemapsMock.mockImplementation(async (_token, _property, index) => (index === last ? [entry('/late.xml')] : index ? [] : [indexes.at(-1)!, entry('/gone.xml')]))
  await syncGscSitemaps(db, projectId, run(), 'token', 'p')
  expect(stored().map((row) => row[0])).toEqual(['/gone.xml', `/index-${GSC_SITEMAP_INDEX_MAX_PER_SYNC}.xml`, '/late.xml'])

  // Now the list is past the cap: the last index is listed but not read.
  listSitemapsMock.mockImplementation(async (_token, _property, index) => (index ? [] : indexes))
  expect(await syncGscSitemaps(db, projectId, run(), 'token', 'p')).toEqual({ sitemaps: GSC_SITEMAP_INDEX_MAX_PER_SYNC + 1, indexesRead: GSC_SITEMAP_INDEX_MAX_PER_SYNC })
  const urls = stored().map((row) => row[0])
  expect(urls).not.toContain('/gone.xml')
  expect(urls).toContain('/late.xml')
  expect(urls).toHaveLength(GSC_SITEMAP_INDEX_MAX_PER_SYNC + 2)
})

it('records an empty list as read, so "no sitemaps" is an answer', async () => {
  listSitemapsMock.mockResolvedValue([])
  await syncGscSitemaps(db, projectId, run(), 'token', 'p')
  expect(stored()).toEqual([])
  expect(db.select().from(sitemapListSyncs).all()).toHaveLength(1)
})

it('keeps the last stored list when Google fails mid-read', async () => {
  listSitemapsMock.mockResolvedValue([entry('/kept.xml')])
  await syncGscSitemaps(db, projectId, run(), 'token', 'p')
  listSitemapsMock.mockImplementation(async (_token, _property, index) => {
    if (index) throw new Error('Google 503')
    return [entry('/index.xml', { isSitemapsIndex: true })]
  })
  await expect(syncGscSitemaps(db, projectId, run(), 'token', 'p')).rejects.toThrow('Google 503')
  expect(stored().map((row) => row[0])).toEqual(['/kept.xml'])
})
