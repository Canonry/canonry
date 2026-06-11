import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { expect, test } from 'vitest'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

/**
 * Regression tests for the auth hook's skip-path matchers.
 *
 * The guest-report matcher must be anchored to the `/api/v1` mount segment:
 * an earlier unanchored version (`/\/guest\/report...$/`) also matched
 * `/api/v1/projects/guest/report` — the authenticated client report of a
 * project literally named "guest" — and served it with no auth.
 */

function makeApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-skip-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'test',
    keyHash: crypto.createHash('sha256').update('cnry_test').digest('hex'),
    keyPrefix: 'cnry_test',
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()

  const app = Fastify()
  app.register(apiRoutes, { db })
  return { app, db, tmpDir }
}

test('a project named "guest" does not turn /projects/guest/report into an anonymous route', async () => {
  const { app, tmpDir } = makeApp()
  await app.ready()
  try {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/guest/report' })
    // Must hit the auth wall — NOT the report handler (which would be 404
    // "project not found" here, and the full report on a real deployment).
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error.code).toBe('AUTH_REQUIRED')
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('the anonymous guest-report paths still skip auth', async () => {
  const { app, tmpDir } = makeApp()
  await app.ready()
  try {
    // With CANONRY_ENABLE_GUEST_REPORTS unset the handler 404s — reaching
    // the handler at all (instead of 401) proves the auth hook skipped.
    for (const url of ['/api/v1/guest/report/some-id', '/api/v1/guest/report/some-id/stream']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(404)
    }
    const create = await app.inject({ method: 'POST', url: '/api/v1/guest/report', payload: { domain: 'acme.com' } })
    expect(create.statusCode).toBe(404)
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('the claim endpoint is NOT in the skip list — it requires auth', async () => {
  const { app, tmpDir } = makeApp()
  await app.ready()
  try {
    const res = await app.inject({ method: 'POST', url: '/api/v1/guest/report/some-id/claim' })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error.code).toBe('AUTH_REQUIRED')
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
