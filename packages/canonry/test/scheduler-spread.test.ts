import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, projects, schedules } from '@canonry/canonry-db'

/**
 * Background syncs start at a fixed offset after their cron minute, so every
 * project's hourly jobs do not hit DNS and Google in the same second. The cron
 * library is stubbed so a test can fire a minute by hand.
 */
const cron = vi.hoisted(() => ({ tasks: new Map<string, () => void>() }))
vi.mock('node-cron', () => ({
  default: {
    validate: () => true,
    schedule: (expr: string, fire: () => void) => {
      cron.tasks.set(`${expr}#${cron.tasks.size}`, fire)
      return { stop: () => {}, destroy: () => {} }
    },
  },
}))

const { SCHEDULE_SPREAD_MS, Scheduler, scheduleSpreadMs } = await import('../src/scheduler.js')

describe('scheduleSpreadMs', () => {
  it('gives each project and kind its own stable offset inside the window', () => {
    const offsets = Array.from({ length: 50 }, (_, i) => scheduleSpreadMs(`project-${i}`, 'traffic-sync'))
    expect(offsets.every(ms => ms >= 0 && ms < SCHEDULE_SPREAD_MS)).toBe(true)
    // Stable hour to hour, and actually spread rather than one shared second.
    expect(scheduleSpreadMs('project-1', 'traffic-sync')).toBe(offsets[1])
    expect(new Set(offsets.map(ms => Math.floor(ms / 10_000))).size).toBeGreaterThan(5)
    expect(scheduleSpreadMs('project-1', 'traffic-sync', 0)).toBe(0)
  })
})

describe('a spread scheduler', () => {
  let tmpDir: string
  let db: ReturnType<typeof createClient>
  const synced: string[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    cron.tasks.clear()
    synced.length = 0
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-scheduler-spread-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'proj_1', name: 'spread', displayName: 'Spread', canonicalDomain: 'spread.example',
      country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()
    db.insert(schedules).values({
      id: 'sched_traffic', projectId: 'proj_1', kind: 'traffic-sync', sourceId: 'src_1',
      cronExpr: '0 * * * *', timezone: 'UTC', enabled: true, providers: [], createdAt: now, updatedAt: now,
    }).run()
  })

  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const trafficTick = () => [...cron.tasks.entries()].find(([key]) => key.startsWith('0 * * * *'))![1]

  it('starts a background sync at its offset after the cron minute, not on it', async () => {
    const scheduler = new Scheduler(db, { onRunCreated: () => {}, onTrafficSyncRequested: (name, source) => synced.push(`${name}:${source}`) }, { spreadMs: SCHEDULE_SPREAD_MS })
    scheduler.start()
    const offset = scheduleSpreadMs('proj_1', 'traffic-sync')

    trafficTick()()
    expect(synced).toEqual([])
    await vi.advanceTimersByTimeAsync(offset)
    expect(synced).toEqual(['spread:src_1'])
    scheduler.stop()
  })

  it('keeps one waiting start per schedule, and stopping cancels it', async () => {
    const scheduler = new Scheduler(db, { onRunCreated: () => {}, onTrafficSyncRequested: (name, source) => synced.push(`${name}:${source}`) }, { spreadMs: SCHEDULE_SPREAD_MS })
    scheduler.start()
    trafficTick()()
    trafficTick()()
    await vi.advanceTimersByTimeAsync(SCHEDULE_SPREAD_MS)
    expect(synced).toEqual(['spread:src_1'])

    trafficTick()()
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(SCHEDULE_SPREAD_MS)
    expect(synced).toEqual(['spread:src_1'])
  })

  it('still starts a schedule that ticks more often than its offset', async () => {
    const spreadMs = 600_000
    // The case this guards: an offset longer than the gap between ticks, where
    // replacing the waiting start on every tick would mean it never ran.
    expect(scheduleSpreadMs('proj_1', 'traffic-sync', spreadMs)).toBeGreaterThan(60_000)
    const scheduler = new Scheduler(db, { onRunCreated: () => {}, onTrafficSyncRequested: (name, source) => synced.push(`${name}:${source}`) }, { spreadMs })
    scheduler.start()
    for (let minute = 0; minute < 4; minute++) {
      trafficTick()()
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(synced).toEqual(['spread:src_1'])
    scheduler.stop()
  })

  it('fires on the minute when no spread is configured', () => {
    const scheduler = new Scheduler(db, { onRunCreated: () => {}, onTrafficSyncRequested: (name, source) => synced.push(`${name}:${source}`) })
    scheduler.start()
    trafficTick()()
    expect(synced).toEqual(['spread:src_1'])
    scheduler.stop()
  })
})
