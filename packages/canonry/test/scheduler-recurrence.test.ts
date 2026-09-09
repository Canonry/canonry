import { afterEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, runs, schedules } from '@ainyc/canonry-db'
import { Scheduler } from '../src/scheduler.js'

const recurrence = { everyDays: 14, startDate: '2026-09-23', time: '00:00' }
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.useRealTimers()
})

function setup(now: string, nextRunAt: string | null, enabled = true, fakeTimers = false) {
  vi.useFakeTimers({ toFake: fakeTimers ? ['Date', 'setTimeout', 'clearTimeout'] : ['Date'] })
  vi.setSystemTime(new Date(now))
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-calendar-scheduler-'))
  const db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  cleanups.push(() => db.$client.close())
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }))
  db.insert(projects).values({
    id: 'project', name: 'calendar-project', displayName: 'Calendar Project', canonicalDomain: 'example.test',
    country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'calendar-schedule', projectId: 'project', kind: 'answer-visibility', cronExpr: '', recurrence,
    preset: null, timezone: 'America/New_York', enabled, providers: [], nextRunAt, createdAt: now, updatedAt: now,
  }).run()
  const onRunCreated = vi.fn()
  const scheduler = new Scheduler(db, { onRunCreated })
  cleanups.push(() => scheduler.stop())
  return { db, scheduler, onRunCreated }
}

test('calendar scheduler holds before the anchor and records its first local occurrence', () => {
  const { db, scheduler, onRunCreated } = setup('2026-09-20T12:00:00.000Z', null)
  scheduler.start()

  expect(onRunCreated).not.toHaveBeenCalled()
  expect(db.select().from(schedules).where(eq(schedules.id, 'calendar-schedule')).get()?.nextRunAt)
    .toBe('2026-09-23T04:00:00.000Z')
})

test('calendar startup catches up once, skips older slots, and a restart cannot replay the claimed occurrence', () => {
  const { db, scheduler, onRunCreated } = setup('2026-11-20T12:00:00.000Z', '2026-09-23T04:00:00.000Z')
  scheduler.start()

  expect(onRunCreated).toHaveBeenCalledTimes(1)
  expect(db.select().from(schedules).where(eq(schedules.id, 'calendar-schedule')).get()?.nextRunAt)
    .toBe('2026-12-02T05:00:00.000Z')

  scheduler.stop()
  const restarted = new Scheduler(db, { onRunCreated })
  cleanups.push(() => restarted.stop())
  restarted.start()
  expect(onRunCreated).toHaveBeenCalledTimes(1)
})

test('calendar occurrence claims are persistent and disabled rows never dispatch callbacks', () => {
  const { db, scheduler, onRunCreated } = setup('2026-09-24T12:00:00.000Z', '2026-09-23T04:00:00.000Z')
  const row = db.select().from(schedules).where(eq(schedules.id, 'calendar-schedule')).get()!
  const claim = scheduler as unknown as { claimCalendarOccurrence: (schedule: typeof row, dueAt: string, now: Date) => boolean, triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility') => void }

  expect(claim.claimCalendarOccurrence(row, row.nextRunAt!, new Date())).toBe(true)
  expect(claim.claimCalendarOccurrence(row, row.nextRunAt!, new Date())).toBe(false)

  db.update(schedules).set({ enabled: false }).where(eq(schedules.id, row.id)).run()
  claim.triggerRun(row.id, row.projectId, 'answer-visibility')
  expect(onRunCreated).not.toHaveBeenCalled()
})


test('calendar timer dispatches at the exact due instant once and advances the next occurrence', () => {
  const { db, scheduler, onRunCreated } = setup('2026-09-23T03:59:59.900Z', null, true, true)
  scheduler.start()

  vi.advanceTimersByTime(99)
  expect(onRunCreated).not.toHaveBeenCalled()

  vi.advanceTimersByTime(1)
  expect(onRunCreated).toHaveBeenCalledTimes(1)
  expect(db.select().from(schedules).where(eq(schedules.id, 'calendar-schedule')).get()?.nextRunAt)
    .toBe('2026-10-07T04:00:00.000Z')

  db.update(runs).set({ status: 'completed' }).run()
  const duplicate = scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility', claimedOccurrence: string) => void
  }
  duplicate.triggerRun('calendar-schedule', 'project', 'answer-visibility', '2026-09-23T04:00:00.000Z')
  expect(onRunCreated).toHaveBeenCalledTimes(1)

  vi.advanceTimersByTime(60_000)
  expect(onRunCreated).toHaveBeenCalledTimes(1)
})

test('calendar timer does not dispatch when a registered schedule is disabled before its due time', () => {
  const { db, scheduler, onRunCreated } = setup('2026-09-23T03:59:59.900Z', null, true, true)
  scheduler.start()
  db.update(schedules).set({ enabled: false }).where(eq(schedules.id, 'calendar-schedule')).run()

  vi.advanceTimersByTime(100)
  expect(onRunCreated).not.toHaveBeenCalled()
})
