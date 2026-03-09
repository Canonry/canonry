import assert from 'node:assert/strict'
import test from 'node:test'

import { getPlatformEnv } from '@ainyc/aeo-platform-config'

import { buildApp } from '../src/app.js'
import { loadApiEnv } from '../src/plugins/env.js'

test('buildApp exposes root and health payloads', async (t) => {
  const env = getPlatformEnv({
    DATABASE_URL: 'postgresql://aeo:aeo@localhost:5432/aeo_platform',
    API_PORT: '3000',
    WORKER_PORT: '3001',
  })
  const app = buildApp(env)

  t.after(async () => {
    await app.close()
  })

  const rootResponse = await app.inject({
    method: 'GET',
    url: '/',
  })
  assert.equal(rootResponse.statusCode, 200)
  assert.deepEqual(rootResponse.json(), {
    service: 'aeo-platform-api',
    mode: 'skeleton',
    status: 'ok',
    version: 'phase-1',
    docs: '/health',
  })

  const healthResponse = await app.inject({
    method: 'GET',
    url: '/health',
  })
  assert.equal(healthResponse.statusCode, 200)
  assert.deepEqual(healthResponse.json(), {
    service: 'aeo-platform-api',
    status: 'ok',
    version: 'phase-1',
    port: 3000,
    databaseUrlConfigured: true,
  })
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
  assert.deepEqual(env.providerQuota, {
    maxConcurrency: 4,
    maxRequestsPerMinute: 15,
    maxRequestsPerDay: 500,
  })
})
