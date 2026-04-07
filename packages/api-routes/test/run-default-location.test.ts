import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { createClient, migrate, runs, projects } from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'
import { apiRoutes } from '../src/index.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-default-loc-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })

  return { app, db, tmpDir }
}

describe('POST /api/v1/projects/:name/runs — default location', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()

    // Seed project with locations and a defaultLocation
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/loc-proj',
      payload: {
        displayName: 'Location Project',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
        locations: [
          { label: 'michigan', city: 'Detroit', region: 'MI', country: 'US' },
          { label: 'nyc', city: 'New York', region: 'NY', country: 'US' },
        ],
        defaultLocation: 'michigan',
      },
    })

    // Seed project without defaultLocation
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/no-default-proj',
      payload: {
        displayName: 'No Default Project',
        canonicalDomain: 'example2.com',
        country: 'US',
        language: 'en',
        locations: [
          { label: 'sf', city: 'San Francisco', region: 'CA', country: 'US' },
        ],
      },
    })

    // Seed project with a stale defaultLocation — create with valid default, then
    // simulate location removal by directly updating the DB
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/stale-default-proj',
      payload: {
        displayName: 'Stale Default Project',
        canonicalDomain: 'example3.com',
        country: 'US',
        language: 'en',
        locations: [
          { label: 'chicago', city: 'Chicago', region: 'IL', country: 'US' },
        ],
        defaultLocation: 'chicago',
      },
    })
    // Overwrite defaultLocation to a label that no longer exists in locations
    db.update(projects)
      .set({ defaultLocation: 'deleted-location' })
      .where(eq(projects.name, 'stale-default-proj'))
      .run()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('auto-applies defaultLocation when no location flags are provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/loc-proj/runs',
      payload: {},
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)

    // Verify the run was created with the default location
    const run = db.select().from(runs).where(eq(runs.id, body.id)).get()
    expect(run).toBeTruthy()
    expect(run!.location).toBe('michigan')
  })

  it('explicit --location overrides defaultLocation', async () => {
    // Cancel existing run first so project isn't busy
    const allRuns = db.select().from(runs).all()
    for (const r of allRuns) {
      db.update(runs).set({ status: 'completed' }).where(eq(runs.id, r.id)).run()
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/loc-proj/runs',
      payload: { location: 'nyc' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)

    const run = db.select().from(runs).where(eq(runs.id, body.id)).get()
    expect(run!.location).toBe('nyc')
  })

  it('--no-location suppresses defaultLocation', async () => {
    const allRuns = db.select().from(runs).all()
    for (const r of allRuns) {
      db.update(runs).set({ status: 'completed' }).where(eq(runs.id, r.id)).run()
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/loc-proj/runs',
      payload: { noLocation: true },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)

    const run = db.select().from(runs).where(eq(runs.id, body.id)).get()
    expect(run!.location).toBeNull()
  })

  it('no defaultLocation configured leaves location null', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/no-default-proj/runs',
      payload: {},
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)

    const run = db.select().from(runs).where(eq(runs.id, body.id)).get()
    expect(run!.location).toBeNull()
  })

  it('errors when defaultLocation references a non-existent location', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/stale-default-proj/runs',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.message).toContain('deleted-location')
  })
})

describe('POST /api/v1/runs (bulk) — default location', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()

    // Project with defaultLocation
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/bulk-loc-proj',
      payload: {
        displayName: 'Bulk Location Project',
        canonicalDomain: 'bulk-example.com',
        country: 'US',
        language: 'en',
        locations: [
          { label: 'denver', city: 'Denver', region: 'CO', country: 'US' },
        ],
        defaultLocation: 'denver',
      },
    })

    // Project without defaultLocation
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/bulk-no-default',
      payload: {
        displayName: 'Bulk No Default',
        canonicalDomain: 'bulk-nodefault.com',
        country: 'US',
        language: 'en',
      },
    })
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('auto-applies defaultLocation per project in bulk run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: {},
    })
    expect(res.statusCode).toBe(207)
    const results = JSON.parse(res.payload) as Array<{ projectName: string; id: string; status: string }>

    const withDefault = results.find(r => r.projectName === 'bulk-loc-proj')
    expect(withDefault).toBeTruthy()
    expect(withDefault!.status).not.toBe('error')
    const run = db.select().from(runs).where(eq(runs.id, withDefault!.id)).get()
    expect(run!.location).toBe('denver')

    const noDefault = results.find(r => r.projectName === 'bulk-no-default')
    expect(noDefault).toBeTruthy()
    expect(noDefault!.status).not.toBe('error')
    const run2 = db.select().from(runs).where(eq(runs.id, noDefault!.id)).get()
    expect(run2!.location).toBeNull()
  })

  it('reports error for stale defaultLocation in bulk run', async () => {
    // Complete existing runs
    const allRuns = db.select().from(runs).all()
    for (const r of allRuns) {
      db.update(runs).set({ status: 'completed' }).where(eq(runs.id, r.id)).run()
    }

    // Create a project with a stale default
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/bulk-stale',
      payload: {
        displayName: 'Bulk Stale',
        canonicalDomain: 'bulk-stale.com',
        country: 'US',
        language: 'en',
        locations: [
          { label: 'boston', city: 'Boston', region: 'MA', country: 'US' },
        ],
        defaultLocation: 'boston',
      },
    })
    db.update(projects)
      .set({ defaultLocation: 'gone-label' })
      .where(eq(projects.name, 'bulk-stale'))
      .run()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: {},
    })
    expect(res.statusCode).toBe(207)
    const results = JSON.parse(res.payload) as Array<{ projectName: string; status: string; error?: string }>

    const staleResult = results.find(r => r.projectName === 'bulk-stale')
    expect(staleResult).toBeTruthy()
    expect(staleResult!.status).toBe('error')
    expect(staleResult!.error).toContain('gone-label')
  })
})
