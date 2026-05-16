import { describe, it, expect, vi } from 'vitest'
import { dispatchRegisteredCommand, type CliCommandSpec } from '../src/cli-dispatch.js'
import { CliError } from '../src/cli-error.js'

describe('dispatchRegisteredCommand --dry-run global flag', () => {
  it('passes dryRun=true to commands that opt in via supportsDryRun', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const spec: CliCommandSpec = {
      path: ['demo'],
      usage: 'canonry demo [--dry-run]',
      supportsDryRun: true,
      run,
    }

    await dispatchRegisteredCommand(['demo', '--dry-run'], 'text', [spec])

    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![0].dryRun).toBe(true)
  })

  it('passes dryRun=false to commands when flag is absent', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const spec: CliCommandSpec = {
      path: ['demo'],
      usage: 'canonry demo',
      supportsDryRun: true,
      run,
    }

    await dispatchRegisteredCommand(['demo'], 'text', [spec])

    expect(run.mock.calls[0]![0].dryRun).toBe(false)
  })

  it('rejects --dry-run on commands that do not opt in', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const spec: CliCommandSpec = {
      path: ['demo'],
      usage: 'canonry demo',
      // supportsDryRun omitted — defaults to false
      run,
    }

    await expect(
      dispatchRegisteredCommand(['demo', '--dry-run'], 'text', [spec]),
    ).rejects.toThrow(CliError)

    expect(run).not.toHaveBeenCalled()
  })

  it('rejection mentions the command and the supported alternatives', async () => {
    const spec: CliCommandSpec = {
      path: ['demo'],
      usage: 'canonry demo',
      run: vi.fn(),
    }

    try {
      await dispatchRegisteredCommand(['demo', '--dry-run'], 'text', [spec])
      throw new Error('expected rejection')
    } catch (err) {
      expect(err).toBeInstanceOf(CliError)
      const message = (err as CliError).message
      expect(message.toLowerCase()).toContain('--dry-run')
      expect(message.toLowerCase()).toContain('does not support')
    }
  })

  it('commands not opting in can still use other options without conflict', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const spec: CliCommandSpec = {
      path: ['demo'],
      usage: 'canonry demo [--name <name>]',
      options: { name: { type: 'string' } },
      run,
    }

    await dispatchRegisteredCommand(['demo', '--name', 'foo'], 'text', [spec])

    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![0].dryRun).toBe(false)
    expect(run.mock.calls[0]![0].values.name).toBe('foo')
  })

  it('--dry-run combines with --format json on supporting commands', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const spec: CliCommandSpec = {
      path: ['demo'],
      usage: 'canonry demo [--dry-run]',
      supportsDryRun: true,
      run,
    }

    await dispatchRegisteredCommand(['demo', '--dry-run', '--format', 'json'], 'text', [spec])

    expect(run.mock.calls[0]![0].dryRun).toBe(true)
    expect(run.mock.calls[0]![0].format).toBe('json')
  })
})
