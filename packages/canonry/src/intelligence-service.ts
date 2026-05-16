import { eq, desc, asc, and, or, inArray } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { competitors, groupRunsByCreatedAt, gscSearchData, healthSnapshots, insights, parseJsonColumn, projects, queries, querySnapshots, runs } from '@ainyc/canonry-db'
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
    const currentRun = this.buildRunData(
      runId,
      projectId,
      currentRunRecord.finishedAt ?? currentRunRecord.createdAt,
      currentRunRecord.location ?? null,
    )

    if (currentRun.snapshots.length === 0) {
      log.info('intelligence.skip', { runId, reason: 'no snapshots' })
      return null
    }

    // 3. Build RunData for previous run + history window (oldest → newest, ending at current).
    //
    // Multi-location fan-out: a single sweep produces one run per configured
    // location. We must compare each run against the previous run *at the
    // same location* — comparing Michigan to its sibling Florida arm would
    // treat the geo difference as a regression/gain. Filter the ordered
    // window to same-location entries, treating null/undefined as one
    // bucket (locationless runs share a chronology).
    const orderedRecent = [...recentRuns].reverse()
    const currentLocation = currentRunRecord.location ?? null
    const sameLocationOrdered = orderedRecent.filter(r => (r.location ?? null) === currentLocation)
    const currentLocIdx = sameLocationOrdered.findIndex(r => r.id === runId)
    const previousRunRecord = currentLocIdx > 0 ? sameLocationOrdered[currentLocIdx - 1]! : null
    const previousRun = previousRunRecord
      ? this.buildRunData(
        previousRunRecord.id,
        projectId,
        previousRunRecord.finishedAt ?? previousRunRecord.createdAt,
        previousRunRecord.location ?? null,
      )
      : null

    const trackedCompetitors = this.loadTrackedCompetitors(projectId)
    const history = sameLocationOrdered
      .slice(0, currentLocIdx + 1)
      .map(r => r.id === runId
        ? currentRun
        : this.buildRunData(r.id, projectId, r.finishedAt ?? r.createdAt, r.location ?? null))

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
    runRecord: { id: string; projectId: string; finishedAt: string | null; createdAt: string; location?: string | null },
    previousRunRecord: { id: string; projectId: string; finishedAt: string | null; createdAt: string; location?: string | null } | null,
    historyRecords?: readonly { id: string; projectId: string; finishedAt: string | null; createdAt: string; location?: string | null }[],
  ): AnalysisResult | null {
    const currentRun = this.buildRunData(
      runRecord.id,
      runRecord.projectId,
      runRecord.finishedAt ?? runRecord.createdAt,
      runRecord.location ?? null,
    )

    if (currentRun.snapshots.length === 0) {
      return null
    }

    const previousRun = previousRunRecord
      ? this.buildRunData(
        previousRunRecord.id,
        previousRunRecord.projectId,
        previousRunRecord.finishedAt ?? previousRunRecord.createdAt,
        previousRunRecord.location ?? null,
      )
      : null

    const trackedCompetitors = this.loadTrackedCompetitors(runRecord.projectId)
    const history = (historyRecords ?? [])
      .map(r => r.id === runRecord.id
        ? currentRun
        : this.buildRunData(r.id, r.projectId, r.finishedAt ?? r.createdAt, r.location ?? null))

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
   *
   * Scoping options:
   *   - `fromRunId` / `toRunId`: bound the target range by exact run ID.
   *   - `since`: bound the target range by `finishedAt >= <date>`. Accepts
   *     any string that `Date.parse` understands (ISO 8601, `YYYY-MM-DD`,
   *     etc.). Runs before the cutoff are *not* re-processed but stay
   *     available for predecessor lookup, so transition detection at the
   *     boundary stays correct. Composes with `fromRunId` / `toRunId` —
   *     all three filters intersect.
   */
  backfill(
    projectName: string,
    opts?: { fromRunId?: string; toRunId?: string; since?: string },
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

    let sinceTimestamp: number | null = null
    if (opts?.since !== undefined) {
      const parsed = Date.parse(opts.since)
      if (Number.isNaN(parsed)) {
        throw new Error(`Invalid --since value "${opts.since}": expected a parseable date (ISO 8601 or YYYY-MM-DD)`)
      }
      sinceTimestamp = parsed
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

    let targetRuns = allRuns.slice(startIdx, endIdx)
    // Apply --since on top of the range slice. We filter target runs only —
    // `allRuns` is intentionally still the full chronology so the predecessor
    // lookup inside the loop can walk back across the cutoff.
    if (sinceTimestamp !== null) {
      targetRuns = targetRuns.filter(r => {
        const ts = r.finishedAt ?? r.createdAt
        const t = Date.parse(ts)
        return !Number.isNaN(t) && t >= sinceTimestamp
      })
    }
    let processed = 0
    let skipped = 0
    let totalInsights = 0

    for (let i = 0; i < targetRuns.length; i++) {
      const run = targetRuns[i]!
      // Pick the previous run *at the same location* — backfill of a
      // multi-location project must not compare sibling fan-out arms as if
      // they were a temporal sequence (Michigan→Florida is not a transition).
      // Locationless runs share a chronology (treated as one bucket).
      const runLocation = run.location ?? null
      const sameLocationRuns = allRuns.filter(r => (r.location ?? null) === runLocation)
      const sameLocIdx = sameLocationRuns.indexOf(run)
      const previousRun = sameLocIdx > 0 ? sameLocationRuns[sameLocIdx - 1]! : null
      // History window for persistent-gap: last HISTORY_WINDOW_RUNS entries
      // at the same location up to and including this run.
      const historyStart = Math.max(0, sameLocIdx - (HISTORY_WINDOW_RUNS - 1))
      const historyRecords = sameLocationRuns.slice(historyStart, sameLocIdx + 1)

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
    // Walk fan-out groups (one group per distinct `createdAt`) so the
    // recurrence lookback covers N time-points, not N rows — a 2-location
    // `--all-locations` sweep would otherwise consume two slots for the same
    // time-point and halve the effective look-back. Insights still aggregate
    // across all run ids in each kept group. See #480.
    //
    // SQL fetch limit must accommodate up to (LOOKBACK + 1) groups worth of
    // rows. Each group's row count caps at the project's configured location
    // count. Scaling the limit by `max(2, locationCount)` keeps the query
    // bounded while letting 5+ location projects span the full lookback
    // window without short-circuiting.
    const projectRow = this.db
      .select({ locations: projects.locations })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get()
    const locationCount = Math.max(
      1,
      parseJsonColumn<unknown[]>(projectRow?.locations ?? null, []).length,
    )
    const ROWS_PER_GROUP_BUDGET = Math.max(2, locationCount)
    const recentRunRows = this.db
      .select({ id: runs.id, createdAt: runs.createdAt })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          eq(runs.kind, RunKinds['answer-visibility']),
          or(eq(runs.status, 'completed'), eq(runs.status, 'partial')),
        ),
      )
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit((RECURRENCE_LOOKBACK_RUNS + 1) * ROWS_PER_GROUP_BUDGET)
      .all()
    const recentGroups = groupRunsByCreatedAt(recentRunRows)
    const recentRunIds: string[] = []
    // Track which createdAt each runId belongs to so the regression count
    // below can be deduped to "groups that had this regression" rather
    // than "rows that had this regression." Without this, under fan-out,
    // a single time-point with the same regression at both florida and
    // michigan inflates the recurrence count by 2× per group.
    const recentRunIdToCreatedAt = new Map<string, string>()
    let consumedGroups = 0
    for (const group of recentGroups) {
      // Skip the group containing the current run so we count *prior* sweeps.
      const groupIds = group.map((r) => r.id)
      if (groupIds.includes(excludeRunId)) continue
      for (const r of group) recentRunIdToCreatedAt.set(r.id, r.createdAt)
      recentRunIds.push(...groupIds)
      consumedGroups++
      if (consumedGroups >= RECURRENCE_LOOKBACK_RUNS) break
    }

    const haveHistory = recentRunIds.length > 0
    const priorRegressionsByPair = new Map<string, number>()
    if (haveHistory) {
      const priorRows = this.db
        .select({ query: insights.query, provider: insights.provider, runId: insights.runId })
        .from(insights)
        .where(and(eq(insights.type, 'regression'), inArray(insights.runId, recentRunIds)))
        .all()
      // Dedupe by (query, provider, groupCreatedAt): one regression at florida
      // + one regression at michigan in the same fan-out group counts as a
      // single time-point of regression, not two.
      const regressionGroups = new Map<string, Set<string>>()
      for (const row of priorRows) {
        if (!row.runId) continue
        const key = `${row.query}:${row.provider}`
        const groupKey = recentRunIdToCreatedAt.get(row.runId) ?? row.runId
        let groups = regressionGroups.get(key)
        if (!groups) {
          groups = new Set()
          regressionGroups.set(key, groups)
        }
        groups.add(groupKey)
      }
      for (const [key, groups] of regressionGroups) {
        priorRegressionsByPair.set(key, groups.size)
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

  private buildRunData(
    runId: string,
    projectId: string,
    completedAt: string,
    location: string | null = null,
  ): RunData {
    const rows = this.db
      .select({
        query: queries.query,
        // Denormalized query text persisted by v58 — the fallback when the
        // joined queries.query has been hard-deleted (or the query_id was
        // nulled by the v58 dangling-FK cleanup).
        queryText: querySnapshots.queryText,
        provider: querySnapshots.provider,
        citationState: querySnapshots.citationState,
        citedDomains: querySnapshots.citedDomains,
        competitorOverlap: querySnapshots.competitorOverlap,
        snapshotLocation: querySnapshots.location,
      })
      .from(querySnapshots)
      .leftJoin(queries, eq(querySnapshots.queryId, queries.id))
      .where(eq(querySnapshots.runId, runId))
      .all()

    const snapshots: Snapshot[] = []
    let orphanCount = 0
    for (const r of rows) {
      // Recover query identity in priority order: live join → denormalized
      // text. If both are missing this snapshot has no identity to surface,
      // and feeding it to the detectors would produce phantom insights —
      // every orphan in the same run collapses to a single ("", provider,
      // location) detector key, fabricating regressions/gains on a synthetic
      // empty query. Skip it.
      const resolvedQuery = r.query ?? r.queryText ?? null
      if (!resolvedQuery) {
        orphanCount++
        continue
      }

      const domains = parseJsonColumn<string[]>(r.citedDomains, [])
      const competitors = parseJsonColumn<string[]>(r.competitorOverlap, [])
      snapshots.push({
        query: resolvedQuery,
        provider: r.provider,
        cited: r.citationState === CitationStates.cited,
        citationUrl: domains[0] ?? undefined,
        // Snapshots carry their own location for downstream detectors. In
        // practice every snapshot in a single runId shares the run's
        // location; the per-row column is the same value duplicated, but
        // we read it from the snapshot row so a stale runs.location can't
        // mask snapshot truth.
        location: r.snapshotLocation ?? location ?? null,
        competitorDomains: competitors,
        // citedDomains is the FULL set (tracked competitors + third-party
        // sources). Cause analysis uses it to name the displacing source
        // when no tracked competitor appears in the response.
        citedDomains: domains,
      })
    }

    // Surface the silent skip path. Healthy DBs emit zero orphan-skip
    // warnings; a sudden non-zero count is a signal that a write path
    // started accumulating dangling-FK rows again, or that v58-equivalent
    // migration debt exists on the project. Without this log the skip is
    // invisible to operators until a customer notices missing insights.
    if (orphanCount > 0) {
      log.warn('snapshot.orphan-skip', { runId, projectId, orphanCount })
    }

    return { runId, projectId, completedAt, location, snapshots }
  }
}
