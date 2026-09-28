import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { projects, runs, schedules, type DatabaseClient } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { batchEligibleProviderNames } from '../src/provider-batch-config.js'
import { ProviderBatchPoller } from '../src/provider-batch-poller.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'
import { Scheduler } from '../src/scheduler.js'
import {
  CLAUDE_MODEL,
  FakeBatchTransport,
  GEMINI_MODEL,
  GEMINI_PRICING,
  NOW,
  batchRows,
  fakeAdapter,
  quotaUsed,
  registryOf,
  requestRows,
  runRow,
  seedPlannedProject,
  snapshotRows,
} from './provider-batch-harness.js'

// A project's stored `providerDispatchModes` takes effect on the sweeps the
// scheduler queues (#1201). This follows one preference all the way: the
// project row, a scheduled sweep queued by the Scheduler with the host's
// batch-eligible providers, the frozen run column, the provider batch the
// sweep submits, and the answers the poller ingests into that run. Everything
// is wired as server.ts wires it; only the provider behind the adapter is fake.

const telemetry = vi.hoisted(() => ({ trackEvent: vi.fn() }))
vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry.js')>()),
  trackEvent: telemetry.trackEvent,
}))

beforeEach(() => {
  telemetry.trackEvent.mockReset()
  resetSharedProviderExecutionGates()
})

const statuses = () => telemetry.trackEvent.mock.calls
  .filter(([event]) => event === 'run.completed')
  .map(([, props]) => (props as { status: string }).status)

/**
 * The server's wiring over one database: a registry whose claude has its
 * batch API enabled in config, a runner, the poller, and a scheduler whose
 * callbacks resolve providers, models and batch eligibility from the registry.
 */
function serve(db: DatabaseClient) {
  const transport = new FakeBatchTransport()
  const registry = registryOf([
    { adapter: fakeAdapter('claude', { transport }), config: { model: CLAUDE_MODEL, batch: { enabled: true } } },
    { adapter: fakeAdapter('gemini'), config: { model: GEMINI_MODEL, pricing: GEMINI_PRICING } },
  ])
  const runner = new JobRunner(db, registry)
  const completed = vi.fn(async (_runId: string, _projectId: string) => {})
  runner.onRunCompleted = completed
  const executions: Array<Promise<void>> = []
  const scheduler = new Scheduler(db, {
    onRunCreated: (runId, projectId, providers, location) => {
      executions.push(runner.executeRun(runId, projectId, providers, location))
    },
    getRunnableProviderNames: () => registry.getAll().map(provider => provider.adapter.name),
    getEffectiveProviderModels: () => Object.fromEntries(registry.getAll()
      .map(provider => [provider.adapter.name, provider.config.model ?? provider.adapter.modelRegistry.defaultModel])),
    getBatchEligibleProviderNames: () => batchEligibleProviderNames(registry),
  })
  onTestFinished(() => scheduler.stop())
  const poller = new ProviderBatchPoller({ db, registry, runner })
  return { transport, runner, scheduler, poller, completed, executions }
}

/** A daily sweep whose slot passed while the server was down, so `start()` catches it up at once. */
function scheduleMissedSweep(db: DatabaseClient, projectId: string): void {
  db.insert(schedules).values({
    id: `sched-${projectId}`, projectId, kind: 'answer-visibility', cronExpr: '0 6 * * *', timezone: 'UTC', enabled: true,
    providers: [], nextRunAt: '2026-01-01T06:00:00.000Z', createdAt: NOW, updatedAt: NOW,
  }).run()
}

function onlySweep(db: DatabaseClient, projectId: string) {
  const sweeps = db.select().from(runs).where(eq(runs.projectId, projectId)).all()
  expect(sweeps).toHaveLength(1)
  return sweeps[0]!
}

describe('a stored batch preference on a scheduled sweep', () => {
  it.each([
    { schema: 2 as const, label: 'an Advanced (v2) portfolio' },
    { schema: 1 as const, label: 'a Simple (v1) plan' },
  ])('$label: claude=batch reaches a provider batch and its answers are ingested into the scheduled run', async ({ schema }) => {
    const { db, projectId } = seedPlannedProject({ count: 2, schema })
    db.update(projects).set({ providerDispatchModes: { claude: 'batch' } }).where(eq(projects.id, projectId)).run()
    scheduleMissedSweep(db, projectId)
    const { transport, scheduler, poller, completed, executions } = serve(db)

    scheduler.start()
    expect(executions).toHaveLength(1)
    await Promise.all(executions)

    // Frozen at queue time from the project row and the host's eligibility.
    const sweep = onlySweep(db, projectId)
    expect(sweep).toMatchObject({ trigger: 'scheduled', providerDispatchModes: { claude: 'batch' }, status: 'running', pendingProviderErrors: {} })
    const [batch] = batchRows(db, sweep.id)
    expect(batchRows(db, sweep.id)).toHaveLength(1)
    expect(batch).toMatchObject({ provider: 'claude', model: CLAUDE_MODEL, status: 'submitted', requestCount: 2, providerBatchId: 'fakebatch_1' })
    expect(transport.submitCalls.map(lines => lines.map(line => (line.request.body as { model: string }).model)))
      .toEqual([[CLAUDE_MODEL, CLAUDE_MODEL]])
    expect(requestRows(db, batch!.id).map(row => row.requestedModel)).toEqual([CLAUDE_MODEL, CLAUDE_MODEL])
    // Only gemini, which the project left sync, has answered yet.
    expect(snapshotRows(db, sweep.id).map(row => [row.provider, row.dispatchMode])).toEqual([['gemini', 'sync'], ['gemini', 'sync']])
    expect(statuses()).toEqual([])

    transport.end(batch!.providerBatchId!)
    await poller.tick()

    expect(runRow(db, sweep.id)).toMatchObject({ status: 'completed', error: null, pendingProviderErrors: null })
    expect(batchRows(db, sweep.id)[0]).toMatchObject({ status: 'ingested', ingestedCount: 2, recordedCount: 2, quotaReleased: 0 })
    expect(snapshotRows(db, sweep.id).map(row => [row.provider, row.dispatchMode, row.providerBatchId, row.usage?.pricingTier])).toEqual([
      ['claude', 'batch', batch!.id, 'batch'],
      ['claude', 'batch', batch!.id, 'batch'],
      ['gemini', 'sync', null, 'standard'],
      ['gemini', 'sync', null, 'standard'],
    ])
    expect(quotaUsed(db, projectId, 'claude')).toBe(2)
    expect(quotaUsed(db, projectId, 'gemini')).toBe(2)
    expect(statuses()).toEqual(['completed'])
    expect(completed).toHaveBeenCalledTimes(1)
    expect(completed).toHaveBeenCalledWith(sweep.id, projectId)
  })

  it('runs every engine sync on a project that stores no preference (the default)', async () => {
    const { db, projectId } = seedPlannedProject({ count: 2 })
    expect(db.select().from(projects).where(eq(projects.id, projectId)).get()?.providerDispatchModes).toEqual({})
    scheduleMissedSweep(db, projectId)
    const { transport, scheduler, completed, executions } = serve(db)

    scheduler.start()
    expect(executions).toHaveLength(1)
    await Promise.all(executions)

    const sweep = onlySweep(db, projectId)
    expect(sweep).toMatchObject({ trigger: 'scheduled', providerDispatchModes: null, status: 'completed', pendingProviderErrors: null })
    expect(batchRows(db, sweep.id)).toEqual([])
    expect(transport.submitCalls).toEqual([])
    expect(snapshotRows(db, sweep.id).map(row => [row.provider, row.dispatchMode])).toEqual([
      ['claude', 'sync'], ['claude', 'sync'], ['gemini', 'sync'], ['gemini', 'sync'],
    ])
    expect(statuses()).toEqual(['completed'])
    expect(completed).toHaveBeenCalledTimes(1)
  })
})
