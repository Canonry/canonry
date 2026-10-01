import { describe, expect, it } from 'vitest'
import { agentProviderIdSchema } from '../src/agent.js'
import {
  AGENT_PROVIDER_IDS,
  RETIRED_AGENT_PROVIDER_IDS,
  isAgentProviderId,
  isRetiredAgentProviderId,
} from '../src/providers.js'

describe('isRetiredAgentProviderId', () => {
  it('recognizes deepinfra as a removed agent provider', () => {
    expect(isRetiredAgentProviderId('deepinfra')).toBe(true)
  })

  it.each(['claude', 'openai', 'gemini', 'zai'])('does not treat the supported provider %s as removed', (id) => {
    expect(isRetiredAgentProviderId(id)).toBe(false)
  })

  it.each(['constructor', '__proto__', 'toString', '', 'nope', 'DeepInfra', ' deepinfra'])(
    'does not match %j',
    (value) => {
      expect(isRetiredAgentProviderId(value)).toBe(false)
    },
  )
})

describe('RETIRED_AGENT_PROVIDER_IDS', () => {
  it('never overlaps the supported agent providers', () => {
    expect(RETIRED_AGENT_PROVIDER_IDS.length).toBeGreaterThan(0)
    for (const id of RETIRED_AGENT_PROVIDER_IDS) {
      expect(AGENT_PROVIDER_IDS as readonly string[]).not.toContain(id)
      expect(isAgentProviderId(id)).toBe(false)
      expect(agentProviderIdSchema.safeParse(id).success).toBe(false)
    }
  })
})
