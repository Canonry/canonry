import { eq, desc, and, or } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs, querySnapshots, keywords, insights, healthSnapshots, parseJsonColumn } from '@ainyc/canonry-db'
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

    // 5. Persist — idempotent: delete existing for this runId, then insert
    this.db.transaction((tx) => {
      tx.delete(insights).where(eq(insights.runId, runId)).run()
      tx.delete(healthSnapshots).where(eq(healthSnapshots.runId, runId)).run()

      const now = new Date().toISOString()

      for (const insight of result.insights) {
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
          dismissed: false,
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

    return result
  }

  private buildRunData(runId: string, projectId: string, completedAt: string): RunData {
    const rows = this.db
      .select({
        keyword: keywords.keyword,
        provider: querySnapshots.provider,
        citationState: querySnapshots.citationState,
        citedDomains: querySnapshots.citedDomains,
      })
      .from(querySnapshots)
      .leftJoin(keywords, eq(querySnapshots.keywordId, keywords.id))
      .where(eq(querySnapshots.runId, runId))
      .all()

    const snapshots: Snapshot[] = rows.map(r => {
      const domains = parseJsonColumn<string[]>(r.citedDomains, [])
      return {
        keyword: r.keyword ?? '',
        provider: r.provider,
        cited: r.citationState === 'cited',
        citationUrl: domains[0] ?? undefined,
      }
    })

    return { runId, projectId, completedAt, snapshots }
  }
}
