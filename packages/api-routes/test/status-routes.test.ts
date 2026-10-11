import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { instanceStatusDtoSchema } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'

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
