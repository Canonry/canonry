import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, runs } from '@ainyc/canonry-db'
import { RunKinds, RunStatuses, RunTriggers, type RunStatus } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'

/**
 * Regression coverage for the dashboard's "Awaiting first run" bug:
 *
 * PR #580 (perf(dashboard): cap GET /runs) capped the response at 500 rows
 * to stop the dashboard from pulling multi-MB JSON on cold load. On busy
 * projects, integration syncs (bing-inspect, gsc-sync, ga-sync) fire on a
 * tight cron and can fill that 500-row window in under an hour, pushing
 * answer-visibility runs out of the response. The dashboard then has no
 * latest-run-id to fan out from and renders every tracked query as
 * "Awaiting first run" — even though the runs and snapshots exist.
 *
 * The `?kind=` filter lets the dashboard scope its query to just the run
 * kind it actually consumes (`answer-visibility`), so integration syncs
 * never displace what it needs. These tests pin that the server honours
 * the filter and rejects typos rather than silently returning empty.
 *
 * `?status=` had the worse failure: both list routes accepted the param and
 * ignored it, so `GET /runs?status=running&limit=20` returned 20 completed
 * rows. The status suites below pin that the filter is applied, combines
 * with `?kind=`, and rejects unknown values the same way.
 */

interface Ctx {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  projectId: string
  bingRunIds: string[]
  answerVisibilityRunIds: string[]
  runningRunIds: string[]
  queuedRunId: string
  failedRunId: string
}

/** 20 bing-inspect + 3 answer-visibility + 4 gsc-sync (2 running, 1 queued, 1 failed). */
const SEEDED_TOTAL = 27
const ALL_STATUSES = Object.values(RunStatuses)

function buildCtx(): Ctx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-runs-filter-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })

  const now = Date.now()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'runs-filter',
    displayName: 'Runs Filter',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: ['openai'],
    locations: [],
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
  }).run()

  // Seed the exact pattern that breaks the dashboard: lots of integration
  // sync runs created NEWER than the answer-visibility run. With a small
  // cap (we use limit=10 in the test instead of the production 500), the
  // unfiltered list returns only bing-inspect rows and zero
  // answer-visibility rows. The filter must surface the older
  // answer-visibility run anyway.
  const bingRunIds: string[] = []
  for (let i = 0; i < 20; i++) {
    const id = crypto.randomUUID()
    bingRunIds.push(id)
    const createdAt = new Date(now - i * 1_000).toISOString() // newer than the AV run
    db.insert(runs).values({
      id,
      projectId,
      kind: 'bing-inspect',
      status: 'completed',
      trigger: 'manual',
      startedAt: createdAt,
      finishedAt: createdAt,
      createdAt,
    }).run()
  }

  const answerVisibilityRunIds: string[] = []
  for (let i = 0; i < 3; i++) {
    const id = crypto.randomUUID()
    answerVisibilityRunIds.push(id)
    const createdAt = new Date(now - 60_000 - i * 1_000).toISOString() // older than the bing runs
    db.insert(runs).values({
      id,
      projectId,
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      startedAt: createdAt,
      finishedAt: createdAt,
      createdAt,
    }).run()
  }

  // Status variety on a third kind so the kind assertions above stay exact:
  // two in-flight syncs, one queued, one failed. All older than the
  // answer-visibility runs so the small-limit repro still sees bing only.
  const seedStatusRun = (status: RunStatus, offsetMs: number): string => {
    const id = crypto.randomUUID()
    const createdAt = new Date(now - 120_000 - offsetMs).toISOString()
    db.insert(runs).values({
      id,
      projectId,
      kind: RunKinds['gsc-sync'],
      status,
      trigger: RunTriggers.scheduled,
      startedAt: status === RunStatuses.queued ? null : createdAt,
      finishedAt: status === RunStatuses.failed ? createdAt : null,
      createdAt,
    }).run()
    return id
  }
  const runningRunIds = [seedStatusRun(RunStatuses.running, 0), seedStatusRun(RunStatuses.running, 1_000)]
  const queuedRunId = seedStatusRun(RunStatuses.queued, 2_000)
  const failedRunId = seedStatusRun(RunStatuses.failed, 3_000)

  return { app, db, tmpDir, projectId, bingRunIds, answerVisibilityRunIds, runningRunIds, queuedRunId, failedRunId }
}

let ctx: Ctx

beforeEach(() => { ctx = buildCtx() })
afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await ctx.app.inject({ method: 'GET', url: path })
  return { status: res.statusCode, body: res.json() as T }
}

describe('GET /runs ?kind= filter', () => {
  it('without the filter, a small limit returns only the newest kind (the bug)', async () => {
    // Reproduces the production failure: the dashboard's unfiltered query
    // can't see the answer-visibility runs because newer integration syncs
    // fill the window.
    const { body } = await get<Array<{ id: string; kind: string }>>(`/api/v1/runs?limit=10`)
    expect(body).toHaveLength(10)
    const kinds = new Set(body.map(r => r.kind))
    expect(kinds.has('bing-inspect')).toBe(true)
    expect(kinds.has('answer-visibility')).toBe(false)
  })

  it('?kind=answer-visibility returns the answer-visibility runs even when older', async () => {
    const { status, body } = await get<Array<{ id: string; kind: string }>>(
      `/api/v1/runs?limit=10&kind=answer-visibility`,
    )
    expect(status).toBe(200)
    expect(body).toHaveLength(3)
    expect(body.every(r => r.kind === 'answer-visibility')).toBe(true)
    expect(new Set(body.map(r => r.id))).toEqual(new Set(ctx.answerVisibilityRunIds))
  })

  it('?kind=bing-inspect returns only bing runs', async () => {
    const { body } = await get<Array<{ kind: string }>>(`/api/v1/runs?kind=bing-inspect`)
    expect(body.length).toBeGreaterThan(0)
    expect(body.every(r => r.kind === 'bing-inspect')).toBe(true)
  })

  it('?kind=<unknown> returns 400 with a clear error (not silently empty)', async () => {
    // Silently returning an empty list on a typo would re-introduce the
    // same class of bug — a misspelled filter giving the dashboard nothing
    // looks identical to "no runs exist".
    const { status, body } = await get<{ error: { code?: string; message?: string } }>(
      `/api/v1/runs?kind=not-a-real-kind`,
    )
    expect(status).toBe(400)
    const err = body as unknown as { error: { message?: string } }
    expect(err.error.message).toMatch(/kind/i)
  })

  it('empty ?kind= behaves like no filter (returns all kinds)', async () => {
    const { body } = await get<Array<{ kind: string }>>(`/api/v1/runs?kind=`)
    const kinds = new Set(body.map(r => r.kind))
    expect(kinds.size).toBeGreaterThan(1) // both bing-inspect and answer-visibility
  })
})

describe('GET /projects/:name/runs ?kind= filter', () => {
  it('?kind=answer-visibility surfaces AV runs the limit window would hide', async () => {
    // limit=10 with 20 newer bing-inspect runs returns zero AV runs unfiltered.
    const { body: unfiltered } = await get<Array<{ kind: string }>>(
      `/api/v1/projects/runs-filter/runs?limit=10`,
    )
    expect(unfiltered.every(r => r.kind === 'bing-inspect')).toBe(true)

    const { status, body } = await get<Array<{ id: string; kind: string }>>(
      `/api/v1/projects/runs-filter/runs?limit=10&kind=answer-visibility`,
    )
    expect(status).toBe(200)
    expect(body).toHaveLength(3)
    expect(body.every(r => r.kind === 'answer-visibility')).toBe(true)
    expect(new Set(body.map(r => r.id))).toEqual(new Set(ctx.answerVisibilityRunIds))
  })

  it('?kind=<unknown> returns 400 rather than a silently empty list', async () => {
    const { status, body } = await get<{ error: { message?: string } }>(
      `/api/v1/projects/runs-filter/runs?kind=not-a-real-kind`,
    )
    expect(status).toBe(400)
    const err = body as unknown as { error: { message?: string } }
    expect(err.error.message).toMatch(/kind/i)
  })

  it('empty ?kind= behaves like no filter', async () => {
    const { body } = await get<Array<{ kind: string }>>(`/api/v1/projects/runs-filter/runs?kind=`)
    expect(new Set(body.map(r => r.kind)).size).toBeGreaterThan(1)
  })
})

describe('GET /runs ?status= filter', () => {
  it('?status=running&limit=20 returns only the running rows (the live repro returned 20 completed rows)', async () => {
    const { status, body } = await get<Array<{ id: string; status: string }>>(`/api/v1/runs?status=running&limit=20`)
    expect(status).toBe(200)
    expect(body).toHaveLength(2)
    expect(body.every(r => r.status === RunStatuses.running)).toBe(true)
    expect(new Set(body.map(r => r.id))).toEqual(new Set(ctx.runningRunIds))
  })

  it('?status=queued and ?status=failed each return exactly the one seeded row', async () => {
    const queued = await get<Array<{ id: string }>>(`/api/v1/runs?status=queued`)
    expect(queued.body.map(r => r.id)).toEqual([ctx.queuedRunId])
    const failed = await get<Array<{ id: string }>>(`/api/v1/runs?status=failed`)
    expect(failed.body.map(r => r.id)).toEqual([ctx.failedRunId])
  })

  it('?status=completed returns every completed row across kinds', async () => {
    const { body } = await get<Array<{ status: string }>>(`/api/v1/runs?status=completed`)
    expect(body).toHaveLength(23)
    expect(body.every(r => r.status === RunStatuses.completed)).toBe(true)
  })

  it('?status= combines with ?kind= as AND', async () => {
    const match = await get<Array<{ id: string }>>(`/api/v1/runs?kind=gsc-sync&status=running`)
    expect(new Set(match.body.map(r => r.id))).toEqual(new Set(ctx.runningRunIds))
    const none = await get<Array<{ id: string }>>(`/api/v1/runs?kind=answer-visibility&status=running`)
    expect(none.status).toBe(200)
    expect(none.body).toEqual([])
  })

  it('?status=<unknown> returns 400 naming the param and the allowed values', async () => {
    const { status, body } = await get<{ error: { code: string; message: string } }>(`/api/v1/runs?status=not-a-status`)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toBe(`"status" must be one of: ${ALL_STATUSES.join(', ')}`)
  })

  it('no filter returns every seeded row, as before', async () => {
    const { body } = await get<Array<{ status: string }>>(`/api/v1/runs`)
    expect(body).toHaveLength(SEEDED_TOTAL)
    expect(new Set(body.map(r => r.status))).toEqual(
      new Set([RunStatuses.completed, RunStatuses.running, RunStatuses.queued, RunStatuses.failed]),
    )
  })

  it('empty ?status= behaves like no filter', async () => {
    const { body } = await get<Array<{ status: string }>>(`/api/v1/runs?status=`)
    expect(body).toHaveLength(SEEDED_TOTAL)
  })
})

describe('GET /projects/:name/runs ?status= filter', () => {
  it('?status=running returns only the running rows', async () => {
    const { status, body } = await get<Array<{ id: string; status: string }>>(
      `/api/v1/projects/runs-filter/runs?status=running`,
    )
    expect(status).toBe(200)
    expect(body).toHaveLength(2)
    expect(body.every(r => r.status === RunStatuses.running)).toBe(true)
    expect(new Set(body.map(r => r.id))).toEqual(new Set(ctx.runningRunIds))
  })

  it('?status=running&limit=1 applies the filter before the limit window, not to it', async () => {
    // Unfiltered, limit=1 is the newest bing-inspect row. Filtered, it must be
    // the newest RUNNING row even though every running row is older.
    const { body } = await get<Array<{ id: string; status: string }>>(
      `/api/v1/projects/runs-filter/runs?status=running&limit=1`,
    )
    expect(body).toHaveLength(1)
    expect(body[0]?.status).toBe(RunStatuses.running)
    expect(body[0]?.id).toBe(ctx.runningRunIds[0])
  })

  it('?status=<unknown> returns 400 naming the param and the allowed values', async () => {
    const { status, body } = await get<{ error: { code: string; message: string } }>(
      `/api/v1/projects/runs-filter/runs?status=not-a-status`,
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toBe(`"status" must be one of: ${ALL_STATUSES.join(', ')}`)
  })

  it('no filter returns every seeded row, as before', async () => {
    const { body } = await get<Array<{ id: string }>>(`/api/v1/projects/runs-filter/runs`)
    expect(body).toHaveLength(SEEDED_TOTAL)
  })
})

describe('OpenAPI: runs list filter params', () => {
  it('kind and status enums on both list routes are the contracts enums', async () => {
    // The kind enum was a hand-copied list that had fallen behind RunKinds;
    // both filters now derive from the schema the server validates against.
    const { body } = await get<{
      paths: Record<string, { get?: { parameters?: Array<{ name: string; schema?: { enum?: string[] } }> } }>
    }>('/api/v1/openapi.json')
    for (const path of ['/api/v1/runs', '/api/v1/projects/{name}/runs']) {
      const params = body.paths[path]?.get?.parameters ?? []
      expect(params.find(p => p.name === 'kind')?.schema?.enum, path).toEqual(Object.values(RunKinds))
      expect(params.find(p => p.name === 'status')?.schema?.enum, path).toEqual(ALL_STATUSES)
    }
  })
})
