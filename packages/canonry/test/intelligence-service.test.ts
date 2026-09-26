import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, onTestFinished } from 'vitest'
import { createClient, migrate, projects, runs, queries, competitors, querySnapshots, insights, healthSnapshots } from '@ainyc/canonry-db'
import { IntelligenceService } from '../src/intelligence-service.js'

function createTempDb(prefix: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  return { db, tmpDir }
}

function seedProject(db: ReturnType<typeof createClient>) {
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'test-project',
    displayName: 'Test Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: '["gemini"]',
    createdAt: now,
    updatedAt: now,
  }).run()
  return projectId
}

function seedRun(db: ReturnType<typeof createClient>, projectId: string, status: string, finishedAt?: string) {
  const now = new Date().toISOString()
  const runId = crypto.randomUUID()
  db.insert(runs).values({
    id: runId,
    projectId,
    status,
    createdAt: now,
    finishedAt: finishedAt ?? now,
  }).run()
  return runId
}

function seedQuery(db: ReturnType<typeof createClient>, projectId: string, word: string) {
  const id = crypto.randomUUID()
  db.insert(queries).values({
    id,
    projectId,
    query: word,
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

function seedSnapshot(
  db: ReturnType<typeof createClient>,
  runId: string,
  queryId: string,
  provider: string,
  citationState: string,
  opts?: {
    citedDomains?: string[]
    competitorOverlap?: string[]
    answerMentioned?: boolean | null
    answerText?: string | null
    groundingSources?: Array<{ uri: string; title?: string }>
  },
) {
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId,
    queryId,
    provider,
    model: 'test-model',
    citationState,
    // Tri-state mention signal. Default null ("not checked") when the caller
    // doesn't specify, mirroring legacy snapshots written before the signal.
    answerMentioned: opts?.answerMentioned ?? null,
    answerText: opts?.answerText ?? null,
    citedDomains: opts?.citedDomains ?? [],
    competitorOverlap: opts?.competitorOverlap ?? [],
    rawResponse: opts?.groundingSources
      ? JSON.stringify({ groundingSources: opts.groundingSources })
      : null,
    createdAt: new Date().toISOString(),
  }).run()
}

describe('IntelligenceService', () => {
  describe('analyzeAndPersist', () => {
    it('persists insights and health snapshot for a completed run', () => {
      const { db } = createTempDb('intel-test-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'roof repair')
      const runId = seedRun(db, projectId, 'completed')
      seedSnapshot(db, runId, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(runId, projectId)

      expect(result).not.toBeNull()
      expect(result!.health.totalPairs).toBe(1)
      expect(result!.health.citedPairs).toBe(1)

      // Verify DB persistence
      const savedInsights = db.select().from(insights).all()
      const savedHealth = db.select().from(healthSnapshots).all()
      expect(savedHealth).toHaveLength(1)
      expect(savedHealth[0]!.runId).toBe(runId)
      expect(savedHealth[0]!.totalPairs).toBe(1)
      // Insights may or may not be generated depending on analysis (first run = opportunities)
      for (const insight of savedInsights) {
        expect(insight.runId).toBe(runId)
        expect(insight.projectId).toBe(projectId)
      }
    })

    it('threads answerMentioned from query_snapshots → computeHealth → persisted mention columns', () => {
      const { db } = createTempDb('intel-mention-')
      const projectId = seedProject(db)
      const q1 = seedQuery(db, projectId, 'roof repair')
      const q2 = seedQuery(db, projectId, 'metal roofing')
      const q3 = seedQuery(db, projectId, 'roof coating')
      const runId = seedRun(db, projectId, 'completed')
      // 3 pairs. Mentioned set is DIFFERENT from cited set, proving the two
      // signals are independent end-to-end:
      //   cited   : q1, q2           → 2/3
      //   mention : q1, q3           → 2/3 (but different queries)
      seedSnapshot(db, runId, q1, 'gemini', 'cited',     { citedDomains: ['example.com'], answerMentioned: true })
      seedSnapshot(db, runId, q2, 'gemini', 'cited',     { citedDomains: ['example.com'], answerMentioned: false })
      seedSnapshot(db, runId, q3, 'gemini', 'not-cited', { answerMentioned: true })

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(runId, projectId)

      expect(result).not.toBeNull()
      // In-memory health carries the mention math.
      expect(result!.health.totalPairs).toBe(3)
      expect(result!.health.citedPairs).toBe(2)
      expect(result!.health.mentionedPairs).toBe(2)
      expect(result!.health.overallMentionRate).toBeCloseTo(2 / 3, 5)
      expect(result!.health.providerBreakdown.gemini.mentioned).toBe(2)
      expect(result!.health.providerBreakdown.gemini.mentionRate).toBeCloseTo(2 / 3, 5)

      // Round-trip: the persisted health_snapshots row carries the new columns.
      const saved = db.select().from(healthSnapshots).all()
      expect(saved).toHaveLength(1)
      expect(saved[0]!.mentionedPairs).toBe(2)
      expect(Number(saved[0]!.overallMentionRate)).toBeCloseTo(2 / 3, 5)
      const providerBreakdown = saved[0]!.providerBreakdown as Record<string, { mentionRate: number; mentioned: number; total: number }>
      expect(providerBreakdown.gemini.mentioned).toBe(2)
      expect(providerBreakdown.gemini.total).toBe(3)
    })

    it('never counts a null answerMentioned (legacy snapshot) as mentioned', () => {
      const { db } = createTempDb('intel-mention-null-')
      const projectId = seedProject(db)
      const q1 = seedQuery(db, projectId, 'q1')
      const q2 = seedQuery(db, projectId, 'q2')
      const runId = seedRun(db, projectId, 'completed')
      // One mentioned, one with null (default — never checked). Mention = 1/2,
      // not 0/2 nor 2/2; null must not coerce to false in the numerator.
      seedSnapshot(db, runId, q1, 'gemini', 'cited', { citedDomains: ['example.com'], answerMentioned: true })
      seedSnapshot(db, runId, q2, 'gemini', 'cited', { citedDomains: ['example.com'] }) // answerMentioned → null

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(runId, projectId)

      expect(result!.health.totalPairs).toBe(2)
      expect(result!.health.mentionedPairs).toBe(1)
      expect(result!.health.overallMentionRate).toBe(0.5)

      const saved = db.select().from(healthSnapshots).all()
      expect(saved[0]!.mentionedPairs).toBe(1)
    })

    it('returns null when run has no snapshots', () => {
      const { db } = createTempDb('intel-empty-')
      const projectId = seedProject(db)
      const runId = seedRun(db, projectId, 'completed')

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(runId, projectId)

      expect(result).toBeNull()
    })

    it('returns null for a run that is not eligible for analysis', () => {
      // Eligibility is a property of the RUN, not of its recency: wrong kind,
      // non-terminal status, or a probe trigger. (This case used to be
      // "not in the recent completed list", which coupled eligibility to
      // whether the run happened to be one of the 5 newest rows — the
      // coupling that refused whole arms of a 6+ location fan-out.)
      const { db } = createTempDb('intel-ineligible-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'roof repair')
      const service = new IntelligenceService(db)

      const ineligible: Array<[string, Partial<typeof runs.$inferInsert>]> = [
        ['wrong kind', { kind: 'ga-sync' }],
        ['still running', { status: 'running' }],
        ['failed', { status: 'failed' }],
        ['probe trigger', { trigger: 'probe' }],
      ]

      for (const [label, overrides] of ineligible) {
        const runId = crypto.randomUUID()
        db.insert(runs).values({
          id: runId,
          projectId,
          kind: 'answer-visibility',
          status: 'completed',
          trigger: 'manual',
          createdAt: '2024-01-01T00:00:00Z',
          finishedAt: '2024-01-01T00:00:00Z',
          ...overrides,
        }).run()
        // Snapshots present, so a null result can only come from eligibility.
        seedSnapshot(db, runId, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

        expect(service.analyzeAndPersist(runId, projectId), label).toBeNull()
      }

      // Control: same shape, eligible — proves the seed itself is analyzable.
      const eligible = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, eligible, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })
      expect(service.analyzeAndPersist(eligible, projectId)).not.toBeNull()
    })

    it('is idempotent — reprocessing preserves dismissed state', async () => {
      const { db } = createTempDb('intel-idempotent-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'best roofing')
      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })
      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, queryId, 'gemini', 'not-cited')

      const service = new IntelligenceService(db)
      service.analyzeAndPersist(run2, projectId)

      // Dismiss an insight
      const insightRows = db.select().from(insights).all()
      if (insightRows.length > 0) {
        const { eq } = await import('drizzle-orm')
        db.update(insights).set({ dismissed: true }).where(eq(insights.id, insightRows[0]!.id)).run()

        // Reprocess — dismissed state should be preserved
        service.analyzeAndPersist(run2, projectId)

        const afterReprocess = db.select().from(insights).all()
        const matchingInsight = afterReprocess.find(
          i => i.query === insightRows[0]!.query && i.provider === insightRows[0]!.provider && i.type === insightRows[0]!.type,
        )
        expect(matchingInsight?.dismissed).toBe(true)
      }
    })

    it('does not produce false gain insights on first run', () => {
      const { db } = createTempDb('intel-first-run-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'roof repair')
      const runId = seedRun(db, projectId, 'completed')
      seedSnapshot(db, runId, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(runId, projectId)

      expect(result).not.toBeNull()
      // Health snapshot should be persisted
      const savedHealth = db.select().from(healthSnapshots).all()
      expect(savedHealth).toHaveLength(1)
      expect(savedHealth[0]!.totalPairs).toBe(1)
      expect(savedHealth[0]!.citedPairs).toBe(1)
      // No transition insights on first run — there is no baseline to compare against
      const savedInsights = db.select().from(insights).all()
      expect(savedInsights).toHaveLength(0)
    })

    it('detects regressions between two runs', () => {
      const { db } = createTempDb('intel-regression-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'roof repair phoenix')

      // Run 1: cited
      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      // Run 2: not cited
      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, queryId, 'gemini', 'not-cited')

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(run2, projectId)

      expect(result).not.toBeNull()
      expect(result!.regressions.length).toBeGreaterThan(0)
      expect(result!.regressions[0]!.query).toBe('roof repair phoenix')
    })

    it('labels a regression with the project domain, not a co-cited competitor', () => {
      const { db } = createTempDb('intel-regression-label-')
      const projectId = seedProject(db) // canonicalDomain: example.com

      const queryId = seedQuery(db, projectId, 'roof repair phoenix')

      // Run 1: project cited, but a competitor sorts first in the FULL
      // citedDomains set (provider order, not project order).
      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', {
        citedDomains: ['tilerival.test', 'example.com'],
      })

      // Run 2: project lost its citation.
      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, queryId, 'gemini', 'not-cited')

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(run2, projectId)

      expect(result!.regressions).toHaveLength(1)
      // The regression is real (project lost its own citation), and its target
      // must be the project's page — never the co-cited competitor.
      expect(result!.regressions[0]!.previousCitationUrl).toBe('example.com')

      const regressionInsight = db.select().from(insights).all()
        .find(i => i.type === 'regression')
      expect(regressionInsight?.recommendation?.target).toBe('example.com')
    })

    it('labels a gain with the project domain, not a co-cited competitor', () => {
      const { db } = createTempDb('intel-gain-label-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'roof repair phoenix')

      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, queryId, 'gemini', 'not-cited')

      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, queryId, 'gemini', 'cited', {
        citedDomains: ['tilerival.test', 'example.com'],
      })

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(run2, projectId)

      const gain = result!.gains.find(g => g.query === 'roof repair phoenix')
      expect(gain?.citationUrl).toBe('example.com')
    })

    it('leaves citationUrl undefined when the project was cited via grounding only', () => {
      const { db } = createTempDb('intel-grounding-label-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'roof repair phoenix')

      // citationState is 'cited' (matched via a grounding source upstream), but
      // no project domain is present in the stored citedDomains set — only a
      // competitor. We must not borrow the competitor as the project's URL.
      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['tilerival.test'] })

      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, queryId, 'gemini', 'not-cited')

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(run2, projectId)

      expect(result!.regressions).toHaveLength(1)
      expect(result!.regressions[0]!.previousCitationUrl).toBeUndefined()
    })

    it('persists first-citation, provider-pickup, persistent-gap, and competitor signals', () => {
      const { db } = createTempDb('intel-signals-')
      const projectId = seedProject(db)
      // Seed competitor so competitor signals are detected
      db.insert(competitors).values({
        id: crypto.randomUUID(),
        projectId,
        domain: 'rival.com',
        createdAt: new Date().toISOString(),
      }).run()

      const k1 = seedQuery(db, projectId, 'k1') // first-citation candidate
      const k2 = seedQuery(db, projectId, 'k2') // provider-pickup candidate
      const k3 = seedQuery(db, projectId, 'k3') // persistent-gap candidate
      const k4 = seedQuery(db, projectId, 'k4') // competitor-gained candidate
      const k5 = seedQuery(db, projectId, 'k5') // competitor-lost candidate

      // Run 1
      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, k1, 'gemini', 'not-cited')
      seedSnapshot(db, run1, k2, 'gemini', 'cited', { citedDomains: ['example.com'] })
      // openai is ASKED about k2 and says no. A pickup means "this provider
      // started citing", which is only claimable against a measured no — an
      // absent row would mean openai errored, not that it declined.
      seedSnapshot(db, run1, k2, 'openai', 'not-cited')
      seedSnapshot(db, run1, k3, 'gemini', 'not-cited')
      seedSnapshot(db, run1, k4, 'gemini', 'not-cited')
      seedSnapshot(db, run1, k5, 'gemini', 'not-cited', {
        citedDomains: ['rival.com'],
        competitorOverlap: ['rival.com'],
      })

      // Run 2
      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, k1, 'gemini', 'not-cited')
      seedSnapshot(db, run2, k2, 'gemini', 'cited', { citedDomains: ['example.com'] })
      seedSnapshot(db, run2, k2, 'openai', 'not-cited')
      seedSnapshot(db, run2, k3, 'gemini', 'not-cited')
      seedSnapshot(db, run2, k4, 'gemini', 'not-cited')
      seedSnapshot(db, run2, k5, 'gemini', 'not-cited', {
        citedDomains: ['rival.com'],
        competitorOverlap: ['rival.com'],
      })

      // Run 3 — the run we're analyzing
      const run3 = seedRun(db, projectId, 'completed', '2024-03-01T00:00:00Z')
      seedSnapshot(db, run3, k1, 'gemini', 'cited', { citedDomains: ['example.com'] }) // first-citation
      seedSnapshot(db, run3, k2, 'gemini', 'cited', { citedDomains: ['example.com'] })
      seedSnapshot(db, run3, k2, 'openai', 'cited', { citedDomains: ['example.com'] }) // provider-pickup
      seedSnapshot(db, run3, k3, 'gemini', 'not-cited') // persistent-gap (3 in a row)
      seedSnapshot(db, run3, k4, 'gemini', 'not-cited', {
        citedDomains: ['rival.com'],
        competitorOverlap: ['rival.com'],
      }) // competitor-gained
      seedSnapshot(db, run3, k5, 'gemini', 'not-cited') // competitor-lost (rival dropped)

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(run3, projectId)

      expect(result).not.toBeNull()
      expect(result!.firstCitations.map(f => f.query)).toContain('k1')
      expect(result!.providerPickups.map(p => `${p.query}:${p.provider}`)).toContain('k2:openai')
      expect(result!.persistentGaps.map(g => g.query)).toContain('k3')
      expect(result!.competitorGains.map(c => `${c.query}:${c.competitorDomain}`)).toContain('k4:rival.com')
      expect(result!.competitorLosses.map(c => `${c.query}:${c.competitorDomain}`)).toContain('k5:rival.com')

      // All signals should land in the DB
      const savedTypes = new Set(db.select({ type: insights.type }).from(insights).all().map(r => r.type))
      expect(savedTypes.has('first-citation')).toBe(true)
      expect(savedTypes.has('provider-pickup')).toBe(true)
      expect(savedTypes.has('persistent-gap')).toBe(true)
      expect(savedTypes.has('competitor-gained')).toBe(true)
      expect(savedTypes.has('competitor-lost')).toBe(true)
    })

    it('does not turn a competitor mention in legacy overlap into a citation cause or alert', () => {
      const { db } = createTempDb('intel-mention-only-competitor-')
      const projectId = seedProject(db)
      db.insert(competitors).values({
        id: crypto.randomUUID(),
        projectId,
        domain: 'rival.com',
        createdAt: new Date().toISOString(),
      }).run()
      const queryId = seedQuery(db, projectId, 'best roofing company')
      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })
      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, queryId, 'gemini', 'not-cited', {
        answerText: 'Rival is a popular roofing company.',
        competitorOverlap: ['rival.com'],
      })

      const result = new IntelligenceService(db).analyzeAndPersist(run2, projectId)!
      const regression = result.insights.find(insight => insight.type === 'regression')

      expect(result.competitorGains).toEqual([])
      expect(regression?.cause?.cause).toBe('unknown')
      expect(result.insights.some(insight => insight.type === 'competitor-gained')).toBe(false)
    })

    it('treats a tracked competitor in grounding evidence as a real citation alert', () => {
      const { db } = createTempDb('intel-grounded-competitor-')
      const projectId = seedProject(db)
      db.insert(competitors).values({
        id: crypto.randomUUID(),
        projectId,
        domain: 'rival.com',
        createdAt: new Date().toISOString(),
      }).run()
      const queryId = seedQuery(db, projectId, 'best roofing company')
      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })
      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, queryId, 'gemini', 'not-cited', {
        groundingSources: [{ uri: 'https://rival.com/roofing', title: 'Rival' }],
      })

      const result = new IntelligenceService(db).analyzeAndPersist(run2, projectId)!
      const regression = result.insights.find(insight => insight.type === 'regression')

      expect(result.competitorGains).toEqual([
        { query: 'best roofing company', competitorDomain: 'rival.com' },
      ])
      expect(regression?.cause).toMatchObject({
        cause: 'competitor_gain',
        competitorDomain: 'rival.com',
      })
    })
  })

  describe('backfill', () => {
    it('processes runs in chronological order', () => {
      const { db } = createTempDb('intel-backfill-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'test query')

      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, queryId, 'gemini', 'not-cited')

      const run3 = seedRun(db, projectId, 'completed', '2024-03-01T00:00:00Z')
      seedSnapshot(db, run3, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const service = new IntelligenceService(db)
      const progress: string[] = []
      const result = service.backfill('test-project', {}, (info) => {
        progress.push(info.runId)
      })

      expect(result.processed).toBe(3)
      expect(result.skipped).toBe(0)
      // Verify progress was reported in order
      expect(progress).toEqual([run1, run2, run3])

      // Verify all runs have health snapshots
      const healthRows = db.select().from(healthSnapshots).all()
      expect(healthRows).toHaveLength(3)
    })

    it('--dry-run does not write insights or health snapshots, returns delta', () => {
      // First we let a real backfill establish baseline insight rows. Then a
      // dry-run pass with mutated data should: (a) leave the DB untouched,
      // (b) return a delta describing what *would* change.
      const { db } = createTempDb('intel-backfill-dryrun-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'test query')

      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })
      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, queryId, 'gemini', 'not-cited')

      const service = new IntelligenceService(db)
      // Real backfill — populates insights + health.
      service.backfill('test-project')

      const insightsBefore = db.select().from(insights).all()
      const healthBefore = db.select().from(healthSnapshots).all()
      expect(insightsBefore.length).toBeGreaterThan(0)
      expect(healthBefore.length).toBeGreaterThan(0)

      // Dry-run pass — must not touch the DB.
      const result = service.backfill('test-project', { dryRun: true })

      const insightsAfter = db.select().from(insights).all()
      const healthAfter = db.select().from(healthSnapshots).all()
      expect(insightsAfter.map(i => i.id).sort()).toEqual(insightsBefore.map(i => i.id).sort())
      expect(healthAfter.map(h => h.id).sort()).toEqual(healthBefore.map(h => h.id).sort())

      // Result reports the would-be deltas so an operator can preview impact.
      expect(result.dryRun).toBe(true)
      expect(result.delta).toBeDefined()
      expect(result.delta!.wouldDelete).toBe(insightsBefore.length)
      expect(result.delta!.wouldCreate).toBe(result.totalInsights)
      expect(result.delta!.netChange).toBe(result.totalInsights - insightsBefore.length)
    })

    it('--dry-run report includes per-run delta entries an agent can scan', () => {
      const { db } = createTempDb('intel-backfill-dryrun-perrun-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'test query')

      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })
      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, queryId, 'gemini', 'not-cited')

      const service = new IntelligenceService(db)
      service.backfill('test-project') // populate baseline

      const result = service.backfill('test-project', { dryRun: true })
      expect(result.delta!.perRun).toBeDefined()
      expect(result.delta!.perRun!.length).toBeGreaterThan(0)
      for (const entry of result.delta!.perRun!) {
        expect(entry).toHaveProperty('runId')
        expect(entry).toHaveProperty('existingInsights')
        expect(entry).toHaveProperty('newInsights')
      }
    })

    it('non-dry-run result omits the dryRun + delta fields (backwards compat)', () => {
      const { db } = createTempDb('intel-backfill-normal-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'test query')
      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const service = new IntelligenceService(db)
      const result = service.backfill('test-project')
      expect(result.dryRun).toBeUndefined()
      expect(result.delta).toBeUndefined()
    })

    it('respects --from-run and --to-run range', () => {
      const { db } = createTempDb('intel-backfill-range-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'test query')

      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, queryId, 'gemini', 'not-cited')

      const run3 = seedRun(db, projectId, 'completed', '2024-03-01T00:00:00Z')
      seedSnapshot(db, run3, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const service = new IntelligenceService(db)
      const result = service.backfill('test-project', { fromRunId: run2, toRunId: run2 })

      // Only run2 should be processed
      expect(result.processed).toBe(1)
      const healthRows = db.select().from(healthSnapshots).all()
      expect(healthRows).toHaveLength(1)
      expect(healthRows[0]!.runId).toBe(run2)
    })

    it('respects --since by scoping processed runs to finishedAt >= the cutoff', () => {
      // Use case: after a code change that affects insight generation, you
      // want to re-process recent runs only — not walk the entire ~900-run
      // history of a long-lived project. The predecessor lookup still pulls
      // from the full history so transitions remain correct at the boundary.
      const { db } = createTempDb('intel-backfill-since-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'test query')

      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, queryId, 'gemini', 'not-cited')

      const run3 = seedRun(db, projectId, 'completed', '2024-03-01T00:00:00Z')
      seedSnapshot(db, run3, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const service = new IntelligenceService(db)
      const result = service.backfill('test-project', { since: '2024-02-15T00:00:00Z' })

      // run1 and run2 are before the cutoff → not re-processed
      // run3 is after → processed, with run2 (from full history) as predecessor
      expect(result.processed).toBe(1)
      const healthRows = db.select().from(healthSnapshots).all()
      expect(healthRows).toHaveLength(1)
      expect(healthRows[0]!.runId).toBe(run3)

      // The transition (run2 not-cited → run3 cited) must still be detected
      // as a gain — proves the predecessor lookup walked back past the cutoff.
      const gainInsights = db.select().from(insights).all().filter(i => i.type === 'gain')
      expect(gainInsights.length).toBeGreaterThanOrEqual(1)
    })

    it('--since accepts a YYYY-MM-DD date and treats it as midnight UTC', () => {
      const { db } = createTempDb('intel-backfill-since-date-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'test query')

      const run1 = seedRun(db, projectId, 'completed', '2024-01-15T00:00:00Z')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const run2 = seedRun(db, projectId, 'completed', '2024-02-15T00:00:00Z')
      seedSnapshot(db, run2, queryId, 'gemini', 'not-cited')

      const service = new IntelligenceService(db)
      const result = service.backfill('test-project', { since: '2024-02-01' })

      // run1 (Jan 15) is before; run2 (Feb 15) is after the Feb 1 cutoff.
      expect(result.processed).toBe(1)
    })

    it('throws a clear error when --since is not parseable as a date', () => {
      const { db } = createTempDb('intel-backfill-bad-since-')
      seedProject(db)
      const service = new IntelligenceService(db)
      expect(() => service.backfill('test-project', { since: 'not-a-date' })).toThrow(/since.*date/i)
    })

    it('--since combines with --to-run to bound the upper edge', () => {
      const { db } = createTempDb('intel-backfill-since-toRun-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'test query')

      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })
      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, queryId, 'gemini', 'not-cited')
      const run3 = seedRun(db, projectId, 'completed', '2024-03-01T00:00:00Z')
      seedSnapshot(db, run3, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const service = new IntelligenceService(db)
      const result = service.backfill('test-project', {
        since: '2024-01-15T00:00:00Z',
        toRunId: run2,
      })

      // Window [since=Jan15, to=run2(Feb1)] → only run2 qualifies.
      expect(result.processed).toBe(1)
    })

    it('throws for unknown project', () => {
      const { db } = createTempDb('intel-backfill-404-')
      const service = new IntelligenceService(db)

      expect(() => service.backfill('nonexistent')).toThrow('Project "nonexistent" not found')
    })

    it('throws for unknown run ID in range', () => {
      const { db } = createTempDb('intel-backfill-bad-run-')
      seedProject(db)
      const service = new IntelligenceService(db)

      expect(() => service.backfill('test-project', { fromRunId: 'bogus' })).toThrow('Run "bogus" not found')
    })

    it('skips runs with no snapshots', () => {
      const { db } = createTempDb('intel-backfill-skip-')
      const projectId = seedProject(db)
      seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')

      const service = new IntelligenceService(db)
      const result = service.backfill('test-project')

      expect(result.processed).toBe(0)
      expect(result.skipped).toBe(1)
    })
  })

  // Regression suite: the run-history window used to select the "previous
  // run" without filtering by kind. Only `answer-visibility` runs write
  // query_snapshots, but any of the other 14 kinds could win the baseline
  // slot — and an empty baseline makes every cited query read as a
  // brand-new first citation. Counterintuitively this got WORSE the better
  // an instance was configured: daily syncs plus weekly sweeps means the
  // row immediately before a sweep is almost always a sync.
  describe('baseline selection ignores runs that measured nothing', () => {
    function insertRun(
      db: ReturnType<typeof createClient>,
      projectId: string,
      kind: string,
      finishedAt: string,
    ): string {
      const runId = crypto.randomUUID()
      db.insert(runs).values({
        id: runId,
        projectId,
        kind,
        status: 'completed',
        trigger: 'manual',
        createdAt: finishedAt,
        finishedAt,
      }).run()
      return runId
    }

    it('does not manufacture first-citations when a sync run sits between two sweeps', () => {
      const { db } = createTempDb('intel-kind-baseline-')
      const projectId = seedProject(db)
      const q1 = seedQuery(db, projectId, 'roof repair')
      const q2 = seedQuery(db, projectId, 'metal roofing')

      // Sweep A cited BOTH queries — so nothing in sweep B is a first citation.
      const sweepA = insertRun(db, projectId, 'answer-visibility', '2026-01-01T00:00:00Z')
      seedSnapshot(db, sweepA, q1, 'gemini', 'cited', { citedDomains: ['example.com'] })
      seedSnapshot(db, sweepA, q2, 'gemini', 'cited', { citedDomains: ['example.com'] })

      // Four days of syncs land between the two sweeps. Each is a completed,
      // non-probe run with zero snapshots, and together they fill the entire
      // 5-run history window.
      insertRun(db, projectId, 'ga-sync', '2026-01-02T00:00:00Z')
      insertRun(db, projectId, 'traffic-sync', '2026-01-03T00:00:00Z')
      insertRun(db, projectId, 'gsc-sync', '2026-01-04T00:00:00Z')
      insertRun(db, projectId, 'site-audit', '2026-01-05T00:00:00Z')

      const sweepB = insertRun(db, projectId, 'answer-visibility', '2026-01-06T00:00:00Z')
      seedSnapshot(db, sweepB, q1, 'gemini', 'cited', { citedDomains: ['example.com'] })
      seedSnapshot(db, sweepB, q2, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(sweepB, projectId)

      expect(result).not.toBeNull()
      // Both queries were already cited in the real previous sweep. Pre-fix
      // the baseline was the site-audit run, whose empty snapshot set made
      // both look brand new: 2 first-citations + 2 gains, all false.
      expect(result!.firstCitations).toHaveLength(0)
      expect(result!.gains).toHaveLength(0)
      expect(result!.insights.filter(i => i.type === 'first-citation')).toHaveLength(0)
      expect(result!.insights.filter(i => i.type === 'gain')).toHaveLength(0)

      // And the persisted rows agree with the in-memory result.
      const savedTypes = db.select().from(insights).all().map(i => i.type)
      expect(savedTypes.filter(t => t === 'first-citation')).toHaveLength(0)
      expect(savedTypes.filter(t => t === 'gain')).toHaveLength(0)
    })

    it('still detects a real regression across an interleaved sync run', () => {
      // The mirror of the case above: an empty baseline holds no cited pairs,
      // so `detectRegressions` finds nothing and a real loss is silently
      // dropped. The kind filter has to restore the true negative AND the
      // true positive.
      const { db } = createTempDb('intel-kind-regression-')
      const projectId = seedProject(db)
      const q1 = seedQuery(db, projectId, 'roof repair')

      const sweepA = insertRun(db, projectId, 'answer-visibility', '2026-01-01T00:00:00Z')
      seedSnapshot(db, sweepA, q1, 'gemini', 'cited', { citedDomains: ['example.com'] })

      insertRun(db, projectId, 'ga-sync', '2026-01-02T00:00:00Z')
      insertRun(db, projectId, 'traffic-sync', '2026-01-03T00:00:00Z')

      const sweepB = insertRun(db, projectId, 'answer-visibility', '2026-01-04T00:00:00Z')
      seedSnapshot(db, sweepB, q1, 'gemini', 'not-cited')

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(sweepB, projectId)

      expect(result!.regressions).toHaveLength(1)
      expect(result!.regressions[0]!.query).toBe('roof repair')
      expect(result!.regressions[0]!.provider).toBe('gemini')
      expect(result!.regressions[0]!.previousRunId).toBe(sweepA)
    })

    it('does not let a snapshotless answer-visibility run anchor the comparison', () => {
      // The kind filter alone is not enough: a sweep whose every provider
      // call failed still lands in the window as a completed/partial
      // answer-visibility run with zero snapshots, and would anchor the same
      // false first-citations. The snapshot guard skips it to the last run
      // that actually measured.
      const { db } = createTempDb('intel-empty-baseline-')
      const projectId = seedProject(db)
      const q1 = seedQuery(db, projectId, 'roof repair')

      const sweepA = insertRun(db, projectId, 'answer-visibility', '2026-01-01T00:00:00Z')
      seedSnapshot(db, sweepA, q1, 'gemini', 'cited', { citedDomains: ['example.com'] })

      // A sweep that produced nothing — right kind, no measurement.
      insertRun(db, projectId, 'answer-visibility', '2026-01-02T00:00:00Z')

      const sweepC = insertRun(db, projectId, 'answer-visibility', '2026-01-03T00:00:00Z')
      seedSnapshot(db, sweepC, q1, 'gemini', 'not-cited')

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(sweepC, projectId)

      expect(result!.firstCitations).toHaveLength(0)
      expect(result!.gains).toHaveLength(0)
      // The comparison lands on sweepA, the last run that measured anything.
      expect(result!.regressions).toHaveLength(1)
      expect(result!.regressions[0]!.previousRunId).toBe(sweepA)
    })

    it('keeps the real baseline when snapshotless sweeps overflow the window', () => {
      // The measurement filter has to run in SQL, before the LIMIT — exactly
      // like kind and location. Dropped only from the LIMITed page, enough
      // snapshotless answer-visibility sweeps push the last measured baseline
      // out of the row budget and the regression against it silently vanishes.
      // Six empties (> HISTORY_WINDOW_RUNS) sit between the baseline and the
      // current run and would consume the entire window.
      const { db } = createTempDb('intel-empty-overflow-')
      const projectId = seedProject(db)
      const q1 = seedQuery(db, projectId, 'roof repair')

      const sweepA = insertRun(db, projectId, 'answer-visibility', '2026-01-01T00:00:00Z')
      seedSnapshot(db, sweepA, q1, 'gemini', 'cited', { citedDomains: ['example.com'] })

      for (let day = 2; day <= 7; day++) {
        insertRun(db, projectId, 'answer-visibility', `2026-01-0${day}T00:00:00Z`)
      }

      const sweepB = insertRun(db, projectId, 'answer-visibility', '2026-01-08T00:00:00Z')
      seedSnapshot(db, sweepB, q1, 'gemini', 'not-cited')

      const result = new IntelligenceService(db).analyzeAndPersist(sweepB, projectId)

      // The window scopes to measured sweeps first, so sweepA is still the
      // baseline and the real cited→not-cited regression is reported.
      expect(result!.firstCitations).toHaveLength(0)
      expect(result!.regressions).toHaveLength(1)
      expect(result!.regressions[0]!.previousRunId).toBe(sweepA)
    })

    it('counts sweeps, not syncs, against the persistent-gap history window', () => {
      // PERSISTENT_GAP_THRESHOLD is 3 and the window holds 5 runs. Unfiltered,
      // the syncs consumed the budget so the window rarely reached back far
      // enough to hold 3 real sweeps — and each empty run also truncated the
      // uncited streak, since detectPersistentGaps breaks on any run missing
      // the query. Three uncited sweeps interleaved with syncs is a real
      // 3-run gap and must be reported as one.
      const { db } = createTempDb('intel-gap-window-')
      const projectId = seedProject(db)
      const q1 = seedQuery(db, projectId, 'roof repair')

      const sweeps: string[] = []
      for (const [i, day] of ['01', '03', '05'].entries()) {
        const sweep = insertRun(db, projectId, 'answer-visibility', `2026-01-${day}T00:00:00Z`)
        seedSnapshot(db, sweep, q1, 'gemini', 'not-cited')
        sweeps.push(sweep)
        // A sync the day after each sweep except the last.
        if (i < 2) insertRun(db, projectId, 'ga-sync', `2026-01-0${Number(day) + 1}T00:00:00Z`)
      }

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(sweeps[2]!, projectId)

      expect(result!.persistentGaps).toHaveLength(1)
      expect(result!.persistentGaps[0]!.query).toBe('roof repair')
      expect(result!.persistentGaps[0]!.streak).toBe(3)
    })

    it('backfill draws baselines from sweeps only, so a reanalyze clears the false rows', () => {
      // The reanalyze path had the same defect, so re-running it would have
      // rewritten the same false insights it exists to clear.
      const { db } = createTempDb('intel-backfill-kind-')
      const projectId = seedProject(db)
      const q1 = seedQuery(db, projectId, 'roof repair')

      const sweepA = insertRun(db, projectId, 'answer-visibility', '2026-01-01T00:00:00Z')
      seedSnapshot(db, sweepA, q1, 'gemini', 'cited', { citedDomains: ['example.com'] })
      insertRun(db, projectId, 'ga-sync', '2026-01-02T00:00:00Z')
      const sweepB = insertRun(db, projectId, 'answer-visibility', '2026-01-03T00:00:00Z')
      seedSnapshot(db, sweepB, q1, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const service = new IntelligenceService(db)

      // Plant the false rows a pre-fix analysis would have written, then
      // prove the backfill removes them rather than reproducing them.
      db.insert(insights).values({
        id: crypto.randomUUID(),
        projectId,
        runId: sweepB,
        type: 'first-citation',
        severity: 'medium',
        title: 'First citation for "roof repair" on gemini',
        query: 'roof repair',
        provider: 'gemini',
        dismissed: false,
        createdAt: '2026-01-03T00:00:00Z',
      }).run()

      const result = service.backfill('test-project')

      // Only the two sweeps are visited; the sync is not a target.
      expect(result.processed).toBe(2)
      expect(result.skipped).toBe(0)

      const remaining = db.select().from(insights).all()
      expect(remaining.filter(i => i.type === 'first-citation')).toHaveLength(0)
      expect(remaining.filter(i => i.type === 'gain')).toHaveLength(0)
    })
  })

  // Regression suite: `HISTORY_WINDOW_RUNS` bounded ROWS, but the location
  // scoping was a post-LIMIT filter — so a fan-out sweep's own siblings ate
  // the window. Measured before the fix, with a real cited→not-cited
  // regression present at every location: detected at 1-2 locations, silently
  // dropped at 3 and 5, and at 8 the run was refused outright (`null` — no
  // insights AND no health snapshot for that arm). Both scoping predicates
  // now live in the WHERE, so the limit means N sweeps AT THIS LOCATION.
  describe('fan-out siblings do not consume the history window', () => {
    function seedFanOutProject(
      db: ReturnType<typeof createClient>,
      locationCount: number,
    ): { projectId: string; queryId: string } {
      const now = new Date().toISOString()
      const projectId = crypto.randomUUID()
      db.insert(projects).values({
        id: projectId,
        name: 'fan-out',
        displayName: 'Fan Out',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
        providers: '["gemini"]',
        locations: JSON.stringify(
          Array.from({ length: locationCount }, (_, i) => ({ label: `loc${i}`, country: 'US' })),
        ),
        createdAt: now,
        updatedAt: now,
      }).run()
      return { projectId, queryId: seedQuery(db, projectId, 'roof repair') }
    }

    /** One sweep fanned out across every location, each arm citing or not. */
    function seedSweep(
      db: ReturnType<typeof createClient>,
      projectId: string,
      queryId: string,
      locationCount: number,
      day: number,
      citationState: string,
    ): string[] {
      const ids: string[] = []
      for (let l = 0; l < locationCount; l++) {
        const runId = crypto.randomUUID()
        const ts = `2026-01-${String(day).padStart(2, '0')}T${String(l).padStart(2, '0')}:00:00Z`
        db.insert(runs).values({
          id: runId,
          projectId,
          kind: 'answer-visibility',
          status: 'completed',
          trigger: 'manual',
          location: `loc${l}`,
          createdAt: ts,
          finishedAt: ts,
        }).run()
        seedSnapshot(db, runId, queryId, 'gemini', citationState, {
          citedDomains: citationState === 'cited' ? ['example.com'] : [],
        })
        ids.push(runId)
      }
      return ids
    }

    // 8 exceeds HISTORY_WINDOW_RUNS (5), which is where the arms used to fall
    // out of their own window entirely.
    for (const locationCount of [2, 3, 5, 8]) {
      it(`detects a real regression at ${locationCount} locations`, () => {
        const { db } = createTempDb(`intel-fanout-reg-${locationCount}-`)
        const { projectId, queryId } = seedFanOutProject(db, locationCount)

        const before = seedSweep(db, projectId, queryId, locationCount, 1, 'cited')
        const after = seedSweep(db, projectId, queryId, locationCount, 2, 'not-cited')

        const service = new IntelligenceService(db)
        // Assert on the FIRST arm: it finished earliest, so it is the one the
        // later siblings pushed out of a row-bounded window.
        const result = service.analyzeAndPersist(after[0]!, projectId)

        expect(result).not.toBeNull()
        expect(result!.regressions).toHaveLength(1)
        expect(result!.regressions[0]!.query).toBe('roof repair')
        // Compared against its OWN location's predecessor, never a sibling.
        expect(result!.regressions[0]!.previousRunId).toBe(before[0]!)
        // And the arm still gets a health snapshot — at 8 locations it used
        // to get none, silently dropping that location off the dashboard.
        const health = db.select().from(healthSnapshots).all()
        expect(health).toHaveLength(1)
        expect(health[0]!.runId).toBe(after[0]!)
      })
    }

    it('reaches PERSISTENT_GAP_THRESHOLD sweeps back at every location count', () => {
      // 4 uncited sweeps is a real 4-run gap at every location. Pre-fix this
      // was found only for a single-location project; at 2+ the window could
      // not hold the 3 same-location sweeps the threshold needs.
      for (const locationCount of [2, 3, 5, 8]) {
        const { db } = createTempDb(`intel-fanout-gap-${locationCount}-`)
        const { projectId, queryId } = seedFanOutProject(db, locationCount)

        let lastFirstArm = ''
        for (let day = 1; day <= 4; day++) {
          lastFirstArm = seedSweep(db, projectId, queryId, locationCount, day, 'not-cited')[0]!
        }

        const result = new IntelligenceService(db).analyzeAndPersist(lastFirstArm, projectId)

        expect(result!.persistentGaps, `locations=${locationCount}`).toHaveLength(1)
        expect(result!.persistentGaps[0]!.streak, `locations=${locationCount}`).toBe(4)
      }
    })

    it('never compares an arm against a sibling location', () => {
      // The invariant the window must not break: florida cited, michigan not,
      // in the SAME sweep. Neither is a transition of the other.
      const { db } = createTempDb('intel-fanout-sibling-')
      const { projectId, queryId } = seedFanOutProject(db, 3)

      seedSweep(db, projectId, queryId, 3, 1, 'cited')
      // Second sweep: loc0 stays cited, others drop. Only loc1/loc2 regressed.
      const day2: string[] = []
      for (let l = 0; l < 3; l++) {
        const runId = crypto.randomUUID()
        const ts = `2026-01-02T0${l}:00:00Z`
        db.insert(runs).values({
          id: runId, projectId, kind: 'answer-visibility', status: 'completed',
          trigger: 'manual', location: `loc${l}`, createdAt: ts, finishedAt: ts,
        }).run()
        seedSnapshot(db, runId, queryId, 'gemini', l === 0 ? 'cited' : 'not-cited', {
          citedDomains: l === 0 ? ['example.com'] : [],
        })
        day2.push(runId)
      }

      const service = new IntelligenceService(db)
      // loc0 held its citation — no regression, and no phantom gain either.
      const loc0 = service.analyzeAndPersist(day2[0]!, projectId)
      expect(loc0!.regressions).toHaveLength(0)
      expect(loc0!.gains).toHaveLength(0)
      expect(loc0!.firstCitations).toHaveLength(0)
      // loc1 lost it — a real regression against loc1's own predecessor.
      const loc1 = service.analyzeAndPersist(day2[1]!, projectId)
      expect(loc1!.regressions).toHaveLength(1)
    })

    it('compares a re-analyzed historical run against its own predecessor, not a later sweep', () => {
      // The window is anchored at the run being analyzed, so re-running
      // analysis over an old run is correct rather than refused. Pre-fix the
      // run had to be among the 5 most recent rows to be analyzed at all.
      const { db } = createTempDb('intel-anchor-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'roof repair')

      const mk = (day: number, state: string) => {
        const runId = crypto.randomUUID()
        const ts = `2026-01-0${day}T00:00:00Z`
        db.insert(runs).values({
          id: runId, projectId, kind: 'answer-visibility', status: 'completed',
          trigger: 'manual', createdAt: ts, finishedAt: ts,
        }).run()
        seedSnapshot(db, runId, queryId, 'gemini', state, {
          citedDomains: state === 'cited' ? ['example.com'] : [],
        })
        return runId
      }

      const day1 = mk(1, 'cited')
      const day2 = mk(2, 'not-cited')  // the regression happened HERE
      mk(3, 'cited')
      mk(4, 'cited')
      mk(5, 'cited')
      mk(6, 'cited')

      const result = new IntelligenceService(db).analyzeAndPersist(day2, projectId)

      expect(result).not.toBeNull()
      expect(result!.regressions).toHaveLength(1)
      expect(result!.regressions[0]!.previousRunId).toBe(day1)
    })
  })

  // Regression suite: a provider call that throws writes NO snapshot row, so
  // a `status='partial'` sweep has per-pair holes. The run-level snapshot
  // guard passes it (the run has SOME rows), and the detectors then read
  // every hole as "was not cited". Measured before the fix on a site where
  // nothing had changed: 6 false insights.
  describe('a partial baseline does not invent transitions', () => {
    it('reports nothing when the only difference is a provider that errored last sweep', () => {
      const { db } = createTempDb('intel-partial-')
      const projectId = seedProject(db)
      const qs = ['q1', 'q2', 'q3'].map(q => seedQuery(db, projectId, q))

      // Sweep 1 (partial): gemini answered and cited all three.
      // openai errored on every query, so it wrote no rows at all.
      const partial = seedRun(db, projectId, 'partial', '2026-01-01T00:00:00Z')
      for (const q of qs) {
        seedSnapshot(db, partial, q, 'gemini', 'cited', { citedDomains: ['example.com'] })
      }

      // Sweep 2 (clean): both providers answer, both cite all three. The site
      // did not change between the sweeps — only the sampling did.
      const clean = seedRun(db, projectId, 'completed', '2026-01-02T00:00:00Z')
      for (const q of qs) {
        seedSnapshot(db, clean, q, 'gemini', 'cited', { citedDomains: ['example.com'] })
        seedSnapshot(db, clean, q, 'openai', 'cited', { citedDomains: ['example.com'] })
      }

      const result = new IntelligenceService(db).analyzeAndPersist(clean, projectId)

      expect(result).not.toBeNull()
      // Pre-fix: 3 gains + 3 provider-pickups = 6 insights, all false.
      expect(result!.gains).toHaveLength(0)
      expect(result!.providerPickups).toHaveLength(0)
      expect(result!.firstCitations).toHaveLength(0)
      expect(result!.insights).toHaveLength(0)
      expect(db.select().from(insights).all()).toHaveLength(0)
    })

    it('still reports the real movement in the same partial sweep', () => {
      // Symmetry check: suppressing holes must not suppress evidence. Same
      // shape as above, except gemini genuinely lost q1 and genuinely gained
      // q3 — both measured on both sides, so both must survive.
      const { db } = createTempDb('intel-partial-real-')
      const projectId = seedProject(db)
      const [q1, q2, q3] = ['q1', 'q2', 'q3'].map(q => seedQuery(db, projectId, q))

      const partial = seedRun(db, projectId, 'partial', '2026-01-01T00:00:00Z')
      seedSnapshot(db, partial, q1!, 'gemini', 'cited', { citedDomains: ['example.com'] })
      seedSnapshot(db, partial, q2!, 'gemini', 'cited', { citedDomains: ['example.com'] })
      seedSnapshot(db, partial, q3!, 'gemini', 'not-cited')
      // openai errored across the board — no rows.

      const clean = seedRun(db, projectId, 'completed', '2026-01-02T00:00:00Z')
      seedSnapshot(db, clean, q1!, 'gemini', 'not-cited')                                   // real LOSS
      seedSnapshot(db, clean, q2!, 'gemini', 'cited', { citedDomains: ['example.com'] })     // unchanged
      seedSnapshot(db, clean, q3!, 'gemini', 'cited', { citedDomains: ['example.com'] })     // real GAIN
      for (const q of [q1, q2, q3]) {
        seedSnapshot(db, clean, q!, 'openai', 'cited', { citedDomains: ['example.com'] })    // unmeasured before
      }

      const result = new IntelligenceService(db).analyzeAndPersist(clean, projectId)

      expect(result!.regressions).toHaveLength(1)
      expect(result!.regressions[0]!.query).toBe('q1')
      expect(result!.gains).toHaveLength(1)
      expect(result!.gains[0]!.query).toBe('q3')
      expect(result!.gains[0]!.provider).toBe('gemini')
      // q3 was uncited by every provider the baseline measured, so its first
      // citation is real evidence, not a hole. The claim is query-level and
      // emits one row per provider citing it now, so q3 yields two rows.
      expect(new Set(result!.firstCitations.map(f => f.query))).toEqual(new Set(['q3']))
      expect(result!.firstCitations).toHaveLength(2)
      // openai's three citations are all unmeasured-before: no claim either way.
      expect(result!.providerPickups).toHaveLength(0)
    })
  })

  // Regression suite for #480: the recurrence lookback used to count rows
  // instead of time-points, so a multi-location project's effective look-back
  // window was halved (or worse for 3+ locations). The fix walks fan-out
  // groups; this test pins that behavior down.
  describe('recurrence lookback under multi-location fan-out (#480)', () => {
    it('does not raise an analyze error on a multi-location latest fan-out group', () => {
      // Smoke test: the recurrence-lookback SQL fetch is now sized by
      // configured location count. A 2-location project with multiple prior
      // fan-out groups must analyze without surprise errors. Severity
      // classification semantics are intentionally not asserted here — those
      // are covered by intelligence-service-severity.test.ts; this test pins
      // down the cross-cutting "lookback walks groups" code path only.
      const { db } = createTempDb('intel-fanout-lookback-')
      const now = new Date().toISOString()
      const projectId = crypto.randomUUID()
      db.insert(projects).values({
        id: projectId,
        name: 'multi-loc-recurrence',
        displayName: 'Multi-Location Recurrence',
        canonicalDomain: 'harborline-coatings.example',
        country: 'US',
        language: 'en',
        providers: '["gemini"]',
        locations: JSON.stringify([
          { label: 'florida',  city: 'Orlando', region: 'Florida',  country: 'US' },
          { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' },
        ]),
        createdAt: now,
        updatedAt: now,
      }).run()
      const queryId = seedQuery(db, projectId, 'polyurea roof coating')

      // Three fan-out groups: oldest, middle, latest. Each group has two
      // runs (florida + michigan). Six runs total — pre-fix, the look-back
      // would have spent 6 of its budget on these (covering ~3 groups
      // assuming RECURRENCE_LOOKBACK_RUNS=5 + headroom=4 → 24 row budget,
      // fine). For a hypothetical 5-location project the budget would
      // need to scale — the fix scales by `max(2, locationCount)`.
      function insertFanOutGroup(createdAt: string): { florida: string; michigan: string } {
        const florida = crypto.randomUUID()
        const michigan = crypto.randomUUID()
        db.insert(runs).values([
          { id: florida,  projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: 'florida',  createdAt, finishedAt: createdAt },
          { id: michigan, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: 'michigan', createdAt, finishedAt: createdAt },
        ]).run()
        return { florida, michigan }
      }
      const oldGroup = insertFanOutGroup('2026-05-10T17:23:20.060Z')
      const midGroup = insertFanOutGroup('2026-05-11T17:23:20.060Z')
      const latestGroup = insertFanOutGroup('2026-05-13T17:23:20.060Z')

      // Snapshots: q cited in florida, not cited in michigan, across all 3
      // groups. The "regression" is consistent at michigan; florida is steady.
      for (const group of [oldGroup, midGroup, latestGroup]) {
        seedSnapshot(db, group.florida,  queryId, 'gemini', 'cited',     { citedDomains: ['harborline-coatings.example'] })
        seedSnapshot(db, group.michigan, queryId, 'gemini', 'not-cited')
      }

      const service = new IntelligenceService(db)
      // Analyze the michigan-arm of the latest group. The lookback should
      // walk groups (not rows), so the fetch limit of
      // (RECURRENCE_LOOKBACK_RUNS + 1) * max(2, locationCount) easily covers
      // all 3 groups. Pre-fix with the hard `* 4` headroom multiplier on
      // RECURRENCE_LOOKBACK_RUNS = 5 would have been
      // (5+1)*4 = 24 rows budget — same outcome on this tiny fixture but
      // the multiplier is now project-aware.
      const result = service.analyzeAndPersist(latestGroup.michigan, projectId)

      // The point of this regression is that the call succeeds and produces
      // a valid AnalysisResult without index-out-of-bounds or short-circuit
      // errors. Whether the resulting insights include specific items is
      // out of scope for this test — the existing severity test file covers
      // the per-insight tier rules.
      expect(result).not.toBeNull()
      expect(typeof result!.health.overallCitedRate).toBe('number')
    })
  })

  // Regression suite for the multi-location grouping bug: `analyzeAndPersist`
  // used to pick the immediately-prior run by finishedAt regardless of
  // location, so two siblings of the same fan-out (Florida cited / Michigan
  // not-cited) were compared as if they were sequential runs at one location
  // — flagging false regressions and false gains on every multi-location
  // sweep. The fix matches previous run by location.
  describe('multi-location previous-run selection', () => {
    function seedTwoLocationProject(db: ReturnType<typeof createClient>): { projectId: string; queryId: string } {
      const now = new Date().toISOString()
      const projectId = crypto.randomUUID()
      db.insert(projects).values({
        id: projectId,
        name: 'multi-loc',
        displayName: 'Multi-Location',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
        providers: '["gemini"]',
        locations: JSON.stringify([
          { label: 'florida',  city: 'Orlando', region: 'Florida',  country: 'US' },
          { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' },
        ]),
        createdAt: now,
        updatedAt: now,
      }).run()
      const queryId = seedQuery(db, projectId, 'polyurea roof coating')
      return { projectId, queryId }
    }

    function insertFanOutRun(
      db: ReturnType<typeof createClient>,
      projectId: string,
      location: string,
      finishedAt: string,
    ): string {
      const runId = crypto.randomUUID()
      db.insert(runs).values({
        id: runId,
        projectId,
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        location,
        createdAt: finishedAt,
        finishedAt,
      }).run()
      return runId
    }

    it('does not flag a regression when the immediately-prior run is a different location', () => {
      // Pre-fix: Michigan-latest (not cited) would be compared to Florida-mid
      // (cited) — flagging "regression". Post-fix: compared to Michigan-mid
      // (also not cited) → no regression.
      const { db } = createTempDb('intel-multi-loc-regression-')
      const { projectId, queryId } = seedTwoLocationProject(db)

      const flMid       = insertFanOutRun(db, projectId, 'florida',  '2026-05-11T00:00:00Z')
      const miMid       = insertFanOutRun(db, projectId, 'michigan', '2026-05-11T00:00:00Z')
      const flLatest    = insertFanOutRun(db, projectId, 'florida',  '2026-05-13T00:00:00Z')
      const miLatest    = insertFanOutRun(db, projectId, 'michigan', '2026-05-13T00:00:00Z')

      seedSnapshot(db, flMid,       queryId, 'gemini', 'cited',     { citedDomains: ['example.com'] })
      seedSnapshot(db, miMid,       queryId, 'gemini', 'not-cited')
      seedSnapshot(db, flLatest,    queryId, 'gemini', 'cited',     { citedDomains: ['example.com'] })
      seedSnapshot(db, miLatest,    queryId, 'gemini', 'not-cited')

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(miLatest, projectId)

      expect(result).not.toBeNull()
      // No transitions — Michigan was not cited last time either.
      expect(result!.regressions).toEqual([])
      expect(result!.gains).toEqual([])

      // And no regression insight persisted to the DB.
      const persistedRegressions = db.select().from(insights)
        .all()
        .filter(i => i.runId === miLatest && i.type === 'regression')
      expect(persistedRegressions).toHaveLength(0)
    })

    it('does not flag a phantom gain on the opposite case (Michigan→Florida)', () => {
      // Symmetric coverage. Florida-latest cited compared against Michigan-mid
      // not-cited would have looked like a "gain" pre-fix.
      const { db } = createTempDb('intel-multi-loc-gain-')
      const { projectId, queryId } = seedTwoLocationProject(db)

      const flMid    = insertFanOutRun(db, projectId, 'florida',  '2026-05-11T00:00:00Z')
      const miMid    = insertFanOutRun(db, projectId, 'michigan', '2026-05-11T00:00:00Z')
      const flLatest = insertFanOutRun(db, projectId, 'florida',  '2026-05-13T00:00:00Z')
      const miLatest = insertFanOutRun(db, projectId, 'michigan', '2026-05-13T00:00:00Z')

      seedSnapshot(db, flMid,    queryId, 'gemini', 'cited',     { citedDomains: ['example.com'] })
      seedSnapshot(db, miMid,    queryId, 'gemini', 'not-cited')
      seedSnapshot(db, flLatest, queryId, 'gemini', 'cited',     { citedDomains: ['example.com'] })
      seedSnapshot(db, miLatest, queryId, 'gemini', 'not-cited')

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(flLatest, projectId)

      expect(result).not.toBeNull()
      // Florida was always cited — no gain.
      expect(result!.gains).toEqual([])
      expect(result!.regressions).toEqual([])
    })

    it('detects a real regression when the previous SAME-location run was cited', () => {
      // Genuine signal we must preserve: Florida cited at mid, not cited at
      // latest, and Michigan steady in between. The Michigan run between
      // them must not mask the Florida regression.
      const { db } = createTempDb('intel-multi-loc-real-regression-')
      const { projectId, queryId } = seedTwoLocationProject(db)

      const flMid    = insertFanOutRun(db, projectId, 'florida',  '2026-05-11T00:00:00Z')
      const miMid    = insertFanOutRun(db, projectId, 'michigan', '2026-05-11T00:00:00Z')
      const flLatest = insertFanOutRun(db, projectId, 'florida',  '2026-05-13T00:00:00Z')

      seedSnapshot(db, flMid,    queryId, 'gemini', 'cited',     { citedDomains: ['example.com'] })
      seedSnapshot(db, miMid,    queryId, 'gemini', 'not-cited')
      seedSnapshot(db, flLatest, queryId, 'gemini', 'not-cited')

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(flLatest, projectId)

      expect(result).not.toBeNull()
      expect(result!.regressions).toHaveLength(1)
      expect(result!.regressions[0]!.query).toBe('polyurea roof coating')
      expect(result!.regressions[0]!.previousRunId).toBe(flMid)
    })
  })

  // Regression suite for the orphan-snapshot insight noise observed after
  // backfilling one project on 2026-05-16: 459 snapshots with `query_id`
  // nulled by the v58 dangling-FK cleanup all collapsed to a single
  // ("", "gemini", null) detector key, generating 28 phantom regressions
  // + 3 phantom gains + 1 phantom first-citation on a single run.
  describe('orphan snapshots (query_id NULL and query_text NULL)', () => {
    function seedOrphanSnapshot(
      db: ReturnType<typeof createClient>,
      runId: string,
      provider: string,
      citationState: string,
    ): void {
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(),
        runId,
        queryId: null, // dangling — the v58 LEFT JOIN backfill nulled it
        queryText: null, // never had a denormalized fallback either
        provider,
        model: 'test-model',
        citationState,
        citedDomains: [],
        competitorOverlap: [],
        createdAt: new Date().toISOString(),
      }).run()
    }

    it('does not generate regression insights for orphan snapshots', () => {
      const { db } = createTempDb('intel-orphan-regression-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'real query')

      const run1 = seedRun(db, projectId, 'completed', '2026-04-01T00:00:00Z')
      const run2 = seedRun(db, projectId, 'completed', '2026-04-02T00:00:00Z')

      // Run 1: orphan cited + real-query cited
      seedOrphanSnapshot(db, run1, 'gemini', 'cited')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      // Run 2: orphan NOT cited + real-query cited (only the orphan would
      // produce a phantom "regression"; the real-query is steady)
      seedOrphanSnapshot(db, run2, 'gemini', 'not-cited')
      seedSnapshot(db, run2, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(run2, projectId)

      expect(result).not.toBeNull()
      // Pre-fix: result.regressions had the orphan as `{ query: '', provider: 'gemini' }`.
      expect(result!.regressions).toHaveLength(0)

      // Persisted insights table also has no empty-query rows.
      const persistedEmpty = db.select().from(insights)
        .all()
        .filter(i => i.runId === run2 && (i.query === null || i.query === ''))
      expect(persistedEmpty).toHaveLength(0)
    })

    it('does not generate gain insights for orphan snapshots', () => {
      const { db } = createTempDb('intel-orphan-gain-')
      const projectId = seedProject(db)
      const queryId = seedQuery(db, projectId, 'real query')

      const run1 = seedRun(db, projectId, 'completed', '2026-04-01T00:00:00Z')
      const run2 = seedRun(db, projectId, 'completed', '2026-04-02T00:00:00Z')

      // Run 1: orphan not cited
      seedOrphanSnapshot(db, run1, 'gemini', 'not-cited')
      seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      // Run 2: orphan now cited — this would produce a phantom "gain" pre-fix
      seedOrphanSnapshot(db, run2, 'gemini', 'cited')
      seedSnapshot(db, run2, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(run2, projectId)

      expect(result).not.toBeNull()
      expect(result!.gains).toHaveLength(0)
    })

    it('uses query_text as a fallback when queries.query is unavailable', () => {
      // The v58 migration also backfilled `query_text` on snapshots whose
      // queries row still existed at migration time. If a query is later
      // hard-deleted (or its row vanishes for any reason), the joined
      // queries.query goes null but query_text survives. The analyzer should
      // recover the query identity from query_text rather than treating the
      // snapshot as an orphan.
      const { db } = createTempDb('intel-querytext-fallback-')
      const projectId = seedProject(db)

      const run1 = seedRun(db, projectId, 'completed', '2026-04-01T00:00:00Z')
      const run2 = seedRun(db, projectId, 'completed', '2026-04-02T00:00:00Z')

      // Pre-existing snapshots with query_text populated but query_id NULL
      // (the queries row was deleted post-snapshot-write, post-v58).
      function insertWithQueryText(runId: string, citationState: string) {
        db.insert(querySnapshots).values({
          id: crypto.randomUUID(),
          runId,
          queryId: null,
          queryText: 'recovered query text',
          provider: 'gemini',
          model: 'test-model',
          citationState,
          citedDomains: citationState === 'cited' ? ['example.com'] : [],
          competitorOverlap: [],
          createdAt: new Date().toISOString(),
        }).run()
      }
      insertWithQueryText(run1, 'cited')
      insertWithQueryText(run2, 'not-cited')

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(run2, projectId)

      expect(result).not.toBeNull()
      expect(result!.regressions).toHaveLength(1)
      expect(result!.regressions[0]!.query).toBe('recovered query text')
    })

    it('logs a warning with the orphan count when orphan snapshots are skipped', async () => {
      // The orphan-skip is silent in code, but loud in operator-facing logs
      // so a healthy DB with sudden orphan accumulation surfaces in the
      // JobRunner / canonry serve output instead of failing closed.
      const vi = await import('vitest').then(m => m.vi)
      const writes: string[] = []
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        if (typeof chunk === 'string') writes.push(chunk)
        else if (chunk instanceof Buffer) writes.push(chunk.toString('utf8'))
        return true
      }) as typeof process.stdout.write)

      try {
        const { db } = createTempDb('intel-orphan-log-')
        const projectId = seedProject(db)
        const queryId = seedQuery(db, projectId, 'real query')
        const run1 = seedRun(db, projectId, 'completed', '2026-04-01T00:00:00Z')

        seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })
        // Three orphan snapshots in the same run.
        for (let i = 0; i < 3; i++) {
          db.insert(querySnapshots).values({
            id: crypto.randomUUID(),
            runId: run1,
            queryId: null,
            queryText: null,
            provider: 'gemini',
            model: 'test-model',
            citationState: 'not-cited',
            citedDomains: [],
            competitorOverlap: [],
            createdAt: new Date().toISOString(),
          }).run()
        }

        const service = new IntelligenceService(db)
        service.analyzeAndPersist(run1, projectId)

        const warnLine = writes.find(w => w.includes('snapshot.orphan-skip'))
        expect(warnLine).toBeDefined()
        expect(warnLine).toContain('"orphanCount":3')
        expect(warnLine).toContain('"warn"')
      } finally {
        spy.mockRestore()
      }
    })

    it('does not emit the warning when no orphan snapshots are present', async () => {
      const vi = await import('vitest').then(m => m.vi)
      const writes: string[] = []
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        if (typeof chunk === 'string') writes.push(chunk)
        else if (chunk instanceof Buffer) writes.push(chunk.toString('utf8'))
        return true
      }) as typeof process.stdout.write)

      try {
        const { db } = createTempDb('intel-orphan-quiet-')
        const projectId = seedProject(db)
        const queryId = seedQuery(db, projectId, 'real query')
        const run1 = seedRun(db, projectId, 'completed', '2026-04-01T00:00:00Z')
        seedSnapshot(db, run1, queryId, 'gemini', 'cited', { citedDomains: ['example.com'] })

        const service = new IntelligenceService(db)
        service.analyzeAndPersist(run1, projectId)

        const warnLine = writes.find(w => w.includes('snapshot.orphan-skip'))
        expect(warnLine).toBeUndefined()
      } finally {
        spy.mockRestore()
      }
    })
  })
})
