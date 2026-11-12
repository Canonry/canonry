import { describe, expect, test } from 'vitest'

import { providerConnectionTestResultDtoSchema, providerSummaryEntryDtoSchema } from '../src/settings.js'

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

describe('providerConnectionTestResultDtoSchema', () => {
  const result = { provider: 'exa', displayName: 'Exa', message: 'Exa key saved, not verified', model: null, checkedAt: '2026-11-08T10:00:00.000Z', durationMs: 4 }

  // Agents branch on ok; it must never call an unproven or failed connection working the other way round.
  test.each([
    { status: 'connected', ok: true, valid: true },
    { status: 'not-verified', ok: true, valid: true },
    { status: 'failed', ok: false, valid: true },
    { status: 'failed', ok: true, valid: false },
    { status: 'connected', ok: false, valid: false },
    { status: 'not-verified', ok: false, valid: false },
  ])('ok is false exactly when status is failed: $status with ok $ok', ({ status, ok, valid }) => {
    expect(providerConnectionTestResultDtoSchema.safeParse({ ...result, status, ok }).success).toBe(valid)
  })
})

