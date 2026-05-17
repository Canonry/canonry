import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { createClient, migrate, projects, queries, competitors, runs, querySnapshots, insights, auditLog } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-delete-preview-'))
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

describe('GET /projects/:name/delete-preview', () => {
  it('returns zero counts for a project with nothing attached', async () => {
    const { app, db } = buildApp()
    seedProject(db, 'empty-project')
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/empty-project/delete-preview' })
    expect(res.statusCode).toBe(200)

    const body = res.json() as { project: { name: string }; cascadeRows: Record<string, number>; detachedRows: Record<string, number> }
    expect(body.project.name).toBe('empty-project')
    expect(body.cascadeRows.queries).toBe(0)
    expect(body.cascadeRows.competitors).toBe(0)
    expect(body.cascadeRows.runs).toBe(0)
    expect(body.cascadeRows.snapshots).toBe(0)
    expect(body.cascadeRows.insights).toBe(0)
    expect(body.detachedRows.auditLog).toBe(0)
  })

  it('returns accurate cascade counts for a project with full data', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'full-project')
    const now = new Date().toISOString()

    // 3 queries
    const queryIds = [1, 2, 3].map(() => crypto.randomUUID())
    for (const id of queryIds) {
      db.insert(queries).values({ id, projectId, query: `q-${id.slice(0, 6)}`, createdAt: now }).run()
    }
    // 2 competitors
    for (const _ of [1, 2]) {
      db.insert(competitors).values({ id: crypto.randomUUID(), projectId, domain: `c-${crypto.randomUUID().slice(0, 6)}.com`, createdAt: now }).run()
    }
    // 4 runs
    const runIds = [1, 2, 3, 4].map(() => crypto.randomUUID())
    for (const id of runIds) {
      db.insert(runs).values({ id, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: now, finishedAt: now }).run()
    }
    // 6 snapshots (across runs)
    for (let i = 0; i < 6; i++) {
      const runId = runIds[i % runIds.length]!
      const queryId = queryIds[i % queryIds.length]!
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(), runId, queryId, provider: 'gemini', citationState: 'cited',
        citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: now,
      }).run()
    }
    // 2 insights
    for (const _ of [1, 2]) {
      db.insert(insights).values({
        id: crypto.randomUUID(), projectId, runId: runIds[0]!, type: 'gain', severity: 'low',
        title: 't', query: 'q', provider: 'gemini', dismissed: false, createdAt: now,
      }).run()
    }
    // 5 audit_log rows (these survive — SET NULL on cascade)
    for (let i = 0; i < 5; i++) {
      db.insert(auditLog).values({
        id: crypto.randomUUID(), projectId, actor: 'api', action: `event-${i}`,
        entityType: 'project', entityId: projectId, createdAt: now,
      }).run()
    }

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/full-project/delete-preview' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { cascadeRows: Record<string, number>; detachedRows: Record<string, number> }

    expect(body.cascadeRows.queries).toBe(3)
    expect(body.cascadeRows.competitors).toBe(2)
    expect(body.cascadeRows.runs).toBe(4)
    expect(body.cascadeRows.snapshots).toBe(6)
    expect(body.cascadeRows.insights).toBe(2)
    expect(body.detachedRows.auditLog).toBe(5)
  })

  it('returns 404 for unknown project', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/missing/delete-preview' })
    expect(res.statusCode).toBe(404)
  })

  it('preview does NOT actually delete anything', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'survives')
    const now = new Date().toISOString()
    db.insert(queries).values({ id: crypto.randomUUID(), projectId, query: 'q1', createdAt: now }).run()
    await app.ready()

    await app.inject({ method: 'GET', url: '/api/v1/projects/survives/delete-preview' })

    // Project still exists, query row still exists
    const projectRow = db.select().from(projects).all().find(p => p.name === 'survives')
    expect(projectRow).toBeDefined()
    const queryRow = db.select().from(queries).all().find(q => q.projectId === projectId)
    expect(queryRow).toBeDefined()
  })
})
