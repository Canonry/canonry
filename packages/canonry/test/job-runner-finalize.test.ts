import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  parseRunError,
  type NormalizedQueryResult,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderHealthcheckResult,
  type RawQueryResult,
  type TrackedQueryInput,
} from '@ainyc/canonry-contracts'
import { createClient, migrate, projects, queries, querySnapshots, runs, usageCounters, type DatabaseClient } from '@ainyc/canonry-db'
import { JobRunner, type RunFinalization } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'
import { getCurrentUsageDay, reserveDailyQueryQuota } from '../src/usage-quota.js'

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

function seed(status: 'queued' | 'running' | 'cancelled', queryCount = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-finalize-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'finalize', displayName: 'Finalize Co', canonicalDomain: 'example.com',
    country: 'US', language: 'en', providers: [], createdAt: now, updatedAt: now,
  }).run()
  for (let index = 0; index < queryCount; index++) {
    db.insert(queries).values({ id: crypto.randomUUID(), projectId, query: `query-${index + 1}`, createdAt: now }).run()
  }
  db.insert(runs).values({
    id: runId, projectId, kind: 'answer-visibility', trigger: 'manual', status, createdAt: now,
    ...(status === 'queued' ? {} : { startedAt: now }),
    ...(status === 'cancelled' ? { finishedAt: now, error: 'Cancelled by user' } : {}),
  }).run()
  return { db, projectId, runId }
}

const runRow = (db: DatabaseClient, runId: string) => db.select().from(runs).where(eq(runs.id, runId)).get()!

const quotaUsed = (db: DatabaseClient, projectId: string) => db.select({ count: usageCounters.count }).from(usageCounters)
  .where(and(eq(usageCounters.scope, `${projectId}:gemini`), eq(usageCounters.metric, 'queries'))).get()?.count ?? 0

const runsCounted = (db: DatabaseClient, projectId: string) => db.select({ count: usageCounters.count }).from(usageCounters)
  .where(and(eq(usageCounters.scope, projectId), eq(usageCounters.metric, 'runs'))).get()?.count ?? 0

/** A reservation of `reserved` gemini queries, `dispatched` of which were sent. */
function reservation(db: DatabaseClient, projectId: string, reserved: number, dispatched: number): NonNullable<RunFinalization['quota']> {
  const scope = `${projectId}:gemini`
  const period = getCurrentUsageDay()
  expect(reserveDailyQueryQuota(db, { scope, period, count: reserved, limit: 1000 }).reserved).toBe(true)
  return {
    dispatched: new Map([['gemini', dispatched]]),
    reservations: new Map([['gemini', { scope, period, reserved }]]),
  }
}

function finalization(runId: string, projectId: string, overrides: Partial<RunFinalization> = {}): RunFinalization {
  return {
    runId,
    projectId,
    kind: 'answer-visibility',
    inserted: 1,
    providerErrors: new Map(),
    planShortfall: 0,
    executionContext: { providerCount: 1, providers: ['gemini'], queryCount: 1, trigger: 'manual', canonicalDomain: 'example.com' },
    startTime: Date.now() - 1000,
    phases: { setup_ms: 10, provider_call_ms: 900, total_ms: 1000 },
    ...overrides,
  }
}

function runnerWithSpies(db: DatabaseClient, registry = new ProviderRegistry()) {
  const onFirstActivation = vi.fn()
  const runner = new JobRunner(db, registry, { onFirstActivation })
  const onRunCompleted = vi.fn(async () => {})
  runner.onRunCompleted = onRunCompleted
  return { runner, onRunCompleted, onFirstActivation }
}

describe('finalizeRun', () => {
  it('completes a run once: a second attempt changes nothing and fires nothing', () => {
    const { db, projectId, runId } = seed('running')
    const { runner, onRunCompleted, onFirstActivation } = runnerWithSpies(db)
    const input = finalization(runId, projectId, { quota: reservation(db, projectId, 3, 1) })

    expect(runner.finalizeRun(input)).toBe(true)
    const first = runRow(db, runId)
    expect(first).toMatchObject({ status: 'completed', error: null })
    expect(first.finishedAt).not.toBeNull()
    // Two of the three reserved queries were never sent, so they go back.
    expect(quotaUsed(db, projectId)).toBe(1)

    expect(runner.finalizeRun(input)).toBe(false)
    expect(runRow(db, runId)).toEqual(first)
    expect(quotaUsed(db, projectId)).toBe(1)

    expect(onRunCompleted).toHaveBeenCalledTimes(1)
    expect(onRunCompleted).toHaveBeenCalledWith(runId, projectId)
    expect(events('run.completed')).toHaveLength(1)
    expect(events('run.completed')[0]![1]).toMatchObject({ status: 'completed', providerCount: 1, queryCount: 1, trigger: 'manual', durationMs: 1000 })
    expect(events('activation.completed')).toHaveLength(1)
    expect(onFirstActivation).toHaveBeenCalledTimes(1)
    expect(runsCounted(db, projectId)).toBe(1)
  })

  it('a losing attempt gives back only its own unused quota', () => {
    const { db, projectId, runId } = seed('running')
    const { runner, onRunCompleted } = runnerWithSpies(db)
    // Two executions of the same run, each holding its own reservation: the
    // winner sent both of its queries, the loser one of its three.
    const winner = reservation(db, projectId, 2, 2)
    const loser = reservation(db, projectId, 3, 1)
    expect(quotaUsed(db, projectId)).toBe(5)

    expect(runner.finalizeRun(finalization(runId, projectId, { quota: winner }))).toBe(true)
    expect(quotaUsed(db, projectId)).toBe(5)
    expect(runner.finalizeRun(finalization(runId, projectId, { quota: loser }))).toBe(false)
    // Exactly what was sent stays counted: nothing leaks, nothing is released twice.
    expect(quotaUsed(db, projectId)).toBe(3)

    expect(onRunCompleted).toHaveBeenCalledTimes(1)
    expect(events('run.completed')).toHaveLength(1)
    expect(runsCounted(db, projectId)).toBe(1)
  })

  it('never overwrites a run that was cancelled, and reports nothing for it', () => {
    const { db, projectId, runId } = seed('cancelled')
    const { runner, onRunCompleted, onFirstActivation } = runnerWithSpies(db)
    const before = runRow(db, runId)

    expect(runner.finalizeRun(finalization(runId, projectId, {
      providerErrors: new Map([['gemini', '429 rate limited']]),
      quota: reservation(db, projectId, 2, 1),
    }))).toBe(false)

    expect(runRow(db, runId)).toEqual(before)
    expect(onRunCompleted).not.toHaveBeenCalled()
    expect(onFirstActivation).not.toHaveBeenCalled()
    expect(telemetry.trackEvent).not.toHaveBeenCalled()
    expect(runsCounted(db, projectId)).toBe(0)
    expect(quotaUsed(db, projectId)).toBe(1)
  })

  it('derives the terminal status from what the run recorded', () => {
    const statusFor = (overrides: Partial<RunFinalization>) => {
      const { db, projectId, runId } = seed('running')
      const { runner } = runnerWithSpies(db)
      expect(runner.finalizeRun(finalization(runId, projectId, overrides))).toBe(true)
      const row = runRow(db, runId)
      return { status: row.status, error: parseRunError(row.error) ?? null }
    }

    expect(statusFor({})).toEqual({ status: 'completed', error: null })
    expect(statusFor({ providerErrors: new Map([['gemini', 'boom']]) }))
      .toMatchObject({ status: 'partial', error: { providers: { gemini: { message: 'boom' } } } })
    // A shortfall alone is not a success, even with no provider error to name.
    expect(statusFor({ planShortfall: 2 })).toMatchObject({ status: 'partial' })
    expect(statusFor({ inserted: 0, planShortfall: 2 })).toMatchObject({ status: 'failed' })
    expect(statusFor({ inserted: 0, providerErrors: new Map([['gemini', 'boom']]) }))
      .toMatchObject({ status: 'failed', error: { providers: { gemini: { message: 'boom' } } } })
  })
})

describe('executeRun completion', () => {
  function adapter(): ProviderAdapter {
    return {
      name: 'gemini',
      validateConfig(_config: ProviderConfig): ProviderHealthcheckResult { return { ok: true, provider: 'gemini', message: 'ok' } },
      async healthcheck(_config: ProviderConfig): Promise<ProviderHealthcheckResult> { return { ok: true, provider: 'gemini', message: 'ok' } },
      async executeTrackedQuery(_input: TrackedQueryInput, _config: ProviderConfig): Promise<RawQueryResult> {
        return { provider: 'gemini', rawResponse: {}, model: 'stub-model', groundingSources: [], searchQueries: [] }
      },
      normalizeResult(_raw: RawQueryResult): NormalizedQueryResult {
        return { provider: 'gemini', answerText: 'stub answer', citedDomains: [], groundingSources: [], searchQueries: [] }
      },
      async generateText(): Promise<string> { return 'stub' },
    }
  }

  function registry(): ProviderRegistry {
    const r = new ProviderRegistry()
    r.register(adapter(), { provider: 'gemini', apiKey: 'test-key', quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 600, maxRequestsPerDay: 100 } })
    return r
  }

  it('finalizes a normal sweep once, through finalizeRun', async () => {
    const { db, projectId, runId } = seed('queued', 2)
    const { runner, onRunCompleted } = runnerWithSpies(db, registry())
    const finalize = vi.spyOn(runner, 'finalizeRun')

    await runner.executeRun(runId, projectId)

    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize.mock.calls[0]![0]).toMatchObject({ runId, projectId, kind: 'answer-visibility', inserted: 2, planShortfall: 0 })
    expect(finalize.mock.results[0]!.value).toBe(true)
    expect(runRow(db, runId).status).toBe('completed')
    expect(onRunCompleted).toHaveBeenCalledTimes(1)
    expect(events('run.completed')).toHaveLength(1)
    expect(runsCounted(db, projectId)).toBe(1)
    expect(quotaUsed(db, projectId)).toBe(2)
  })

  it('reports a cancel that lands as the sweep finishes as a cancellation, without overwriting it', async () => {
    const { db, projectId, runId } = seed('queued', 2)
    const { runner, onRunCompleted } = runnerWithSpies(db, registry())
    const finalize = runner.finalizeRun.bind(runner)
    // The cancel is written between the sweep's last cancellation check and
    // its terminal write, the window only the compare-and-set closes.
    vi.spyOn(runner, 'finalizeRun').mockImplementation((input) => {
      db.update(runs).set({ status: 'cancelled', error: 'Cancelled by user' }).where(eq(runs.id, runId)).run()
      return finalize(input)
    })

    await runner.executeRun(runId, projectId)

    const run = runRow(db, runId)
    expect(run).toMatchObject({ status: 'cancelled', error: 'Cancelled by user' })
    expect(run.finishedAt).not.toBeNull()
    expect(events('run.completed')).toHaveLength(1)
    expect(events('run.completed')[0]).toEqual(['run.completed', expect.objectContaining({ status: 'cancelled' }), { errorCode: 'RUN_CANCELLED' }])
    expect(events('activation.completed')).toHaveLength(0)
    expect(onRunCompleted).toHaveBeenCalledTimes(1)
    // A cancelled run is not counted as a completed one.
    expect(runsCounted(db, projectId)).toBe(0)
    // Both answers were sent before the cancel, so both stay counted.
    expect(quotaUsed(db, projectId)).toBe(2)
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()).toHaveLength(2)
  })
})
