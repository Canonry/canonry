import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { parse, stringify } from 'yaml'

import { runCli } from '../src/cli.js'
import { saveConfig, saveConfigPatch, loadConfig, loadConfigRaw, getConfigPath } from '../src/config.js'
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
  vi.restoreAllMocks()
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

test('saveConfig and saveConfigPatch replace config through a same-directory 0600 file', () => {
  const configPath = getConfigPath()
  fs.writeFileSync(configPath, stringify(baseConfig({ telemetry: false })), 'utf-8')
  const rename = vi.spyOn(fs, 'renameSync')

  saveConfig(baseConfig({ telemetry: true }))
  saveConfigPatch({ telemetry: false })

  expect(rename).toHaveBeenCalledTimes(2)
  for (const [temporaryPath, targetPath] of rename.mock.calls) {
    expect(path.dirname(String(temporaryPath))).toBe(tmpDir)
    expect(String(targetPath)).toBe(configPath)
  }
  expect(fs.readdirSync(tmpDir).filter(name => name.endsWith('.tmp'))).toEqual([])
  expect(fs.statSync(configPath).mode & 0o777).toBe(0o600)
  expect(readOnDisk().telemetry).toBe(false)
})

test('atomic config replacement preserves the prior config and cleans its temporary file on rename failure', () => {
  const configPath = getConfigPath()
  const original = stringify(baseConfig({ telemetry: false }))
  fs.writeFileSync(configPath, original, 'utf-8')
  vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('simulated rename failure')
  })

  expect(() => saveConfigPatch({ telemetry: true })).toThrow('simulated rename failure')

  expect(fs.readFileSync(configPath, 'utf-8')).toBe(original)
  expect(fs.readdirSync(tmpDir)).toEqual(['config.yaml'])
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

test('loadConfig defaults legacy Cloudflare credentials to direct-push', () => {
  const initial = baseConfig() as CanonryConfig & {
    cloudflareTraffic: { connections: Array<Record<string, unknown>> }
  }
  initial.cloudflareTraffic = {
    connections: [{
      projectName: 'demo',
      sourceId: 'src_legacy',
      bearerToken: 'bearer',
      hmacSecret: 'hmac',
      workerVersion: '1.0.0',
      expectedBotListVersion: '2026-05-27',
      zoneId: null,
      accountId: null,
      createdAt: '2026-05-27T00:00:00Z',
      updatedAt: '2026-05-27T00:00:00Z',
    }],
  }
  fs.writeFileSync(getConfigPath(), stringify(initial), 'utf-8')

  expect(loadConfig().cloudflareTraffic?.connections?.[0]?.deliveryMode).toBe('direct-push')
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

test('loadConfig preserves managed sweeps from config.yaml and validates its boolean type', () => {
  const configured = baseConfig({ dashboard: { showResourceLinks: false, managedSweeps: true } })
  fs.writeFileSync(getConfigPath(), stringify(configured))
  expect(loadConfig().dashboard).toEqual(configured.dashboard)
  fs.writeFileSync(getConfigPath(), stringify({ ...configured, dashboard: { managedSweeps: 'true' } }))
  expect(loadConfig).toThrow(/managedSweeps/)
})

test('loadConfig preserves viewer research policy and validates both fields', () => {
  const configured = baseConfig({ research: { allowViewers: true, viewerDailyRunLimit: 7 } })
  const original = stringify(configured)
  fs.writeFileSync(getConfigPath(), original)
  expect(loadConfig().research).toEqual(configured.research)
  saveConfigPatch(loadConfig())
  expect(fs.readFileSync(getConfigPath(), 'utf8')).toBe(original)

  fs.writeFileSync(getConfigPath(), stringify({ ...configured, research: { allowViewers: 'true' } }))
  expect(loadConfig).toThrow(/research\.allowViewers/)
  fs.writeFileSync(getConfigPath(), stringify({ ...configured, research: { viewerDailyRunLimit: 0 } }))
  expect(loadConfig).toThrow(/research\.viewerDailyRunLimit/)
})

test('loadConfig accepts a legacy blank showUpdateNotification value', () => {
  const original = `${stringify(baseConfig())}dashboard:\n  showUpdateNotification:\n`
  fs.writeFileSync(getConfigPath(), original)

  expect(loadConfig().dashboard?.showUpdateNotification).toBeNull()
  expect(fs.readFileSync(getConfigPath(), 'utf8')).toBe(original)
})

test.each([undefined, false, true, null])('managedSweeps=%s leaves nullable legacy dashboard fields untouched', managedSweeps => {
  const dashboard = {
    showUpdateNotification: null,
    showResourceLinks: null,
    requirePassword: null,
    onboardingMode: null,
    extension: { label: 'preserve this' },
    ...(managedSweeps === undefined ? {} : { managedSweeps }),
  }
  const original = stringify({ ...baseConfig(), dashboard })
  fs.writeFileSync(getConfigPath(), original)

  expect(loadConfig().dashboard).toEqual(dashboard)
  saveConfigPatch(loadConfig())
  expect(fs.readFileSync(getConfigPath(), 'utf8')).toBe(original)
})

test.each([undefined, false, true])('managedSweeps=%s preserves dashboard key order across whole-config saves', managedSweeps => {
  const dashboard = {
    showUpdateNotification: false,
    extension: { label: 'preserve this' },
    showResourceLinks: false,
    requirePassword: true,
    ...(managedSweeps === undefined ? {} : { managedSweeps }),
  }
  const original = stringify({ ...baseConfig(), dashboard })
  fs.writeFileSync(getConfigPath(), original)

  saveConfigPatch(loadConfig())
  expect(fs.readFileSync(getConfigPath(), 'utf8')).toBe(original)
})

test.each(['text', 'json', 'jsonl'])('invalid managed sweeps is a path-qualified, non-retryable CLI error (%s)', async format => {
  // Installed skills on the host must not trigger unrelated background config writes.
  setEnv('CANONRY_NO_AUTO_SKILLS_SYNC', '1')
  const invalidValue = 'private-invalid-value'
  const original = stringify({ ...baseConfig(), dashboard: { managedSweeps: invalidValue } })
  fs.writeFileSync(getConfigPath(), original)
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

  expect(await runCli(['telemetry', 'enable', '--format', format])).toBe(1)
  const output = stderr.mock.calls.map(args => args.join(' ')).join('\n')
  expect(output).toContain(getConfigPath())
  expect(output).toContain('dashboard.managedSweeps')
  expect(output).not.toContain(invalidValue)
  expect(output).not.toContain('cnry_prod_key')
  if (format !== 'text') expect(JSON.parse(output).error.code).toBe('CONFIG_INVALID')
  expect(fs.readFileSync(getConfigPath(), 'utf8')).toBe(original)
})
