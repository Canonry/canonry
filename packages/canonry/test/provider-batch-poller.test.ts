import { and, eq, inArray } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRunError } from '@ainyc/canonry-contracts'
import { providerBatches, providerBatchRequests, querySnapshots, runFills, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import {
  PROVIDER_BATCH_CANCEL_GRACE_MS,
  PROVIDER_BATCH_POLL_INITIAL_MS,
  PROVIDER_BATCH_POLL_MAX_MS,
  PROVIDER_BATCH_TICK_MS,
  ProviderBatchPoller,
  startProviderBatchPoller,
} from '../src/provider-batch-poller.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'
import {
  FakeBatchTransport,
  GEMINI_PRICING,
  NOW,
  batchRows,
  fakeAdapter,
  queueBatchRun,
  quotaUsed,
  registryOf,
  requestRows,
  runRow,
  seedPlannedProject,
  snapshotRows,
  succeeded,
  tempDb,
} from './provider-batch-harness.js'

// The poller owns a batch from the moment the provider accepts it: it polls
// with a backoff, cancels a batch that outlives its deadline, ingests what the
// provider returned, and finalizes the run once nothing is outstanding. Every
// step is keyed off the database, so a restart resumes where the last process
// stopped and nothing is recorded, released or reported twice.

const telemetry = vi.hoisted(() => ({ trackEvent: vi.fn() }))
vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry.js')>()),
  trackEvent: telemetry.trackEvent,
}))

beforeEach(() => {
  telemetry.trackEvent.mockReset()
  resetSharedProviderExecutionGates()
})

const events = (name: string) => telemetry.trackEvent.mock.calls.filter(([event]) => event === name)
const statuses = () => events('run.completed').map(([, props]) => (props as { status: string }).status)
const HOUR = 60 * 60 * 1000

function setup(db: DatabaseClient, transport = new FakeBatchTransport(), options: { claudeSyncGate?: Promise<void> } = {}) {
  const registry = registryOf([
    { adapter: fakeAdapter('claude', { transport, ...(options.claudeSyncGate ? { syncGate: options.claudeSyncGate } : {}) }), config: { batch: { enabled: true } } },
    { adapter: fakeAdapter('gemini'), config: { pricing: GEMINI_PRICING } },
  ])
  const runner = new JobRunner(db, registry)
  const completed = vi.fn(async (_runId: string, _projectId: string) => {})
  runner.onRunCompleted = completed
  const clock = { now: Date.now() }
  const poller = new ProviderBatchPoller({ db, registry, runner, now: () => clock.now })
  return { registry, runner, transport, completed, clock, poller }
}

/** What the poller writes when a poll says the batch ended. */
function markEnded(db: DatabaseClient, batchId: string): void {
  db.update(providerBatches).set({ status: 'ended', endedAt: NOW }).where(eq(providerBatches.id, batchId)).run()
}

async function batchPendingRun(count = 2) {
  const { db, projectId } = seedPlannedProject({ count })
  const runId = queueBatchRun(db, projectId)
  const env = setup(db)
  await env.runner.executeRun(runId, projectId)
  const [batch] = batchRows(db, runId)
  expect(batch?.status).toBe('submitted')
  return { db, projectId, runId, batch: batch!, ...env }
}

describe('polling', () => {
  it('backs off from 30s, doubling to a 10 minute ceiling, and starts over when the status changes', async () => {
    const { transport, clock, poller, batch } = await batchPendingRun()
    const start = clock.now
    const pollsAt = async (offsets: number[]) => {
      const seen: number[] = []
      for (const offset of offsets) {
        clock.now = start + offset
        const before = transport.pollCalls.length
        await poller.tick()
        if (transport.pollCalls.length > before) seen.push(offset)
      }
      return seen
    }

    // First sight polls at once; then 30s, 60s, 120s, 240s, 480s, 600s, 600s.
    const schedule = [0, 30, 90, 210, 450, 930, 1530, 2130].map(s => s * 1000)
    const probes = [...schedule, ...schedule.slice(1).map(at => at - 1000)].sort((a, b) => a - b)
    expect(await pollsAt(probes)).toEqual(schedule)
    expect(PROVIDER_BATCH_POLL_INITIAL_MS).toBe(30_000)
    expect(PROVIDER_BATCH_POLL_MAX_MS).toBe(600_000)

    // A new status (the provider started cancelling) resets the wait to 30s.
    transport.require(batch.providerBatchId!).status = 'canceling'
    expect(await pollsAt([2730 * 1000, 2759 * 1000, 2760 * 1000])).toEqual([2730 * 1000, 2760 * 1000])
  })

  it('keeps polling through a failed poll, backing off as if nothing changed', async () => {
    const { db, runId, transport, clock, poller } = await batchPendingRun()
    transport.pollFailures = [new Error('[fake] 503 overloaded')]
    await poller.tick()
    expect(transport.pollCalls).toHaveLength(1)
    expect(batchRows(db, runId)[0]!.status).toBe('submitted')

    transport.end(transport.only().id)
    clock.now += 30_000
    await poller.tick()
    expect(transport.pollCalls).toHaveLength(2)
    expect(runRow(db, runId).status).toBe('completed')
  })
})

describe('deadlines', () => {
  it('cancels a batch past its deadline, keeps polling, and ingests what it answered before ending', async () => {
    const { db, projectId, runId, transport, clock, poller, batch, completed } = await batchPendingRun(3)
    clock.now = Date.parse(batch.deadlineAt) + 1
    await poller.tick()

    expect(transport.cancelCalls).toEqual([batch.providerBatchId])
    const cancelling = batchRows(db, runId)[0]!
    expect(cancelling).toMatchObject({ status: 'submitted', cancelRequestedAt: new Date(clock.now).toISOString() })
    expect(runRow(db, runId).status).toBe('running')

    // The cancel is asked once, however long the provider takes to wind down.
    clock.now += PROVIDER_BATCH_POLL_INITIAL_MS
    await poller.tick()
    expect(transport.cancelCalls).toHaveLength(1)

    // A cancelled Claude batch still returns (and bills) what it finished.
    const requests = requestRows(db, batch.id)
    transport.end(batch.providerBatchId!, (request) => request.customId === requests[0]!.id
      ? succeeded(request)
      : { customId: request.customId, type: 'canceled', error: '[fake] canceled before processing' })
    clock.now += 2 * PROVIDER_BATCH_POLL_INITIAL_MS
    await poller.tick()

    expect(batchRows(db, runId)[0]).toMatchObject({ status: 'ingested', ingestedCount: 3, recordedCount: 1, quotaReleased: 2 })
    expect(snapshotRows(db, runId).filter(row => row.provider === 'claude').map(row => row.measurementExecutionId)).toEqual(['exec-1'])
    const run = runRow(db, runId)
    expect(run.status).toBe('partial')
    expect(parseRunError(run.error)?.providers?.claude?.message)
      .toBe('2 of 3 batch answer(s) were not recorded. First: [fake] canceled before processing')
    expect(quotaUsed(db, projectId, 'claude')).toBe(1)
    expect(statuses()).toEqual(['partial'])
    expect(completed).toHaveBeenCalledTimes(1)
  })

  it('gives up on a batch that has not ended an hour after its cancellation, and finalizes without it', async () => {
    const { db, projectId, runId, transport, clock, poller, batch } = await batchPendingRun()
    clock.now = Date.parse(batch.deadlineAt) + 1
    await poller.tick()
    const cancelRequestedAt = Date.parse(batchRows(db, runId)[0]!.cancelRequestedAt!)

    clock.now = cancelRequestedAt + PROVIDER_BATCH_CANCEL_GRACE_MS - 1
    await poller.tick()
    expect(batchRows(db, runId)[0]!.status).toBe('submitted')

    clock.now = cancelRequestedAt + PROVIDER_BATCH_CANCEL_GRACE_MS + PROVIDER_BATCH_POLL_MAX_MS
    await poller.tick()
    expect(PROVIDER_BATCH_CANCEL_GRACE_MS).toBe(HOUR)
    expect(batchRows(db, runId)[0]).toMatchObject({
      status: 'cancelled',
      error: 'The provider batch did not end within an hour of being cancelled at its deadline; its 2 answer(s) were not recorded.',
      // Whether any of it was billed is unknown, so the reservation stays.
      quotaReleased: 0,
    })
    const run = runRow(db, runId)
    expect(run.status).toBe('partial')
    expect(parseRunError(run.error)?.providers?.claude?.message).toBe(batchRows(db, runId)[0]!.error)
    expect(quotaUsed(db, projectId, 'claude')).toBe(2)
    expect(statuses()).toEqual(['partial'])

    // It is never ingested, even if the provider finishes it later.
    transport.end(batch.providerBatchId!)
    clock.now += PROVIDER_BATCH_POLL_MAX_MS
    await poller.tick()
    expect(transport.resultsCalls).toEqual([])
  })
})

describe('results that cannot be read', () => {
  it('retries an ended batch until an hour past its deadline, then finalizes without it', async () => {
    const { db, projectId, runId, transport, clock, poller, batch } = await batchPendingRun()
    transport.end(batch.providerBatchId!)
    transport.resultsFailure = new Error('[fake] 500 results unavailable')
    await poller.tick()
    expect(batchRows(db, runId)[0]!.status).toBe('ended')

    clock.now = Date.parse(batch.deadlineAt) + PROVIDER_BATCH_CANCEL_GRACE_MS - 1
    await poller.tick()
    expect(batchRows(db, runId)[0]!.status).toBe('ended')
    expect(runRow(db, runId).status).toBe('running')

    // Failed reads back off like failed polls.
    clock.now = Date.parse(batch.deadlineAt) + PROVIDER_BATCH_CANCEL_GRACE_MS + PROVIDER_BATCH_POLL_MAX_MS
    await poller.tick()
    const given = batchRows(db, runId)[0]!
    expect(given).toMatchObject({
      status: 'cancelled',
      error: 'The provider batch ended but its results could not be read in time; its unread answer(s) were not recorded: [fake] 500 results unavailable',
      quotaReleased: 0,
    })
    expect(runRow(db, runId).status).toBe('partial')
    expect(parseRunError(runRow(db, runId).error)?.providers?.claude?.message).toBe(given.error)
    expect(quotaUsed(db, projectId, 'claude')).toBe(2)
    expect(statuses()).toEqual(['partial'])
  })

  it('keeps what a broken ingest recorded when it gives up, and releases only the lines it saw go unbilled', async () => {
    const { db, projectId, runId, transport, clock, poller, batch } = await batchPendingRun(3)
    // Lines stream last-submitted first: an answer, an expired line, then the
    // stream breaks before the third.
    transport.end(batch.providerBatchId!, (request, index) => index === 1
      ? { customId: request.customId, type: 'expired', error: '[fake] expired line' }
      : succeeded(request))
    transport.breakResultsAfter = 2
    await poller.tick()
    const outcomes = () => requestRows(db, batch.id).map(row => row.outcome ?? 'unread').sort()
    expect(outcomes()).toEqual(['expired', 'recorded', 'unread'])
    expect(batchRows(db, runId)[0]!.status).toBe('ended')

    transport.resultsFailure = new Error('[fake] 500 results unavailable')
    clock.now = Date.parse(batch.deadlineAt) + PROVIDER_BATCH_CANCEL_GRACE_MS + PROVIDER_BATCH_POLL_MAX_MS
    await poller.tick()

    expect(batchRows(db, runId)[0]).toMatchObject({
      status: 'cancelled',
      error: 'The provider batch ended but its results could not be read in time; its unread answer(s) were not recorded: [fake] 500 results unavailable',
      ingestedCount: 2,
      recordedCount: 1,
      quotaReserved: 3,
      // The expired line was not billed; the unread one may have been.
      quotaReleased: 1,
    })
    expect(outcomes()).toEqual(['expired', 'recorded', 'unread'])
    expect(quotaUsed(db, projectId, 'claude')).toBe(2)
    expect(snapshotRows(db, runId).filter(row => row.provider === 'claude')).toHaveLength(1)
    expect(runRow(db, runId).status).toBe('partial')
    expect(statuses()).toEqual(['partial'])

    // Given up once: another pass releases nothing more.
    await poller.tick()
    expect(batchRows(db, runId)[0]).toMatchObject({ status: 'cancelled', quotaReleased: 1 })
    expect(quotaUsed(db, projectId, 'claude')).toBe(2)
  })
})

describe('ingest is idempotent', () => {
  it('a second ingest of an ingested batch records, releases and reports nothing', async () => {
    const { db, projectId, runId, runner, transport, poller, batch } = await batchPendingRun(2)
    const requests = requestRows(db, batch.id)
    transport.end(batch.providerBatchId!, request => request.customId === requests[0]!.id
      ? succeeded(request)
      : { customId: request.customId, type: 'errored', error: '[fake] errored line' })
    // Ingest directly, as the poller would after seeing it end, but without
    // the finalize that follows.
    markEnded(db, batch.id)
    expect(await runner.ingestProviderBatch(batch.id)).toEqual({ kind: 'ingested', recorded: 1, notRecorded: 1, released: 1 })
    const before = { snapshots: snapshotRows(db, runId).length, quota: quotaUsed(db, projectId, 'claude') }
    expect(before).toEqual({ snapshots: 3, quota: 1 })

    expect(await runner.ingestProviderBatch(batch.id)).toEqual({ kind: 'skipped' })
    // Even a batch forced back to `ended` (a crash between the snapshot insert
    // and its ledger write) finds its rows and adds nothing.
    db.update(providerBatches).set({ status: 'ended' }).where(eq(providerBatches.id, batch.id)).run()
    db.update(providerBatchRequests).set({ outcome: null, error: null }).where(eq(providerBatchRequests.batchId, batch.id)).run()
    expect(await runner.ingestProviderBatch(batch.id)).toEqual({ kind: 'ingested', recorded: 1, notRecorded: 1, released: 0 })

    expect(snapshotRows(db, runId)).toHaveLength(before.snapshots)
    expect(quotaUsed(db, projectId, 'claude')).toBe(before.quota)
    expect(batchRows(db, runId)[0]).toMatchObject({ status: 'ingested', ingestedCount: 2, recordedCount: 1, quotaReleased: 1 })
    expect(requestRows(db, batch.id).map(row => row.outcome)).toEqual(['recorded', 'errored'])

    await poller.tick()
    expect(runRow(db, runId).status).toBe('partial')
    expect(statuses()).toEqual(['partial'])
  })

  it('resumes a results stream that broke midway without duplicating a line', async () => {
    const { db, runId, transport, clock, poller, batch } = await batchPendingRun(3)
    transport.end(batch.providerBatchId!)
    transport.breakResultsAfter = 1
    await poller.tick()

    expect(batchRows(db, runId)[0]!.status).toBe('ended')
    expect(requestRows(db, batch.id).filter(row => row.outcome === 'recorded')).toHaveLength(1)
    expect(runRow(db, runId).status).toBe('running')

    clock.now += PROVIDER_BATCH_POLL_INITIAL_MS
    await poller.tick()
    expect(batchRows(db, runId)[0]).toMatchObject({ status: 'ingested', ingestedCount: 3, recordedCount: 3 })
    expect(snapshotRows(db, runId).filter(row => row.provider === 'claude')).toHaveLength(3)
    expect(runRow(db, runId).status).toBe('completed')
    expect(statuses()).toEqual(['completed'])
  })

  it('maps lines by custom_id whatever their order, and marks a line the provider never returned as errored', async () => {
    const { db, projectId, runId, transport, poller, batch } = await batchPendingRun(3)
    const requests = requestRows(db, batch.id)
    transport.end(batch.providerBatchId!, request => request.customId === requests[2]!.id ? null : succeeded(request))
    await poller.tick()

    expect(requestRows(db, batch.id).map(row => [row.executionId, row.outcome, row.error])).toEqual([
      ['exec-1', 'recorded', null],
      ['exec-2', 'recorded', null],
      ['exec-3', 'errored', 'The provider returned no result for this request.'],
    ])
    expect(batchRows(db, runId)[0]).toMatchObject({ recordedCount: 2, ingestedCount: 3, quotaReleased: 1 })
    expect(quotaUsed(db, projectId, 'claude')).toBe(2)
    expect(runRow(db, runId).status).toBe('partial')
  })
})

describe('a restart', () => {
  it('recovers every state, resumes polling, and finalizes each run exactly once', async () => {
    const db = tempDb()
    // A: batch outstanding, and the process died while gemini was still answering.
    const a = seedPlannedProject({ db, count: 2 })
    const aRun = queueBatchRun(db, a.projectId)
    const first = setup(db)
    await first.runner.executeRun(aRun, a.projectId)
    const aGemini = snapshotRows(db, aRun).find(row => row.provider === 'gemini' && row.measurementExecutionId === 'exec-2')!
    db.delete(querySnapshots).where(eq(querySnapshots.id, aGemini.id)).run()
    db.update(runs).set({ pendingProviderErrors: null }).where(eq(runs.id, aRun)).run()

    // B: the process died between writing the batch row and hearing back from submit.
    const b = seedPlannedProject({ db, count: 1 })
    const bRun = queueBatchRun(db, b.projectId)
    const hung = setup(db)
    hung.transport.submitOutcomes = [() => new Promise<void>(() => {})]
    void hung.runner.executeRun(bRun, b.projectId)
    await vi.waitFor(() => {
      expect(batchRows(db, bRun)[0]?.status).toBe('submitting')
      expect(snapshotRows(db, bRun).map(row => row.provider)).toEqual(['gemini'])
    })

    // C: the batch was ingested, then the process died before finalizing.
    const c = seedPlannedProject({ db, count: 1 })
    const cRun = queueBatchRun(db, c.projectId)
    const third = setup(db)
    await third.runner.executeRun(cRun, c.projectId)
    third.transport.end(third.transport.only().id)
    markEnded(db, batchRows(db, cRun)[0]!.id)
    expect(await third.runner.ingestProviderBatch(batchRows(db, cRun)[0]!.id)).toMatchObject({ kind: 'ingested', recorded: 1 })
    expect(runRow(db, cRun)).toMatchObject({ status: 'running', pendingProviderErrors: {} })

    // G: the poller saw the batch end, then the process died before ingesting it.
    const g = seedPlannedProject({ db, count: 1 })
    const gRun = queueBatchRun(db, g.projectId)
    const seventh = setup(db, first.transport)
    await seventh.runner.executeRun(gRun, g.projectId)
    first.transport.end(batchRows(db, gRun)[0]!.providerBatchId!)
    markEnded(db, batchRows(db, gRun)[0]!.id)

    // H: the provider refused the batch and the process died during the sync fallback.
    const h = seedPlannedProject({ db, count: 1 })
    const hRun = queueBatchRun(db, h.projectId)
    const eighth = setup(db, new FakeBatchTransport(), { claudeSyncGate: new Promise<void>(() => {}) })
    eighth.transport.submitOutcomes = ['definite']
    void eighth.runner.executeRun(hRun, h.projectId)
    await vi.waitFor(() => {
      expect(batchRows(db, hRun)[0]?.status).toBe('failed')
      expect(snapshotRows(db, hRun).map(row => row.provider)).toEqual(['gemini'])
    })

    // D and E: ordinary sweeps caught running and queued; F: a fill caught running.
    const d = seedPlannedProject({ db, count: 1 })
    db.insert(runs).values({ id: 'run-d', projectId: d.projectId, kind: 'answer-visibility', status: 'running', trigger: 'manual', startedAt: NOW, createdAt: NOW }).run()
    const e = seedPlannedProject({ db, count: 1 })
    db.insert(runs).values({ id: 'run-e', projectId: e.projectId, kind: 'answer-visibility', status: 'queued', trigger: 'manual', createdAt: NOW }).run()
    db.insert(runs).values({ id: 'run-f', projectId: e.projectId, kind: 'answer-visibility', status: 'partial', trigger: 'manual', startedAt: NOW, finishedAt: NOW, createdAt: NOW }).run()
    db.insert(runFills).values({ id: 'fill-f', projectId: e.projectId, runId: 'run-f', status: 'running', createdAt: NOW }).run()

    telemetry.trackEvent.mockReset()
    // The restart: a new runner and poller over the same database, talking to
    // the provider that still holds A's batch.
    const transport = first.transport
    const restarted = setup(db, transport)
    restarted.runner.recoverStaleRuns()

    // A stays running on its batch; its interrupted gemini slot is named.
    expect(runRow(db, aRun)).toMatchObject({ status: 'running', pendingProviderErrors: { gemini: 'Server restarted while run was in progress' } })
    expect(batchRows(db, aRun)[0]!.status).toBe('submitted')
    // B's batch may or may not exist at the provider: unknown, never resubmitted.
    expect(batchRows(db, bRun)[0]).toMatchObject({
      status: 'unknown',
      error: 'Server restarted while the batch was being submitted; it may or may not exist at the provider, so it was not resubmitted.',
    })
    expect(runRow(db, bRun)).toMatchObject({ status: 'running', pendingProviderErrors: {} })
    expect(runRow(db, cRun)).toMatchObject({ status: 'running', pendingProviderErrors: {} })
    expect(runRow(db, gRun)).toMatchObject({ status: 'running', pendingProviderErrors: {} })
    // H's refused batch fell back to sync, so its missing claude slot is the sweep's gap.
    expect(runRow(db, hRun)).toMatchObject({ status: 'running', pendingProviderErrors: { claude: 'Server restarted while run was in progress' } })
    // Everything else fails exactly as before.
    expect(runRow(db, 'run-d')).toMatchObject({ status: 'failed', error: 'Server restarted while run was in progress' })
    expect(runRow(db, 'run-e')).toMatchObject({ status: 'failed', error: 'Server restarted while run was in progress' })
    expect(db.select().from(runFills).where(eq(runFills.id, 'fill-f')).get()?.status).toBe('failed')
    expect(statuses()).toEqual([])

    // First pass: B, C and H have nothing outstanding and finalize from the
    // database; G's ended batch is ingested, then G finalizes too.
    await restarted.poller.tick()
    expect(runRow(db, bRun).status).toBe('partial')
    expect(parseRunError(runRow(db, bRun).error)?.providers?.claude?.message).toBe(batchRows(db, bRun)[0]!.error)
    expect(runRow(db, cRun)).toMatchObject({ status: 'completed', pendingProviderErrors: null })
    expect(runRow(db, gRun)).toMatchObject({ status: 'completed', pendingProviderErrors: null })
    expect(batchRows(db, gRun)[0]).toMatchObject({ status: 'ingested', recordedCount: 1 })
    expect(runRow(db, hRun).status).toBe('partial')
    expect(parseRunError(runRow(db, hRun).error)?.providers).toEqual({ claude: expect.objectContaining({ message: 'Server restarted while run was in progress' }) })
    expect(runRow(db, aRun).status).toBe('running')

    // A's batch ends; the next pass ingests and finalizes it.
    transport.end(batchRows(db, aRun)[0]!.providerBatchId!)
    restarted.clock.now += PROVIDER_BATCH_POLL_INITIAL_MS
    await restarted.poller.tick()
    const finalA = runRow(db, aRun)
    expect(finalA.status).toBe('partial')
    expect(parseRunError(finalA.error)?.providers).toEqual({ gemini: expect.objectContaining({ message: 'Server restarted while run was in progress' }) })
    expect(snapshotRows(db, aRun).filter(row => row.provider === 'claude')).toHaveLength(2)

    await restarted.poller.tick()
    const finalized = events('run.completed').map(([, props]) => (props as { status: string }).status).sort()
    expect(finalized).toEqual(['completed', 'completed', 'partial', 'partial', 'partial'])
    expect(restarted.completed.mock.calls.map(([runId]) => runId).sort()).toEqual([aRun, bRun, cRun, gRun, hRun].sort())
  })
})

describe('batches of a run that is no longer running', () => {
  it('cancels them at the provider instead of polling or ingesting', async () => {
    const { db, runId, transport, poller, batch } = await batchPendingRun()
    // A cancellation this process did not see (another path wrote it).
    db.update(runs).set({ status: 'cancelled', finishedAt: new Date().toISOString() }).where(eq(runs.id, runId)).run()
    transport.end(batch.providerBatchId!)
    await poller.tick()

    expect(transport.cancelCalls).toEqual([batch.providerBatchId])
    expect(transport.resultsCalls).toEqual([])
    expect(batchRows(db, runId)[0]).toMatchObject({ status: 'cancelled' })
    expect(db.select().from(providerBatches).where(and(
      eq(providerBatches.runId, runId),
      inArray(providerBatches.status, ['submitted', 'ended']),
    )).all()).toEqual([])
    expect(statuses()).toEqual([])
  })
})

describe('the loop', () => {
  it('passes on its interval, unref\'d, and stops when asked', async () => {
    const { db, runId, transport, registry, runner } = await batchPendingRun()
    vi.useFakeTimers()
    try {
      const stop = startProviderBatchPoller({ db, registry, runner }, 1_000)
      await vi.advanceTimersByTimeAsync(999)
      expect(transport.pollCalls).toEqual([])
      transport.end(transport.only().id)
      await vi.advanceTimersByTimeAsync(1)
      expect(transport.pollCalls).toHaveLength(1)
      expect(runRow(db, runId).status).toBe('completed')

      stop()
      await vi.advanceTimersByTimeAsync(PROVIDER_BATCH_TICK_MS * 10)
      expect(transport.pollCalls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
