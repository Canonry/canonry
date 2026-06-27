import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  queries as queriesTable,
  runs,
  querySnapshots,
} from '@ainyc/canonry-db'
import type { PortfolioDto } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'

/**
 * Integration coverage for GET /api/v1/portfolio. Seeds one project with two
 * comparable answer-visibility sweeps where the second LOSES a citation +
 * mention, and asserts the cross-project change feed, the timestamped
 * recent-runs log (with both result signals), and the envelope counts.
 */

interface Ctx {
  app: ReturnType<typeof Fastify>
  tmpDir: string
  olderRunId: string
  newerRunId: string
}

function buildCtx(): Ctx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-portfolio-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })

  const projectId = crypto.randomUUID()
  const olderAt = '2026-06-20T00:00:00.000Z'
  const newerAt = '2026-06-27T00:00:00.000Z'

  db.insert(projects).values({
    id: projectId,
    name: 'acme',
    displayName: 'Acme',
    canonicalDomain: 'acme.example.com',
    country: 'US',
    language: 'en',
    providers: ['openai'],
    locations: [],
    createdAt: olderAt,
    updatedAt: olderAt,
  }).run()

  const queryId = crypto.randomUUID()
  db.insert(queriesTable).values({
    id: queryId,
    projectId,
    query: 'best AEO platform',
    createdAt: olderAt,
  }).run()

  // Older sweep: cited + mentioned.
  const olderRunId = crypto.randomUUID()
  db.insert(runs).values({
    id: olderRunId,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    startedAt: olderAt,
    finishedAt: olderAt,
    createdAt: olderAt,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: olderRunId,
    queryId,
    queryText: 'best AEO platform',
    provider: 'openai',
    citationState: 'cited',
    answerMentioned: true,
    citedDomains: ['acme.example.com'],
    competitorOverlap: [],
    recommendedCompetitors: [],
    answerText: 'acme.example.com is the platform.',
    createdAt: olderAt,
  }).run()

  // Newer sweep (same basket): lost the citation AND the mention.
  const newerRunId = crypto.randomUUID()
  db.insert(runs).values({
    id: newerRunId,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    startedAt: newerAt,
    finishedAt: '2026-06-27T00:00:30.000Z',
    createdAt: newerAt,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: newerRunId,
    queryId,
    queryText: 'best AEO platform',
    provider: 'openai',
    citationState: 'not-cited',
    answerMentioned: false,
    citedDomains: ['rival.example.com'],
    competitorOverlap: [],
    recommendedCompetitors: [],
    answerText: 'rival.example.com is better.',
    createdAt: newerAt,
  }).run()

  return { app, tmpDir, olderRunId, newerRunId }
}

let ctx: Ctx
beforeEach(() => { ctx = buildCtx() })
afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

async function getPortfolio(): Promise<PortfolioDto> {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/portfolio' })
  expect(res.statusCode).toBe(200)
  return res.json() as PortfolioDto
}

describe('GET /api/v1/portfolio', () => {
  it('surfaces the citation + mention loss in the change feed', async () => {
    const p = await getPortfolio()
    const kinds = p.changeFeed.map(c => c.changeType)
    expect(kinds).toContain('citation-lost')
    expect(kinds).toContain('mention-lost')
    const lost = p.changeFeed.find(c => c.changeType === 'citation-lost')!
    expect(lost.projectSlug).toBe('acme')
    expect(lost.detail).toContain('best AEO platform')
    expect(lost.tone).toBe('negative')
    // Anchored to the newer run's finish time.
    expect(lost.occurredAt).toBe('2026-06-27T00:00:30.000Z')
  })

  it('logs recent runs newest-first with both result signals joined from run history', async () => {
    const p = await getPortfolio()
    expect(p.recentRuns.map(r => r.runId)).toEqual([ctx.newerRunId, ctx.olderRunId])
    const [newer, older] = p.recentRuns
    // Newer sweep: 0/1 mentioned, 0/1 cited.
    expect(newer).toMatchObject({ mentionedCount: 0, citedCount: 0, totalCount: 1, status: 'completed' })
    expect(newer!.durationMs).toBe(30_000)
    // Older sweep: 1/1 both.
    expect(older).toMatchObject({ mentionedCount: 1, citedCount: 1, totalCount: 1 })
  })

  it('reports honest envelope counts and a freshness anchor', async () => {
    const p = await getPortfolio()
    expect(p.projectCount).toBe(1)
    expect(p.comparableProjectCount).toBe(1)
    expect(p.firstSweepProjectCount).toBe(0)
    expect(p.lastSweepAt).toBe('2026-06-27T00:00:30.000Z')
    expect(typeof p.generatedAt).toBe('string')
    expect(p.feedEmptyState).toBeNull()
  })

  it('renders the project state row with distinct mention and cited signals', async () => {
    const p = await getPortfolio()
    const row = p.projects.find(r => r.projectSlug === 'acme')!
    // Latest (newer) sweep state: not mentioned, not cited.
    expect(row.mentionedOfTotal).toEqual({ mentioned: 0, total: 1 })
    expect(row.citedOfTotal).toEqual({ cited: 0, total: 1 })
    expect(row.mentionDelta).toMatchObject({ lost: 1, comparable: true })
    expect(row.citationDelta).toMatchObject({ lost: 1, comparable: true })
    expect(row.hasEverRun).toBe(true)
  })

  it('returns the awaiting-second-sweep empty state for a single-run portfolio', async () => {
    // A fresh project with only ONE sweep cannot compute movement → the feed
    // is empty and resolves to the honest "no comparison yet" state, never the
    // old "All projects stable" lie.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-portfolio-single-'))
    const db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    const app = Fastify()
    app.register(apiRoutes, { db, skipAuth: true })
    const projectId = crypto.randomUUID()
    const at = '2026-06-27T00:00:00.000Z'
    db.insert(projects).values({
      id: projectId, name: 'solo', displayName: 'Solo', canonicalDomain: 'solo.example.com',
      country: 'US', language: 'en', providers: ['openai'], locations: [], createdAt: at, updatedAt: at,
    }).run()
    const qid = crypto.randomUUID()
    db.insert(queriesTable).values({ id: qid, projectId, query: 'q', createdAt: at }).run()
    const runId = crypto.randomUUID()
    db.insert(runs).values({
      id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
      startedAt: at, finishedAt: at, createdAt: at,
    }).run()
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(), runId, queryId: qid, queryText: 'q', provider: 'openai',
      citationState: 'cited', answerMentioned: true, citedDomains: ['solo.example.com'],
      competitorOverlap: [], recommendedCompetitors: [], answerText: 'solo wins', createdAt: at,
    }).run()

    const res = await app.inject({ method: 'GET', url: '/api/v1/portfolio' })
    const body = res.json() as PortfolioDto
    expect(body.changeFeed).toHaveLength(0)
    expect(body.feedEmptyState?.kind).toBe('awaiting-second-sweep')
    expect(body.comparableProjectCount).toBe(0)
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
