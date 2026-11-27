import { Console } from 'node:console'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConnectionTestResultDto } from '@canonry/canonry-contracts'

const mockTestProvider = vi.fn<(name: string) => Promise<ProviderConnectionTestResultDto>>()

vi.mock('../src/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client.js')>()),
  createApiClient: () => ({ testProvider: mockTestProvider }),
}))

const { runCli } = await import('../src/cli.js')

async function cli(args: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalLog = console.log
  const originalError = console.error
  const originalWrite = process.stderr.write
  const terminal = new Console({ stdout: process.stdout, stderr: process.stderr })
  console.log = (...parts: unknown[]) => { stdout.push(parts.join(' ')) }
  console.error = terminal.error.bind(terminal)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'))
    return true
  }) as typeof process.stderr.write
  try {
    const exitCode = await runCli(args)
    return { stdout: stdout.join('\n'), stderr: stderr.join(''), exitCode }
  } finally {
    console.log = originalLog
    console.error = originalError
    process.stderr.write = originalWrite
  }
}

function result(overrides: Partial<ProviderConnectionTestResultDto>): ProviderConnectionTestResultDto {
  return {
    provider: 'gemini',
    displayName: 'Gemini',
    status: 'connected',
    ok: true,
    message: 'gemini api key verified',
    model: 'gemini-flash-latest',
    checkedAt: '2026-11-08T10:00:00.000Z',
    durationMs: 1200,
    ...overrides,
  }
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('canonry settings provider test', () => {
  it.each([
    { result: result({}), exitCode: 0, heading: 'Gemini: connected' },
    {
      result: result({ provider: 'exa', displayName: 'Exa', status: 'not-verified', message: 'Exa key saved, not verified: the service documents no free key check.', model: null }),
      exitCode: 0,
      heading: 'Exa: saved, not verified',
    },
    { result: result({ status: 'failed', ok: false, message: '400 API key not valid.' }), exitCode: 2, heading: 'Gemini: failed' },
  ])('prints "$heading" and exits $exitCode', async ({ result: tested, exitCode, heading }) => {
    mockTestProvider.mockResolvedValue(tested)
    const output = await cli(['settings', 'provider', 'test', tested.provider])
    // "provider test <name>" is the test, never an update of a provider called "test".
    expect(mockTestProvider).toHaveBeenCalledWith(tested.provider)
    expect(output.exitCode).toBe(exitCode)
    expect(output.stdout.split('\n')).toEqual([
      heading,
      ...(tested.model ? [`  Model:   ${tested.model}`] : []),
      `  Result:  ${tested.message}`,
      `  Checked: ${tested.checkedAt} (1s)`,
    ])
    if (exitCode === 2) {
      expect(output.stderr).toContain('Error: the Gemini connection test failed. Fix the saved key or endpoint with "canonry settings provider gemini", then test again.')
    } else {
      expect(output.stderr).toBe('')
    }
  })

  it('keeps stdout exactly the API result in JSON and puts the failure envelope on stderr', async () => {
    const failed = result({ status: 'failed', ok: false, message: '400 API key not valid.' })
    mockTestProvider.mockResolvedValue(failed)
    const output = await cli(['settings', 'provider', 'test', 'gemini', '--format', 'json'])
    expect(output.exitCode).toBe(2)
    expect(JSON.parse(output.stdout)).toEqual(failed)
    expect(JSON.parse(output.stderr)).toEqual({
      error: {
        code: 'PROVIDER_TEST_FAILED',
        message: 'Gemini connection test failed: 400 API key not valid.',
        details: { provider: 'gemini', status: 'failed' },
      },
    })
  })

  it('exits 1 without calling the server when no provider is named', async () => {
    const output = await cli(['settings', 'provider', 'test', '--format', 'json'])
    expect(output.exitCode).toBe(1)
    expect(JSON.parse(output.stderr)).toMatchObject({ error: { code: 'CLI_USAGE_ERROR' } })
    expect(mockTestProvider).not.toHaveBeenCalled()
  })
})
