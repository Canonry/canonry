import { describe, expect, test } from 'vitest'
import { buildBrandTokens, categorizeQueryByIntent } from '../src/query-categorize.js'

describe('buildBrandTokens', () => {
  test('strips TLD and produces a compact token from the canonical domain', () => {
    expect(buildBrandTokens('demand-iq.com')).toContain('demandiq')
  })

  test('includes brand names as compact tokens when distinct', () => {
    const tokens = buildBrandTokens('foo.com', ['Foo Bar'])
    expect(tokens).toContain('foobar')
  })

  test('drops tokens shorter than 3 characters', () => {
    const tokens = buildBrandTokens('a.com', ['B'])
    expect(tokens).toEqual([])
  })

  test('deduplicates tokens', () => {
    const tokens = buildBrandTokens('foo.com', ['foo'])
    expect(tokens).toEqual(['foo'])
  })

  test('includes multiple brand names (aliases)', () => {
    const tokens = buildBrandTokens('llamaindex.ai', ['LlamaIndex', 'LlamaParse'])
    expect(tokens).toContain('llamaindex')
    expect(tokens).toContain('llamaparse')
  })

  test('handles empty brand names array', () => {
    expect(buildBrandTokens('demand-iq.com', [])).toEqual(['demandiq'])
  })
})

describe('categorizeQueryByIntent', () => {
  const brand = ['demandiq']

  test('matches "demand iq" / "demandiq" / "demand iq login" all as brand', () => {
    expect(categorizeQueryByIntent('demand iq', brand)).toBe('brand')
    expect(categorizeQueryByIntent('demandiq', brand)).toBe('brand')
    expect(categorizeQueryByIntent('demand iq login', brand)).toBe('brand')
    expect(categorizeQueryByIntent('Demand IQ Pricing', brand)).toBe('brand')
  })

  test('matches hyphenated brand variants', () => {
    expect(categorizeQueryByIntent('demand-iq pricing', brand)).toBe('brand')
  })

  test('does not classify non-brand queries as brand', () => {
    expect(categorizeQueryByIntent('roofing estimate calculator', brand)).not.toBe('brand')
    expect(categorizeQueryByIntent('hvac lead generation', brand)).not.toBe('brand')
  })

  test('classifies transactional queries as lead-gen', () => {
    expect(categorizeQueryByIntent('buy hvac estimator', [])).toBe('lead-gen')
    expect(categorizeQueryByIntent('roofing services near me', [])).toBe('lead-gen')
    expect(categorizeQueryByIntent('hvac contractor agency', [])).toBe('lead-gen')
  })

  test('classifies informational queries as industry', () => {
    expect(categorizeQueryByIntent('how does aeo work', [])).toBe('industry')
    expect(categorizeQueryByIntent('what is mrr', [])).toBe('industry')
    expect(categorizeQueryByIntent('best aeo platforms vs', [])).toBe('industry')
  })

  test('falls back to other for unclassifiable queries', () => {
    expect(categorizeQueryByIntent('asdf qwerty', [])).toBe('other')
    expect(categorizeQueryByIntent('demand for hvac', [])).toBe('other')
  })

  test('brand match takes precedence over lead-gen / industry classifiers', () => {
    expect(categorizeQueryByIntent('demand iq buy', brand)).toBe('brand')
    expect(categorizeQueryByIntent('demand iq how to use', brand)).toBe('brand')
  })

  test('empty brand list never produces a brand match', () => {
    expect(categorizeQueryByIntent('demand iq', [])).not.toBe('brand')
  })
})
