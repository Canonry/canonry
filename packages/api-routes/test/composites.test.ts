import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createClient,
  migrate,
  insights,
  healthSnapshots,
  keywords,
  projects,
  querySnapshots,
  runs,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'
import type { ProjectOverviewDto, ProjectSearchResponseDto } from '@ainyc/canonry-contracts'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-composites-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true } satisfies ApiRoutesOptions)

  return { app, db, tmpDir }
}

const cleanups: Array<() => void> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0)) fn()
})

function seedProjectWithRuns() {
  const { app, db, tmpDir } = buildApp()
  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const projectId = crypto.randomUUID()
  const previousRunId = crypto.randomUUID()
  const latestRunId = crypto.randomUUID()
  const keywordA = crypto.randomUUID()
  const keywordB = crypto.randomUUID()

  db.insert(projects).values({
    id: projectId,
    name: 'demo',
    displayName: 'Demo',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    ownedDomains: '[]',
    tags: '[]',
    providers: '[]',
    createdAt: '2026-04-18T14:00:00.000Z',
    updatedAt: '2026-04-18T14:00:00.000Z',
  }).run()
  db.insert(keywords).values([
    { id: keywordA, projectId, keyword: 'answer engine optimization', createdAt: '2026-04-18T14:05:00.000Z' },
    { id: keywordB, projectId, keyword: 'aeo monitoring', createdAt: '2026-04-18T14:05:00.000Z' },
  ]).run()
  db.insert(runs).values([
    { id: previousRunId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: '2026-04-18T14:10:00.000Z', finishedAt: '2026-04-18T14:11:00.000Z' },
    { id: latestRunId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: '2026-04-18T14:20:00.000Z', finishedAt: '2026-04-18T14:21:00.000Z' },
  ]).run()
  // previous run: A cited (gemini), B not cited
  db.insert(querySnapshots).values([
    { id: crypto.randomUUID(), runId: previousRunId, keywordId: keywordA, provider: 'gemini', citationState: 'cited', answerMentioned: true, citedDomains: '["example.com"]', competitorOverlap: '[]', recommendedCompetitors: '[]', answerText: 'Example.com is the leader in answer engine optimization.', createdAt: '2026-04-18T14:10:30.000Z' },
    { id: crypto.randomUUID(), runId: previousRunId, keywordId: keywordB, provider: 'gemini', citationState: 'not-cited', answerMentioned: false, citedDomains: '[]', competitorOverlap: '[]', recommendedCompetitors: '[]', answerText: null, createdAt: '2026-04-18T14:10:30.000Z' },
  ]).run()
  // latest run: A still cited, B newly cited (gained), plus an openai snapshot for variety
  db.insert(querySnapshots).values([
    { id: crypto.randomUUID(), runId: latestRunId, keywordId: keywordA, provider: 'gemini', citationState: 'cited', answerMentioned: true, citedDomains: '["example.com"]', competitorOverlap: '[]', recommendedCompetitors: '[]', answerText: 'Example.com is the leader in answer engine optimization. Rival.com is the runner-up.', createdAt: '2026-04-18T14:20:30.000Z' },
    { id: crypto.randomUUID(), runId: latestRunId, keywordId: keywordB, provider: 'gemini', citationState: 'cited', answerMentioned: true, citedDomains: '["example.com"]', competitorOverlap: '[]', recommendedCompetitors: '[]', answerText: 'Example.com offers AEO monitoring tools.', createdAt: '2026-04-18T14:20:30.000Z' },
    { id: crypto.randomUUID(), runId: latestRunId, keywordId: keywordA, provider: 'openai', citationState: 'not-cited', answerMentioned: false, citedDomains: '[]', competitorOverlap: '[]', recommendedCompetitors: '[]', answerText: null, createdAt: '2026-04-18T14:20:30.000Z' },
  ]).run()
  db.insert(healthSnapshots).values({
    id: crypto.randomUUID(),
    projectId,
    runId: latestRunId,
    overallCitedRate: '0.6667',
    totalPairs: 3,
    citedPairs: 2,
    providerBreakdown: '{}',
    createdAt: '2026-04-18T14:21:00.000Z',
  }).run()
  // Two insights, one dismissed
  db.insert(insights).values([
    { id: crypto.randomUUID(), projectId, runId: latestRunId, type: 'gain', severity: 'high', title: 'Newly cited for "aeo monitoring"', keyword: 'aeo monitoring', provider: 'gemini', recommendation: null, cause: null, dismissed: false, createdAt: '2026-04-18T14:21:30.000Z' },
    { id: crypto.randomUUID(), projectId, runId: latestRunId, type: 'opportunity', severity: 'medium', title: 'Rival.com appears alongside example.com', keyword: 'answer engine optimization', provider: 'gemini', recommendation: null, cause: null, dismissed: true, createdAt: '2026-04-18T14:21:35.000Z' },
  ]).run()

  return { app, db, projectId, latestRunId, previousRunId, keywordA, keywordB }
}

describe('GET /api/v1/projects/:name/overview', () => {
  it('returns project info, latest run, top insights, health, and transitions in one call', async () => {
    const { app, latestRunId, previousRunId } = seedProjectWithRuns()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/overview' })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.payload) as ProjectOverviewDto
    expect(body.project.name).toBe('demo')
    expect(body.latestRun.totalRuns).toBe(2)
    expect(body.latestRun.run?.id).toBe(latestRunId)
    expect(body.latestRun.run?.snapshots).toBeUndefined()
    expect(body.health?.totalPairs).toBe(3)
    expect(body.topInsights).toHaveLength(1)
    expect(body.topInsights[0]?.dismissed).toBe(false)
    expect(body.keywordCounts).toEqual({
      totalKeywords: 2,
      citedKeywords: 2,
      notCitedKeywords: 0,
      citedRate: 1,
    })
    expect(body.providers.map(p => p.provider)).toEqual(['gemini', 'openai'])
    expect(body.transitions.since).toBe('2026-04-18T14:10:00.000Z')
    expect(body.transitions.gained).toBe(1)
    expect(body.transitions.lost).toBe(0)
    expect(body.transitions.emerging).toBe(0)
    // Cross-check that both runs exist; transitions used the previous one.
    expect(previousRunId).toBeTruthy()

    await app.close()
  })

  it('returns empty counts and null transitions when project has no runs', async () => {
    const { app, db, tmpDir } = buildApp()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    await app.ready()

    db.insert(projects).values({
      id: crypto.randomUUID(),
      name: 'empty',
      displayName: 'Empty',
      canonicalDomain: 'empty.example.com',
      country: 'US',
      language: 'en',
      ownedDomains: '[]',
      tags: '[]',
      providers: '[]',
      createdAt: '2026-04-18T14:00:00.000Z',
      updatedAt: '2026-04-18T14:00:00.000Z',
    }).run()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/empty/overview' })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.payload) as ProjectOverviewDto
    expect(body.latestRun).toEqual({ totalRuns: 0, run: null })
    expect(body.health).toBeNull()
    expect(body.topInsights).toEqual([])
    expect(body.keywordCounts).toEqual({ totalKeywords: 0, citedKeywords: 0, notCitedKeywords: 0, citedRate: 0 })
    expect(body.providers).toEqual([])
    expect(body.transitions).toEqual({ since: null, gained: 0, lost: 0, emerging: 0 })

    await app.close()
  })
})

describe('GET /api/v1/projects/:name/search', () => {
  it('finds matches in snapshot answers and insight titles', async () => {
    const { app } = seedProjectWithRuns()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/search?q=rival' })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.payload) as ProjectSearchResponseDto
    expect(body.query).toBe('rival')
    expect(body.totalHits).toBeGreaterThan(0)
    expect(body.hits.some(h => h.kind === 'snapshot' && h.matchedField === 'answerText')).toBe(true)
    expect(body.hits.some(h => h.kind === 'insight' && h.matchedField === 'title')).toBe(true)

    await app.close()
  })

  it('rejects queries shorter than 2 chars', async () => {
    const { app } = seedProjectWithRuns()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/search?q=a' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error.code).toBe('VALIDATION_ERROR')

    await app.close()
  })

  it('escapes LIKE wildcards so a literal % matches no rows', async () => {
    const { app } = seedProjectWithRuns()
    await app.ready()

    // %25%25 → "%%". A naive LIKE pattern would match every non-empty answer
    // text. With ESCAPE clause it matches no rows because no answer contains
    // a literal "%%".
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/search?q=%25%25' })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.payload) as ProjectSearchResponseDto
    expect(body.totalHits).toBe(0)

    await app.close()
  })

  it('respects the limit parameter', async () => {
    const { app } = seedProjectWithRuns()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/search?q=example&limit=1' })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.payload) as ProjectSearchResponseDto
    expect(body.hits).toHaveLength(1)
    expect(body.truncated).toBe(true)

    await app.close()
  })
})
