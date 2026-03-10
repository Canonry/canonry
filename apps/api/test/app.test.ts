import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { getPlatformEnv } from '@ainyc/canonry-config'
import { createClient, migrate } from '@ainyc/canonry-db'

import { buildApp } from '../src/app.js'
import { loadApiEnv } from '../src/plugins/env.js'

test('buildApp registers health and API routes', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-test-'))
  const dbPath = path.join(tmpDir, 'test.db')

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // Pre-create and migrate the database
  const db = createClient(dbPath)
  migrate(db)

  const env = getPlatformEnv({
    DATABASE_URL: dbPath,
    API_PORT: '3000',
    WORKER_PORT: '3001',
  })
  const app = buildApp(env)

  t.after(async () => {
    await app.close()
  })

  const healthResponse = await app.inject({
    method: 'GET',
    url: '/health',
  })
  assert.equal(healthResponse.statusCode, 200)
  assert.deepEqual(healthResponse.json(), {
    service: 'aeo-platform-api',
    status: 'ok',
    version: '0.1.0',
    port: 3000,
    databaseUrlConfigured: true,
  })

  // API routes are registered — projects endpoint is available
  const projectsResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
  })
  // Auth or success — either way, the route exists (not 404)
  assert.ok(
    [200, 401].includes(projectsResponse.statusCode),
    `Expected 200 or 401 but got ${projectsResponse.statusCode}`,
  )
})

test('loadApiEnv delegates to shared platform config', () => {
  const env = loadApiEnv({
    DATABASE_URL: 'postgresql://aeo:aeo@localhost:5432/aeo_platform',
    API_PORT: '4100',
    WORKER_PORT: '4101',
    WEB_PORT: '4173',
    BOOTSTRAP_SECRET: 'secret',
    GEMINI_API_KEY: 'gemini-key',
    GEMINI_MAX_CONCURRENCY: '4',
    GEMINI_MAX_REQUESTS_PER_MINUTE: '15',
    GEMINI_MAX_REQUESTS_PER_DAY: '500',
  })

  assert.equal(env.apiPort, 4100)
  assert.equal(env.workerPort, 4101)
  assert.equal(env.bootstrapSecret, 'secret')
  assert.ok(env.providers.gemini)
  assert.deepEqual(env.providers.gemini!.quota, {
    maxConcurrency: 4,
    maxRequestsPerMinute: 15,
    maxRequestsPerDay: 500,
  })
})
