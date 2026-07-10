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
  competitors,
  runs,
  querySnapshots,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

/**
 * Route-level coverage for GET /projects/:name/visibility-compare. The shared
 * `probe-exclusion.test.ts` seeds a single month, which cannot exercise a
 * two-month endpoint, so the probe-exclusion invariant for this route is
 * asserted here: a probe run in the `to` month must not enter the counts.
 */
interface Ctx {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
}
let ctx: Ctx

function seedRun(db: Ctx['db'], projectId: string, queryId: string, opts: {
  createdAt: string
  trigger: 'manual' | 'probe'
  mentioned: boolean
  cited: boolean
}) {
  const runId = crypto.randomUUID()
  db.insert(runs).values({
    id: runId, projectId, kind: 'answer-visibility', status: 'completed',
    trigger: opts.trigger, createdAt: opts.createdAt, finishedAt: opts.createdAt,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(), runId, queryId, provider: 'openai', model: 'gpt-5.4',
    citationState: opts.cited ? 'cited' : 'not-cited',
    answerMentioned: opts.mentioned,
    citedDomains: opts.cited ? ['cmp.example.com'] : ['rival.example.com'],
    competitorOverlap: [], recommendedCompetitors: [],
    answerText: 'cmp.example.com and rival are options.',
    rawResponse: '{}', createdAt: opts.createdAt,
  }).run()
}

beforeEach(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-compare-route-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()

  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'cmp', displayName: 'Cmp', canonicalDomain: 'cmp.example.com',
    country: 'US', language: 'en', providers: ['openai'], locations: [],
    createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
  }).run()
  const queryId = crypto.randomUUID()
  db.insert(queriesTable).values({ id: queryId, projectId, query: 'best aeo platform', createdAt: '2026-05-01T00:00:00.000Z' }).run()
  db.insert(competitors).values({ id: crypto.randomUUID(), projectId, domain: 'rival.example.com', createdAt: '2026-05-01T00:00:00.000Z' }).run()

  // May: one real run, mentioned.
  seedRun(db, projectId, queryId, { createdAt: '2026-05-10T12:00:00.000Z', trigger: 'manual', mentioned: true, cited: true })
  // June: one real run (mentioned) + one PROBE run (NOT mentioned) — the probe must be excluded.
  seedRun(db, projectId, queryId, { createdAt: '2026-06-10T12:00:00.000Z', trigger: 'manual', mentioned: true, cited: true })
  seedRun(db, projectId, queryId, { createdAt: '2026-06-11T12:00:00.000Z', trigger: 'probe', mentioned: false, cited: false })

  ctx = { app, db, tmpDir }
})

afterEach(async () => {
  await ctx.app.close()
  ctx.db.$client.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

const get = (url: string) => ctx.app.inject({ method: 'GET', url })

describe('GET /visibility-compare', () => {
  it('excludes probe runs from the compared counts', async () => {
    const res = await get('/api/v1/projects/cmp/visibility-compare?from=2026-05&to=2026-06')
    expect(res.statusCode).toBe(200)
    const dto = JSON.parse(res.payload)
    const mentionRate = dto.metrics.find((m: { key: string }) => m.key === 'mention-rate')
    // June has 1 real (mentioned) + 1 probe (not mentioned). If the probe leaked
    // in, checked=2 and point=0.5. Probe excluded => checked=1, point=1.
    expect(mentionRate.to.denominator).toBe(1)
    expect(mentionRate.to.point).toBe(1)
    expect(dto.to.runCount).toBe(1) // the probe run is not counted
  })

  it('echoes the month windows and marks low run counts', async () => {
    const dto = JSON.parse((await get('/api/v1/projects/cmp/visibility-compare?from=2026-05&to=2026-06')).payload)
    expect(dto.from.month).toBe('2026-05')
    expect(dto.to.month).toBe('2026-06')
    expect(dto.from.since).toBe('2026-05-01T00:00:00.000Z')
    expect(dto.from.lowRunCount).toBe(true) // 1 sweep < 5
    expect(dto.basket).toMatchObject({ queryCount: 1, providers: ['openai'] })
  })

  it('rejects missing or mis-ordered months', async () => {
    expect((await get('/api/v1/projects/cmp/visibility-compare?to=2026-06')).statusCode).toBe(400)
    expect((await get('/api/v1/projects/cmp/visibility-compare?from=2026-05')).statusCode).toBe(400)
    expect((await get('/api/v1/projects/cmp/visibility-compare?from=2026-06&to=2026-05')).statusCode).toBe(400)
    expect((await get('/api/v1/projects/cmp/visibility-compare?from=2026-06&to=2026-06')).statusCode).toBe(400)
    expect((await get('/api/v1/projects/cmp/visibility-compare?from=bad&to=2026-06')).statusCode).toBe(400)
  })
})
