import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { createClient, migrate, projects, queries, runs, querySnapshots } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queries-replace-preview-'))
  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db }
}

function seedProject(db: ReturnType<typeof createClient>, name: string): string {
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name,
    displayName: name,
    canonicalDomain: `${name}.example`,
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  return projectId
}

function seedQuery(db: ReturnType<typeof createClient>, projectId: string, query: string): string {
  const id = crypto.randomUUID()
  db.insert(queries).values({
    id, projectId, query, createdAt: new Date().toISOString(),
  }).run()
  return id
}

function seedSnapshot(db: ReturnType<typeof createClient>, projectId: string, queryId: string): void {
  const runId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(runs).values({
    id: runId, projectId, kind: 'answer-visibility', status: 'completed',
    trigger: 'manual', createdAt: now, finishedAt: now,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(), runId, queryId, provider: 'gemini', citationState: 'cited',
    citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: now,
  }).run()
}

describe('POST /projects/:name/queries/replace-preview', () => {
  it('returns empty diff and zero snapshot impact for an empty project', async () => {
    const { app, db } = buildApp()
    seedProject(db, 'empty-project')
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/empty-project/queries/replace-preview',
      payload: { queries: ['alpha', 'beta'] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      project: { name: string }
      current: string[]
      proposed: string[]
      diff: { added: string[]; removed: string[]; unchanged: string[] }
      snapshotImpact: { affectedQueries: number; snapshotsDetached: number }
    }
    expect(body.project.name).toBe('empty-project')
    expect(body.current).toEqual([])
    expect(body.proposed).toEqual(['alpha', 'beta'])
    expect(body.diff.added).toEqual(['alpha', 'beta'])
    expect(body.diff.removed).toEqual([])
    expect(body.diff.unchanged).toEqual([])
    expect(body.snapshotImpact.affectedQueries).toBe(0)
    expect(body.snapshotImpact.snapshotsDetached).toBe(0)
  })

  it('computes the diff correctly across overlapping sets', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'overlap')
    seedQuery(db, projectId, 'alpha')
    seedQuery(db, projectId, 'beta')
    seedQuery(db, projectId, 'gamma')
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/overlap/queries/replace-preview',
      payload: { queries: ['beta', 'gamma', 'delta'] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      diff: { added: string[]; removed: string[]; unchanged: string[] }
    }
    expect(body.diff.added.sort()).toEqual(['delta'])
    expect(body.diff.removed.sort()).toEqual(['alpha'])
    expect(body.diff.unchanged.sort()).toEqual(['beta', 'gamma'])
  })

  it('reports snapshot impact: replace wipes all queries → all snapshots for current queries detach', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'with-history')
    const alpha = seedQuery(db, projectId, 'alpha')
    const beta = seedQuery(db, projectId, 'beta')
    // alpha has 3 snapshots, beta has 2
    seedSnapshot(db, projectId, alpha)
    seedSnapshot(db, projectId, alpha)
    seedSnapshot(db, projectId, alpha)
    seedSnapshot(db, projectId, beta)
    seedSnapshot(db, projectId, beta)
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/with-history/queries/replace-preview',
      payload: { queries: ['alpha', 'gamma'] }, // 'alpha' is "unchanged" by text but its row is replaced
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      snapshotImpact: { affectedQueries: number; snapshotsDetached: number }
    }
    // Both alpha + beta's rows go away (replace wipes everything), even though
    // alpha's text reappears. So ALL 5 snapshots detach across 2 query rows.
    expect(body.snapshotImpact.affectedQueries).toBe(2)
    expect(body.snapshotImpact.snapshotsDetached).toBe(5)
  })

  it('returns 404 for unknown project', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/missing/queries/replace-preview',
      payload: { queries: ['alpha'] },
    })
    expect(res.statusCode).toBe(404)
  })

  it('rejects missing queries array', async () => {
    const { app, db } = buildApp()
    seedProject(db, 'noargs')
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/noargs/queries/replace-preview',
      payload: { },
    })
    expect(res.statusCode).toBe(400)
  })

  it('preview does NOT write — current queries and snapshots survive', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'survives')
    const alpha = seedQuery(db, projectId, 'alpha')
    seedSnapshot(db, projectId, alpha)
    await app.ready()

    await app.inject({
      method: 'POST',
      url: '/api/v1/projects/survives/queries/replace-preview',
      payload: { queries: ['totally-different'] },
    })

    const queryRows = db.select().from(queries).all().filter(q => q.projectId === projectId)
    expect(queryRows).toHaveLength(1)
    expect(queryRows[0]!.query).toBe('alpha')
    const snapshotRows = db.select().from(querySnapshots).all().filter(s => s.queryId === alpha)
    expect(snapshotRows).toHaveLength(1)
  })
})
