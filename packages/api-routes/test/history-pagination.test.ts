import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditLog, createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let projectId: string

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-history-pagination-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  projectId = crypto.randomUUID()
  const now = '2026-09-11T12:00:00.000Z'
  db.insert(projects).values({
    id: projectId,
    name: 'history-page',
    displayName: 'History page',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: [],
    locations: [],
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(auditLog).values(Array.from({ length: 505 }, (_, index) => ({
    id: `entry-${String(index).padStart(4, '0')}`,
    projectId,
    actor: 'api',
    action: 'project.updated',
    entityType: 'project',
    entityId: projectId,
    diff: null,
    createdAt: now,
  }))).run()
  db.insert(auditLog).values([
    { id: 'legacy-api', projectId, actor: 'api', action: 'legacy', entityType: 'project', entityId: projectId, diff: null, createdAt: '2026-09-11T13:00:00.000Z' },
    { id: 'key-api', projectId, actor: 'api-key:key-1', action: 'key', entityType: 'project', entityId: projectId, diff: null, createdAt: '2026-09-11T13:00:00.000Z' },
    { id: 'user-api', projectId, actor: 'user:user-1', action: 'user', entityType: 'project', entityId: projectId, diff: null, createdAt: '2026-09-11T13:00:00.000Z' },
    { id: 'custom', projectId, actor: 'scheduler', action: 'scheduler', entityType: 'project', entityId: projectId, diff: null, createdAt: '2026-09-11T13:00:00.000Z' },
  ]).run()
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('audit history pagination', () => {
  it('uses createdAt DESC, id DESC to provide non-overlapping offset pages beyond 500 rows', async () => {
    const first = await app.inject('/api/v1/projects/history-page/history?limit=500&offset=0')
    const second = await app.inject('/api/v1/projects/history-page/history?limit=500&offset=500')

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    const firstIds = (first.json() as Array<{ id: string }>).map(entry => entry.id)
    const secondIds = (second.json() as Array<{ id: string }>).map(entry => entry.id)
    const tiedIds = Array.from({ length: 505 }, (_, index) => `entry-${String(index).padStart(4, '0')}`).reverse()
    expect(firstIds).toHaveLength(500)
    expect(secondIds).toHaveLength(9)
    expect(firstIds).toEqual(['user-api', 'legacy-api', 'key-api', 'custom', ...tiedIds.slice(0, 496)])
    expect(secondIds).toEqual(tiedIds.slice(496))
    expect(new Set([...firstIds, ...secondIds])).toHaveLength(509)
  })

  it('keeps actor=api compatible with legacy and authenticated HTTP principal actors', async () => {
    const category = await app.inject('/api/v1/projects/history-page/history?actor=api&limit=10')
    const exact = await app.inject('/api/v1/projects/history-page/history?actor=api-key:key-1&limit=10')

    expect((category.json() as Array<{ id: string }>).map(entry => entry.id).slice(0, 3)).toEqual(['user-api', 'legacy-api', 'key-api'])
    expect((exact.json() as Array<{ id: string }>).map(entry => entry.id)).toEqual(['key-api'])
  })
})
