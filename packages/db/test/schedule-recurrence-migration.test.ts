import { describe, it, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createClient, migrate, projects, schedules } from '../src/index.js'

describe('calendar recurrence migration', () => {
  it('upgrades existing cron schedules without changing their timing and persists calendar schedules across reboot', () => {
    const db = createClient(':memory:')
    migrate(db)
    const now = '2026-09-09T18:00:00.000Z'
    db.insert(projects).values({ id: 'p', name: 'demo', displayName: 'Demo', canonicalDomain: 'example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
    db.insert(schedules).values({ id: 's', projectId: 'p', cronExpr: '0 6 * * *', preset: 'daily', nextRunAt: '2026-09-10T06:00:00.000Z', createdAt: now, updatedAt: now }).run()
    // Reconstruct the previous release's schedule table, then exercise upgrade.
    db.run(sql`ALTER TABLE schedules DROP COLUMN recurrence`)
    db.run(sql`DELETE FROM _migrations WHERE version = 152`)
    migrate(db)
    expect(db.select().from(schedules).get()).toMatchObject({ id: 's', cronExpr: '0 6 * * *', preset: 'daily', recurrence: null, nextRunAt: '2026-09-10T06:00:00.000Z', updatedAt: now })
    const recurrence = { everyDays: 14, startDate: '2026-09-23', time: '00:00' }
    db.update(schedules).set({ cronExpr: '', preset: null, recurrence, timezone: 'America/New_York', nextRunAt: '2026-09-23T04:00:00.000Z' }).where(eq(schedules.id, 's')).run()
    migrate(db)
    expect(db.select().from(schedules).get()).toMatchObject({ recurrence, nextRunAt: '2026-09-23T04:00:00.000Z' })
  })
})
