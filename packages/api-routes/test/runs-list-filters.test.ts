import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, runs } from '@ainyc/canonry-db'
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
 */

interface Ctx {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  projectId: string
  bingRunIds: string[]
  answerVisibilityRunIds: string[]
}

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

  return { app, db, tmpDir, projectId, bingRunIds, answerVisibilityRunIds }
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
