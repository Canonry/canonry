import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { count, eq, isNotNull, and, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { ProviderBatchStatuses } from '@ainyc/canonry-contracts'
import { providerBatches, providerBatchRequests, queries, querySnapshots } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { addLogListener } from '../src/logger.js'
import * as citedCapture from '../src/cited-url-capture.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'
import {
  batchRows, deferred, FakeBatchTransport, fakeAdapter, queueBatchRun,
  registryOf, requestRows, seedPlannedProject, snapshotRows, succeeded,
} from './provider-batch-harness.js'

beforeEach(() => {
  resetSharedProviderExecutionGates()
})

async function readyBatch(rowCount: number, schema: 1 | 2 = 2) {
  const { db, projectId } = seedPlannedProject({ count: rowCount, schema, providers: ['claude'] })
  const transport = new FakeBatchTransport()
  const adapter = fakeAdapter('claude', { transport })
  const runner = new JobRunner(db, registryOf([{ adapter, config: { batch: { enabled: true } } }]))
  const runId = queueBatchRun(db, projectId)
  await runner.executeRun(runId, projectId)
  const batch = batchRows(db, runId)[0]!
  transport.end(batch.providerBatchId!)
  db.update(providerBatches).set({ status: ProviderBatchStatuses.ended }).where(eq(providerBatches.id, batch.id)).run()
  const snapshots = () => db.select({ value: count() }).from(querySnapshots).where(eq(querySnapshots.runId, runId)).get()!.value
  const outcomes = () => db.select({ value: count() }).from(providerBatchRequests)
    .where(and(eq(providerBatchRequests.batchId, batch.id), isNotNull(providerBatchRequests.outcome))).get()!.value
  return { db, projectId, transport, adapter, runner, runId, batch, snapshots, outcomes }
}

describe('bounded provider batch ingestion', () => {
  it.each([1, 2] as const)('commits at most 32 results together and reports after commit for schema %i', async (schema) => {
    const { db, transport, runner, runId, batch, snapshots, outcomes } = await readyBatch(65, schema)
    const observations: Array<{ snapshots: number; outcomes: number; inTransaction: boolean }> = []
    const preparationTransactions: boolean[] = []
    transport.onResultLine = () => preparationTransactions.push(db.$client.inTransaction)
    onTestFinished(addLogListener(entry => {
      if (entry.module === 'JobRunner' && entry.runId === runId && entry.action === 'query.citation') {
        observations.push({ snapshots: snapshots(), outcomes: outcomes(), inTransaction: db.$client.inTransaction })
      }
    }))
    const transactions = vi.spyOn(db, 'transaction')
    onTestFinished(() => transactions.mockRestore())
    const firstYield = yieldToEventLoop().then(() => ({ snapshots: snapshots(), outcomes: outcomes() }))

    expect(await runner.ingestProviderBatch(batch.id)).toEqual({ kind: 'ingested', recorded: 65, notRecorded: 0, released: 0 })

    expect(await firstYield).toEqual({ snapshots: 32, outcomes: 32 })
    expect(observations).toEqual([
      ...Array.from({ length: 32 }, () => ({ snapshots: 32, outcomes: 32, inTransaction: false })),
      ...Array.from({ length: 32 }, () => ({ snapshots: 64, outcomes: 64, inTransaction: false })),
      { snapshots: 65, outcomes: 65, inTransaction: false },
    ])
    expect(preparationTransactions).toEqual(Array.from({ length: 65 }, () => false))
    // Three bounded write transactions plus the final quota/status transaction.
    expect(transactions).toHaveBeenCalledTimes(4)
  })

  it('rolls back a failed chunk with its ledger and replays only missing results', async () => {
    const { db, transport, runner, runId, batch, snapshots, outcomes } = await readyBatch(65)
    const rejectedId = transport.only().lines[40]!.customId
    db.run(sql.raw(`CREATE TRIGGER refuse_ingest_receipt BEFORE UPDATE OF outcome ON provider_batch_requests
      WHEN NEW.id = '${rejectedId}' BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END`))
    const reported: string[] = []
    onTestFinished(addLogListener(entry => {
      if (entry.module === 'JobRunner' && entry.runId === runId && entry.action === 'query.citation') reported.push(String(entry.executionId))
    }))

    await expect(runner.ingestProviderBatch(batch.id)).rejects.toThrow('receipt write failed')
    expect({ snapshots: snapshots(), outcomes: outcomes(), reports: reported.length }).toEqual({ snapshots: 32, outcomes: 32, reports: 32 })
    expect(batchRows(db, runId)[0]!.status).toBe(ProviderBatchStatuses.ended)
    db.run(sql.raw('DROP TRIGGER refuse_ingest_receipt'))

    expect(await runner.ingestProviderBatch(batch.id)).toEqual({ kind: 'ingested', recorded: 65, notRecorded: 0, released: 0 })
    expect({ snapshots: snapshots(), outcomes: outcomes(), reports: reported.length }).toEqual({ snapshots: 65, outcomes: 65, reports: 65 })
    expect(new Set(reported).size).toBe(65)
  })

  it.each([320, 600])('flushes and yields early for %i KiB answers, including a single oversized result', async (answerKiB) => {
    const { transport, runner, batch, snapshots, outcomes } = await readyBatch(3)
    transport.end(batch.providerBatchId!, request => succeeded(request, { answer: 'x'.repeat(answerKiB * 1024) }))
    const observed: number[] = []
    onTestFinished(addLogListener(entry => {
      if (entry.module === 'JobRunner' && entry.runId === batch.runId && entry.action === 'query.citation') observed.push(snapshots())
    }))
    const firstYield = yieldToEventLoop().then(() => ({ snapshots: snapshots(), outcomes: outcomes() }))

    expect(await runner.ingestProviderBatch(batch.id)).toEqual({ kind: 'ingested', recorded: 3, notRecorded: 0, released: 0 })

    // The answer appears in both answer_text and serialized raw_response.
    // Two 320 KiB answers exceed the chunk budget; one 600 KiB answer exceeds it alone.
    expect(observed).toEqual([1, 2, 3])
    expect(await firstYield).toEqual({ snapshots: 1, outcomes: 1 })
  })

  it('keeps malformed outcomes isolated, deduplicates buffered lines and preserves a deleted query', async () => {
    const { db, transport, runner, runId, batch } = await readyBatch(6)
    transport.end(batch.providerBatchId!, (request, index) => index === 0
      ? succeeded(request, { fail: 'invalid answer' })
      : index === 1
        ? { customId: request.customId, type: 'expired', error: 'provider deadline' }
        : succeeded(request))
    const firstLine = transport.only().lines[0]!
    const deleted = requestRows(db, batch.id).find(row => row.id === firstLine.customId)!
    transport.only().lines.splice(1, 0, firstLine)
    transport.onResultLine = (index) => {
      if (index === 1) db.delete(queries).where(eq(queries.id, deleted.queryId!)).run()
    }

    expect(await runner.ingestProviderBatch(batch.id)).toEqual({ kind: 'ingested', recorded: 4, notRecorded: 2, released: 1 })
    expect(requestRows(db, batch.id).map(row => row.outcome).sort()).toEqual(['expired', 'parse_failed', 'recorded', 'recorded', 'recorded', 'recorded'])
    const rows = snapshotRows(db, runId)
    expect(rows).toHaveLength(4)
    expect(rows.find(row => row.measurementExecutionId === deleted.executionId)).toMatchObject({ queryId: null, queryText: deleted.queryText })
  })

  it('prepares asynchronous citation evidence without a transaction and stops a cancelled batch before preparing another line', async () => {
    const { db, transport, adapter, runner, runId, batch, snapshots, outcomes } = await readyBatch(3)
    const entered = deferred()
    const release = deferred()
    const originalCapture = citedCapture.captureCitedUrls
    const preparationTransactions: boolean[] = []
    const capture = vi.spyOn(citedCapture, 'captureCitedUrls').mockImplementation(async (...args) => {
      preparationTransactions.push(db.$client.inTransaction)
      entered.resolve()
      await release.promise
      preparationTransactions.push(db.$client.inTransaction)
      return originalCapture(...args)
    })
    const parse = vi.spyOn(adapter, 'parseTrackedQueryResponse')
    onTestFinished(() => { capture.mockRestore(); parse.mockRestore() })
    const ingest = runner.ingestProviderBatch(batch.id)
    await entered.promise
    await runner.abandonProviderBatches([batch.id], 'Operator cancelled this batch.')
    release.resolve()

    expect(await ingest).toEqual({ kind: 'cancelled' })
    expect(preparationTransactions).toEqual([false, false])
    expect(parse).toHaveBeenCalledTimes(1)
    expect({ snapshots: snapshots(), outcomes: outcomes() }).toEqual({ snapshots: 0, outcomes: 0 })
    expect(snapshotRows(db, runId)).toEqual([])
    expect(transport.cancelCalls).toEqual([batch.providerBatchId])
  })
})
