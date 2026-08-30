import { test, expect } from 'vitest'
import { normalizeProjectName, orderLocationsDefaultFirst, projectCreateRequestSchema, queryReplaceRequestSchema } from '../src/index.js'


// ---------------------------------------------------------------------------
// orderLocationsDefaultFirst — discovery probes must follow the same geo
// default as sweeps (project.defaultLocation), not config order.
// ---------------------------------------------------------------------------

test('orderLocationsDefaultFirst moves the default location to the front, order otherwise stable', () => {
  const phoenix = { label: 'phoenix', city: 'Phoenix', region: 'Arizona', country: 'US' }
  const tucson = { label: 'tucson', city: 'Tucson', region: 'Arizona', country: 'US' }
  const mesa = { label: 'mesa', city: 'Mesa', region: 'Arizona', country: 'US' }
  expect(orderLocationsDefaultFirst([phoenix, tucson, mesa], 'tucson')).toEqual([tucson, phoenix, mesa])
})

test('orderLocationsDefaultFirst is a no-op when the default is absent, unknown, or already first', () => {
  const phoenix = { label: 'phoenix', city: 'Phoenix', region: 'Arizona', country: 'US' }
  const tucson = { label: 'tucson', city: 'Tucson', region: 'Arizona', country: 'US' }
  expect(orderLocationsDefaultFirst([phoenix, tucson], null)).toEqual([phoenix, tucson])
  expect(orderLocationsDefaultFirst([phoenix, tucson], 'nowhere')).toEqual([phoenix, tucson])
  expect(orderLocationsDefaultFirst([phoenix, tucson], 'phoenix')).toEqual([phoenix, tucson])
  expect(orderLocationsDefaultFirst([], 'phoenix')).toEqual([])
})

test('project creation has a dedicated name field and a stable normalized route key', () => {
  expect(normalizeProjectName('  Acmé & Co.  ')).toBe('acme-co')
  expect(normalizeProjectName('---')).toBe('')
  expect(projectCreateRequestSchema.parse({
    name: 'Acme & Co.',
    displayName: 'Acme',
    canonicalDomain: 'https://www.acme.example/path',
    country: 'US',
    language: 'en',
  }).name).toBe('Acme & Co.')
})

test('single-query replacement trims new text but preserves the exact stale-text guard', () => {
  expect(queryReplaceRequestSchema.parse({
    query: '  New wording  ',
    expectedQuery: ' Old wording ',
  })).toEqual({ query: 'New wording', expectedQuery: ' Old wording ' })
  expect(queryReplaceRequestSchema.safeParse({ query: '', expectedQuery: 'Old wording' }).success).toBe(false)
  expect(queryReplaceRequestSchema.safeParse({ query: 'New wording', expectedQuery: 'x'.repeat(4001) }).success).toBe(false)
  expect(queryReplaceRequestSchema.safeParse({ query: 'New wording', expectedQuery: 'Old wording', extra: true }).success).toBe(false)
})
