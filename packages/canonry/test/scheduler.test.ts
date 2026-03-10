import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
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
    enabled: 1,
    providers: '[]',
    createdAt: now,
    updatedAt: now,
  }).run()

  const createdRunIds: string[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: (runId) => createdRunIds.push(runId),
  })

  scheduler.start()
  assert.equal((scheduler as unknown as { tasks: Map<string, unknown> }).tasks.size, 1)

  db.delete(projects).where(eq(projects.id, 'proj_1')).run()
  ;(scheduler as unknown as { triggerRun: (scheduleId: string, projectId: string) => void }).triggerRun('sched_1', 'proj_1')

  assert.equal(createdRunIds.length, 0)
  assert.equal((scheduler as unknown as { tasks: Map<string, unknown> }).tasks.size, 0)

  scheduler.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
