import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, readNegativeReviewMaxStars } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

// A project's negative-review threshold (`negativeReviewMaxStars`) decides what
// the review.negative webhook and the reviews read call negative. These pin
// how the setting is written, kept, reset and exported; gbp.test.ts covers the
// reviews read that applies it.

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

async function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-review-threshold-'))
  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, allowLoopbackWebhooks: true })
  await app.ready()
  cleanups.push(() => { void app.close() })
  return { app, db }
}

const body = (extras: Record<string, unknown> = {}) => ({
  displayName: 'Harborline',
  canonicalDomain: 'harborline.example',
  country: 'US',
  language: 'en',
  ...extras,
})

const config = (specExtras: Record<string, unknown> = {}) => ({
  apiVersion: 'canonry/v1',
  kind: 'Project',
  metadata: { name: 'harborline' },
  spec: { displayName: 'Harborline', canonicalDomain: 'harborline.example', country: 'US', language: 'en', ...specExtras },
})

function stored(db: ReturnType<typeof createClient>): number | null {
  const project = db.select().from(projects).where(eq(projects.name, 'harborline')).get()!
  return readNegativeReviewMaxStars(db, project.id)
}

describe('negativeReviewMaxStars', () => {
  it('is set by an upsert, kept when omitted, and reset by null', async () => {
    const { app, db } = await buildApp()
    const put = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: '/api/v1/projects/harborline', payload })

    const created = await put(body())
    expect(created.statusCode).toBe(201)
    expect(created.json().negativeReviewMaxStars).toBeNull()

    const set = await put(body({ negativeReviewMaxStars: 2 }))
    expect(set.json().negativeReviewMaxStars).toBe(2)
    expect(stored(db)).toBe(2)

    await put(body({ country: 'GB' }))
    expect(stored(db)).toBe(2)

    await put(body({ negativeReviewMaxStars: null }))
    expect(stored(db)).toBeNull()
  })

  it('rejects a threshold outside 1-4', async () => {
    const { app } = await buildApp()
    for (const value of [0, 5, 2.5]) {
      const res = await app.inject({ method: 'PUT', url: '/api/v1/projects/harborline', payload: body({ negativeReviewMaxStars: value }) })
      expect(res.statusCode, String(value)).toBe(400)
    }
  })

  it('is declarative under apply and round-trips through export', async () => {
    const { app, db } = await buildApp()
    expect((await app.inject({ method: 'POST', url: '/api/v1/apply', payload: config({ negativeReviewMaxStars: 1 }) })).statusCode).toBe(200)
    expect(stored(db)).toBe(1)

    const exported = (await app.inject({ method: 'GET', url: '/api/v1/projects/harborline/export' })).json()
    expect(exported.spec.negativeReviewMaxStars).toBe(1)

    // A spec without the field means the default, like the settings around it.
    await app.inject({ method: 'POST', url: '/api/v1/apply', payload: config() })
    expect(stored(db)).toBeNull()
    const reExported = (await app.inject({ method: 'GET', url: '/api/v1/projects/harborline/export' })).json()
    expect(reExported.spec).not.toHaveProperty('negativeReviewMaxStars')
  })
})
