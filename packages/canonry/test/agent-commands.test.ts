import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parse } from 'yaml'
import type { AgentConfigEntry } from '../src/config.js'

// Mock the API client — agentSetup calls attachAgentWebhookToAllProjects which
// uses createApiClient().listProjects(). In tests no server is running, so the
// mock throws ECONNREFUSED to trigger the DB fallback path.
vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    listProjects: () => { const err = new Error('fetch failed'); (err as NodeJS.ErrnoException).code = 'ECONNREFUSED'; throw err },
    listNotifications: () => Promise.resolve([]),
    createNotification: () => Promise.resolve({ id: 'mock-notif' }),
    deleteNotification: () => Promise.resolve(),
  }),
}))

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

  it('bulk-attaches agent webhook to all existing projects via DB when server is offline', async () => {
    const { stringify } = await import('yaml')
    const { getConfigPath } = await import('../src/config.js')
    const dbPath = path.join(tmpDir, 'canonry.db')
    const baseConfig = { apiUrl: 'http://localhost:4100', database: dbPath, apiKey: 'cnry_test' }
    fs.writeFileSync(getConfigPath(), stringify(baseConfig), 'utf-8')

    // Seed the DB with two projects before running setup
    const { createClient, migrate, projects: projectsTable, notifications, parseJsonColumn } = await import('@ainyc/canonry-db')
    const seedDb = createClient(dbPath)
    migrate(seedDb)
    const now = new Date().toISOString()
    for (const name of ['alpha', 'beta']) {
      seedDb.insert(projectsTable).values({
        id: `proj_${name}`,
        name,
        displayName: name,
        canonicalDomain: `${name}.example.com`,
        country: 'US',
        language: 'en',
        createdAt: now,
        updatedAt: now,
      }).run()
    }

    const bootstrap = await import('../src/agent-bootstrap.js')
    const spies = mockBootstrapHelpers(bootstrap)

    const stateDir = path.join(tmpDir, '.openclaw-aero')
    const output = await captureStdout(() =>
      agentSetup({ gatewayPort: 3579, format: 'json', stateDir }),
    )

    const parsed = JSON.parse(output)
    expect(parsed.state).toBe('configured')
    // Server isn't running → must fall back to DB path
    expect(parsed.attached.path).toBe('db')
    expect(parsed.attached.attached).toBe(2)
    expect(parsed.attached.alreadyAttached).toBe(0)

    // Verify notifications actually landed in the DB
    const rows = seedDb.select().from(notifications).all()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      const cfg = parseJsonColumn<{ url: string; events: string[]; source?: string }>(row.config, { url: '', events: [] })
      expect(cfg.url).toBe('http://localhost:3579/hooks/canonry')
      expect(cfg.source).toBe('agent')
      expect(cfg.events).toContain('insight.critical')
      expect(cfg.events).toContain('insight.high')
    }

    // Running setup a second time must be idempotent
    const output2 = await captureStdout(() =>
      agentSetup({ gatewayPort: 3579, format: 'json', stateDir }),
    )
    const parsed2 = JSON.parse(output2)
    expect(parsed2.attached.attached).toBe(0)
    expect(parsed2.attached.alreadyAttached).toBe(2)
    expect(seedDb.select().from(notifications).all()).toHaveLength(2)

    for (const spy of Object.values(spies)) spy.mockRestore()
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

