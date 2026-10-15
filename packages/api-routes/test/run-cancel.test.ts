import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { createClient, migrate, runs } from '@canonry/canonry-db'
import { eq, sql } from 'drizzle-orm'
import { apiRoutes } from '../src/index.js'

function buildApp(onRunCancelled?: (runId: string, projectId: string) => void) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-cancel-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, onRunCancelled })

  return { app, db, tmpDir }
}

describe('POST /api/v1/runs/:id/cancel', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()

    // Seed a project
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/test-proj',
      payload: {
        displayName: 'Test Project',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
      },
    })
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('cancels a queued run', async () => {
    // Create a run
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-proj/runs',
      payload: {},
    })
    expect(createRes.statusCode).toBe(201)
    const run = JSON.parse(createRes.payload)
    expect(run.status).toBe('queued')

    // Cancel it
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${run.id}/cancel`,
    })
    expect(cancelRes.statusCode).toBe(200)
    const cancelled = JSON.parse(cancelRes.payload)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.finishedAt).toBeTruthy()
    expect(cancelled.error).toEqual({ message: 'Cancelled by user' })
  })

  it('cancels a running run', async () => {
    // Create and manually transition to running
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-proj/runs',
      payload: {},
    })
    expect(createRes.statusCode).toBe(201)
    const run = JSON.parse(createRes.payload)

    // Transition to running
    db.update(runs)
      .set({ status: 'running', startedAt: new Date().toISOString() })
      .where(eq(runs.id, run.id))
      .run()

    // Cancel it
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${run.id}/cancel`,
    })
    expect(cancelRes.statusCode).toBe(200)
    const cancelled = JSON.parse(cancelRes.payload)
    expect(cancelled.status).toBe('cancelled')
  })

  it('notifies a host executor only after durable cancellation', async () => {
    const events: Array<{ runId: string; projectId: string; status: string }> = []
    const isolated = buildApp((runId, projectId) => {
      events.push({
        runId,
        projectId,
        status: isolated.db.select().from(runs).where(eq(runs.id, runId)).get()!.status,
      })
    })
    await isolated.app.ready()
    await isolated.app.inject({ method: 'PUT', url: '/api/v1/projects/callback-proj', payload: { displayName: 'Callback', canonicalDomain: 'example.com', country: 'US', language: 'en' } })
    const created = await isolated.app.inject({ method: 'POST', url: '/api/v1/projects/callback-proj/runs', payload: {} })
    const run = JSON.parse(created.payload)
    await isolated.app.inject({ method: 'POST', url: `/api/v1/runs/${run.id}/cancel` })
    expect(events).toEqual([{ runId: run.id, projectId: expect.any(String), status: 'cancelled' }])
    await isolated.app.close()
    fs.rmSync(isolated.tmpDir, { recursive: true, force: true })
  })

  it('rejects cancellation of a completed run', async () => {
    // Create and manually transition to completed
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-proj/runs',
      payload: {},
    })
    expect(createRes.statusCode).toBe(201)
    const run = JSON.parse(createRes.payload)

    db.update(runs)
      .set({ status: 'completed', finishedAt: new Date().toISOString() })
      .where(eq(runs.id, run.id))
      .run()

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${run.id}/cancel`,
    })
    expect(cancelRes.statusCode).toBe(409)
    const body = JSON.parse(cancelRes.payload)
    expect(body.error.code).toBe('RUN_NOT_CANCELLABLE')
  })

  it('does not overwrite a terminal transition that wins the cancellation race', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/v1/projects/test-proj/runs', payload: {} })
    const run = JSON.parse(createRes.payload)
    db.update(runs).set({ status: 'running', startedAt: new Date().toISOString() }).where(eq(runs.id, run.id)).run()

    // Simulate the executor completing after the route's initial read but
    // before the durable cancellation update. RAISE(IGNORE) preserves the
    // trigger's completed transition and turns the outer update into zero rows.
    db.run(sql.raw(`CREATE TRIGGER complete_before_cancel
      BEFORE UPDATE OF status ON runs
      WHEN OLD.id = '${run.id}' AND OLD.status = 'running' AND NEW.status = 'cancelled'
      BEGIN
        UPDATE runs SET status = 'completed', finished_at = '2026-08-08T00:00:00.000Z' WHERE id = OLD.id;
        SELECT RAISE(IGNORE);
      END`))

    const cancelRes = await app.inject({ method: 'POST', url: `/api/v1/runs/${run.id}/cancel` })
    expect(cancelRes.statusCode).toBe(409)
    expect(db.select().from(runs).where(eq(runs.id, run.id)).get()?.status).toBe('completed')
  })

  it('returns 404 for non-existent run', async () => {
    const cancelRes = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/non-existent-id/cancel',
    })
    expect(cancelRes.statusCode).toBe(404)
  })

  it('allows a new run after cancellation', async () => {
    // Create a run
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-proj/runs',
      payload: {},
    })
    expect(createRes.statusCode).toBe(201)
    const run = JSON.parse(createRes.payload)

    // Cancel it
    await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${run.id}/cancel`,
    })

    // New run should work (no longer blocked)
    const newRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-proj/runs',
      payload: {},
    })
    expect(newRes.statusCode).toBe(201)
    const newRun = JSON.parse(newRes.payload)
    expect(newRun.status).toBe('queued')

    // Clean up for other tests
    await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${newRun.id}/cancel`,
    })
  })
})
