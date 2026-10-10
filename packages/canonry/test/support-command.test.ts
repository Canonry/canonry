import { afterEach, describe, expect, it, vi } from 'vitest'
import { supportCommand } from '../src/commands/support.js'
import { CliError, EXIT_SYSTEM_ERROR, printCliError } from '../src/cli-error.js'
import { CANONRY_DISCORD_URL } from '../src/support-links.js'

afterEach(() => vi.restoreAllMocks())

describe('canonry support', () => {
  it('prints the Discord invite, issue tracker and feedback command', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    supportCommand('text')
    expect(log.mock.calls[0]?.[0]).toContain('https://discord.gg/jnJ2H2z5Xh')
    expect(log.mock.calls[0]?.[0]).toContain('canonry feedback')
    supportCommand('json')
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toEqual({
      discord: 'https://discord.gg/jnJ2H2z5Xh',
      issues: 'https://github.com/Canonry/canonry/issues',
      feedbackCommand: 'canonry feedback "<what happened>"',
    })
  })
})

describe('the help hint on errors', () => {
  const tty = (value: boolean) => Object.defineProperty(process.stderr, 'isTTY', { value, configurable: true })
  afterEach(() => tty(false))

  it('points a person at a terminal to support after an unexpected error', () => {
    tty(true)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    printCliError(new Error('boom'), 'text')
    expect(err.mock.calls.map(c => String(c[0])).join('\n')).toContain(CANONRY_DISCORD_URL)
    err.mockClear()
    printCliError(new CliError({ code: 'INTERNAL', message: 'x', exitCode: EXIT_SYSTEM_ERROR }), 'text')
    expect(err.mock.calls.map(c => String(c[0])).join('\n')).toContain("canonry support")
  })

  it('stays out of usage errors, captured output and machine formats', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    tty(true)
    printCliError(new CliError({ code: 'CLI_USAGE_ERROR', message: 'bad flag' }), 'text')
    printCliError(new Error('boom'), 'json')
    tty(false)
    printCliError(new Error('boom'), 'text')
    expect(err.mock.calls.map(c => String(c[0])).join('\n')).not.toContain(CANONRY_DISCORD_URL)
  })
})
