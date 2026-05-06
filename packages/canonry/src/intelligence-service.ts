import { eq, desc, asc, and, or, inArray } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { projects, runs, querySnapshots, queries, competitors, insights, healthSnapshots, gscSearchData, parseJsonColumn } from '@ainyc/canonry-db'
import { analyzeRuns, classifyRegressionSeverity, PERSISTENT_GAP_THRESHOLD } from '@ainyc/canonry-intelligence'
import type { RunData, Snapshot, AnalysisResult, Insight } from '@ainyc/canonry-intelligence'
import { CitationStates, RunKinds } from '@ainyc/canonry-contracts'
import crypto from 'node:crypto'
import { createLogger } from './logger.js'

const RECURRENCE_LOOKBACK_RUNS = 5
/** Number of recent runs to load for persistent-gap detection. Must be >= PERSISTENT_GAP_THRESHOLD. */
const HISTORY_WINDOW_RUNS = Math.max(PERSISTENT_GAP_THRESHOLD, 5)

const log = createLogger('IntelligenceService')

export class IntelligenceService {
  constructor(private db: DatabaseClient) {}

  /**
   * Analyze a completed run and persist insights + health snapshot.
   * Idempotent: deletes prior results for the same runId before inserting.
   * Returns the analysis result for the coordinator to inspect (e.g. for webhook dispatch).
   */
  analyzeAndPersist(runId: string, projectId: string): AnalysisResult | null {
    // 1. Fetch a window of recent completed/partial runs — covers immediate
    //    previous run and enough history for persistent-gap detection.
    //    Order by finishedAt (then createdAt) so chronology is well-defined
    //    even when multiple test rows share a wall-clock createdAt.
    const recentRuns = this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          or(eq(runs.status, 'completed'), eq(runs.status, 'partial')),
        ),
      )
      .orderBy(desc(runs.finishedAt), desc(runs.createdAt))
      .limit(HISTORY_WINDOW_RUNS)
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

    // 3. Build RunData for previous run + history window (oldest → newest, ending at current)
    const orderedRecent = [...recentRuns].reverse()
    const currentIdx = orderedRecent.findIndex(r => r.id === runId)
    const previousRunRecord = currentIdx > 0 ? orderedRecent[currentIdx - 1]! : null
    const previousRun = previousRunRecord
      ? this.buildRunData(previousRunRecord.id, projectId, previousRunRecord.finishedAt ?? previousRunRecord.createdAt)
      : null

    const trackedCompetitors = this.loadTrackedCompetitors(projectId)
    const history = orderedRecent
      .slice(0, currentIdx + 1)
      .map(r => r.id === runId ? currentRun : this.buildRunData(r.id, projectId, r.finishedAt ?? r.createdAt))

    // 4. Run analysis — skip transition detection on first run (no baseline to compare)
    if (!previousRun) {
      const result = analyzeRuns(currentRun, currentRun, { trackedCompetitors, history })
      log.info('intelligence.analyzed', {
        runId,
        regressions: 0,
        gains: 0,
        citedRate: result.health.overallCitedRate,
        insights: 0,
      })
      // Persist only the health snapshot, no transition insights
      this.persistResult(this.emptyAnalysisResult(result), runId, projectId)
      return result
    }

    const result = analyzeRuns(currentRun, previousRun, { trackedCompetitors, history })

    log.info('intelligence.analyzed', {
      runId,
      regressions: result.regressions.length,
      gains: result.gains.length,
      firstCitations: result.firstCitations.length,
      providerPickups: result.providerPickups.length,
      persistentGaps: result.persistentGaps.length,
      competitorGains: result.competitorGains.length,
      competitorLosses: result.competitorLosses.length,
      citedRate: result.health.overallCitedRate,
      insights: result.insights.length,
    })

    // 5. Tier severities once, pass tiered insights to persist + return so
    // RunCoordinator / webhook dispatch see the same severities the DB holds.
    const tieredResult = this.tierResult(result, runId, projectId)
    this.persistResult(tieredResult, runId, projectId)

    return tieredResult
  }

  /**
   * Analyze a single run given an explicit previous run (or null for first run).
   * Used by backfill where we control the run ordering.
   */
  analyzeRunWithPrevious(
    runRecord: { id: string; projectId: string; finishedAt: string | null; createdAt: string },
    previousRunRecord: { id: string; projectId: string; finishedAt: string | null; createdAt: string } | null,
    historyRecords?: readonly { id: string; projectId: string; finishedAt: string | null; createdAt: string }[],
  ): AnalysisResult | null {
    const currentRun = this.buildRunData(runRecord.id, runRecord.projectId, runRecord.finishedAt ?? runRecord.createdAt)

    if (currentRun.snapshots.length === 0) {
      return null
    }

    const previousRun = previousRunRecord
      ? this.buildRunData(previousRunRecord.id, previousRunRecord.projectId, previousRunRecord.finishedAt ?? previousRunRecord.createdAt)
      : null

    const trackedCompetitors = this.loadTrackedCompetitors(runRecord.projectId)
    const history = (historyRecords ?? [])
      .map(r => r.id === runRecord.id
        ? currentRun
        : this.buildRunData(r.id, r.projectId, r.finishedAt ?? r.createdAt))

    // Skip transition detection on first run (no baseline to compare)
    if (!previousRun) {
      const result = analyzeRuns(currentRun, currentRun, { trackedCompetitors, history })
      this.persistResult(this.emptyAnalysisResult(result), runRecord.id, runRecord.projectId)
      return result
    }

    const result = analyzeRuns(currentRun, previousRun, { trackedCompetitors, history })

    const tieredResult = this.tierResult(result, runRecord.id, runRecord.projectId)
    this.persistResult(tieredResult, runRecord.id, runRecord.projectId)

    return tieredResult
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
      // History window for persistent-gap: last HISTORY_WINDOW_RUNS entries up to and including this run.
      const historyStart = Math.max(0, globalIdx - (HISTORY_WINDOW_RUNS - 1))
      const historyRecords = allRuns.slice(historyStart, globalIdx + 1)

      const result = this.analyzeRunWithPrevious(run, previousRun, historyRecords)

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

  private loadTrackedCompetitors(projectId: string): string[] {
    return this.db
      .select({ domain: competitors.domain })
      .from(competitors)
      .where(eq(competitors.projectId, projectId))
      .all()
      .map(r => r.domain)
  }

  /**
   * Wipe transition signals from an analysis result while keeping health.
   * Used when there's no baseline (first run) to avoid emitting false transitions.
   */
  private emptyAnalysisResult(result: AnalysisResult): AnalysisResult {
    return {
      ...result,
      insights: [],
      regressions: [],
      gains: [],
      firstCitations: [],
      providerPickups: [],
      persistentGaps: [],
      competitorGains: [],
      competitorLosses: [],
    }
  }

  private persistResult(result: AnalysisResult, runId: string, projectId: string): void {
    const previouslyDismissed = new Set<string>()
    const existingInsights = this.db
      .select({ query: insights.query, provider: insights.provider, type: insights.type, dismissed: insights.dismissed })
      .from(insights)
      .where(eq(insights.runId, runId))
      .all()
    for (const row of existingInsights) {
      if (row.dismissed) {
        previouslyDismissed.add(`${row.query}:${row.provider}:${row.type}`)
      }
    }

    this.db.transaction((tx) => {
      tx.delete(insights).where(eq(insights.runId, runId)).run()
      tx.delete(healthSnapshots).where(eq(healthSnapshots.runId, runId)).run()

      const now = new Date().toISOString()

      for (const insight of result.insights) {
        const wasDismissed = previouslyDismissed.has(`${insight.query}:${insight.provider}:${insight.type}`)
        tx.insert(insights).values({
          id: insight.id,
          projectId,
          runId,
          type: insight.type,
          severity: insight.severity,
          title: insight.title,
          query: insight.query,
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

  /**
   * Apply severity tiering to the insights of an AnalysisResult and return a
   * new result. Wraps `applySeverityTiering` so callers (analyzeAndPersist,
   * analyzeRunWithPrevious) can pass the same tiered shape both into the DB
   * write and back to the RunCoordinator / webhook dispatcher.
   */
  private tierResult(result: AnalysisResult, runId: string, projectId: string): AnalysisResult {
    if (result.insights.length === 0) return result
    return { ...result, insights: this.applySeverityTiering(result.insights, runId, projectId) }
  }

  /**
   * Re-classify each regression insight's severity using GSC traffic +
   * recurrence signals via the pure `classifyRegressionSeverity` primitive
   * in @ainyc/canonry-intelligence. Non-regression insights are returned
   * untouched.
   */
  private applySeverityTiering(
    rawInsights: Insight[],
    excludeRunId: string,
    projectId: string,
  ): Insight[] {
    const regressions = rawInsights.filter((i) => i.type === 'regression')
    if (regressions.length === 0) return rawInsights

    // GSC impressions per query (case-insensitive).
    // GSC impressions per query. Distinguish "GSC not connected" (no rows
    // at all → undefined per query) from "connected but zero impressions
    // for this query" (returns 0 — a real measurement).
    const gscRows = this.db
      .select({ query: gscSearchData.query, impressions: gscSearchData.impressions })
      .from(gscSearchData)
      .where(eq(gscSearchData.projectId, projectId))
      .all()
    const gscConnected = gscRows.length > 0
    const gscImpressionsByQuery = new Map<string, number>()
    for (const row of gscRows) {
      const key = row.query.toLowerCase()
      gscImpressionsByQuery.set(key, (gscImpressionsByQuery.get(key) ?? 0) + row.impressions)
    }

    // Recurrence count: prior regression rows for the same (query, provider)
    // in the last RECURRENCE_LOOKBACK_RUNS runs, excluding this run's own.
    // Distinguish "no prior runs to compare against" (undefined) from "prior
    // runs exist but never regressed this pair" (0).
    const recentRunIds = this.db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          eq(runs.kind, RunKinds['answer-visibility']),
          or(eq(runs.status, 'completed'), eq(runs.status, 'partial')),
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(RECURRENCE_LOOKBACK_RUNS + 1)
      .all()
      .map((r) => r.id)
      .filter((id) => id !== excludeRunId)
      .slice(0, RECURRENCE_LOOKBACK_RUNS)

    const haveHistory = recentRunIds.length > 0
    const priorRegressionsByPair = new Map<string, number>()
    if (haveHistory) {
      const priorRows = this.db
        .select({ query: insights.query, provider: insights.provider })
        .from(insights)
        .where(and(eq(insights.type, 'regression'), inArray(insights.runId, recentRunIds)))
        .all()
      for (const row of priorRows) {
        const key = `${row.query}:${row.provider}`
        priorRegressionsByPair.set(key, (priorRegressionsByPair.get(key) ?? 0) + 1)
      }
    }

    return rawInsights.map((insight) => {
      if (insight.type !== 'regression') return insight
      const gscImpressions = gscConnected
        ? gscImpressionsByQuery.get(insight.query.toLowerCase()) ?? 0
        : undefined
      const recurrenceCount = haveHistory
        ? priorRegressionsByPair.get(`${insight.query}:${insight.provider}`) ?? 0
        : undefined
      const severity = classifyRegressionSeverity({
        gscImpressions,
        recurrenceCount,
      })
      return { ...insight, severity }
    })
  }

  private buildRunData(runId: string, projectId: string, completedAt: string): RunData {
    const rows = this.db
      .select({
        query: queries.query,
        provider: querySnapshots.provider,
        citationState: querySnapshots.citationState,
        citedDomains: querySnapshots.citedDomains,
        competitorOverlap: querySnapshots.competitorOverlap,
      })
      .from(querySnapshots)
      .leftJoin(queries, eq(querySnapshots.queryId, queries.id))
      .where(eq(querySnapshots.runId, runId))
      .all()

    const snapshots: Snapshot[] = rows.map(r => {
      const domains = parseJsonColumn<string[]>(r.citedDomains, [])
      const competitors = parseJsonColumn<string[]>(r.competitorOverlap, [])
      return {
        query: r.query ?? '',
        provider: r.provider,
        cited: r.citationState === CitationStates.cited,
        citationUrl: domains[0] ?? undefined,
        competitorDomain: competitors[0] ?? undefined,
      }
    })

    return { runId, projectId, completedAt, snapshots }
  }
}
