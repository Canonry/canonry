import { describe, expect, it } from 'vitest'
import { normalizeIdentityText, normalizeQueryText } from '../src/query-normalize.js'

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

describe('normalizeIdentityText', () => {
  it('trims, collapses internal whitespace and lowercases', () => {
    expect(normalizeIdentityText('  Best   Dentist\tNYC \n')).toBe('best dentist nyc')
  })

  it('lowercases without Unicode case folding', () => {
    // Full case folding would map ß to ss; lowercasing keeps the two apart.
    expect(normalizeIdentityText('Straße')).toBe('straße')
    expect(normalizeIdentityText('STRASSE')).toBe('strasse')
  })

  it('applies NFKC, so compatibility forms share one identity', () => {
    // Full-width letters and a non-breaking space fold to their plain forms.
    expect(normalizeIdentityText('ＧＥＭＩＮＩ Pro')).toBe('gemini pro')
    expect(normalizeIdentityText('ﬁle')).toBe('file')
  })

  it('is idempotent', () => {
    const once = normalizeIdentityText(' New  York, NY ')
    expect(normalizeIdentityText(once)).toBe(once)
  })

  it('handles the empty string', () => {
    expect(normalizeIdentityText('   ')).toBe('')
  })
})
