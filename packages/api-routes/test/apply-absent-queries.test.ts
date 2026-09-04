import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, queries } from '@ainyc/canonry-db'
import { apiRoutes, type ApiRoutesOptions } from '../src/index.js'

/**
 * POST /apply with NO queries field must leave the tracked-query basket alone.
 *
 * Observed live 2026-08-29: a control plane re-applies a Project spec carrying
 * providers/locations/metadata only (no queries key) on every boot to converge
 * provider policy. resolveConfigSpecQueries resolved the absent field to [],
 * and replaceProjectQueries then classified EVERY tracked query as removed and
 * deleted the basket, mid-sweep: ~120 in-flight snapshot inserts died on the
 * queries FK and the project ended with zero tracked queries. Absent means
 * "not managing this field"; an explicit empty list stays a deliberate clear.
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function buildApp(callbacks: Pick<ApiRoutesOptions, 'onProjectCreated'> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-absent-queries-'))
  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, allowLoopbackWebhooks: true, ...callbacks })
  return { app, db }
}

function seedProject(db: ReturnType<typeof createClient>, name: string): string {
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects)
    .values({
      id: projectId,
      name,
      displayName: name,
      canonicalDomain: `${name}.example`,
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return projectId
}

function seedQuery(db: ReturnType<typeof createClient>, projectId: string, query: string): void {
  db.insert(queries).values({ id: crypto.randomUUID(), projectId, query, createdAt: new Date().toISOString() }).run()
}

function trackedQueries(db: ReturnType<typeof createClient>, projectId: string): string[] {
  return db
    .select({ query: queries.query })
    .from(queries)
    .where(eq(queries.projectId, projectId))
    .all()
    .map((r) => r.query)
    .sort()
}

const baseConfig = (name: string, specExtras: Record<string, unknown> = {}) => ({
  apiVersion: 'canonry/v1',
  kind: 'Project',
  metadata: { name },
  spec: {
    displayName: name,
    canonicalDomain: `${name}.example`,
    country: 'US',
    language: 'en',
    ...specExtras,
  },
})

describe('POST /apply and the tracked-query basket', () => {
  it('fires project-created even when declarative notifications suppress the legacy upsert callback', async () => {
    const created: Array<{ id: string; name: string }> = []
    const { app, db } = buildApp({
      onProjectCreated: (id, name) => created.push({ id, name }),
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: baseConfig('with-notifications', {
        notifications: [{
          channel: 'webhook',
          url: 'http://127.0.0.1/hook',
          events: ['run.completed'],
        }],
      }),
    })

    expect(res.statusCode).toBe(200)
    const project = db.select().from(projects).where(eq(projects.name, 'with-notifications')).get()!
    expect(created).toEqual([{ id: project.id, name: project.name }])
  })

  it('a spec with NO queries field preserves the existing basket', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'keepers')
    seedQuery(db, projectId, 'roof repair truckee')
    seedQuery(db, projectId, 'roof replacement reno')
    await app.ready()

    const res = await app.inject({ method: 'POST', url: '/api/v1/apply', payload: baseConfig('keepers') })
    expect(res.statusCode).toBe(200)
    expect(trackedQueries(db, projectId)).toEqual(['roof repair truckee', 'roof replacement reno'])
  })

  it('an EXPLICIT empty queries list is still a deliberate clear', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'clearing')
    seedQuery(db, projectId, 'roof repair truckee')
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: baseConfig('clearing', { queries: [] }),
    })
    expect(res.statusCode).toBe(200)
    expect(trackedQueries(db, projectId)).toEqual([])
  })

  it('a spec WITH queries still replaces declaratively', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'replacing')
    seedQuery(db, projectId, 'old query')
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: baseConfig('replacing', { queries: ['new query one', 'new query two'] }),
    })
    expect(res.statusCode).toBe(200)
    expect(trackedQueries(db, projectId)).toEqual(['new query one', 'new query two'])
  })

  it('the legacy keywords alias still counts as managing the field', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'aliased')
    seedQuery(db, projectId, 'old query')
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: baseConfig('aliased', { keywords: ['keyword query'] }),
    })
    expect(res.statusCode).toBe(200)
    expect(trackedQueries(db, projectId)).toEqual(['keyword query'])
  })
})
