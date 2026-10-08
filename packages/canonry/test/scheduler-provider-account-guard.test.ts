import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { buildProviderRunError, PROVIDER_ACCOUNT_FAILURE_STREAK, PROVIDER_ACCOUNT_RETRY_HOURS, serializeRunError } from '@ainyc/canonry-contracts'
import { auditLog, createClient, migrate, projects, queries, runs, schedules } from '@ainyc/canonry-db'
import { addLogListener, type LogEntry } from '../src/logger.js'
import { hashDomain } from '../src/run-telemetry.js'
import { Scheduler } from '../src/scheduler.js'

// A schedule cannot pass `force`, so when every provider keeps failing on its
// account the scheduler skips the slot instead of queueing another run that
// would fail the same way, and moves the schedule on to its next slot. A
// skipped slot leaves no run, so the first one of each refusal writes a
// `run.refused` audit row and a `run.aborted` event; later slots of the same
// refusal repeat neither.

const telemetry = vi.hoisted(() => ({ trackEvent: vi.fn() }))
vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry.js')>()),
  trackEvent: telemetry.trackEvent,
}))

const NOW = new Date().toISOString()
const AUTH = '[provider-openai] 401 Incorrect API key provided'

let removeListener: (() => void) | null = null
beforeEach(() => { telemetry.trackEvent.mockReset() })
afterEach(() => {
  removeListener?.()
  removeListener = null
})

it('skips a scheduled sweep while every provider fails on its account, records the refusal once, and advances the schedule', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-sched-account-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'stuck', displayName: 'Stuck Co', canonicalDomain: 'example.com', country: 'US', language: 'en',
    providers: ['openai'], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(queries).values({ id: crypto.randomUUID(), projectId, query: 'widget pricing', createdAt: NOW }).run()
  const failedRun = (minutesAgo: number) => {
    const id = crypto.randomUUID()
    db.insert(runs).values({
      id, projectId, kind: 'answer-visibility', status: 'failed', trigger: 'scheduled',
      error: serializeRunError(buildProviderRunError([['openai', AUTH]])),
      // The last few minutes: inside the retry interval.
      createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    }).run()
    return id
  }
  const streak = Array.from({ length: PROVIDER_ACCOUNT_FAILURE_STREAK }, (_, i) => failedRun(PROVIDER_ACCOUNT_FAILURE_STREAK + 1 - i))
  db.insert(schedules).values({
    id: 'sched_stuck', projectId, cronExpr: '0 6 * * *', timezone: 'UTC', enabled: true, providers: [],
    nextRunAt: NOW, createdAt: NOW, updatedAt: NOW,
  }).run()

  const logs: LogEntry[] = []
  removeListener = addLogListener(entry => { if (entry.module === 'Scheduler') logs.push(entry) })
  const created: string[] = []
  const scheduler = new Scheduler(db, { onRunCreated: runId => created.push(runId), getRunnableProviderNames: () => ['openai'] })
  const fire = () => (scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility') => void
  }).triggerRun('sched_stuck', projectId, 'answer-visibility')
  const refusals = () => db.select().from(auditLog).where(eq(auditLog.action, 'run.refused')).all()
  const aborted = () => telemetry.trackEvent.mock.calls.filter(([event]) => event === 'run.aborted')
  const refusalOf = (latestRunId: string, since: string, latestCreatedAt: string) => ({
    code: 'PROVIDERS_FAILING',
    consecutiveRuns: PROVIDER_ACCOUNT_FAILURE_STREAK,
    latestRunId,
    since,
    retryAfter: new Date(Date.parse(latestCreatedAt) + PROVIDER_ACCOUNT_RETRY_HOURS * 3_600_000).toISOString(),
    providers: { openai: 'PROVIDER_AUTH' },
  })
  const createdAt = (id: string) => db.select({ createdAt: runs.createdAt }).from(runs).where(eq(runs.id, id)).get()!.createdAt

  fire()

  expect(created).toEqual([])
  expect(db.select().from(runs).all()).toHaveLength(PROVIDER_ACCOUNT_FAILURE_STREAK)
  expect(logs.find(entry => entry.action === 'run.skipped-providers-failing')).toMatchObject({
    level: 'warn', projectName: 'stuck', providers: { openai: 'PROVIDER_AUTH' }, retryAfter: expect.any(String),
  })
  expect(db.select().from(schedules).where(eq(schedules.id, 'sched_stuck')).get()?.nextRunAt).not.toBe(NOW)
  const first = refusalOf(streak.at(-1)!, createdAt(streak[0]!), createdAt(streak.at(-1)!))
  expect(refusals().map(row => ({ ...row, diff: JSON.parse(row.diff!) }))).toEqual([expect.objectContaining({
    projectId, actor: 'scheduler', entityType: 'schedule', entityId: 'sched_stuck', diff: first,
  })])
  expect(aborted()).toEqual([[
    'run.aborted',
    {
      reason: 'providers_failing',
      providerCount: 1,
      providers: ['openai'],
      providerOutcomes: { openai: 'PROVIDER_AUTH' },
      trigger: 'scheduled',
      domainHash: hashDomain('example.com'),
    },
    { errorCode: 'PROVIDERS_FAILING' },
  ]])

  // The next slot meets the same refusal: skipped again, recorded nowhere new.
  fire()
  expect(created).toEqual([])
  expect(refusals()).toHaveLength(1)
  expect(aborted()).toHaveLength(1)

  // A newer failure (a forced run, say) starts a new refusal, recorded again.
  const newest = failedRun(0)
  fire()
  expect(refusals().map(row => JSON.parse(row.diff!))).toEqual(expect.arrayContaining([
    first,
    refusalOf(newest, createdAt(streak[1]!), createdAt(newest)),
  ]))
  expect(refusals()).toHaveLength(2)
  expect(aborted()).toHaveLength(2)
})
