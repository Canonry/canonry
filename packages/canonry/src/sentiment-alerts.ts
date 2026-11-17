import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm'
import { notProbeRun } from '@canonry/canonry-api-routes'
import type { DatabaseClient } from '@canonry/canonry-db'
import { runs, sentimentAlertRuns, sentimentCompletionReceipts, sentimentJobs, sentimentSettings } from '@canonry/canonry-db'
import { describeError } from '@canonry/canonry-contracts'
import { startAlertLoop } from './alert-loop.js'
import { createLogger } from './logger.js'

const log = createLogger('SentimentAlerts')

/**
 * A sweep is considered only while its automatic sentiment jobs are this
 * recent, so a project that turns alerts on never hears about old sweeps, and
 * a sweep no webhook accepted stops being retried.
 */
export const SENTIMENT_ALERT_WINDOW_MS = 7 * 86_400_000
export const SENTIMENT_ALERT_INTERVAL_MS = 5 * 60_000

export const SentimentAlertStates = {
  sent: 'sent',
  skipped: 'skipped',
  quiet: 'quiet',
  baseline: 'baseline',
} as const
export type SentimentAlertState = (typeof SentimentAlertStates)[keyof typeof SentimentAlertStates]

/** The automatic sentiment admission of a sweep (`SentimentWorker.reconcile`); backfills never alert. */
const AUTOMATIC = 'automatic'

/**
 * Sweeps whose automatic sentiment work has settled, per project, oldest
 * first. A sweep is settled once every automatic job admitted for it in the
 * window has no pending, retrying or running assessment, and the worker has
 * admitted every class of its newest completion receipt (the project's
 * `reconciledSequence` reached it), so a class still waiting for admission
 * is never decided without. Probe runs never alert.
 *
 * Sweeps are decided in order: a project's list stops at its oldest sweep
 * that has not settled. A later sweep compared while an earlier one is still
 * unrated would be compared with the sweep before both, and the earlier one
 * would report the same answer again once it settled.
 */
export function settledSentimentRuns(db: DatabaseClient, now: number): Map<string, string[]> {
  const since = new Date(now - SENTIMENT_ALERT_WINDOW_MS).toISOString()
  const jobRunId = sql<string>`json_extract(${sentimentJobs.selection}, '$.runId')`
  const lastReceipt = sql<number | null>`(SELECT MAX(${sentimentCompletionReceipts.sequence}) FROM ${sentimentCompletionReceipts}
    WHERE ${sentimentCompletionReceipts.projectId} = ${runs.projectId} AND ${sentimentCompletionReceipts.runId} = ${runs.id})`
  const rows = db.select({
    projectId: sentimentJobs.projectId,
    runId: runs.id,
    open: sql<number>`SUM(${sentimentJobs.pendingItems} + ${sentimentJobs.runningItems})`,
    lastReceipt,
    reconciled: sentimentSettings.reconciledSequence,
  })
    .from(sentimentJobs)
    .innerJoin(runs, and(eq(runs.projectId, sentimentJobs.projectId), sql`${runs.id} = ${jobRunId}`))
    .leftJoin(sentimentSettings, eq(sentimentSettings.projectId, sentimentJobs.projectId))
    .where(and(eq(sentimentJobs.action, AUTOMATIC), gte(sentimentJobs.createdAt, since), notProbeRun()))
    .groupBy(sentimentJobs.projectId, runs.id)
    .orderBy(asc(runs.createdAt), asc(runs.id))
    .all()
  const settled = new Map<string, string[]>()
  const waiting = new Set<string>()
  for (const row of rows) {
    if (waiting.has(row.projectId)) continue
    const admitted = row.lastReceipt === null || row.lastReceipt <= (row.reconciled ?? 0)
    if (Number(row.open) > 0 || !admitted) {
      waiting.add(row.projectId)
      continue
    }
    const list = settled.get(row.projectId)
    if (list) list.push(row.runId)
    else settled.set(row.projectId, [row.runId])
  }
  return settled
}

/**
 * Of these sweeps, the ones the project has not decided on yet, and whether it
 * has decided on any sweep before. A project's first pass records what has
 * already settled as its baseline instead of alerting on it.
 */
export function undecidedSentimentRuns(db: DatabaseClient, projectId: string, runIds: readonly string[]): { undecided: string[]; firstPass: boolean } {
  if (runIds.length === 0) return { undecided: [], firstPass: false }
  const decided = new Set(db.select({ runId: sentimentAlertRuns.runId })
    .from(sentimentAlertRuns)
    .where(and(eq(sentimentAlertRuns.projectId, projectId), inArray(sentimentAlertRuns.runId, [...runIds])))
    .all()
    .map(row => row.runId))
  const firstPass = db.select({ runId: sentimentAlertRuns.runId })
    .from(sentimentAlertRuns)
    .where(eq(sentimentAlertRuns.projectId, projectId))
    .limit(1)
    .get() === undefined
  return { undecided: runIds.filter(runId => !decided.has(runId)), firstPass }
}

export function recordSentimentAlertRuns(db: DatabaseClient, projectId: string, runIds: readonly string[], state: SentimentAlertState, now: number): void {
  const recordedAt = new Date(now).toISOString()
  for (const runId of runIds) {
    db.insert(sentimentAlertRuns).values({ projectId, runId, state, recordedAt }).onConflictDoNothing().run()
  }
}

/** Run `dispatch` every `intervalMs`; passes never overlap. */
export function startSentimentAlertLoop(dispatch: () => Promise<number>, intervalMs = SENTIMENT_ALERT_INTERVAL_MS): () => void {
  return startAlertLoop(dispatch, intervalMs, err => { log.warn('sentiment-alerts.dispatch-failed', { error: describeError(err) }) })
}
