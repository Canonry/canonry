import { test, expect } from 'vitest'

import { getBootstrapEnv, getPlatformEnv } from '../src/index.js'

test('getPlatformEnv returns defaults when no env vars set', () => {
  const env = getPlatformEnv({})

  expect(env.apiPort).toBe(3000)
  expect(env.workerPort).toBe(3001)
  expect(env.webPort).toBe(4173)
  expect(env.bootstrapSecret).toBe('change-me')
  // No providers configured by default
  expect(env.providers).toEqual({})
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

  expect(env.databaseUrl).toBe('postgresql://custom')
  expect(env.apiPort).toBe(4100)
  expect(env.bootstrapSecret).toBe('secret')
  expect(env.providers.gemini).toBeTruthy()
  expect(env.providers.gemini!.apiKey).toBe('gemini-key')
  expect(env.providers.gemini!.model).toBe('gemini-2.5-flash')
  expect(env.providers.gemini!.quota).toEqual({
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

  expect(env.providers.gemini).toBeTruthy()
  expect(env.providers.openai).toBeTruthy()
  expect(env.providers.claude).toBeTruthy()
  expect(env.providers.gemini!.apiKey).toBe('gemini-key')
  expect(env.providers.openai!.apiKey).toBe('openai-key')
  expect(env.providers.claude!.apiKey).toBe('claude-key')
})

test('getPlatformEnv omits providers without API keys', () => {
  const env = getPlatformEnv({
    GEMINI_API_KEY: 'gemini-key',
  })

  expect(env.providers.gemini).toBeTruthy()
  expect(env.providers.openai).toBe(undefined)
  expect(env.providers.claude).toBe(undefined)
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

  expect(env.apiKey).toBe('cnry_test')
  expect(env.apiUrl).toBe('https://canonry.example.com')
  expect(env.databasePath).toBe('/data/canonry/data.db')
  expect(env.providers.gemini?.apiKey).toBe('gemini-key')
  expect(env.providers.gemini?.model).toBe('gemini-3-flash')
  expect(env.providers.local?.baseUrl).toBe('http://localhost:11434/v1')
  expect(env.providers.local?.model).toBe('llama3')
  expect(env.googleClientId).toBe('google-client-id')
  expect(env.googleClientSecret).toBe('google-client-secret')
})
