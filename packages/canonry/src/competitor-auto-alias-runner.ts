import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import {
  applyCompetitorAutoAliases,
  createProjectPassQueue,
  type AppliedCompetitorAutoAliases,
  type CompetitorAnswerAnchorReader,
} from '@ainyc/canonry-api-routes'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { describeError } from '@ainyc/canonry-contracts'
import { createLogger } from './logger.js'

const log = createLogger('CompetitorAutoAliases')

export interface CompetitorAutoAliasRunner {
  /**
   * Ask for one detection pass over the project's stored answers. Returns at
   * once; the pass runs on a later tick. Requests made while a pass runs
   * share one follow-up pass after it (`createProjectPassQueue`), so a burst
   * (a sweep and its fill completing together) costs at most two passes.
   * Failures are logged.
   */
  schedule(projectId: string, reason: string): void
  /**
   * One pass through the same queue, resolving with its result
   * (`POST /competitor-auto-aliases`): it never runs beside a post-run pass,
   * and its result is from a pass that started after the request. Failures
   * are logged and rethrown.
   */
  request(projectId: string, reason: string): Promise<AppliedCompetitorAutoAliases | null>
  /** Resolves when no pass is queued or running (tests and shutdown). */
  settled(): Promise<void>
}

/**
 * Runs answer-derived competitor alias detection (`applyCompetitorAutoAliases`)
 * off the request and run-completion paths: after every completed or partial
 * answer-visibility run, after a competitor is added, after a name is
 * unblocked, and for an apply-now request. When a pass changes any
 * competitor's auto names, `onNamesChanged` refreshes the stored competitor
 * fields, the same recompute a curated alias edit triggers.
 */
export function createCompetitorAutoAliasRunner(opts: {
  db: DatabaseClient
  readAnchors?: CompetitorAnswerAnchorReader
  onNamesChanged: (projectId: string, projectName: string) => void
}): CompetitorAutoAliasRunner {
  /** Why each project's next pass runs, for its log line. */
  const reasons = new Map<string, string[]>()

  const queue = createProjectPassQueue(async (projectId) => {
    // Never on the caller's tick: the completion path and the request return first.
    await yieldToEventLoop()
    const reason = (reasons.get(projectId) ?? []).join(',')
    reasons.delete(projectId)
    const result = await applyCompetitorAutoAliases(opts.db, projectId, { readAnchors: opts.readAnchors })
    if (!result) return null
    const added = result.detection.competitors.reduce((sum, competitor) => sum + competitor.added.length, 0)
    const removed = result.detection.competitors.reduce((sum, competitor) => sum + competitor.removed.length, 0)
    log.info('detection.completed', {
      projectId,
      reason,
      runs: result.detection.scan.runs,
      snapshots: result.detection.scan.snapshots,
      added,
      removed,
      namesChanged: result.namesChanged,
    })
    if (result.namesChanged) {
      // The names are stored; a failing refresh is its own problem.
      try { opts.onNamesChanged(projectId, result.detection.project) }
      catch (err) { log.error('names-changed.failed', { projectId, error: describeError(err) }) }
    }
    return result
  })

  const enqueue = (projectId: string, reason: string): Promise<AppliedCompetitorAutoAliases | null> => {
    reasons.set(projectId, [...(reasons.get(projectId) ?? []), reason])
    return queue.request(projectId)
  }

  return {
    schedule(projectId, reason) {
      enqueue(projectId, reason).catch((err: unknown) => {
        log.error('detection.failed', { projectId, reason, error: describeError(err) })
      })
    },
    async request(projectId, reason) {
      try {
        return await enqueue(projectId, reason)
      } catch (err) {
        log.error('detection.failed', { projectId, reason, error: describeError(err) })
        throw err
      }
    },
    settled: () => queue.settled(),
  }
}
