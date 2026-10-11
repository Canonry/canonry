import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, projects, runs } from '@ainyc/canonry-db'
import { instanceStatusDtoSchema } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import type { GoogleConnectionStore } from '../src/google.js'

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
    const addRun = (status: 'completed' | 'failed', daysAgo: number, error: string | null = null) => {
      const createdAt = new Date(now - daysAgo * 86_400_000).toISOString()
      db.insert(runs).values({ id: crypto.randomUUID(), projectId, kind: 'gsc-sync', status, trigger: 'scheduled', createdAt, finishedAt: createdAt, error }).run()
    }
    addRun('completed', 10)
    for (const daysAgo of [4, 3, 2, 1]) addRun('failed', daysAgo, 'DNS blocked')
    const googleConnectionStore = {
      getConnection: (_domain: string, type: string) => type === 'gsc' ? ({ createdAt: new Date(now - 30 * 86_400_000).toISOString() }) : undefined,
    } as unknown as GoogleConnectionStore
    const app = Fastify()
    app.register(apiRoutes, { db, skipAuth: true, googleConnectionStore })
    await app.ready()
    const response = await app.inject({ method: 'GET', url: '/api/v1/status?project=advanced-demo' })
    const body = JSON.parse(response.payload) as { projects: Array<{ integrations: Array<Record<string, unknown>> }> }
    const gsc = body.projects[0]!.integrations.find(row => row.integration === 'gsc')!
    expect(gsc).toMatchObject({ state: 'failing', consecutiveFailures: 4, latestStatus: 'failed', latestError: 'DNS blocked' })
    expect(gsc.lastSuccessAt).toBe(new Date(now - 10 * 86_400_000).toISOString())
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
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
    expect(body.projects).toHaveLength(0)
    await app.close()
  })
})
