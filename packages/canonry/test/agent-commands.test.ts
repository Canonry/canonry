import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { AgentConfigEntry } from '../src/config.js'
import { agentStatus } from '../src/commands/agent.js'

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

    // Write process.json with our own PID (alive)
    const processJson = { pid: process.pid, gatewayPort: 3579, startedAt: '2026-04-07T00:00:00Z' }
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
