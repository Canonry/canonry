import { describe, expect, it } from 'vitest'
import { HelpRequested, HELP_TEXT, main, parseScope } from '../src/mcp/cli.js'

describe('parseScope', () => {
  it('defaults to "all" with no flags or env', () => {
    expect(parseScope([], undefined)).toBe('all')
  })

  it('honors --read-only', () => {
    expect(parseScope(['--read-only'], undefined)).toBe('read-only')
  })

  it('honors --scope=read-only', () => {
    expect(parseScope(['--scope=read-only'], undefined)).toBe('read-only')
  })

  it('reads CANONRY_MCP_SCOPE when no flag is passed', () => {
    expect(parseScope([], 'read-only')).toBe('read-only')
  })

  it('throws HelpRequested for --help', () => {
    expect(() => parseScope(['--help'], undefined)).toThrow(HelpRequested)
  })

  it('throws HelpRequested for -h', () => {
    expect(() => parseScope(['-h'], undefined)).toThrow(HelpRequested)
  })

  it('throws on unknown arguments', () => {
    expect(() => parseScope(['--bogus'], undefined)).toThrow(/Unknown canonry-mcp argument/)
  })
})

describe('canonry-mcp main', () => {
  it('writes HELP_TEXT to stderr when --help is passed and does not start a server', async () => {
    const stderr = captureStderr()
    try {
      await main(['--help'])
    } finally {
      stderr.restore()
    }
    expect(stderr.text()).toBe(HELP_TEXT)
    expect(HELP_TEXT).toContain('canonry-mcp')
    expect(HELP_TEXT).toContain('--read-only')
    expect(HELP_TEXT).toContain('--scope=')
  })

  it('writes HELP_TEXT to stderr when -h is passed', async () => {
    const stderr = captureStderr()
    try {
      await main(['-h'])
    } finally {
      stderr.restore()
    }
    expect(stderr.text()).toBe(HELP_TEXT)
  })
})

function captureStderr() {
  const writes: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((data: string | Uint8Array) => {
    writes.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
    return true
  }) as typeof process.stderr.write
  return {
    text: () => writes.join(''),
    restore: () => {
      process.stderr.write = original
    },
  }
}
