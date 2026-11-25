import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunKinds, RunStatuses, RunTriggers, type HealthSnapshotDto, type ProjectOverviewDto, type VisibilityReportResponse } from '@canonry/canonry-contracts'
import { createClient, healthSnapshots, migrate, projects, queries, querySnapshots, runs } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'

/**
 * A spot check is a run limited to a list of queries (`runs.queries`) or to a
 * slice of a measurement plan (`runs.measurement_scope`). It stores real
 * answers for what it asked, but it is never a whole-project sweep: drawn as a
 * trend point it reads as a crash (2 of 15 queries measured, 0% cited), and
 * picked as the latest sweep it reports a slice as the whole basket.
 *
 * The seed is one Simple project with two queries and four runs, newest last:
 *
 *   10:00 full sweep   A cited + mentioned, B neither        → 50% / 50%
 *   10:30 spot check   B only: cited + mentioned
 *   11:00 full sweep   A and B cited + mentioned             → 100% / 100%
 *   11:30 spot check   A only: neither
 *
 * The spot check between the sweeps would hide B's gain if it were taken as
 * the previous sweep. The one after would zero the headline if it were taken
 * as the latest. Every surface below must read the two full sweeps only.
 */

const A = 'best aeo platform'
const B = 'aeo monitoring tools'

interface Ctx {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  previousSweep: { id: string; createdAt: string; finishedAt: string }
  latestSweep: { id: string; createdAt: string; finishedAt: string }
  spotBetween: string
  spotAfter: string
}

function buildCtx(): Ctx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-spot-check-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })

  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'spot',
    displayName: 'Spot Brand',
    canonicalDomain: 'spot.example.com',
    country: 'US',
    language: 'en',
    providers: ['openai'],
    locations: [],
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-01T09:00:00.000Z',
  }).run()
  const queryA = crypto.randomUUID()
  const queryB = crypto.randomUUID()
  db.insert(queries).values([
    { id: queryA, projectId, query: A, createdAt: '2026-11-01T09:00:00.000Z' },
    { id: queryB, projectId, query: B, createdAt: '2026-11-01T09:00:00.000Z' },
  ]).run()

  const run = (createdAt: string, scopedQueries: string[] | null) => {
    const id = crypto.randomUUID()
    const finishedAt = createdAt.replace(':00.000Z', ':50.000Z')
    db.insert(runs).values({
      id,
      projectId,
      kind: RunKinds['answer-visibility'],
      status: RunStatuses.completed,
      trigger: RunTriggers.manual,
      queries: scopedQueries,
      createdAt,
      finishedAt,
    }).run()
    return { id, createdAt, finishedAt }
  }
  const answer = (runId: string, queryId: string, createdAt: string, cited: boolean) => {
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      queryId,
      provider: 'openai',
      citationState: cited ? 'cited' : 'not-cited',
      answerMentioned: cited,
      citedDomains: cited ? ['spot.example.com'] : ['other.example.com'],
      competitorOverlap: [],
      recommendedCompetitors: [],
      answerText: cited ? 'Spot Brand (spot.example.com) is the pick.' : 'Other tools exist.',
      createdAt,
    }).run()
  }
  const health = (runId: string, createdAt: string, totalPairs: number, citedPairs: number) => {
    db.insert(healthSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      runId,
      overallCitedRate: String(citedPairs / totalPairs),
      overallMentionRate: String(citedPairs / totalPairs),
      totalPairs,
      citedPairs,
      mentionedPairs: citedPairs,
      providerBreakdown: {},
      createdAt,
    }).run()
  }

  const previousSweep = run('2026-11-10T10:00:00.000Z', null)
  answer(previousSweep.id, queryA, previousSweep.createdAt, true)
  answer(previousSweep.id, queryB, previousSweep.createdAt, false)
  health(previousSweep.id, previousSweep.finishedAt, 2, 1)

  const spotBetween = run('2026-11-10T10:30:00.000Z', [B])
  answer(spotBetween.id, queryB, spotBetween.createdAt, true)
  health(spotBetween.id, spotBetween.finishedAt, 1, 1)

  const latestSweep = run('2026-11-10T11:00:00.000Z', null)
  answer(latestSweep.id, queryA, latestSweep.createdAt, true)
  answer(latestSweep.id, queryB, latestSweep.createdAt, true)
  health(latestSweep.id, latestSweep.finishedAt, 2, 2)

  const spotAfter = run('2026-11-10T11:30:00.000Z', [A])
  answer(spotAfter.id, queryA, spotAfter.createdAt, false)
  health(spotAfter.id, spotAfter.finishedAt, 1, 0)

  return { app, db, tmpDir, previousSweep, latestSweep, spotBetween: spotBetween.id, spotAfter: spotAfter.id }
}

let ctx: Ctx

beforeEach(() => { ctx = buildCtx() })
afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

async function get<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await ctx.app.inject({ method: 'GET', url })
  return { status: res.statusCode, body: res.json() as T }
}

describe('spot checks stay out of sweep series and latest-sweep picks', () => {
  it('overview trends plot the two sweeps only', async () => {
    const { body } = await get<ProjectOverviewDto>('/api/v1/projects/spot/overview')
    expect(body.runHistory.map(point => ({
      runId: point.runId,
      cited: point.citedCount,
      mentioned: point.mentionedCount,
      total: point.totalCount,
      citationRate: point.citationRate,
      mentionRate: point.mentionRate,
    }))).toEqual([
      { runId: ctx.previousSweep.id, cited: 1, mentioned: 1, total: 2, citationRate: 50, mentionRate: 50 },
      { runId: ctx.latestSweep.id, cited: 2, mentioned: 2, total: 2, citationRate: 100, mentionRate: 100 },
    ])
    expect(body.scores.mention.trend).toEqual([50, 100])
    expect(body.scores.visibility.trend).toEqual([50, 100])
    expect(body.providerScores.map(score => ({ provider: score.provider, trend: score.trend }))).toEqual([
      { provider: 'openai', trend: [50, 100] },
    ])
  })

  it('overview headline and movement read the latest sweep against the sweep before it', async () => {
    const { body } = await get<ProjectOverviewDto>('/api/v1/projects/spot/overview')
    // The newest run of any kind is still the spot check, and it still counts.
    expect(body.latestRun.run?.id).toBe(ctx.spotAfter)
    expect(body.latestRun.totalRuns).toBe(4)
    // If the 11:30 spot check were the latest, this would be 0 of 1.
    expect(body.queryCounts).toMatchObject({ totalQueries: 2, citedQueries: 2, mentionedQueries: 2 })
    expect(body.mentionCoverage.selection.run).toEqual({ id: ctx.latestSweep.id, explicit: false })
    // If the 10:30 spot check were the previous sweep, B would already be
    // cited and the gain would disappear.
    expect(body.transitions.since).toBe(ctx.previousSweep.createdAt)
    expect(body.movementSummary).toMatchObject({ gained: 1, lost: 0, gainedQueries: [B] })
    expect(body.mentionMovement).toMatchObject({ gained: 1, lost: 0, gainedQueries: [B] })
    expect(body.movementComparison).toMatchObject({ previousRunAt: ctx.previousSweep.createdAt, comparable: true })
    expect(body.whatChanged.latestCheck?.runIds).toEqual([ctx.latestSweep.id])
    // The spot check's own health row (1 pair, 0 cited) is not the headline.
    expect(body.health).toMatchObject({ runId: ctx.latestSweep.id, totalPairs: 2, citedPairs: 2 })
  })

  it('health latest and history skip the spot checks', async () => {
    const latest = await get<HealthSnapshotDto>('/api/v1/projects/spot/health/latest')
    expect(latest.body).toMatchObject({ runId: ctx.latestSweep.id, totalPairs: 2, citedPairs: 2, status: 'ready' })

    const history = await get<HealthSnapshotDto[]>('/api/v1/projects/spot/health/history')
    expect(history.body.map(row => ({ runId: row.runId, totalPairs: row.totalPairs, citedPairs: row.citedPairs }))).toEqual([
      { runId: ctx.latestSweep.id, totalPairs: 2, citedPairs: 2 },
      { runId: ctx.previousSweep.id, totalPairs: 2, citedPairs: 1 },
    ])
  })

  it('visibility report selects the latest sweep and charts the two sweeps', async () => {
    const { status, body } = await get<VisibilityReportResponse>('/api/v1/projects/spot/visibility-report?queryClass=all')
    expect(status).toBe(200)
    expect(body.selection.run).toEqual({ id: ctx.latestSweep.id, explicit: false })
    // These planless runs carry no frozen class split, so each population's
    // trend holds the runs without class rates; which runs it holds is the
    // contract here. A leaked spot check would add a point between and after.
    const previousRun = { id: ctx.previousSweep.id, createdAt: ctx.previousSweep.createdAt, completedAt: ctx.previousSweep.finishedAt }
    for (const population of body.populations) {
      expect(population.trend.map(point => point.runId)).toEqual([ctx.previousSweep.id, ctx.latestSweep.id])
      // The sweep named as previous is the 10:00 sweep, not the 10:30 spot check.
      expect(population.comparison).toEqual({ state: 'unavailable', reason: 'legacy-unknown', previousRun })
    }
  })

  it('a spot check pinned by id is still readable, and never compared', async () => {
    const { status, body } = await get<VisibilityReportResponse>(`/api/v1/projects/spot/visibility-report?queryClass=all&runId=${ctx.spotAfter}`)
    expect(status).toBe(200)
    expect(body.selection.run).toEqual({ id: ctx.spotAfter, explicit: true })
    expect(body.populations.map(population => population.comparison)).toEqual([
      { state: 'unavailable', reason: 'scoped-run', previousRun: null },
      { state: 'unavailable', reason: 'scoped-run', previousRun: null },
      { state: 'unavailable', reason: 'scoped-run', previousRun: null },
    ])
  })

  it('analytics metrics pool the two sweeps only', async () => {
    const { body } = await get<{ overall: { cited: number; total: number; citationRate: number } }>(
      '/api/v1/projects/spot/analytics/metrics',
    )
    // Sweeps: 3 cited of 4 answers. With the spot checks it would be 4 of 6.
    expect(body.overall).toMatchObject({ cited: 3, total: 4, citationRate: 0.75 })
  })

  it('analytics gaps and the competitor landscape read the latest sweep', async () => {
    const gaps = await get<{ runId: string | null; cited: Array<{ query: string }> }>('/api/v1/projects/spot/analytics/gaps')
    expect(gaps.body.runId).toBe(ctx.latestSweep.id)
    expect(gaps.body.cited.map(row => row.query).sort()).toEqual([B, A].sort())

    const landscape = await get<{ runIds: string[] }>('/api/v1/projects/spot/analytics/competitors?runId=latest')
    expect(landscape.body.runIds).toEqual([ctx.latestSweep.id])
  })

  it('analytics sources refuses a pinned spot check with a reason that names it', async () => {
    const { status, body } = await get<{ error: { code: string; message: string } }>(
      `/api/v1/projects/spot/analytics/sources?runId=${ctx.spotBetween}`,
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toBe(`Run "${ctx.spotBetween}" is a spot check that measured only some queries, so it is excluded from source analytics.`)
  })
})
