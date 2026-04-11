import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentConfigEntry } from '../src/config.js'

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

// Lazy import so mocks are in place
const { detectOpenClaw, getAeroStateDir } = await import('../src/agent-bootstrap.js')
const { execFileSync } = await import('node:child_process')

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-bootstrap-'))
  vi.clearAllMocks()
  // Reset detection cache between tests
  detectOpenClaw.resetCache?.()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('detectOpenClaw', () => {
  it('returns found:true when binary at configured path responds to --version', async () => {
    const binaryPath = path.join(tmpDir, 'openclaw')
    fs.writeFileSync(binaryPath, '#!/bin/sh\necho "1.0.0"', { mode: 0o755 })

    vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from('openclaw 1.0.0\n'))

    const result = await detectOpenClaw({ binary: binaryPath })
    expect(result.found).toBe(true)
    expect(result.path).toBe(binaryPath)
    expect(result.version).toBe('1.0.0')
  })

  it('returns found:true when openclaw is in PATH via which', async () => {
    // No config binary → goes to findInPath() → which openclaw → probeVersion
    vi.mocked(execFileSync)
      .mockImplementationOnce(((cmd: string) => {
        // findInPath calls: which openclaw
        if (cmd === 'which') return '/usr/local/bin/openclaw\n'
        throw new Error('unexpected')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any)
      .mockImplementationOnce(((cmd: string) => {
        // probeVersion calls: /usr/local/bin/openclaw --version
        if (cmd === '/usr/local/bin/openclaw') return 'openclaw 2.0.0\n'
        throw new Error('unexpected')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any)

    const result = await detectOpenClaw()
    expect(result.found).toBe(true)
    expect(result.path).toBe('/usr/local/bin/openclaw')
  })

  it('returns found:false when not available', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not found')
    })

    const result = await detectOpenClaw()
    expect(result.found).toBe(false)
    expect(result.path).toBeUndefined()
    expect(result.version).toBeUndefined()
  })

  it('prefers configured binary path over PATH lookup', async () => {
    const configBinary = path.join(tmpDir, 'my-openclaw')
    fs.writeFileSync(configBinary, '', { mode: 0o755 })

    vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from('openclaw 3.0.0\n'))

    const result = await detectOpenClaw({ binary: configBinary })
    expect(result.found).toBe(true)
    expect(result.path).toBe(configBinary)

    // Should NOT have called which — config path takes priority
    const calls = vi.mocked(execFileSync).mock.calls
    const whichCalls = calls.filter(c => c[0] === 'which' || c[0] === 'where')
    expect(whichCalls).toHaveLength(0)
  })

  it('caches result for repeated calls', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not found')
    })

    const result1 = await detectOpenClaw()
    const result2 = await detectOpenClaw()

    expect(result1).toEqual(result2)
    // execFileSync should only be called once (for the first detection)
    // Second call should use cache
    const callCount = vi.mocked(execFileSync).mock.calls.length
    expect(callCount).toBeLessThanOrEqual(2) // at most: which + where (first call only)
  })
})

describe('getAeroStateDir', () => {
  it('returns ~/.openclaw-aero by default', () => {
    const result = getAeroStateDir()
    expect(result).toBe(path.join(os.homedir(), '.openclaw-aero'))
  })

  it('uses custom profile name when provided', () => {
    const result = getAeroStateDir('custom')
    expect(result).toBe(path.join(os.homedir(), '.openclaw-custom'))
  })
})
