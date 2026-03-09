import assert from 'node:assert/strict'
import test from 'node:test'

import { getPlatformEnv } from '../src/index.js'

test('getPlatformEnv returns documented defaults', () => {
  const env = getPlatformEnv({})

  assert.equal(env.apiPort, 3000)
  assert.equal(env.workerPort, 3001)
  assert.equal(env.webPort, 4173)
  assert.equal(env.bootstrapSecret, 'change-me')
  assert.equal(env.geminiApiKey, 'change-me')
  assert.deepEqual(env.providerQuota, {
    maxConcurrency: 2,
    maxRequestsPerMinute: 10,
    maxRequestsPerDay: 1000,
  })
})

test('getPlatformEnv respects explicit overrides', () => {
  const env = getPlatformEnv({
    DATABASE_URL: 'postgresql://custom',
    API_PORT: '4100',
    WORKER_PORT: '4101',
    WEB_PORT: '4200',
    BOOTSTRAP_SECRET: 'secret',
    GEMINI_API_KEY: 'gemini',
    GEMINI_MAX_CONCURRENCY: '5',
    GEMINI_MAX_REQUESTS_PER_MINUTE: '15',
    GEMINI_MAX_REQUESTS_PER_DAY: '1500',
  })

  assert.equal(env.databaseUrl, 'postgresql://custom')
  assert.equal(env.apiPort, 4100)
  assert.equal(env.workerPort, 4101)
  assert.equal(env.webPort, 4200)
  assert.equal(env.bootstrapSecret, 'secret')
  assert.equal(env.geminiApiKey, 'gemini')
  assert.deepEqual(env.providerQuota, {
    maxConcurrency: 5,
    maxRequestsPerMinute: 15,
    maxRequestsPerDay: 1500,
  })
})
