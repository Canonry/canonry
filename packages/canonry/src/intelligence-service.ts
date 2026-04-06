import { eq, desc, asc, and, or } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { projects, runs, querySnapshots, keywords, insights, healthSnapshots, parseJsonColumn } from '@ainyc/canonry-db'
import { analyzeRuns } from '@ainyc/canonry-intelligence'
import type { RunData, Snapshot, AnalysisResult } from '@ainyc/canonry-intelligence'
import crypto from 'node:crypto'
import { createLogger } from './logger.js'

const log = createLogger('IntelligenceService')

export class IntelligenceService {
  constructor(private db: DatabaseClient) {}

  /**
   * Analyze a completed run and persist insights + health snapshot.
   * Idempotent: deletes prior results for the same runId before inserting.
   * Returns the analysis result for the coordinator to inspect (e.g. for webhook dispatch).
   */
  analyzeAndPersist(runId: string, projectId: string): AnalysisResult | null {
    // 1. Fetch the two most recent completed/partial runs for context
    const recentRuns = this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          or(eq(runs.status, 'completed'), eq(runs.status, 'partial')),
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(2)
      .all()

    if (recentRuns.length === 0) {
      log.info('intelligence.skip', { runId, reason: 'no completed runs' })
      return null
    }

    const currentRunRecord = recentRuns.find(r => r.id === runId)
    if (!currentRunRecord) {
      log.info('intelligence.skip', { runId, reason: 'run not in recent completed list' })
      return null
    }

    // 2. Build RunData for the current run
    const currentRun = this.buildRunData(runId, projectId, currentRunRecord.finishedAt ?? currentRunRecord.createdAt)

    if (currentRun.snapshots.length === 0) {
      log.info('intelligence.skip', { runId, reason: 'no snapshots' })
      return null
    }

    // 3. Build RunData for the previous run (if available)
    const previousRunRecord = recentRuns.find(r => r.id !== runId)
    const previousRun = previousRunRecord
      ? this.buildRunData(previousRunRecord.id, projectId, previousRunRecord.finishedAt ?? previousRunRecord.createdAt)
      : null

    // 4. Run analysis
    const result = previousRun
      ? analyzeRuns(currentRun, previousRun)
      : analyzeRuns(currentRun, { ...currentRun, snapshots: [] })

    log.info('intelligence.analyzed', {
      runId,
      regressions: result.regressions.length,
      gains: result.gains.length,
      citedRate: result.health.overallCitedRate,
      insights: result.insights.length,
    })

    // 5. Persist — idempotent via shared persistResult
    this.persistResult(result, runId, projectId)

    return result
  }

  /**
   * Analyze a single run given an explicit previous run (or null for first run).
   * Used by backfill where we control the run ordering.
   */
  analyzeRunWithPrevious(
    runRecord: { id: string; projectId: string; finishedAt: string | null; createdAt: string },
    previousRunRecord: { id: string; projectId: string; finishedAt: string | null; createdAt: string } | null,
  ): AnalysisResult | null {
    const currentRun = this.buildRunData(runRecord.id, runRecord.projectId, runRecord.finishedAt ?? runRecord.createdAt)

    if (currentRun.snapshots.length === 0) {
      return null
    }

    const previousRun = previousRunRecord
      ? this.buildRunData(previousRunRecord.id, previousRunRecord.projectId, previousRunRecord.finishedAt ?? previousRunRecord.createdAt)
      : null

    const result = previousRun
      ? analyzeRuns(currentRun, previousRun)
      : analyzeRuns(currentRun, { ...currentRun, snapshots: [] })

    this.persistResult(result, runRecord.id, runRecord.projectId)

    return result
  }

  /**
   * Backfill intelligence for all completed/partial runs of a project.
   * Processes runs in chronological order so each run compares against its predecessor.
   */
  backfill(
    projectName: string,
    opts?: { fromRunId?: string; toRunId?: string },
    onProgress?: (info: { runId: string; index: number; total: number; insights: number }) => void,
  ): { processed: number; skipped: number; totalInsights: number } {
    const project = this.db
      .select()
      .from(projects)
      .where(eq(projects.name, projectName))
      .get()
    if (!project) {
      throw new Error(`Project "${projectName}" not found`)
    }

    const allRuns = this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, project.id),
          or(eq(runs.status, 'completed'), eq(runs.status, 'partial')),
        ),
      )
      .orderBy(asc(runs.finishedAt))
      .all()

    // Apply --from-run / --to-run range
    let startIdx = 0
    let endIdx = allRuns.length
    if (opts?.fromRunId) {
      const idx = allRuns.findIndex(r => r.id === opts.fromRunId)
      if (idx === -1) throw new Error(`Run "${opts.fromRunId}" not found in project`)
      startIdx = idx
    }
    if (opts?.toRunId) {
      const idx = allRuns.findIndex(r => r.id === opts.toRunId)
      if (idx === -1) throw new Error(`Run "${opts.toRunId}" not found in project`)
      endIdx = idx + 1
    }

    const targetRuns = allRuns.slice(startIdx, endIdx)
    let processed = 0
    let skipped = 0
    let totalInsights = 0

    for (let i = 0; i < targetRuns.length; i++) {
      const run = targetRuns[i]!
      // Previous run is the one before this in the full list (not just the target slice)
      const globalIdx = allRuns.indexOf(run)
      const previousRun = globalIdx > 0 ? allRuns[globalIdx - 1]! : null

      const result = this.analyzeRunWithPrevious(run, previousRun)

      if (result) {
        processed++
        totalInsights += result.insights.length
        onProgress?.({ runId: run.id, index: i + 1, total: targetRuns.length, insights: result.insights.length })
      } else {
        skipped++
        onProgress?.({ runId: run.id, index: i + 1, total: targetRuns.length, insights: 0 })
      }
    }

    return { processed, skipped, totalInsights }
  }

  private persistResult(result: AnalysisResult, runId: string, projectId: string): void {
    const previouslyDismissed = new Set<string>()
    const existingInsights = this.db
      .select({ keyword: insights.keyword, provider: insights.provider, type: insights.type, dismissed: insights.dismissed })
      .from(insights)
      .where(eq(insights.runId, runId))
      .all()
    for (const row of existingInsights) {
      if (row.dismissed) {
        previouslyDismissed.add(`${row.keyword}:${row.provider}:${row.type}`)
      }
    }

    this.db.transaction((tx) => {
      tx.delete(insights).where(eq(insights.runId, runId)).run()
      tx.delete(healthSnapshots).where(eq(healthSnapshots.runId, runId)).run()

      const now = new Date().toISOString()

      for (const insight of result.insights) {
        const wasDismissed = previouslyDismissed.has(`${insight.keyword}:${insight.provider}:${insight.type}`)
        tx.insert(insights).values({
          id: insight.id,
          projectId,
          runId,
          type: insight.type,
          severity: insight.severity,
          title: insight.title,
          keyword: insight.keyword,
          provider: insight.provider,
          recommendation: insight.recommendation ? JSON.stringify(insight.recommendation) : null,
          cause: insight.cause ? JSON.stringify(insight.cause) : null,
          dismissed: wasDismissed,
          createdAt: insight.createdAt,
        }).run()
      }

      tx.insert(healthSnapshots).values({
        id: crypto.randomUUID(),
        projectId,
        runId,
        overallCitedRate: String(result.health.overallCitedRate),
        totalPairs: result.health.totalPairs,
        citedPairs: result.health.citedPairs,
        providerBreakdown: JSON.stringify(result.health.providerBreakdown),
        createdAt: now,
      }).run()
    })

    log.info('intelligence.persisted', { runId, insights: result.insights.length })
  }

  private buildRunData(runId: string, projectId: string, completedAt: string): RunData {
    const rows = this.db
      .select({
        keyword: keywords.keyword,
        provider: querySnapshots.provider,
        citationState: querySnapshots.citationState,
        citedDomains: querySnapshots.citedDomains,
        competitorOverlap: querySnapshots.competitorOverlap,
      })
      .from(querySnapshots)
      .leftJoin(keywords, eq(querySnapshots.keywordId, keywords.id))
      .where(eq(querySnapshots.runId, runId))
      .all()

    const snapshots: Snapshot[] = rows.map(r => {
      const domains = parseJsonColumn<string[]>(r.citedDomains, [])
      const competitors = parseJsonColumn<string[]>(r.competitorOverlap, [])
      return {
        keyword: r.keyword ?? '',
        provider: r.provider,
        cited: r.citationState === 'cited',
        citationUrl: domains[0] ?? undefined,
        competitorDomain: competitors[0] ?? undefined,
      }
    })

    return { runId, projectId, completedAt, snapshots }
  }
}
