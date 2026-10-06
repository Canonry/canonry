import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: spawnMock }
})

const { installDuckdb } = await import('../src/plugin-installer.js')
let pluginDir: string

beforeEach(async () => {
  pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-installer-'))
  spawnMock.mockReset()
})

afterEach(async () => {
  await fs.rm(pluginDir, { recursive: true, force: true })
})

async function writeInstalledModule(directory: string): Promise<void> {
  const duckdbDir = path.join(directory, 'node_modules', '@duckdb', 'node-api')
  await fs.mkdir(duckdbDir, { recursive: true })
  await fs.writeFile(path.join(duckdbDir, 'package.json'), JSON.stringify({
    name: '@duckdb/node-api', version: '1.4.4-r.3', main: 'index.js',
  }))
  await fs.writeFile(path.join(duckdbDir, 'index.js'), 'module.exports = {}')
}

function mockExit(code: number, installation?: () => Promise<void>): void {
  spawnMock.mockImplementation(() => {
    const completion = installation?.() ?? Promise.resolve()
    return {
      on(event: string, callback: (code: number) => void) {
        if (event === 'exit') void completion.then(() => callback(code))
        return this
      },
      stdout: null,
      stderr: null,
    } as unknown as ReturnType<typeof import('node:child_process').spawn>
  })
}

describe('installDuckdb', () => {
  test('short-circuits with alreadyPresent and preserves operator package metadata', async () => {
    const packageBytes = '{\n  "name": "mine", "custom": true,\n  "dependencies": { "other-plugin": "2.0.0" }\n}\n'
    await fs.writeFile(path.join(pluginDir, 'package.json'), packageBytes)
    await writeInstalledModule(pluginDir)

    const result = await installDuckdb({ pluginDir })
    expect(result).toEqual({ alreadyPresent: true, version: '1.4.4-r.3', path: pluginDir })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(pluginDir, 'package.json'), 'utf8')).toBe(packageBytes)
  })

  test('creates plugin metadata and spawns the expected npm install command', async () => {
    const fresh = path.join(pluginDir, 'nested')
    mockExit(0, () => writeInstalledModule(fresh))

    const result = await installDuckdb({ pluginDir: fresh, spec: '@duckdb/node-api@1.4.4-r.3' })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]?.[0]).toBe('npm')
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'install', '@duckdb/node-api@1.4.4-r.3', '--prefix', fresh,
    ])
    expect(result).toEqual({ alreadyPresent: false, version: '1.4.4-r.3', path: fresh })
    expect(JSON.parse(await fs.readFile(path.join(fresh, 'package.json'), 'utf8'))).toEqual({
      name: 'canonry-plugins', private: true, dependencies: {},
    })
  })

  test('uses pnpm add with the requested package and plugin directory', async () => {
    mockExit(0, () => writeInstalledModule(pluginDir))
    await installDuckdb({ pluginDir, packageManager: 'pnpm', spec: '@duckdb/node-api@1.4.4-r.3' })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]?.[0]).toBe('pnpm')
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'add', '@duckdb/node-api@1.4.4-r.3', '--dir', pluginDir,
    ])
  })

  test('rejects a successful package-manager exit until the plugin resolves', async () => {
    mockExit(0)
    await expect(installDuckdb({ pluginDir })).rejects.toThrow(
      `npm install completed but @duckdb/node-api still cannot be resolved from ${pluginDir}`,
    )
  })

  test('throws when npm exits non-zero', async () => {
    mockExit(1)
    await expect(installDuckdb({ pluginDir })).rejects.toThrow('npm install exited with code 1')
  })
})
