/**
 * Cloud-mode flag tests for the Scheduler (Track 1 — Canonry Hosted).
 *
 * The `CANONRY_SCHEDULER=external` flag is read at module load and frozen
 * for the lifetime of the process — that's intentional, so the in-process
 * scheduler can be deterministically disabled in cloud deployments.
 *
 * Vitest gives us module isolation through `vi.resetModules()` plus a
 * pre-import env mutation, so each test gets a fresh Scheduler with the
 * env it set.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, projects, schedules } from '@ainyc/canonry-db'

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-cloud-sched-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  return { db, tmpDir }
}

function seedEnabledSchedule(db: ReturnType<typeof createClient>) {
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: 'proj_1', name: 'cloud-sched',
    displayName: 'Cloud Sched', canonicalDomain: 'example.com',
    country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_1', projectId: 'proj_1', cronExpr: '* * * * *',
    timezone: 'UTC', enabled: true, providers: [],
    createdAt: now, updatedAt: now,
  }).run()
}

describe('Scheduler — CANONRY_SCHEDULER=external (Track 1)', () => {
  const originalEnv = process.env.CANONRY_SCHEDULER

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CANONRY_SCHEDULER
    } else {
      process.env.CANONRY_SCHEDULER = originalEnv
    }
    vi.resetModules()
  })

  it('registers cron tasks when CANONRY_SCHEDULER is unset (OSS default)', async () => {
    delete process.env.CANONRY_SCHEDULER
    vi.resetModules()
    const { Scheduler } = await import('../src/scheduler.js')
    const { db, tmpDir } = createTempDb()
    seedEnabledSchedule(db)

    const scheduler = new Scheduler(db, { onRunCreated: () => {} })
    scheduler.start()
    try {
      expect((scheduler as unknown as { tasks: Map<string, unknown> }).tasks.size).toBe(1)
    } finally {
      scheduler.stop()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does NOT register cron tasks when CANONRY_SCHEDULER=external', async () => {
    process.env.CANONRY_SCHEDULER = 'external'
    vi.resetModules()
    const { Scheduler } = await import('../src/scheduler.js')
    const { db, tmpDir } = createTempDb()
    seedEnabledSchedule(db)

    const scheduler = new Scheduler(db, { onRunCreated: () => {} })
    scheduler.start()
    try {
      // Empty tasks map proves no cron registration happened — the control
      // plane is responsible for firing runs in cloud mode.
      expect((scheduler as unknown as { tasks: Map<string, unknown> }).tasks.size).toBe(0)
    } finally {
      scheduler.stop()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('upsert is a no-op in cloud mode (does not register new tasks)', async () => {
    process.env.CANONRY_SCHEDULER = 'external'
    vi.resetModules()
    const { Scheduler } = await import('../src/scheduler.js')
    const { db, tmpDir } = createTempDb()
    seedEnabledSchedule(db)

    const scheduler = new Scheduler(db, { onRunCreated: () => {} })
    scheduler.upsert('proj_1', 'answer-visibility')
    try {
      expect((scheduler as unknown as { tasks: Map<string, unknown> }).tasks.size).toBe(0)
    } finally {
      scheduler.stop()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('treats arbitrary non-"external" values as the OSS default', async () => {
    // Operator typo guard: only the exact string `external` flips the
    // scheduler off. Anything else (`disabled`, `cloud`, `1`) preserves
    // OSS behavior so a misconfigured tenant doesn't silently stop running
    // sweeps.
    process.env.CANONRY_SCHEDULER = 'cloud'
    vi.resetModules()
    const { Scheduler } = await import('../src/scheduler.js')
    const { db, tmpDir } = createTempDb()
    seedEnabledSchedule(db)

    const scheduler = new Scheduler(db, { onRunCreated: () => {} })
    scheduler.start()
    try {
      expect((scheduler as unknown as { tasks: Map<string, unknown> }).tasks.size).toBe(1)
    } finally {
      scheduler.stop()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
