import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { beforeEach, expect, test } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  keywords,
  competitors,
  runs,
  querySnapshots,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { CitationVisibilityResponse } from '@ainyc/canonry-contracts'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-citations-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db, tmpDir }
}

function insertProject(db: ReturnType<typeof createClient>, name: string, providers: string[] = []) {
  const id = crypto.randomUUID()
  db.insert(projects).values({
    id,
    name,
    displayName: name,
    canonicalDomain: `${name}.example.com`,
    country: 'US',
    language: 'en',
    providers: JSON.stringify(providers),
    locations: '[]',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run()
  return id
}

function insertKeyword(db: ReturnType<typeof createClient>, projectId: string, keyword: string) {
  const id = crypto.randomUUID()
  db.insert(keywords).values({ id, projectId, keyword, createdAt: new Date().toISOString() }).run()
  return id
}

function insertCompetitor(db: ReturnType<typeof createClient>, projectId: string, domain: string) {
  db.insert(competitors).values({
    id: crypto.randomUUID(),
    projectId,
    domain,
    createdAt: new Date().toISOString(),
  }).run()
}

function insertRun(db: ReturnType<typeof createClient>, projectId: string, createdAt: string) {
  const id = crypto.randomUUID()
  db.insert(runs).values({
    id,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    createdAt,
  }).run()
  return id
}

function insertSnapshot(
  db: ReturnType<typeof createClient>,
  args: {
    runId: string
    keywordId: string
    provider: string
    citationState: 'cited' | 'not-cited'
    citedDomains?: string[]
    competitorOverlap?: string[]
    createdAt: string
  },
) {
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: args.runId,
    keywordId: args.keywordId,
    provider: args.provider,
    citationState: args.citationState,
    citedDomains: JSON.stringify(args.citedDomains ?? []),
    competitorOverlap: JSON.stringify(args.competitorOverlap ?? []),
    recommendedCompetitors: '[]',
    createdAt: args.createdAt,
  }).run()
}

let ctx: ReturnType<typeof buildApp>

beforeEach(() => {
  ctx = buildApp()
  return async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  }
})

test('404 when project does not exist', async () => {
  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/missing/citations/visibility' })
  expect(res.statusCode).toBe(404)
})

test('no-data sentinel with reason "no-keywords" when project has no keywords', async () => {
  insertProject(ctx.db, 'empty', ['gemini'])
  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/empty/citations/visibility' })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body) as CitationVisibilityResponse
  expect(body.status).toBe('no-data')
  expect(body.reason).toBe('no-keywords')
  expect(body.byKeyword).toEqual([])
})

test('no-data sentinel with reason "no-runs-yet" when project has keywords but no runs', async () => {
  const projectId = insertProject(ctx.db, 'fresh', ['gemini'])
  insertKeyword(ctx.db, projectId, 'best CRM')
  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/fresh/citations/visibility' })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body) as CitationVisibilityResponse
  expect(body.status).toBe('no-data')
  expect(body.reason).toBe('no-runs-yet')
})

test('ready response computes coverage from latest snapshot per (keyword × provider)', async () => {
  const projectId = insertProject(ctx.db, 'live', ['gemini', 'claude'])
  const kwA = insertKeyword(ctx.db, projectId, 'keyword A')
  const kwB = insertKeyword(ctx.db, projectId, 'keyword B')

  const oldRun = insertRun(ctx.db, projectId, '2026-04-20T00:00:00Z')
  const newRun = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')

  // Old run — both providers, both keywords, all not-cited
  insertSnapshot(ctx.db, { runId: oldRun, keywordId: kwA, provider: 'gemini', citationState: 'not-cited', createdAt: '2026-04-20T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: oldRun, keywordId: kwA, provider: 'claude', citationState: 'not-cited', createdAt: '2026-04-20T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: oldRun, keywordId: kwB, provider: 'gemini', citationState: 'not-cited', createdAt: '2026-04-20T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: oldRun, keywordId: kwB, provider: 'claude', citationState: 'not-cited', createdAt: '2026-04-20T00:00:01Z' })

  // New run — gemini cites kwA only; claude still cites neither
  insertSnapshot(ctx.db, { runId: newRun, keywordId: kwA, provider: 'gemini', citationState: 'cited', createdAt: '2026-04-28T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: newRun, keywordId: kwA, provider: 'claude', citationState: 'not-cited', createdAt: '2026-04-28T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: newRun, keywordId: kwB, provider: 'gemini', citationState: 'not-cited', createdAt: '2026-04-28T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: newRun, keywordId: kwB, provider: 'claude', citationState: 'not-cited', createdAt: '2026-04-28T00:00:01Z' })

  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/live/citations/visibility' })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body) as CitationVisibilityResponse

  expect(body.status).toBe('ready')
  expect(body.summary.providersConfigured).toBe(2)
  expect(body.summary.providersCiting).toBe(1)
  expect(body.summary.totalKeywords).toBe(2)
  expect(body.summary.keywordsCited).toBe(1)
  expect(body.summary.keywordsFullyCovered).toBe(0)
  expect(body.summary.keywordsUncovered).toBe(1)
  expect(body.summary.latestRunId).toBe(newRun)

  const rowA = body.byKeyword.find(r => r.keyword === 'keyword A')!
  expect(rowA.citedCount).toBe(1)
  expect(rowA.totalProviders).toBe(2)
  expect(rowA.providers.find(p => p.provider === 'gemini')!.cited).toBe(true)
  expect(rowA.providers.find(p => p.provider === 'gemini')!.runId).toBe(newRun)
  expect(rowA.providers.find(p => p.provider === 'claude')!.cited).toBe(false)

  const rowB = body.byKeyword.find(r => r.keyword === 'keyword B')!
  expect(rowB.citedCount).toBe(0)
})

test('uses observed providers when project.providers is empty', async () => {
  const projectId = insertProject(ctx.db, 'no-config', [])
  const kw = insertKeyword(ctx.db, projectId, 'keyword X')
  const run = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')
  insertSnapshot(ctx.db, { runId: run, keywordId: kw, provider: 'perplexity', citationState: 'cited', createdAt: '2026-04-28T00:00:01Z' })

  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/no-config/citations/visibility' })
  const body = JSON.parse(res.body) as CitationVisibilityResponse
  expect(body.summary.providersConfigured).toBe(1)
  expect(body.summary.providersCiting).toBe(1)
  expect(body.byKeyword[0]!.providers).toHaveLength(1)
  expect(body.byKeyword[0]!.providers[0]!.provider).toBe('perplexity')
})

test('competitor gaps lists not-cited keywords where a configured competitor appears in cited domains', async () => {
  const projectId = insertProject(ctx.db, 'gaps', ['gemini'])
  const kwA = insertKeyword(ctx.db, projectId, 'keyword A')
  const kwB = insertKeyword(ctx.db, projectId, 'keyword B')
  insertCompetitor(ctx.db, projectId, 'rival.com')
  insertCompetitor(ctx.db, projectId, 'other.com')

  const run = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')

  // Keyword A: not cited; rival.com appears in cited domains => gap row
  insertSnapshot(ctx.db, {
    runId: run,
    keywordId: kwA,
    provider: 'gemini',
    citationState: 'not-cited',
    citedDomains: ['rival.com', 'unrelated.com'],
    createdAt: '2026-04-28T00:00:01Z',
  })

  // Keyword B: cited; rival.com still appears, but no gap because we are cited
  insertSnapshot(ctx.db, {
    runId: run,
    keywordId: kwB,
    provider: 'gemini',
    citationState: 'cited',
    citedDomains: ['rival.com', 'gaps.example.com'],
    createdAt: '2026-04-28T00:00:01Z',
  })

  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/gaps/citations/visibility' })
  const body = JSON.parse(res.body) as CitationVisibilityResponse

  expect(body.competitorGaps).toHaveLength(1)
  const gap = body.competitorGaps[0]!
  expect(gap.keyword).toBe('keyword A')
  expect(gap.provider).toBe('gemini')
  expect(gap.citingCompetitors).toEqual(['rival.com'])
})

test('competitor gap reads from competitorOverlap when citedDomains is empty', async () => {
  const projectId = insertProject(ctx.db, 'overlap-only', ['gemini'])
  const kw = insertKeyword(ctx.db, projectId, 'keyword X')
  insertCompetitor(ctx.db, projectId, 'rival.com')

  const run = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')
  insertSnapshot(ctx.db, {
    runId: run,
    keywordId: kw,
    provider: 'gemini',
    citationState: 'not-cited',
    citedDomains: [],
    competitorOverlap: ['rival.com'],
    createdAt: '2026-04-28T00:00:01Z',
  })

  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/overlap-only/citations/visibility' })
  const body = JSON.parse(res.body) as CitationVisibilityResponse
  expect(body.competitorGaps).toHaveLength(1)
  expect(body.competitorGaps[0]!.citingCompetitors).toEqual(['rival.com'])
})

test('does not surface a gap when project has no configured competitors', async () => {
  const projectId = insertProject(ctx.db, 'no-comp', ['gemini'])
  const kw = insertKeyword(ctx.db, projectId, 'keyword X')
  const run = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')
  insertSnapshot(ctx.db, {
    runId: run,
    keywordId: kw,
    provider: 'gemini',
    citationState: 'not-cited',
    citedDomains: ['rival.com'],
    createdAt: '2026-04-28T00:00:01Z',
  })

  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/no-comp/citations/visibility' })
  const body = JSON.parse(res.body) as CitationVisibilityResponse
  expect(body.competitorGaps).toHaveLength(0)
})

test('keywordsFullyCovered counts keywords cited by every configured provider', async () => {
  const projectId = insertProject(ctx.db, 'full', ['gemini', 'claude'])
  const kw = insertKeyword(ctx.db, projectId, 'keyword Y')
  const run = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')
  insertSnapshot(ctx.db, { runId: run, keywordId: kw, provider: 'gemini', citationState: 'cited', createdAt: '2026-04-28T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: run, keywordId: kw, provider: 'claude', citationState: 'cited', createdAt: '2026-04-28T00:00:01Z' })

  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/full/citations/visibility' })
  const body = JSON.parse(res.body) as CitationVisibilityResponse
  expect(body.summary.keywordsFullyCovered).toBe(1)
  expect(body.summary.keywordsCited).toBe(1)
  expect(body.summary.providersCiting).toBe(2)
})

test('keywordsFullyCovered does not count keywords missing snapshots from configured providers', async () => {
  // Project configures gemini + claude + openai but only gemini + claude have run.
  // Both observed providers cite, but openai has no snapshot — keyword is NOT
  // fully covered by the configured set.
  const projectId = insertProject(ctx.db, 'partial-coverage', ['gemini', 'claude', 'openai'])
  const kw = insertKeyword(ctx.db, projectId, 'keyword Z')
  const run = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')
  insertSnapshot(ctx.db, { runId: run, keywordId: kw, provider: 'gemini', citationState: 'cited', createdAt: '2026-04-28T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: run, keywordId: kw, provider: 'claude', citationState: 'cited', createdAt: '2026-04-28T00:00:01Z' })

  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/partial-coverage/citations/visibility' })
  const body = JSON.parse(res.body) as CitationVisibilityResponse
  expect(body.summary.providersConfigured).toBe(3)
  expect(body.summary.keywordsCited).toBe(1)
  expect(body.summary.keywordsFullyCovered).toBe(0)
})

test('competitor matching normalizes www. and protocol on both sides', async () => {
  const projectId = insertProject(ctx.db, 'normalize', ['gemini'])
  const kw = insertKeyword(ctx.db, projectId, 'keyword X')
  // Competitor entered with www. prefix (no insert-time normalization).
  insertCompetitor(ctx.db, projectId, 'www.rival.com')
  // Second competitor entered as a full URL.
  insertCompetitor(ctx.db, projectId, 'https://other.com/')

  const run = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')
  insertSnapshot(ctx.db, {
    runId: run,
    keywordId: kw,
    provider: 'gemini',
    citationState: 'not-cited',
    citedDomains: ['rival.com', 'other.com', 'unrelated.com'],
    createdAt: '2026-04-28T00:00:01Z',
  })

  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/normalize/citations/visibility' })
  const body = JSON.parse(res.body) as CitationVisibilityResponse
  expect(body.competitorGaps).toHaveLength(1)
  expect(body.competitorGaps[0]!.citingCompetitors).toEqual(['other.com', 'rival.com'])
})
