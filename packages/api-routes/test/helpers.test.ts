import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, onTestFinished } from 'vitest'
import { eq } from 'drizzle-orm'
import { createClient, migrate, usageCounters } from '@ainyc/canonry-db'
import { incrementUsage } from '../src/helpers.js'

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-helpers-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return db
}

describe('incrementUsage', () => {
  it('inserts a new counter row on first call', () => {
    const db = createTempDb()
    incrementUsage(db, 'project:test', 'runs')

    const rows = db.select().from(usageCounters)
      .where(eq(usageCounters.scope, 'project:test'))
      .all()

    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(1)
    expect(rows[0].metric).toBe('runs')
  })

  it('increments an existing counter on subsequent calls', () => {
    const db = createTempDb()
    incrementUsage(db, 'project:test', 'runs')
    incrementUsage(db, 'project:test', 'runs')
    incrementUsage(db, 'project:test', 'runs')

    const rows = db.select().from(usageCounters)
      .where(eq(usageCounters.scope, 'project:test'))
      .all()

    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(3)
  })

  it('keeps separate counters for different metrics', () => {
    const db = createTempDb()
    incrementUsage(db, 'project:test', 'runs')
    incrementUsage(db, 'project:test', 'keywords')

    const rows = db.select().from(usageCounters)
      .where(eq(usageCounters.scope, 'project:test'))
      .all()

    expect(rows).toHaveLength(2)
    const byMetric = Object.fromEntries(rows.map(r => [r.metric, r.count]))
    expect(byMetric['runs']).toBe(1)
    expect(byMetric['keywords']).toBe(1)
  })

  it('keeps separate counters for different scopes', () => {
    const db = createTempDb()
    incrementUsage(db, 'project:a', 'runs')
    incrementUsage(db, 'project:b', 'runs')

    const all = db.select().from(usageCounters).all()
    expect(all).toHaveLength(2)
    expect(all.every(r => r.count === 1)).toBe(true)
  })
})
