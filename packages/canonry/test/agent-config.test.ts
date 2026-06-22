import { describe, it, expect } from 'vitest'
import { resolveAgentEnabled } from '../src/agent-config.js'
import type { CanonryConfig } from '../src/config.js'

function cfg(agent?: CanonryConfig['agent']): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: ':memory:',
    apiKey: 'cnry_test',
    ...(agent ? { agent } : {}),
  } as CanonryConfig
}

describe('resolveAgentEnabled', () => {
  it('defaults to enabled with no env and no config', () => {
    expect(resolveAgentEnabled({}, cfg())).toBe(true)
  })

  it('config agent.mode "disabled" disables', () => {
    expect(resolveAgentEnabled({}, cfg({ mode: 'disabled' }))).toBe(false)
  })

  it('CANONRY_AGENT_DISABLED=1 disables (no config)', () => {
    expect(resolveAgentEnabled({ CANONRY_AGENT_DISABLED: '1' }, cfg())).toBe(false)
  })

  it('CANONRY_AGENT_DISABLED=true disables (case-insensitive)', () => {
    expect(resolveAgentEnabled({ CANONRY_AGENT_DISABLED: 'TRUE' }, cfg())).toBe(false)
  })

  it('CANONRY_AGENT_DISABLED=0 forces enabled, overriding a config disable', () => {
    expect(resolveAgentEnabled({ CANONRY_AGENT_DISABLED: '0' }, cfg({ mode: 'disabled' }))).toBe(true)
  })

  it('CANONRY_AGENT_DISABLED=false forces enabled, overriding a config disable', () => {
    expect(resolveAgentEnabled({ CANONRY_AGENT_DISABLED: 'false' }, cfg({ mode: 'disabled' }))).toBe(true)
  })

  it('empty / whitespace env falls through to config', () => {
    expect(resolveAgentEnabled({ CANONRY_AGENT_DISABLED: '   ' }, cfg({ mode: 'disabled' }))).toBe(false)
    expect(resolveAgentEnabled({ CANONRY_AGENT_DISABLED: '' }, cfg())).toBe(true)
  })
})
