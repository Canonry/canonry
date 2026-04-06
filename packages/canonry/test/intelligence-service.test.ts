import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, onTestFinished } from 'vitest'
import { createClient, migrate, projects, runs, keywords, querySnapshots, insights, healthSnapshots } from '@ainyc/canonry-db'
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
    providers: '["gemini"]',
    createdAt: now,
    finishedAt: finishedAt ?? now,
  }).run()
  return runId
}

function seedKeyword(db: ReturnType<typeof createClient>, projectId: string, word: string) {
  const id = crypto.randomUUID()
  db.insert(keywords).values({
    id,
    projectId,
    keyword: word,
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

function seedSnapshot(
  db: ReturnType<typeof createClient>,
  runId: string,
  keywordId: string,
  provider: string,
  citationState: string,
  opts?: { citedDomains?: string[]; competitorOverlap?: string[] },
) {
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId,
    keywordId,
    provider,
    model: 'test-model',
    citationState,
    citedDomains: JSON.stringify(opts?.citedDomains ?? []),
    competitorOverlap: JSON.stringify(opts?.competitorOverlap ?? []),
    groundingSources: '[]',
    searchQueries: '[]',
    createdAt: new Date().toISOString(),
  }).run()
}

describe('IntelligenceService', () => {
  describe('analyzeAndPersist', () => {
    it('persists insights and health snapshot for a completed run', () => {
      const { db } = createTempDb('intel-test-')
      const projectId = seedProject(db)
      const kwId = seedKeyword(db, projectId, 'roof repair')
      const runId = seedRun(db, projectId, 'completed')
      seedSnapshot(db, runId, kwId, 'gemini', 'cited', { citedDomains: ['example.com'] })

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
      const kwId = seedKeyword(db, projectId, 'best roofing')
      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, kwId, 'gemini', 'cited', { citedDomains: ['example.com'] })
      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, kwId, 'gemini', 'not-cited')

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
          i => i.keyword === insightRows[0]!.keyword && i.provider === insightRows[0]!.provider && i.type === insightRows[0]!.type,
        )
        expect(matchingInsight?.dismissed).toBe(true)
      }
    })

    it('detects regressions between two runs', () => {
      const { db } = createTempDb('intel-regression-')
      const projectId = seedProject(db)
      const kwId = seedKeyword(db, projectId, 'roof repair phoenix')

      // Run 1: cited
      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, kwId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      // Run 2: not cited
      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, kwId, 'gemini', 'not-cited')

      const service = new IntelligenceService(db)
      const result = service.analyzeAndPersist(run2, projectId)

      expect(result).not.toBeNull()
      expect(result!.regressions.length).toBeGreaterThan(0)
      expect(result!.regressions[0]!.keyword).toBe('roof repair phoenix')
    })
  })

  describe('backfill', () => {
    it('processes runs in chronological order', () => {
      const { db } = createTempDb('intel-backfill-')
      const projectId = seedProject(db)
      const kwId = seedKeyword(db, projectId, 'test keyword')

      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, kwId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, kwId, 'gemini', 'not-cited')

      const run3 = seedRun(db, projectId, 'completed', '2024-03-01T00:00:00Z')
      seedSnapshot(db, run3, kwId, 'gemini', 'cited', { citedDomains: ['example.com'] })

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

    it('respects --from-run and --to-run range', () => {
      const { db } = createTempDb('intel-backfill-range-')
      const projectId = seedProject(db)
      const kwId = seedKeyword(db, projectId, 'test keyword')

      const run1 = seedRun(db, projectId, 'completed', '2024-01-01T00:00:00Z')
      seedSnapshot(db, run1, kwId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const run2 = seedRun(db, projectId, 'completed', '2024-02-01T00:00:00Z')
      seedSnapshot(db, run2, kwId, 'gemini', 'not-cited')

      const run3 = seedRun(db, projectId, 'completed', '2024-03-01T00:00:00Z')
      seedSnapshot(db, run3, kwId, 'gemini', 'cited', { citedDomains: ['example.com'] })

      const service = new IntelligenceService(db)
      const result = service.backfill('test-project', { fromRunId: run2, toRunId: run2 })

      // Only run2 should be processed
      expect(result.processed).toBe(1)
      const healthRows = db.select().from(healthSnapshots).all()
      expect(healthRows).toHaveLength(1)
      expect(healthRows[0]!.runId).toBe(run2)
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
})
