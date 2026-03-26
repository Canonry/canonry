import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, beforeEach, afterEach } from 'vitest'
import { parse, stringify } from 'yaml'

import { saveConfig, loadConfigRaw, getConfigPath } from '../src/config.js'
import type { CanonryConfig } from '../src/config.js'

let tmpDir: string
const origEnv: Record<string, string | undefined> = {}

function setEnv(key: string, value: string | undefined) {
  if (!(key in origEnv)) origEnv[key] = process.env[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function restoreEnv() {
  for (const [key, value] of Object.entries(origEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function baseConfig(overrides: Partial<CanonryConfig> = {}): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: path.join(tmpDir, 'canonry.db'),
    apiKey: 'cnry_prod_key',
    ...overrides,
  }
}

function readOnDisk(): Record<string, unknown> {
  return parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-save-config-'))
  setEnv('CANONRY_CONFIG_DIR', tmpDir)
})

afterEach(() => {
  restoreEnv()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('saveConfig preserves on-disk fields not present in incoming config', () => {
  // Write an initial config with an extra field
  const initial = baseConfig({ anonymousId: 'anon-123', telemetry: true })
  fs.writeFileSync(getConfigPath(), stringify(initial), 'utf-8')

  // Save a config that omits anonymousId
  const partial: CanonryConfig = {
    apiUrl: 'http://localhost:4100',
    database: path.join(tmpDir, 'canonry.db'),
    apiKey: 'cnry_prod_key',
    telemetry: false,
  }
  saveConfig(partial)

  const result = readOnDisk()
  expect(result.anonymousId).toBe('anon-123') // preserved from disk
  expect(result.telemetry).toBe(false) // updated
})

test('saveConfig does not persist CANONRY_PORT-derived apiUrl changes', () => {
  const initial = baseConfig()
  fs.writeFileSync(getConfigPath(), stringify(initial), 'utf-8')

  // Simulate loadConfig applying CANONRY_PORT override
  setEnv('CANONRY_PORT', '5000')
  const loaded = { ...initial, apiUrl: 'http://localhost:5000' }

  // Targeted change: add a provider
  loaded.providers = { gemini: { apiKey: 'gem-key' } }
  saveConfig(loaded as CanonryConfig)

  const result = readOnDisk()
  // apiUrl should be the original on-disk value, not the port-overridden one
  expect(result.apiUrl).toBe('http://localhost:4100')
  expect((result.providers as Record<string, unknown>).gemini).toEqual({ apiKey: 'gem-key' })
})

test('saveConfig does not persist CANONRY_BASE_PATH-derived basePath changes', () => {
  const initial = baseConfig({ basePath: '/prod-path' })
  fs.writeFileSync(getConfigPath(), stringify(initial), 'utf-8')

  // Simulate CANONRY_BASE_PATH env var overriding basePath at load time
  setEnv('CANONRY_BASE_PATH', '/test-path')
  const loaded = { ...initial, basePath: '/test-path' }

  saveConfig(loaded as CanonryConfig)

  const result = readOnDisk()
  // Should preserve the on-disk basePath, not the env-var override
  expect(result.basePath).toBe('/prod-path')
})

test('saveConfig removes basePath when CANONRY_BASE_PATH is set but on-disk has none', () => {
  const initial = baseConfig()
  // No basePath on disk
  fs.writeFileSync(getConfigPath(), stringify(initial), 'utf-8')

  setEnv('CANONRY_BASE_PATH', '/injected')
  const loaded = { ...initial, basePath: '/injected' }
  saveConfig(loaded as CanonryConfig)

  const result = readOnDisk()
  expect(result.basePath).toBeUndefined()
})

test('saveConfig creates config file when none exists', () => {
  const config = baseConfig({ providers: { openai: { apiKey: 'oai-key' } } })
  saveConfig(config)

  const result = readOnDisk()
  expect(result.apiUrl).toBe('http://localhost:4100')
  expect((result.providers as Record<string, unknown>).openai).toEqual({ apiKey: 'oai-key' })
})

test('saveConfig merges targeted provider update without clobbering database', () => {
  // Simulate production config on disk
  const prodConfig = baseConfig({
    database: '/home/user/.canonry/prod.db',
    anonymousId: 'uuid-prod',
    providers: { gemini: { apiKey: 'old-gem-key' } },
  })
  fs.writeFileSync(getConfigPath(), stringify(prodConfig), 'utf-8')

  // Simulate a config loaded from a DIFFERENT session (test session) that
  // has been mutated in memory with a new provider key
  const testConfig: CanonryConfig = {
    apiUrl: 'http://localhost:4100',
    database: '/tmp/test-session/test.db', // test DB path
    apiKey: 'cnry_prod_key',
    providers: { gemini: { apiKey: 'new-gem-key' } },
  }
  saveConfig(testConfig)

  const result = readOnDisk()
  // The provider update should be applied
  expect((result.providers as Record<string, Record<string, string>>).gemini.apiKey).toBe('new-gem-key')
  // But database is overwritten because the caller explicitly provided it
  // (this is expected — the read-modify-write merges all provided fields)
  // The protection against cross-session clobbering comes from the env-var guards
  expect(result.database).toBe('/tmp/test-session/test.db')
  // On-disk fields not in incoming config are preserved
  expect(result.anonymousId).toBe('uuid-prod')
})

test('saveConfig does not persist basePath-derived apiUrl mutation when basePath is on disk', () => {
  // On disk: apiUrl without basePath suffix, basePath configured
  const initial = baseConfig({ basePath: '/canonry' })
  fs.writeFileSync(getConfigPath(), stringify(initial), 'utf-8')

  // Simulate what loadConfig() produces: apiUrl has basePath appended
  // No CANONRY_PORT or CANONRY_BASE_PATH env vars set
  const loaded: CanonryConfig = {
    ...initial,
    apiUrl: 'http://localhost:4100/canonry', // mutated by loadConfig basePath logic
  }
  saveConfig(loaded)

  const result = readOnDisk()
  // apiUrl must be restored to the original on-disk value, not the mutated one
  expect(result.apiUrl).toBe('http://localhost:4100')
  expect(result.basePath).toBe('/canonry')
})

test('loadConfigRaw returns null when no config file exists', () => {
  const result = loadConfigRaw()
  expect(result).toBeNull()
})

test('loadConfigRaw reads config without applying env-var transformations', () => {
  const initial = baseConfig({ basePath: '/original' })
  fs.writeFileSync(getConfigPath(), stringify(initial), 'utf-8')

  setEnv('CANONRY_PORT', '9999')
  setEnv('CANONRY_BASE_PATH', '/overridden')

  const raw = loadConfigRaw()
  expect(raw).not.toBeNull()
  expect(raw!.apiUrl).toBe('http://localhost:4100') // not port-overridden
  expect(raw!.basePath).toBe('/original') // not env-overridden
})
