import { afterEach, describe, expect, it, vi } from 'vitest'
import { supportCommand } from '../src/commands/support.js'
import { CliError, EXIT_SYSTEM_ERROR, printCliError } from '../src/cli-error.js'

const welcomeInvite = 'https://discord.gg/8K9yY7GywJ'

afterEach(() => vi.restoreAllMocks())

describe('canonry support', () => {
  afterEach(() => vi.unstubAllEnvs())

  const support = {
    discord: welcomeInvite,
    issues: 'https://github.com/Canonry/canonry/issues',
    feedbackCommand: 'canonry feedback "<what happened>"',
  }
  const social = {
    x: 'https://x.com/canonry_ai',
    youtube: 'https://www.youtube.com/@Canonry_AI',
  }

  it('prints support and social links on a self-hosted install', () => {
    vi.stubEnv('CANONRY_RUNTIME_MODE', undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    supportCommand('text')
    for (const value of Object.values({ ...support, ...social })) {
      expect(log.mock.calls[0]?.[0]).toContain(value)
    }
    supportCommand('json')
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toEqual({ ...support, ...social })
  })

  it('shows the welcome invite in cloud mode and omits the social links', () => {
    vi.stubEnv('CANONRY_RUNTIME_MODE', ' Cloud ')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    supportCommand('text')
    for (const url of Object.values(social)) expect(log.mock.calls[0]?.[0]).not.toContain(url)
    supportCommand('json')
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toEqual(support)
  })
})

describe('the help hint on errors', () => {
  const tty = (value: boolean) => Object.defineProperty(process.stderr, 'isTTY', { value, configurable: true })
  afterEach(() => tty(false))

  it('points a person at a terminal to support after an unexpected error', () => {
    tty(true)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    printCliError(new Error('boom'), 'text')
    expect(err.mock.calls.map(c => String(c[0])).join('\n')).toContain(welcomeInvite)
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
    expect(err.mock.calls.map(c => String(c[0])).join('\n')).not.toMatch(/discord\.gg|canonry support/)
  })
})
