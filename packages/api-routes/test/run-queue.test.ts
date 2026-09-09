import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, onTestFinished } from 'vitest'
import { createClient, migrate, projects, runs, schedules } from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'
import { RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
import { queueRunIfProjectIdle } from '../src/run-queue.js'

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-run-queue-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  return { db, tmpDir }
}

function seedProject(db: ReturnType<typeof createClient>, id: string, name: string) {
  const now = new Date().toISOString()
  db.insert(projects).values({
    id,
    name,
    displayName: name,
    canonicalDomain: `${name}.com`,
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
}

describe('queueRunIfProjectIdle', () => {
  it.each(Object.values(RunKinds).filter(kind => kind !== RunKinds['answer-visibility']).flatMap(kind =>
    [RunStatuses.queued, RunStatuses.running].map(status => ({ kind, status })),
  ))('allows a visibility sweep alongside $status $kind, but still blocks a duplicate sweep', ({ kind, status }) => {
    const { db, tmpDir } = createTempDb()
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, 'proj_1', 'test-project')
    db.insert(runs).values({
      id: 'other-run', projectId: 'proj_1', kind, status, createdAt: new Date().toISOString(),
    }).run()

    const sweep = queueRunIfProjectIdle(db, { projectId: 'proj_1' })
    expect(sweep.conflict).toBe(false)
    if (sweep.conflict) throw new Error('visibility should not be blocked by another kind')
    expect(queueRunIfProjectIdle(db, { projectId: 'proj_1' }))
      .toEqual({ conflict: true, activeRunId: sweep.runId })
    expect(queueRunIfProjectIdle(db, { projectId: 'proj_1', kind }))
      .toEqual({ conflict: true, activeRunId: 'other-run' })
    expect(db.select().from(runs).all()).toHaveLength(2)
    expect(db.select().from(runs).where(eq(runs.id, 'other-run')).get()?.status).toBe(status)
  })

  it('queues a run when project has no active runs', () => {
    const { db, tmpDir } = createTempDb()
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, 'proj_1', 'test-project')

    const result = queueRunIfProjectIdle(db, { projectId: 'proj_1' })

    expect(result.conflict).toBe(false)
    if (!result.conflict) {
      expect(result.runId).toBeTruthy()
    }

    const queuedRuns = db.select().from(runs).where(eq(runs.projectId, 'proj_1')).all()
    expect(queuedRuns).toHaveLength(1)
    expect(queuedRuns[0].status).toBe(RunStatuses.queued)
  })

  it('reports conflict when a queued run already exists', () => {
    const { db, tmpDir } = createTempDb()
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, 'proj_1', 'test-project')

    const first = queueRunIfProjectIdle(db, { projectId: 'proj_1', trigger: RunTriggers.scheduled })
    expect(first.conflict).toBe(false)

    const second = queueRunIfProjectIdle(db, { projectId: 'proj_1', trigger: RunTriggers.manual })
    expect(second.conflict).toBe(true)

    // Only the first run was inserted
    const allRuns = db.select().from(runs).where(eq(runs.projectId, 'proj_1')).all()
    expect(allRuns).toHaveLength(1)
    expect(allRuns[0].trigger).toBe(RunTriggers.scheduled)
  })

  it('reports conflict when a running run exists', () => {
    const { db, tmpDir } = createTempDb()
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, 'proj_1', 'test-project')

    const first = queueRunIfProjectIdle(db, { projectId: 'proj_1' })
    expect(first.conflict).toBe(false)

    if (!first.conflict) {
      db.update(runs).set({ status: RunStatuses.running }).where(eq(runs.id, first.runId)).run()
    }

    const second = queueRunIfProjectIdle(db, { projectId: 'proj_1' })
    expect(second.conflict).toBe(true)
  })

  it('allows a new run after a previous run completes', () => {
    const { db, tmpDir } = createTempDb()
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, 'proj_1', 'test-project')

    const first = queueRunIfProjectIdle(db, { projectId: 'proj_1' })
    expect(first.conflict).toBe(false)

    if (!first.conflict) {
      db.update(runs).set({ status: RunStatuses.completed, finishedAt: new Date().toISOString() }).where(eq(runs.id, first.runId)).run()
    }

    const second = queueRunIfProjectIdle(db, { projectId: 'proj_1' })
    expect(second.conflict).toBe(false)
  })

  it('allows a new run after a previous run is cancelled', () => {
    const { db, tmpDir } = createTempDb()
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, 'proj_1', 'test-project')

    const first = queueRunIfProjectIdle(db, { projectId: 'proj_1' })
    expect(first.conflict).toBe(false)

    if (!first.conflict) {
      db.update(runs).set({ status: RunStatuses.cancelled, finishedAt: new Date().toISOString() }).where(eq(runs.id, first.runId)).run()
    }

    const second = queueRunIfProjectIdle(db, { projectId: 'proj_1' })
    expect(second.conflict).toBe(false)
  })

  it('allows a new run after a previous run fails', () => {
    const { db, tmpDir } = createTempDb()
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, 'proj_1', 'test-project')

    const first = queueRunIfProjectIdle(db, { projectId: 'proj_1' })
    expect(first.conflict).toBe(false)

    if (!first.conflict) {
      db.update(runs).set({ status: RunStatuses.failed, finishedAt: new Date().toISOString() }).where(eq(runs.id, first.runId)).run()
    }

    const second = queueRunIfProjectIdle(db, { projectId: 'proj_1' })
    expect(second.conflict).toBe(false)
  })

  it('isolates run queues between different projects', () => {
    const { db, tmpDir } = createTempDb()
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, 'proj_1', 'project-a')
    seedProject(db, 'proj_2', 'project-b')

    const a1 = queueRunIfProjectIdle(db, { projectId: 'proj_1' })
    expect(a1.conflict).toBe(false)

    // Project B should still be available despite A being queued
    const b1 = queueRunIfProjectIdle(db, { projectId: 'proj_2' })
    expect(b1.conflict).toBe(false)

    // Project A should still conflict
    const a2 = queueRunIfProjectIdle(db, { projectId: 'proj_1' })
    expect(a2.conflict).toBe(true)
  })

  it('uses default values for kind, trigger, and createdAt', () => {
    const { db, tmpDir } = createTempDb()
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, 'proj_1', 'test-project')

    queueRunIfProjectIdle(db, { projectId: 'proj_1' })

    const run = db.select().from(runs).where(eq(runs.projectId, 'proj_1')).get()!
    expect(run.kind).toBe(RunKinds['answer-visibility'])
    expect(run.trigger).toBe(RunTriggers.manual)
    expect(run.createdAt).toBeTruthy()
  })

  it('respects custom kind, trigger, createdAt, and location', () => {
    const { db, tmpDir } = createTempDb()
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, 'proj_1', 'test-project')

    const customTime = '2026-03-15T12:00:00Z'
    queueRunIfProjectIdle(db, {
      projectId: 'proj_1',
      kind: RunKinds['gsc-sync'],
      trigger: RunTriggers.scheduled,
      createdAt: customTime,
      location: 'NYC',
    })

    const run = db.select().from(runs).where(eq(runs.projectId, 'proj_1')).get()!
    expect(run.kind).toBe(RunKinds['gsc-sync'])
    expect(run.trigger).toBe(RunTriggers.scheduled)
    expect(run.createdAt).toBe(customTime)
    expect(run.location).toBe('NYC')
  })

  it('stores null location when not provided', () => {
    const { db, tmpDir } = createTempDb()
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, 'proj_1', 'test-project')

    queueRunIfProjectIdle(db, { projectId: 'proj_1' })

    const run = db.select().from(runs).where(eq(runs.projectId, 'proj_1')).get()!
    expect(run.location).toBeNull()
  })

  it('returns the exact conflicting run ID', () => {
    const { db, tmpDir } = createTempDb()
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, 'proj_1', 'test-project')

    const first = queueRunIfProjectIdle(db, { projectId: 'proj_1' })
    const second = queueRunIfProjectIdle(db, { projectId: 'proj_1' })

    expect(first.conflict).toBe(false)
    expect(second.conflict).toBe(true)
    if (!first.conflict && second.conflict) {
      expect(second.activeRunId).toBe(first.runId)
    }
  })

  it('rolls back a calendar occurrence claim when queue insertion fails', () => {
    const { db, tmpDir } = createTempDb()
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, 'proj_1', 'test-project')
    const dueAt = '2026-09-23T04:00:00.000Z'
    db.insert(schedules).values({
      id: 'calendar', projectId: 'proj_1', kind: 'answer-visibility', cronExpr: '',
      recurrence: { everyDays: 14, startDate: '2026-09-23', time: '00:00' }, preset: null,
      timezone: 'America/New_York', enabled: true, providers: [], nextRunAt: dueAt,
      createdAt: dueAt, updatedAt: dueAt,
    }).run()
    db.$client.exec("CREATE TRIGGER fail_calendar_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'queue insert failed'); END")

    expect(() => queueRunIfProjectIdle(db, {
      projectId: 'proj_1', kind: 'answer-visibility', trigger: RunTriggers.scheduled,
      scheduleClaim: {
        scheduleId: 'calendar', dueAt, expectedUpdatedAt: dueAt,
        nextRunAt: '2026-10-07T04:00:00.000Z',
      },
    })).toThrow('queue insert failed')
    expect(db.select().from(schedules).where(eq(schedules.id, 'calendar')).get())
      .toMatchObject({ nextRunAt: dueAt, updatedAt: dueAt })
  })

})
