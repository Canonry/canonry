import { describe, expect, it } from 'vitest'
import { formatModelName } from '../src/models.js'

describe('formatModelName', () => {
  it.each([
    ['google/gemini-2.5-flash', 'Gemini 2.5 Flash'],
    ['anthropic/claude-sonnet-4-5', 'Claude Sonnet 4-5'],
    ['openai/gpt-4o-mini-2024-07-18', 'GPT-4o Mini 2024-07-18'],
    ['openai/o3-mini', 'o3 Mini'],
    ['google/gemini-2.5-flash:free', 'Gemini 2.5 Flash: Free'],
    ['google/gemini-2.5-flash:extended', 'Gemini 2.5 Flash: Extended'],
    ['acme/gemini-2.5-flash', 'Acme: Gemini 2.5 Flash'],
    ['other/gemini-2.5-flash', 'Other: Gemini 2.5 Flash'],
    ['custom_model-v2', 'Custom Model V2'],
    ['', ''],
  ])('keeps %s readable and distinguishable without a catalog', (id, label) => {
    expect(formatModelName(id)).toBe(label)
  })

  it('uses the catalog name for its exact ID, removing only its redundant publisher prefix', () => {
    const catalog = [
      { id: 'anthropic/claude-sonnet-4-5', displayName: 'Anthropic: Claude Sonnet 4.5' },
      { id: 'acme/special-v2', displayName: 'Acme: Special Edition II' },
    ]
    expect(formatModelName('anthropic/claude-sonnet-4-5', catalog)).toBe('Claude Sonnet 4.5')
    expect(formatModelName('acme/special-v2', catalog)).toBe('Acme: Special Edition II')
    expect(formatModelName('other/special-v2', catalog)).toBe('Other: Special V2')
  })

  it('keeps a saved model readable when its catalog label is missing or blank', () => {
    expect(formatModelName('google/gemini-2.5-flash', [{ id: 'google/gemini-2.5-flash', displayName: '  ' }])).toBe('Gemini 2.5 Flash')
  })
})
