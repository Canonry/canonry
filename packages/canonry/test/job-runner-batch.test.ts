import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRunError, type ProviderAdapter, type ProviderBatchResultLine } from '@ainyc/canonry-contracts'
import { queueRunFill } from '@ainyc/canonry-api-routes'
import { claudeAdapter } from '@ainyc/canonry-provider-claude'
import { runFills, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderBatchPoller } from '../src/provider-batch-poller.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'
import {
  CLAUDE_BATCH_COST,
  CLAUDE_MODEL,
  CLAUDE_STANDARD_COST,
  FakeBatchTransport,
  GEMINI_MODEL,
  GEMINI_PRICING,
  GEMINI_STANDARD_COST,
  NORTH,
  batchRows,
  deferred,
  dispatchOf,
  fakeAdapter,
  queueBatchRun,
  quotaUsed,
  registryOf,
  requestRows,
  runRow,
  runsCounted,
  seedPlannedProject,
  snapshotRows,
  succeeded,
  usageOf,
} from './provider-batch-harness.js'

// A provider in batch mode submits its slots of a plan sweep to the
// provider's batch API instead of calling it once per slot (#1201). The sweep
// hands the run to the poller, which ingests each batch through the same
// recordSlot as a sync answer and finalizes the run once, from the database.

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
const HOUR = 60 * 60 * 1000

interface Harness {
  runner: JobRunner
  transport: FakeBatchTransport
  poller: ProviderBatchPoller
  completed: ReturnType<typeof vi.fn>
  syncCalls: Array<{ provider: string; query: string; model: string | undefined }>
  clock: { now: number }
}

function harness(db: DatabaseClient, options: {
  transport?: FakeBatchTransport
  claudeBatch?: { maxRequestsPerBatch?: number; deadlineHours?: number }
  geminiGate?: Promise<void>
  claude?: ProviderAdapter
} = {}): Harness {
  const transport = options.transport ?? new FakeBatchTransport()
  const syncCalls: Harness['syncCalls'] = []
  const record = (provider: string) => (input: { query: string }, config: { model?: string }) => {
    syncCalls.push({ provider, query: input.query, model: config.model })
  }
  const registry = registryOf([
    {
      adapter: options.claude ?? fakeAdapter('claude', { transport, onSyncCall: record('claude') }),
      config: { batch: { enabled: true, ...options.claudeBatch } },
    },
    {
      adapter: fakeAdapter('gemini', { onSyncCall: record('gemini'), ...(options.geminiGate ? { syncGate: options.geminiGate } : {}) }),
      config: { pricing: GEMINI_PRICING },
    },
  ])
  const runner = new JobRunner(db, registry)
  const completed = vi.fn(async (_runId: string, _projectId: string) => {})
  runner.onRunCompleted = completed
  const clock = { now: Date.now() }
  const poller = new ProviderBatchPoller({ db, registry, runner, now: () => clock.now })
  return { runner, transport, poller, completed, syncCalls, clock }
}

describe('a mixed run: one sync provider, one batch provider', () => {
  it.each([
    { schema: 2 as const, label: 'an Advanced (v2) portfolio' },
    { schema: 1 as const, label: 'a Simple (v1) plan' },
  ])('$label records sync answers now, batch answers at ingest, and finalizes exactly once', async ({ schema }) => {
    const { db, projectId } = seedPlannedProject({ count: 2, schema })
    const runId = queueBatchRun(db, projectId)
    const { runner, transport, poller, completed, syncCalls } = harness(db)

    await runner.executeRun(runId, projectId)

    // The sync half finished and handed the run to the poller: still running,
    // nothing reported, and the (empty) sync errors are persisted as the marker.
    expect(runRow(db, runId)).toMatchObject({ status: 'running', pendingProviderErrors: {}, finishedAt: null, error: null })
    expect(events('run.completed')).toHaveLength(0)
    expect(completed).not.toHaveBeenCalled()
    expect(syncCalls.map(call => call.provider)).toEqual(['gemini', 'gemini'])

    const [batch] = batchRows(db, runId)
    expect(batch).toMatchObject({
      projectId, provider: 'claude', model: CLAUDE_MODEL, status: 'submitted', providerBatchId: 'fakebatch_1',
      requestCount: 2, ingestedCount: 0, recordedCount: 0, error: null,
      quotaScope: `${projectId}:claude`, quotaReserved: 2, quotaReleased: 0, cancelRequestedAt: null, fillId: null,
    })
    expect(Date.parse(batch!.deadlineAt) - Date.parse(batch!.submittedAt!)).toBe(24 * HOUR)

    // One ledger row per slot, keyed by the custom_id that went on the wire.
    const requests = requestRows(db, batch!.id)
    const ledger = requests
      .map(({ id: _id, batchId: _batch, queryId, ...rest }) => ({ ...rest, hasQueryId: queryId !== null }))
      .sort((left, right) => left.queryText.localeCompare(right.queryText))
    expect(ledger).toEqual([1, 2].map(n => ({
      // A v1 plan compiles its own node keys; a v2 revision names them.
      executionId: schema === 2 ? `exec-${n}` : expect.any(String),
      queryText: `widget question ${n}`,
      requestedModel: CLAUDE_MODEL,
      requestedContext: NORTH,
      outcome: null,
      error: null,
      hasQueryId: true,
    })))
    for (const request of requests) expect(request.id).toMatch(/^[0-9a-f]{32}$/)
    const [submitted] = transport.submitCalls
    expect(submitted!.map(line => line.customId).sort()).toEqual(requests.map(row => row.id).sort())
    for (const line of submitted!) {
      const request = requests.find(row => row.id === line.customId)!
      expect(line.request).toEqual({ endpoint: '/v1/fake', body: { model: CLAUDE_MODEL, query: request.queryText, location: NORTH.label } })
    }

    // Only the sync answers exist yet.
    expect(snapshotRows(db, runId).map(dispatchOf)).toEqual([
      expect.objectContaining({ provider: 'gemini', dispatchMode: 'sync', providerBatchId: null, stopReason: 'end_turn', usage: usageOf('standard', GEMINI_STANDARD_COST, 'override') }),
      expect.objectContaining({ provider: 'gemini', dispatchMode: 'sync', providerBatchId: null, stopReason: 'end_turn', usage: usageOf('standard', GEMINI_STANDARD_COST, 'override') }),
    ])
    // Both reservations stand: gemini sent 2 calls, claude 2 batch lines.
    expect(quotaUsed(db, projectId, 'claude')).toBe(2)
    expect(quotaUsed(db, projectId, 'gemini')).toBe(2)

    transport.end(batch!.providerBatchId!)
    await poller.tick()

    const run = runRow(db, runId)
    expect(run).toMatchObject({ status: 'completed', error: null, pendingProviderErrors: null })
    expect(run.finishedAt).not.toBeNull()
    expect(snapshotRows(db, runId).map(row => ({ ...dispatchOf(row), model: row.model }))).toEqual([
      { provider: 'claude', executionId: 'exec-1', dispatchMode: 'batch', providerBatchId: batch!.id, stopReason: 'end_turn', usage: usageOf('batch', CLAUDE_BATCH_COST, 'default'), model: CLAUDE_MODEL },
      { provider: 'claude', executionId: 'exec-2', dispatchMode: 'batch', providerBatchId: batch!.id, stopReason: 'end_turn', usage: usageOf('batch', CLAUDE_BATCH_COST, 'default'), model: CLAUDE_MODEL },
      { provider: 'gemini', executionId: 'exec-1', dispatchMode: 'sync', providerBatchId: null, stopReason: 'end_turn', usage: usageOf('standard', GEMINI_STANDARD_COST, 'override'), model: GEMINI_MODEL },
      { provider: 'gemini', executionId: 'exec-2', dispatchMode: 'sync', providerBatchId: null, stopReason: 'end_turn', usage: usageOf('standard', GEMINI_STANDARD_COST, 'override'), model: GEMINI_MODEL },
    ].map(row => schema === 1 ? { ...row, executionId: expect.any(String) } : row))
    expect(batchRows(db, runId)[0]).toMatchObject({ status: 'ingested', ingestedCount: 2, recordedCount: 2, quotaReleased: 0 })
    expect(requestRows(db, batch!.id).map(row => row.outcome)).toEqual(['recorded', 'recorded'])

    expect(events('run.completed').map(([, props]) => (props as { status: string }).status)).toEqual(['completed'])
    expect(events('activation.completed')).toHaveLength(1)
    expect(completed).toHaveBeenCalledTimes(1)
    expect(completed).toHaveBeenCalledWith(runId, projectId)
    expect(runsCounted(db, projectId)).toBe(1)
    expect(quotaUsed(db, projectId, 'claude')).toBe(2)
    expect(quotaUsed(db, projectId, 'gemini')).toBe(2)

    // Nothing is left to do: another pass changes nothing and reports nothing.
    await poller.tick()
    expect(events('run.completed')).toHaveLength(1)
    expect(completed).toHaveBeenCalledTimes(1)
    expect(snapshotRows(db, runId)).toHaveLength(4)
  })

  it('finalizes once when the batch ends before the sync provider does (the sync half hands off last)', async () => {
    const { db, projectId } = seedPlannedProject({ count: 2 })
    const runId = queueBatchRun(db, projectId)
    const gate = deferred()
    const { runner, transport, poller, completed } = harness(db, { geminiGate: gate.promise })

    const execution = runner.executeRun(runId, projectId)
    await vi.waitFor(() => expect(batchRows(db, runId)[0]?.status).toBe('submitted'))
    transport.end(transport.only().id)
    await poller.tick()

    // Ingested, but the sweep is still answering gemini: the poller must not
    // finalize a run whose sync half has not handed off.
    expect(batchRows(db, runId)[0]).toMatchObject({ status: 'ingested', recordedCount: 2 })
    expect(runRow(db, runId)).toMatchObject({ status: 'running', pendingProviderErrors: null })
    expect(events('run.completed')).toHaveLength(0)
    // Each guard holds on its own: the database marker (another runner, as
    // after a restart, cannot see the live sweep) ...
    expect(new JobRunner(db, registryOf([])).finalizeBatchRun(runId, projectId)).toBe(false)
    // ... and the live sweep (even with the marker forced on).
    db.update(runs).set({ pendingProviderErrors: {} }).where(eq(runs.id, runId)).run()
    expect(runner.finalizeBatchRun(runId, projectId)).toBe(false)
    db.update(runs).set({ pendingProviderErrors: null }).where(eq(runs.id, runId)).run()
    expect(runRow(db, runId).status).toBe('running')

    gate.resolve()
    await execution

    expect(runRow(db, runId)).toMatchObject({ status: 'completed', pendingProviderErrors: null })
    expect(snapshotRows(db, runId)).toHaveLength(4)
    expect(events('run.completed').map(([, props]) => (props as { status: string }).status)).toEqual(['completed'])
    expect(completed).toHaveBeenCalledTimes(1)
    await poller.tick()
    expect(events('run.completed')).toHaveLength(1)
    expect(completed).toHaveBeenCalledTimes(1)
  })

  it('keeps sync errors across the handoff and folds them into the final error', async () => {
    const { db, projectId } = seedPlannedProject({ count: 2 })
    const runId = queueBatchRun(db, projectId)
    const transport = new FakeBatchTransport()
    const registry = registryOf([
      { adapter: fakeAdapter('claude', { transport }), config: { batch: { enabled: true } } },
      { adapter: fakeAdapter('gemini', { syncFailure: input => input.query === 'widget question 2' ? '429 rate limit exceeded' : null }), config: { pricing: GEMINI_PRICING } },
    ])
    const runner = new JobRunner(db, registry)
    await runner.executeRun(runId, projectId)

    expect(runRow(db, runId).pendingProviderErrors).toEqual({ gemini: '[fake-gemini] 429 rate limit exceeded' })
    transport.end(transport.only().id)
    await new ProviderBatchPoller({ db, registry, runner }).tick()

    const run = runRow(db, runId)
    expect(run).toMatchObject({ status: 'partial', pendingProviderErrors: null })
    expect(parseRunError(run.error)?.providers).toEqual({
      gemini: expect.objectContaining({ message: '[fake-gemini] 429 rate limit exceeded' }),
    })
    expect(events('run.completed').map(([, props]) => (props as { status: string }).status)).toEqual(['partial'])
  })
})

describe('batch lines that produce no answer', () => {
  it('leaves errored and expired slots missing, names them, and releases their quota exactly', async () => {
    const { db, projectId } = seedPlannedProject({ count: 3 })
    const runId = queueBatchRun(db, projectId)
    const { runner, transport, poller } = harness(db)
    await runner.executeRun(runId, projectId)
    const [batch] = batchRows(db, runId)
    const requests = requestRows(db, batch!.id)
    const outcomeFor = new Map<string, ProviderBatchResultLine['type']>([
      [requests[0]!.id, 'succeeded'],
      [requests[1]!.id, 'errored'],
      [requests[2]!.id, 'expired'],
    ])
    transport.end(batch!.providerBatchId!, (request) => {
      const type = outcomeFor.get(request.customId)!
      if (type === 'succeeded') return succeeded(request)
      return { customId: request.customId, type, error: `[fake] ${type} line` } as ProviderBatchResultLine
    })
    expect(quotaUsed(db, projectId, 'claude')).toBe(3)

    await poller.tick()

    const run = runRow(db, runId)
    expect(run.status).toBe('partial')
    expect(parseRunError(run.error)?.providers?.claude?.message)
      .toBe('2 of 3 batch answer(s) were not recorded. First: [fake] errored line')
    expect(parseRunError(run.error)?.providers?.gemini).toBeUndefined()
    expect(snapshotRows(db, runId).filter(row => row.provider === 'claude').map(row => row.measurementExecutionId)).toEqual(['exec-1'])
    expect(requestRows(db, batch!.id).map(row => [row.executionId, row.outcome, row.error])).toEqual([
      ['exec-1', 'recorded', null],
      ['exec-2', 'errored', '[fake] errored line'],
      ['exec-3', 'expired', '[fake] expired line'],
    ])
    // Two lines were never answered, so never billed: exactly those two come back.
    expect(batchRows(db, runId)[0]).toMatchObject({ status: 'ingested', ingestedCount: 3, recordedCount: 1, quotaReserved: 3, quotaReleased: 2 })
    expect(quotaUsed(db, projectId, 'claude')).toBe(1)
    expect(quotaUsed(db, projectId, 'gemini')).toBe(3)
    expect(events('run.completed').map(([, props]) => (props as { status: string }).status)).toEqual(['partial'])
  })

  it('reads Claude batch lines with the real Claude parser: a failed web search leaves its slot missing', async () => {
    const { db, projectId } = seedPlannedProject({ count: 2 })
    const runId = queueBatchRun(db, projectId)
    const transport = new FakeBatchTransport()
    const { runner, poller } = harness(db, { transport, claude: { ...claudeAdapter, batch: transport.capability } })
    await runner.executeRun(runId, projectId)

    // The lines are the real Claude request bodies, built by the adapter.
    const submitted = transport.only().requests
    const requests = requestRows(db, batchRows(db, runId)[0]!.id)
    for (const line of submitted) {
      const request = requests.find(row => row.id === line.customId)!
      expect(line.request).toEqual(claudeAdapter.buildTrackedQueryRequest!(
        { query: request.queryText, canonicalDomains: ['example.com'], competitorDomains: ['rivalrywidgets.com'], location: NORTH },
        { provider: 'claude', apiKey: 'test-key', model: CLAUDE_MODEL, quotaPolicy: { maxConcurrency: 4, maxRequestsPerMinute: 6000, maxRequestsPerDay: 1000 } },
      ))
    }

    const exec1 = requests.find(row => row.executionId === 'exec-1')!.id
    transport.end(transport.only().id, (request) => ({
      customId: request.customId,
      type: 'succeeded',
      body: request.customId === exec1 ? claudeMessage('Planned Co leads on widgets.') : claudeMessage('', { searchError: 'max_uses_exceeded' }),
    }))
    await poller.tick()

    const claudeRows = snapshotRows(db, runId).filter(row => row.provider === 'claude')
    expect(claudeRows.map(row => ({ ...dispatchOf(row), answer: row.answerText, citation: row.citationState, mentioned: row.answerMentioned }))).toEqual([{
      provider: 'claude',
      executionId: 'exec-1',
      dispatchMode: 'batch',
      providerBatchId: batchRows(db, runId)[0]!.id,
      stopReason: 'end_turn',
      // 1,800 input × $3 + 420 output × $15 = 11,700 µ$, halved in batch, plus
      // one search at the full $10 / 1,000.
      usage: { inputTokens: 1800, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 420, searchCount: 1, pricingTier: 'batch', estimatedCostMicros: 5_850 + 10_000, priceSource: 'default' },
      answer: 'Planned Co leads on widgets.',
      citation: 'cited',
      mentioned: true,
    }])
    expect(requestRows(db, batchRows(db, runId)[0]!.id).map(row => [row.executionId, row.outcome])).toEqual([
      ['exec-1', 'recorded'],
      ['exec-2', 'parse_failed'],
    ])
    const run = runRow(db, runId)
    expect(run.status).toBe('partial')
    expect(parseRunError(run.error)?.providers?.claude?.message).toMatch(/^1 of 2 batch answer\(s\) were not recorded\. First: \[provider-claude\] .*max_uses_exceeded/)
    // An answer that came back was billed, readable or not: nothing is released.
    expect(batchRows(db, runId)[0]).toMatchObject({ quotaReleased: 0 })
    expect(quotaUsed(db, projectId, 'claude')).toBe(2)
  })
})

/** A Claude Messages API answer as a batch line carries it. */
function claudeMessage(text: string, options: { searchError?: string } = {}): Record<string, unknown> {
  const url = 'https://example.com/property-001/widgets'
  return {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6-20260801',
    content: options.searchError
      ? [
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'widgets' } },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'web_search_tool_result_error', error_code: options.searchError } },
        ]
      : [
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'widgets' } },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url, title: 'Source' }] },
          { type: 'text', text, citations: [{ type: 'web_search_result_location', url, title: 'Source', cited_text: text }] },
        ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1800,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 420,
      server_tool_use: { web_search_requests: 1 },
      service_tier: 'batch',
    },
  }
}

describe('submission failures', () => {
  it('falls back to sync, in the same run, for a batch the provider definitely refused', async () => {
    const { db, projectId } = seedPlannedProject({ count: 2 })
    const runId = queueBatchRun(db, projectId)
    const { runner, transport, completed, syncCalls } = harness(db)
    transport.submitOutcomes = ['definite']

    await runner.executeRun(runId, projectId)

    const [batch] = batchRows(db, runId)
    expect(batch).toMatchObject({
      status: 'failed', providerBatchId: null, requestCount: 2,
      error: '[fake] batch submit failed: 400 invalid_request_error',
      // Handed back to the sweep, which sent the same slots itself.
      quotaReserved: 2, quotaReleased: 2,
    })
    expect(syncCalls.filter(call => call.provider === 'claude').map(call => [call.query, call.model]).sort()).toEqual([
      ['widget question 1', CLAUDE_MODEL],
      ['widget question 2', CLAUDE_MODEL],
    ])
    expect(snapshotRows(db, runId).filter(row => row.provider === 'claude').map(dispatchOf)).toEqual([
      { provider: 'claude', executionId: 'exec-1', dispatchMode: 'sync', providerBatchId: null, stopReason: 'end_turn', usage: usageOf('standard', CLAUDE_STANDARD_COST, 'default') },
      { provider: 'claude', executionId: 'exec-2', dispatchMode: 'sync', providerBatchId: null, stopReason: 'end_turn', usage: usageOf('standard', CLAUDE_STANDARD_COST, 'default') },
    ])
    // Nothing is outstanding, so the sweep finalizes the run itself.
    expect(runRow(db, runId)).toMatchObject({ status: 'completed', error: null, pendingProviderErrors: null })
    expect(events('run.completed').map(([, props]) => (props as { status: string }).status)).toEqual(['completed'])
    expect(completed).toHaveBeenCalledTimes(1)
    expect(quotaUsed(db, projectId, 'claude')).toBe(2)
  })

  it('records an ambiguous submit as unknown, never resubmits it, and leaves its slots missing', async () => {
    const { db, projectId } = seedPlannedProject({ count: 2 })
    const runId = queueBatchRun(db, projectId)
    const { runner, transport, poller, completed, syncCalls } = harness(db)
    transport.submitOutcomes = ['ambiguous']

    await runner.executeRun(runId, projectId)

    const unknownError = 'The provider batch of 2 answer(s) may or may not have been created, so it was not resubmitted '
      + 'and its answers were not recorded: [fake] batch submit failed: Request timed out'
    expect(batchRows(db, runId)[0]).toMatchObject({ status: 'unknown', providerBatchId: null, error: unknownError, quotaReleased: 0 })
    expect(transport.submitCalls).toHaveLength(1)
    expect(syncCalls.filter(call => call.provider === 'claude')).toEqual([])
    const run = runRow(db, runId)
    expect(run).toMatchObject({ status: 'partial', pendingProviderErrors: null })
    expect(parseRunError(run.error)?.providers?.claude?.message).toBe(unknownError)
    expect(snapshotRows(db, runId).map(row => row.provider)).toEqual(['gemini', 'gemini'])
    // The provider may have accepted (and will bill) it: the reservation stays.
    expect(quotaUsed(db, projectId, 'claude')).toBe(2)
    expect(events('run.completed').map(([, props]) => (props as { status: string }).status)).toEqual(['partial'])
    expect(completed).toHaveBeenCalledTimes(1)

    await poller.tick()
    expect(transport.submitCalls).toHaveLength(1)
    expect(transport.pollCalls).toEqual([])
    expect(events('run.completed')).toHaveLength(1)
  })

  it('cancels its batches and fails the run when the sweep throws after submitting', async () => {
    const { db, projectId } = seedPlannedProject({ count: 2 })
    const runId = queueBatchRun(db, projectId)
    const { runner, transport, poller, completed } = harness(db)
    const handOff = vi.spyOn(runner as unknown as { handOffBatchRun: (...args: unknown[]) => unknown }, 'handOffBatchRun')
      .mockImplementation(() => { throw new Error('disk I/O error') })

    await runner.executeRun(runId, projectId)
    expect(handOff).toHaveBeenCalledTimes(1)

    const run = runRow(db, runId)
    expect(run).toMatchObject({ status: 'failed', error: 'disk I/O error' })
    // No failed run is left with a batch the poller would still ingest.
    const [batch] = batchRows(db, runId)
    expect(batch).toMatchObject({ status: 'cancelled', error: 'Cancelled because the run failed: disk I/O error' })
    expect(transport.cancelCalls).toEqual([batch!.providerBatchId])
    expect(events('run.completed').map(([, props]) => (props as { status: string }).status)).toEqual(['failed'])
    expect(completed).toHaveBeenCalledTimes(1)

    transport.end(batch!.providerBatchId!)
    await poller.tick()
    expect(transport.resultsCalls).toEqual([])
    expect(snapshotRows(db, runId).map(row => row.provider)).toEqual(['gemini', 'gemini'])
    expect(events('run.completed')).toHaveLength(1)
  })
})

describe('splitting a provider\'s slots into batches', () => {
  it('groups by model and chunks by the configured request cap', async () => {
    const { db, projectId } = seedPlannedProject({
      count: 5,
      claudeModels: [CLAUDE_MODEL, 'claude-haiku-4-5', CLAUDE_MODEL, CLAUDE_MODEL, 'claude-haiku-4-5'],
    })
    const queued = queueBatchRun(db, projectId)
    const { runner, transport } = harness(db, { claudeBatch: { maxRequestsPerBatch: 2 } })

    await runner.executeRun(queued, projectId)

    const batches = batchRows(db, queued)
    expect(batches.map(batch => [batch.model, batch.requestCount, batch.status]).sort()).toEqual([
      ['claude-haiku-4-5', 2, 'submitted'],
      [CLAUDE_MODEL, 1, 'submitted'],
      [CLAUDE_MODEL, 2, 'submitted'],
    ])
    for (const batch of batches) {
      const lines = transport.require(batch.providerBatchId!).requests
      expect(lines.map(line => (line.request.body as { model: string }).model)).toEqual(lines.map(() => batch.model))
      expect(lines.map(line => line.customId).sort()).toEqual(requestRows(db, batch.id).map(row => row.id).sort())
    }
    expect(quotaUsed(db, projectId, 'claude')).toBe(5)
  })

  it('chunks by the provider\'s byte limit, and sends a line too large for any batch sync', async () => {
    const { db, projectId } = seedPlannedProject({ count: 3 })
    const queued = queueBatchRun(db, projectId)
    // Room for exactly one line of this size per batch.
    const oneLine = Buffer.byteLength(JSON.stringify({
      custom_id: '0'.repeat(32),
      params: { model: CLAUDE_MODEL, query: 'widget question 1', location: NORTH.label },
    }))
    const transport = new FakeBatchTransport({ maxBytesPerBatch: oneLine + 16 + 5 })
    const { runner } = harness(db, { transport })

    await runner.executeRun(queued, projectId)
    expect(batchRows(db, queued).map(batch => batch.requestCount)).toEqual([1, 1, 1])

    const tiny = seedPlannedProject({ db, count: 1 })
    const tinyRun = queueBatchRun(db, tiny.projectId)
    const tinyTransport = new FakeBatchTransport({ maxBytesPerBatch: 64 })
    const tinyHarness = harness(db, { transport: tinyTransport })
    await tinyHarness.runner.executeRun(tinyRun, tiny.projectId)
    expect(batchRows(db, tinyRun)).toEqual([])
    expect(tinyTransport.submitCalls).toEqual([])
    expect(snapshotRows(db, tinyRun).map(row => [row.provider, row.dispatchMode])).toEqual([['claude', 'sync'], ['gemini', 'sync']])
    expect(runRow(db, tinyRun).status).toBe('completed')
  })

  it('uses the configured deadline instead of the provider default', async () => {
    const { db, projectId } = seedPlannedProject({ count: 1 })
    const runId = queueBatchRun(db, projectId)
    const { runner } = harness(db, { claudeBatch: { deadlineHours: 6 } })
    await runner.executeRun(runId, projectId)
    const [batch] = batchRows(db, runId)
    expect(Date.parse(batch!.deadlineAt) - Date.parse(batch!.submittedAt!)).toBe(6 * HOUR)
  })
})

describe('cancelling a run with a batch', () => {
  it('cancels at the provider, never ingests, and reports the cancellation once', async () => {
    const { db, projectId } = seedPlannedProject({ count: 2 })
    const runId = queueBatchRun(db, projectId)
    const { runner, transport, poller, completed } = harness(db)
    await runner.executeRun(runId, projectId)
    const [batch] = batchRows(db, runId)

    cancelLikeTheRoute(db, runId)
    await runner.cancelRunBatches(runId, projectId)

    expect(transport.cancelCalls).toEqual([batch!.providerBatchId])
    expect(batchRows(db, runId)[0]).toMatchObject({ status: 'cancelled', error: 'Cancelled with its run.' })
    expect(runRow(db, runId)).toMatchObject({ status: 'cancelled', pendingProviderErrors: null })
    expect(events('run.completed').map(([, props]) => (props as { status: string }).status)).toEqual(['cancelled'])
    expect(completed).toHaveBeenCalledTimes(1)

    // The provider may still finish it; nothing reads it into the cancelled run.
    transport.end(batch!.providerBatchId!)
    await poller.tick()
    await runner.cancelRunBatches(runId, projectId)
    expect(transport.resultsCalls).toEqual([])
    expect(snapshotRows(db, runId).map(row => row.provider)).toEqual(['gemini', 'gemini'])
    expect(events('run.completed')).toHaveLength(1)
    expect(completed).toHaveBeenCalledTimes(1)
  })

  it('leaves the report to the sweep when the sweep is still running', async () => {
    const { db, projectId } = seedPlannedProject({ count: 2 })
    const runId = queueBatchRun(db, projectId)
    const gate = deferred()
    const { runner, transport, completed } = harness(db, { geminiGate: gate.promise })
    const execution = runner.executeRun(runId, projectId)
    await vi.waitFor(() => expect(batchRows(db, runId)[0]?.status).toBe('submitted'))

    cancelLikeTheRoute(db, runId)
    await runner.cancelRunBatches(runId, projectId)
    expect(transport.cancelCalls).toEqual([transport.only().id])
    expect(events('run.completed')).toHaveLength(0)

    gate.resolve()
    await execution
    expect(runRow(db, runId).status).toBe('cancelled')
    expect(batchRows(db, runId)[0]!.status).toBe('cancelled')
    expect(events('run.completed').map(([, props]) => (props as { status: string }).status)).toEqual(['cancelled'])
    expect(completed).toHaveBeenCalledTimes(1)
  })
})

describe('filling a batch run', () => {
  it('counts the fill window from when the run finalized, and fills the batch gap sync', async () => {
    const { db, projectId } = seedPlannedProject({ count: 2 })
    const runId = queueBatchRun(db, projectId)
    const { runner, transport, poller } = harness(db)
    await runner.executeRun(runId, projectId)
    transport.end(transport.only().id, (request, index) => index === 0
      ? succeeded(request)
      : { customId: request.customId, type: 'expired', error: '[fake] expired line' })
    await poller.tick()
    const finalized = runRow(db, runId)
    expect(finalized.status).toBe('partial')

    // The batch took most of a day: started 30 hours ago, finalized just now.
    const finishedAt = Date.parse(finalized.finishedAt!)
    const startedAt = new Date(finishedAt - 30 * HOUR).toISOString()
    db.update(runs).set({ createdAt: startedAt, startedAt }).where(eq(runs.id, runId)).run()

    expect(queueRunFill(db, runId, { now: new Date(finishedAt + 25 * HOUR) })).toMatchObject({ kind: 'refused', code: 'too_old' })
    const admitted = queueRunFill(db, runId, { now: new Date(finishedAt + 23 * HOUR) })
    if (admitted.kind !== 'queued') throw new Error(`fill not admitted: ${admitted.kind}`)
    await runner.executeRunFill(admitted.fill.id)

    expect(db.select().from(runFills).where(eq(runFills.id, admitted.fill.id)).get()).toMatchObject({ status: 'completed', filled: 1 })
    expect(runRow(db, runId).status).toBe('completed')
    const claudeRows = snapshotRows(db, runId).filter(row => row.provider === 'claude')
    expect(claudeRows.map(row => [row.dispatchMode, row.usage?.pricingTier])).toEqual([['batch', 'batch'], ['sync', 'standard']])
  })
})

/** What `POST /runs/:id/cancel` writes before it calls `onRunCancelled`. */
function cancelLikeTheRoute(db: DatabaseClient, runId: string): void {
  db.update(runs).set({ status: 'cancelled', finishedAt: new Date().toISOString(), error: '{"message":"Cancelled by user"}' })
    .where(eq(runs.id, runId)).run()
}
