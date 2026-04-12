import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parse } from 'yaml'
import type { AgentConfigEntry } from '../src/config.js'

// Mock execFileSync for PID identity verification in AgentManager
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return {
    ...orig,
    execFileSync: vi.fn((...args: unknown[]) => {
      const cmd = args[0] as string
      const cmdArgs = args[1] as string[] | undefined
      // Intercept ps calls for identity check, return openclaw match
      if (cmd === 'ps' && cmdArgs && cmdArgs.includes('args=')) {
        return 'node /usr/local/bin/openclaw gateway\n'
      }
      return orig.execFileSync(...(args as Parameters<typeof orig.execFileSync>))
    }),
  }
})

const { agentStatus, agentSetup } = await import('../src/commands/agent.js')

// Capture original before any spying
const _readFileSync = fs.readFileSync.bind(fs)

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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-cmd-'))
  setEnv('CANONRY_CONFIG_DIR', tmpDir)
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
  restoreEnv()
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('agent status', () => {
  it('outputs JSON with state field when --format json', async () => {
    const stateDir = path.join(tmpDir, '.openclaw-aero')
    fs.mkdirSync(stateDir, { recursive: true })

    const output = await captureStdout(() =>
      agentStatus({ format: 'json', stateDir }),
    )

    const parsed = JSON.parse(output)
    expect(parsed.state).toBe('stopped')
  })

  it('outputs human-readable text with state when no format', async () => {
    const stateDir = path.join(tmpDir, '.openclaw-aero')
    fs.mkdirSync(stateDir, { recursive: true })

    const output = await captureStdout(() =>
      agentStatus({ stateDir }),
    )

    expect(output.toLowerCase()).toContain('stopped')
  })

  it('shows running state when process.json has live PID', async () => {
    const stateDir = path.join(tmpDir, '.openclaw-aero')
    fs.mkdirSync(stateDir, { recursive: true })

    // Write process.json with our own PID (alive) and proper marker
    const processJson = {
      pid: process.pid,
      gatewayPort: 3579,
      startedAt: '2026-04-07T00:00:00Z',
      marker: 'canonry-openclaw-gateway',
    }
    fs.writeFileSync(path.join(stateDir, 'process.json'), JSON.stringify(processJson))

    const output = await captureStdout(() =>
      agentStatus({ format: 'json', stateDir }),
    )

    const parsed = JSON.parse(output)
    expect(parsed.state).toBe('running')
    expect(parsed.pid).toBe(process.pid)
    expect(parsed.port).toBe(3579)
  })
})

describe('agent setup', () => {
  function mockBootstrapHelpers(bootstrap: typeof import('../src/agent-bootstrap.js')) {
    return {
      detect: vi.spyOn(bootstrap, 'detectOpenClaw').mockResolvedValue({
        found: true,
        path: '/usr/local/bin/openclaw',
        version: '1.0.0',
      }),
      seed: vi.spyOn(bootstrap, 'seedWorkspace').mockImplementation(() => {}),
      initProfile: vi.spyOn(bootstrap, 'initializeOpenClawProfile').mockImplementation(() => {}),
      configGateway: vi.spyOn(bootstrap, 'configureOpenClawGateway').mockImplementation(() => {}),
      setModel: vi.spyOn(bootstrap, 'setOpenClawModel').mockImplementation(() => {}),
    }
  }

  it('persists agent config to config.yaml and seeds workspace', async () => {
    const { stringify } = await import('yaml')
    const { getConfigPath } = await import('../src/config.js')
    const baseConfig = { apiUrl: 'http://localhost:4100', database: path.join(tmpDir, 'canonry.db'), apiKey: 'cnry_test' }
    fs.writeFileSync(getConfigPath(), stringify(baseConfig), 'utf-8')

    const bootstrap = await import('../src/agent-bootstrap.js')
    const spies = mockBootstrapHelpers(bootstrap)

    const stateDir = path.join(tmpDir, '.openclaw-aero')
    const output = await captureStdout(() =>
      agentSetup({ gatewayPort: 4000, format: 'json', stateDir }),
    )

    const parsed = JSON.parse(output)
    expect(parsed.state).toBe('configured')
    expect(parsed.binary).toBe('/usr/local/bin/openclaw')
    expect(parsed.gatewayPort).toBe(4000)

    // Verify config was persisted
    const onDisk = parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>
    const agent = onDisk.agent as Record<string, unknown>
    expect(agent.binary).toBe('/usr/local/bin/openclaw')
    expect(agent.gatewayPort).toBe(4000)
    expect(agent.profile).toBe('aero')

    // Verify bootstrap helpers were called in order
    expect(spies.initProfile).toHaveBeenCalled()
    expect(spies.configGateway).toHaveBeenCalledWith('/usr/local/bin/openclaw', 'aero', 4000)
    expect(spies.seed).toHaveBeenCalledWith(stateDir)

    for (const spy of Object.values(spies)) spy.mockRestore()
  })

  it('auto-installs openclaw when not found', async () => {
    const { stringify } = await import('yaml')
    const { getConfigPath } = await import('../src/config.js')
    const baseConfig = { apiUrl: 'http://localhost:4100', database: path.join(tmpDir, 'canonry.db'), apiKey: 'cnry_test' }
    fs.writeFileSync(getConfigPath(), stringify(baseConfig), 'utf-8')

    const bootstrap = await import('../src/agent-bootstrap.js')
    const spies = mockBootstrapHelpers(bootstrap)
    spies.detect.mockReset()
    spies.detect
      .mockResolvedValueOnce({ found: false })
      .mockResolvedValueOnce({ found: true, path: '/usr/local/bin/openclaw', version: '2.0.0' })
    const installSpy = vi.spyOn(bootstrap, 'installOpenClaw').mockResolvedValue({
      success: true,
      detection: { found: true, path: '/usr/local/bin/openclaw', version: '2.0.0' },
    })

    const stateDir = path.join(tmpDir, '.openclaw-aero')
    const output = await captureStdout(() =>
      agentSetup({ format: 'json', stateDir }),
    )

    expect(installSpy).toHaveBeenCalled()
    const parsed = JSON.parse(output)
    expect(parsed.state).toBe('configured')
    expect(parsed.binary).toBe('/usr/local/bin/openclaw')
    expect(parsed.version).toBe('2.0.0')

    for (const spy of Object.values(spies)) spy.mockRestore()
    installSpy.mockRestore()
  })

  it('reports error when auto-install fails', async () => {
    const { stringify } = await import('yaml')
    const { getConfigPath } = await import('../src/config.js')
    const baseConfig = { apiUrl: 'http://localhost:4100', database: path.join(tmpDir, 'canonry.db'), apiKey: 'cnry_test' }
    fs.writeFileSync(getConfigPath(), stringify(baseConfig), 'utf-8')

    const bootstrap = await import('../src/agent-bootstrap.js')
    const detectSpy = vi.spyOn(bootstrap, 'detectOpenClaw').mockResolvedValue({ found: false })
    const installSpy = vi.spyOn(bootstrap, 'installOpenClaw').mockResolvedValue({
      success: false,
      error: 'npm install failed',
    })

    const stateDir = path.join(tmpDir, '.openclaw-aero')
    await expect(
      agentSetup({ format: 'json', stateDir }),
    ).rejects.toThrow('npm install failed')

    expect(installSpy).toHaveBeenCalled()
    expect(process.exitCode).toBe(1)

    // Clean up exitCode
    process.exitCode = undefined

    detectSpy.mockRestore()
    installSpy.mockRestore()
  })
})

/**
 * Capture console.log output during an async function call.
 */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(' '))
  }
  try {
    await fn()
  } finally {
    console.log = originalLog
  }
  return chunks.join('\n')
}

