import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ENV_KEYS = [
  'CANONRY_ANONYMOUS_ID',
  'CANONRY_TELEMETRY_DISABLED',
  'DO_NOT_TRACK',
  'CI',
  'CANONRY_CONFIG_DIR',
  'CANONRY_AGENT',
] as const

describe('telemetry.disabled', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}
  const anonymousId = crypto.randomUUID()
  let configDir: string
  let payloads: Array<Record<string, unknown>>
  let originalFetch: typeof fetch
  let originalLog: typeof console.log

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-telemetry-disabled-'))
    process.env.CANONRY_CONFIG_DIR = configDir
    // The CLI reports the coding agent it runs under; pin it so the suite does not depend on its own harness.
    process.env.CANONRY_AGENT = 'codex'
    const { saveConfig } = await import('../src/config.js')
    saveConfig({ apiUrl: 'http://localhost:4100', database: 'test.db', apiKey: 'cnry_test', telemetry: true, anonymousId })

    payloads = []
    originalFetch = globalThis.fetch
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) payloads.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ ok: true }))
    }
    originalLog = console.log
    console.log = () => {}
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    console.log = originalLog
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  async function configuredTelemetry() {
    const { loadConfig } = await import('../src/config.js')
    return loadConfig().telemetry
  }

  it('sends one last event from `canonry telemetry disable`, delivered before the command settles', async () => {
    const { telemetryCommand } = await import('../src/commands/telemetry.js')
    let release!: (response: Response) => void
    const response = new Promise<Response>(resolve => { release = resolve })
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) payloads.push(JSON.parse(String(init.body)))
      return response
    }
    const logs: string[] = []
    console.log = (message: string) => { logs.push(message) }
    let settled = false
    const command = Promise.resolve(telemetryCommand('disable', 'json', 'local'))
      .then(() => { settled = true })

    try {
      await Promise.resolve()
      expect(settled, 'the command must wait for the collector response').toBe(false)
      expect(await configuredTelemetry()).toBe(false)
      expect(logs).toHaveLength(1)
      expect(JSON.parse(logs[0]!)).toMatchObject({ target: 'local', enabled: false, configuredEnabled: false })
      expect(payloads).toHaveLength(1)
      expect(payloads[0]).toMatchObject({ event: 'telemetry.disabled', anonymousId })
      expect(payloads[0]!.properties).toEqual({ method: 'cli', surface: 'cli', agent: 'codex' })
    } finally {
      release(new Response(JSON.stringify({ ok: true })))
      await command
    }

    expect(settled).toBe(true)
    expect(await configuredTelemetry()).toBe(false)
  })

  it('sends nothing once telemetry is already off, so a repeated disable never counts twice', async () => {
    const { telemetryCommand } = await import('../src/commands/telemetry.js')

    await telemetryCommand('disable', 'json', 'local')
    await telemetryCommand('disable', 'json', 'local')

    expect(payloads.map(payload => payload.event)).toEqual(['telemetry.disabled'])
  })

  it.each([
    ['DO_NOT_TRACK', '1'],
    ['CANONRY_TELEMETRY_DISABLED', '1'],
    ['CI', 'true'],
  ] as const)('sends nothing when %s already keeps telemetry off, but still records the preference', async (key, value) => {
    process.env[key] = value
    const { setTelemetryPreference } = await import('../src/telemetry.js')

    await setTelemetryPreference(false, 'cli')

    expect(payloads).toEqual([])
    expect(await configuredTelemetry()).toBe(false)
  })

  it('tags an opt-out through the API, and sends nothing when telemetry is turned on', async () => {
    const { setTelemetryPreference } = await import('../src/telemetry.js')

    await setTelemetryPreference(true, 'api')
    expect(payloads).toEqual([])
    expect(await configuredTelemetry()).toBe(true)

    await setTelemetryPreference(false, 'api', { surface: 'mcp-stdio', agent: 'claude' })
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({ event: 'telemetry.disabled' })
    expect(payloads[0]!.properties).toEqual({ method: 'api', surface: 'mcp-stdio', agent: 'claude' })
    expect(await configuredTelemetry()).toBe(false)
  })

  it('attributes an API opt-out with no request to the server itself, never to the CLI', async () => {
    const { setTelemetryPreference } = await import('../src/telemetry.js')

    await setTelemetryPreference(false, 'api')
    expect(payloads[0]!.properties).toEqual({ method: 'api', surface: 'system' })
  })

  it('persists the preference even when the collector is unreachable', async () => {
    globalThis.fetch = async () => { throw new Error('offline') }
    const { setTelemetryPreference } = await import('../src/telemetry.js')

    await expect(setTelemetryPreference(false, 'api')).resolves.toBeUndefined()
    expect(await configuredTelemetry()).toBe(false)
  })

  // File modes do not stop root, which would make the write succeed and the test meaningless.
  it.skipIf(process.getuid?.() === 0)('announces nothing when the opt-out cannot be written, so a retry never counts twice', async () => {
    const { setTelemetryPreference } = await import('../src/telemetry.js')
    const configPath = path.join(configDir, 'config.yaml')
    fs.chmodSync(configPath, 0o444)
    fs.chmodSync(configDir, 0o555)
    try {
      expect(() => setTelemetryPreference(false, 'cli')).toThrow()
      expect(() => setTelemetryPreference(false, 'cli')).toThrow()
    } finally {
      fs.chmodSync(configDir, 0o755)
      fs.chmodSync(configPath, 0o644)
    }

    expect(payloads).toEqual([])
    expect(await configuredTelemetry()).toBe(true)
  })
})
