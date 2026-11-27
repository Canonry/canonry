import { describe, expect, test } from 'vitest'
import { effectiveBrandNames, formatLocaleLabel, normalizeQueryText, suggestedBrandName, uniqueQueryTexts } from '../src/index.js'

describe('formatLocaleLabel', () => {
  test('names the country and language as people read them', () => {
    expect(formatLocaleLabel('US', 'en')).toBe('United States · English')
    expect(formatLocaleLabel('gb', 'FR')).toBe('United Kingdom · French')
  })

  test('keeps a code it cannot name and never collapses to a bare separator', () => {
    expect(formatLocaleLabel('USA', 'en')).toBe('USA · English')
    expect(formatLocaleLabel('', '')).toBe('Country · Language')
    expect(formatLocaleLabel('  ', 'de')).toBe('Country · German')
  })
})

describe('suggestedBrandName', () => {
  test('title-cases the domain label', () => {
    expect(suggestedBrandName('canonry.ai')).toBe('Canonry')
    expect(suggestedBrandName('https://www.Summit-Roofing.com/pricing')).toBe('Summit Roofing')
    expect(suggestedBrandName('shop.example.co.uk')).toBe('Example')
  })

  test('keeps the full domain when the label is too short to be a brand name', () => {
    expect(suggestedBrandName('ai.com')).toBe('ai.com')
    expect(suggestedBrandName('hp.com')).toBe('hp.com')
  })

  test('adds no brand identity that the domain does not already contribute to mention matching', () => {
    for (const domain of ['canonry.ai', 'summit-roofing.com', 'ai.com', 'shop.example.co.uk']) {
      const fromDomain = effectiveBrandNames({ canonicalDomain: domain })
      const withSuggestion = effectiveBrandNames({ canonicalDomain: domain, displayName: suggestedBrandName(domain) })
      expect(withSuggestion).toHaveLength(fromDomain.length)
    }
  })
})

describe('uniqueQueryTexts', () => {
  test('keeps each query once, first spelling, trimmed, in order', () => {
    expect(uniqueQueryTexts(['Best CRM ', 'best crm', '  ', 'crm pricing', 'BEST CRM', 'crm  pricing'])).toEqual([
      'Best CRM',
      'crm pricing',
      // Internal whitespace is part of the query, as on the server.
      'crm  pricing',
    ])
  })

  test('collapses exactly as normalizeQueryText keys queries', () => {
    const texts = ['A', 'a', ' a ', 'b']
    expect(uniqueQueryTexts(texts)).toHaveLength(new Set(texts.map(normalizeQueryText).filter(Boolean)).size)
  })
})
