import { describe, expect, it, vi } from 'vitest'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { CliError, EXIT_SYSTEM_ERROR, printCliError, usageError, type CliFormat } from '../src/cli-error.js'

vi.mock('../src/commands/agent.js', () => ({
  agentAttach: vi.fn(),
  agentDetach: vi.fn(),
}))

vi.mock('../src/commands/agent-ask.js', () => ({
  agentAsk: vi.fn(),
}))

vi.mock('../src/commands/agent-providers.js', () => ({
  agentProviders: vi.fn(),
}))

vi.mock('../src/commands/agent-transcript.js', () => ({
  agentTranscript: vi.fn(),
  agentTranscriptReset: vi.fn(),
}))

vi.mock('../src/commands/agent-memory.js', () => ({
  agentMemoryForget: vi.fn(),
  agentMemoryList: vi.fn(),
  agentMemorySet: vi.fn(),
}))

vi.mock('../src/agent/session.js', () => ({
  coerceAgentProvider: (value: string) => (
    ['claude', 'openai', 'gemini', 'zai'].includes(value)
      ? value
      : undefined
  ),
  listAgentProviders: () => ['claude', 'openai', 'gemini', 'zai'],
}))

const { AGENT_CLI_COMMANDS } = await import('../src/cli-commands/agent.js')

async function invokeAgentCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode?: number }> {
  const format: CliFormat = args.includes('--format') && args[args.indexOf('--format') + 1] === 'json' ? 'json' : 'text'
  const logs: string[] = []
  const errors: string[] = []
  const writes: string[] = []
  const origLog = console.log
  const origError = console.error
  const origStderrWrite = process.stderr.write
  let exitCode: number | undefined

  console.log = (...parts: unknown[]) => logs.push(parts.join(' '))
  console.error = (...parts: unknown[]) => errors.push(parts.join(' '))
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'))
    return true
  }) as typeof process.stderr.write

  try {
    try {
      const handled = await dispatchRegisteredCommand(args, format, AGENT_CLI_COMMANDS)
      if (!handled) {
        throw usageError('Error: unknown command: agent\nRun "canonry --help" for usage.', {
          message: 'unknown command: agent',
          details: {
            command: 'agent',
            usage: 'canonry --help',
          },
        })
      }
    } catch (err) {
      printCliError(err, format)
      exitCode = err instanceof CliError ? err.exitCode : EXIT_SYSTEM_ERROR
    }
  } finally {
    console.log = origLog
    console.error = origError
    process.stderr.write = origStderrWrite
  }

  return {
    stdout: logs.join('\n'),
    stderr: [...errors, ...writes].filter(Boolean).join('\n'),
    exitCode,
  }
}

describe('agent CLI contract', () => {
  it('prints a JSON usage error for agent providers with no project', async () => {
    const result = await invokeAgentCli(['agent', 'providers', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { command: string; usage: string } }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe('project name is required')
    expect(parsed.error.details.command).toBe('agent.providers')
    expect(parsed.error.details.usage).toBe('canonry agent providers <project> [--format json]')
  })

  it('prints a JSON usage error for agent ask with no prompt', async () => {
    const result = await invokeAgentCli(['agent', 'ask', 'demo', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { command: string; usage: string } }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe('prompt is required')
    expect(parsed.error.details.command).toBe('agent.ask')
    expect(parsed.error.details.usage).toContain('canonry agent ask <project>')
  })

  it('prints a JSON usage error for agent ask with an invalid provider', async () => {
    const result = await invokeAgentCli(['agent', 'ask', 'demo', 'hello', '--provider', 'bogus', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const parsed = JSON.parse(result.stderr) as {
      error: {
        code: string
        message: string
        details: { command: string; provider: string; validProviders: string[] }
      }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toContain('--provider must be one of:')
    expect(parsed.error.details.command).toBe('agent.ask')
    expect(parsed.error.details.provider).toBe('bogus')
    expect(parsed.error.details.validProviders.length).toBeGreaterThan(0)
  })

  it('prints a JSON usage error for agent attach with no url', async () => {
    const result = await invokeAgentCli(['agent', 'attach', 'demo', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const parsed = JSON.parse(result.stderr) as {
      error: {
        code: string
        message: string
        details: { command: string; usage: string; flag: string }
      }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe('--url is required')
    expect(parsed.error.details.command).toBe('agent.attach')
    expect(parsed.error.details.flag).toBe('url')
  })

  it('prints a JSON usage error for agent memory set with no value', async () => {
    const result = await invokeAgentCli(['agent', 'memory', 'set', 'demo', '--key', 'status', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const parsed = JSON.parse(result.stderr) as {
      error: {
        code: string
        message: string
        details: { command: string; usage: string; flag: string }
      }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe('--value is required')
    expect(parsed.error.details.command).toBe('agent.memory.set')
    expect(parsed.error.details.flag).toBe('value')
  })
})
