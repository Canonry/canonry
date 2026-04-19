import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { isDuckdbInstalled, loadDuckdb, readInstalledVersion } from '../src/plugin-resolver.js'

let pluginDir: string
let pluginPkgJson: string

beforeEach(async () => {
  pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-plugin-'))
  pluginPkgJson = path.join(pluginDir, 'package.json')
  await fs.writeFile(pluginPkgJson, JSON.stringify({ name: 'canonry-plugins', private: true }))
})

afterEach(async () => {
  await fs.rm(pluginDir, { recursive: true, force: true })
})

describe('loadDuckdb', () => {
  test('throws MISSING_DEPENDENCY when module is absent', () => {
    expect(() => loadDuckdb({ pluginPkgJson })).toThrow(/not installed/)
    try {
      loadDuckdb({ pluginPkgJson })
    } catch (err) {
      expect((err as { code?: string }).code).toBe('MISSING_DEPENDENCY')
      expect((err as { statusCode?: number }).statusCode).toBe(422)
    }
  })
})

describe('isDuckdbInstalled', () => {
  test('returns false when module is absent', () => {
    expect(isDuckdbInstalled({ pluginPkgJson })).toBe(false)
  })
})

describe('readInstalledVersion', () => {
  test('returns null when the module is absent', () => {
    expect(readInstalledVersion({ pluginPkgJson })).toBeNull()
  })

  test('reads version from node_modules/@duckdb/node-api/package.json', async () => {
    const duckdbDir = path.join(pluginDir, 'node_modules', '@duckdb', 'node-api')
    await fs.mkdir(duckdbDir, { recursive: true })
    await fs.writeFile(path.join(duckdbDir, 'package.json'), JSON.stringify({ version: '1.4.4-r.3' }))
    expect(readInstalledVersion({ pluginPkgJson })).toBe('1.4.4-r.3')
  })
})
