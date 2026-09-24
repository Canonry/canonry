import { and, asc, eq, inArray } from 'drizzle-orm'
import { providerBatches, type DatabaseClient } from '@ainyc/canonry-db'
import {
  OUTSTANDING_PROVIDER_BATCH_STATUSES,
  type ProviderBatchSummaryDto,
} from '@ainyc/canonry-contracts'

/**
 * Reads over `provider_batches` shared by the run routes, fill admission, and
 * the scheduler. Writes belong to the job runner and the batch poller.
 */

type ProviderBatchRow = typeof providerBatches.$inferSelect

export function formatProviderBatchSummary(row: ProviderBatchRow): ProviderBatchSummaryDto {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    status: row.status,
    requestCount: row.requestCount,
    ingestedCount: row.ingestedCount,
    recordedCount: row.recordedCount,
    submittedAt: row.submittedAt,
    endedAt: row.endedAt,
    deadlineAt: row.deadlineAt,
    error: row.error,
  }
}

/** A run's provider batches, oldest first. */
export function readRunProviderBatches(db: DatabaseClient, runId: string): ProviderBatchSummaryDto[] {
  return db.select().from(providerBatches)
    .where(eq(providerBatches.runId, runId))
    .orderBy(asc(providerBatches.createdAt), asc(providerBatches.id))
    .all()
    .map(formatProviderBatchSummary)
}

/** Whether the run ever wrote a provider batch row, whatever became of it. */
export function runHadProviderBatch(db: DatabaseClient, runId: string): boolean {
  return db.select({ id: providerBatches.id }).from(providerBatches)
    .where(eq(providerBatches.runId, runId)).limit(1).get() !== undefined
}

/**
 * Whether the run is waiting on a provider: one of its batches is still
 * `submitted` or `ended` (not yet ingested). Such a run stays `running` until
 * the poller finalizes it or its deadline passes.
 */
export function hasOutstandingProviderBatch(db: DatabaseClient, runId: string): boolean {
  return db.select({ id: providerBatches.id }).from(providerBatches)
    .where(and(eq(providerBatches.runId, runId), inArray(providerBatches.status, [...OUTSTANDING_PROVIDER_BATCH_STATUSES])))
    .limit(1).get() !== undefined
}

/**
 * The project's runs that are waiting on a provider (see
 * `hasOutstandingProviderBatch`): each holds a batch the provider may still be
 * processing and billing.
 */
export function readProjectRunsWithOutstandingProviderBatch(db: DatabaseClient, projectId: string): string[] {
  return db.selectDistinct({ runId: providerBatches.runId }).from(providerBatches)
    .where(and(eq(providerBatches.projectId, projectId), inArray(providerBatches.status, [...OUTSTANDING_PROVIDER_BATCH_STATUSES])))
    .orderBy(asc(providerBatches.runId))
    .all()
    .map(row => row.runId)
}
