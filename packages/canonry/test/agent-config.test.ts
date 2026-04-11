import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, beforeEach, afterEach } from 'vitest'
import { parse, stringify } from 'yaml'

import { saveConfig, saveConfigPatch, loadConfig, getConfigPath } from '../src/config.js'
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
    apiKey: 'cnry_test_key',
    ...overrides,
  }
}

function readOnDisk(): Record<string, unknown> {
  return parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-config-'))
  setEnv('CANONRY_CONFIG_DIR', tmpDir)
})

afterEach(() => {
  restoreEnv()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('AgentConfigEntry survives saveConfig round-trip', () => {
  const config = baseConfig({
    agent: {
      binary: '/usr/local/bin/openclaw',
      profile: 'aero',
      autoStart: true,
      gatewayPort: 3579,
    },
  })
  saveConfig(config)

  const result = readOnDisk()
  expect(result.agent).toEqual({
    binary: '/usr/local/bin/openclaw',
    profile: 'aero',
    autoStart: true,
    gatewayPort: 3579,
  })
})

test('loadConfig returns agent field when present', () => {
  const config = baseConfig({
    agent: {
      profile: 'aero',
      autoStart: false,
      gatewayPort: 4000,
    },
  })
  fs.writeFileSync(getConfigPath(), stringify(config), 'utf-8')

  const loaded = loadConfig()
  expect(loaded.agent).toBeDefined()
  expect(loaded.agent!.profile).toBe('aero')
  expect(loaded.agent!.autoStart).toBe(false)
  expect(loaded.agent!.gatewayPort).toBe(4000)
})

test('loadConfig works when agent field is absent', () => {
  const config = baseConfig()
  fs.writeFileSync(getConfigPath(), stringify(config), 'utf-8')

  const loaded = loadConfig()
  expect(loaded.agent).toBeUndefined()
})

test('saveConfigPatch preserves agent config when patching other fields', () => {
  const config = baseConfig({
    agent: {
      profile: 'aero',
      autoStart: true,
      gatewayPort: 3579,
    },
    providers: { gemini: { apiKey: 'gem-key' } },
  })
  fs.writeFileSync(getConfigPath(), stringify(config), 'utf-8')

  // Patch an unrelated field
  saveConfigPatch({ telemetry: false })

  const result = readOnDisk()
  expect(result.agent).toEqual({
    profile: 'aero',
    autoStart: true,
    gatewayPort: 3579,
  })
  expect(result.telemetry).toBe(false)
})
