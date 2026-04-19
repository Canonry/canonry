import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: spawnMock }
})

const { ensurePluginDir, installDuckdb } = await import('../src/plugin-installer.js')

let pluginDir: string

beforeEach(async () => {
  pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-installer-'))
  spawnMock.mockReset()
})

afterEach(async () => {
  await fs.rm(pluginDir, { recursive: true, force: true })
})

describe('ensurePluginDir', () => {
  test('creates the directory and a minimal package.json', async () => {
    const fresh = path.join(pluginDir, 'nested')
    const pkgJson = path.join(fresh, 'package.json')
    await ensurePluginDir(fresh, pkgJson)
    const parsed = JSON.parse(await fs.readFile(pkgJson, 'utf8')) as {
      name?: string
      private?: boolean
      dependencies?: Record<string, string>
    }
    expect(parsed.name).toBe('canonry-plugins')
    expect(parsed.private).toBe(true)
    expect(parsed.dependencies).toEqual({})
  })

  test('does not overwrite an existing package.json', async () => {
    const pkgJson = path.join(pluginDir, 'package.json')
    await fs.writeFile(pkgJson, JSON.stringify({ name: 'mine', custom: true }))
    await ensurePluginDir(pluginDir, pkgJson)
    const parsed = JSON.parse(await fs.readFile(pkgJson, 'utf8')) as { name: string; custom: boolean }
    expect(parsed.name).toBe('mine')
    expect(parsed.custom).toBe(true)
  })
})

describe('installDuckdb', () => {
  test('short-circuits with alreadyPresent when node-api resolves', async () => {
    const duckdbDir = path.join(pluginDir, 'node_modules', '@duckdb', 'node-api')
    await fs.mkdir(duckdbDir, { recursive: true })
    await fs.writeFile(path.join(duckdbDir, 'package.json'), JSON.stringify({
      name: '@duckdb/node-api',
      version: '1.4.4-r.3',
      main: 'index.js',
    }))
    await fs.writeFile(path.join(duckdbDir, 'index.js'), 'module.exports = {}')

    const result = await installDuckdb({ pluginDir })
    expect(result.alreadyPresent).toBe(true)
    expect(result.version).toBe('1.4.4-r.3')
    expect(result.path).toBe(pluginDir)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  test('spawns the expected npm install command when not yet installed', async () => {
    spawnMock.mockImplementation((_cmd: string, _args: string[]) => {
      const duckdbDir = path.join(pluginDir, 'node_modules', '@duckdb', 'node-api')
      void (async () => {
        await fs.mkdir(duckdbDir, { recursive: true })
        await fs.writeFile(path.join(duckdbDir, 'package.json'), JSON.stringify({
          name: '@duckdb/node-api',
          version: '1.4.4-r.3',
          main: 'index.js',
        }))
        await fs.writeFile(path.join(duckdbDir, 'index.js'), 'module.exports = {}')
      })()
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {}
      return {
        on: (event: string, cb: (...args: unknown[]) => void) => {
          ;(listeners[event] ??= []).push(cb)
          if (event === 'exit') setTimeout(() => cb(0), 10)
          return this
        },
        stdout: null,
        stderr: null,
      } as unknown as ReturnType<typeof import('node:child_process').spawn>
    })

    const result = await installDuckdb({ pluginDir, spec: '@duckdb/node-api@1.4.4-r.3' })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]?.[0]).toBe('npm')
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'install',
      '@duckdb/node-api@1.4.4-r.3',
      '--prefix',
      pluginDir,
    ])
    expect(result.alreadyPresent).toBe(false)
    expect(result.version).toBe('1.4.4-r.3')
  })

  test('uses pnpm add when packageManager is pnpm', async () => {
    spawnMock.mockImplementation((_cmd: string, _args: string[]) => {
      void (async () => {
        const duckdbDir = path.join(pluginDir, 'node_modules', '@duckdb', 'node-api')
        await fs.mkdir(duckdbDir, { recursive: true })
        await fs.writeFile(path.join(duckdbDir, 'package.json'), JSON.stringify({
          name: '@duckdb/node-api',
          version: '1.4.4-r.3',
          main: 'index.js',
        }))
        await fs.writeFile(path.join(duckdbDir, 'index.js'), 'module.exports = {}')
      })()
      return {
        on: (event: string, cb: (...args: unknown[]) => void) => {
          if (event === 'exit') setTimeout(() => cb(0), 10)
        },
        stdout: null,
        stderr: null,
      } as unknown as ReturnType<typeof import('node:child_process').spawn>
    })

    await installDuckdb({ pluginDir, packageManager: 'pnpm' })
    expect(spawnMock.mock.calls[0]?.[0]).toBe('pnpm')
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'add',
      '@duckdb/node-api@1.4.4-r.3',
      '--dir',
      pluginDir,
    ])
  })

  test('throws when npm exits non-zero', async () => {
    spawnMock.mockImplementation(() => {
      return {
        on: (event: string, cb: (...args: unknown[]) => void) => {
          if (event === 'exit') setTimeout(() => cb(1), 10)
        },
        stdout: null,
        stderr: null,
      } as unknown as ReturnType<typeof import('node:child_process').spawn>
    })
    await expect(installDuckdb({ pluginDir })).rejects.toThrow(/exited with code 1/)
  })
})
