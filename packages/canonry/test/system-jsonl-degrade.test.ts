import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * The `--format jsonl` degrade trap: system/lifecycle and mutation commands that
 * don't STREAM a jsonl collection must still emit their JSON document for
 * `--format jsonl` (degrade to json) rather than falling through to decorated
 * human text. Each block below proves, for one representative command per
 * handler file, that `jsonl` output === `json` output (parseable, equal) and
 * that the no-format human output is unchanged.
 */

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '))
  return { logs, restore: () => { console.log = orig } }
}

async function withLog<T>(fn: () => Promise<T> | T): Promise<string[]> {
  const { logs, restore } = captureLog()
  try {
    await fn()
  } finally {
    restore()
  }
  return logs
}

// ---------------------------------------------------------------------------
// telemetry.ts — telemetryCommand('status', format)
// ---------------------------------------------------------------------------
describe('telemetry status jsonl degrade', () => {
  const saved: Record<string, string | undefined> = {}
  const ENV_KEYS = ['CI', 'CANONRY_TELEMETRY_DISABLED', 'DO_NOT_TRACK'] as const
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k]
    delete process.env.CANONRY_TELEMETRY_DISABLED
    delete process.env.DO_NOT_TRACK
    process.env.CI = '1'
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('jsonl emits the same JSON document as json (degrade, not human text)', async () => {
    const { telemetryCommand } = await import('../src/commands/telemetry.js')
    const jsonLogs = await withLog(() => telemetryCommand('status', 'json'))
    const jsonlLogs = await withLog(() => telemetryCommand('status', 'jsonl'))
    const jsonPayload = JSON.parse(jsonLogs.join(''))
    const jsonlPayload = JSON.parse(jsonlLogs.join(''))
    expect(jsonlPayload).toEqual(jsonPayload)
    expect(jsonPayload).toMatchObject({ enabled: false, reason: 'CI' })
  })

  it('text output is unchanged (human, not JSON)', async () => {
    const { telemetryCommand } = await import('../src/commands/telemetry.js')
    const logs = await withLog(() => telemetryCommand('status', 'text'))
    expect(logs.join('\n')).toContain('Telemetry: disabled (CI environment detected)')
    expect(() => JSON.parse(logs.join(''))).toThrow()
  })
})

// ---------------------------------------------------------------------------
// daemon.ts — stopDaemon(format) with no PID file
// ---------------------------------------------------------------------------
describe('daemon stopDaemon jsonl degrade', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `canonry-daemon-jsonl-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir
  })
  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('jsonl emits the same JSON document as json', async () => {
    const { stopDaemon } = await import('../src/commands/daemon.js')
    const jsonLogs = await withLog(() => stopDaemon('json'))
    const jsonlLogs = await withLog(() => stopDaemon('jsonl'))
    const jsonPayload = JSON.parse(jsonLogs.join(''))
    const jsonlPayload = JSON.parse(jsonlLogs.join(''))
    expect(jsonlPayload).toEqual(jsonPayload)
    expect(jsonPayload).toMatchObject({ stopped: false, reason: 'not_running' })
  })

  it('text output is unchanged (human, not JSON)', async () => {
    const { stopDaemon } = await import('../src/commands/daemon.js')
    const logs = await withLog(() => stopDaemon('text'))
    expect(logs.join('\n')).toContain('not running')
    expect(() => JSON.parse(logs.join(''))).toThrow()
  })
})

// ---------------------------------------------------------------------------
// init.ts — initCommand({ format }) on the config-exists short-circuit
// ---------------------------------------------------------------------------
const mockConfigExists = vi.fn()
const mockGetConfigPath = vi.fn(() => '/tmp/canonry/config.yaml')
vi.mock('../src/config.js', () => ({
  configExists: () => mockConfigExists(),
  getConfigPath: () => mockGetConfigPath(),
  // Honor CANONRY_CONFIG_DIR so the daemon block's temp-dir setup still drives
  // getPidPath() correctly even though the config module is mocked file-wide.
  getConfigDir: () => process.env.CANONRY_CONFIG_DIR ?? '/tmp/canonry',
  loadConfig: () => ({ providers: {} }),
  saveConfig: vi.fn(),
  saveConfigPatch: vi.fn(),
}))

describe('init jsonl degrade (config-exists short-circuit)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigExists.mockReturnValue(true)
    mockGetConfigPath.mockReturnValue('/tmp/canonry/config.yaml')
  })

  it('jsonl emits the same JSON document as json', async () => {
    const { initCommand } = await import('../src/commands/init.js')
    const jsonLogs = await withLog(() => initCommand({ format: 'json' }))
    const jsonlLogs = await withLog(() => initCommand({ format: 'jsonl' }))
    const jsonPayload = JSON.parse(jsonLogs.join(''))
    const jsonlPayload = JSON.parse(jsonlLogs.join(''))
    expect(jsonlPayload).toEqual(jsonPayload)
    expect(jsonPayload).toMatchObject({ initialized: false, reason: 'config_exists' })
  })

  it('text output is unchanged (human, not JSON)', async () => {
    const { initCommand } = await import('../src/commands/init.js')
    const logs = await withLog(() => initCommand({ format: 'text' }))
    expect(logs.join('\n')).toContain('Config already exists')
    expect(logs.some(l => l.trim().startsWith('{'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// serve.ts — serveCommand(format), mocked to reach the listen-output branch
// ---------------------------------------------------------------------------
const mockListen = vi.fn()
const mockClose = vi.fn()
vi.mock('@ainyc/canonry-db', () => ({
  createClient: () => ({}),
  migrate: vi.fn(),
}))
vi.mock('../src/server.js', () => ({
  createServer: async () => ({ listen: mockListen, close: mockClose }),
}))
vi.mock('../src/telemetry.js', () => ({
  trackEvent: vi.fn(),
  setTelemetrySource: vi.fn(),
}))
vi.mock('../src/commands/backfill.js', () => ({
  backfillNormalizedPaths: () => ({ updated: 0 }),
  backfillAiReferralPaths: () => ({ updated: 0 }),
}))

describe('serve jsonl degrade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfigExists.mockReturnValue(true)
    mockListen.mockResolvedValue(undefined)
    mockClose.mockResolvedValue(undefined)
  })

  it('jsonl emits the same JSON document as json', async () => {
    const { serveCommand } = await import('../src/commands/serve.js')
    const jsonLogs = await withLog(() => serveCommand('json'))
    const jsonlLogs = await withLog(() => serveCommand('jsonl'))
    const jsonPayload = JSON.parse(jsonLogs.join(''))
    const jsonlPayload = JSON.parse(jsonlLogs.join(''))
    expect(jsonlPayload).toEqual(jsonPayload)
    expect(jsonPayload).toMatchObject({ started: true })
  })

  it('text output is unchanged (human, not JSON)', async () => {
    const { serveCommand } = await import('../src/commands/serve.js')
    const logs = await withLog(() => serveCommand('text'))
    expect(logs.join('\n')).toContain('Canonry server running at')
    expect(logs.join('\n')).toContain('/setup')
    expect(logs.some(l => l.trim().startsWith('{'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// mcp.ts — printMcpConfig({ client, format })
// ---------------------------------------------------------------------------
describe('mcp config jsonl degrade', () => {
  // Pass an explicit binPath so the command doesn't resolve canonry-mcp from
  // package.json (which isn't on disk relative to the .ts source under vitest).
  const binPath = '/usr/local/bin/canonry-mcp'

  it('jsonl emits the same JSON document as json', async () => {
    const { printMcpConfig } = await import('../src/commands/mcp.js')
    const jsonLogs = await withLog(() => printMcpConfig({ client: 'claude-desktop', binPath, format: 'json' }))
    const jsonlLogs = await withLog(() => printMcpConfig({ client: 'claude-desktop', binPath, format: 'jsonl' }))
    const jsonPayload = JSON.parse(jsonLogs.join('\n'))
    const jsonlPayload = JSON.parse(jsonlLogs.join('\n'))
    expect(jsonlPayload).toEqual(jsonPayload)
    expect(jsonPayload).toMatchObject({ client: 'claude-desktop', serverName: 'canonry' })
  })

  it('text output is unchanged (human snippet, not a single JSON document)', async () => {
    const { printMcpConfig } = await import('../src/commands/mcp.js')
    const logs = await withLog(() => printMcpConfig({ client: 'claude-desktop', binPath, format: 'text' }))
    // The human path prints a "# ... paste into ..." header line before the snippet.
    expect(logs.join('\n')).toMatch(/# .* — paste into /)
  })
})

// ---------------------------------------------------------------------------
// skills.ts — listSkills({ format })
// ---------------------------------------------------------------------------
describe('skills list jsonl degrade', () => {
  it('jsonl emits the same JSON document as json', async () => {
    const { listSkills } = await import('../src/commands/skills.js')
    const jsonLogs = await withLog(() => listSkills({ format: 'json' }))
    const jsonlLogs = await withLog(() => listSkills({ format: 'jsonl' }))
    const jsonPayload = JSON.parse(jsonLogs.join(''))
    const jsonlPayload = JSON.parse(jsonlLogs.join(''))
    expect(jsonlPayload).toEqual(jsonPayload)
    expect(jsonPayload.skills.map((s: { name: string }) => s.name).sort()).toEqual(['aero', 'canonry'])
  })

  it('text output is unchanged (human, not JSON)', async () => {
    const { listSkills } = await import('../src/commands/skills.js')
    const logs = await withLog(() => listSkills({ format: 'text' }))
    expect(logs.join('\n')).toContain('Bundled canonry skills:')
    expect(logs.some(l => l.trim().startsWith('{'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// cdp.ts — cdpStatus(format), client mocked
// ---------------------------------------------------------------------------
const mockGetCdpStatus = vi.fn()
vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ getCdpStatus: mockGetCdpStatus }),
}))

describe('cdp status jsonl degrade', () => {
  const cdpStatusValue = {
    connected: true,
    endpoint: 'ws://localhost:9222',
    browserVersion: 'Chrome/123',
    targets: [{ name: 'chatgpt', alive: true, lastUsed: '2026-05-30T00:00:00.000Z' }],
  }
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCdpStatus.mockResolvedValue(cdpStatusValue)
  })

  it('jsonl emits the same JSON document as json', async () => {
    const { cdpStatus } = await import('../src/commands/cdp.js')
    const jsonLogs = await withLog(() => cdpStatus('json'))
    const jsonlLogs = await withLog(() => cdpStatus('jsonl'))
    const jsonPayload = JSON.parse(jsonLogs.join(''))
    const jsonlPayload = JSON.parse(jsonlLogs.join(''))
    expect(jsonlPayload).toEqual(jsonPayload)
    expect(jsonlPayload).toEqual(cdpStatusValue)
  })

  it('text output is unchanged (human, not JSON)', async () => {
    const { cdpStatus } = await import('../src/commands/cdp.js')
    const logs = await withLog(() => cdpStatus('text'))
    expect(logs.join('\n')).toContain('CDP connected: ws://localhost:9222')
    expect(logs.some(l => l.trim().startsWith('{'))).toBe(false)
  })
})
