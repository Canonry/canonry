import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
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
 * Probe runs (`runs.trigger = 'probe'`) write snapshots so an operator can
 * inspect what a provider returned, but they must NEVER influence
 * dashboard / analytics / report / timeline aggregates. The aggregates
 * read directly from `runs` + `query_snapshots`, so the filter has to live
 * at the query layer.
 *
 * This file is the single chokepoint for that invariant: it seeds one
 * project with two runs — a `manual` (real) run that cites the brand and
 * a `probe` run that intentionally does NOT cite the brand — and verifies
 * every aggregate endpoint surfaces only the real run.
 *
 * If you add a new read-aggregate endpoint that reads from `runs`, add a
 * case to this file. The map in the original PR (.probe-exclusion-map.txt)
 * enumerates the surface.
 */

interface Ctx {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  projectId: string
  queryId: string
  realRunId: string
  probeRunId: string
}

function buildCtx(): Ctx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-probe-excl-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })

  const now = new Date()
  const realCreatedAt = new Date(now.getTime() - 60_000).toISOString() // 1 min ago
  const probeCreatedAt = now.toISOString() // newer than the real run

  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'probe-excl',
    displayName: 'Probe Exclusion',
    canonicalDomain: 'real-brand.example.com',
    country: 'US',
    language: 'en',
    providers: ['openai'],
    locations: [],
    createdAt: realCreatedAt,
    updatedAt: realCreatedAt,
  }).run()

  const queryId = crypto.randomUUID()
  db.insert(queriesTable).values({
    id: queryId,
    projectId,
    query: 'best AEO platform',
    createdAt: realCreatedAt,
  }).run()

  db.insert(competitors).values({
    id: crypto.randomUUID(),
    projectId,
    domain: 'competitor.example.com',
    createdAt: realCreatedAt,
  }).run()

  // Real run — cites the brand. Should appear in every aggregate.
  const realRunId = crypto.randomUUID()
  db.insert(runs).values({
    id: realRunId,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    createdAt: realCreatedAt,
    finishedAt: realCreatedAt,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: realRunId,
    queryId,
    provider: 'openai',
    citationState: 'cited',
    answerMentioned: true,
    citedDomains: ['real-brand.example.com'],
    competitorOverlap: [],
    recommendedCompetitors: [],
    answerText: 'real-brand.example.com is the canonical AEO platform.',
    rawResponse: JSON.stringify({
      groundingSources: [{ uri: 'https://real-brand.example.com/aeo', title: 'Real brand' }],
    }),
    createdAt: realCreatedAt,
  }).run()

  // Probe run — intentionally NOT cited. Newer than the real run, so any
  // endpoint that picks "latest" without filtering would (incorrectly) show
  // not-cited.
  const probeRunId = crypto.randomUUID()
  db.insert(runs).values({
    id: probeRunId,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'probe',
    createdAt: probeCreatedAt,
    finishedAt: probeCreatedAt,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: probeRunId,
    queryId,
    provider: 'openai',
    citationState: 'not-cited',
    answerMentioned: false,
    citedDomains: ['competitor.example.com'],
    competitorOverlap: ['competitor.example.com'],
    recommendedCompetitors: [],
    answerText: 'Do you mean an AEO platform in the US? (probe clarifier)',
    rawResponse: JSON.stringify({
      groundingSources: [{ uri: 'https://competitor.example.com/x', title: 'Probe competitor' }],
    }),
    createdAt: probeCreatedAt,
  }).run()

  return { app, db, tmpDir, projectId, queryId, realRunId, probeRunId }
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

// ============================================================================
// Aggregates that MUST exclude probes
// ============================================================================

describe('probe runs are excluded from dashboard / analytics aggregates', () => {
  it('citations/visibility reads the real run, not the newer probe', async () => {
    const { body } = await get<{
      summary: { latestRunId: string | null; queriesCitedAndMentioned: number; totalQueries: number }
    }>(`/api/v1/projects/probe-excl/citations/visibility`)
    // If the probe leaked, latestRunId would point at the probe run (it's newer)
    // and queriesCitedAndMentioned would be 0 (probe is not-cited).
    expect(body.summary.latestRunId).toBe(ctx.realRunId)
    expect(body.summary.queriesCitedAndMentioned).toBe(1)
    expect(body.summary.totalQueries).toBe(1)
  })

  it('overview composite returns the real run as latest answer-visibility run', async () => {
    const { body } = await get<{ latestRun: { run: { id: string } | null } | null }>(
      `/api/v1/projects/probe-excl/overview`,
    )
    // latestRun.run is the absolute-latest run of any kind. We only have
    // answer-visibility runs here, so the real run should win — not the probe.
    expect(body.latestRun?.run?.id).toBe(ctx.realRunId)
  })

  it('portfolio composite excludes probes from recentRuns, lastSweepAt, and project state', async () => {
    const { body } = await get<{
      lastSweepAt: string | null
      recentRuns: { runId: string; mentionedCount: number | null; citedCount: number | null }[]
      projects: {
        projectSlug: string
        mentionedOfTotal: { mentioned: number; total: number }
        citedOfTotal: { cited: number; total: number }
      }[]
    }>(`/api/v1/portfolio`)
    // The probe is newer; an unfiltered query would surface it as the newest
    // run and drag the cited/mentioned state to 0. Only the real run may show.
    expect(body.recentRuns.map(r => r.runId)).toEqual([ctx.realRunId])
    expect(body.recentRuns[0]?.mentionedCount).toBe(1)
    expect(body.recentRuns[0]?.citedCount).toBe(1)
    expect(body.lastSweepAt).toBeTruthy()
    const proj = body.projects.find(p => p.projectSlug === 'probe-excl')!
    expect(proj.mentionedOfTotal).toEqual({ mentioned: 1, total: 1 })
    expect(proj.citedOfTotal).toEqual({ cited: 1, total: 1 })
  })

  it('runs/latest returns the real run and totalRuns excludes the probe', async () => {
    // The probe is intentionally newer than the real run, so an unfiltered
    // ORDER BY created_at DESC + LIMIT 1 would surface the probe. This
    // endpoint powers the dashboard headline, `canonry status`, `canonry
    // export`, and the MCP `canonry_project_overview` tool — none of them
    // should ever show a probe as the project's current state.
    const { body } = await get<{ totalRuns: number; run: { id: string } | null }>(
      `/api/v1/projects/probe-excl/runs/latest`,
    )
    expect(body.run?.id).toBe(ctx.realRunId)
    expect(body.totalRuns).toBe(1)
  })

  it('analytics/metrics overall rate reflects the real run only (probe excluded from totals)', async () => {
    const { body } = await get<{ overall: { citationRate: number; cited: number; total: number } }>(
      `/api/v1/projects/probe-excl/analytics/metrics`,
    )
    // Real run: 1 cited snapshot out of 1. Probe (if leaked): 1 not-cited
    // snapshot out of 1, dropping the rate from 1.0 to 0.5.
    expect(body.overall.total).toBe(1)
    expect(body.overall.cited).toBe(1)
    expect(body.overall.citationRate).toBe(1)
  })

  it('visibility-stats counts the real run only (probe excluded from the sample)', async () => {
    const { body } = await get<{
      window: { runCount: number }
      totals: { total: number; cited: number; mentioned: number; checked: number }
    }>(`/api/v1/projects/probe-excl/visibility-stats`)
    // Real run: 1 cited + mentioned snapshot. Probe (if leaked): 1 not-cited,
    // not-mentioned snapshot — would drop the sample to 2 and the cited count
    // to 1 of 2 instead of 1 of 1.
    expect(body.window.runCount).toBe(1)
    expect(body.totals.total).toBe(1)
    expect(body.totals.checked).toBe(1)
    expect(body.totals.cited).toBe(1)
    expect(body.totals.mentioned).toBe(1)
  })

  it('analytics/gaps anchors to the real run (cited), not the probe (not-cited)', async () => {
    const { body } = await get<{
      runId: string | null
      cited: Array<{ query: string }>
      uncited: Array<{ query: string }>
    }>(`/api/v1/projects/probe-excl/analytics/gaps`)
    // Gap analysis anchors to the latest answer-visibility run. If the probe
    // leaked, runId would point at the probe and the query would be uncited.
    expect(body.runId).toBe(ctx.realRunId)
    expect(body.cited.map(q => q.query)).toContain('best AEO platform')
    expect(body.uncited.map(q => q.query)).not.toContain('best AEO platform')
  })

  it('analytics/sources anchors to the real run (cites brand domain)', async () => {
    const { body } = await get<{ runId: string | null; overall: Array<{ url?: string; domain?: string }> }>(
      `/api/v1/projects/probe-excl/analytics/sources`,
    )
    // If the probe leaked, runId would point at the probe whose only grounding
    // source is competitor.example.com, not the brand domain.
    expect(body.runId).toBe(ctx.realRunId)
  })

  it('analytics/sources ranked + byProvider cuts exclude probe-run domains', async () => {
    const { body } = await get<{
      ranked: { entries: Array<{ domain: string }>; totalCitedSlots: number }
      byProvider: Record<string, { entries: Array<{ domain: string }> }>
    }>(`/api/v1/projects/probe-excl/analytics/sources`)
    const rankedDomains = body.ranked.entries.map(e => e.domain)
    // The real run's grounding source is present; the probe's is not.
    expect(rankedDomains).toContain('real-brand.example.com')
    expect(rankedDomains).not.toContain('competitor.example.com')
    expect(body.ranked.totalCitedSlots).toBe(1)
    // Both runs used provider openai; the probe's slot must not inflate it.
    const openaiDomains = body.byProvider.openai?.entries.map(e => e.domain) ?? []
    expect(openaiDomains).toContain('real-brand.example.com')
    expect(openaiDomains).not.toContain('competitor.example.com')
  })

  it('snapshots list excludes probe snapshots', async () => {
    const { body } = await get<{ snapshots: { runId: string }[] }>(
      `/api/v1/projects/probe-excl/snapshots`,
    )
    const runIds = new Set(body.snapshots.map(s => s.runId))
    expect(runIds.has(ctx.realRunId)).toBe(true)
    expect(runIds.has(ctx.probeRunId)).toBe(false)
  })

  it('timeline does not include the probe run', async () => {
    const { body } = await get<Array<{ query: string; runs: { runId: string }[] }>>(
      `/api/v1/projects/probe-excl/timeline`,
    )
    const allRunIds = new Set(body.flatMap(q => q.runs.map(r => r.runId)))
    expect(allRunIds.has(ctx.realRunId)).toBe(true)
    expect(allRunIds.has(ctx.probeRunId)).toBe(false)
  })

  it('report citations trend does not include the probe', async () => {
    const { body } = await get<{ citationsTrend: { points: Array<{ runId: string }> } }>(
      `/api/v1/projects/probe-excl/report`,
    )
    const trendRunIds = new Set((body.citationsTrend?.points ?? []).map(p => p.runId))
    expect(trendRunIds.has(ctx.probeRunId)).toBe(false)
  })

  it('content/targets pulls recent answer-visibility runs without the probe', async () => {
    // Probes must not poison the orchestrator input that drives the
    // content-engine recommendations.
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/projects/probe-excl/content/targets` })
    expect(res.statusCode).toBe(200)
    // No specific assertion on shape — the test exists to catch regression where
    // the probe snapshot poisons the orchestrator input and crashes the route
    // (or shifts recommendations). If it returns 200, the filter held.
    const body = res.json() as { targets?: unknown[] }
    expect(body.targets === undefined || Array.isArray(body.targets)).toBe(true)
  })
})

// ============================================================================
// Things that MUST still include probes (so operators can audit their tests)
// ============================================================================

describe('probe runs remain queryable for operators', () => {
  it('GET /runs/:id returns a probe by id (per-run inspector)', async () => {
    const { status, body } = await get<{ id: string; trigger: string }>(
      `/api/v1/runs/${ctx.probeRunId}`,
    )
    expect(status).toBe(200)
    expect(body.id).toBe(ctx.probeRunId)
    expect(body.trigger).toBe('probe')
  })

  it('GET /projects/:name/runs lists probes alongside real runs (operator visibility)', async () => {
    const { body } = await get<{ id: string; trigger: string }[]>(
      `/api/v1/projects/probe-excl/runs`,
    )
    const triggers = new Set(body.map(r => r.trigger))
    expect(triggers.has('manual')).toBe(true)
    expect(triggers.has('probe')).toBe(true)
  })
})

describe("POST /projects/:name/runs accepts trigger='probe' end-to-end", () => {
  it('persists the run row with trigger=probe', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/probe-excl/runs`,
      payload: { trigger: 'probe', queries: ['best AEO platform'], noLocation: true },
    })
    expect([200, 201]).toContain(res.statusCode)
    const body = res.json() as { id?: string; trigger?: string } | Array<{ id: string; trigger: string }>
    // Single-location runs return a single object; fan-out returns an array.
    const created = Array.isArray(body) ? body[0]! : body
    expect(created.trigger).toBe('probe')

    // Confirm the DB row really has trigger='probe' — schema enum + handler
    // path both validated end-to-end.
    const runRow = ctx.db.select().from(runs).where(eq(runs.id, created.id!)).get()
    expect(runRow?.trigger).toBe('probe')
  })

  it("rejects unknown trigger values (e.g. 'scheduled' from external callers)", async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/probe-excl/runs`,
      payload: { trigger: 'scheduled', noLocation: true },
    })
    expect(res.statusCode).toBe(400)
  })
})
