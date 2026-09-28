import { and, eq, inArray, isNotNull, isNull, notExists, sql } from 'drizzle-orm'
import { providerBatches, runs, type DatabaseClient } from '@ainyc/canonry-db'
import {
  OUTSTANDING_PROVIDER_BATCH_STATUSES,
  ProviderBatchStatuses,
  RunStatuses,
  describeError,
  type ProviderBatchPollStatus,
  type ProviderBatchStatus,
} from '@ainyc/canonry-contracts'
import type { JobRunner } from './job-runner.js'
import type { ProviderRegistry, RegisteredProvider } from './provider-registry.js'
import { createLogger } from './logger.js'

const log = createLogger('ProviderBatchPoller')

/**
 * Drive every submitted provider batch to an end (#1201), in this process.
 *
 * The poller owns a batch from the moment the provider accepts it: it polls
 * it with a per-batch backoff, cancels one that outlives its deadline, hands
 * an ended one to `JobRunner.ingestProviderBatch`, and asks
 * `JobRunner.finalizeBatchRun` to finalize a run once nothing of it is
 * outstanding. Everything it decides is read from the database each pass, so
 * a restart resumes exactly where the last process stopped; only the backoff
 * schedule is in memory, and losing it just means one early poll.
 *
 * Like the site-liveness loop, it is an interval owned by the running process
 * rather than a schedule row, and it never goes through the HTTP API.
 */

/** First wait between polls of one batch, and the wait after its status changes. */
export const PROVIDER_BATCH_POLL_INITIAL_MS = 30_000
/** Longest wait between polls of one batch. */
export const PROVIDER_BATCH_POLL_MAX_MS = 10 * 60_000
/**
 * How long a batch cancelled at its deadline may take to end. Past this it is
 * given up on: marked `cancelled`, its slots left missing.
 */
export const PROVIDER_BATCH_CANCEL_GRACE_MS = 60 * 60_000
/** How often the loop looks for work; each batch is polled on its own backoff. */
export const PROVIDER_BATCH_TICK_MS = 15_000

/** The JobRunner methods the poller drives. */
export type ProviderBatchRunner = Pick<JobRunner, 'ingestProviderBatch' | 'finalizeBatchRun' | 'abandonProviderBatches' | 'abandonUnreadableProviderBatch'>

export interface ProviderBatchPollerDeps {
  db: DatabaseClient
  registry: ProviderRegistry
  runner: ProviderBatchRunner
  /** Epoch ms; injected by tests. */
  now?: () => number
}

type BatchRow = typeof providerBatches.$inferSelect

interface PollSchedule {
  nextPollAt: number
  delayMs: number
  /** The provider status last seen; a change resets the backoff. */
  lastStatus: ProviderBatchPollStatus | null
}

export class ProviderBatchPoller {
  private readonly schedule = new Map<string, PollSchedule>()
  private readonly now: () => number

  constructor(private readonly deps: ProviderBatchPollerDeps) {
    this.now = deps.now ?? Date.now
  }

  /** One pass: advance every outstanding batch that is due, then finalize what that settled. */
  async tick(): Promise<void> {
    const { db } = this.deps
    const rows = db.select().from(providerBatches)
      .where(inArray(providerBatches.status, [...OUTSTANDING_PROVIDER_BATCH_STATUSES]))
      .all()
    const live = new Set(rows.map(row => row.id))
    for (const id of this.schedule.keys()) if (!live.has(id)) this.schedule.delete(id)

    const settledRuns = new Map<string, string>()
    for (const row of rows) {
      try {
        if (await this.advance(row)) settledRuns.set(row.runId, row.projectId)
      } catch (err: unknown) {
        log.warn('batch.advance-failed', { batchId: row.id, runId: row.runId, providerName: row.provider, error: describeError(err) })
        this.reschedule(row.id, null)
      }
    }
    // Also every run handed off with nothing left outstanding: its last batch
    // settled while its sweep still held it, or before a restart.
    for (const run of this.finalizableRuns()) settledRuns.set(run.id, run.projectId)
    for (const [runId, projectId] of settledRuns) {
      try {
        this.deps.runner.finalizeBatchRun(runId, projectId)
      } catch (err: unknown) {
        log.warn('batch.finalize-failed', { runId, error: describeError(err) })
      }
    }
  }

  /**
   * Move one batch forward if it is due. Returns true when it stopped being
   * outstanding (ingested or cancelled), so its run may now finalize.
   */
  private async advance(row: BatchRow): Promise<boolean> {
    const runStatus = this.deps.db.select({ status: runs.status }).from(runs).where(eq(runs.id, row.runId)).get()?.status
    if (runStatus !== RunStatuses.running) {
      // Never ingest into a run that is over (cancelled, or failed by its
      // sweep): stop the provider's work instead.
      await this.deps.runner.abandonProviderBatches([row.id], 'Cancelled because its run is no longer running.')
      this.schedule.delete(row.id)
      return false
    }
    const entry = this.schedule.get(row.id)
    if (entry && this.now() < entry.nextPollAt) return false
    if (row.status === ProviderBatchStatuses.ended) return this.ingest(row)

    const registered = this.deps.registry.get(row.provider)
    let status: ProviderBatchPollStatus | null = null
    if (registered?.adapter.batch && row.providerBatchId) {
      try {
        const poll = await registered.adapter.batch.poll(row.providerBatchId, registered.config)
        status = poll.status
        if (poll.status === 'ended') {
          const endedAt = poll.endedAt ?? new Date(this.now()).toISOString()
          const ended = this.deps.db.update(providerBatches)
            .set({ status: ProviderBatchStatuses.ended, endedAt, resultsExpireAt: poll.resultsExpireAt ?? null, updatedAt: endedAt })
            .where(and(eq(providerBatches.id, row.id), eq(providerBatches.status, ProviderBatchStatuses.submitted)))
            .run()
            .changes === 1
          this.schedule.delete(row.id)
          return ended ? this.ingest({ ...row, status: ProviderBatchStatuses.ended, resultsExpireAt: poll.resultsExpireAt ?? null }) : false
        }
      } catch (err: unknown) {
        log.warn('batch.poll-failed', { batchId: row.id, runId: row.runId, providerName: row.provider, error: describeError(err) })
      }
    } else {
      // Nothing here can reach it (its provider was removed from config); the
      // deadline still bounds how long the run waits.
      log.warn('batch.poll-unavailable', { batchId: row.id, runId: row.runId, providerName: row.provider })
    }
    this.reschedule(row.id, status)
    return this.enforceDeadline(row, registered)
  }

  /**
   * A batch past its deadline is cancelled at the provider once, and kept
   * polling: a cancelled batch ends with whatever it had finished, which is
   * ingested like any other. One that has not ended an hour after the cancel
   * is given up on.
   */
  private async enforceDeadline(row: BatchRow, registered: RegisteredProvider | undefined): Promise<boolean> {
    const now = this.now()
    const at = new Date(now).toISOString()
    if (row.cancelRequestedAt === null) {
      if (now < Date.parse(row.deadlineAt)) return false
      const claimed = this.deps.db.update(providerBatches)
        .set({ cancelRequestedAt: at, updatedAt: at })
        .where(and(
          eq(providerBatches.id, row.id),
          eq(providerBatches.status, ProviderBatchStatuses.submitted),
          isNull(providerBatches.cancelRequestedAt),
        ))
        .run()
        .changes === 1
      if (!claimed) return false
      log.warn('batch.deadline-passed', { batchId: row.id, runId: row.runId, providerName: row.provider, deadlineAt: row.deadlineAt })
      if (registered?.adapter.batch && row.providerBatchId) {
        try {
          await registered.adapter.batch.cancel(row.providerBatchId, registered.config)
        } catch (err: unknown) {
          log.warn('batch.cancel-failed', { batchId: row.id, providerName: row.provider, error: describeError(err) })
        }
      }
      return false
    }
    if (now < Date.parse(row.cancelRequestedAt) + PROVIDER_BATCH_CANCEL_GRACE_MS) return false
    // Whether the provider billed any of it is unknown, so its reservation stays.
    const gaveUp = this.deps.db.update(providerBatches)
      .set({
        status: ProviderBatchStatuses.cancelled,
        error: `The provider batch did not end within an hour of being cancelled at its deadline; its ${row.requestCount} answer(s) were not recorded.`,
        updatedAt: at,
      })
      .where(and(eq(providerBatches.id, row.id), eq(providerBatches.status, ProviderBatchStatuses.submitted)))
      .run()
      .changes === 1
    this.schedule.delete(row.id)
    if (gaveUp) log.warn('batch.abandoned-after-deadline', { batchId: row.id, runId: row.runId, providerName: row.provider })
    return gaveUp
  }

  private async ingest(row: BatchRow): Promise<boolean> {
    try {
      const result = await this.deps.runner.ingestProviderBatch(row.id)
      return result.kind !== 'skipped'
    } catch (err: unknown) {
      const error = describeError(err)
      log.warn('batch.ingest-failed', { batchId: row.id, runId: row.runId, providerName: row.provider, error })
      // Results that can no longer be read (the provider deleted them), or
      // that still cannot be read an hour past the deadline, would hold the
      // run (and every later scheduled sweep) open for good. Stop waiting.
      const now = this.now()
      const unreadable = row.resultsExpireAt !== null && now >= Date.parse(row.resultsExpireAt)
      if (unreadable || now >= Date.parse(row.deadlineAt) + PROVIDER_BATCH_CANCEL_GRACE_MS) {
        // It keeps what an interrupted pass recorded, and gives back what that
        // pass saw go unbilled.
        const gaveUp = this.deps.runner.abandonUnreadableProviderBatch(
          row.id,
          `The provider batch ended but its results could not be read in time; its unread answer(s) were not recorded: ${error}`,
        )
        this.schedule.delete(row.id)
        return gaveUp
      }
      this.reschedule(row.id, null)
      return false
    }
  }

  /**
   * Wait `PROVIDER_BATCH_POLL_INITIAL_MS` after the first look and after any
   * status change, doubling otherwise (a failed poll counts as no change) up
   * to `PROVIDER_BATCH_POLL_MAX_MS`.
   */
  private reschedule(batchId: string, status: ProviderBatchPollStatus | null): void {
    const entry = this.schedule.get(batchId)
    const changed = !entry || (status !== null && status !== entry.lastStatus)
    const delayMs = changed ? PROVIDER_BATCH_POLL_INITIAL_MS : Math.min(entry.delayMs * 2, PROVIDER_BATCH_POLL_MAX_MS)
    this.schedule.set(batchId, { nextPollAt: this.now() + delayMs, delayMs, lastStatus: status ?? entry?.lastStatus ?? null })
  }

  /** Runs the sweep handed off whose batches have all settled. */
  private finalizableRuns(): Array<{ id: string; projectId: string }> {
    const holding: ProviderBatchStatus[] = [ProviderBatchStatuses.submitting, ...OUTSTANDING_PROVIDER_BATCH_STATUSES]
    return this.deps.db.select({ id: runs.id, projectId: runs.projectId }).from(runs)
      .where(and(
        eq(runs.status, RunStatuses.running),
        isNotNull(runs.pendingProviderErrors),
        notExists(this.deps.db.select({ one: sql`1` }).from(providerBatches)
          .where(and(eq(providerBatches.runId, runs.id), inArray(providerBatches.status, holding)))),
      ))
      .all()
  }
}

/**
 * Start the loop. Passes never overlap: one that overruns its interval makes
 * the next wait, since two passes could each ingest the same ended batch.
 */
export function startProviderBatchPoller(deps: ProviderBatchPollerDeps, intervalMs = PROVIDER_BATCH_TICK_MS): () => void {
  const poller = new ProviderBatchPoller(deps)
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void poller.tick()
      .catch((err: unknown) => log.warn('batch.pass-failed', { error: describeError(err) }))
      .finally(() => { running = false })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
