import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const client = vi.hoisted(() => ({
  getTelemetry: vi.fn(),
  updateTelemetry: vi.fn(),
}))

vi.mock('../src/client.js', () => ({ createApiClient: () => client }))

function captureLog() {
  const logs: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '))
  return { logs, restore: () => { console.log = original } }
}

describe('telemetry target controls', () => {
  const saved: Record<string, string | undefined> = {}
  let configDir: string
  const envKeys = ['CANONRY_CONFIG_DIR', 'CANONRY_TELEMETRY_DISABLED', 'DO_NOT_TRACK', 'CI'] as const

  beforeEach(() => {
    for (const key of envKeys) saved[key] = process.env[key]
    delete process.env.CANONRY_TELEMETRY_DISABLED
    delete process.env.DO_NOT_TRACK
    delete process.env.CI
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-telemetry-target-'))
    process.env.CANONRY_CONFIG_DIR = configDir
    client.getTelemetry.mockReset()
    client.updateTelemetry.mockReset()
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    fs.rmSync(configDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('uses the API only for the explicit server target', async () => {
    client.getTelemetry.mockResolvedValue({
      enabled: false, configuredEnabled: true, reason: 'CI', target: 'server',
    })
    const { telemetryCommand } = await import('../src/commands/telemetry.js')
    const captured = captureLog()
    try {
      await telemetryCommand('status', 'json', 'server')
    } finally {
      captured.restore()
    }
    expect(client.getTelemetry).toHaveBeenCalledOnce()
    expect(client.updateTelemetry).not.toHaveBeenCalled()
    expect(JSON.parse(captured.logs.join(''))).toMatchObject({ target: 'server', reason: 'CI' })
  })

  it('reports the environment override after a local enable receipt', async () => {
    process.env.CANONRY_TELEMETRY_DISABLED = '1'
    const { saveConfig } = await import('../src/config.js')
    saveConfig({ apiUrl: 'http://localhost:4100', database: 'test.db', apiKey: 'cnry_test', telemetry: false })
    const { telemetryCommand } = await import('../src/commands/telemetry.js')
    const captured = captureLog()
    try {
      telemetryCommand('enable', 'json', 'local')
    } finally {
      captured.restore()
    }
    expect(client.updateTelemetry).not.toHaveBeenCalled()
    expect(JSON.parse(captured.logs.join(''))).toMatchObject({
      target: 'local', enabled: false, configuredEnabled: true, reason: 'CANONRY_TELEMETRY_DISABLED',
    })
  })

  it('validates the target before any local or remote mutation', async () => {
    const { telemetryCommand } = await import('../src/commands/telemetry.js')
    expect(() => telemetryCommand('disable', 'json', 'elsewhere')).toThrow(/--target must be/)
    expect(client.updateTelemetry).not.toHaveBeenCalled()
  })

  it('retains the legacy local masked-ID field alongside the shared DTO', async () => {
    const { saveConfig } = await import('../src/config.js')
    saveConfig({ apiUrl: 'http://localhost:4100', database: 'test.db', apiKey: 'cnry_test', anonymousId: '01234567-89ab-4cde-8fab-0123456789ab' })
    const { telemetryCommand } = await import('../src/commands/telemetry.js')
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    telemetryCommand('status', 'json')
    expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ anonymousId: '01234567...', anonymousIdMasked: '01234567...' })
  })
})
