import assert from 'node:assert/strict'
import test from 'node:test'

import { getBootstrapEnv, getPlatformEnv } from '../src/index.js'

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

test('getBootstrapEnv parses hosted Canonry env vars', () => {
  const env = getBootstrapEnv({
    CANONRY_API_KEY: 'cnry_test',
    CANONRY_API_URL: 'https://canonry.example.com',
    CANONRY_DATABASE_PATH: '/data/canonry/data.db',
    GEMINI_API_KEY: 'gemini-key',
    LOCAL_BASE_URL: 'http://localhost:11434/v1',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
  })

  assert.equal(env.apiKey, 'cnry_test')
  assert.equal(env.apiUrl, 'https://canonry.example.com')
  assert.equal(env.databasePath, '/data/canonry/data.db')
  assert.equal(env.providers.gemini?.apiKey, 'gemini-key')
  assert.equal(env.providers.gemini?.model, 'gemini-3-flash')
  assert.equal(env.providers.local?.baseUrl, 'http://localhost:11434/v1')
  assert.equal(env.providers.local?.model, 'llama3')
  assert.equal(env.googleClientId, 'google-client-id')
  assert.equal(env.googleClientSecret, 'google-client-secret')
})
