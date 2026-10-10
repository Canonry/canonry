import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, onTestFinished, beforeEach, vi } from 'vitest'
import type {
  NormalizedQueryResult,
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  RawQueryResult,
  TrackedQueryInput,
} from '@ainyc/canonry-contracts'
import { createClient, migrate, projects, queries, runs } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { getSharedProviderExecutionGate, resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'

/**
 * NEW-3: `ProviderExecutionGate` holds the per-provider concurrency and
 * rate-limit budget for one upstream API key. Two runs for two DIFFERENT
 * projects can be in flight at once (the scheduler does not serialize
 * projects against each other), and both name the same provider — they share
 * the same upstream key and the same real-world rate limit. A gate built
 * fresh per run gives each run its own independent budget against that same
 * key, silently multiplying the configured limit by the number of concurrent
 * runs. The gate must be shared process-wide, one per provider name.
 */

beforeEach(() => {
  resetSharedProviderExecutionGates()
})

function buildAdapter(onDispatch: () => Promise<void> | void): ProviderAdapter {
  return {
    name: 'gemini',
    validateConfig(_config: ProviderConfig): ProviderHealthcheckResult {
      return { ok: true, provider: 'gemini', message: 'ok' }
    },
    async healthcheck(_config: ProviderConfig): Promise<ProviderHealthcheckResult> {
      return { ok: true, provider: 'gemini', message: 'ok' }
    },
    async executeTrackedQuery(_input: TrackedQueryInput, _config: ProviderConfig): Promise<RawQueryResult> {
      await onDispatch()
      return {
        provider: 'gemini',
        rawResponse: {},
        model: 'stub-model',
        groundingSources: [],
        searchQueries: [],
      }
    },
    normalizeResult(_raw: RawQueryResult): NormalizedQueryResult {
      return {
        provider: 'gemini',
        answerText: 'stub answer',
        citedDomains: [],
        groundingSources: [],
        searchQueries: [],
      }
    },
    async generateText(_prompt: string, _config: ProviderConfig): Promise<string> {
      return 'stub'
    },
  }
}

function seedProjectAndRun(db: ReturnType<typeof createClient>, queryCount: number) {
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()

  db.insert(projects).values({
    id: projectId,
    name: `project-${projectId}`,
    displayName: 'Test Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  for (let index = 0; index < queryCount; index++) {
    db.insert(queries).values({
      id: crypto.randomUUID(),
      projectId,
      query: `query-${index + 1}`,
      createdAt: now,
    }).run()
  }

  db.insert(runs).values({
    id: runId,
    projectId,
    status: 'queued',
    createdAt: now,
  }).run()

  return { projectId, runId }
}

test('two concurrent runs for different projects share one concurrency budget for the same provider', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-shared-gate-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  let inFlight = 0
  let maxSeen = 0
  const adapter = buildAdapter(async () => {
    inFlight++
    maxSeen = Math.max(maxSeen, inFlight)
    await new Promise(resolve => setTimeout(resolve, 30))
    inFlight--
  })

  const registry = new ProviderRegistry()
  registry.register(adapter, {
    provider: 'gemini',
    apiKey: 'test-key',
    // A budget of 1 in-flight request against this provider. If each run
    // gets its own gate, two runs dispatching at once will still peak at 2 —
    // the whole point of a SHARED gate is that the peak stays at 1 no matter
    // how many runs are in flight for it concurrently.
    quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 60, maxRequestsPerDay: 100 },
  })

  const runnerA = new JobRunner(db, registry)
  const runnerB = new JobRunner(db, registry)
  const { projectId: projectA, runId: runIdA } = seedProjectAndRun(db, 2)
  const { projectId: projectB, runId: runIdB } = seedProjectAndRun(db, 2)

  await Promise.all([
    runnerA.executeRun(runIdA, projectA),
    runnerB.executeRun(runIdB, projectB),
  ])

  expect(maxSeen).toBe(1)
})

function registerQuota(registry: ProviderRegistry, maxConcurrency: number, maxRequestsPerMinute: number): void {
  registry.register(buildAdapter(() => {}), {
    provider: 'gemini', apiKey: 'test-key',
    quotaPolicy: { maxConcurrency, maxRequestsPerMinute, maxRequestsPerDay: 100 },
  })
}

test('lowering a registered concurrency cap waits for existing calls to drain before dispatching queued work', async () => {
  vi.useFakeTimers()
  onTestFinished(() => vi.useRealTimers())
  const registry = new ProviderRegistry()
  registerQuota(registry, 3, 60)
  const gate = getSharedProviderExecutionGate('gemini', 3, 60)
  const started: number[] = []
  const releases = new Map<number, () => void>()
  const executions = [0, 1, 2, 3].map(id => gate.run(async () => {
    started.push(id)
    await new Promise<void>(resolve => releases.set(id, resolve))
  }))
  await vi.advanceTimersByTimeAsync(0)
  const beforeChange = [...started]
  registerQuota(registry, 1, 60)
  releases.get(0)?.()
  await vi.advanceTimersByTimeAsync(0)
  const afterFirstRelease = [...started]
  releases.get(1)?.()
  await vi.advanceTimersByTimeAsync(0)
  const afterSecondRelease = [...started]
  releases.get(2)?.()
  await vi.advanceTimersByTimeAsync(0)
  const afterDrain = [...started]
  releases.get(3)?.()
  await Promise.all(executions)

  expect(beforeChange).toEqual([0, 1, 2])
  expect(afterFirstRelease).toEqual([0, 1, 2])
  expect(afterSecondRelease).toEqual([0, 1, 2])
  expect(afterDrain).toEqual([0, 1, 2, 3])
})

test('raising concurrency wakes queued work without resetting the minute budget or restoring an older run policy', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  onTestFinished(() => vi.useRealTimers())
  const registry = new ProviderRegistry()
  registerQuota(registry, 1, 2)
  const gate = getSharedProviderExecutionGate('gemini', 1, 2)
  const started: number[] = []
  const releases = new Map<number, () => void>()
  const hold = (id: number) => async () => {
    started.push(id)
    await new Promise<void>(resolve => releases.set(id, resolve))
  }
  const executions = [gate.run(hold(0)), gate.run(hold(1)), gate.run(hold(2))]
  await vi.advanceTimersByTimeAsync(0)
  registerQuota(registry, 3, 2)
  executions.push(getSharedProviderExecutionGate('gemini', 1, 2).run(hold(3)))
  await vi.advanceTimersByTimeAsync(0)
  const afterChange = [...started]
  releases.get(0)?.()
  releases.get(1)?.()
  await vi.advanceTimersByTimeAsync(59_999)
  const beforeWindowExpires = [...started]
  await vi.advanceTimersByTimeAsync(52)
  const afterWindowExpires = [...started]
  for (let id = 0; id < 4; id++) {
    releases.get(id)?.()
    await vi.runAllTimersAsync()
  }
  await Promise.all(executions)

  expect(afterChange).toEqual([0, 1])
  expect(beforeWindowExpires).toEqual([0, 1])
  expect(afterWindowExpires).toEqual([0, 1, 2, 3])
})

test('lowering the minute cap preserves dispatch history and waits until the new budget has capacity', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  onTestFinished(() => vi.useRealTimers())
  const registry = new ProviderRegistry()
  registerQuota(registry, 2, 3)
  const gate = getSharedProviderExecutionGate('gemini', 2, 3)
  const dispatches: number[] = []
  const dispatch = async () => { dispatches.push(Date.now()) }
  await gate.run(dispatch)
  await vi.advanceTimersByTimeAsync(1_000)
  await gate.run(dispatch)
  registerQuota(registry, 2, 1)
  const queued = gate.run(dispatch)
  await vi.advanceTimersByTimeAsync(59_051)
  const afterOldestExpires = [...dispatches]
  await vi.advanceTimersByTimeAsync(1_000)
  await queued

  expect(afterOldestExpires).toEqual([0, 1_000])
  expect(dispatches).toEqual([0, 1_000, 61_050])
})

test('raising the minute cap releases an existing rate waiter immediately', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  onTestFinished(() => vi.useRealTimers())
  const registry = new ProviderRegistry()
  registerQuota(registry, 1, 1)
  const gate = getSharedProviderExecutionGate('gemini', 1, 1)
  const dispatches: number[] = []
  const dispatch = async () => { dispatches.push(Date.now()) }
  await gate.run(dispatch)
  const queued = gate.run(dispatch)
  await vi.advanceTimersByTimeAsync(1_000)
  registerQuota(registry, 1, 2)
  await vi.advanceTimersByTimeAsync(0)
  const afterChange = [...dispatches]
  await vi.runAllTimersAsync()
  await queued

  expect(afterChange).toEqual([0, 1_000])
})

test('lowering concurrency while raising the minute budget still bounds calls already waiting for rate capacity', async () => {
  vi.useFakeTimers()
  onTestFinished(() => vi.useRealTimers())
  const registry = new ProviderRegistry()
  registerQuota(registry, 3, 1)
  const gate = getSharedProviderExecutionGate('gemini', 3, 1)
  await gate.run(async () => {})
  let active = 0
  let maxSeen = 0
  const started: number[] = []
  const releases = new Map<number, () => void>()
  const executions = [0, 1].map(id => gate.run(async () => {
    active++
    maxSeen = Math.max(maxSeen, active)
    started.push(id)
    await new Promise<void>(resolve => releases.set(id, resolve))
    active--
  }))
  await vi.advanceTimersByTimeAsync(0)
  registerQuota(registry, 1, 3)
  await vi.advanceTimersByTimeAsync(0)
  const afterChange = [...started]
  releases.get(0)?.()
  await vi.advanceTimersByTimeAsync(0)
  const afterFirstRelease = [...started]
  releases.get(1)?.()
  await Promise.all(executions)

  expect(afterChange).toEqual([0])
  expect(afterFirstRelease).toEqual([0, 1])
  expect(maxSeen).toBe(1)
})
