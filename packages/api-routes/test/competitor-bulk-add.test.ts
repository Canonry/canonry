import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiKeys, auditLog, competitors, createClient, migrate, projects, runs, type DatabaseClient } from '@canonry/canonry-db'
import { COMPETITOR_BULK_ADD_THRESHOLD } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'

const NOW = '2026-10-11T12:00:00.000Z'
let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-competitor-bulk-add-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: 'bulk-project', name: 'bulk', displayName: 'Synthetic', canonicalDomain: 'synthetic.example',
    ownedDomains: [], country: 'US', language: 'en', providers: ['openai'], locations: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(competitors).values(Array.from({ length: 7 }, (_, i) => ({
    id: `stored-${i}`, projectId: 'bulk-project', domain: `stored-${i}.example`, provenance: 'manual', createdAt: '2026-10-01T12:00:00.000Z',
  }))).run()
  db.insert(runs).values({ id: 'bulk-run', projectId: 'bulk-project', kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: null, createdAt: NOW }).run()
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('competitor bulk add guard', () => {
  it('refuses measured growth over the shared threshold without writing or auditing', async () => {
    const beforeAudits = db.select().from(auditLog).all().length
    const response = await app.inject({
      method: 'POST', url: '/api/v1/projects/bulk/competitors',
      payload: { competitors: Array.from({ length: 6 }, (_, i) => `new-${i}.example`) },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.details).toMatchObject({ reason: 'bulk-add-unacknowledged', limit: COMPETITOR_BULK_ADD_THRESHOLD, trackedBefore: 7, trackedAfter: 13 })
    expect(db.select().from(competitors).all()).toHaveLength(7)
    expect(db.select().from(auditLog).all()).toHaveLength(beforeAudits)
  })

  it('accepts an explicit acknowledgement and records it in the audit diff', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/projects/bulk/competitors',
      payload: { competitors: Array.from({ length: 6 }, (_, i) => `accepted-${i}.example`), acknowledgeBulkAdd: true },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(db.select().from(competitors).all()).toHaveLength(13)
    expect(JSON.parse(String(db.select().from(auditLog).all().at(-1)?.diff))).toMatchObject({ bulkAddAcknowledged: true, bulkAddCount: 6 })
  })

  it('allows five new domains and any size on an unmeasured project', async () => {
    const five = await app.inject({
      method: 'POST', url: '/api/v1/projects/bulk/competitors',
      payload: { competitors: Array.from({ length: 5 }, (_, i) => `five-${i}.example`) },
    })
    expect(five.statusCode, five.body).toBe(200)
    db.insert(projects).values({
      id: 'unmeasured', name: 'unmeasured', displayName: 'Unmeasured', canonicalDomain: 'unmeasured.example',
      ownedDomains: [], country: 'US', language: 'en', providers: ['openai'], locations: [], createdAt: NOW, updatedAt: NOW,
    }).run()
    const preview = await app.inject({
      method: 'POST', url: '/api/v1/projects/unmeasured/competitor-changes/preview',
      payload: { change: 'add', competitors: ['many-0.example', 'many-1.example'] },
    })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json().bulkAdd).toEqual({ limit: 5, count: 2, acknowledgementRequired: false })
    const twenty = await app.inject({
      method: 'POST', url: '/api/v1/projects/unmeasured/competitors',
      payload: { competitors: Array.from({ length: 20 }, (_, i) => `many-${i}.example`) },
    })
    expect(twenty.statusCode, twenty.body).toBe(200)
  })

  it('counts additions cumulatively across the trailing 24 hours', async () => {
    const first = await app.inject({
      method: 'POST', url: '/api/v1/projects/bulk/competitors',
      payload: { competitors: ['rolling-a.example', 'rolling-b.example', 'rolling-c.example'] },
    })
    expect(first.statusCode, first.body).toBe(200)
    const second = await app.inject({
      method: 'POST', url: '/api/v1/projects/bulk/competitors',
      payload: { competitors: ['rolling-d.example', 'rolling-e.example', 'rolling-f.example'] },
    })
    expect(second.statusCode).toBe(400)
    expect(second.json().error.details).toMatchObject({ reason: 'bulk-add-unacknowledged', recentlyAdded: 3, wouldAdd: ['rolling-d.example', 'rolling-e.example', 'rolling-f.example'] })
    db.update(competitors).set({ createdAt: '2026-10-01T12:00:00.000Z' }).where(eq(competitors.projectId, 'bulk-project')).run()
    const afterWindow = await app.inject({
      method: 'POST', url: '/api/v1/projects/bulk/competitors',
      payload: { competitors: ['rolling-d.example', 'rolling-e.example', 'rolling-f.example'] },
    })
    expect(afterWindow.statusCode, afterWindow.body).toBe(200)
  })

  it('counts duplicate and already tracked entries once, and lets alias-only writes and removals pass', async () => {
    const append = await app.inject({
      method: 'POST', url: '/api/v1/projects/bulk/competitors',
      payload: { competitors: ['stored-0.example', 'dedupe-a.example', 'dedupe-a.example', 'dedupe-b.example', 'dedupe-c.example', 'dedupe-d.example'] },
    })
    expect(append.statusCode, append.body).toBe(200)
    const aliases = await app.inject({
      method: 'POST', url: '/api/v1/projects/bulk/competitors',
      payload: { competitors: [{ domain: 'stored-0.example', aliases: ['Stored Rival'] }] },
    })
    expect(aliases.statusCode, aliases.body).toBe(200)
    const remove = await app.inject({ method: 'PUT', url: '/api/v1/projects/bulk/competitors', payload: { competitors: ['stored-0.example'] } })
    expect(remove.statusCode, remove.body).toBe(200)
  })

  it('predicts the same refusal in dry-run as the write guard', async () => {
    const recent = new Date().toISOString()
    db.insert(competitors).values(Array.from({ length: 6 }, (_, i) => ({
      id: `recent-${i}`, projectId: 'bulk-project', domain: `recent-${i}.example`, provenance: 'manual', createdAt: recent,
    }))).run()
    const preview = await app.inject({
      method: 'POST', url: '/api/v1/projects/bulk/competitor-changes/preview',
      payload: { change: 'add', competitors: ['predicted.example'] },
    })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json().bulkAdd).toEqual({ limit: 5, count: 7, acknowledgementRequired: true })
    const write = await app.inject({ method: 'POST', url: '/api/v1/projects/bulk/competitors', payload: { competitors: ['predicted.example'] } })
    expect(write.statusCode).toBe(400)
    expect(write.json().error.details).toMatchObject({ reason: 'bulk-add-unacknowledged', limit: 5, recentlyAdded: 6, wouldAdd: ['predicted.example'] })
  })

  it('treats a probe-only project as unmeasured', async () => {
    db.insert(projects).values({
      id: 'probe-only', name: 'probe-only', displayName: 'Probe Only', canonicalDomain: 'probe-only.example',
      ownedDomains: [], country: 'US', language: 'en', providers: ['openai'], locations: [], createdAt: NOW, updatedAt: NOW,
    }).run()
    db.insert(runs).values({ id: 'probe-only-run', projectId: 'probe-only', kind: 'answer-visibility', status: 'completed', trigger: 'probe', location: null, createdAt: NOW }).run()
    const response = await app.inject({
      method: 'POST', url: '/api/v1/projects/probe-only/competitors',
      payload: { competitors: Array.from({ length: 20 }, (_, i) => `probe-${i}.example`) },
    })
    expect(response.statusCode, response.body).toBe(200)
  })

  it('enforces project and write scope for a real read-only key', async () => {
    db.insert(projects).values({
      id: 'foreign-project', name: 'foreign-project', displayName: 'Foreign', canonicalDomain: 'foreign.example',
      ownedDomains: [], country: 'US', language: 'en', providers: ['openai'], locations: [], createdAt: NOW, updatedAt: NOW,
    }).run()
    const key = 'cnry_bulk_read_key'
    db.insert(apiKeys).values({
      id: 'bulk-read-key', name: 'Bulk read key', keyHash: crypto.createHash('sha256').update(key).digest('hex'),
      keyPrefix: key.slice(0, 8), scopes: ['read'], projectId: 'bulk-project', createdAt: NOW,
    }).run()
    await app.close()
    app = Fastify()
    app.register(apiRoutes, { db })
    await app.ready()
    const headers = { authorization: `Bearer ${key}` }
    expect((await app.inject({ method: 'GET', headers, url: '/api/v1/projects/bulk/competitors' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', headers, url: '/api/v1/projects/foreign-project/competitors' })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', headers, url: '/api/v1/projects/bulk/competitors', payload: { competitors: ['read-write.example'] } })).statusCode).toBe(403)
  })
})
