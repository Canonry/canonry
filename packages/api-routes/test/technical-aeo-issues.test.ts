import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createClient, migrate, projects, runs, siteCrawlAttempts, siteCrawlPages, siteCrawlSnapshots,
} from '@canonry/canonry-db'
import {
  siteAuditIssuesResponseSchema, siteAuditIssuePagesResponseSchema,
  type SiteCrawlIssueEvidence,
} from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'

const NOW = '2026-10-12T12:00:00.000Z'
const EMPTY_CROSS: SiteCrawlIssueEvidence = { schemaVersion: '1.0', groupIdentityVersion: 'duplicate-metadata-v1', siteIssues: [] }
const finding = (code: string, type = 'missing', message = code) => ({ code, type, message })
const evidence = (findings: unknown[], recommendations: string[] = []) => ({
  schemaVersion: '1.0', factors: [{ id: 'entity-consistency', findings, recommendations }], criticalDefects: [],
})

describe('stored audit issue feed', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmp: string

  const seed = (name = 'issues', options: { complete?: boolean; cross?: SiteCrawlIssueEvidence | null; createdAt?: string; projectId?: string; trigger?: string } = {}) => {
    const projectId = options.projectId ?? crypto.randomUUID()
    if (!options.projectId) db.insert(projects).values({ id: projectId, name, displayName: name,
      canonicalDomain: `${name}.example`, country: 'US', language: 'en', providers: [], locations: [], createdAt: NOW, updatedAt: NOW }).run()
    const runId = crypto.randomUUID()
    const attemptId = crypto.randomUUID()
    const createdAt = options.createdAt ?? NOW
    db.insert(runs).values({ id: runId, projectId, kind: 'site-audit', status: options.complete === false ? 'partial' : 'completed',
      trigger: options.trigger ?? 'manual', createdAt, finishedAt: createdAt }).run()
    db.insert(siteCrawlAttempts).values({ id: attemptId, projectId, runId, attemptNumber: 1,
      state: 'completed', startedAt: createdAt, finishedAt: createdAt, createdAt, updatedAt: createdAt }).run()
    db.insert(siteCrawlSnapshots).values({ id: crypto.randomUUID(), projectId, runId, attemptId,
      rootUrl: `https://${name}.example/`, complete: options.complete ?? true,
      termination: options.complete === false ? 'max-pages' : 'completed', detailsAvailable: true,
      issueEvidence: options.cross === undefined ? EMPTY_CROSS : options.cross, createdAt, updatedAt: createdAt }).run()
    return { projectId, runId, attemptId, name }
  }
  const page = (scope: ReturnType<typeof seed>, nodeKey: string, auditFields: Record<string, unknown>, url = `https://${scope.name}.example/${nodeKey}`) => {
    db.insert(siteCrawlPages).values({ id: crypto.randomUUID(), projectId: scope.projectId, runId: scope.runId,
      attemptId: scope.attemptId, nodeKey, url, path: `/${nodeKey}`, parentPath: '/', discoverySource: 'sitemap',
      fetchState: 'html', auditState: 'complete', auditScore: 100, auditFields, createdAt: NOW, updatedAt: NOW }).run()
  }
  const list = async (name = 'issues', query = '') => {
    const res = await app.inject(`/api/v1/projects/${name}/technical-aeo/issues${query}`)
    expect(res.statusCode).toBe(200)
    return siteAuditIssuesResponseSchema.parse(res.json())
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-audit-issues-'))
    db = createClient(path.join(tmp, 'test.db'))
    migrate(db)
    app = Fastify()
    app.register(apiRoutes, { db, skipAuth: true })
  })
  afterEach(async () => { await app.close(); db.$client.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

  it('surfaces passing-score findings, ranks actionable before advice, and keeps duplicate membership once', async () => {
    const urls = ['https://issues.example/a', 'https://issues.example/b', 'https://issues.example/c', 'https://issues.example/d']
    const scope = seed('issues', { complete: false, cross: { ...EMPTY_CROSS, siteIssues: [
      { key: 'site-issue:exact-title', code: 'site.duplicate-title', message: 'Repeated title', affectedUrls: urls },
    ] } })
    for (const [i, url] of urls.entries()) page(scope, String(i), evidence([
      finding('site.duplicate-title', 'info'), finding('entity-consistency.title.short', 'info'),
      ...(i === 0 ? [finding('entity-consistency.description.missing'), finding('other.info', 'info'), finding('other.found', 'found')] : []),
    ], ['Improve the metadata']), url)
    const result = await list()
    expect(result).toMatchObject({ runId: scope.runId, attemptId: scope.attemptId, auditedAt: NOW,
      complete: false, termination: 'max-pages', state: 'partial', total: 4,
      coverage: { pageFindings: 'available', crossPage: 'available', auditedPages: 4, omittedFindings: 0 } })
    expect(result.issues[0]).toMatchObject({ code: 'entity-consistency.description.missing', disposition: 'actionable', affectedPages: 1 })
    expect(result.issues[0]!.examples[0]).toMatchObject({ recommendationsScope: 'factor', recommendations: ['Improve the metadata'] })
    const duplicate = result.issues.find(issue => issue.code === 'site.duplicate-title')!
    expect(duplicate).toMatchObject({ id: 'site-issue:exact-title', disposition: 'advisory', affectedPages: 4, examplesTruncated: true })
    expect(duplicate.examples).toHaveLength(3)
    const detail = await app.inject(`/api/v1/projects/issues/technical-aeo/issues/${duplicate.id}/pages?limit=2`)
    const first = siteAuditIssuePagesResponseSchema.parse(detail.json())
    expect(first.total).toBe(4)
    expect(first.pages.map(value => value.url)).toEqual(urls.slice(0, 2))
    const next = await app.inject(`/api/v1/projects/issues/technical-aeo/issues/${duplicate.id}/pages?cursor=${first.nextCursor}`)
    expect(siteAuditIssuePagesResponseSchema.parse(next.json()).pages.map(value => value.url)).toEqual(urls.slice(2))
  })

  it('distinguishes measured zero from legacy, malformed and uncoded evidence', async () => {
    const scope = seed('issues', { cross: null })
    page(scope, 'legacy', { factors: [{ id: 'entity-consistency', score: 100 }] })
    expect(await list()).toMatchObject({ state: 'unavailable', total: null,
      coverage: { pageFindings: 'unavailable', crossPage: 'unavailable', pagesWithoutFindingEvidence: 1 } })
    db.update(siteCrawlPages).set({ auditFields: evidence([]) }).run()
    db.update(siteCrawlSnapshots).set({ issueEvidence: EMPTY_CROSS }).run()
    expect(await list()).toMatchObject({ state: 'available', total: 0, issues: [] })
    db.update(siteCrawlPages).set({ auditFields: evidence([finding('known'), { type: 'missing', message: 'No code' }, null]) }).run()
    expect(await list()).toMatchObject({ state: 'partial', total: 1,
      coverage: { pageFindings: 'partial', omittedFindings: 2, pagesWithoutFindingEvidence: 1 } })
    db.update(siteCrawlPages).set({ auditScore: null, auditFields: {
      schemaVersion: '1.0', factors: [], criticalDefects: [{ id: 'no-h1', severity: 'critical',
        detail: 'No main heading', recommendation: 'Add the page main heading' }],
    } }).run()
    const defects = await list()
    expect(defects).toMatchObject({ state: 'available', total: 1,
      coverage: { auditedPages: 1, pagesWithFindingEvidence: 1 } })
    expect(defects.issues[0]).toMatchObject({ code: 'no-h1', source: 'critical-defect', severity: 'critical', disposition: 'actionable',
      examples: [{ recommendationsScope: 'issue', recommendations: ['Add the page main heading'] }] })
    db.update(siteCrawlSnapshots).set({ detailsAvailable: false, issueEvidence: { ...EMPTY_CROSS,
      siteIssues: [{ key: null, code: 'future.check', message: 'New retained evidence', affectedUrls: ['https://issues.example/legacy'] }],
    } }).run()
    const retained = await list()
    expect(retained).toMatchObject({ state: 'partial', total: 1, coverage: { pageFindings: 'unavailable', crossPage: 'available' } })
    expect(retained.issues[0]).toMatchObject({ stableIdentity: false, code: 'future.check', disposition: 'informational' })
  })

  it('binds cursors to evidence, run, project and endpoint while retaining published-attempt isolation', async () => {
    const scope = seed()
    page(scope, 'a', evidence([finding('a'), finding('b')]))
    page(scope, 'b', evidence([finding('a')]))
    const old = seed('issues', { projectId: scope.projectId, createdAt: '2026-10-11T12:00:00.000Z' })
    page(old, 'old', evidence([finding('old')]))
    const other = seed('other')
    page(other, 'other', evidence([finding('private')]))
    const unpublishedAttempt = crypto.randomUUID()
    db.insert(siteCrawlAttempts).values({ id: unpublishedAttempt, projectId: scope.projectId, runId: scope.runId, attemptNumber: 2,
      state: 'completed', createdAt: NOW, updatedAt: NOW }).run()
    page({ ...scope, attemptId: unpublishedAttempt }, 'hidden', evidence([finding('unpublished')]))
    const first = await list('issues', '?limit=1')
    expect(first.total).toBe(2)
    const second = await list('issues', `?cursor=${first.nextCursor}`)
    expect(second.issues).toHaveLength(1)
    expect(second.issues[0]!.id).not.toBe(first.issues[0]!.id)
    const cursor = first.nextCursor!
    const tampered = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { offset: number }
    tampered.offset += 1
    for (const url of [
      `/api/v1/projects/issues/technical-aeo/issues?cursor=${Buffer.from(JSON.stringify(tampered)).toString('base64url')}`,
      `/api/v1/projects/other/technical-aeo/issues?cursor=${cursor}`,
      `/api/v1/projects/issues/technical-aeo/issues?runId=${old.runId}&cursor=${cursor}`,
      `/api/v1/projects/issues/technical-aeo/issues/${first.issues[0]!.id}/pages?cursor=${cursor}`,
    ]) expect((await app.inject(url)).statusCode).toBe(400)
    expect((await app.inject(`/api/v1/projects/issues/technical-aeo/issues?runId=${other.runId}`)).statusCode).toBe(404)
    expect((await app.inject(`/api/v1/projects/issues/technical-aeo/issues/${(await list('other')).issues[0]!.id}/pages`)).statusCode).toBe(404)
    db.update(siteCrawlPages).set({ auditFields: evidence([finding('a'), finding('changed')]) }).where(eq(siteCrawlPages.nodeKey, 'a')).run()
    expect((await app.inject(`/api/v1/projects/issues/technical-aeo/issues?cursor=${cursor}`)).statusCode).toBe(400)
  })

  it('bounds pretty JSON bytes, resumes every issue and member, and reports truncated prose', async () => {
    const scope = seed()
    for (let i = 0; i < 8; i += 1) page(scope, String(i), evidence(
      Array.from({ length: 7 }, (_, index) => finding(`code.${index}`, 'missing', '問題'.repeat(350))),
      ['修'.repeat(600), '正'.repeat(400), '文'.repeat(400), 'fourth'],
    ), `https://issues.example/${i}/${'url'.repeat(300)}`)
    const ids: string[] = []
    let cursor: string | null = null
    do {
      const result = await list('issues', cursor ? `?limit=100&cursor=${cursor}` : '?limit=100')
      expect(Buffer.byteLength(JSON.stringify(result, null, 2))).toBeLessThanOrEqual(16 * 1024)
      expect(result.issues.length).toBeGreaterThan(0)
      ids.push(...result.issues.map(issue => issue.id))
      cursor = result.nextCursor
    } while (cursor)
    expect(new Set(ids).size).toBe(7)
    expect(ids).toHaveLength(7)
    const urls: string[] = []
    do {
      const res = await app.inject(`/api/v1/projects/issues/technical-aeo/issues/${ids[0]}/pages?limit=100${cursor ? `&cursor=${cursor}` : ''}`)
      const result = siteAuditIssuePagesResponseSchema.parse(res.json())
      expect(Buffer.byteLength(JSON.stringify(result, null, 2))).toBeLessThanOrEqual(16 * 1024)
      expect(result.pages[0]).toMatchObject({ messageTruncated: true, recommendationsTruncated: true })
      urls.push(...result.pages.map(value => value.url))
      cursor = result.nextCursor
    } while (cursor)
    expect(new Set(urls).size).toBe(8)
    expect(urls).toHaveLength(8)
  })

  it('rejects invalid limits and a single oversized row instead of returning a repeating empty cursor', async () => {
    const scope = seed()
    page(scope, 'huge', evidence([finding('huge')]), `https://issues.example/${'x'.repeat(20_000)}`)
    for (const limit of ['1.5', '0', '101', 'nope', '1&limit=2']) {
      expect((await app.inject(`/api/v1/projects/issues/technical-aeo/issues?limit=${limit}`)).statusCode).toBe(400)
    }
    const res = await app.inject('/api/v1/projects/issues/technical-aeo/issues')
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('16 KiB response budget')
  })
})
