import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackedQueryInput } from '@ainyc/canonry-contracts'
import { projects, queries, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderBatchPoller } from '../src/provider-batch-poller.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'
import {
  CLAUDE_BATCH_COST,
  FAKE_USAGE,
  FakeBatchTransport,
  GEMINI_MODEL,
  GEMINI_PRICING,
  GEMINI_STANDARD_COST,
  fakeAdapter,
  queueBatchRun,
  registryOf,
  seedPlannedProject,
  tempDb,
} from './provider-batch-harness.js'

// `run.completed` reports what a sweep used: the answers each provider
// returned, their tokens and estimated cost (summed as the run detail sums
// them), how many came through a provider batch, and each provider's median
// sync call latency.

const telemetry = vi.hoisted(() => ({ trackEvent: vi.fn() }))
vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry.js')>()),
  trackEvent: telemetry.trackEvent,
}))

const runCompleted = () => telemetry.trackEvent.mock.calls
  .filter(([event]) => event === 'run.completed')
  .map(([, props]) => props as Record<string, unknown>)

/** One call at a time, so each call's latency is exactly the clock step its adapter takes. */
const SERIAL = { maxConcurrency: 1, maxRequestsPerMinute: 6000, maxRequestsPerDay: 1000 }

/** Advance the (faked) clock by this call's latency while the provider "answers". */
function answerAfter(latencies: Record<string, number>) {
  return (input: TrackedQueryInput) => { vi.setSystemTime(Date.now() + latencies[input.query]!) }
}

beforeEach(() => {
  telemetry.trackEvent.mockReset()
  resetSharedProviderExecutionGates()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T12:00:00.000Z'))
  // Providers run one after another, so no provider's clock step lands inside another's call.
  vi.stubEnv('CANONRY_PROVIDER_FANOUT', '1')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

/** A project with no measurement plan, its two queries, and a queued manual sweep. */
function seedPlanless(db: DatabaseClient, providers: readonly string[]): { projectId: string; runId: string } {
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: `planless-${projectId.slice(0, 8)}`, displayName: 'Planless Co', canonicalDomain: 'example.com',
    country: 'US', language: 'en', providers: [...providers], createdAt: now, updatedAt: now,
  }).run()
  for (const query of ['query-1', 'query-2']) db.insert(queries).values({ id: crypto.randomUUID(), projectId, query, createdAt: now }).run()
  db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', trigger: 'manual', status: 'queued', createdAt: now }).run()
  return { projectId, runId }
}

describe('run.completed provider usage', () => {
  it('reports a batch sweep at finalization: batch and sync answers, priced cost, and sync latency only', async () => {
    const { db, projectId } = seedPlannedProject({ count: 2 })
    const runId = queueBatchRun(db, projectId)
    const transport = new FakeBatchTransport()
    const registry = registryOf([
      { adapter: fakeAdapter('claude', { transport }), config: { batch: { enabled: true } } },
      {
        adapter: fakeAdapter('gemini', { onSyncCall: answerAfter({ 'widget question 1': 1_000, 'widget question 2': 3_000 }) }),
        config: { pricing: GEMINI_PRICING, quotaPolicy: SERIAL },
      },
    ])
    const runner = new JobRunner(db, registry)

    await runner.executeRun(runId, projectId)
    expect(runCompleted()).toEqual([])
    transport.end(transport.only().id)
    await new ProviderBatchPoller({ db, registry, runner }).tick()

    const [props] = runCompleted()
    expect(props).toMatchObject({ status: 'completed', providerCount: 2, queryCount: 2 })
    expect(props!.providerCalls).toEqual({ claude: 2, gemini: 2 })
    expect(props!.usage).toEqual({
      inputTokens: 4 * FAKE_USAGE.input_tokens,
      outputTokens: 4 * FAKE_USAGE.output_tokens,
      // Claude at the default batch price, Gemini at its configured override.
      costMicros: 2 * CLAUDE_BATCH_COST + 2 * GEMINI_STANDARD_COST,
      batchCalls: 2,
    })
    // Claude answered only through its batch, whose turnaround is not a call latency.
    expect(props!.providerLatencyMs).toEqual({ gemini: 2_000 })
    expect(runCompleted()).toHaveLength(1)
  })

  it('counts stored answers only, and leaves cost out when any answer has no price', async () => {
    const db = tempDb()
    const { projectId, runId } = seedPlanless(db, ['gemini', 'openai'])
    const registry = registryOf([
      {
        adapter: fakeAdapter('gemini', { onSyncCall: answerAfter({ 'query-1': 1_000, 'query-2': 3_000 }) }),
        config: { model: GEMINI_MODEL, pricing: GEMINI_PRICING, quotaPolicy: SERIAL },
      },
      {
        adapter: fakeAdapter('openai', {
          onSyncCall: answerAfter({ 'query-1': 5_100, 'query-2': 200 }),
          syncFailure: input => input.query === 'query-2' ? '429 rate limit exceeded' : null,
        }),
        config: { quotaPolicy: SERIAL },
      },
    ])

    await new JobRunner(db, registry).executeRun(runId, projectId)

    const [props] = runCompleted()
    expect(props).toMatchObject({ status: 'partial', providerOutcomes: { gemini: 'ok', openai: 'RATE_LIMITED' } })
    expect(props!.providerCalls).toEqual({ gemini: 2, openai: 1 })
    // OpenAI has no price in the built-in table or config, so the run's cost is unknown.
    expect(props!.usage).toEqual({ inputTokens: 3 * FAKE_USAGE.input_tokens, outputTokens: 3 * FAKE_USAGE.output_tokens, batchCalls: 0 })
    // The call that failed returned no answer, so it has no latency.
    expect(props!.providerLatencyMs).toEqual({ gemini: 2_000, openai: 5_100 })
  })

  it('reports what a cancelled sweep stored before the cancel, in the same shape', async () => {
    const db = tempDb()
    const { projectId, runId } = seedPlanless(db, ['gemini'])
    const latencies = answerAfter({ 'query-1': 1_000, 'query-2': 3_000 })
    const registry = registryOf([{
      adapter: fakeAdapter('gemini', {
        onSyncCall: (input) => {
          latencies(input)
          // The operator cancels while the second call is out: its answer is never stored.
          if (input.query === 'query-2') db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, runId)).run()
        },
      }),
      config: { model: GEMINI_MODEL, pricing: GEMINI_PRICING, quotaPolicy: SERIAL },
    }])

    await new JobRunner(db, registry).executeRun(runId, projectId)

    const [props] = runCompleted()
    expect(props).toMatchObject({ status: 'cancelled' })
    expect(props!.providerCalls).toEqual({ gemini: 1 })
    expect(props!.usage).toEqual({ inputTokens: FAKE_USAGE.input_tokens, outputTokens: FAKE_USAGE.output_tokens, costMicros: GEMINI_STANDARD_COST, batchCalls: 0 })
    expect(props!.providerLatencyMs).toEqual({ gemini: 2_000 })
  })

  it('sends neither calls nor usage for a sweep that stored no answer', async () => {
    const db = tempDb()
    const { projectId, runId } = seedPlanless(db, ['gemini'])
    const registry = registryOf([{ adapter: fakeAdapter('gemini', { syncFailure: () => '401 invalid api key' }), config: { quotaPolicy: SERIAL } }])

    await new JobRunner(db, registry).executeRun(runId, projectId)

    const [props] = runCompleted()
    expect(props).toMatchObject({ status: 'failed', providerOutcomes: { gemini: 'PROVIDER_AUTH' } })
    expect(props).not.toHaveProperty('providerCalls')
    expect(props).not.toHaveProperty('usage')
    expect(props).not.toHaveProperty('providerLatencyMs')
  })
})
