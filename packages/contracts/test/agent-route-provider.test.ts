import { describe, expect, it } from 'vitest'
import {
  aeroProviderIdSchema,
  agentProviderIdSchema,
  agentProvidersResponseDtoSchema,
} from '../src/agent.js'

describe('Aero route provider identity', () => {
  it('adds configured route IDs without widening the native provider enum', () => {
    expect(agentProviderIdSchema.safeParse('claude').success).toBe(true)
    expect(agentProviderIdSchema.safeParse('route:gateway-openai-gpt-5').success).toBe(false)

    expect(aeroProviderIdSchema.safeParse('claude').success).toBe(true)
    expect(aeroProviderIdSchema.safeParse('route:gateway-openai-gpt-5').success).toBe(true)
    expect(aeroProviderIdSchema.safeParse('route:').success).toBe(false)
    expect(aeroProviderIdSchema.safeParse('not-a-provider').success).toBe(false)
  })

  it('accepts a configured route in the provider-picker response', () => {
    const parsed = agentProvidersResponseDtoSchema.parse({
      providers: [{
        id: 'route:gateway-openai-gpt-5',
        label: 'Gateway GPT-5',
        defaultModel: 'openai/gpt-5',
        configured: true,
        keySource: 'config',
      }],
      defaultProvider: 'route:gateway-openai-gpt-5',
    })

    expect(parsed.defaultProvider).toBe('route:gateway-openai-gpt-5')
  })
})
