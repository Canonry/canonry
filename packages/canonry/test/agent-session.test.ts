import { describe, expect, it } from 'vitest'
import { resolveAgentSessionKey } from '../src/agent-session.js'
import type { CanonryConfig } from '../src/config.js'

function makeConfig(agent?: CanonryConfig['agent']): CanonryConfig {
  return {
    apiUrl: 'http://localhost:3000/api/v1',
    agent,
  } as CanonryConfig
}

describe('resolveAgentSessionKey', () => {
  it('returns default key when no agent config', () => {
    expect(resolveAgentSessionKey(makeConfig())).toBe('agent:aero:main')
  })

  it('returns default key when agent config has no sessionKey or profile', () => {
    expect(resolveAgentSessionKey(makeConfig({ binary: '/usr/bin/openclaw' }))).toBe('agent:aero:main')
  })

  it('uses custom profile in key', () => {
    expect(resolveAgentSessionKey(makeConfig({ profile: 'custom' }))).toBe('agent:custom:main')
  })

  it('returns explicit sessionKey when set', () => {
    expect(resolveAgentSessionKey(makeConfig({
      profile: 'custom',
      sessionKey: 'agent:mybot:special',
    }))).toBe('agent:mybot:special')
  })

  it('prefers sessionKey over profile-derived key', () => {
    expect(resolveAgentSessionKey(makeConfig({
      profile: 'aero',
      sessionKey: 'override:key',
    }))).toBe('override:key')
  })
})
