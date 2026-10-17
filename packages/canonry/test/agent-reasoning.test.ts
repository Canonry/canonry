/**
 * Aero's reasoning level (`agent.reasoning`, `CANONRY_AGENT_REASONING`, and the
 * per-provider default). Canonry used to leave it unset, so every model ran with
 * reasoning off.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { AGENT_REASONING_LEVELS } from '@canonry/canonry-config'
import { AGENT_PROVIDER_IDS } from '@canonry/canonry-contracts'
import { resolveAgentReasoning } from '../src/agent-config.js'
import { PROVIDER_DEFAULT_REASONING } from '../src/agent/providers.js'
import { createAeroSession } from '../src/agent/session.js'
import type { ApiClient } from '../src/client.js'
import { CliError } from '../src/cli-error.js'
import { getConfigPath, loadConfig, type CanonryConfig } from '../src/config.js'

function config(providers: CanonryConfig['providers'], agent?: CanonryConfig['agent']): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: ':memory:',
    apiKey: 'cnry_test',
    providers,
    ...(agent ? { agent } : {}),
  } as CanonryConfig
}

describe('PROVIDER_DEFAULT_REASONING', () => {
  it('has a valid level for every Aero provider, low for OpenAI and off for the rest', () => {
    expect(Object.keys(PROVIDER_DEFAULT_REASONING).sort()).toEqual([...AGENT_PROVIDER_IDS].sort())
    for (const level of Object.values(PROVIDER_DEFAULT_REASONING)) expect(AGENT_REASONING_LEVELS).toContain(level)
    expect(PROVIDER_DEFAULT_REASONING).toEqual({ claude: 'off', openai: 'low', gemini: 'off', zai: 'off' })
  })
})

describe('resolveAgentReasoning', () => {
  it('uses the provider default with no env and no config', () => {
    expect(resolveAgentReasoning({}, config({}), 'openai')).toBe('low')
    expect(resolveAgentReasoning({}, config({}), 'claude')).toBe('off')
  })

  it('agent.reasoning overrides the provider default, either way', () => {
    expect(resolveAgentReasoning({}, config({}, { reasoning: 'off' }), 'openai')).toBe('off')
    expect(resolveAgentReasoning({}, config({}, { reasoning: 'medium' }), 'claude')).toBe('medium')
  })

  it('CANONRY_AGENT_REASONING overrides the config, case-insensitively', () => {
    expect(resolveAgentReasoning({ CANONRY_AGENT_REASONING: 'high' }, config({}, { reasoning: 'off' }), 'openai')).toBe('high')
    expect(resolveAgentReasoning({ CANONRY_AGENT_REASONING: ' OFF ' }, config({}), 'openai')).toBe('off')
  })

  it('ignores an unknown or empty env value and falls back to the config', () => {
    expect(resolveAgentReasoning({ CANONRY_AGENT_REASONING: 'fast' }, config({}, { reasoning: 'medium' }), 'openai')).toBe('medium')
    expect(resolveAgentReasoning({ CANONRY_AGENT_REASONING: '   ' }, config({}), 'openai')).toBe('low')
  })
})

describe('createAeroSession reasoning level', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function session(cfg: CanonryConfig) {
    return createAeroSession({ projectName: 'demo', client: {} as ApiClient, config: cfg, systemPromptOverride: 'Test.' })
  }

  it('asks an OpenAI model for low reasoning by default', () => {
    expect(session(config({ openai: { apiKey: 'openai-key' } })).state.thinkingLevel).toBe('low')
  })

  it('leaves reasoning off for Claude by default', () => {
    expect(session(config({ claude: { apiKey: 'anthropic-key' } })).state.thinkingLevel).toBe('off')
  })

  it('applies agent.reasoning, and the env over it', () => {
    const cfg = config({ openai: { apiKey: 'openai-key' } }, { reasoning: 'medium' })
    expect(session(cfg).state.thinkingLevel).toBe('medium')
    vi.stubEnv('CANONRY_AGENT_REASONING', 'off')
    expect(session(cfg).state.thinkingLevel).toBe('off')
  })
})

describe('loadConfig agent.reasoning', () => {
  let configDir: string

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-reasoning-'))
    vi.stubEnv('CANONRY_CONFIG_DIR', configDir)
    vi.stubEnv('CANONRY_PORT', undefined as unknown as string)
    vi.stubEnv('CANONRY_BASE_PATH', undefined as unknown as string)
    vi.stubEnv('CANONRY_EXTERNAL_MCP', undefined as unknown as string)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  function writeConfig(agent: Record<string, unknown>): void {
    const cfg = {
      apiUrl: 'http://127.0.0.1:4999',
      database: path.join(configDir, 'data.sqlite'),
      apiKey: 'cnry_reasoning_fixture',
      providers: {},
      agent,
    }
    fs.writeFileSync(getConfigPath(), stringify(cfg), { mode: 0o600 })
  }

  it('loads a valid level', () => {
    writeConfig({ reasoning: 'low' })
    expect(loadConfig().agent?.reasoning).toBe('low')
  })

  it('rejects an unknown level and lists the valid ones', () => {
    writeConfig({ reasoning: 'fast' })
    let error: unknown
    try {
      loadConfig()
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).toBe('CONFIG_INVALID')
    expect((error as CliError).message).toBe(
      `Invalid config at ${getConfigPath()}: agent.reasoning must be one of ${AGENT_REASONING_LEVELS.join(', ')}, or left blank.`,
    )
  })
})
