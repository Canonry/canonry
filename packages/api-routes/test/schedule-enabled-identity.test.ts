import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
import { createClient, migrate, projects, schedules } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'

// A schedule's `enabled` flag is operator state, not config-as-code state.
// Someone pauses a schedule from the dashboard or the API because the sweeps
// were costing money, hitting a broken provider, or running against a client
// who churned. An apply that changes the cron expression is not a request to
// resume that work, so a declarative write must NOT silently flip it back on.
//
// `enabled` is therefore only written when the spec says so: omit it and the
// existing state survives; set it and it is authoritative. A schedule that
// apply CREATES has no prior state to preserve and defaults to enabled.
//
// These tests pin both halves. Delete the `specEnabled === undefined` guard in
// apply.ts and the first test fails.

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-enabled-identity-'))
  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db }
}

function applyBody(name: string, schedule: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) {
  return {
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name },
    spec: {
      displayName: 'Demo',
      canonicalDomain: 'demo.example',
      country: 'US',
      language: 'en',
      queries: ['best aeo agency'],
      ...(schedule === undefined ? {} : { schedule }),
      ...over,
    },
  }
}

function avSchedule(db: ReturnType<typeof createClient>, projectId: string) {
  return db
    .select()
    .from(schedules)
    .where(and(eq(schedules.projectId, projectId), eq(schedules.kind, 'answer-visibility')))
    .get()
}

function projectId(db: ReturnType<typeof createClient>, name: string): string {
  const row = db.select().from(projects).where(eq(projects.name, name)).get()
  if (!row) throw new Error(`project ${name} not found`)
  return row.id
}

describe('schedule enabled state — POST /apply', () => {
  it('advances the current schedule version when an apply runs behind its persisted clock', async () => {
    const { app, db } = buildApp()
    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo', { preset: 'daily' }) })
    const id = projectId(db, 'demo')
    const futureVersion = '2100-01-01T00:00:00.000Z'
    db.update(schedules).set({ updatedAt: futureVersion }).where(eq(schedules.projectId, id)).run()

    const applied = await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo', { preset: 'weekly' }) })
    expect(applied.statusCode).toBe(200)
    expect(avSchedule(db, id)).toMatchObject({ preset: 'weekly', updatedAt: '2100-01-01T00:00:00.001Z' })
    const stale = await app.inject({
      method: 'PUT', url: '/api/v1/projects/demo/schedule',
      payload: { preset: 'daily', expectedUpdatedAt: futureVersion },
    })
    expect(stale.statusCode).toBe(409)
  })

  it('leaves a paused schedule paused when the spec omits enabled', async () => {
    const { app, db } = buildApp()

    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo', { preset: 'daily' }) })
    const id = projectId(db, 'demo')
    expect(avSchedule(db, id)?.enabled).toBe(true)

    // The operator pauses it out of band, the way the dashboard does.
    db.update(schedules).set({ enabled: false }).where(eq(schedules.projectId, id)).run()
    expect(avSchedule(db, id)?.enabled).toBe(false)

    const res = await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo', { preset: 'daily' }) })
    expect(res.statusCode).toBe(200)
    expect(avSchedule(db, id)?.enabled).toBe(false)
  })

  it('still updates cron, timezone and providers while the paused state survives', async () => {
    const { app, db } = buildApp()

    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo', { preset: 'daily' }) })
    const id = projectId(db, 'demo')
    db.update(schedules).set({ enabled: false }).where(eq(schedules.projectId, id)).run()

    await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: applyBody('demo', { cron: '0 6 * * *', timezone: 'America/New_York', providers: ['openai'] }),
    })

    const row = avSchedule(db, id)
    expect(row?.enabled).toBe(false)
    expect(row?.cronExpr).toBe('0 6 * * *')
    expect(row?.timezone).toBe('America/New_York')
    expect(row?.providers).toEqual(['openai'])
  })

  it('pauses an active schedule when the spec sets enabled: false', async () => {
    const { app, db } = buildApp()

    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo', { preset: 'daily' }) })
    const id = projectId(db, 'demo')
    expect(avSchedule(db, id)?.enabled).toBe(true)

    await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: applyBody('demo', { preset: 'daily', enabled: false }),
    })
    expect(avSchedule(db, id)?.enabled).toBe(false)
  })

  it('resumes a paused schedule when the spec sets enabled: true', async () => {
    const { app, db } = buildApp()

    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo', { preset: 'daily' }) })
    const id = projectId(db, 'demo')
    db.update(schedules).set({ enabled: false }).where(eq(schedules.projectId, id)).run()

    await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: applyBody('demo', { preset: 'daily', enabled: true }),
    })
    expect(avSchedule(db, id)?.enabled).toBe(true)
  })

  it('creates a schedule enabled by default, and paused when the spec asks', async () => {
    const { app, db } = buildApp()

    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('on', { preset: 'daily' }) })
    expect(avSchedule(db, projectId(db, 'on'))?.enabled).toBe(true)

    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('off', { preset: 'daily', enabled: false }) })
    expect(avSchedule(db, projectId(db, 'off'))?.enabled).toBe(false)
  })
})
