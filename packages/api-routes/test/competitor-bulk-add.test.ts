import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditLog, competitors, createClient, migrate, projects, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { COMPETITOR_BULK_ADD_THRESHOLD } from '@ainyc/canonry-contracts'
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
    const twenty = await app.inject({
      method: 'POST', url: '/api/v1/projects/unmeasured/competitors',
      payload: { competitors: Array.from({ length: 20 }, (_, i) => `many-${i}.example`) },
    })
    expect(twenty.statusCode, twenty.body).toBe(200)
  })
})
