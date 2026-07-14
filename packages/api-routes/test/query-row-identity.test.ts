import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, queries, runs, querySnapshots } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

// Tracked-query rows are the FK anchor for every historical snapshot
// (query_snapshots.query_id is ON DELETE SET NULL). A declarative write whose
// query list is textually unchanged must therefore preserve the EXISTING rows —
// delete-all + reinsert mints new UUIDs, silently orphans all history, and
// breaks the FK-based analytics/dashboard attribution. These tests pin row
// identity across apply and the two replace routes.

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-row-identity-'))
  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db }
}

function applyBody(name: string, over: Record<string, unknown> = {}) {
  return {
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name },
    spec: {
      displayName: 'Demo',
      canonicalDomain: 'demo.example',
      country: 'US',
      language: 'en',
      queries: ['best aeo agency', 'how to rank on chatgpt'],
      ...over,
    },
  }
}

function queryRows(db: ReturnType<typeof createClient>, projectId: string) {
  return db.select().from(queries).where(eq(queries.projectId, projectId)).all()
}

function idsByText(rows: Array<{ id: string; query: string }>): Map<string, string> {
  return new Map(rows.map((r) => [r.query.trim().toLowerCase(), r.id]))
}

function seedSnapshot(db: ReturnType<typeof createClient>, projectId: string, queryId: string, queryText: string): string {
  const runId = crypto.randomUUID()
  const snapId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(runs).values({
    id: runId, projectId, kind: 'answer-visibility', status: 'completed',
    trigger: 'manual', createdAt: now, finishedAt: now,
  }).run()
  db.insert(querySnapshots).values({
    id: snapId, runId, queryId, queryText, provider: 'gemini', citationState: 'cited',
    citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: now,
  }).run()
  return snapId
}

describe('query row identity — POST /apply', () => {
  it('two identical applies leave query row ids (and createdAt) unchanged', async () => {
    const { app, db } = buildApp()
    await app.ready()

    const first = await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo') })
    expect(first.statusCode).toBe(200)
    const projectId = db.select().from(projects).where(eq(projects.name, 'demo')).get()!.id
    const before = queryRows(db, projectId)
    expect(before).toHaveLength(2)

    const second = await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo') })
    expect(second.statusCode).toBe(200)
    const after = queryRows(db, projectId)

    expect(idsByText(after)).toEqual(idsByText(before))
    expect(new Map(after.map((r) => [r.id, r.createdAt]))).toEqual(new Map(before.map((r) => [r.id, r.createdAt])))
  })

  it('an apply changing only canonicalDomain does not touch query rows', async () => {
    const { app, db } = buildApp()
    await app.ready()

    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo') })
    const projectId = db.select().from(projects).where(eq(projects.name, 'demo')).get()!.id
    const before = queryRows(db, projectId)

    const res = await app.inject({
      method: 'POST', url: '/api/v1/apply',
      payload: applyBody('demo', { canonicalDomain: 'renamed.example' }),
    })
    expect(res.statusCode).toBe(200)
    expect(db.select().from(projects).where(eq(projects.name, 'demo')).get()!.canonicalDomain).toBe('renamed.example')

    const after = queryRows(db, projectId)
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort())
  })

  it('snapshots keep their query_id FK across an identical apply', async () => {
    const { app, db } = buildApp()
    await app.ready()

    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo') })
    const projectId = db.select().from(projects).where(eq(projects.name, 'demo')).get()!.id
    const row = queryRows(db, projectId).find((r) => r.query === 'best aeo agency')!
    const snapId = seedSnapshot(db, projectId, row.id, row.query)

    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo') })

    const snap = db.select().from(querySnapshots).where(eq(querySnapshots.id, snapId)).get()!
    expect(snap.queryId).toBe(row.id)
  })

  it('a changed basket only churns the delta: kept text keeps its id, removed goes, added is new', async () => {
    const { app, db } = buildApp()
    await app.ready()

    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo') })
    const projectId = db.select().from(projects).where(eq(projects.name, 'demo')).get()!.id
    const keptId = idsByText(queryRows(db, projectId)).get('best aeo agency')!

    await app.inject({
      method: 'POST', url: '/api/v1/apply',
      payload: applyBody('demo', { queries: ['best aeo agency', 'a brand new query'] }),
    })
    const after = queryRows(db, projectId)
    const map = idsByText(after)
    expect(after).toHaveLength(2)
    expect(map.get('best aeo agency')).toBe(keptId)
    expect(map.has('how to rank on chatgpt')).toBe(false)
    expect(map.has('a brand new query')).toBe(true)
  })

  it('a casing-only change keeps the row id and updates the stored text', async () => {
    const { app, db } = buildApp()
    await app.ready()

    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo') })
    const projectId = db.select().from(projects).where(eq(projects.name, 'demo')).get()!.id
    const keptId = idsByText(queryRows(db, projectId)).get('best aeo agency')!

    await app.inject({
      method: 'POST', url: '/api/v1/apply',
      payload: applyBody('demo', { queries: ['Best AEO Agency', 'how to rank on chatgpt'] }),
    })
    const after = queryRows(db, projectId)
    const renamed = after.find((r) => r.id === keptId)!
    expect(renamed.query).toBe('Best AEO Agency')
  })
})

describe('query row identity — PUT /projects/:name/queries (replace)', () => {
  it('replacing with the identical list preserves row ids', async () => {
    const { app, db } = buildApp()
    await app.ready()
    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo') })
    const projectId = db.select().from(projects).where(eq(projects.name, 'demo')).get()!.id
    const before = queryRows(db, projectId)

    const res = await app.inject({
      method: 'PUT', url: '/api/v1/projects/demo/queries',
      payload: { queries: ['best aeo agency', 'how to rank on chatgpt'] },
    })
    expect(res.statusCode).toBe(200)
    expect(idsByText(queryRows(db, projectId))).toEqual(idsByText(before))
  })

  it('keeps snapshots linked for surviving queries while removed queries detach via the text safety net', async () => {
    const { app, db } = buildApp()
    await app.ready()
    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo') })
    const projectId = db.select().from(projects).where(eq(projects.name, 'demo')).get()!.id
    const rows = queryRows(db, projectId)
    const kept = rows.find((r) => r.query === 'best aeo agency')!
    const removed = rows.find((r) => r.query === 'how to rank on chatgpt')!
    const keptSnap = seedSnapshot(db, projectId, kept.id, kept.query)
    const removedSnap = seedSnapshot(db, projectId, removed.id, removed.query)

    await app.inject({
      method: 'PUT', url: '/api/v1/projects/demo/queries',
      payload: { queries: ['best aeo agency'] },
    })

    const keptRow = db.select().from(querySnapshots).where(eq(querySnapshots.id, keptSnap)).get()!
    const removedRow = db.select().from(querySnapshots).where(eq(querySnapshots.id, removedSnap)).get()!
    expect(keptRow.queryId).toBe(kept.id)
    expect(removedRow.queryId).toBeNull()
    expect(removedRow.queryText).toBe('how to rank on chatgpt')
  })
})

describe('query row identity — PUT /projects/:name/keywords (legacy alias)', () => {
  it('replacing with the identical list preserves row ids', async () => {
    const { app, db } = buildApp()
    await app.ready()
    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: applyBody('demo') })
    const projectId = db.select().from(projects).where(eq(projects.name, 'demo')).get()!.id
    const before = queryRows(db, projectId)

    const res = await app.inject({
      method: 'PUT', url: '/api/v1/projects/demo/keywords',
      payload: { keywords: ['best aeo agency', 'how to rank on chatgpt'] },
    })
    expect(res.statusCode).toBe(200)
    expect(idsByText(queryRows(db, projectId))).toEqual(idsByText(before))
  })
})
