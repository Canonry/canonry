import { describe, expect, test } from 'vitest'
import { buildBrandTokens, categorizeQueryByIntent } from '../src/query-categorize.js'

describe('buildBrandTokens', () => {
  test('strips TLD and produces a compact token from the canonical domain', () => {
    expect(buildBrandTokens('vexlo-iq.test')).toContain('vexloiq')
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
    expect(buildBrandTokens('vexlo-iq.test', [])).toEqual(['vexloiq'])
  })
})

describe('categorizeQueryByIntent', () => {
  const brand = ['vexloiq']

  test('matches "vexlo iq" / "vexloiq" / "vexlo iq login" all as brand', () => {
    expect(categorizeQueryByIntent('vexlo iq', brand)).toBe('brand')
    expect(categorizeQueryByIntent('vexloiq', brand)).toBe('brand')
    expect(categorizeQueryByIntent('vexlo iq login', brand)).toBe('brand')
    expect(categorizeQueryByIntent('Vexlo IQ Pricing', brand)).toBe('brand')
  })

  test('matches hyphenated brand variants', () => {
    expect(categorizeQueryByIntent('vexlo-iq pricing', brand)).toBe('brand')
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
    expect(categorizeQueryByIntent('vexlo iq buy', brand)).toBe('brand')
    expect(categorizeQueryByIntent('vexlo iq how to use', brand)).toBe('brand')
  })

  test('empty brand list never produces a brand match', () => {
    expect(categorizeQueryByIntent('vexlo iq', [])).not.toBe('brand')
  })
})

describe('approved brand aliases', () => {
  const withoutAlias = buildBrandTokens('vantrellhotel.test', ['Vantrell Hotel'])
  const vantrell = buildBrandTokens('vantrellhotel.test', ['Vantrell Hotel', 'Vantrell'])
  const vexloiq = buildBrandTokens('vexlo-iq.test', ['Vexlo IQ'])

  test('does not derive an unreviewed category-stripped identity', () => {
    expect(withoutAlias).toEqual(['vantrellhotel'])
    expect(categorizeQueryByIntent('vantrell', withoutAlias)).not.toBe('brand')
  })

  test('classifies an approved shorter alias and its modifiers', () => {
    expect(vantrell).toEqual(['vantrellhotel', 'vantrell'])
    expect(categorizeQueryByIntent('vantrell', vantrell)).toBe('brand')
    expect(categorizeQueryByIntent('vantrell harborview', vantrell)).toBe('brand')
    expect(categorizeQueryByIntent('vantrell springfield', vantrell)).toBe('brand')
  })

  test('does not brand category words, substrings, or edit-distance neighbors', () => {
    expect(categorizeQueryByIntent('hotel', vantrell)).not.toBe('brand')
    expect(categorizeQueryByIntent('harborview beach hotels', vantrell)).not.toBe('brand')
    expect(categorizeQueryByIntent('vantell harborview', vantrell)).not.toBe('brand')
    expect(categorizeQueryByIntent('santell harborview', vantrell)).not.toBe('brand')
    expect(categorizeQueryByIntent('price comparison', ['prime'])).not.toBe('brand')
    expect(categorizeQueryByIntent('apply online', ['apple'])).not.toBe('brand')
    expect(categorizeQueryByIntent('roofing leads on vexlo', vexloiq)).not.toBe('brand')
    expect(categorizeQueryByIntent('vexlo intelligence', vexloiq)).not.toBe('brand')
  })

  test('lets an operator approve a high-value misspelling explicitly', () => {
    const withTypoAlias = buildBrandTokens(
      'vantrellhotel.test',
      ['Vantrell Hotel', 'Vantrell', 'Vantell'],
    )
    expect(categorizeQueryByIntent('vantell harborview', withTypoAlias)).toBe('brand')
  })
})
