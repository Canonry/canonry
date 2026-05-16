import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { and, eq, or } from 'drizzle-orm'
import { createClient, migrate, runs } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-run-all-loc-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db, tmpDir }
}

async function seedProjectWithLocations(app: ReturnType<typeof Fastify>) {
  await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/multi-loc',
    payload: {
      displayName: 'Multi-location',
      canonicalDomain: 'multi-loc.example.com',
      country: 'US',
      language: 'en',
      locations: [
        { label: 'east', city: 'New York', region: 'NY', country: 'US' },
        { label: 'west', city: 'San Francisco', region: 'CA', country: 'US' },
        { label: 'south', city: 'Austin', region: 'TX', country: 'US' },
      ],
    },
  })
}

describe('POST /api/v1/projects/:name/runs with allLocations respects the idle lock', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string

  beforeEach(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()
    await seedProjectWithLocations(app)
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function projectIdFor(name: string): string {
    // Pull from the runs table after a sweep, or from the API. Simplest: read
    // the project row directly via the same DB the route plugin uses.
    const row = db
      .select({ projectId: runs.projectId })
      .from(runs)
      .all()
    if (row.length > 0) return row[0]!.projectId
    // Fallback: synthesize a UUID; the test will fail before using this when
    // setup is correct.
    return name
  }

  it('returns 409 RUN_IN_PROGRESS when a queued run already exists for the project', async () => {
    // First, kick off a single-location run to learn the project_id (read
    // via runs.projectId since the projects route doesn't return the UUID).
    const seedRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/multi-loc/runs',
      payload: { location: 'east' },
    })
    expect(seedRes.statusCode).toBe(201)
    const projectId = projectIdFor('multi-loc')

    // The seed run is still queued — leave it that way to simulate the
    // "another sweep is already going" condition. Now try allLocations.
    const allLocRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/multi-loc/runs',
      payload: { allLocations: true },
    })

    expect(allLocRes.statusCode).toBe(409)
    const body = JSON.parse(allLocRes.payload) as { error: { code: string } }
    expect(body.error.code).toBe('RUN_IN_PROGRESS')

    // Critically: no new run rows were inserted. Only the seed run exists.
    const allRunsAfter = db
      .select()
      .from(runs)
      .where(eq(runs.projectId, projectId))
      .all()
    expect(allRunsAfter).toHaveLength(1)
  })

  it('returns 409 when a running run is already in flight', async () => {
    // Seed a project row by triggering a run we then promote to "running".
    const seedRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/multi-loc/runs',
      payload: { location: 'east' },
    })
    expect(seedRes.statusCode).toBe(201)
    const seedBody = JSON.parse(seedRes.payload) as { id: string }
    db.update(runs).set({ status: 'running' }).where(eq(runs.id, seedBody.id)).run()
    const projectId = projectIdFor('multi-loc')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/multi-loc/runs',
      payload: { allLocations: true },
    })

    expect(res.statusCode).toBe(409)
    const allRunsAfter = db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          or(eq(runs.status, 'queued'), eq(runs.status, 'running')),
        ),
      )
      .all()
    expect(allRunsAfter).toHaveLength(1) // only the original running run
    expect(allRunsAfter[0]!.id).toBe(seedBody.id)
  })

  it('succeeds with 207 and creates one run per location when project is idle', async () => {
    // Sanity: with no active runs, allLocations still fans out as before.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/multi-loc/runs',
      payload: { allLocations: true },
    })
    expect(res.statusCode).toBe(207)
    const body = JSON.parse(res.payload) as unknown[]
    expect(body).toHaveLength(3)
    const projectId = projectIdFor('multi-loc')
    const queued = db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          or(eq(runs.status, 'queued'), eq(runs.status, 'running')),
        ),
      )
      .all()
    expect(queued).toHaveLength(3)
  })

  it('a second allLocations call while the first is in-flight is rejected (no double-fan-out)', async () => {
    // First call fans out 3 runs (idle precondition satisfied).
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/multi-loc/runs',
      payload: { allLocations: true },
    })
    expect(first.statusCode).toBe(207)
    const projectId = projectIdFor('multi-loc')

    // Second call must see "active run(s) on this project" and refuse.
    // Pre-fix, the route bypassed the idle check entirely and inserted
    // another 3 runs on top of the existing 3 — concurrent provider calls,
    // double billing, racing snapshots.
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/multi-loc/runs',
      payload: { allLocations: true },
    })
    expect(second.statusCode).toBe(409)

    // Still exactly 3 active runs — no duplication.
    const queued = db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          or(eq(runs.status, 'queued'), eq(runs.status, 'running')),
        ),
      )
      .all()
    expect(queued).toHaveLength(3)
  })
})
