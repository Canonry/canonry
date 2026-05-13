import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { competitors, createClient, migrate, queries } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

/**
 * Regression suite for the `provenance` invariant introduced in v55:
 *
 *   Every new `queries` / `competitors` row written through the API surface
 *   must carry `provenance = 'cli'`. NULL after the v55 backfill ran means
 *   the writer forgot to set it (a bug per `queryProvenanceSchema`).
 */

interface Ctx {
  app: FastifyInstance
  db: ReturnType<typeof createClient>
  tmpDir: string
}

async function buildCtx(): Promise<Ctx> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-prov-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const app = Fastify()
  await app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
  return { app, db, tmpDir }
}

async function seedProject(app: FastifyInstance) {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/p',
    payload: {
      displayName: 'P',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    },
  })
  expect(res.statusCode).toBe(201)
}

function readQueries(db: Ctx['db']) {
  return db.select().from(queries).all()
}

function readCompetitors(db: Ctx['db']) {
  return db.select().from(competitors).all()
}

describe("provenance writers — every new row must carry 'cli'", () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await buildCtx()
    await seedProject(ctx.app)
  })
  afterEach(async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('PUT /queries sets provenance="cli" on every row', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/p/queries',
      payload: { queries: ['q1', 'q2'] },
    })
    const rows = readQueries(ctx.db)
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.provenance).toBe('cli')
  })

  it('POST /queries sets provenance="cli" on newly-appended rows', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/p/queries',
      payload: { queries: ['seed'] },
    })
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects/p/queries',
      payload: { queries: ['fresh'] },
    })
    const fresh = readQueries(ctx.db).find((r) => r.query === 'fresh')
    expect(fresh?.provenance).toBe('cli')
  })

  it('PUT /keywords (legacy alias) sets provenance="cli"', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/p/keywords',
      payload: { keywords: ['kw1'] },
    })
    const [row] = readQueries(ctx.db)
    expect(row.provenance).toBe('cli')
  })

  it('POST /keywords (legacy alias) sets provenance="cli" on newly-appended rows', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects/p/keywords',
      payload: { keywords: ['kw-fresh'] },
    })
    const [row] = readQueries(ctx.db)
    expect(row.provenance).toBe('cli')
  })

  it('PUT /competitors sets provenance="cli" on every row', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/p/competitors',
      payload: { competitors: ['rival.com', 'foe.com'] },
    })
    const rows = readCompetitors(ctx.db)
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.provenance).toBe('cli')
  })

  it('POST /competitors sets provenance="cli" on newly-appended rows', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/p/competitors',
      payload: { competitors: ['rival.com'] },
    })
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects/p/competitors',
      payload: { competitors: ['newcomer.com'] },
    })
    const newcomer = readCompetitors(ctx.db).find((r) => r.domain === 'newcomer.com')
    expect(newcomer?.provenance).toBe('cli')
  })

  it('POST /apply sets provenance="cli" on queries + competitors', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: {
        apiVersion: 'canonry/v1',
        kind: 'Project',
        metadata: { name: 'p' },
        spec: {
          displayName: 'P',
          canonicalDomain: 'example.com',
          country: 'US',
          language: 'en',
          queries: ['applied-q1', 'applied-q2'],
          competitors: ['applied-rival.com'],
        },
      },
    })
    expect(res.statusCode).toBe(200)

    const project = ctx.db.select().from(queries).all()[0]?.projectId
    expect(project).toBeDefined()

    const qRows = ctx.db.select().from(queries).where(eq(queries.projectId, project!)).all()
    expect(qRows.length).toBeGreaterThanOrEqual(2)
    for (const r of qRows) expect(r.provenance).toBe('cli')

    const cRows = ctx.db.select().from(competitors).where(eq(competitors.projectId, project!)).all()
    expect(cRows.length).toBe(1)
    expect(cRows[0]?.provenance).toBe('cli')
  })
})
