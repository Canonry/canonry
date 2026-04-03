import { vi, describe, it, expect, afterEach } from 'vitest'
import { systemError, CliError, EXIT_SYSTEM_ERROR } from '../src/cli-error.js'
import { runCli } from '../src/cli.js'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'

vi.mock('../src/cli-dispatch.js', () => ({
  dispatchRegisteredCommand: vi.fn(),
}))

describe('systemError()', () => {
  it('creates a CliError with code CLI_SYSTEM_ERROR and exitCode 2', () => {
    const err = systemError('provider call failed')
    expect(err).toBeInstanceOf(CliError)
    expect(err.code).toBe('CLI_SYSTEM_ERROR')
    expect(err.exitCode).toBe(EXIT_SYSTEM_ERROR)
    expect(err.exitCode).toBe(2)
    expect(err.message).toBe('provider call failed')
  })

  it('accepts optional displayMessage and details', () => {
    const err = systemError('network timeout', {
      displayMessage: 'Connection timed out. Please try again.',
      details: { url: 'https://api.example.com' },
    })
    expect(err.displayMessage).toBe('Connection timed out. Please try again.')
    expect(err.details).toEqual({ url: 'https://api.example.com' })
  })
})

describe('runCli() exit code propagation', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  it('returns 2 when a systemError is thrown by a command', async () => {
    vi.mocked(dispatchRegisteredCommand).mockRejectedValueOnce(
      systemError('provider unavailable'),
    )
    const origError = console.error
    console.error = () => {}
    try {
      expect(await runCli(['run', 'my-project'])).toBe(2)
    } finally {
      console.error = origError
    }
  })

  it('returns 2 when an unexpected non-CliError exception is thrown', async () => {
    vi.mocked(dispatchRegisteredCommand).mockRejectedValueOnce(
      new Error('unexpected crash'),
    )
    const origError = console.error
    console.error = () => {}
    try {
      expect(await runCli(['run', 'my-project'])).toBe(2)
    } finally {
      console.error = origError
    }
  })
})
