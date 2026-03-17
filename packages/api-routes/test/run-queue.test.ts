import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, onTestFinished } from 'vitest'
import { createClient, migrate, projects, runs } from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'
import { queueRunIfProjectIdle } from '../src/run-queue.js'

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-run-queue-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  return { db, tmpDir }
}

test('queueRunIfProjectIdle queues once and reports conflicts afterward', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_1',
    name: 'test-project',
    displayName: 'Test Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  const first = queueRunIfProjectIdle(db, {
    createdAt: now,
    projectId: 'proj_1',
    trigger: 'scheduled',
  })
  expect(first.conflict).toBe(false)

  const second = queueRunIfProjectIdle(db, {
    createdAt: now,
    projectId: 'proj_1',
    trigger: 'manual',
  })
  expect(second.conflict).toBe(true)

  const queuedRuns = db.select().from(runs).where(eq(runs.projectId, 'proj_1')).all()
  expect(queuedRuns).toHaveLength(1)
  expect(queuedRuns[0]!.trigger).toBe('scheduled')
})
