import { describe, expect, it } from 'vitest'
import { normalizeQueryText } from '../src/query-normalize.js'

describe('normalizeQueryText', () => {
  it('lowercases and trims surrounding whitespace', () => {
    expect(normalizeQueryText('  Best Dentist NYC  ')).toBe('best dentist nyc')
  })

  it('is idempotent', () => {
    const once = normalizeQueryText('Emergency Dentist Brooklyn')
    expect(normalizeQueryText(once)).toBe(once)
  })

  it('treats case/whitespace variants as the same identity', () => {
    expect(normalizeQueryText('Invisalign Brooklyn')).toBe(normalizeQueryText('invisalign brooklyn '))
  })

  it('preserves internal whitespace and punctuation (distinct queries stay distinct)', () => {
    expect(normalizeQueryText('dentist  near  me')).toBe('dentist  near  me')
    expect(normalizeQueryText("kids' dentist")).toBe("kids' dentist")
  })

  it('handles the empty string', () => {
    expect(normalizeQueryText('   ')).toBe('')
  })
})
