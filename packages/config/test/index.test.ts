import { test, expect } from 'vitest'

import { getBootstrapEnv, getPlatformEnv, readCloudModeFlags } from '../src/index.js'

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

test('getPlatformEnv configures Gemini via Vertex AI env vars (no API key)', () => {
  const env = getPlatformEnv({
    GEMINI_VERTEX_PROJECT: 'my-gcp-project',
    GEMINI_VERTEX_REGION: 'europe-west1',
    GEMINI_VERTEX_CREDENTIALS: '/path/to/sa.json',
  })

  expect(env.providers.gemini).toBeTruthy()
  expect(env.providers.gemini!.apiKey).toBe('')
  expect(env.providers.gemini!.vertexProject).toBe('my-gcp-project')
  expect(env.providers.gemini!.vertexRegion).toBe('europe-west1')
  expect(env.providers.gemini!.vertexCredentials).toBe('/path/to/sa.json')
})

test('getPlatformEnv configures Gemini via Vertex AI with only project (defaults region)', () => {
  const env = getPlatformEnv({
    GEMINI_VERTEX_PROJECT: 'my-gcp-project',
  })

  expect(env.providers.gemini).toBeTruthy()
  expect(env.providers.gemini!.apiKey).toBe('')
  expect(env.providers.gemini!.vertexProject).toBe('my-gcp-project')
  expect(env.providers.gemini!.vertexRegion).toBeUndefined()
})

test('getBootstrapEnv configures Gemini via Vertex AI env vars', () => {
  const env = getBootstrapEnv({
    GEMINI_VERTEX_PROJECT: 'my-gcp-project',
    GEMINI_VERTEX_REGION: 'us-east1',
    GEMINI_VERTEX_CREDENTIALS: '/path/to/sa.json',
  })

  expect(env.providers.gemini).toBeTruthy()
  expect(env.providers.gemini!.apiKey).toBe('')
  expect(env.providers.gemini!.vertexProject).toBe('my-gcp-project')
  expect(env.providers.gemini!.vertexRegion).toBe('us-east1')
  expect(env.providers.gemini!.vertexCredentials).toBe('/path/to/sa.json')
  expect(env.providers.gemini!.model).toBe('gemini-2.5-flash')
})

test('readCloudModeFlags returns OSS defaults when env is empty', () => {
  const flags = readCloudModeFlags({})

  expect(flags.runtimeMode).toBe('oss')
  expect(flags.scheduler).toBe('internal')
  expect(flags.managedSettings).toBe(false)
  expect(flags.enableCloudBootstrap).toBe(false)
})

test('readCloudModeFlags honours CANONRY_RUNTIME_MODE=cloud', () => {
  expect(readCloudModeFlags({ CANONRY_RUNTIME_MODE: 'cloud' }).runtimeMode).toBe('cloud')
  expect(readCloudModeFlags({ CANONRY_RUNTIME_MODE: 'CLOUD' }).runtimeMode).toBe('cloud')
  expect(readCloudModeFlags({ CANONRY_RUNTIME_MODE: 'oss' }).runtimeMode).toBe('oss')
  expect(readCloudModeFlags({ CANONRY_RUNTIME_MODE: 'something-else' }).runtimeMode).toBe('oss')
})

test('readCloudModeFlags honours CANONRY_SCHEDULER=external', () => {
  expect(readCloudModeFlags({ CANONRY_SCHEDULER: 'external' }).scheduler).toBe('external')
  expect(readCloudModeFlags({ CANONRY_SCHEDULER: 'EXTERNAL' }).scheduler).toBe('external')
  expect(readCloudModeFlags({ CANONRY_SCHEDULER: 'internal' }).scheduler).toBe('internal')
  expect(readCloudModeFlags({ CANONRY_SCHEDULER: 'noop' }).scheduler).toBe('internal')
})

test('readCloudModeFlags parses boolean flags', () => {
  expect(readCloudModeFlags({ CANONRY_MANAGED_SETTINGS: '1' }).managedSettings).toBe(true)
  expect(readCloudModeFlags({ CANONRY_MANAGED_SETTINGS: 'true' }).managedSettings).toBe(true)
  expect(readCloudModeFlags({ CANONRY_MANAGED_SETTINGS: 'YES' }).managedSettings).toBe(true)
  expect(readCloudModeFlags({ CANONRY_MANAGED_SETTINGS: '0' }).managedSettings).toBe(false)
  expect(readCloudModeFlags({ CANONRY_MANAGED_SETTINGS: 'false' }).managedSettings).toBe(false)
  expect(readCloudModeFlags({ CANONRY_MANAGED_SETTINGS: '' }).managedSettings).toBe(false)

  expect(readCloudModeFlags({ CANONRY_ENABLE_CLOUD_BOOTSTRAP: '1' }).enableCloudBootstrap).toBe(true)
  expect(readCloudModeFlags({ CANONRY_ENABLE_CLOUD_BOOTSTRAP: 'on' }).enableCloudBootstrap).toBe(true)
  expect(readCloudModeFlags({}).enableCloudBootstrap).toBe(false)
})

test('getPlatformEnv exposes cloud flags and control plane URL', () => {
  const env = getPlatformEnv({
    CANONRY_RUNTIME_MODE: 'cloud',
    CANONRY_SCHEDULER: 'external',
    CANONRY_MANAGED_SETTINGS: '1',
    CANONRY_ENABLE_CLOUD_BOOTSTRAP: '1',
    CANONRY_CONTROL_PLANE_URL: 'http://canonry-control-plane:8080/',
  })

  expect(env.cloud.runtimeMode).toBe('cloud')
  expect(env.cloud.scheduler).toBe('external')
  expect(env.cloud.managedSettings).toBe(true)
  expect(env.cloud.enableCloudBootstrap).toBe(true)
  // Trailing slashes are stripped so callers can append paths cleanly.
  expect(env.controlPlaneUrl).toBe('http://canonry-control-plane:8080')
})

test('getPlatformEnv defaults cloud flags to OSS posture', () => {
  const env = getPlatformEnv({})

  expect(env.cloud.runtimeMode).toBe('oss')
  expect(env.cloud.scheduler).toBe('internal')
  expect(env.cloud.managedSettings).toBe(false)
  expect(env.cloud.enableCloudBootstrap).toBe(false)
  expect(env.controlPlaneUrl).toBeUndefined()
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
  expect(env.providers.gemini?.model).toBe('gemini-2.5-flash')
  expect(env.providers.local?.baseUrl).toBe('http://localhost:11434/v1')
  expect(env.providers.local?.model).toBe('llama3')
  expect(env.googleClientId).toBe('google-client-id')
  expect(env.googleClientSecret).toBe('google-client-secret')
})
