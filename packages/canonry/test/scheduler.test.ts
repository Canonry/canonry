import { test, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, schedules } from '@ainyc/canonry-db'
import { Scheduler } from '../src/scheduler.js'

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-scheduler-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  return { db, tmpDir }
}

test('scheduler removes orphaned tasks after project deletion', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_1',
    name: 'scheduled-project',
    displayName: 'Scheduled Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(schedules).values({
    id: 'sched_1',
    projectId: 'proj_1',
    cronExpr: '* * * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  const createdRunIds: string[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: (runId) => createdRunIds.push(runId),
  })

  scheduler.start()
  expect((scheduler as unknown as { tasks: Map<string, unknown> }).tasks.size).toBe(1)

  db.delete(projects).where(eq(projects.id, 'proj_1')).run()
  ;(scheduler as unknown as { triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'traffic-sync') => void })
    .triggerRun('sched_1', 'proj_1', 'answer-visibility')

  expect(createdRunIds.length).toBe(0)
  expect((scheduler as unknown as { tasks: Map<string, unknown> }).tasks.size).toBe(0)

  scheduler.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('scheduler keys tasks by (projectId, kind) — both kinds can register independently', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_2',
    name: 'multi-kind',
    displayName: 'Multi Kind',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(schedules).values([
    {
      id: 'sched_av',
      projectId: 'proj_2',
      kind: 'answer-visibility',
      cronExpr: '* * * * *',
      timezone: 'UTC',
      enabled: true,
      providers: [],
      sourceId: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'sched_ts',
      projectId: 'proj_2',
      kind: 'traffic-sync',
      cronExpr: '*/30 * * * *',
      timezone: 'UTC',
      enabled: true,
      providers: [],
      sourceId: 'src-uuid',
      createdAt: now,
      updatedAt: now,
    },
  ]).run()

  const scheduler = new Scheduler(db, { onRunCreated: () => {} })
  scheduler.start()
  // Both schedules registered.
  expect((scheduler as unknown as { tasks: Map<string, unknown> }).tasks.size).toBe(2)

  // Remove only the traffic-sync one — the answer-visibility task survives.
  scheduler.remove('proj_2', 'traffic-sync')
  expect((scheduler as unknown as { tasks: Map<string, unknown> }).tasks.size).toBe(1)

  // removeAllForProject clears both.
  scheduler.removeAllForProject('proj_2')
  expect((scheduler as unknown as { tasks: Map<string, unknown> }).tasks.size).toBe(0)

  scheduler.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('traffic-sync trigger fires onTrafficSyncRequested with the configured source ID', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_3',
    name: 'tsync-project',
    displayName: 'Traffic Sync Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_ts2',
    projectId: 'proj_3',
    kind: 'traffic-sync',
    cronExpr: '*/15 * * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    sourceId: 'src-uuid-x',
    createdAt: now,
    updatedAt: now,
  }).run()

  const trafficCalls: Array<{ projectName: string; sourceId: string }> = []
  const runCalls: string[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: (runId) => runCalls.push(runId),
    onTrafficSyncRequested: (projectName, sourceId) => trafficCalls.push({ projectName, sourceId }),
  })

  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'traffic-sync') => void
  }).triggerRun('sched_ts2', 'proj_3', 'traffic-sync')

  expect(trafficCalls).toHaveLength(1)
  expect(trafficCalls[0]).toEqual({ projectName: 'tsync-project', sourceId: 'src-uuid-x' })
  // answer-visibility callback must NOT fire for traffic-sync
  expect(runCalls).toHaveLength(0)

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('traffic-sync trigger skips silently when sourceId is missing', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_4',
    name: 'no-source',
    displayName: 'No Source',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_nosrc',
    projectId: 'proj_4',
    kind: 'traffic-sync',
    cronExpr: '*/15 * * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    sourceId: null,
    createdAt: now,
    updatedAt: now,
  }).run()

  const trafficCalls: unknown[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: () => {},
    onTrafficSyncRequested: () => trafficCalls.push(null),
  })

  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'traffic-sync') => void
  }).triggerRun('sched_nosrc', 'proj_4', 'traffic-sync')

  expect(trafficCalls).toHaveLength(0)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('data-refresh trigger fires onDataRefreshRequested with the project name only', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_dr',
    name: 'refresh-project',
    displayName: 'Refresh Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_dr',
    projectId: 'proj_dr',
    kind: 'data-refresh',
    cronExpr: '30 12 * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  const refreshCalls: string[] = []
  const runCalls: string[] = []
  const trafficCalls: unknown[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: (runId) => runCalls.push(runId),
    onTrafficSyncRequested: () => trafficCalls.push(null),
    onDataRefreshRequested: (projectName) => refreshCalls.push(projectName),
  })

  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'traffic-sync' | 'data-refresh') => void
  }).triggerRun('sched_dr', 'proj_dr', 'data-refresh')

  expect(refreshCalls).toEqual(['refresh-project'])
  // Neither the answer-visibility nor the traffic-sync callback fires for data-refresh.
  expect(runCalls).toHaveLength(0)
  expect(trafficCalls).toHaveLength(0)

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('data-refresh trigger skips silently when no onDataRefreshRequested callback is registered', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_dr2',
    name: 'refresh-no-cb',
    displayName: 'Refresh No Callback',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_dr2',
    projectId: 'proj_dr2',
    kind: 'data-refresh',
    cronExpr: '30 12 * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  const scheduler = new Scheduler(db, { onRunCreated: () => {} })

  expect(() =>
    (scheduler as unknown as {
      triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'traffic-sync' | 'data-refresh') => void
    }).triggerRun('sched_dr2', 'proj_dr2', 'data-refresh'),
  ).not.toThrow()

  fs.rmSync(tmpDir, { recursive: true, force: true })
})
