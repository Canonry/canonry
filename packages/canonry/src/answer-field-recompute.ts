import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import {
  backfillProjectAnswerMentionsInChunks,
  createProjectPassQueue,
  type ProjectAnswerMentionsBackfillResult,
} from '@ainyc/canonry-api-routes'
import type { DatabaseClient } from '@ainyc/canonry-db'

/** What one recompute request covers. */
export interface AnswerFieldRecomputeRequest {
  /**
   * Recompute `answer_mentioned` too (a project identity change). Without it
   * only `competitor_overlap` and `recommended_competitors` are recomputed,
   * the pass a competitor names change runs.
   */
  full?: boolean
}

export interface AnswerFieldRecomputePass {
  full: boolean
  result: ProjectAnswerMentionsBackfillResult
}

export interface AnswerFieldRecomputeQueue {
  /**
   * Ask for a recompute of every answer-visibility run of the project;
   * resolves with the pass that covered it, which started after the request.
   * Requests made while a pass runs share one follow-up pass (`full` if any
   * of them asked for it).
   */
  request(projectId: string, scope: AnswerFieldRecomputeRequest): Promise<AnswerFieldRecomputePass>
  /** Resolves when no pass is queued or running. */
  settled(): Promise<void>
}

/**
 * ONE QUEUE FOR EVERY IDENTITY-CHANGE RECOMPUTE OF THE STORED ANSWER FIELDS.
 *
 * A project alias change (`answer_mentioned` and the competitor fields) and a
 * competitor names change (curated, auto-detected, blocked: the competitor
 * fields) both go through this per-project queue, so two recomputes of one
 * project never interleave their chunks and the last pass to write started
 * after the last change it was asked for. Each pass also re-reads the
 * identity between its chunks (`backfillProjectAnswerMentionsInChunks`), so a
 * change committed while it runs never leaves a chunk written from the
 * identity it replaced. A run still recording when the identity changes
 * rescores itself when it finishes (`JobRunner.reconcileRunAnswerFields`).
 */
export function createAnswerFieldRecomputeQueue(opts: { db: DatabaseClient }): AnswerFieldRecomputeQueue {
  const pendingFull = new Map<string, boolean>()

  const queue = createProjectPassQueue(async (projectId): Promise<AnswerFieldRecomputePass> => {
    // Taken synchronously when the pass starts: a request made from here on
    // waits for the follow-up pass and adds to its scope.
    const full = pendingFull.get(projectId) ?? false
    pendingFull.delete(projectId)
    // Never on the caller's tick: the request path returns first.
    await yieldToEventLoop()
    const result = await backfillProjectAnswerMentionsInChunks(opts.db, projectId, { competitorFieldsOnly: !full })
    return { full, result }
  })

  return {
    request(projectId, scope) {
      pendingFull.set(projectId, (pendingFull.get(projectId) ?? false) || scope.full === true)
      return queue.request(projectId)
    },
    settled: () => queue.settled(),
  }
}
