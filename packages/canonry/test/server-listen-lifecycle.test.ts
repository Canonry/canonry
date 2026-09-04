import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apiKeys,
  createClient,
  migrate,
  projects,
  queries,
  queryBasketVersions,
  schedules,
} from '@ainyc/canonry-db'

import { createServer, waitForServerRuntimeStartup } from '../src/server.js'
import { Scheduler } from '../src/scheduler.js'

const tempDirs: string[] = []

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-listen-lifecycle-'))
  tempDirs.push(dir)
  const database = path.join(dir, 'data.db')
  const db = createClient(database)
  migrate(db)
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(projects).values({
    id: projectId,
    name: 'existing',
    displayName: 'Existing',
    canonicalDomain: 'existing.example',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(queries).values({
    id: crypto.randomUUID(),
    projectId,
    query: 'existing query',
    createdAt: now,
  }).run()
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'default',
    keyHash: crypto.createHash('sha256').update(apiKey).digest('hex'),
    keyPrefix: apiKey.slice(0, 9),
    scopes: ['*'],
    createdAt: now,
  }).run()
  return { db, database, projectId, apiKey }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('server listen lifecycle', () => {
  it('does not seed schedules or query baskets when the bind fails', async () => {
    const { db, database, apiKey } = fixture()
    const blocker = net.createServer()
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', resolve)
    })
    const address = blocker.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')

    const app = await createServer({
      config: { apiUrl: 'http://127.0.0.1:4100', database, apiKey, providers: {} },
      db,
      logger: false,
    })
    try {
      await expect(app.listen({ host: '127.0.0.1', port: address.port })).rejects.toThrow(/EADDRINUSE/)
      expect(db.select().from(schedules).all()).toHaveLength(0)
      expect(db.select().from(queryBasketVersions).all()).toHaveLength(0)
    } finally {
      await app.close()
      await new Promise<void>((resolve, reject) => blocker.close(err => err ? reject(err) : resolve()))
    }
  })

  it('reconciles after listen and seeds each new project when it is created', async () => {
    const { db, database, projectId, apiKey } = fixture()
    const app = await createServer({
      config: { apiUrl: 'http://127.0.0.1:4100', database, apiKey, providers: {} },
      db,
      logger: false,
    })
    try {
      await app.listen({ host: '127.0.0.1', port: 0 })
      await waitForServerRuntimeStartup(app)
      expect(db.select().from(schedules).where(eq(schedules.projectId, projectId)).all()).toHaveLength(1)
      expect(db.select().from(queryBasketVersions).where(eq(queryBasketVersions.projectId, projectId)).all()).toHaveLength(1)

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          name: 'new-project',
          displayName: 'New project',
          canonicalDomain: 'new.example',
          country: 'US',
          language: 'en',
        },
      })
      expect(created.statusCode).toBe(201)
      const createdProject = db.select().from(projects).where(eq(projects.name, 'new-project')).get()!
      expect(db.select().from(schedules).where(eq(schedules.projectId, createdProject.id)).all()).toHaveLength(1)

      const applied = await app.inject({
        method: 'POST',
        url: '/api/v1/apply',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          apiVersion: 'canonry/v1',
          kind: 'Project',
          metadata: { name: 'applied-project' },
          spec: {
            displayName: 'Applied project',
            canonicalDomain: 'applied.example',
            country: 'US',
            language: 'en',
            notifications: [{
              channel: 'webhook',
              url: 'http://127.0.0.1/hook',
              events: ['run.completed'],
            }],
          },
        },
      })
      expect(applied.statusCode).toBe(200)
      const appliedProject = db.select().from(projects).where(eq(projects.name, 'applied-project')).get()!
      expect(db.select().from(schedules).where(eq(schedules.projectId, appliedProject.id)).all()).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it('exposes critical post-bind runtime startup failures to the serve lifecycle', async () => {
    const { db, database, apiKey } = fixture()
    const start = vi.spyOn(Scheduler.prototype, 'start').mockImplementationOnce(() => {
      throw new Error('scheduler startup failed')
    })
    const app = await createServer({
      config: { apiUrl: 'http://127.0.0.1:4100', database, apiKey, providers: {} },
      db,
      logger: false,
    })
    try {
      await app.listen({ host: '127.0.0.1', port: 0 })
      await expect(waitForServerRuntimeStartup(app)).rejects.toThrow('scheduler startup failed')
      expect(db.select().from(schedules).all()).toHaveLength(0)
      expect(db.select().from(queryBasketVersions).all()).toHaveLength(0)
    } finally {
      start.mockRestore()
      await app.close()
    }
  })
})
