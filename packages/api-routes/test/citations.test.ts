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
  queries as queriesTable,
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

function insertQuery(db: ReturnType<typeof createClient>, projectId: string, query: string) {
  const id = crypto.randomUUID()
  db.insert(queriesTable).values({ id, projectId, query, createdAt: new Date().toISOString() }).run()
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
    queryId: string
    provider: string
    citationState: 'cited' | 'not-cited'
    answerMentioned?: boolean | null
    citedDomains?: string[]
    competitorOverlap?: string[]
    createdAt: string
  },
) {
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: args.runId,
    queryId: args.queryId,
    provider: args.provider,
    citationState: args.citationState,
    answerMentioned: args.answerMentioned ?? null,
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

test('no-data sentinel with reason "no-queries" when project has no queries', async () => {
  insertProject(ctx.db, 'empty', ['gemini'])
  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/empty/citations/visibility' })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body) as CitationVisibilityResponse
  expect(body.status).toBe('no-data')
  expect(body.reason).toBe('no-queries')
  expect(body.byQuery).toEqual([])
})

test('no-data sentinel with reason "no-runs-yet" when project has queries but no runs', async () => {
  const projectId = insertProject(ctx.db, 'fresh', ['gemini'])
  insertQuery(ctx.db, projectId, 'best CRM')
  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/fresh/citations/visibility' })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body) as CitationVisibilityResponse
  expect(body.status).toBe('no-data')
  expect(body.reason).toBe('no-runs-yet')
})

test('ready response computes coverage from latest snapshot per (query × provider)', async () => {
  const projectId = insertProject(ctx.db, 'live', ['gemini', 'claude'])
  const qA = insertQuery(ctx.db, projectId, 'query A')
  const qB = insertQuery(ctx.db, projectId, 'query B')

  const oldRun = insertRun(ctx.db, projectId, '2026-04-20T00:00:00Z')
  const newRun = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')

  // Old run — both providers, both queries, all not-cited and not-mentioned
  insertSnapshot(ctx.db, { runId: oldRun, queryId: qA, provider: 'gemini', citationState: 'not-cited', answerMentioned: false, createdAt: '2026-04-20T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: oldRun, queryId: qA, provider: 'claude', citationState: 'not-cited', answerMentioned: false, createdAt: '2026-04-20T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: oldRun, queryId: qB, provider: 'gemini', citationState: 'not-cited', answerMentioned: false, createdAt: '2026-04-20T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: oldRun, queryId: qB, provider: 'claude', citationState: 'not-cited', answerMentioned: false, createdAt: '2026-04-20T00:00:01Z' })

  // New run — gemini cites qA only; claude still cites neither but now mentions qA in prose
  insertSnapshot(ctx.db, { runId: newRun, queryId: qA, provider: 'gemini', citationState: 'cited', answerMentioned: true, createdAt: '2026-04-28T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: newRun, queryId: qA, provider: 'claude', citationState: 'not-cited', answerMentioned: true, createdAt: '2026-04-28T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: newRun, queryId: qB, provider: 'gemini', citationState: 'not-cited', answerMentioned: false, createdAt: '2026-04-28T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: newRun, queryId: qB, provider: 'claude', citationState: 'not-cited', answerMentioned: false, createdAt: '2026-04-28T00:00:01Z' })

  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/live/citations/visibility' })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body) as CitationVisibilityResponse

  expect(body.status).toBe('ready')
  expect(body.summary.providersConfigured).toBe(2)
  expect(body.summary.providersCiting).toBe(1)
  expect(body.summary.providersMentioning).toBe(2)
  expect(body.summary.totalQueries).toBe(2)
  // query A: cited (gemini) AND mentioned (gemini + claude) → cited+mentioned bucket
  // query B: nothing → invisible bucket
  expect(body.summary.queriesCitedAndMentioned).toBe(1)
  expect(body.summary.queriesCitedOnly).toBe(0)
  expect(body.summary.queriesMentionedOnly).toBe(0)
  expect(body.summary.queriesInvisible).toBe(1)
  expect(body.summary.latestRunId).toBe(newRun)

  const rowA = body.byQuery.find(r => r.query === 'query A')!
  expect(rowA.citedCount).toBe(1)
  expect(rowA.mentionedCount).toBe(2)
  expect(rowA.totalProviders).toBe(2)
  const rowAGemini = rowA.providers.find(p => p.provider === 'gemini')!
  expect(rowAGemini.cited).toBe(true)
  expect(rowAGemini.mentioned).toBe(true)
  expect(rowAGemini.runId).toBe(newRun)
  const rowAClaude = rowA.providers.find(p => p.provider === 'claude')!
  expect(rowAClaude.cited).toBe(false)
  expect(rowAClaude.mentioned).toBe(true)

  const rowB = body.byQuery.find(r => r.query === 'query B')!
  expect(rowB.citedCount).toBe(0)
  expect(rowB.mentionedCount).toBe(0)
})

test('uses observed providers when project.providers is empty', async () => {
  const projectId = insertProject(ctx.db, 'no-config', [])
  const q = insertQuery(ctx.db, projectId, 'query X')
  const run = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')
  insertSnapshot(ctx.db, { runId: run, queryId: q, provider: 'perplexity', citationState: 'cited', answerMentioned: false, createdAt: '2026-04-28T00:00:01Z' })

  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/no-config/citations/visibility' })
  const body = JSON.parse(res.body) as CitationVisibilityResponse
  expect(body.summary.providersConfigured).toBe(1)
  expect(body.summary.providersCiting).toBe(1)
  expect(body.byQuery[0]!.providers).toHaveLength(1)
  expect(body.byQuery[0]!.providers[0]!.provider).toBe('perplexity')
})

test('competitor gaps lists not-cited queries where a configured competitor appears in cited domains', async () => {
  const projectId = insertProject(ctx.db, 'gaps', ['gemini'])
  const qA = insertQuery(ctx.db, projectId, 'query A')
  const qB = insertQuery(ctx.db, projectId, 'query B')
  insertCompetitor(ctx.db, projectId, 'rival.com')
  insertCompetitor(ctx.db, projectId, 'other.com')

  const run = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')

  // Query A: not cited; rival.com appears in cited domains => gap row
  insertSnapshot(ctx.db, {
    runId: run,
    queryId: qA,
    provider: 'gemini',
    citationState: 'not-cited',
    citedDomains: ['rival.com', 'unrelated.com'],
    createdAt: '2026-04-28T00:00:01Z',
  })

  // Query B: cited; rival.com still appears, but no gap because we are cited
  insertSnapshot(ctx.db, {
    runId: run,
    queryId: qB,
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
  expect(gap.query).toBe('query A')
  expect(gap.provider).toBe('gemini')
  expect(gap.citingCompetitors).toEqual(['rival.com'])
})

test('competitor gap reads from competitorOverlap when citedDomains is empty', async () => {
  const projectId = insertProject(ctx.db, 'overlap-only', ['gemini'])
  const q = insertQuery(ctx.db, projectId, 'query X')
  insertCompetitor(ctx.db, projectId, 'rival.com')

  const run = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')
  insertSnapshot(ctx.db, {
    runId: run,
    queryId: q,
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
  const q = insertQuery(ctx.db, projectId, 'query X')
  const run = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')
  insertSnapshot(ctx.db, {
    runId: run,
    queryId: q,
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

test('cross-tab buckets are mutually exclusive over queries with snapshots', async () => {
  // Four queries, one per bucket. Single configured provider so the tests
  // are unambiguous about which bucket each query lands in.
  const projectId = insertProject(ctx.db, 'crosstab', ['gemini'])
  const qBoth = insertQuery(ctx.db, projectId, 'cited and mentioned')
  const qCitedOnly = insertQuery(ctx.db, projectId, 'cited only')
  const qMentionedOnly = insertQuery(ctx.db, projectId, 'mentioned only')
  const qInvisible = insertQuery(ctx.db, projectId, 'invisible')
  // Fifth query has no snapshots — should not count toward any bucket.
  insertQuery(ctx.db, projectId, 'no data yet')

  const run = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')
  insertSnapshot(ctx.db, { runId: run, queryId: qBoth, provider: 'gemini', citationState: 'cited', answerMentioned: true, createdAt: '2026-04-28T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: run, queryId: qCitedOnly, provider: 'gemini', citationState: 'cited', answerMentioned: false, createdAt: '2026-04-28T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: run, queryId: qMentionedOnly, provider: 'gemini', citationState: 'not-cited', answerMentioned: true, createdAt: '2026-04-28T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: run, queryId: qInvisible, provider: 'gemini', citationState: 'not-cited', answerMentioned: false, createdAt: '2026-04-28T00:00:01Z' })

  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/crosstab/citations/visibility' })
  const body = JSON.parse(res.body) as CitationVisibilityResponse

  expect(body.summary.totalQueries).toBe(5)
  expect(body.summary.queriesCitedAndMentioned).toBe(1)
  expect(body.summary.queriesCitedOnly).toBe(1)
  expect(body.summary.queriesMentionedOnly).toBe(1)
  expect(body.summary.queriesInvisible).toBe(1)
  // Sum of buckets = 4, total = 5 — the no-data query is excluded
  const sum =
    body.summary.queriesCitedAndMentioned +
    body.summary.queriesCitedOnly +
    body.summary.queriesMentionedOnly +
    body.summary.queriesInvisible
  expect(sum).toBe(4)
})

test('cited-and-mentioned bucket counts a query when different engines provide each signal', async () => {
  // Gemini cites but does not mention; OpenAI mentions but does not cite.
  // Query should land in cited+mentioned because we count "any engine" per
  // dimension at the query level.
  const projectId = insertProject(ctx.db, 'split-signals', ['gemini', 'openai'])
  const q = insertQuery(ctx.db, projectId, 'split query')
  const run = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')
  insertSnapshot(ctx.db, { runId: run, queryId: q, provider: 'gemini', citationState: 'cited', answerMentioned: false, createdAt: '2026-04-28T00:00:01Z' })
  insertSnapshot(ctx.db, { runId: run, queryId: q, provider: 'openai', citationState: 'not-cited', answerMentioned: true, createdAt: '2026-04-28T00:00:01Z' })

  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/split-signals/citations/visibility' })
  const body = JSON.parse(res.body) as CitationVisibilityResponse

  expect(body.summary.queriesCitedAndMentioned).toBe(1)
  expect(body.summary.queriesCitedOnly).toBe(0)
  expect(body.summary.queriesMentionedOnly).toBe(0)
  expect(body.summary.providersCiting).toBe(1)
  expect(body.summary.providersMentioning).toBe(1)
})

test('legacy snapshots with null answer_mentioned count as not mentioned', async () => {
  const projectId = insertProject(ctx.db, 'legacy', ['gemini'])
  const q = insertQuery(ctx.db, projectId, 'old query')
  const run = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')
  insertSnapshot(ctx.db, { runId: run, queryId: q, provider: 'gemini', citationState: 'cited', answerMentioned: null, createdAt: '2026-04-28T00:00:01Z' })

  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/legacy/citations/visibility' })
  const body = JSON.parse(res.body) as CitationVisibilityResponse

  expect(body.summary.providersMentioning).toBe(0)
  expect(body.summary.queriesCitedAndMentioned).toBe(0)
  expect(body.summary.queriesCitedOnly).toBe(1)
  expect(body.byQuery[0]!.providers[0]!.mentioned).toBe(false)
})

test('competitor matching normalizes www. and protocol on both sides', async () => {
  const projectId = insertProject(ctx.db, 'normalize', ['gemini'])
  const q = insertQuery(ctx.db, projectId, 'query X')
  // Competitor entered with www. prefix (no insert-time normalization).
  insertCompetitor(ctx.db, projectId, 'www.rival.com')
  // Second competitor entered as a full URL.
  insertCompetitor(ctx.db, projectId, 'https://other.com/')

  const run = insertRun(ctx.db, projectId, '2026-04-28T00:00:00Z')
  insertSnapshot(ctx.db, {
    runId: run,
    queryId: q,
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
