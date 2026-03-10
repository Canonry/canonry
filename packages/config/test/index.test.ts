import assert from 'node:assert/strict'
import test from 'node:test'

import { getPlatformEnv } from '../src/index.js'

test('getPlatformEnv returns defaults when no env vars set', () => {
  const env = getPlatformEnv({})

  assert.equal(env.apiPort, 3000)
  assert.equal(env.workerPort, 3001)
  assert.equal(env.webPort, 4173)
  assert.equal(env.bootstrapSecret, 'change-me')
  // No providers configured by default
  assert.deepEqual(env.providers, {})
})

test('getPlatformEnv configures Gemini provider from env vars', () => {
  const env = getPlatformEnv({
    DATABASE_URL: 'postgresql://custom',
    API_PORT: '4100',
    WORKER_PORT: '4101',
    WEB_PORT: '4200',
    BOOTSTRAP_SECRET: 'secret',
    GEMINI_API_KEY: 'gemini-key',
    GEMINI_MODEL: 'gemini-2.5-flash',
    GEMINI_MAX_CONCURRENCY: '5',
    GEMINI_MAX_REQUESTS_PER_MINUTE: '15',
    GEMINI_MAX_REQUESTS_PER_DAY: '1500',
  })

  assert.equal(env.databaseUrl, 'postgresql://custom')
  assert.equal(env.apiPort, 4100)
  assert.equal(env.bootstrapSecret, 'secret')
  assert.ok(env.providers.gemini)
  assert.equal(env.providers.gemini!.apiKey, 'gemini-key')
  assert.equal(env.providers.gemini!.model, 'gemini-2.5-flash')
  assert.deepEqual(env.providers.gemini!.quota, {
    maxConcurrency: 5,
    maxRequestsPerMinute: 15,
    maxRequestsPerDay: 1500,
  })
})

test('getPlatformEnv configures multiple providers', () => {
  const env = getPlatformEnv({
    GEMINI_API_KEY: 'gemini-key',
    OPENAI_API_KEY: 'openai-key',
    ANTHROPIC_API_KEY: 'claude-key',
  })

  assert.ok(env.providers.gemini)
  assert.ok(env.providers.openai)
  assert.ok(env.providers.claude)
  assert.equal(env.providers.gemini!.apiKey, 'gemini-key')
  assert.equal(env.providers.openai!.apiKey, 'openai-key')
  assert.equal(env.providers.claude!.apiKey, 'claude-key')
})

test('getPlatformEnv omits providers without API keys', () => {
  const env = getPlatformEnv({
    GEMINI_API_KEY: 'gemini-key',
  })

  assert.ok(env.providers.gemini)
  assert.equal(env.providers.openai, undefined)
  assert.equal(env.providers.claude, undefined)
})
