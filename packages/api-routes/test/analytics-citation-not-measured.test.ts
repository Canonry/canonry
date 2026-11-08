import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { createClient, migrate, projects, queries, runs, querySnapshots, competitors } from '@canonry/canonry-db'
import { brandMetricsDtoSchema, sourceBreakdownDtoSchema, type CitationState, type GapAnalysisDto, type RetrievalStatus } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'

// An engine with no web access (Local) returns no sources, so whether its
// answer cites the project is never observed. Its answers must leave every
// cited figure (numerator and denominator alike) while still counting for
// mention. Older Local rows stored `not-cited` beside retrieval
// `not-applicable` and must read the same way.

const DAY = 86_400_000
const now = Date.now()
const sweepA = new Date(now - 3 * DAY).toISOString()
const sweepB = new Date(now - 1 * DAY).toISOString()
// Newest of all, so a leak would also make it the latest sweep.
const probeAt = new Date(now - 1 * DAY + 3_600_000).toISOString()

const MENTIONED = 'Acme CRM is a strong pick for agencies.'
const NOT_MENTIONED = 'HubSpot is a strong pick for agencies.'

describe('analytics leave answers without sources out of cited figures', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string

  function seedProject(name: string, providers: string[]): { projectId: string; queryIds: string[] } {
    const projectId = crypto.randomUUID()
    const at = new Date(now - 10 * DAY).toISOString()
    db.insert(projects).values({
      id: projectId,
      name,
      displayName: 'Acme CRM',
      canonicalDomain: 'acme.example',
      country: 'US',
      language: 'en',
      providers,
      createdAt: at,
      updatedAt: at,
    }).run()
    db.insert(competitors).values({ id: crypto.randomUUID(), projectId, domain: 'rival.example', createdAt: at }).run()
    const queryIds = ['crm for agencies', 'crm pricing'].map(query => {
      const id = crypto.randomUUID()
      db.insert(queries).values({ id, projectId, query, createdAt: at }).run()
      return id
    })
    return { projectId, queryIds }
  }

  function seedRun(projectId: string, createdAt: string, trigger: 'manual' | 'probe' = 'manual'): string {
    const id = crypto.randomUUID()
    db.insert(runs).values({ id, projectId, kind: 'answer-visibility', status: 'completed', trigger, createdAt, finishedAt: createdAt }).run()
    return id
  }

  function seedAnswer(runId: string, queryId: string, answer: {
    provider: string
    citationState: CitationState
    retrievalStatus: RetrievalStatus
    citedDomains?: string[]
    mentioned: boolean
  }, createdAt: string): void {
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      queryId,
      provider: answer.provider,
      citationState: answer.citationState,
      retrievalStatus: answer.retrievalStatus,
      citedDomains: answer.citedDomains ?? [],
      answerMentioned: answer.mentioned,
      answerText: answer.mentioned ? MENTIONED : NOT_MENTIONED,
      createdAt,
    }).run()
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-not-measured-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    app = Fastify()
    app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()

    // Gemini can cite; Local cannot.
    const mixed = seedProject('mixed', ['gemini', 'local'])
    const [crm, pricing] = mixed.queryIds as [string, string]
    const a = seedRun(mixed.projectId, sweepA)
    seedAnswer(a, crm, { provider: 'gemini', citationState: 'cited', retrievalStatus: 'used', citedDomains: ['acme.example'], mentioned: true }, sweepA)
    // An older Local row: stored as a miss, its retrieval status says it had no sources.
    seedAnswer(a, crm, { provider: 'local', citationState: 'not-cited', retrievalStatus: 'not-applicable', mentioned: true }, sweepA)
    seedAnswer(a, pricing, { provider: 'gemini', citationState: 'not-cited', retrievalStatus: 'used', citedDomains: ['rival.example'], mentioned: false }, sweepA)
    seedAnswer(a, pricing, { provider: 'local', citationState: 'not-measured', retrievalStatus: 'not-applicable', mentioned: false }, sweepA)
    const b = seedRun(mixed.projectId, sweepB)
    seedAnswer(b, crm, { provider: 'gemini', citationState: 'not-cited', retrievalStatus: 'used', mentioned: false }, sweepB)
    seedAnswer(b, crm, { provider: 'local', citationState: 'not-measured', retrievalStatus: 'not-applicable', mentioned: true }, sweepB)
    // Gemini failed on this query in sweep B, so only Local answered it.
    seedAnswer(b, pricing, { provider: 'local', citationState: 'not-measured', retrievalStatus: 'not-applicable', mentioned: false }, sweepB)
    // A spot check that cites on both engines must move nothing.
    const probe = seedRun(mixed.projectId, probeAt, 'probe')
    seedAnswer(probe, crm, { provider: 'gemini', citationState: 'cited', retrievalStatus: 'used', citedDomains: ['acme.example'], mentioned: true }, probeAt)
    seedAnswer(probe, pricing, { provider: 'gemini', citationState: 'cited', retrievalStatus: 'used', citedDomains: ['acme.example'], mentioned: true }, probeAt)
    seedAnswer(probe, crm, { provider: 'local', citationState: 'not-measured', retrievalStatus: 'not-applicable', mentioned: true }, probeAt)

    // One Local row from each way Local answers were ever stored, beside Gemini.
    const eras = seedProject('local-eras', ['gemini', 'local'])
    const [eraQuery] = eras.queryIds as [string, string]
    const eraSweeps = [9, 7, 5, 3].map(days => new Date(now - days * DAY).toISOString())
    const localRows: Array<{ citationState: CitationState; retrievalStatus: RetrievalStatus | null; citedDomains: string[] }> = [
      // Before #871: "cited" from a domain the answer text wrote, no retrieval status.
      { citationState: 'cited', retrievalStatus: null, citedDomains: ['acme.example'] },
      // Before migration 112: no retrieval status.
      { citationState: 'not-cited', retrievalStatus: null, citedDomains: [] },
      // Before this release: retrieval recorded as not applicable.
      { citationState: 'not-cited', retrievalStatus: 'not-applicable', citedDomains: [] },
      // From this release.
      { citationState: 'not-measured', retrievalStatus: 'not-applicable', citedDomains: [] },
    ]
    eraSweeps.forEach((at, index) => {
      const run = seedRun(eras.projectId, at)
      const geminiCited = index % 2 === 1
      seedAnswer(run, eraQuery, { provider: 'gemini', citationState: geminiCited ? 'cited' : 'not-cited', retrievalStatus: 'used', citedDomains: geminiCited ? ['acme.example'] : [], mentioned: false }, at)
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(), runId: run, queryId: eraQuery, provider: 'local', ...localRows[index]!,
        answerMentioned: true, answerText: MENTIONED, createdAt: at,
      }).run()
    })

    // Only an engine without sources.
    const localOnly = seedProject('local-only', ['local'])
    const l = seedRun(localOnly.projectId, sweepB)
    seedAnswer(l, localOnly.queryIds[0]!, { provider: 'local', citationState: 'not-measured', retrievalStatus: 'not-applicable', mentioned: true }, sweepB)
    seedAnswer(l, localOnly.queryIds[1]!, { provider: 'local', citationState: 'not-cited', retrievalStatus: 'not-applicable', mentioned: false }, sweepB)
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function get(url: string): Promise<unknown> {
    const res = await app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(200)
    return JSON.parse(res.payload)
  }

  describe('GET /analytics/metrics', () => {
    it('rates citation over the answers whose sources were checked, and mention over every answer', async () => {
      const body = brandMetricsDtoSchema.parse(await get('/api/v1/projects/mixed/analytics/metrics?window=all'))

      // 7 answers outside the probe; 4 are Local's (two stored not-measured,
      // one older not-cited/not-applicable, one more not-measured). Cited is 1
      // of the 3 Gemini answers; mentioned is 3 of all 7.
      expect(body.overall).toEqual({ citationRate: 0.3333, cited: 1, total: 7, citationNotMeasured: 4, citedTotal: 3, mentionRate: 0.4286, mentionedCount: 3 })
      expect(body.byProvider.gemini).toEqual({ citationRate: 0.3333, cited: 1, total: 3, citationNotMeasured: 0, citedTotal: 3, mentionRate: 0.3333, mentionedCount: 1 })
      expect(body.byProvider.local).toEqual({ citationRate: null, cited: 0, total: 4, citationNotMeasured: 4, citedTotal: 0, mentionRate: 0.5, mentionedCount: 2 })
    })

    it('keeps each bucket and engine line on its own base, with no point where nothing was measured', async () => {
      const body = brandMetricsDtoSchema.parse(await get('/api/v1/projects/mixed/analytics/metrics?window=all'))

      expect(body.buckets.map(bucket => ({
        cited: bucket.cited, total: bucket.total, citationNotMeasured: bucket.citationNotMeasured, citedTotal: bucket.citedTotal,
        citationRate: bucket.citationRate, mentionRate: bucket.mentionRate,
      }))).toEqual([
        { cited: 1, total: 4, citationNotMeasured: 2, citedTotal: 2, citationRate: 0.5, mentionRate: 0.5 },
        { cited: 0, total: 3, citationNotMeasured: 2, citedTotal: 1, citationRate: 0, mentionRate: 0.3333 },
      ])
      expect(body.buckets[1]!.byProvider.gemini).toMatchObject({ citationRate: 0, cited: 0, total: 1, citationNotMeasured: 0 })
      expect(body.buckets[1]!.byProvider.local).toMatchObject({ citationRate: null, cited: 0, total: 2, citationNotMeasured: 2 })
    })

    it('compares and trends citation across the measured buckets only', async () => {
      const body = brandMetricsDtoSchema.parse(await get('/api/v1/projects/mixed/analytics/metrics?window=all'))

      expect(body.windowChange.citationRate).toEqual({ first: 0.5, latest: 0, delta: -0.5 })
      // 1 of 2 checked, then 0 of 1: a 50-point fall. Pooled with Local's
      // answers it would read 1 of 4 then 0 of 3.
      expect(body.trend).toBe('declining')
      expect(body.windowChange.mentionRate).toEqual({ first: 0.5, latest: 0.3333, delta: -0.1667 })
    })

    it('reads every stored Local row as not measured, so its series never mixes two methods', async () => {
      const body = brandMetricsDtoSchema.parse(await get('/api/v1/projects/local-eras/analytics/metrics?window=all'))

      // One row per storage era, including a pre-#871 "cited" taken from answer
      // text: none observed a source, so none is cited, missed, or a rate point.
      expect(body.byProvider.local).toMatchObject({ citationRate: null, cited: 0, total: 4, citationNotMeasured: 4 })
      expect(body.buckets.map(bucket => bucket.byProvider.local?.citationRate)).toEqual([null, null, null, null])
      // Cited is Gemini's alone: 2 of its 4 answers, in every bucket and overall.
      expect(body.overall).toMatchObject({ citationRate: 0.5, cited: 2, total: 8, citationNotMeasured: 4 })
      expect(body.buckets.map(bucket => bucket.citationRate)).toEqual([0, 1, 0, 1])
    })

    it('reads not measured, never 0%, when no engine returns sources', async () => {
      const body = brandMetricsDtoSchema.parse(await get('/api/v1/projects/local-only/analytics/metrics?window=all'))

      expect(body.overall).toEqual({ citationRate: null, cited: 0, total: 2, citationNotMeasured: 2, citedTotal: 0, mentionRate: 0.5, mentionedCount: 1 })
      expect(body.buckets.map(bucket => bucket.citationRate)).toEqual([null])
      expect(body.windowChange.citationRate).toBeNull()
      expect(body.trend).toBe('stable')
    })
  })

  describe('GET /analytics/gaps', () => {
    it('sets apart a query only an engine without sources answered, and keeps its mention', async () => {
      const body = await get('/api/v1/projects/mixed/analytics/gaps?window=all') as GapAnalysisDto
      const byQuery = (rows: GapAnalysisDto['cited']) => rows.map(row => row.query)

      // Latest sweep: "crm for agencies" was checked by Gemini and not cited;
      // "crm pricing" was answered by Local alone.
      expect(byQuery(body.cited)).toEqual([])
      expect(byQuery(body.gap)).toEqual([])
      expect(byQuery(body.uncited)).toEqual(['crm for agencies'])
      expect(byQuery(body.citationNotMeasured)).toEqual(['crm pricing'])
      expect(body.citationNotMeasured[0]!.category).toBe('not-measured')
      // Local's answer named the brand, which a mention lane still counts.
      expect(byQuery(body.mentionedQueries)).toEqual(['crm for agencies'])
      expect(byQuery(body.notMentioned)).toEqual(['crm pricing'])
    })

    it('counts citation consistency over the sweeps that checked a source', async () => {
      const body = await get('/api/v1/projects/mixed/analytics/gaps?window=all') as GapAnalysisDto
      const consistency = Object.fromEntries([...body.uncited, ...body.citationNotMeasured].map(row => [row.query, row.consistency]))

      expect(consistency['crm for agencies']).toEqual({ citedRuns: 1, totalRuns: 2, mentionedRuns: 2, citationNotMeasuredRuns: 0, citedTotalRuns: 2 })
      // Gemini checked "crm pricing" in sweep A only.
      expect(consistency['crm pricing']).toEqual({ citedRuns: 0, totalRuns: 2, mentionedRuns: 0, citationNotMeasuredRuns: 1, citedTotalRuns: 1 })
    })
  })

  describe('GET /analytics/sources', () => {
    it('takes answers without sources out of every count and names their engine', async () => {
      const body = sourceBreakdownDtoSchema.parse(await get('/api/v1/projects/mixed/analytics/sources?window=all'))

      expect(body.answerTotal).toBe(3)
      expect(body.citationNotMeasuredAnswers).toBe(4)
      expect(body.providersCitationNotMeasured).toEqual(['local'])
      expect(body.providersWithoutSources).toEqual([])
      expect(Object.keys(body.byProvider)).toEqual(['gemini'])
      expect(body.ranked.answerTotal).toBe(3)
      expect(body.ranked.answersWithSources).toBe(2)
      // Each domain is cited by 1 of the 3 answers that had sources to check.
      expect(body.ranked.entries.map(entry => [entry.domain, entry.count, entry.answerShare])).toEqual([
        ['acme.example', 1, 0.33333333],
        ['rival.example', 1, 0.33333333],
      ])
    })

    it('has no answer base at all when no engine returns sources', async () => {
      const body = sourceBreakdownDtoSchema.parse(await get('/api/v1/projects/local-only/analytics/sources?window=all'))

      expect(body.answerTotal).toBe(0)
      expect(body.citationNotMeasuredAnswers).toBe(2)
      expect(body.providersCitationNotMeasured).toEqual(['local'])
      expect(body.ranked.entries).toEqual([])
    })
  })
})
