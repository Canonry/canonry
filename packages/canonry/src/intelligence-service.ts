import { eq, desc, asc, and, ne, or, inArray } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { competitors, groupRunsByCreatedAt, gscSearchData, healthSnapshots, insights, projects, queries, querySnapshots, runs, gbpLocations, gbpDailyMetrics, gbpKeywordMonthly, gbpPlaceActions, gbpLodgingSnapshots } from '@ainyc/canonry-db'
import { analyzeRuns, analyzeGbp, classifyRegressionSeverity, PERSISTENT_GAP_THRESHOLD } from '@ainyc/canonry-intelligence'
import type { RunData, Snapshot, AnalysisResult, Insight, GbpLocationSignals, GbpKeywordPoint } from '@ainyc/canonry-intelligence'
import { buildGbpSummary } from '@ainyc/canonry-api-routes'
import { CitationStates, RunKinds, RunTriggers, effectiveDomains } from '@ainyc/canonry-contracts'
import crypto from 'node:crypto'
import { createLogger } from './logger.js'
import { pickProjectCitedDomain } from './citation-utils.js'

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
          // Defensive: RunCoordinator already skips probes before this is
          // called, but if a future call site invokes analyzeAndPersist
          // directly for a probe, probes still must not pollute the
          // intelligence window.
          ne(runs.trigger, RunTriggers.probe),
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
   * Analyze a completed `gbp-sync` run and persist location-scoped GBP insights.
   *
   * Point-in-time (no previous-run comparison): for each SELECTED location it
   * derives signals from the shared GBP summary math (metric week-over-week,
   * lodging completeness, place-action CTAs) plus the accumulating keyword
   * monthly series (month-over-month keyword drop), then runs the pure
   * `analyzeGbp` analyzer. Persists insights ONLY — no health snapshot, which is
   * an answer-visibility concept. Idempotent per `runId`; dismissals are
   * preserved across re-analysis of the same run by the stable insight id.
   * Returns the persisted insights so the coordinator can count critical/high.
   */
  analyzeAndPersistGbp(runId: string, projectId: string): Insight[] {
    const selected = this.db
      .select()
      .from(gbpLocations)
      .where(and(eq(gbpLocations.projectId, projectId), eq(gbpLocations.selected, true)))
      .all()

    if (selected.length === 0) {
      log.info('gbp-intelligence.skip', { runId, reason: 'no selected locations' })
      this.persistGbpInsights(runId, projectId, [])
      return []
    }

    const today = new Date().toISOString().slice(0, 10)
    const signals = selected.map((loc) =>
      this.buildGbpLocationSignals(projectId, loc.locationName, loc.displayName, today),
    )
    const drafts = analyzeGbp(signals)

    const now = new Date().toISOString()
    const builtInsights: Insight[] = drafts.map((d) => ({
      // Stable id: unique per (run, location, type). Embedding runId keeps the
      // PK unique across runs; embedding locationName keeps two chain locations
      // that share a displayName from colliding.
      id: `${runId}::gbp::${d.locationName}::${d.type}`,
      type: d.type,
      severity: d.severity,
      title: d.title,
      query: d.query,
      provider: d.provider,
      recommendation: d.recommendation,
      createdAt: now,
    }))

    this.persistGbpInsights(runId, projectId, builtInsights)
    log.info('gbp-intelligence.analyzed', { runId, locations: selected.length, insights: builtInsights.length })
    return builtInsights
  }

  /** Build the per-location signal bundle the GBP analyzer consumes. */
  private buildGbpLocationSignals(
    projectId: string,
    locationName: string,
    displayName: string,
    fallbackDate: string,
  ): GbpLocationSignals {
    const metricRows = this.db
      .select({ metric: gbpDailyMetrics.metric, date: gbpDailyMetrics.date, value: gbpDailyMetrics.value })
      .from(gbpDailyMetrics)
      .where(and(eq(gbpDailyMetrics.projectId, projectId), eq(gbpDailyMetrics.locationName, locationName)))
      .all()
    const placeActionRows = this.db
      .select({ placeActionType: gbpPlaceActions.placeActionType, providerType: gbpPlaceActions.providerType })
      .from(gbpPlaceActions)
      .where(and(eq(gbpPlaceActions.projectId, projectId), eq(gbpPlaceActions.locationName, locationName)))
      .all()
    const lodgingRow = this.db
      .select({ populatedGroupCount: gbpLodgingSnapshots.populatedGroupCount })
      .from(gbpLodgingSnapshots)
      .where(and(eq(gbpLodgingSnapshots.projectId, projectId), eq(gbpLodgingSnapshots.locationName, locationName)))
      .orderBy(desc(gbpLodgingSnapshots.syncedAt))
      .limit(1)
      .get()

    // Anchor the window to the latest stored metric date (same as the summary
    // route) so the recent-vs-prior split is deterministic, not clock-relative.
    const referenceDate = metricRows.reduce<string>((max, r) => (r.date > max ? r.date : max), '') || fallbackDate
    const summary = buildGbpSummary({
      locationName,
      locationCount: 1,
      referenceDate,
      dailyMetrics: metricRows,
      keywords: [], // keyword coverage is unused here; the trend uses the monthly series below
      placeActions: placeActionRows.map((r) => ({ placeActionType: r.placeActionType, providerType: r.providerType ?? null })),
      lodging: lodgingRow ? [{ locationName, populatedGroupCount: lodgingRow.populatedGroupCount }] : [],
    })

    const trend = this.buildGbpKeywordTrend(projectId, locationName)

    return {
      locationName,
      displayName,
      metricRecent7d: summary.performance.recent7d,
      metricPrior7d: summary.performance.prior7d,
      metricDeltaPct: summary.performance.deltaPct,
      lodgingCapable: summary.lodging.lodgingLocationCount > 0,
      lodgingEmpty: summary.lodging.emptyLodgingCount > 0,
      placeActionCount: summary.placeActions.total,
      hasDirectMerchantCta: summary.placeActions.hasDirectMerchantCta,
      keywordRecentMonth: trend.recentMonth,
      keywordPriorMonth: trend.priorMonth,
      keywordPoints: trend.points,
    }
  }

  /** Build the month-over-month keyword series for a location from the
   *  accumulating gbp_keyword_monthly table (latest complete month vs prior). */
  private buildGbpKeywordTrend(
    projectId: string,
    locationName: string,
  ): { recentMonth: string | null; priorMonth: string | null; points: GbpKeywordPoint[] } {
    const rows = this.db
      .select({ month: gbpKeywordMonthly.month, keyword: gbpKeywordMonthly.keyword, valueCount: gbpKeywordMonthly.valueCount })
      .from(gbpKeywordMonthly)
      .where(and(eq(gbpKeywordMonthly.projectId, projectId), eq(gbpKeywordMonthly.locationName, locationName)))
      .all()
    if (rows.length === 0) return { recentMonth: null, priorMonth: null, points: [] }

    const months = [...new Set(rows.map((r) => r.month))].sort().reverse()
    const recentMonth = months[0] ?? null
    const priorMonth = months[1] ?? null
    if (!recentMonth || !priorMonth) return { recentMonth, priorMonth: null, points: [] }

    const recentByKeyword = new Map<string, number | null>()
    const priorByKeyword = new Map<string, number | null>()
    for (const r of rows) {
      if (r.month === recentMonth) recentByKeyword.set(r.keyword, r.valueCount)
      else if (r.month === priorMonth) priorByKeyword.set(r.keyword, r.valueCount)
    }
    const points: GbpKeywordPoint[] = []
    for (const [keyword, recent] of recentByKeyword) {
      points.push({ keyword, recent: recent ?? null, prior: priorByKeyword.get(keyword) ?? null })
    }
    return { recentMonth, priorMonth, points }
  }

  /**
   * Persist GBP insights for a run. Mirrors `persistResult`'s idempotency
   * (delete-then-insert for the run) and dismissal preservation, but keyed by
   * the stable insight id (GBP insights aren't query/provider-scoped) and
   * WITHOUT a health snapshot.
   */
  private persistGbpInsights(runId: string, projectId: string, gbpInsights: Insight[]): void {
    const previouslyDismissed = new Set<string>()
    const existing = this.db
      .select({ id: insights.id, dismissed: insights.dismissed })
      .from(insights)
      .where(eq(insights.runId, runId))
      .all()
    for (const row of existing) {
      if (row.dismissed) previouslyDismissed.add(row.id)
    }

    this.db.transaction((tx) => {
      tx.delete(insights).where(eq(insights.runId, runId)).run()
      for (const insight of gbpInsights) {
        tx.insert(insights).values({
          id: insight.id,
          projectId,
          runId,
          type: insight.type,
          severity: insight.severity,
          title: insight.title,
          query: insight.query,
          provider: insight.provider,
          recommendation: insight.recommendation ?? null,
          cause: insight.cause ?? null,
          dismissed: previouslyDismissed.has(insight.id),
          createdAt: insight.createdAt,
        }).run()
      }
    })

    log.info('gbp-intelligence.persisted', { runId, insights: gbpInsights.length })
  }

  /**
   * Analyze a single run given an explicit previous run (or null for first run).
   * Used by backfill where we control the run ordering.
   *
   * `dryRun: true` skips the DB write — `persistResult` is not called and
   * dismissed flags / health rows are untouched. Callers receive the same
   * AnalysisResult they would have, suitable for previewing what a write
   * would have produced.
   */
  analyzeRunWithPrevious(
    runRecord: { id: string; projectId: string; finishedAt: string | null; createdAt: string; location?: string | null },
    previousRunRecord: { id: string; projectId: string; finishedAt: string | null; createdAt: string; location?: string | null } | null,
    historyRecords?: readonly { id: string; projectId: string; finishedAt: string | null; createdAt: string; location?: string | null }[],
    opts?: { dryRun?: boolean },
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
      const emptyResult = this.emptyAnalysisResult(result)
      if (!opts?.dryRun) this.persistResult(emptyResult, runRecord.id, runRecord.projectId)
      return result
    }

    const result = analyzeRuns(currentRun, previousRun, { trackedCompetitors, history })

    const tieredResult = this.tierResult(result, runRecord.id, runRecord.projectId)
    if (!opts?.dryRun) this.persistResult(tieredResult, runRecord.id, runRecord.projectId)

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
   *   - `dryRun`: compute the analysis without writing. The return value
   *     includes a `delta` describing what would change (rows to delete vs
   *     create per run + aggregate). DB is left untouched.
   */
  backfill(
    projectName: string,
    opts?: { fromRunId?: string; toRunId?: string; since?: string; dryRun?: boolean },
    onProgress?: (info: { runId: string; index: number; total: number; insights: number }) => void,
  ): {
    processed: number
    skipped: number
    totalInsights: number
    dryRun?: boolean
    delta?: {
      wouldDelete: number
      wouldCreate: number
      netChange: number
      perRun: Array<{ runId: string; existingInsights: number; newInsights: number }>
    }
  } {
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
          // Backfill must not replay probe runs as if they were real sweeps.
          ne(runs.trigger, RunTriggers.probe),
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
    const isDryRun = opts?.dryRun === true
    const perRunDelta: Array<{ runId: string; existingInsights: number; newInsights: number }> = []
    let wouldDeleteTotal = 0

    // Dry-run delta calc: count the existing insights for every targeted run
    // so we can report "what gets wiped" alongside "what gets written". A
    // real backfill would delete these inside persistResult before re-inserting.
    const existingByRunId = new Map<string, number>()
    if (isDryRun && targetRuns.length > 0) {
      const rows = this.db
        .select({ runId: insights.runId })
        .from(insights)
        .where(inArray(insights.runId, targetRuns.map(r => r.id)))
        .all()
      for (const r of rows) {
        // insights.run_id is nullable in the schema (FK SET NULL post-cascade),
        // but rows whose run_id is null can't have been written by a backfill
        // for any run in targetRuns, so skip them.
        if (r.runId == null) continue
        existingByRunId.set(r.runId, (existingByRunId.get(r.runId) ?? 0) + 1)
      }
    }

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

      const result = this.analyzeRunWithPrevious(run, previousRun, historyRecords, { dryRun: isDryRun })

      if (result) {
        processed++
        totalInsights += result.insights.length
        if (isDryRun) {
          const existing = existingByRunId.get(run.id) ?? 0
          wouldDeleteTotal += existing
          perRunDelta.push({ runId: run.id, existingInsights: existing, newInsights: result.insights.length })
        }
        onProgress?.({ runId: run.id, index: i + 1, total: targetRuns.length, insights: result.insights.length })
      } else {
        skipped++
        onProgress?.({ runId: run.id, index: i + 1, total: targetRuns.length, insights: 0 })
      }
    }

    if (isDryRun) {
      return {
        processed,
        skipped,
        totalInsights,
        dryRun: true,
        delta: {
          wouldDelete: wouldDeleteTotal,
          wouldCreate: totalInsights,
          netChange: totalInsights - wouldDeleteTotal,
          perRun: perRunDelta,
        },
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
          recommendation: insight.recommendation ?? null,
          cause: insight.cause ?? null,
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
        providerBreakdown: result.health.providerBreakdown,
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
      (projectRow?.locations ?? []).length,
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
          // Defensive — see top of file.
          ne(runs.trigger, RunTriggers.probe),
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
    // Project-owned domains, used to label a citation gain/regression with the
    // project's OWN cited URL rather than `citedDomains[0]` (which is often a
    // co-cited competitor). One PK lookup per run in the window.
    const projectDomainRow = this.db
      .select({ canonicalDomain: projects.canonicalDomain, ownedDomains: projects.ownedDomains })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get()
    const projectDomains = projectDomainRow
      ? effectiveDomains({
          canonicalDomain: projectDomainRow.canonicalDomain,
          ownedDomains: projectDomainRow.ownedDomains,
        })
      : []

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

      const domains = r.citedDomains
      const competitors = r.competitorOverlap
      snapshots.push({
        query: resolvedQuery,
        provider: r.provider,
        cited: r.citationState === CitationStates.cited,
        // The project's OWN cited domain — never a co-cited competitor that
        // happens to sort first in the full citedDomains set.
        citationUrl: pickProjectCitedDomain(domains, projectDomains),
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
