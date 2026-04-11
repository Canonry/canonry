import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parse } from 'yaml'
import type { AgentConfigEntry } from '../src/config.js'
import { agentStatus, agentSetup } from '../src/commands/agent.js'

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
})

afterEach(() => {
  restoreEnv()
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
  it('persists agent config to config.yaml and seeds workspace', async () => {
    // Create a base config file so saveConfigPatch has something to merge into
    const { stringify } = await import('yaml')
    const { getConfigPath } = await import('../src/config.js')
    const baseConfig = { apiUrl: 'http://localhost:4100', database: path.join(tmpDir, 'canonry.db'), apiKey: 'cnry_test' }
    fs.writeFileSync(getConfigPath(), stringify(baseConfig), 'utf-8')

    // Mock detectOpenClaw to return a found binary
    const bootstrap = await import('../src/agent-bootstrap.js')
    const detectSpy = vi.spyOn(bootstrap, 'detectOpenClaw').mockResolvedValue({
      found: true,
      path: '/usr/local/bin/openclaw',
      version: '1.0.0',
    })
    const seedSpy = vi.spyOn(bootstrap, 'seedWorkspace').mockImplementation(() => {})

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

    // Verify workspace was seeded
    expect(seedSpy).toHaveBeenCalledWith(stateDir)

    detectSpy.mockRestore()
    seedSpy.mockRestore()
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
