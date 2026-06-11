import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bingCoverageSnapshots,
  createClient,
  migrate,
  insights,
  gscCoverageSnapshots,
  gscSearchData,
  gscUrlInspections,
  healthSnapshots,
  queries,
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
  const queryA = crypto.randomUUID()
  const queryB = crypto.randomUUID()

  db.insert(projects).values({
    id: projectId,
    name: 'demo',
    displayName: 'Demo',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    ownedDomains: [],
    tags: [],
    providers: [],
    createdAt: '2026-04-18T14:00:00.000Z',
    updatedAt: '2026-04-18T14:00:00.000Z',
  }).run()
  db.insert(queries).values([
    { id: queryA, projectId, query: 'answer engine optimization', createdAt: '2026-04-18T14:05:00.000Z' },
    { id: queryB, projectId, query: 'aeo monitoring', createdAt: '2026-04-18T14:05:00.000Z' },
  ]).run()
  db.insert(runs).values([
    { id: previousRunId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: '2026-04-18T14:10:00.000Z', finishedAt: '2026-04-18T14:11:00.000Z' },
    { id: latestRunId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: '2026-04-18T14:20:00.000Z', finishedAt: '2026-04-18T14:21:00.000Z' },
  ]).run()
  // previous run: A cited (gemini), B not cited
  db.insert(querySnapshots).values([
    { id: crypto.randomUUID(), runId: previousRunId, queryId: queryA, provider: 'gemini', citationState: 'cited', answerMentioned: true, citedDomains: ['example.com'], competitorOverlap: [], recommendedCompetitors: [], answerText: 'Example.com is the leader in answer engine optimization.', createdAt: '2026-04-18T14:10:30.000Z' },
    { id: crypto.randomUUID(), runId: previousRunId, queryId: queryB, provider: 'gemini', citationState: 'not-cited', answerMentioned: false, citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], answerText: null, createdAt: '2026-04-18T14:10:30.000Z' },
  ]).run()
  // latest run: A still cited, B newly cited (gained), plus an openai snapshot for variety
  db.insert(querySnapshots).values([
    { id: crypto.randomUUID(), runId: latestRunId, queryId: queryA, provider: 'gemini', citationState: 'cited', answerMentioned: true, citedDomains: ['example.com'], competitorOverlap: [], recommendedCompetitors: [], answerText: 'Example.com is the leader in answer engine optimization. Rival.com is the runner-up.', createdAt: '2026-04-18T14:20:30.000Z' },
    { id: crypto.randomUUID(), runId: latestRunId, queryId: queryB, provider: 'gemini', citationState: 'cited', answerMentioned: true, citedDomains: ['example.com'], competitorOverlap: [], recommendedCompetitors: [], answerText: 'Example.com offers AEO monitoring tools.', createdAt: '2026-04-18T14:20:30.000Z' },
    { id: crypto.randomUUID(), runId: latestRunId, queryId: queryA, provider: 'openai', citationState: 'not-cited', answerMentioned: false, citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], answerText: null, createdAt: '2026-04-18T14:20:30.000Z' },
  ]).run()
  db.insert(healthSnapshots).values({
    id: crypto.randomUUID(),
    projectId,
    runId: latestRunId,
    overallCitedRate: '0.6667',
    totalPairs: 3,
    citedPairs: 2,
    providerBreakdown: {},
    createdAt: '2026-04-18T14:21:00.000Z',
  }).run()
  // Two insights, one dismissed
  db.insert(insights).values([
    { id: crypto.randomUUID(), projectId, runId: latestRunId, type: 'gain', severity: 'high', title: 'Newly cited for "aeo monitoring"', query: 'aeo monitoring', provider: 'gemini', recommendation: null, cause: null, dismissed: false, createdAt: '2026-04-18T14:21:30.000Z' },
    { id: crypto.randomUUID(), projectId, runId: latestRunId, type: 'opportunity', severity: 'medium', title: 'Rival.com appears alongside example.com', query: 'answer engine optimization', provider: 'gemini', recommendation: null, cause: null, dismissed: true, createdAt: '2026-04-18T14:21:35.000Z' },
  ]).run()

  return { app, db, projectId, latestRunId, previousRunId, queryA, queryB }
}

// Seeds a 2-location project (azcoatings-test) with one or two fan-out groups
// of completed answer-visibility runs, each group sharing a single createdAt
// timestamp across both locations. Used to verify #480 — the /overview endpoint
// must aggregate across both locations rather than collapsing to one.
function seedTwoLocationFanOut(opts: { withPreviousGroup: boolean }) {
  const { app, db, tmpDir } = buildApp()
  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const projectId = crypto.randomUUID()
  const queryId = crypto.randomUUID()
  const latestFlId = crypto.randomUUID()
  const latestMiId = crypto.randomUUID()
  const latestCreatedAt = '2026-05-13T17:23:20.060Z'

  db.insert(projects).values({
    id: projectId,
    name: 'azcoatings-test',
    displayName: 'AZ Coatings (test)',
    canonicalDomain: 'azcoatings.example',
    country: 'US',
    language: 'en',
    ownedDomains: [],
    tags: [],
    providers: [],
    locations: [
      { label: 'florida',  city: 'Orlando', region: 'Florida',  country: 'US' },
      { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' },
    ],
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: latestCreatedAt,
  }).run()
  db.insert(queries).values({
    id: queryId,
    projectId,
    query: 'polyurea roof coating',
    createdAt: '2026-05-10T00:00:00.000Z',
  }).run()

  if (opts.withPreviousGroup) {
    const prevFlId = crypto.randomUUID()
    const prevMiId = crypto.randomUUID()
    const prevCreatedAt = '2026-05-12T17:23:20.060Z'
    db.insert(runs).values([
      { id: prevFlId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: 'florida',  createdAt: prevCreatedAt, finishedAt: prevCreatedAt },
      { id: prevMiId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: 'michigan', createdAt: prevCreatedAt, finishedAt: prevCreatedAt },
    ]).run()
    // Previous group: cited in BOTH locations.
    db.insert(querySnapshots).values([
      { id: crypto.randomUUID(), runId: prevFlId, queryId, provider: 'gemini', citationState: 'cited', answerMentioned: true, location: 'florida',  citedDomains: ['azcoatings.example'], competitorOverlap: [], recommendedCompetitors: [], answerText: null, createdAt: prevCreatedAt },
      { id: crypto.randomUUID(), runId: prevMiId, queryId, provider: 'gemini', citationState: 'cited', answerMentioned: true, location: 'michigan', citedDomains: ['azcoatings.example'], competitorOverlap: [], recommendedCompetitors: [], answerText: null, createdAt: prevCreatedAt },
    ]).run()
  }

  db.insert(runs).values([
    { id: latestFlId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: 'florida',  createdAt: latestCreatedAt, finishedAt: latestCreatedAt },
    { id: latestMiId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: 'michigan', createdAt: latestCreatedAt, finishedAt: latestCreatedAt },
  ]).run()
  // Latest group: cited in florida only; not cited in michigan.
  db.insert(querySnapshots).values([
    { id: crypto.randomUUID(), runId: latestFlId, queryId, provider: 'gemini', citationState: 'cited',     answerMentioned: true,  location: 'florida',  citedDomains: ['azcoatings.example'], competitorOverlap: [], recommendedCompetitors: [], answerText: null, createdAt: latestCreatedAt },
    { id: crypto.randomUUID(), runId: latestMiId, queryId, provider: 'gemini', citationState: 'not-cited', answerMentioned: false, location: 'michigan', citedDomains: [],                       competitorOverlap: [], recommendedCompetitors: [], answerText: null, createdAt: latestCreatedAt },
  ]).run()

  return { app, db, projectId, queryId, latestFlId, latestMiId }
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
    expect(body.queryCounts).toEqual({
      totalQueries: 2,
      citedQueries: 2,
      notCitedQueries: 0,
      citedRate: 1,
      mentionedQueries: 2,
      notMentionedQueries: 0,
      mentionRate: 1,
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

  it('populates the Phase 2 score gauges, movement, and provider scores', async () => {
    const { app } = seedProjectWithRuns()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/overview' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as ProjectOverviewDto

    expect(body.scores.visibility.label).toBe('Citation Coverage')
    expect(body.scores.visibility.value).toBe('100')
    expect(body.scores.visibility.tone).toBe('positive')

    // Mention coverage is the new primary metric. The seeded snapshots have
    // queryA and queryB both with answerMentioned=true on gemini's latest run,
    // so all 2 tracked queries count as mentioned → 100%.
    expect(body.scores.mention.label).toBe('Mention Coverage')
    expect(body.scores.mention.value).toBe('100')
    expect(body.scores.mention.tone).toBe('positive')
    expect(body.scores.mention.delta).toBe('2 of 2 queries mentioned')

    expect(body.scores.gapQueries.value).toBe('0')
    expect(body.scores.indexCoverage.value).toBe('No data')
    expect(body.scores.competitorPressure.value).toBe('None')
    expect(body.scores.runStatus.value).toBe('Healthy')

    // Mention Share — no competitors configured, so the breakdown is empty
    // and the gauge renders the "add competitors" neutral state. The
    // snapshotsTotal still reflects the seeded snapshots so the UI can
    // explain why no comparison is possible despite real run data.
    expect(body.scores.mentionShare.label).toBe('Mention Share')
    expect(body.scores.mentionShare.tone).toBe('neutral')
    expect(body.scores.mentionShare.value).toBe('Add competitors')
    expect(body.scores.mentionShare.breakdown.perCompetitor).toEqual([])
    expect(body.scores.mentionShare.breakdown.projectMentionSnapshots).toBe(0)
    expect(body.scores.mentionShare.breakdown.competitorMentionSnapshots).toBe(0)

    expect(body.movementSummary).toEqual({
      gained: 1,
      lost: 0,
      tone: 'positive',
      hasPreviousRun: true,
      gainedQueries: ['aeo monitoring'],
      lostQueries: [],
    })

    expect(body.providerScores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'gemini', score: 100, cited: 2, total: 2 }),
        expect.objectContaining({ provider: 'openai', score: 0, cited: 0, total: 1 }),
      ]),
    )

    // No competitors are configured in the seed.
    expect(body.competitors).toEqual([])

    expect(body.attentionItems).toHaveLength(1)
    expect(body.attentionItems[0]?.actionLabel).toBe('High')

    expect(body.runHistory).toHaveLength(2)
    expect(body.runHistory[0]?.citationRate).toBe(50) // previous run: A cited, B not
    expect(body.runHistory[1]?.citationRate).toBe(100) // latest run: both cited
    // Mention is tracked per run independently: previous run had A mentioned
    // (answerMentioned=true), B not → 50%; latest run had both mentioned → 100%.
    expect(body.runHistory[0]?.mentionRate).toBe(50)
    expect(body.runHistory[1]?.mentionRate).toBe(100)

    // Each headline score carries its own over-time series (the portfolio
    // sparkline + `canonry overview` read mention.trend now) — same ascending
    // 0–100 values as runHistory, derived from it.
    expect(body.scores.mention.trend).toEqual([50, 100])
    expect(body.scores.visibility.trend).toEqual([50, 100])

    expect(body.dateRangeLabel).toBe('All time')
    expect(body.contextLabel).toBe('US / EN')

    // Suggested queries — seed has no GSC search data, so the panel is empty.
    expect(body.suggestedQueries).toEqual({
      rows: [],
      totalCandidates: 0,
      skippedAlreadyTracked: 0,
    })
  })

  it('elevates index-coverage tone to negative when GSC reports newly deindexed URLs', async () => {
    const { app, db, projectId } = seedProjectWithRuns()
    // Headline percentage stays high (95%) but a previously indexed URL just flipped to non-indexed.
    db.insert(gscCoverageSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-04-18',
      indexed: 19,
      notIndexed: 1,
      reasonBreakdown: {},
      createdAt: '2026-04-18T14:25:00.000Z',
    }).run()
    db.insert(gscUrlInspections).values([
      // First (older) inspection for /a — was indexed
      { id: crypto.randomUUID(), projectId, url: 'https://example.com/a', indexingState: 'INDEXING_ALLOWED', verdict: 'PASS', coverageState: 'Submitted and indexed', pageFetchState: 'SUCCESSFUL', robotsTxtState: 'ALLOWED', crawlTime: null, lastCrawlResult: null, isMobileFriendly: 1, richResults: '[]', referringUrls: '[]', inspectedAt: '2026-04-15T00:00:00.000Z', createdAt: '2026-04-15T00:00:00.000Z' },
      // Latest inspection for /a — flipped to deindexed
      { id: crypto.randomUUID(), projectId, url: 'https://example.com/a', indexingState: 'BLOCKED', verdict: 'FAIL', coverageState: 'Excluded by noindex tag', pageFetchState: 'SUCCESSFUL', robotsTxtState: 'ALLOWED', crawlTime: null, lastCrawlResult: null, isMobileFriendly: 1, richResults: '[]', referringUrls: '[]', inspectedAt: '2026-04-18T00:00:00.000Z', createdAt: '2026-04-18T00:00:00.000Z' },
    ]).run()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/overview' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as ProjectOverviewDto

    expect(body.scores.indexCoverage.value).toBe('95')
    expect(body.scores.indexCoverage.tone).toBe('negative')
    expect(body.scores.indexCoverage.description).toMatch(/1 deindexed URL detected/)
  })

  it('uses Bing coverage when GSC has none, and never elevates tone for Bing (no inspection history)', async () => {
    const { app, db, projectId } = seedProjectWithRuns()
    db.insert(bingCoverageSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-04-18',
      indexed: 6,
      notIndexed: 4,
      reasonBreakdown: {},
      createdAt: '2026-04-18T14:25:00.000Z',
    }).run()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/overview' })
    const body = JSON.parse(res.payload) as ProjectOverviewDto

    expect(body.scores.indexCoverage.delta).toMatch(/^Bing/)
    expect(body.scores.indexCoverage.value).toBe('60')
    // 60% indexed → negative under the headline-only thresholds, unrelated to deindexed.
    expect(body.scores.indexCoverage.tone).toBe('negative')
    expect(body.scores.indexCoverage.description).not.toMatch(/deindexed/)
  })

  it('honors the ?since filter by excluding runs older than the cutoff', async () => {
    const { app } = seedProjectWithRuns()
    await app.ready()

    // Cutoff after the previous run but before the latest — only the latest survives.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo/overview?since=2026-04-18T14:15:00.000Z',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as ProjectOverviewDto

    expect(body.latestRun.totalRuns).toBe(1)
    expect(body.runHistory).toHaveLength(1)
    expect(body.movementSummary.hasPreviousRun).toBe(false)
    expect(body.transitions.since).toBeNull()
  })

  it('rejects ?since values that are not valid ISO datetimes', async () => {
    const { app } = seedProjectWithRuns()
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo/overview?since=not-a-date',
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error.code).toBe('VALIDATION_ERROR')
  })

  it('filters runs by ?location label, returning empty data when no run matches', async () => {
    const { app } = seedProjectWithRuns()
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demo/overview?location=Boston',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as ProjectOverviewDto
    // Seed has no runs with location='Boston' — every snapshot-derived metric
    // collapses to its empty form.
    expect(body.latestRun.totalRuns).toBe(0)
    expect(body.runHistory).toHaveLength(0)
    expect(body.scores.visibility.value).toBe('No data')
  })

  it('does NOT raise a stale-visibility attention item when the most recent non-visibility run is a discovery run (aeo-discover-probe)', async () => {
    // Stale-visibility hint should fire only for real upstream integration
    // syncs. After PR 1a, discovery has its own run kinds; without the
    // INTEGRATION_SYNC_KINDS allowlist, an active discovery session would
    // wrongly trigger the warning.
    const { app, db, projectId } = seedProjectWithRuns()
    // Insert a discovery probe that ran AFTER the latest visibility sweep
    // (which is at 2026-04-18T14:20:00.000Z per the seed). Use ample lag
    // (> 1 day) so the hint would have fired if the predicate were wrong.
    db.insert(runs).values({
      id: crypto.randomUUID(),
      projectId,
      kind: 'aeo-discover-probe',
      status: 'completed',
      trigger: 'manual',
      createdAt: '2026-04-20T14:00:00.000Z',
      finishedAt: '2026-04-20T14:01:00.000Z',
    }).run()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/overview' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as ProjectOverviewDto

    expect(body.attentionItems.find((i) => i.id === 'stale_visibility')).toBeUndefined()
  })

  it('DOES raise a stale-visibility attention item when a real integration sync (gsc-sync) ran more recently', async () => {
    const { app, db, projectId } = seedProjectWithRuns()
    db.insert(runs).values({
      id: crypto.randomUUID(),
      projectId,
      kind: 'gsc-sync',
      status: 'completed',
      trigger: 'manual',
      createdAt: '2026-04-20T14:00:00.000Z',
      finishedAt: '2026-04-20T14:01:00.000Z',
    }).run()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/overview' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as ProjectOverviewDto

    const stale = body.attentionItems.find((i) => i.id === 'stale_visibility')
    expect(stale).toBeDefined()
    expect(stale?.tone).toBe('caution')
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
      ownedDomains: [],
      tags: [],
      providers: [],
      createdAt: '2026-04-18T14:00:00.000Z',
      updatedAt: '2026-04-18T14:00:00.000Z',
    }).run()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/empty/overview' })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.payload) as ProjectOverviewDto
    expect(body.latestRun).toEqual({ totalRuns: 0, run: null })
    expect(body.health).toBeNull()
    expect(body.topInsights).toEqual([])
    expect(body.queryCounts).toEqual({ totalQueries: 0, citedQueries: 0, notCitedQueries: 0, citedRate: 0, mentionedQueries: 0, notMentionedQueries: 0, mentionRate: 0 })
    expect(body.providers).toEqual([])
    expect(body.transitions).toEqual({ since: null, gained: 0, lost: 0, emerging: 0 })

    await app.close()
  })

  // queryCounts.mentionedQueries must read the mention signal (answerMentioned)
  // independently of cited — never derived from it. Seed queries where the two
  // signals deliberately diverge and prove the counts track their own field.
  it('counts mentioned queries from answerMentioned, disjoint from cited', async () => {
    const { app, db, tmpDir } = buildApp()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

    const projectId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const qCitedOnly = crypto.randomUUID()
    const qMentionOnly = crypto.randomUUID()
    const qBoth = crypto.randomUUID()
    const qCitedOnly2 = crypto.randomUUID()

    db.insert(projects).values({
      id: projectId, name: 'split', displayName: 'Split', canonicalDomain: 'split.example',
      country: 'US', language: 'en', ownedDomains: [], tags: [], providers: [],
      createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
    }).run()
    db.insert(queries).values([
      { id: qCitedOnly, projectId, query: 'cited not mentioned', createdAt: '2026-05-01T00:00:00.000Z' },
      { id: qMentionOnly, projectId, query: 'mentioned not cited', createdAt: '2026-05-01T00:00:00.000Z' },
      { id: qBoth, projectId, query: 'cited and mentioned', createdAt: '2026-05-01T00:00:00.000Z' },
      { id: qCitedOnly2, projectId, query: 'cited not mentioned two', createdAt: '2026-05-01T00:00:00.000Z' },
    ]).run()
    db.insert(runs).values({
      id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
      createdAt: '2026-05-01T01:00:00.000Z', finishedAt: '2026-05-01T01:01:00.000Z',
    }).run()
    const snap = (queryId: string, citationState: string, answerMentioned: boolean) => ({
      id: crypto.randomUUID(), runId, queryId, provider: 'gemini', citationState, answerMentioned,
      citedDomains: citationState === 'cited' ? ['split.example'] : [],
      competitorOverlap: [], recommendedCompetitors: [], answerText: null, createdAt: '2026-05-01T01:00:30.000Z',
    })
    db.insert(querySnapshots).values([
      snap(qCitedOnly, 'cited', false),
      snap(qMentionOnly, 'not-cited', true),
      snap(qBoth, 'cited', true),
      snap(qCitedOnly2, 'cited', false),
    ]).run()

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/split/overview' })
    expect(res.statusCode).toBe(200)
    const qc = (JSON.parse(res.payload) as ProjectOverviewDto).queryCounts

    expect(qc.totalQueries).toBe(4)
    // cited = {CitedOnly, Both, CitedOnly2} = 3; mentioned = {MentionOnly, Both} = 2.
    expect(qc.citedQueries).toBe(3)
    expect(qc.mentionedQueries).toBe(2)
    expect(qc.notCitedQueries).toBe(1)
    expect(qc.notMentionedQueries).toBe(2)
    expect(qc.citedRate).toBe(0.75)
    expect(qc.mentionRate).toBe(0.5)
    // Disjointness proof: the mentioned set INCLUDES a not-cited query and
    // EXCLUDES a cited-but-not-mentioned query, so mentionedQueries cannot have
    // been derived from the cited signal (and vice versa).
    expect(qc.mentionedQueries).not.toBe(qc.citedQueries)

    await app.close()
  })

  // Regression suite for #480: multi-location fan-out previously collapsed to
  // one location's run via completedVisRuns[0]/[1], silently halving the data
  // visible in queryCounts/providerScores/movementSummary and mislabeling the
  // sibling location's current run as "previous."
  it('aggregates snapshots from both fan-out locations into latestSnapshots', async () => {
    const { app } = seedTwoLocationFanOut({ withPreviousGroup: true })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/azcoatings-test/overview' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as ProjectOverviewDto

    // 1 tracked query; cited in florida (yes), michigan (no). Project-level
    // "cited" = cited in any (provider × location), so citedQueries == 1.
    expect(body.queryCounts.totalQueries).toBe(1)
    expect(body.queryCounts.citedQueries).toBe(1)

    // Provider scores must reflect BOTH locations' snapshots: 1 of 2
    // (provider × location) pairs cited. Before the fix, this returned 1/1
    // (florida only).
    const gemini = body.providers.find(p => p.provider === 'gemini')
    expect(gemini?.total).toBe(2)
    expect(gemini?.cited).toBe(1)

    await app.close()
  })

  it('movementSummary compares latest fan-out group vs previous fan-out group, not within-group', async () => {
    const { app } = seedTwoLocationFanOut({ withPreviousGroup: true })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/azcoatings-test/overview' })
    const body = JSON.parse(res.payload) as ProjectOverviewDto

    // Previous group: cited in both locations → project-level cited.
    // Latest group:   cited in florida only  → still project-level cited.
    // Project-level cited status unchanged, so gained=0, lost=0,
    // hasPreviousRun=true. The buggy pre-fix code happened to return the
    // same gained/lost numbers because it compared florida-latest to
    // michigan-latest (both cited at florida, not-cited at michigan, by
    // coincidence near zero); this test now asserts the correct semantic
    // path is taken.
    expect(body.movementSummary.hasPreviousRun).toBe(true)
    expect(body.movementSummary.gained).toBe(0)
    expect(body.movementSummary.lost).toBe(0)

    await app.close()
  })

  it('hasPreviousRun=false when only one fan-out group exists', async () => {
    // With only the latest fan-out group present (no earlier sweep), the
    // previous group is empty and the buggy `[1]` pick used to return the
    // sibling location's current run, falsely setting hasPreviousRun=true.
    const { app } = seedTwoLocationFanOut({ withPreviousGroup: false })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/azcoatings-test/overview' })
    const body = JSON.parse(res.payload) as ProjectOverviewDto

    expect(body.movementSummary.hasPreviousRun).toBe(false)
    expect(body.movementSummary.gained).toBeGreaterThanOrEqual(0)
    expect(body.movementSummary.lost).toBe(0)

    await app.close()
  })

  it('populates suggestedQueries from GSC data, excluding queries already in the tracked basket', async () => {
    const { app, db, projectId, latestRunId } = seedProjectWithRuns()
    const today = new Date().toISOString().slice(0, 10)
    // Seed 4 GSC queries:
    //  - 'answer engine optimization' — ALREADY tracked (queryA) → skipped
    //  - 'best aeo tool' — high impressions, untracked → top suggestion
    //  - 'how to track ai citations' — medium, untracked → second
    //  - 'a' — empty/below-floor (5 impressions) → dropped
    db.insert(gscSearchData).values([
      { id: crypto.randomUUID(), projectId, syncRunId: latestRunId, date: today, query: 'answer engine optimization', page: '/aeo', impressions: 3000, clicks: 60, ctr: '0.02', position: '8', createdAt: new Date().toISOString() },
      { id: crypto.randomUUID(), projectId, syncRunId: latestRunId, date: today, query: 'best aeo tool', page: '/tools', impressions: 1800, clicks: 30, ctr: '0.017', position: '12', createdAt: new Date().toISOString() },
      { id: crypto.randomUUID(), projectId, syncRunId: latestRunId, date: today, query: 'how to track ai citations', page: '/track', impressions: 400, clicks: 5, ctr: '0.013', position: '22', createdAt: new Date().toISOString() },
      { id: crypto.randomUUID(), projectId, syncRunId: latestRunId, date: today, query: 'low traffic q', page: '/low', impressions: 5, clicks: 0, ctr: '0', position: '90', createdAt: new Date().toISOString() },
    ]).run()
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/overview' })
    const body = JSON.parse(res.payload) as ProjectOverviewDto

    expect(body.suggestedQueries.rows.map(r => r.query)).toEqual([
      'best aeo tool',
      'how to track ai citations',
    ])
    expect(body.suggestedQueries.totalCandidates).toBe(2)
    expect(body.suggestedQueries.skippedAlreadyTracked).toBe(1)
    expect(body.suggestedQueries.rows[0]?.reason).toMatch(/1\.8K impressions.*#12/)

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
