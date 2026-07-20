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
import { apiRoutes } from '../src/index.js'

/**
 * `GET /projects/:name/timeline` derives everything it returns from
 * `query_snapshots`, and only `answer-visibility` runs write those. Every
 * other run kind (`traffic-sync`, `gsc-sync`, `ga-sync`, …) contributes no
 * data but still occupies a slot in the `?limit=N` window.
 *
 * A real project syncs traffic every ~30 minutes and sweeps roughly twice a
 * month, so the newest N runs are almost always pure integration syncs. The
 * dashboard asks for `?limit=20`, which selected ~10 hours of traffic syncs
 * and zero sweeps — the timeline came back with `runs: []` for every query
 * and the "Query evidence" panel rendered "Awaiting first run" against months
 * of real history.
 *
 * This file locks the invariant: the timeline's run window is measured in
 * SWEEPS, not in runs of any kind. It seeds one completed answer-visibility
 * run with snapshots, then buries it under 25 newer `traffic-sync` runs —
 * more than the limit under test, so an unfiltered query cannot reach it.
 */

interface Ctx {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  sweepRunId: string
}

const PROJECT = 'timeline-run-kind'

/** Runs created AFTER the sweep, enough to fully displace it at limit=20. */
const TRAFFIC_SYNC_COUNT = 25

function buildCtx(): Ctx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-timeline-kind-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })

  const now = Date.now()
  // The sweep is the OLDEST run on the project.
  const sweepCreatedAt = new Date(now - (TRAFFIC_SYNC_COUNT + 1) * 60_000).toISOString()

  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: PROJECT,
    displayName: 'Timeline Run Kind',
    canonicalDomain: 'real-brand.example.com',
    country: 'US',
    language: 'en',
    providers: ['openai'],
    locations: [],
    createdAt: sweepCreatedAt,
    updatedAt: sweepCreatedAt,
  }).run()

  const queryId = crypto.randomUUID()
  db.insert(queriesTable).values({
    id: queryId,
    projectId,
    query: 'best AEO platform',
    createdAt: sweepCreatedAt,
  }).run()

  // The only snapshot-bearing run.
  const sweepRunId = crypto.randomUUID()
  db.insert(runs).values({
    id: sweepRunId,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    createdAt: sweepCreatedAt,
    finishedAt: sweepCreatedAt,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: sweepRunId,
    queryId,
    queryText: 'best AEO platform',
    provider: 'openai',
    citationState: 'cited',
    answerMentioned: true,
    citedDomains: ['real-brand.example.com'],
    competitorOverlap: [],
    recommendedCompetitors: [],
    answerText: 'real-brand.example.com is the canonical AEO platform.',
    rawResponse: JSON.stringify({ groundingSources: [] }),
    createdAt: sweepCreatedAt,
  }).run()

  // Integration syncs, all newer than the sweep. These carry no snapshots.
  for (let i = 0; i < TRAFFIC_SYNC_COUNT; i++) {
    const createdAt = new Date(now - (TRAFFIC_SYNC_COUNT - i) * 60_000).toISOString()
    db.insert(runs).values({
      id: crypto.randomUUID(),
      projectId,
      kind: 'traffic-sync',
      status: 'completed',
      trigger: 'scheduled',
      createdAt,
      finishedAt: createdAt,
    }).run()
  }

  return { app, db, tmpDir, sweepRunId }
}

let ctx: Ctx

beforeEach(() => { ctx = buildCtx() })
afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

type TimelineBody = Array<{
  query: string
  runs: Array<{ runId: string }>
  providerRuns?: Record<string, Array<{ runId: string }>>
}>

async function getTimeline(query: string): Promise<TimelineBody> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/projects/${PROJECT}/timeline${query}`,
  })
  expect(res.statusCode).toBe(200)
  return res.json() as TimelineBody
}

describe('timeline run window counts sweeps, not runs of every kind', () => {
  it('?limit=20 still surfaces the sweep buried under 25 newer traffic-sync runs', async () => {
    // This is the exact call the project dashboard makes
    // (DASHBOARD_TIMELINE_RUN_LIMIT = 20). Before the run-kind filter, the
    // newest 20 runs were all traffic-syncs and this came back as 0.
    const body = await getTimeline('?limit=20')
    expect(body).toHaveLength(1)
    const entry = body[0]!
    expect(entry.query).toBe('best AEO platform')
    expect(entry.runs).toHaveLength(1)
    expect(entry.runs[0]!.runId).toBe(ctx.sweepRunId)
    expect(entry.providerRuns?.openai).toHaveLength(1)
  })

  it('a small limit selects the newest sweeps, unaffected by interleaved sync runs', async () => {
    // limit=1 is the tightest window there is; the single sweep must still win.
    const body = await getTimeline('?limit=1')
    expect(body[0]?.runs.map(r => r.runId)).toEqual([ctx.sweepRunId])
  })

  it('the unlimited response matches the limited one (no other kind ever contributed)', async () => {
    const unlimited = await getTimeline('')
    const limited = await getTimeline('?limit=20')
    expect(unlimited).toEqual(limited)
    expect(unlimited[0]?.runs.map(r => r.runId)).toEqual([ctx.sweepRunId])
  })
})
