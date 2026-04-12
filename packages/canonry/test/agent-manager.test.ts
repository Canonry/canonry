import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentConfigEntry } from '../src/config.js'

// Mock child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn((_cmd: string, args?: string[]) => {
    // Default: simulate ps returning an openclaw process for identity checks
    if (args && args.includes('-o') && args.includes('args=')) {
      return 'node /usr/local/bin/openclaw gateway\n'
    }
    return ''
  }),
}))

const { AgentManager } = await import('../src/agent-manager.js')
const { spawn } = await import('node:child_process')

// Capture original before any spying
const _readFileSync = fs.readFileSync.bind(fs)

let tmpDir: string

function defaultConfig(overrides: Partial<AgentConfigEntry> = {}): AgentConfigEntry {
  return {
    profile: 'aero',
    gatewayPort: 3579,
    ...overrides,
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-mgr-'))
  vi.clearAllMocks()
  // On Linux CI, verifyProcessIdentity reads /proc/<pid>/cmdline instead of
  // calling execFileSync('ps'). Intercept those reads so identity checks pass.
  vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    const filePath = args[0]
    if (typeof filePath === 'string' && /^\/proc\/\d+\/cmdline$/.test(filePath)) {
      return 'openclaw' as ReturnType<typeof fs.readFileSync>
    }
    return _readFileSync(...args)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function processJsonPath() {
  return path.join(tmpDir, 'process.json')
}

const PROCESS_MARKER = 'canonry-openclaw-gateway'

function writeProcessJson(data: Record<string, unknown>) {
  fs.writeFileSync(processJsonPath(), JSON.stringify({ marker: PROCESS_MARKER, ...data }), 'utf-8')
}

function readProcessJson(): Record<string, unknown> | null {
  const p = processJsonPath()
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf-8'))
}

describe('AgentManager.status', () => {
  it('returns stopped when no process.json exists', () => {
    const mgr = new AgentManager(defaultConfig(), tmpDir)
    const status = mgr.status()
    expect(status.state).toBe('stopped')
    expect(status.pid).toBeUndefined()
  })

  it('returns stopped when process.json exists but process is dead', () => {
    writeProcessJson({ pid: 999999, gatewayPort: 3579, startedAt: new Date().toISOString() })

    const mgr = new AgentManager(defaultConfig(), tmpDir)
    const status = mgr.status()
    expect(status.state).toBe('stopped')

    // Should clean up stale process.json
    expect(fs.existsSync(processJsonPath())).toBe(false)
  })

  it('returns running when process.json exists and process is alive', () => {
    // Use our own PID — it's definitely alive
    const pid = process.pid
    writeProcessJson({ pid, gatewayPort: 3579, startedAt: '2026-04-07T00:00:00Z' })

    const mgr = new AgentManager(defaultConfig(), tmpDir)
    const status = mgr.status()
    expect(status.state).toBe('running')
    expect(status.pid).toBe(pid)
    expect(status.port).toBe(3579)
    expect(status.startedAt).toBe('2026-04-07T00:00:00Z')
  })
})

describe('AgentManager.start', () => {
  it('spawns detached gateway process and writes process.json', async () => {
    const mockChild = {
      pid: 12345,
      unref: vi.fn(),
      on: vi.fn(),
      stdout: null,
      stderr: null,
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(spawn).mockReturnValueOnce(mockChild as any)

    // Mock process.kill(pid, 0) to report the process as alive
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 0 && pid === 12345) return true
      throw new Error('no such process')
    })

    const mgr = new AgentManager(defaultConfig({ binary: '/usr/bin/openclaw' }), tmpDir)
    await mgr.start()

    // Should have spawned openclaw
    expect(spawn).toHaveBeenCalledOnce()
    const [bin, args, opts] = vi.mocked(spawn).mock.calls[0]
    expect(bin).toBe('/usr/bin/openclaw')
    expect(args).toContain('--profile')
    expect(args).toContain('aero')
    expect(opts).toMatchObject({ detached: true })
    expect(opts.env).toMatchObject({ OPENCLAW_GATEWAY_PORT: '3579' })

    // Should have called unref
    expect(mockChild.unref).toHaveBeenCalled()

    // Should have written process.json with marker
    const pj = readProcessJson()
    expect(pj).not.toBeNull()
    expect(pj!.pid).toBe(12345)
    expect(pj!.gatewayPort).toBe(3579)
    expect(pj!.startedAt).toBeDefined()
    expect(pj!.marker).toBe(PROCESS_MARKER)

    killSpy.mockRestore()
  })

  it('throws when spawn emits an error (binary not found)', async () => {
    const mockChild = {
      pid: undefined,
      unref: vi.fn(),
      on: vi.fn((event: string, cb: (err: Error) => void) => {
        if (event === 'error') {
          // Simulate async spawn error on next tick
          setTimeout(() => cb(new Error('spawn ENOENT')), 10)
        }
      }),
      stdout: null,
      stderr: null,
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(spawn).mockReturnValueOnce(mockChild as any)

    const mgr = new AgentManager(defaultConfig({ binary: '/nonexistent/openclaw' }), tmpDir)
    await expect(mgr.start()).rejects.toThrow('Failed to start OpenClaw gateway')

    // Should NOT have written process.json
    expect(fs.existsSync(processJsonPath())).toBe(false)
  })

  it('is idempotent when already running', async () => {
    // Write process.json with our own PID (alive)
    writeProcessJson({ pid: process.pid, gatewayPort: 3579, startedAt: new Date().toISOString() })

    const mgr = new AgentManager(defaultConfig(), tmpDir)
    await mgr.start()

    // Should NOT have spawned anything
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('AgentManager.stop', () => {
  it('removes process.json after shutdown', async () => {
    // Use a PID that's definitely dead
    writeProcessJson({ pid: 999999, gatewayPort: 3579, startedAt: new Date().toISOString() })

    const mgr = new AgentManager(defaultConfig(), tmpDir)
    await mgr.stop()

    expect(fs.existsSync(processJsonPath())).toBe(false)
  })

  it('is idempotent when already stopped', async () => {
    const mgr = new AgentManager(defaultConfig(), tmpDir)
    // Should not throw
    await expect(mgr.stop()).resolves.toBeUndefined()
  })
})

describe('AgentManager.reset', () => {
  it('stops and wipes workspace directory', async () => {
    const workspaceDir = path.join(tmpDir, 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, 'test.txt'), 'hello')

    // Dead PID so stop is a no-op cleanup
    writeProcessJson({ pid: 999999, gatewayPort: 3579, startedAt: new Date().toISOString() })

    const mgr = new AgentManager(defaultConfig(), tmpDir)
    await mgr.reset()

    expect(fs.existsSync(processJsonPath())).toBe(false)
    expect(fs.existsSync(workspaceDir)).toBe(false)
  })
})
