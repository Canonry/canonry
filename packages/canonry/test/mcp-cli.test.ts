import { describe, expect, it } from 'vitest'
import { HelpRequested, HELP_TEXT, main, parseCliOptions } from '../src/mcp/cli.js'

const emptyEnv = {} as NodeJS.ProcessEnv
const envWith = (entries: Record<string, string>) => entries as unknown as NodeJS.ProcessEnv

describe('parseCliOptions', () => {
  it('defaults to scope:"all" eager:false with no flags or env', () => {
    expect(parseCliOptions([], emptyEnv)).toEqual({ scope: 'all', eager: false })
  })

  it('honors --read-only', () => {
    expect(parseCliOptions(['--read-only'], emptyEnv)).toEqual({ scope: 'read-only', eager: false })
  })

  it('honors --scope=read-only', () => {
    expect(parseCliOptions(['--scope=read-only'], emptyEnv)).toEqual({ scope: 'read-only', eager: false })
  })

  it('honors --eager', () => {
    expect(parseCliOptions(['--eager'], emptyEnv)).toEqual({ scope: 'all', eager: true })
  })

  it('reads CANONRY_MCP_SCOPE when no flag is passed', () => {
    expect(parseCliOptions([], envWith({ CANONRY_MCP_SCOPE: 'read-only' }))).toEqual({ scope: 'read-only', eager: false })
  })

  it('reads CANONRY_MCP_EAGER from env', () => {
    expect(parseCliOptions([], envWith({ CANONRY_MCP_EAGER: '1' }))).toEqual({ scope: 'all', eager: true })
    expect(parseCliOptions([], envWith({ CANONRY_MCP_EAGER: 'true' }))).toEqual({ scope: 'all', eager: true })
    expect(parseCliOptions([], envWith({ CANONRY_MCP_EAGER: 'no' }))).toEqual({ scope: 'all', eager: false })
  })

  it('throws HelpRequested for --help', () => {
    expect(() => parseCliOptions(['--help'], emptyEnv)).toThrow(HelpRequested)
  })

  it('throws HelpRequested for -h', () => {
    expect(() => parseCliOptions(['-h'], emptyEnv)).toThrow(HelpRequested)
  })

  it('honors --help even when CANONRY_MCP_SCOPE is invalid', () => {
    expect(() => parseCliOptions(['--help'], envWith({ CANONRY_MCP_SCOPE: 'bogus' }))).toThrow(HelpRequested)
    expect(() => parseCliOptions(['-h'], envWith({ CANONRY_MCP_SCOPE: 'bogus' }))).toThrow(HelpRequested)
  })

  it('throws on unknown arguments', () => {
    expect(() => parseCliOptions(['--bogus'], emptyEnv)).toThrow(/Unknown canonry-mcp argument/)
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
    expect(HELP_TEXT).toContain('--eager')
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
