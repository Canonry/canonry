import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
import { createClient, migrate, projects, schedules, trafficSources } from '@ainyc/canonry-db'
import { SchedulableRunKinds, TrafficSourceStatuses, TrafficSourceTypes } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'

interface Harness {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  projectId: string
  trafficSourceId: string
  otherProjectId: string
  otherTrafficSourceId: string
}

async function buildHarness(): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  const otherProjectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'site-a',
    displayName: 'Site A',
    canonicalDomain: 'site-a.example.com',
    ownedDomains: '[]',
    country: 'US',
    language: 'en',
    tags: '[]',
    labels: '{}',
    providers: '[]',
    locations: '[]',
    defaultLocation: null,
    autoExtractBacklinks: 0,
    configSource: 'api',
    configRevision: 1,
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(projects).values({
    id: otherProjectId,
    name: 'site-b',
    displayName: 'Site B',
    canonicalDomain: 'site-b.example.com',
    ownedDomains: '[]',
    country: 'US',
    language: 'en',
    tags: '[]',
    labels: '{}',
    providers: '[]',
    locations: '[]',
    defaultLocation: null,
    autoExtractBacklinks: 0,
    configSource: 'api',
    configRevision: 1,
    createdAt: now,
    updatedAt: now,
  }).run()

  const trafficSourceId = crypto.randomUUID()
  const otherTrafficSourceId = crypto.randomUUID()
  db.insert(trafficSources).values({
    id: trafficSourceId,
    projectId,
    sourceType: TrafficSourceTypes['cloud-run'],
    displayName: 'Site A Cloud Run',
    status: TrafficSourceStatuses.connected,
    lastSyncedAt: null,
    lastCursor: null,
    lastError: null,
    lastEventIds: null,
    archivedAt: null,
    configJson: {},
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(trafficSources).values({
    id: otherTrafficSourceId,
    projectId: otherProjectId,
    sourceType: TrafficSourceTypes['cloud-run'],
    displayName: 'Site B Cloud Run',
    status: TrafficSourceStatuses.connected,
    lastSyncedAt: null,
    lastCursor: null,
    lastError: null,
    lastEventIds: null,
    archivedAt: null,
    configJson: {},
    createdAt: now,
    updatedAt: now,
  }).run()

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()

  return { app, db, tmpDir, projectId, trafficSourceId, otherProjectId, otherTrafficSourceId }
}

async function teardown(harness: Harness) {
  await harness.app.close()
  fs.rmSync(harness.tmpDir, { recursive: true, force: true })
}

describe('schedule per-kind invariants', () => {
  let harness: Harness
  beforeEach(async () => { harness = await buildHarness() })
  afterEach(async () => { await teardown(harness) })

  it('rejects PUT /schedule with kind=traffic-sync and no sourceId', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/site-a/schedule',
      payload: { kind: 'traffic-sync', preset: 'daily' },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toMatch(/sourceId.*traffic-sync/)
  })

  it('rejects PUT /schedule with sourceId when kind is answer-visibility', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/site-a/schedule',
      payload: { kind: 'answer-visibility', preset: 'daily', sourceId: harness.trafficSourceId },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toMatch(/sourceId.*traffic-sync/)
  })

  it('rejects PUT /schedule with kind=traffic-sync and providers set', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/site-a/schedule',
      payload: {
        kind: 'traffic-sync',
        preset: 'daily',
        sourceId: harness.trafficSourceId,
        providers: ['gemini'],
      },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toMatch(/providers.*not valid.*traffic-sync/)
  })

  it('rejects PUT /schedule when sourceId belongs to a different project', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/site-a/schedule',
      payload: {
        kind: 'traffic-sync',
        preset: 'daily',
        sourceId: harness.otherTrafficSourceId,
      },
    })
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.payload)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('accepts a well-formed traffic-sync schedule and round-trips via GET / DELETE', async () => {
    const putRes = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/site-a/schedule',
      payload: { kind: 'traffic-sync', preset: 'daily', sourceId: harness.trafficSourceId },
    })
    expect(putRes.statusCode).toBe(201)
    const created = JSON.parse(putRes.payload)
    expect(created.kind).toBe('traffic-sync')
    expect(created.sourceId).toBe(harness.trafficSourceId)
    expect(created.providers).toEqual([])

    const getRes = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/projects/site-a/schedule?kind=traffic-sync',
    })
    expect(getRes.statusCode).toBe(200)
    expect(JSON.parse(getRes.payload).id).toBe(created.id)

    // The default GET (no kind) must NOT see the traffic-sync schedule.
    const defaultGetRes = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/projects/site-a/schedule',
    })
    expect(defaultGetRes.statusCode).toBe(404)

    const delRes = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/site-a/schedule?kind=traffic-sync',
    })
    expect(delRes.statusCode).toBe(204)
  })

  it('accepts a well-formed gbp-sync schedule (no sourceId) and round-trips via GET', async () => {
    const putRes = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/site-a/schedule',
      payload: { kind: 'gbp-sync', preset: 'daily' },
    })
    expect(putRes.statusCode).toBe(201)
    const created = JSON.parse(putRes.payload)
    expect(created.kind).toBe('gbp-sync')
    // GBP schedules operate on the project's selected locations — no source.
    expect(created.sourceId).toBeNull()
    expect(created.providers).toEqual([])

    const getRes = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/projects/site-a/schedule?kind=gbp-sync',
    })
    expect(getRes.statusCode).toBe(200)
    expect(JSON.parse(getRes.payload).id).toBe(created.id)

    // The default GET (no kind) must NOT see the gbp-sync schedule.
    const defaultGetRes = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/projects/site-a/schedule',
    })
    expect(defaultGetRes.statusCode).toBe(404)
  })

  it('rejects PUT /schedule with kind=gbp-sync and a sourceId', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/site-a/schedule',
      payload: { kind: 'gbp-sync', preset: 'daily', sourceId: harness.trafficSourceId },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toMatch(/sourceId.*traffic-sync/)
  })
})

describe('apply preserves traffic-sync schedules', () => {
  let harness: Harness
  beforeEach(async () => { harness = await buildHarness() })
  afterEach(async () => { await teardown(harness) })

  async function seedBothSchedules() {
    // 1. Create the answer-visibility schedule via the public route.
    const av = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/site-a/schedule',
      payload: { kind: 'answer-visibility', preset: 'daily' },
    })
    expect(av.statusCode).toBe(201)

    // 2. Create the traffic-sync schedule.
    const ts = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/site-a/schedule',
      payload: { kind: 'traffic-sync', cron: '*/15 * * * *', sourceId: harness.trafficSourceId },
    })
    expect(ts.statusCode).toBe(201)

    return { trafficSyncId: JSON.parse(ts.payload).id as string }
  }

  it('apply with no spec.schedule keeps the traffic-sync row intact', async () => {
    const { trafficSyncId } = await seedBothSchedules()

    const applyRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: {
        apiVersion: 'canonry/v1',
        kind: 'Project',
        metadata: { name: 'site-a' },
        spec: {
          displayName: 'Site A',
          canonicalDomain: 'site-a.example.com',
          country: 'US',
          language: 'en',
          queries: ['aeo tools'],
        },
      },
    })
    expect(applyRes.statusCode).toBe(200)

    const remaining = harness.db.select().from(schedules).where(eq(schedules.projectId, harness.projectId)).all()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe(trafficSyncId)
    expect(remaining[0]!.kind).toBe(SchedulableRunKinds['traffic-sync'])
    expect(remaining[0]!.preset).toBeNull()
    expect(remaining[0]!.cronExpr).toBe('*/15 * * * *')
    expect(remaining[0]!.sourceId).toBe(harness.trafficSourceId)
  })

  it('apply with spec.schedule updates only the answer-visibility row', async () => {
    await seedBothSchedules()

    const applyRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: {
        apiVersion: 'canonry/v1',
        kind: 'Project',
        metadata: { name: 'site-a' },
        spec: {
          displayName: 'Site A',
          canonicalDomain: 'site-a.example.com',
          country: 'US',
          language: 'en',
          queries: ['aeo tools'],
          schedule: { preset: 'weekly' },
        },
      },
    })
    expect(applyRes.statusCode).toBe(200)

    const trafficRow = harness.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.projectId, harness.projectId), eq(schedules.kind, SchedulableRunKinds['traffic-sync'])))
      .get()
    expect(trafficRow).toBeTruthy()
    expect(trafficRow!.preset).toBeNull()
    expect(trafficRow!.cronExpr).toBe('*/15 * * * *')
    expect(trafficRow!.sourceId).toBe(harness.trafficSourceId)

    const avRow = harness.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.projectId, harness.projectId), eq(schedules.kind, SchedulableRunKinds['answer-visibility'])))
      .get()
    expect(avRow).toBeTruthy()
    expect(avRow!.preset).toBe('weekly')
  })
})
