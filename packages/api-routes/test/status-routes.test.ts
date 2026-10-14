import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, doctorHealthState, gbpLocations, gscDataWatermarks, measurementPlanVersions, measurementPlans, migrate, projects, runs } from '@ainyc/canonry-db'
import { GBP_NO_SELECTED_LOCATIONS_ERROR, canonicalMeasurementPlanV2Json, instanceStatusDtoSchema, serializeRunError } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import type { GoogleConnectionStore } from '../src/google.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function appForStatus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-status-'))
  const db = createClient(path.join(dir, 'status.db'))
  migrate(db)
  db.insert(projects).values({
    id: crypto.randomUUID(), name: 'demo', displayName: 'Demo', canonicalDomain: 'example.com', country: 'US', language: 'en',
    ownedDomains: '[]', tags: '[]', providers: '[]', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run()
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return app
}

describe('GET /api/v1/status', () => {
  it('shares the doctor streak reader and reports the stored last success and latest error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-status-parity-'))
    const db = createClient(path.join(dir, 'status.db'))
    migrate(db)
    const projectId = crypto.randomUUID()
    const now = Date.now()
    db.insert(projects).values({
      id: projectId, name: 'advanced-demo', displayName: 'Advanced Demo', canonicalDomain: 'advanced.example', country: 'US', language: 'en',
      ownedDomains: '[]', tags: '[]', providers: JSON.stringify(['advanced']), createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    }).run()
    const plan = measurementPlanV2Fixture()
    db.insert(measurementPlanVersions).values({ id: 'advanced-plan-v2', projectId, revision: 1, schemaVersion: 2, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'advanced-plan-checksum', compiledChecksum: plan.compiledChecksum, createdAt: new Date(now - 20 * 86_400_000).toISOString() }).run()
    db.insert(measurementPlans).values({ projectId, activeVersionId: 'advanced-plan-v2', createdAt: new Date(now - 20 * 86_400_000).toISOString(), updatedAt: new Date(now - 20 * 86_400_000).toISOString() }).run()
    const addRun = (kind: 'gsc-sync' | 'ga-sync' | 'gbp-sync', status: 'completed' | 'partial' | 'failed', daysAgo: number, error: string | null = null) => {
      const createdAt = new Date(now - daysAgo * 86_400_000).toISOString()
      db.insert(runs).values({ id: crypto.randomUUID(), projectId, kind, status, trigger: 'scheduled', createdAt, finishedAt: createdAt, error }).run()
    }
    addRun('gsc-sync', 'completed', 10)
    for (const daysAgo of [4, 3, 2, 1]) addRun('gsc-sync', 'failed', daysAgo, 'DNS blocked')
    addRun('ga-sync', 'failed', 10, 'before connection')
    addRun('ga-sync', 'failed', 1, 'after connection')
    db.insert(gbpLocations).values({ id: 'selected-location', projectId, accountName: 'accounts/1', locationName: 'locations/1', displayName: 'Selected', selected: true, createdAt: new Date(now - 30 * 86_400_000).toISOString(), updatedAt: new Date(now - 30 * 86_400_000).toISOString() }).run()
    for (const daysAgo of [3, 2, 1]) addRun('gbp-sync', 'failed', daysAgo, serializeRunError({ message: GBP_NO_SELECTED_LOCATIONS_ERROR }))
    const googleConnectionStore = {
      getConnection: (_domain: string, type: string) => ['gsc', 'gbp'].includes(type) ? ({ createdAt: new Date(now - 30 * 86_400_000).toISOString() }) : type === 'ga4' ? ({ createdAt: new Date(now - 5 * 86_400_000).toISOString() }) : undefined,
    } as unknown as GoogleConnectionStore
    const app = Fastify()
    app.register(apiRoutes, { db, skipAuth: true, googleConnectionStore })
    await app.ready()
    const response = await app.inject({ method: 'GET', url: '/api/v1/status?project=advanced-demo' })
    const body = JSON.parse(response.payload) as { projects: Array<{ integrations: Array<Record<string, unknown>> }> }
    const gsc = body.projects[0]!.integrations.find(row => row.integration === 'gsc')!
    const ga = body.projects[0]!.integrations.find(row => row.integration === 'ga')!
    const gbp = body.projects[0]!.integrations.find(row => row.integration === 'gbp')!
    expect(gsc).toMatchObject({ state: 'failing', consecutiveFailures: 4, latestStatus: 'failed', latestError: 'DNS blocked' })
    expect(gsc.lastSuccessAt).toBe(new Date(now - 10 * 86_400_000).toISOString())
    expect(ga).toMatchObject({ state: 'ok', consecutiveFailures: 1, latestStatus: 'failed', latestError: 'after connection' })
    expect(gbp).toMatchObject({ state: 'never-synced', consecutiveFailures: 0, latestStatus: null })
    addRun('gsc-sync', 'partial', 0)
    const partial = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/status?project=advanced-demo' })).payload).projects[0].integrations.find((row: { integration: string }) => row.integration === 'gsc')
    expect(partial).toMatchObject({ state: 'ok', consecutiveFailures: 0, latestStatus: 'partial' })
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('includes stored health failures and warnings in the problems view and summary', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-health-'))
    const db = createClient(path.join(dir, 'status.db'))
    migrate(db)
    const now = new Date().toISOString()
    for (const [id, status] of [['failure', 'fail'], ['warning', 'warn'], ['healthy', 'ok']] as const) {
      db.insert(projects).values({ id, name: id, displayName: id, canonicalDomain: `${id}.example`, country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
      db.insert(doctorHealthState).values({ projectId: id, status, code: `traffic.${status}`, summary: `${status} summary`, checkedAt: now }).run()
    }
    const before = db.select().from(doctorHealthState).all()
    const app = Fastify()
    app.register(apiRoutes, { db, skipAuth: true })
    try {
      const response = await app.inject('/api/v1/status?problems=true')
      expect(response.statusCode).toBe(200)
      expect(response.json().summary).toEqual({ projects: 3, ok: 1, failing: 1, warning: 1, stale: 0, neverSynced: 0 })
      expect(response.json().projects).toMatchObject([
        { project: 'failure', state: 'failing', health: { status: 'fail' }, integrations: [] },
        { project: 'warning', state: 'warning', health: { status: 'warn' }, integrations: [] },
      ])
      expect(db.select().from(doctorHealthState).all()).toEqual(before)
    } finally {
      await app.close()
      db.$client.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('counts Search Console freshness in Pacific reporting days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-11T01:00:00.000Z'))
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'status-pacific-'))
    const db = createClient(path.join(directory, 'test.db'))
    migrate(db)
    const now = new Date().toISOString()
    db.insert(projects).values({ id: 'p', name: 'pacific', displayName: 'Pacific', canonicalDomain: 'pacific.example', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
    db.insert(runs).values({ id: 'r', projectId: 'p', kind: 'gsc-sync', status: 'completed', trigger: 'scheduled', createdAt: now, finishedAt: now }).run()
    db.insert(gscDataWatermarks).values({ projectId: 'p', dataThroughDate: '2026-10-06', updatedAt: now }).run()
    const googleConnectionStore = { getConnection: (_domain: string, type: string) => type === 'gsc' ? { createdAt: now } : undefined } as unknown as GoogleConnectionStore
    const app = Fastify()
    app.register(apiRoutes, { db, skipAuth: true, googleConnectionStore })
    try {
      const response = await app.inject({ url: '/api/v1/status?project=pacific' })
      expect(response.statusCode).toBe(200)
      expect(response.json().projects[0].integrations[0]).toMatchObject({ state: 'ok', dataThrough: '2026-10-06', dataAgeDays: 4 })
    } finally {
      await app.close()
      db.$client.close()
      fs.rmSync(directory, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('returns a contract-valid stored-only payload without provider probes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider call'))
    const app = appForStatus()
    await app.ready()
    const response = await app.inject({ method: 'GET', url: '/api/v1/status' })
    expect(response.statusCode).toBe(200)
    expect(instanceStatusDtoSchema.safeParse(JSON.parse(response.payload)).success).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    await app.close()
    fetchSpy.mockRestore()
  })

  it('filters one project and problems without mutating health state', async () => {
    const app = appForStatus()
    await app.ready()
    const response = await app.inject({ method: 'GET', url: '/api/v1/status?project=demo&problems=true' })
    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.payload)
    expect(body.projects).toMatchObject([{ project: 'demo', health: null, integrations: [] }])
    await app.close()
  })
})
