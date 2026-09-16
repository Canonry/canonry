import { afterEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { type ScheduleDto, type SchedulableRunKind, SchedulableRunKinds } from '@ainyc/canonry-contracts'
import { createClient, migrate, projects, schedules, trafficSources } from '@ainyc/canonry-db'
import { Scheduler } from '../src/scheduler.js'

const NOW = '2026-09-05T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
})

function harness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-scheduler-cas-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  cleanups.push(() => db.$client.close())
  db.insert(projects).values({
    id: 'project', name: 'example', displayName: 'Example', canonicalDomain: 'example.test',
    country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()
  const scheduler = new Scheduler(db, {
    onRunCreated: vi.fn(),
    onTrafficSyncRequested: vi.fn(),
    onGbpSyncRequested: vi.fn(),
    onAdsSyncRequested: vi.fn(),
    onDataRefreshRequested: vi.fn(),
    onDoctorRequested: vi.fn(),
    onBacklinksSyncRequested: vi.fn(),
    onSiteAuditRequested: vi.fn(),
  })
  cleanups.push(() => scheduler.stop())
  return { db, scheduler }
}

function freezeClock(now = NOW_MS): void {
  // Keep actual timers for Fastify/node-cron; only the clock used for row
  // versions is frozen. No cron job fires in these tests.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
}

test('real scheduler callbacks preserve schedule CAS on equal ticks and clock rollback', async () => {
  const { db, scheduler } = harness()
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    onScheduleUpdated(action, projectId, kind) {
      if (action === 'upsert') scheduler.upsert(projectId, kind)
      else scheduler.remove(projectId, kind)
    },
  })
  cleanups.push(() => app.close())
  await app.ready()
  freezeClock()
  const url = '/api/v1/projects/example/schedule'

  const created = await app.inject({ method: 'PUT', url, payload: { preset: 'daily', expectedUpdatedAt: null } })
  expect(created.statusCode).toBe(201)
  const createdVersion = created.json<ScheduleDto>().updatedAt

  const saved = await app.inject({ method: 'PUT', url, payload: { preset: 'daily@8', expectedUpdatedAt: createdVersion } })
  expect(saved.statusCode).toBe(200)
  const savedVersion = saved.json<ScheduleDto>().updatedAt
  expect(Date.parse(savedVersion)).toBeGreaterThan(Date.parse(createdVersion))
  expect(db.select().from(schedules).where(eq(schedules.kind, 'answer-visibility')).get()?.updatedAt).toBe(savedVersion)

  const staleSave = await app.inject({ method: 'PUT', url, payload: { preset: 'daily@9', expectedUpdatedAt: createdVersion } })
  expect(staleSave.statusCode).toBe(409)
  expect(staleSave.json()).toMatchObject({ error: { code: 'SCHEDULE_VERSION_CONFLICT' } })

  vi.setSystemTime(NOW_MS - 60_000)
  const rollbackSave = await app.inject({ method: 'PUT', url, payload: { preset: 'daily@10', expectedUpdatedAt: savedVersion } })
  expect(rollbackSave.statusCode).toBe(200)
  const rollbackVersion = rollbackSave.json<ScheduleDto>().updatedAt
  expect(Date.parse(rollbackVersion)).toBeGreaterThan(Date.parse(savedVersion))

  const staleDelete = await app.inject({ method: 'DELETE', url: `${url}?expectedUpdatedAt=${encodeURIComponent(savedVersion)}` })
  expect(staleDelete.statusCode).toBe(409)
  const current = await app.inject({ method: 'GET', url })
  expect(current.json()).toMatchObject({ preset: 'daily@10', updatedAt: rollbackVersion })
  const currentDelete = await app.inject({ method: 'DELETE', url: `${url}?expectedUpdatedAt=${encodeURIComponent(rollbackVersion)}` })
  expect(currentDelete.statusCode).toBe(204)
})

test('cron registration advances the latest persisted version, not its captured schedule row', () => {
  const { db, scheduler } = harness()
  db.insert(schedules).values({
    id: 'schedule', projectId: 'project', kind: 'doctor', cronExpr: '0 6 * * *',
    timezone: 'UTC', enabled: true, providers: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  const captured = db.select().from(schedules).where(eq(schedules.id, 'schedule')).get()!
  db.update(schedules).set({ updatedAt: '2026-09-05T12:00:00.050Z' }).where(eq(schedules.id, 'schedule')).run()
  freezeClock()

  ;(scheduler as unknown as { registerCronTask: (row: typeof captured) => void }).registerCronTask(captured)

  expect(db.select().from(schedules).where(eq(schedules.id, 'schedule')).get()?.updatedAt)
    .toBe('2026-09-05T12:00:00.051Z')
})

test.each(Object.values(SchedulableRunKinds))('%s ticks and active-run skips never regress the persisted schedule version', (kind) => {
  const { db, scheduler } = harness()
  if (kind === 'traffic-sync') {
    db.insert(trafficSources).values({
      id: 'source', projectId: 'project', sourceType: 'cloud-run', displayName: 'Test source',
      status: 'connected', configJson: {}, createdAt: NOW, updatedAt: NOW,
    }).run()
  }
  db.insert(schedules).values({
    id: 'schedule', projectId: 'project', kind, cronExpr: '0 6 * * *',
    timezone: 'UTC', enabled: true, providers: [], sourceId: kind === 'traffic-sync' ? 'source' : null,
    createdAt: NOW, updatedAt: NOW,
  }).run()
  freezeClock()
  const trigger = () => (scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: SchedulableRunKind) => void
  }).triggerRun('schedule', 'project', kind)

  trigger()
  const first = db.select().from(schedules).where(eq(schedules.id, 'schedule')).get()!
  expect(first.updatedAt).toBe('2026-09-05T12:00:00.001Z')
  expect(first.lastRunAt).toBe(NOW)

  // Answer-visibility, ads-sync, and site-audit now take their active-run
  // reschedule path; the other kinds dispatch their harmless test callbacks.
  vi.setSystemTime(NOW_MS - 60_000)
  trigger()
  const second = db.select().from(schedules).where(eq(schedules.id, 'schedule')).get()!
  expect(second.updatedAt).toBe('2026-09-05T12:00:00.002Z')
})
