import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { buildProviderRunError, serializeRunError } from '@ainyc/canonry-contracts'
import { createClient, migrate, projects, queries, runs, schedules } from '@ainyc/canonry-db'
import { addLogListener, type LogEntry } from '../src/logger.js'
import { Scheduler } from '../src/scheduler.js'

// A schedule cannot pass `force`, so when every provider keeps failing on its
// account the scheduler skips the slot instead of queueing another run that
// would fail the same way, and moves the schedule on to its next slot.

const NOW = '2026-10-07T06:00:00.000Z'
/** The documented admission threshold (OpenAPI, MCP tool description). */
const STREAK = 10

let removeListener: (() => void) | null = null
afterEach(() => {
  removeListener?.()
  removeListener = null
})

it('skips a scheduled sweep while every provider fails on its account, and advances the schedule', () => {
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
  for (let i = 0; i < STREAK; i += 1) {
    db.insert(runs).values({
      id: crypto.randomUUID(), projectId, kind: 'answer-visibility', status: 'failed', trigger: 'scheduled',
      error: serializeRunError(buildProviderRunError([['openai', '[provider-openai] 401 Incorrect API key provided']])),
      createdAt: new Date(Date.UTC(2026, 9, 1, i)).toISOString(),
    }).run()
  }
  db.insert(schedules).values({
    id: 'sched_stuck', projectId, cronExpr: '0 6 * * *', timezone: 'UTC', enabled: true, providers: [],
    nextRunAt: NOW, createdAt: NOW, updatedAt: NOW,
  }).run()

  const logs: LogEntry[] = []
  removeListener = addLogListener(entry => { if (entry.module === 'Scheduler') logs.push(entry) })
  const created: string[] = []
  const scheduler = new Scheduler(db, { onRunCreated: runId => created.push(runId), getRunnableProviderNames: () => ['openai'] })
  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility') => void
  }).triggerRun('sched_stuck', projectId, 'answer-visibility')

  expect(created).toEqual([])
  expect(db.select().from(runs).all()).toHaveLength(STREAK)
  expect(logs.find(entry => entry.action === 'run.skipped-providers-failing')).toMatchObject({
    level: 'warn', projectName: 'stuck', providers: { openai: 'PROVIDER_AUTH' },
  })
  expect(db.select().from(schedules).where(eq(schedules.id, 'sched_stuck')).get()?.nextRunAt).not.toBe(NOW)
})
