import { test, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, schedules, runs } from '@ainyc/canonry-db'
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

test('gbp-sync trigger creates a run row and fires onGbpSyncRequested', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_gbp',
    name: 'gbp-project',
    displayName: 'GBP Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_gbp',
    projectId: 'proj_gbp',
    kind: 'gbp-sync',
    cronExpr: '0 6 * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    sourceId: null,
    createdAt: now,
    updatedAt: now,
  }).run()

  const gbpCalls: Array<{ runId: string; projectId: string }> = []
  const runCalls: string[] = []
  const trafficCalls: unknown[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: (runId) => runCalls.push(runId),
    onTrafficSyncRequested: () => trafficCalls.push(null),
    onGbpSyncRequested: (runId, projectId) => gbpCalls.push({ runId, projectId }),
  })

  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'traffic-sync' | 'gbp-sync') => void
  }).triggerRun('sched_gbp', 'proj_gbp', 'gbp-sync')

  // The callback fired once with the created run row id.
  expect(gbpCalls).toHaveLength(1)
  expect(gbpCalls[0]!.projectId).toBe('proj_gbp')

  // A gbp-sync run row was created with trigger=scheduled.
  const runRow = db.select().from(runs).where(eq(runs.id, gbpCalls[0]!.runId)).get()
  expect(runRow).toBeDefined()
  expect(runRow!.kind).toBe('gbp-sync')
  expect(runRow!.trigger).toBe('scheduled')
  expect(runRow!.status).toBe('queued')
  expect(runRow!.projectId).toBe('proj_gbp')

  // lastRunAt advanced on the schedule row.
  const sched = db.select().from(schedules).where(eq(schedules.id, 'sched_gbp')).get()
  expect(sched!.lastRunAt).not.toBeNull()

  // The other kinds' callbacks must NOT fire for a gbp-sync trigger.
  expect(runCalls).toHaveLength(0)
  expect(trafficCalls).toHaveLength(0)

  scheduler.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('gbp-sync trigger skips silently when no callback is registered', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_gbp2',
    name: 'gbp-project-2',
    displayName: 'GBP Project 2',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_gbp2',
    projectId: 'proj_gbp2',
    kind: 'gbp-sync',
    cronExpr: '0 6 * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    sourceId: null,
    createdAt: now,
    updatedAt: now,
  }).run()

  // No onGbpSyncRequested callback registered.
  const scheduler = new Scheduler(db, { onRunCreated: () => {} })

  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'traffic-sync' | 'gbp-sync') => void
  }).triggerRun('sched_gbp2', 'proj_gbp2', 'gbp-sync')

  // No orphan run row should be created when the host can't run the sync.
  const runRows = db.select().from(runs).where(eq(runs.projectId, 'proj_gbp2')).all()
  expect(runRows).toHaveLength(0)

  scheduler.stop()
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

test('backlinks-sync trigger fires onBacklinksSyncRequested with the project name and creates no run row', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_bl',
    name: 'backlinks-project',
    displayName: 'Backlinks Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_bl',
    projectId: 'proj_bl',
    kind: 'backlinks-sync',
    cronExpr: '0 4 * * 1',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  const backlinksCalls: string[] = []
  const runCalls: string[] = []
  const refreshCalls: unknown[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: (runId) => runCalls.push(runId),
    onDataRefreshRequested: () => refreshCalls.push(null),
    onBacklinksSyncRequested: (projectName) => backlinksCalls.push(projectName),
  })

  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'backlinks-sync') => void
  }).triggerRun('sched_bl', 'proj_bl', 'backlinks-sync')

  expect(backlinksCalls).toEqual(['backlinks-project'])

  // Workspace-global sync — the scheduler creates NO per-project run row.
  const runRows = db.select().from(runs).where(eq(runs.projectId, 'proj_bl')).all()
  expect(runRows).toHaveLength(0)

  // lastRunAt advanced on the schedule row.
  const sched = db.select().from(schedules).where(eq(schedules.id, 'sched_bl')).get()
  expect(sched!.lastRunAt).not.toBeNull()

  // Other kinds' callbacks must NOT fire for a backlinks-sync trigger.
  expect(runCalls).toHaveLength(0)
  expect(refreshCalls).toHaveLength(0)

  scheduler.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('backlinks-sync trigger skips silently when no onBacklinksSyncRequested callback is registered', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_bl2',
    name: 'backlinks-no-cb',
    displayName: 'Backlinks No Callback',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_bl2',
    projectId: 'proj_bl2',
    kind: 'backlinks-sync',
    cronExpr: '0 4 * * 1',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  const scheduler = new Scheduler(db, { onRunCreated: () => {} })

  expect(() =>
    (scheduler as unknown as {
      triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'backlinks-sync') => void
    }).triggerRun('sched_bl2', 'proj_bl2', 'backlinks-sync'),
  ).not.toThrow()

  fs.rmSync(tmpDir, { recursive: true, force: true })
})
