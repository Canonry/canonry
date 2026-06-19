import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, queries as queriesTable, runs, querySnapshots } from '@ainyc/canonry-db'
import type { VisibilityStatsDto } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { computeVisibilityStats, type VisibilityStatsSnapshotInput } from '../src/visibility-stats.js'

// ============================================================================
// Pure calculation — computeVisibilityStats
// ============================================================================

const Q = [
  { id: 'q1', query: 'best AEO platform' },
  { id: 'q2', query: 'how to optimize for AI search' },
]

function snap(over: Partial<VisibilityStatsSnapshotInput>): VisibilityStatsSnapshotInput {
  return {
    queryId: 'q1',
    queryText: 'best AEO platform',
    provider: 'openai',
    citationState: 'not-cited',
    answerMentioned: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...over,
  }
}

describe('computeVisibilityStats (pure)', () => {
  it('counts mentioned only when answerMentioned === true; null is excluded from checked, false is checked-not-mentioned', () => {
    const snapshots = [
      snap({ answerMentioned: true }),
      snap({ answerMentioned: false }),
      snap({ answerMentioned: null }),
    ]
    const { totals, queries } = computeVisibilityStats({ queries: Q, snapshots, groupBy: null })
    // total counts every snapshot; checked excludes the null; mentioned counts only true.
    expect(totals.total).toBe(3)
    expect(totals.checked).toBe(2) // true + false, NOT the null
    expect(totals.mentioned).toBe(1) // only the true
    // mentionRate is over checked (2), NOT total (3): 1/2 = 0.5
    expect(totals.mentionRate).toBe(0.5)
    expect(queries).toHaveLength(1)
    expect(queries[0]!.checked).toBe(2)
    expect(queries[0]!.mentioned).toBe(1)
    expect(queries[0]!.mentionRate).toBe(0.5)
  })

  it('keeps mention (answer text) and cited (source list) independent', () => {
    const snapshots = [
      snap({ citationState: 'cited', answerMentioned: false }), // cited, not mentioned
      snap({ citationState: 'not-cited', answerMentioned: true }), // mentioned, not cited
      snap({ citationState: 'cited', answerMentioned: true }), // both
      snap({ citationState: 'not-cited', answerMentioned: false }), // neither
    ]
    const { totals } = computeVisibilityStats({ queries: Q, snapshots, groupBy: null })
    expect(totals.total).toBe(4)
    expect(totals.checked).toBe(4)
    expect(totals.cited).toBe(2) // independent of mention
    expect(totals.mentioned).toBe(2) // independent of citation
    expect(totals.citedRate).toBe(0.5) // cited / total
    expect(totals.mentionRate).toBe(0.5) // mentioned / checked
  })

  it('citedRate uses total as the denominator (citation is always checked)', () => {
    // 1 cited of 4 total, but only 2 checked for mention.
    const snapshots = [
      snap({ citationState: 'cited', answerMentioned: null }),
      snap({ citationState: 'not-cited', answerMentioned: null }),
      snap({ citationState: 'not-cited', answerMentioned: true }),
      snap({ citationState: 'not-cited', answerMentioned: false }),
    ]
    const { totals } = computeVisibilityStats({ queries: Q, snapshots, groupBy: null })
    expect(totals.cited).toBe(1)
    expect(totals.total).toBe(4)
    expect(totals.citedRate).toBe(0.25) // 1/4 — denominator is total, not checked
    expect(totals.checked).toBe(2)
    expect(totals.mentionRate).toBe(0.5) // 1/2
  })

  it('returns null rates when the denominator is zero (rate undefined over no samples)', () => {
    // All unchecked → checked = 0 → mentionRate null. No snapshots at all → all null.
    const allNull = computeVisibilityStats({
      queries: Q,
      snapshots: [snap({ answerMentioned: null }), snap({ answerMentioned: null })],
      groupBy: null,
    })
    expect(allNull.totals.checked).toBe(0)
    expect(allNull.totals.mentionRate).toBeNull()
    expect(allNull.totals.citedRate).toBe(0) // total=2, cited=0 → 0, not null

    const empty = computeVisibilityStats({ queries: Q, snapshots: [], groupBy: null })
    expect(empty.totals.total).toBe(0)
    expect(empty.totals.mentionRate).toBeNull()
    expect(empty.totals.citedRate).toBeNull()
    expect(empty.queries).toHaveLength(0)
  })

  it('groupBy=provider returns per-provider counts that sum to the pooled counts', () => {
    const snapshots = [
      snap({ provider: 'openai', citationState: 'cited', answerMentioned: true }),
      snap({ provider: 'openai', citationState: 'not-cited', answerMentioned: false }),
      snap({ provider: 'gemini', citationState: 'cited', answerMentioned: true }),
      snap({ provider: 'gemini', citationState: 'cited', answerMentioned: null }),
    ]
    const { totals, byProvider, queries } = computeVisibilityStats({ queries: Q, snapshots, groupBy: 'provider' })
    expect(byProvider).toBeDefined()
    // sorted alphabetically: gemini, openai
    expect(byProvider!.map((p) => p.provider)).toEqual(['gemini', 'openai'])

    const sum = (key: 'total' | 'checked' | 'mentioned' | 'cited') =>
      byProvider!.reduce((acc, p) => acc + p[key], 0)
    expect(sum('total')).toBe(totals.total)
    expect(sum('checked')).toBe(totals.checked)
    expect(sum('mentioned')).toBe(totals.mentioned)
    expect(sum('cited')).toBe(totals.cited)

    // per-query providers also sum to the query's pooled counts
    const qEntry = queries[0]!
    expect(qEntry.providers).toBeDefined()
    expect(qEntry.providers!.reduce((a, p) => a + p.cited, 0)).toBe(qEntry.cited)
    expect(qEntry.providers!.reduce((a, p) => a + p.mentioned, 0)).toBe(qEntry.mentioned)

    // gemini: 2 total, 1 checked (the null excluded), 1 mentioned, 2 cited
    const gemini = byProvider!.find((p) => p.provider === 'gemini')!
    expect(gemini).toMatchObject({ total: 2, checked: 1, mentioned: 1, cited: 2 })
    expect(gemini.mentionRate).toBe(1) // 1/1
    expect(gemini.citedRate).toBe(1) // 2/2
  })

  it('attributes snapshots by queryText when queryId is null (post query-replace)', () => {
    const snapshots = [
      snap({ queryId: null, queryText: 'best AEO platform', answerMentioned: true }),
      snap({ queryId: 'q2', queryText: 'how to optimize for AI search', citationState: 'cited' }),
    ]
    const { queries } = computeVisibilityStats({ queries: Q, snapshots, groupBy: null })
    const byText = new Map(queries.map((q) => [q.query, q]))
    expect(byText.get('best AEO platform')!.queryId).toBe('q1') // recovered via text
    expect(byText.get('best AEO platform')!.mentioned).toBe(1)
    expect(byText.get('how to optimize for AI search')!.cited).toBe(1)
  })

  it('drops snapshots that cannot be attributed to any current query', () => {
    const snapshots = [
      snap({ queryId: null, queryText: 'a query that was removed' }),
      snap({ queryId: 'q1', queryText: 'best AEO platform', answerMentioned: true }),
    ]
    const { totals, queries } = computeVisibilityStats({ queries: Q, snapshots, groupBy: null })
    expect(queries).toHaveLength(1) // only the attributable one
    expect(totals.total).toBe(1)
    expect(totals.mentioned).toBe(1)
  })

  it('tracks firstObserved / lastObserved per query and provider', () => {
    const snapshots = [
      snap({ createdAt: '2026-06-03T00:00:00.000Z' }),
      snap({ createdAt: '2026-06-01T00:00:00.000Z' }),
      snap({ createdAt: '2026-06-05T00:00:00.000Z' }),
    ]
    const { queries } = computeVisibilityStats({ queries: Q, snapshots, groupBy: 'provider' })
    expect(queries[0]!.firstObserved).toBe('2026-06-01T00:00:00.000Z')
    expect(queries[0]!.lastObserved).toBe('2026-06-05T00:00:00.000Z')
    expect(queries[0]!.providers![0]!.firstObserved).toBe('2026-06-01T00:00:00.000Z')
    expect(queries[0]!.providers![0]!.lastObserved).toBe('2026-06-05T00:00:00.000Z')
  })

  it('omits provider breakdowns when groupBy is null', () => {
    const { byProvider, queries } = computeVisibilityStats({
      queries: Q,
      snapshots: [snap({ answerMentioned: true })],
      groupBy: null,
    })
    expect(byProvider).toBeUndefined()
    expect(queries[0]!.providers).toBeUndefined()
  })

  it('prefers queryId over queryText when both resolve (fallback ordering)', () => {
    // queryId points at q1 while the denormalized text matches q2 — id wins.
    const snapshots = [
      snap({ queryId: 'q1', queryText: 'how to optimize for AI search', answerMentioned: true }),
    ]
    const { queries } = computeVisibilityStats({ queries: Q, snapshots, groupBy: null })
    expect(queries).toHaveLength(1)
    expect(queries[0]!.queryId).toBe('q1')
    expect(queries[0]!.query).toBe('best AEO platform') // q1's text, not the snapshot's stale text
  })

  it('groupBy=provider with no snapshots returns an empty (defined) breakdown', () => {
    const { byProvider, queries } = computeVisibilityStats({ queries: Q, snapshots: [], groupBy: 'provider' })
    expect(byProvider).toEqual([]) // defined-but-empty, not undefined
    expect(queries).toEqual([])
  })

  it('rounds rates to 4 decimal places (round4)', () => {
    // 1 of 3 checked → 0.33333… → 0.3333; 2 of 3 cited → 0.66666… → 0.6667.
    const snapshots = [
      snap({ citationState: 'cited', answerMentioned: true }),
      snap({ citationState: 'cited', answerMentioned: false }),
      snap({ citationState: 'not-cited', answerMentioned: false }),
    ]
    const { totals } = computeVisibilityStats({ queries: Q, snapshots, groupBy: null })
    expect(totals.mentionRate).toBe(0.3333) // 1/3
    expect(totals.citedRate).toBe(0.6667) // 2/3
  })
})

// ============================================================================
// Route integration — GET /projects/:name/visibility-stats
// ============================================================================

interface Ctx {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  projectId: string
  q1: string
  q2: string
}

function iso(daysAgo: number): string {
  return new Date(Date.UTC(2026, 5, 10) - daysAgo * 86_400_000).toISOString()
}

let ctx: Ctx

function seedRun(opts: {
  createdAt: string
  kind?: string
  trigger?: string
  status?: string
  snapshots: Array<{ queryId: string; queryText: string; provider: string; cited: boolean; mentioned: boolean | null }>
}): string {
  const runId = crypto.randomUUID()
  ctx.db
    .insert(runs)
    .values({
      id: runId,
      projectId: ctx.projectId,
      kind: opts.kind ?? 'answer-visibility',
      status: opts.status ?? 'completed',
      trigger: opts.trigger ?? 'manual',
      createdAt: opts.createdAt,
      finishedAt: opts.createdAt,
    })
    .run()
  for (const s of opts.snapshots) {
    ctx.db
      .insert(querySnapshots)
      .values({
        id: crypto.randomUUID(),
        runId,
        queryId: s.queryId,
        queryText: s.queryText,
        provider: s.provider,
        citationState: s.cited ? 'cited' : 'not-cited',
        answerMentioned: s.mentioned,
        citedDomains: [],
        competitorOverlap: [],
        recommendedCompetitors: [],
        createdAt: opts.createdAt,
      })
      .run()
  }
  return runId
}

function buildCtx(): Ctx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-vis-stats-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })

  const projectId = crypto.randomUUID()
  db.insert(projects)
    .values({
      id: projectId,
      name: 'vis-stats',
      displayName: 'Vis Stats',
      canonicalDomain: 'brand.example.com',
      country: 'US',
      language: 'en',
      providers: ['openai', 'gemini'],
      locations: [],
      createdAt: iso(30),
      updatedAt: iso(30),
    })
    .run()

  const q1 = crypto.randomUUID()
  const q2 = crypto.randomUUID()
  db.insert(queriesTable).values({ id: q1, projectId, query: 'best AEO platform', createdAt: iso(30) }).run()
  db.insert(queriesTable).values({ id: q2, projectId, query: 'AI search optimization', createdAt: iso(30) }).run()

  return { app, db, tmpDir, projectId, q1, q2 }
}

async function getStats(qs = ''): Promise<{ status: number; body: VisibilityStatsDto & { error?: unknown } }> {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/projects/vis-stats/visibility-stats${qs}` })
  return { status: res.statusCode, body: res.json() }
}

describe('GET /projects/:name/visibility-stats', () => {
  beforeEach(() => {
    ctx = buildCtx()
  })
  afterEach(async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('aggregates across multiple runs into a per-query sample', async () => {
    seedRun({
      createdAt: iso(5),
      snapshots: [
        { queryId: ctx.q1, queryText: 'best AEO platform', provider: 'openai', cited: true, mentioned: true },
      ],
    })
    seedRun({
      createdAt: iso(3),
      snapshots: [
        { queryId: ctx.q1, queryText: 'best AEO platform', provider: 'openai', cited: false, mentioned: false },
      ],
    })
    const { status, body } = await getStats()
    expect(status).toBe(200)
    expect(body.project).toBe('vis-stats')
    expect(body.window.runCount).toBe(2)
    expect(body.groupBy).toBeUndefined() // omitted (not null) when no breakdown requested
    const q = body.queries.find((x) => x.query === 'best AEO platform')!
    expect(q.total).toBe(2)
    expect(q.checked).toBe(2)
    expect(q.cited).toBe(1)
    expect(q.mentioned).toBe(1)
    expect(q.citedRate).toBe(0.5)
    expect(q.mentionRate).toBe(0.5)
  })

  it('returns an empty, well-formed payload when there are no runs', async () => {
    const { status, body } = await getStats()
    expect(status).toBe(200)
    expect(body.window.runCount).toBe(0)
    expect(body.queries).toEqual([])
    expect(body.totals).toMatchObject({ total: 0, checked: 0, mentioned: 0, cited: 0, mentionRate: null, citedRate: null })
  })

  it('filters by since/until on run createdAt', async () => {
    seedRun({ createdAt: iso(10), snapshots: [{ queryId: ctx.q1, queryText: 'best AEO platform', provider: 'openai', cited: true, mentioned: true }] })
    seedRun({ createdAt: iso(2), snapshots: [{ queryId: ctx.q1, queryText: 'best AEO platform', provider: 'openai', cited: false, mentioned: false }] })
    // window that includes only the recent (iso(2)) run
    const { body } = await getStats(`?since=${encodeURIComponent(iso(4))}`)
    expect(body.window.runCount).toBe(1)
    expect(body.window.since).toBe(iso(4))
    const q = body.queries[0]!
    expect(q.total).toBe(1)
    expect(q.cited).toBe(0) // only the not-cited recent run
  })

  it('includes runs from the whole UTC day when until is a date-only value', async () => {
    // Mid-afternoon run: a bare-midnight `until` bound would wrongly drop it.
    seedRun({
      createdAt: '2026-06-08T15:30:00.000Z',
      snapshots: [{ queryId: ctx.q1, queryText: 'best AEO platform', provider: 'openai', cited: true, mentioned: true }],
    })
    // A date-only `until` on the SAME day must include the afternoon run.
    const included = await getStats('?until=2026-06-08')
    expect(included.body.window.runCount).toBe(1)
    expect(included.body.totals.cited).toBe(1)
    // The prior day still excludes it.
    const excluded = await getStats('?until=2026-06-07')
    expect(excluded.body.window.runCount).toBe(0)
  })

  it('treats the date-only until bound as the exact end of the UTC day', async () => {
    // Last representable instant of the day — must be included.
    seedRun({
      createdAt: '2026-06-08T23:59:59.999Z',
      snapshots: [{ queryId: ctx.q1, queryText: 'best AEO platform', provider: 'openai', cited: true, mentioned: true }],
    })
    // First instant of the next day — must be excluded.
    seedRun({
      createdAt: '2026-06-09T00:00:00.000Z',
      snapshots: [{ queryId: ctx.q1, queryText: 'best AEO platform', provider: 'openai', cited: false, mentioned: false }],
    })
    const { body } = await getStats('?until=2026-06-08')
    expect(body.window.runCount).toBe(1)
    expect(body.totals.total).toBe(1)
    expect(body.totals.cited).toBe(1)
  })

  it('lastRuns selects the most recent N answer-visibility runs', async () => {
    seedRun({ createdAt: iso(9), snapshots: [{ queryId: ctx.q1, queryText: 'best AEO platform', provider: 'openai', cited: true, mentioned: true }] })
    seedRun({ createdAt: iso(6), snapshots: [{ queryId: ctx.q1, queryText: 'best AEO platform', provider: 'openai', cited: true, mentioned: true }] })
    seedRun({ createdAt: iso(1), snapshots: [{ queryId: ctx.q1, queryText: 'best AEO platform', provider: 'openai', cited: false, mentioned: false }] })
    const { body } = await getStats('?lastRuns=2')
    expect(body.window.lastRuns).toBe(2)
    expect(body.window.runCount).toBe(2)
    const q = body.queries[0]!
    // last 2 runs = iso(6) cited + iso(1) not-cited → 1 of 2 cited
    expect(q.total).toBe(2)
    expect(q.cited).toBe(1)
  })

  it('lastRuns larger than the available run count returns every run', async () => {
    seedRun({ createdAt: iso(4), snapshots: [{ queryId: ctx.q1, queryText: 'best AEO platform', provider: 'openai', cited: true, mentioned: true }] })
    seedRun({ createdAt: iso(2), snapshots: [{ queryId: ctx.q1, queryText: 'best AEO platform', provider: 'openai', cited: false, mentioned: false }] })
    const { body } = await getStats('?lastRuns=10')
    expect(body.window.lastRuns).toBe(10)
    expect(body.window.runCount).toBe(2) // only 2 exist — no overflow
    expect(body.queries[0]!.total).toBe(2)
  })

  it('groupBy=provider returns per-provider counts that sum to pooled (route level)', async () => {
    seedRun({
      createdAt: iso(2),
      snapshots: [
        { queryId: ctx.q1, queryText: 'best AEO platform', provider: 'openai', cited: true, mentioned: true },
        { queryId: ctx.q1, queryText: 'best AEO platform', provider: 'gemini', cited: false, mentioned: false },
      ],
    })
    const { body } = await getStats('?groupBy=provider')
    expect(body.groupBy).toBe('provider')
    expect(body.byProvider).toBeDefined()
    const pooledCited = body.byProvider!.reduce((a, p) => a + p.cited, 0)
    expect(pooledCited).toBe(body.totals.cited)
    expect(body.totals.cited).toBe(1)
  })

  it('groupBy=provider with no runs returns groupBy + an empty byProvider', async () => {
    const { body } = await getStats('?groupBy=provider')
    expect(body.groupBy).toBe('provider')
    expect(body.byProvider).toEqual([]) // present-but-empty, not omitted
    expect(body.queries).toEqual([])
  })

  it('excludes non-answer-visibility runs (e.g. gsc-sync) from the run set', async () => {
    seedRun({ createdAt: iso(2), kind: 'gsc-sync', snapshots: [] })
    const { body } = await getStats()
    expect(body.window.runCount).toBe(0)
  })

  it('excludes queued/failed runs (only completed/partial count)', async () => {
    seedRun({ createdAt: iso(2), status: 'failed', snapshots: [{ queryId: ctx.q1, queryText: 'best AEO platform', provider: 'openai', cited: true, mentioned: true }] })
    const { body } = await getStats()
    expect(body.window.runCount).toBe(0)
  })

  it('rejects combining lastRuns with since/until, with a descriptive message', async () => {
    const { status, body } = await getStats(`?lastRuns=2&since=${encodeURIComponent(iso(5))}`)
    expect(status).toBe(400)
    const err = body.error as { code: string; message: string }
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.message).toMatch(/cannot be combined/i)
  })

  it('rejects invalid params with VALIDATION_ERROR + a message naming the offending param', async () => {
    const cases: Array<{ qs: string; match: RegExp }> = [
      { qs: '?groupBy=model', match: /groupBy/ },
      { qs: '?since=not-a-date', match: /since/ },
      { qs: '?until=not-a-date', match: /until/ },
      { qs: '?lastRuns=0', match: /lastRuns/ },
      { qs: '?lastRuns=-3', match: /lastRuns/ },
      { qs: '?lastRuns=2.5', match: /lastRuns/ },
      // until strictly before since (iso(2) is newer than iso(5)) → range error
      { qs: `?since=${encodeURIComponent(iso(2))}&until=${encodeURIComponent(iso(5))}`, match: /on or after/i },
    ]
    for (const { qs, match } of cases) {
      const { status, body } = await getStats(qs)
      expect(status, qs).toBe(400)
      const err = body.error as { code: string; message: string }
      expect(err.code, qs).toBe('VALIDATION_ERROR')
      expect(err.message, qs).toMatch(match)
    }
  })

  it('404s for an unknown project', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/nope/visibility-stats' })
    expect(res.statusCode).toBe(404)
  })
})
