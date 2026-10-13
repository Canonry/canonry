import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import type { SchedulableRunKind } from '@ainyc/canonry-contracts'
import { createClient, migrate, projects, runs, schedules, type DatabaseClient } from '@ainyc/canonry-db'
import { Scheduler, type SchedulerCallbacks } from '../src/scheduler.js'

// A `schedules.slot` outcome says whether a slot fired or why it did not; the
// work it hands off reports its own outcome.

const trackEvent = vi.hoisted(() => vi.fn())
vi.mock('../src/telemetry.js', () => ({ trackEvent }))
beforeEach(() => trackEvent.mockReset())
afterEach(() => { vi.useRealTimers() })

const NOW = new Date().toISOString()

function harness(callbacks: Partial<SchedulerCallbacks> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-scheduler-slots-'))
  const db: DatabaseClient = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: 'proj', name: 'slots', displayName: 'Slots', canonicalDomain: 'example.com', country: 'US', language: 'en',
    providers: ['openai'], createdAt: NOW, updatedAt: NOW,
  }).run()
  const scheduler = new Scheduler(db, { onRunCreated: () => {}, getRunnableProviderNames: () => ['openai'], ...callbacks })
  onTestFinished(() => { scheduler.stop(); fs.rmSync(tmpDir, { recursive: true, force: true }) })
  const schedule = (id: string, kind: SchedulableRunKind, extra: Partial<typeof schedules.$inferInsert> = {}) => {
    db.insert(schedules).values({
      id, projectId: 'proj', kind, cronExpr: '0 6 * * *', timezone: 'UTC', enabled: true, providers: [],
      createdAt: NOW, updatedAt: NOW, ...extra,
    }).run()
  }
  const fire = (scheduleId: string, kind: SchedulableRunKind) => (scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: SchedulableRunKind) => void
  }).triggerRun(scheduleId, 'proj', kind)
  return { db, scheduler, schedule, fire }
}

const slot = (outcome: Record<string, unknown>, trigger = 'scheduled') => [
  'feature.completed',
  { feature: 'schedules', operation: 'slot', trigger, surface: 'system', ...outcome },
  outcome.reasonCode ? { errorCode: outcome.reasonCode } : undefined,
]

it('reports a fired slot on schedule, and a missed one caught up at startup', () => {
  const refreshed: string[] = []
  const h = harness({ onDataRefreshRequested: name => refreshed.push(name) })
  h.schedule('refresh', 'data-refresh')
  h.fire('refresh', 'data-refresh')
  h.schedule('missed', 'traffic-sync', { sourceId: 'src', nextRunAt: new Date(Date.now() - 60_000).toISOString() })
  h.scheduler.start()

  expect(refreshed).toEqual(['slots'])
  expect(trackEvent.mock.calls).toEqual([
    slot({ status: 'succeeded' }),
    // The host never registered a traffic-sync callback.
    slot({ status: 'failed', reasonCode: 'UNSUPPORTED' }, 'startup'),
  ])
})

it('reports skipped slots: work still in flight, a stale or disabled schedule', () => {
  const h = harness({ onAdsSyncRequested: () => {} })
  h.schedule('ads', 'ads-sync')
  h.db.insert(runs).values({ id: 'inflight', projectId: 'proj', kind: 'ads-sync', status: 'running', trigger: 'scheduled', createdAt: NOW }).run()
  h.fire('ads', 'ads-sync')
  h.schedule('sweep', 'answer-visibility')
  h.db.insert(runs).values({ id: 'sweeping', projectId: 'proj', kind: 'answer-visibility', status: 'running', trigger: 'manual', createdAt: NOW }).run()
  h.fire('sweep', 'answer-visibility')
  h.fire('deleted', 'doctor')
  h.schedule('off', 'site-audit', { enabled: false })
  h.fire('off', 'site-audit')

  expect(trackEvent.mock.calls).toEqual([
    slot({ status: 'skipped', reasonCode: 'OPERATION_IN_PROGRESS' }),
    slot({ status: 'skipped', reasonCode: 'OPERATION_IN_PROGRESS' }),
    slot({ status: 'skipped', reasonCode: 'NOT_FOUND' }),
    slot({ status: 'skipped', reasonCode: 'NOT_DUE' }),
  ])
})

it('reports failed slots: a schedule missing its source, and an error from the host by class', () => {
  const h = harness({
    onTrafficSyncRequested: () => {},
    onRunCreated: () => { throw new RangeError('job runner refused run for https://example.com') },
  })
  h.schedule('no-source', 'traffic-sync')
  h.fire('no-source', 'traffic-sync')
  h.schedule('sweep', 'answer-visibility')
  h.fire('sweep', 'answer-visibility')

  expect(trackEvent.mock.calls).toEqual([
    slot({ status: 'failed', reasonCode: 'VALIDATION' }),
    slot({ status: 'failed', reasonCode: 'UNKNOWN', errorName: 'RangeError' }),
  ])
  expect(h.db.select().from(runs).where(eq(runs.kind, 'answer-visibility')).all()).toHaveLength(1)
})

it('samples a schedule that fires every minute, per status and reason, carrying the count it dropped', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const h = harness({ onDataRefreshRequested: () => {} })
  h.schedule('refresh', 'data-refresh')
  for (let tick = 0; tick < 7; tick++) h.fire('refresh', 'data-refresh')
  h.fire('deleted', 'doctor')
  expect(trackEvent).toHaveBeenCalledTimes(6)
  vi.setSystemTime(Date.now() + 30 * 60_000)
  h.fire('refresh', 'data-refresh')
  expect(trackEvent.mock.calls.at(-1)).toEqual(slot({ status: 'succeeded', droppedBefore: 2 }))
})
