import { describe, expect, test } from 'vitest'

import { providerSummaryEntryDtoSchema } from '../src/settings.js'

describe('providerSummaryEntryDtoSchema', () => {
  test('keeps an explicit model override alongside the adapter default model', () => {
    const parsed = providerSummaryEntryDtoSchema.parse({
      name: 'openai',
      configured: true,
      model: 'gpt-4o',
      defaultModel: 'gpt-5.4',
    })

    expect(parsed.model).toBe('gpt-4o')
    expect(parsed.defaultModel).toBe('gpt-5.4')
  })

  test('allows the default model with no explicit override (the common case)', () => {
    const parsed = providerSummaryEntryDtoSchema.parse({
      name: 'claude',
      configured: true,
      defaultModel: 'claude-sonnet-4-6',
    })

    expect(parsed.model).toBeUndefined()
    expect(parsed.defaultModel).toBe('claude-sonnet-4-6')
  })

  test('treats defaultModel as optional so older payloads still parse', () => {
    const parsed = providerSummaryEntryDtoSchema.parse({
      name: 'local',
      configured: false,
    })

    expect(parsed.defaultModel).toBeUndefined()
  })
})
