import { test, expect } from 'vitest'

import { normalizeServedModel } from '../src/provider.js'

test('normalizeServedModel keeps a disclosed identity verbatim', () => {
  expect(normalizeServedModel('gpt-5.6-sol')).toBe('gpt-5.6-sol')
  expect(normalizeServedModel('gpt-5.4-2026-03-05')).toBe('gpt-5.4-2026-03-05')
  expect(normalizeServedModel('gemini-3.5-flash')).toBe('gemini-3.5-flash')
})

test('normalizeServedModel trims surrounding whitespace', () => {
  expect(normalizeServedModel('  claude-sonnet-5\n')).toBe('claude-sonnet-5')
})

test('normalizeServedModel returns undefined for a whitespace-only value', () => {
  expect(normalizeServedModel('   ')).toBeUndefined()
  expect(normalizeServedModel('\t\n')).toBeUndefined()
})

test('normalizeServedModel returns undefined for an absent or non-string value', () => {
  expect(normalizeServedModel(undefined)).toBeUndefined()
  expect(normalizeServedModel(null)).toBeUndefined()
  expect(normalizeServedModel('')).toBeUndefined()
  expect(normalizeServedModel(42)).toBeUndefined()
  expect(normalizeServedModel({ model: 'gpt-5.6' })).toBeUndefined()
})
