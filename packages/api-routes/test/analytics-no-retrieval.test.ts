import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { createClient, migrate, projects, queries, runs, querySnapshots } from '@canonry/canonry-db'
import { brandMetricsDtoSchema } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-no-retrieval-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })

  return { app, db, tmpDir }
}

function seedProject(db: ReturnType<typeof createClient>, name: string) {
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name,
    displayName: name,
    canonicalDomain: 'example.com',
    ownedDomains: '[]',
    country: 'US',
    language: 'en',
    tags: '[]',
    labels: '{}',
    providers: '["gemini","openai"]',
    locations: '[]',
    defaultLocation: null,
    configSource: 'api',
    configRevision: 1,
    createdAt: now,
    updatedAt: now,
  }).run()
  return projectId
}

function seedRun(db: ReturnType<typeof createClient>, projectId: string) {
  const runId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(runs).values({
    id: runId,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    location: null,
    startedAt: now,
    finishedAt: now,
    error: null,
    createdAt: now,
  }).run()
  return runId
}

function seedSnapshot(
  db: ReturnType<typeof createClient>,
  runId: string,
  values: { queryId: string; provider: string; citationState: string; answerMentioned: boolean; retrievalStatus: string | null },
) {
  // Mention is recomputed from answerText whenever text is stored, so the
  // text must agree with the stored boolean — a mentioning text on a
  // not-mentioned row would resolve to mentioned.
  const answerText = values.answerMentioned ? 'Example.com is great...' : 'A generic answer about SEO tools.'
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId,
    queryId: values.queryId,
    provider: values.provider,
    model: 'test-model',
    citationState: values.citationState,
    answerMentioned: values.answerMentioned,
    retrievalStatus: values.retrievalStatus,
    answerText,
    citedDomains: [],
    competitorOverlap: [],
    location: null,
    rawResponse: '{}',
    createdAt: new Date().toISOString(),
  }).run()
}

describe('analytics metrics excludes no-retrieval answers from the cited rate (#1161)', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()

    // Mixed project: 4 answers, 1 written with no web search.
    const projectId = seedProject(db, 'no-retrieval-site')
    const q1Id = crypto.randomUUID()
    const q2Id = crypto.randomUUID()
    db.insert(queries).values([
      { id: q1Id, projectId, query: 'best seo tools', createdAt: new Date().toISOString() },
      { id: q2Id, projectId, query: 'aeo monitoring', createdAt: new Date().toISOString() },
    ]).run()
    const runId = seedRun(db, projectId)
    // Searched + cited.
    seedSnapshot(db, runId, { queryId: q1Id, provider: 'gemini', citationState: 'cited', answerMentioned: true, retrievalStatus: 'used' })
    // Searched, not cited — a genuine miss.
    seedSnapshot(db, runId, { queryId: q1Id, provider: 'openai', citationState: 'not-cited', answerMentioned: true, retrievalStatus: 'used' })
    // Searched, not cited, not mentioned.
    seedSnapshot(db, runId, { queryId: q2Id, provider: 'gemini', citationState: 'not-cited', answerMentioned: false, retrievalStatus: 'used' })
    // Written with no web search: cites nothing by construction, and still
    // mentions the brand from weights — it must leave the cited rate but
    // stay in the mention rate.
    seedSnapshot(db, runId, { queryId: q2Id, provider: 'openai', citationState: 'not-cited', answerMentioned: true, retrievalStatus: 'not-used' })

    // All-no-retrieval project: the cited denominator is empty, so the rate
    // is 0 rather than undefined, and every answer is excluded.
    const emptyProjectId = seedProject(db, 'all-no-retrieval-site')
    const q3Id = crypto.randomUUID()
    db.insert(queries).values([
      { id: q3Id, projectId: emptyProjectId, query: 'best seo tools', createdAt: new Date().toISOString() },
    ]).run()
    const emptyRunId = seedRun(db, emptyProjectId)
    seedSnapshot(db, emptyRunId, { queryId: q3Id, provider: 'gemini', citationState: 'not-cited', answerMentioned: true, retrievalStatus: 'not-used' })
    seedSnapshot(db, emptyRunId, { queryId: q3Id, provider: 'openai', citationState: 'not-cited', answerMentioned: false, retrievalStatus: 'not-used' })
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('excludes not-used answers from the cited rate but keeps them in the mention rate', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/no-retrieval-site/analytics/metrics' })
    expect(res.statusCode).toBe(200)
    const body = brandMetricsDtoSchema.parse(JSON.parse(res.body))

    // Cited rate is 1 cited / 3 searched (0.3333), not 1 / 4.
    expect(body.overall.total).toBe(4)
    expect(body.overall.cited).toBe(1)
    expect(body.overall.citationRate).toBe(0.3333)
    expect(body.overall.excludedNoRetrieval).toBe(1)
    // Mention rate still reads the full population: 3 mentioned / 4.
    expect(body.overall.mentionedCount).toBe(3)
    expect(body.overall.mentionRate).toBe(0.75)

    // Per-provider: gemini searched both answers, openai left one out.
    expect(body.byProvider.gemini?.citationRate).toBe(0.5)
    expect(body.byProvider.gemini?.total).toBe(2)
    expect(body.byProvider.gemini?.excludedNoRetrieval).toBeUndefined()
    expect(body.byProvider.openai?.citationRate).toBe(0)
    expect(body.byProvider.openai?.cited).toBe(0)
    expect(body.byProvider.openai?.total).toBe(2)
    expect(body.byProvider.openai?.excludedNoRetrieval).toBe(1)

    // The single bucket carries the same exclusion.
    expect(body.buckets).toHaveLength(1)
    expect(body.buckets[0]?.citationRate).toBe(0.3333)
    expect(body.buckets[0]?.total).toBe(4)
    expect(body.buckets[0]?.excludedNoRetrieval).toBe(1)
    expect(body.buckets[0]?.mentionRate).toBe(0.75)
  })

  it('reports a zero cited rate with every answer excluded when nothing was searched', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/all-no-retrieval-site/analytics/metrics' })
    expect(res.statusCode).toBe(200)
    const body = brandMetricsDtoSchema.parse(JSON.parse(res.body))

    expect(body.overall.total).toBe(2)
    expect(body.overall.cited).toBe(0)
    expect(body.overall.citationRate).toBe(0)
    expect(body.overall.excludedNoRetrieval).toBe(2)
    // Mention still reads the full population: 1 mentioned / 2.
    expect(body.overall.mentionedCount).toBe(1)
    expect(body.overall.mentionRate).toBe(0.5)
  })
})
