import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { vi } from 'vitest'
import { getConfigPath, clearDashboardPassword } from '../src/config.js'

let configDir: string

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-dashboard-password-reset-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', configDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(configDir, { recursive: true, force: true })
})

describe('clearDashboardPassword', () => {
  it('deletes dashboardPasswordHash from disk without touching other fields', () => {
    const original = {
      apiUrl: 'http://127.0.0.1:4999',
      database: path.join(configDir, 'custom.sqlite'),
      apiKey: 'cnry_reset_fixture',
      dashboardPasswordHash: 'deadbeef'.repeat(8),
    }
    fs.writeFileSync(getConfigPath(), stringify(original), { mode: 0o600 })

    const result = clearDashboardPassword()

    expect(result.cleared).toBe(true)
    const onDisk = parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>
    expect(onDisk.dashboardPasswordHash).toBeUndefined()
    expect('dashboardPasswordHash' in onDisk).toBe(false)
    expect(onDisk.apiUrl).toBe(original.apiUrl)
    expect(onDisk.database).toBe(original.database)
    expect(onDisk.apiKey).toBe(original.apiKey)
  })

  it('does not use saveConfigPatch, which deliberately re-preserves dashboardPasswordHash', async () => {
    // Regression guard for the saveConfigPatch trap: saveConfigPatch({})
    // reads the on-disk hash back in after merging, so calling it with an
    // empty or undefined patch can never actually clear the password.
    const { saveConfigPatch } = await import('../src/config.js')
    const original = {
      apiUrl: 'http://127.0.0.1:4999',
      database: path.join(configDir, 'custom.sqlite'),
      apiKey: 'cnry_reset_fixture',
      dashboardPasswordHash: 'deadbeef'.repeat(8),
    }
    fs.writeFileSync(getConfigPath(), stringify(original), { mode: 0o600 })

    saveConfigPatch({})

    const onDisk = parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>
    expect(onDisk.dashboardPasswordHash).toBe(original.dashboardPasswordHash)
  })

  it('is a no-op when no config file exists', () => {
    const result = clearDashboardPassword()
    expect(result.cleared).toBe(false)
  })

  it('is a no-op when the config file has no dashboardPasswordHash', () => {
    const original = {
      apiUrl: 'http://127.0.0.1:4999',
      database: path.join(configDir, 'custom.sqlite'),
      apiKey: 'cnry_reset_fixture',
    }
    fs.writeFileSync(getConfigPath(), stringify(original), { mode: 0o600 })

    const result = clearDashboardPassword()

    expect(result.cleared).toBe(false)
    const onDisk = parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>
    expect(onDisk.apiUrl).toBe(original.apiUrl)
  })
})
