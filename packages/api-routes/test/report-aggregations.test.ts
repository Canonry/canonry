/**
 * PR B: aggregations layered onto the existing report builders.
 * - CompetitorRow.sharePct (SOV across all cited slots)
 * - CompetitorRow.theirCitedPages (URLs they were cited for + which queries)
 * - GscSection.trackedButNoGsc + .gscButNotTracked (GSC × AEO crossover)
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  queries as queriesTable,
  competitors,
  runs,
  querySnapshots,
  gscSearchData,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ProjectReportDto } from '@ainyc/canonry-contracts'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-report-aggr-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db, tmpDir }
}

function insertProject(db: ReturnType<typeof createClient>, name: string, canonicalDomain?: string) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id,
    name,
    displayName: name,
    canonicalDomain: canonicalDomain ?? `${name}.example.com`,
    country: 'US',
    language: 'en',
    locations: '[]',
    providers: '["gemini"]',
    createdAt: now,
    updatedAt: now,
  }).run()
  return id
}

function insertQuery(db: ReturnType<typeof createClient>, projectId: string, query: string) {
  const id = crypto.randomUUID()
  db.insert(queriesTable).values({
    id, projectId, query,
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

function insertCompetitor(db: ReturnType<typeof createClient>, projectId: string, domain: string) {
  db.insert(competitors).values({
    id: crypto.randomUUID(),
    projectId,
    domain,
    createdAt: new Date().toISOString(),
  }).run()
}

function insertRun(db: ReturnType<typeof createClient>, projectId: string) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(runs).values({
    id, projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    startedAt: now,
    finishedAt: now,
    createdAt: now,
  }).run()
  return id
}

function insertSnapshot(
  db: ReturnType<typeof createClient>,
  runId: string,
  queryId: string,
  opts: {
    citedDomains?: string[]
    competitorOverlap?: string[]
    citationState?: 'cited' | 'not-cited'
    rawResponse?: { groundingSources: { uri: string; title?: string }[] }
    answerText?: string | null
    answerMentioned?: boolean | null
  } = {},
) {
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId,
    queryId,
    provider: 'gemini',
    citationState: opts.citationState ?? 'cited',
    answerMentioned: opts.answerMentioned ?? false,
    answerText: opts.answerText ?? null,
    citedDomains: JSON.stringify(opts.citedDomains ?? []),
    competitorOverlap: JSON.stringify(opts.competitorOverlap ?? []),
    rawResponse: opts.rawResponse ? JSON.stringify(opts.rawResponse) : null,
    createdAt: new Date().toISOString(),
  }).run()
}

let ctx: ReturnType<typeof buildApp>

beforeEach(() => {
  ctx = buildApp()
})

afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

describe('CompetitorRow.sharePct (SOV)', () => {
  test('sums to ~100% across project + competitors when cited slots are present', async () => {
    const projectId = insertProject(ctx.db, 'sov', 'sov.example.com')
    insertCompetitor(ctx.db, projectId, 'rival-a.com')
    insertCompetitor(ctx.db, projectId, 'rival-b.com')

    const k1 = insertQuery(ctx.db, projectId, 'k1')
    const k2 = insertQuery(ctx.db, projectId, 'k2')
    const k3 = insertQuery(ctx.db, projectId, 'k3')
    const runId = insertRun(ctx.db, projectId)

    // Snap 1: project + rival-a
    insertSnapshot(ctx.db, runId, k1, { citedDomains: ['sov.example.com', 'rival-a.com'] })
    // Snap 2: rival-a + rival-b
    insertSnapshot(ctx.db, runId, k2, { citedDomains: ['rival-a.com', 'rival-b.com'] })
    // Snap 3: rival-a only
    insertSnapshot(ctx.db, runId, k3, { citedDomains: ['rival-a.com'] })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/sov/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    const byDomain = Object.fromEntries(body.competitorLandscape.competitors.map(c => [c.domain, c]))
    // Total cited slots = project(1) + rivalA(3) + rivalB(1) = 5
    expect(byDomain['rival-a.com']!.sharePct).toBe(60)
    expect(byDomain['rival-b.com']!.sharePct).toBe(20)
    // The project's own count is exposed as projectCitationCount, not a row.
    // Verify total sums to 100 if we add the project share back in:
    expect(body.competitorLandscape.projectCitationCount).toBe(1)
  })

  test('returns sharePct=0 for every row when no snapshots have any cited domain', async () => {
    const projectId = insertProject(ctx.db, 'empty')
    insertCompetitor(ctx.db, projectId, 'rival.com')
    const k = insertQuery(ctx.db, projectId, 'k')
    const runId = insertRun(ctx.db, projectId)
    insertSnapshot(ctx.db, runId, k, { citationState: 'not-cited', citedDomains: [] })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/empty/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    for (const row of body.competitorLandscape.competitors) {
      expect(row.sharePct).toBe(0)
    }
  })
})

describe('CompetitorRow.theirCitedPages', () => {
  test('aggregates competitor cited URLs per query from groundingSources', async () => {
    const projectId = insertProject(ctx.db, 'pages')
    insertCompetitor(ctx.db, projectId, 'rival-a.com')
    const k1 = insertQuery(ctx.db, projectId, 'k1')
    const k2 = insertQuery(ctx.db, projectId, 'k2')
    const runId = insertRun(ctx.db, projectId)

    insertSnapshot(ctx.db, runId, k1, {
      citedDomains: ['rival-a.com'],
      rawResponse: {
        groundingSources: [{ uri: 'https://rival-a.com/page-x', title: 'X' }],
      },
    })
    insertSnapshot(ctx.db, runId, k2, {
      citedDomains: ['rival-a.com'],
      rawResponse: {
        groundingSources: [
          { uri: 'https://rival-a.com/page-x', title: 'X' },
          { uri: 'https://rival-a.com/page-y', title: 'Y' },
        ],
      },
    })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/pages/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    const rival = body.competitorLandscape.competitors.find(c => c.domain === 'rival-a.com')!
    expect(rival.theirCitedPages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: 'https://rival-a.com/page-x',
          citedFor: expect.arrayContaining(['k1', 'k2']),
        }),
        expect.objectContaining({
          url: 'https://rival-a.com/page-y',
          citedFor: ['k2'],
        }),
      ]),
    )
    expect(rival.theirCitedPages).toHaveLength(2)
  })

  test('returns empty theirCitedPages when no grounding sources reference the competitor', async () => {
    const projectId = insertProject(ctx.db, 'no-pages')
    insertCompetitor(ctx.db, projectId, 'rival.com')
    const k = insertQuery(ctx.db, projectId, 'k')
    const runId = insertRun(ctx.db, projectId)
    insertSnapshot(ctx.db, runId, k, { citedDomains: ['rival.com'] }) // no rawResponse

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/no-pages/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    const rival = body.competitorLandscape.competitors.find(c => c.domain === 'rival.com')!
    expect(rival.theirCitedPages).toEqual([])
  })

  test('ignores grounding sources from non-competitor domains', async () => {
    const projectId = insertProject(ctx.db, 'mixed')
    insertCompetitor(ctx.db, projectId, 'rival.com')
    const k = insertQuery(ctx.db, projectId, 'k')
    const runId = insertRun(ctx.db, projectId)
    insertSnapshot(ctx.db, runId, k, {
      citedDomains: ['rival.com', 'unrelated.com'],
      rawResponse: {
        groundingSources: [
          { uri: 'https://rival.com/keep', title: '' },
          { uri: 'https://unrelated.com/drop', title: '' },
        ],
      },
    })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/mixed/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    const rival = body.competitorLandscape.competitors.find(c => c.domain === 'rival.com')!
    expect(rival.theirCitedPages.map(p => p.url)).toEqual(['https://rival.com/keep'])
  })
})

describe('mentionLandscape', () => {
  test('counts per-competitor mentions from snapshot answer text', async () => {
    const projectId = insertProject(ctx.db, 'mentions', 'mentions.example.com')
    insertCompetitor(ctx.db, projectId, 'rival-a.com')
    insertCompetitor(ctx.db, projectId, 'rival-b.com')
    const k1 = insertQuery(ctx.db, projectId, 'k1')
    const k2 = insertQuery(ctx.db, projectId, 'k2')
    const k3 = insertQuery(ctx.db, projectId, 'k3')
    const runId = insertRun(ctx.db, projectId)

    // Snap 1: project + rival-a mentioned
    insertSnapshot(ctx.db, runId, k1, {
      answerText: 'Top picks include mentions.example.com and rival-a.com for this category.',
      answerMentioned: true,
    })
    // Snap 2: rival-a + rival-b mentioned, project not
    insertSnapshot(ctx.db, runId, k2, {
      answerText: 'Consider rival-a.com or rival-b.com depending on workflow.',
      answerMentioned: false,
    })
    // Snap 3: rival-a only
    insertSnapshot(ctx.db, runId, k3, {
      answerText: 'rival-a.com leads the category for this segment.',
      answerMentioned: false,
    })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/mentions/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.mentionLandscape.totalAnswerSnapshots).toBe(3)
    expect(body.mentionLandscape.projectMentionCount).toBe(1)
    const byDomain = Object.fromEntries(body.mentionLandscape.competitors.map(c => [c.domain, c]))
    expect(byDomain['rival-a.com']!.mentionCount).toBe(3)
    expect(byDomain['rival-b.com']!.mentionCount).toBe(1)
    expect(byDomain['rival-a.com']!.mentionedQueries).toEqual(expect.arrayContaining(['k1', 'k2', 'k3']))
    expect(byDomain['rival-a.com']!.pressureLabel).toBe('High')
    // SOV denominator = projectMentions(1) + rivalA(3) + rivalB(1) = 5
    expect(byDomain['rival-a.com']!.sharePct).toBe(60)
    expect(byDomain['rival-b.com']!.sharePct).toBe(20)
  })

  test('skips snapshots with no answer text from the totalCount denominator', async () => {
    const projectId = insertProject(ctx.db, 'no-text', 'no-text.example.com')
    insertCompetitor(ctx.db, projectId, 'rival.com')
    const k1 = insertQuery(ctx.db, projectId, 'k1')
    const k2 = insertQuery(ctx.db, projectId, 'k2')
    const runId = insertRun(ctx.db, projectId)

    insertSnapshot(ctx.db, runId, k1, { answerText: 'rival.com is mentioned here.' })
    insertSnapshot(ctx.db, runId, k2, { answerText: null }) // ignored

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/no-text/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.mentionLandscape.totalAnswerSnapshots).toBe(1)
    const rival = body.mentionLandscape.competitors.find(c => c.domain === 'rival.com')!
    expect(rival.mentionCount).toBe(1)
    expect(rival.totalCount).toBe(1)
  })

  test('returns zero mentions when no snapshot text references competitors or project', async () => {
    const projectId = insertProject(ctx.db, 'empty-mentions', 'empty.example.com')
    insertCompetitor(ctx.db, projectId, 'rival.com')
    const k = insertQuery(ctx.db, projectId, 'k')
    const runId = insertRun(ctx.db, projectId)
    insertSnapshot(ctx.db, runId, k, { answerText: 'Generic advice with no brand references.' })

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/empty-mentions/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.mentionLandscape.projectMentionCount).toBe(0)
    expect(body.mentionLandscape.competitors[0]!.mentionCount).toBe(0)
    expect(body.mentionLandscape.competitors[0]!.sharePct).toBe(0)
    expect(body.mentionLandscape.competitors[0]!.pressureLabel).toBe('None')
  })
})

describe('GscSection × AEO crossover', () => {
  function seedGscQueries(
    db: ReturnType<typeof createClient>,
    projectId: string,
    runId: string,
    queriesWithImpressions: Array<[string, number]>,
  ) {
    const now = new Date().toISOString()
    for (const [query, impressions] of queriesWithImpressions) {
      db.insert(gscSearchData).values({
        id: crypto.randomUUID(),
        projectId,
        syncRunId: runId,
        date: '2026-04-01',
        query,
        page: '/p',
        impressions,
        clicks: 0,
        ctr: '0',
        position: '10',
        createdAt: now,
      }).run()
    }
  }

  test('lists tracked AEO queries with no GSC impressions', async () => {
    const projectId = insertProject(ctx.db, 'cross1')
    insertQuery(ctx.db, projectId, 'tracked-with-gsc')
    insertQuery(ctx.db, projectId, 'tracked-no-gsc')
    const runId = insertRun(ctx.db, projectId)
    seedGscQueries(ctx.db, projectId, runId, [['tracked-with-gsc', 50]])

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/cross1/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.gsc).not.toBeNull()
    expect(body.gsc!.trackedButNoGsc).toEqual(['tracked-no-gsc'])
  })

  test('lists GSC top queries that are not tracked AEO queries', async () => {
    const projectId = insertProject(ctx.db, 'cross2')
    insertQuery(ctx.db, projectId, 'tracked')
    const runId = insertRun(ctx.db, projectId)
    seedGscQueries(ctx.db, projectId, runId, [
      ['tracked', 100],
      ['untracked-bigtraffic', 500],
      ['untracked-smalltraffic', 5],
    ])

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/cross2/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    // Sorted by impressions desc (highest demand first)
    expect(body.gsc!.gscButNotTracked.slice(0, 2)).toEqual([
      'untracked-bigtraffic',
      'untracked-smalltraffic',
    ])
    expect(body.gsc!.gscButNotTracked).not.toContain('tracked')
  })

  test('case-insensitive match between tracked query and GSC query', async () => {
    const projectId = insertProject(ctx.db, 'cross3')
    insertQuery(ctx.db, projectId, 'HVAC Estimator')
    const runId = insertRun(ctx.db, projectId)
    seedGscQueries(ctx.db, projectId, runId, [['hvac estimator', 100]])

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/cross3/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.gsc!.trackedButNoGsc).toEqual([])
    expect(body.gsc!.gscButNotTracked).toEqual([])
  })

  test('both lists empty when all tracked queries have GSC entries and no extras exist', async () => {
    const projectId = insertProject(ctx.db, 'cross4')
    insertQuery(ctx.db, projectId, 'foo')
    const runId = insertRun(ctx.db, projectId)
    seedGscQueries(ctx.db, projectId, runId, [['foo', 50]])

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/cross4/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    expect(body.gsc!.trackedButNoGsc).toEqual([])
    expect(body.gsc!.gscButNotTracked).toEqual([])
  })
})
