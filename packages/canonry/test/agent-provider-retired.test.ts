import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { AGENT_PROVIDER_IDS, agentProviderIdSchema } from '@ainyc/canonry-contracts'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { CliError, EXIT_SYSTEM_ERROR, printCliError, type CliFormat } from '../src/cli-error.js'
import { getConfigPath, loadConfig, type CanonryConfig } from '../src/config.js'

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

// Keep the real provider guard from the registry so the CLI check runs against
// the shipped provider list, without loading the full session runtime.
vi.mock('../src/agent/session.js', async () => {
  const providers = await import('../src/agent/providers.js')
  return {
    coerceAgentProvider: providers.coerceAgentProvider,
    listAgentProviders: providers.listAgentProviders,
  }
})

const { AGENT_CLI_COMMANDS } = await import('../src/cli-commands/agent.js')
const { agentAsk } = await import('../src/commands/agent-ask.js')

const SUPPORTED_LIST = 'claude, openai, gemini, zai'

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
      if (!handled) throw new Error(`agent CLI did not handle: ${args.join(' ')}`)
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

type JsonUsageError = {
  error: {
    code: string
    message: string
    details: { command: string; provider: string; validProviders: string[] }
  }
}

describe('retired agent provider ids in contracts', () => {
  it('drops deepinfra from the agent provider list and schema', () => {
    expect(AGENT_PROVIDER_IDS).toEqual(['claude', 'openai', 'gemini', 'zai'])
    expect(AGENT_PROVIDER_IDS as readonly string[]).not.toContain('deepinfra')
    expect(agentProviderIdSchema.safeParse('deepinfra').success).toBe(false)
    expect(agentProviderIdSchema.safeParse('zai').success).toBe(true)
  })
})

describe('loadConfig with a retired agent.provider pin', () => {
  let configDir: string

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-provider-retired-'))
    vi.stubEnv('CANONRY_CONFIG_DIR', configDir)
    vi.stubEnv('CANONRY_PORT', undefined as unknown as string)
    vi.stubEnv('CANONRY_BASE_PATH', undefined as unknown as string)
    vi.stubEnv('CANONRY_EXTERNAL_MCP', undefined as unknown as string)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  function writeConfig(agent: Record<string, unknown>, providers: CanonryConfig['providers'] = {}): void {
    const config = {
      apiUrl: 'http://127.0.0.1:4999',
      database: path.join(configDir, 'data.sqlite'),
      apiKey: 'cnry_retired_provider_fixture',
      providers,
      agent,
    }
    fs.writeFileSync(getConfigPath(), stringify(config), { mode: 0o600 })
  }

  function loadConfigError(): CliError {
    try {
      loadConfig()
    } catch (error) {
      expect(error).toBeInstanceOf(CliError)
      return error as CliError
    }
    throw new Error('expected loadConfig to throw')
  }

  it('rejects agent.provider deepinfra as removed and names the supported providers', () => {
    writeConfig({ provider: 'deepinfra' })

    const error = loadConfigError()
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toBe(
      `Invalid config at ${getConfigPath()}: agent.provider deepinfra was removed. `
      + `Pin one of ${SUPPORTED_LIST} (with a key under providers.<name>.apiKey), or leave it blank.`,
    )
    expect(error.message).not.toContain('must be one of')
  })

  it('rejects a removed pin even when a model is pinned alongside it', () => {
    writeConfig({ provider: 'deepinfra', model: 'some-model' })

    const error = loadConfigError()
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('agent.provider deepinfra was removed')
  })

  it('keeps the generic message for an id that was never a provider', () => {
    writeConfig({ provider: 'nope' })

    const error = loadConfigError()
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toBe(
      `Invalid config at ${getConfigPath()}: agent.provider must be one of ${SUPPORTED_LIST}, or left blank.`,
    )
    expect(error.message).not.toContain('was removed')
  })

  it('loads a supported pin', () => {
    writeConfig({ provider: 'zai' }, { zai: { apiKey: 'test-zai-key' } })

    const config = loadConfig()
    expect(config.agent?.provider).toBe('zai')
  })

  it('loads when agent.provider is left blank', () => {
    writeConfig({ provider: null })

    expect(() => loadConfig()).not.toThrow()
  })
})

describe('agent ask --provider with a retired id', () => {
  beforeEach(() => {
    vi.mocked(agentAsk).mockClear()
  })

  it('rejects --provider deepinfra as removed and names the supported providers', async () => {
    const result = await invokeAgentCli(['agent', 'ask', 'demo', 'hello', '--provider', 'deepinfra', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const parsed = JSON.parse(result.stderr) as JsonUsageError
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe(`--provider deepinfra was removed; use one of: ${SUPPORTED_LIST}`)
    expect(parsed.error.details.command).toBe('agent.ask')
    expect(parsed.error.details.provider).toBe('deepinfra')
    expect(parsed.error.details.validProviders).toEqual(['claude', 'openai', 'gemini', 'zai'])
    expect(agentAsk).not.toHaveBeenCalled()
  })

  it('prints the removed message in text mode too', async () => {
    const result = await invokeAgentCli(['agent', 'ask', 'demo', 'hello', '--provider', 'deepinfra'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`Error: --provider deepinfra was removed; use one of: ${SUPPORTED_LIST}`)
    expect(agentAsk).not.toHaveBeenCalled()
  })

  it('keeps the generic message for an id that was never a provider', async () => {
    const result = await invokeAgentCli(['agent', 'ask', 'demo', 'hello', '--provider', 'nope', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    const parsed = JSON.parse(result.stderr) as JsonUsageError
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe(`--provider must be one of: ${SUPPORTED_LIST}`)
    expect(parsed.error.details.provider).toBe('nope')
    expect(agentAsk).not.toHaveBeenCalled()
  })

  it('passes a supported provider through to the ask command', async () => {
    const result = await invokeAgentCli(['agent', 'ask', 'demo', 'hello', '--provider', 'zai', '--format', 'json'])

    expect(result.exitCode).toBeUndefined()
    expect(agentAsk).toHaveBeenCalledTimes(1)
    expect(vi.mocked(agentAsk).mock.calls[0]![0]).toMatchObject({ project: 'demo', prompt: 'hello', provider: 'zai' })
  })
})
