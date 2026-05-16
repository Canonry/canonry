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
  opts?: { citedDomains?: string[]; competitorOverlap?: string[] },
) {
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId,
    queryId,
    provider,
    model: 'test-model',
    citationState,
    citedDomains: JSON.stringify(opts?.citedDomains ?? []),
    competitorOverlap: JSON.stringify(opts?.competitorOverlap ?? []),
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

    it('returns null when run has no snapshots', () => {
      const { db } = createTempDb('intel-empty-')
      const projectId = seedProject(db)
      const runId = seedRun(db, projectId, 'completed')

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(runId, projectId)

      expect(result).toBeNull()
    })

    it('returns null for a run not in recent completed list', () => {
      const { db } = createTempDb('intel-old-')
      const projectId = seedProject(db)
      // Create 3 runs — the oldest one won't be in the top 2
      const oldRun = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedRun(db, projectId, 'completed', '2024-06-01T00:00:00Z')
      seedRun(db, projectId, 'completed', '2024-12-01T00:00:00Z')

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(oldRun, projectId)

      expect(result).toBeNull()
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
      seedSnapshot(db, run1, k3, 'gemini', 'not-cited')
      seedSnapshot(db, run1, k4, 'gemini', 'not-cited')
      seedSnapshot(db, run1, k5, 'gemini', 'not-cited', { competitorOverlap: ['rival.com'] })

      // Run 2
      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, k1, 'gemini', 'not-cited')
      seedSnapshot(db, run2, k2, 'gemini', 'cited', { citedDomains: ['example.com'] })
      seedSnapshot(db, run2, k3, 'gemini', 'not-cited')
      seedSnapshot(db, run2, k4, 'gemini', 'not-cited')
      seedSnapshot(db, run2, k5, 'gemini', 'not-cited', { competitorOverlap: ['rival.com'] })

      // Run 3 — the run we're analyzing
      const run3 = seedRun(db, projectId, 'completed', '2024-03-01T00:00:00Z')
      seedSnapshot(db, run3, k1, 'gemini', 'cited', { citedDomains: ['example.com'] }) // first-citation
      seedSnapshot(db, run3, k2, 'gemini', 'cited', { citedDomains: ['example.com'] })
      seedSnapshot(db, run3, k2, 'openai', 'cited', { citedDomains: ['example.com'] }) // provider-pickup
      seedSnapshot(db, run3, k3, 'gemini', 'not-cited') // persistent-gap (3 in a row)
      seedSnapshot(db, run3, k4, 'gemini', 'not-cited', { competitorOverlap: ['rival.com'] }) // competitor-gained
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
        canonicalDomain: 'azcoatings.example',
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
        seedSnapshot(db, group.florida,  queryId, 'gemini', 'cited',     { citedDomains: ['azcoatings.example'] })
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
  // backfilling azcoatings on 2026-05-16: 459 snapshots with `query_id`
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
        citedDomains: '[]',
        competitorOverlap: '[]',
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
          citedDomains: citationState === 'cited' ? '["example.com"]' : '[]',
          competitorOverlap: '[]',
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
            citedDomains: '[]',
            competitorOverlap: '[]',
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
