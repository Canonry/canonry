import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { createClient, migrate, runs, queries, parseJsonColumn } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-run-scoped-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db, tmpDir }
}

async function clearActiveRuns(db: ReturnType<typeof createClient>) {
  const allRuns = db.select().from(runs).all()
  for (const r of allRuns) {
    if (r.status === 'queued' || r.status === 'running') {
      db.update(runs).set({ status: 'completed' }).where(eq(runs.id, r.id)).run()
    }
  }
}

describe('POST /api/v1/projects/:name/runs — queries scope', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()

    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/scope-proj',
      payload: {
        displayName: 'Scope Project',
        canonicalDomain: 'scope.example.com',
        country: 'US',
        language: 'en',
      },
    })
    await app.inject({
      method: 'POST',
      url: '/api/v1/projects/scope-proj/queries',
      payload: { queries: ['alpha', 'beta', 'gamma'] },
    })
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('persists scope on the run row when a valid subset is provided', async () => {
    await clearActiveRuns(db)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/scope-proj/runs',
      payload: { queries: ['alpha', 'beta'] },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)
    expect(body.queries).toEqual(['alpha', 'beta'])

    const row = db.select().from(runs).where(eq(runs.id, body.id)).get()
    expect(row).toBeTruthy()
    expect(parseJsonColumn<string[]>(row!.queries, [])).toEqual(['alpha', 'beta'])
  })

  it('leaves queries column null for a full sweep (no queries field)', async () => {
    await clearActiveRuns(db)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/scope-proj/runs',
      payload: {},
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)
    expect(body.queries).toBeNull()

    const row = db.select().from(runs).where(eq(runs.id, body.id)).get()
    expect(row!.queries).toBeNull()
  })

  it('rejects queries not tracked on the project with 400 listing the missing values', async () => {
    await clearActiveRuns(db)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/scope-proj/runs',
      payload: { queries: ['alpha', 'untracked-1', 'untracked-2'] },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toContain('untracked-1')
    expect(body.error.message).toContain('untracked-2')
    expect(body.error.details?.missing).toEqual(['untracked-1', 'untracked-2'])

    // No run inserted on rejection
    const projectRuns = db
      .select()
      .from(runs)
      .where(eq(runs.projectId, db.select().from(queries).get()!.projectId))
      .all()
    expect(projectRuns.every((r) => r.status === 'completed')).toBe(true)
  })

  it('rejects an empty queries array (Zod schema enforcement)', async () => {
    await clearActiveRuns(db)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/scope-proj/runs',
      payload: { queries: [] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('persists scope on every per-location run when combined with allLocations', async () => {
    await clearActiveRuns(db)

    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/scope-proj',
      payload: {
        displayName: 'Scope Project',
        canonicalDomain: 'scope.example.com',
        country: 'US',
        language: 'en',
        locations: [
          { label: 'east', city: 'New York', region: 'NY', country: 'US' },
          { label: 'west', city: 'San Francisco', region: 'CA', country: 'US' },
        ],
      },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/scope-proj/runs',
      payload: { queries: ['alpha'], allLocations: true },
    })
    expect(res.statusCode).toBe(207)
    const body = JSON.parse(res.payload)
    expect(body).toHaveLength(2)
    for (const r of body) {
      expect(r.queries).toEqual(['alpha'])
      const row = db.select().from(runs).where(eq(runs.id, r.id)).get()
      expect(parseJsonColumn<string[]>(row!.queries, [])).toEqual(['alpha'])
    }
  })
})
