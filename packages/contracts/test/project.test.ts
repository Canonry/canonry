import { test, expect } from 'vitest'
import {
  normalizeCompetitorDomain,
  normalizeProjectName,
  orderLocationsDefaultFirst,
  projectCreateRequestSchema,
  projectUpsertRequestSchema,
  resolveProjectQualifiedAliases,
} from '../src/index.js'


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

// ---------------------------------------------------------------------------
// resolveProjectQualifiedAliases: the operator-chosen subset of aliases that
// Simple sentiment tells the evaluator are this brand's own names.
// ---------------------------------------------------------------------------

const qualifiedIdentity = {
  displayName: 'Harborline Labs',
  aliases: ['HBLNYC', 'HBL NYC', 'HBL', 'HarborlineLabs', 'Keystone Co', 'Tidewater'],
}

test('resolveProjectQualifiedAliases keeps only stored aliases, in their stored spelling, sorted by code unit', () => {
  expect(resolveProjectQualifiedAliases(qualifiedIdentity, ['keystone co', ' hblnyc ', 'HBL NYC'])).toEqual({
    value: ['HBL NYC', 'HBLNYC', 'Keystone Co'],
    rejected: [],
  })
})

test('resolveProjectQualifiedAliases keeps key-equivalent spellings and dedupes only case-insensitively', () => {
  // "HBLNYC" and "HBL NYC" share one brand key; the evaluator must see both literals.
  const result = resolveProjectQualifiedAliases(qualifiedIdentity, ['HBLNYC', 'hblnyc', 'HBL NYC', '  ', ''])
  expect(result.value).toEqual(['HBL NYC', 'HBLNYC'])
  expect(result.rejected).toEqual([])
})

test('resolveProjectQualifiedAliases names each rejection reason in order', () => {
  const result = resolveProjectQualifiedAliases(
    qualifiedIdentity,
    ['Unknown Brand', 'Harborline Labs', 'HarborlineLabs', 'HBL', 'Tidewater', 'HBLNYC'],
    ['Tidewater Partners', 'tidewater'],
  )
  expect(result.value).toEqual(['HBLNYC'])
  expect(result.rejected).toEqual([
    { name: 'Unknown Brand', reason: 'not-an-alias' },
    // normalizeProjectAliases never stores the display name as an alias.
    { name: 'Harborline Labs', reason: 'not-an-alias' },
    { name: 'HarborlineLabs', reason: 'display-name' },
    { name: 'HBL', reason: 'too-short' },
    { name: 'Tidewater', reason: 'competitor-collision' },
  ])
})

test('resolveProjectQualifiedAliases rejects a short key before a competitor collision', () => {
  const result = resolveProjectQualifiedAliases({ displayName: 'Harborline Labs', aliases: ['AI'] }, ['AI'], ['ai'])
  expect(result).toEqual({ value: [], rejected: [{ name: 'AI', reason: 'too-short' }] })
})

test('resolveProjectQualifiedAliases treats a missing request or identity as empty', () => {
  expect(resolveProjectQualifiedAliases(qualifiedIdentity, undefined)).toEqual({ value: [], rejected: [] })
  expect(resolveProjectQualifiedAliases(qualifiedIdentity, null)).toEqual({ value: [], rejected: [] })
  expect(resolveProjectQualifiedAliases({ displayName: null, aliases: null }, ['HBLNYC'])).toEqual({
    value: [],
    rejected: [{ name: 'HBLNYC', reason: 'not-an-alias' }],
  })
})

test('project upsert bounds qualifiedAliases and leaves it optional', () => {
  const base = { displayName: 'Harborline Labs', canonicalDomain: 'harborline.example', country: 'US', language: 'en' }
  expect(projectUpsertRequestSchema.parse(base).qualifiedAliases).toBeUndefined()
  expect(projectUpsertRequestSchema.parse({ ...base, qualifiedAliases: [' HBLNYC '] }).qualifiedAliases).toEqual(['HBLNYC'])
  expect(projectUpsertRequestSchema.safeParse({ ...base, qualifiedAliases: ['  '] }).success).toBe(false)
  expect(projectUpsertRequestSchema.safeParse({ ...base, qualifiedAliases: ['x'.repeat(201)] }).success).toBe(false)
  expect(projectUpsertRequestSchema.safeParse({ ...base, qualifiedAliases: Array.from({ length: 21 }, (_, i) => `Alias ${i}`) }).success).toBe(false)
  expect(projectUpsertRequestSchema.safeParse({ ...base, qualifiedAliases: Array.from({ length: 20 }, (_, i) => `Alias ${i}`) }).success).toBe(true)
})

// ---------------------------------------------------------------------------
// normalizeCompetitorDomain: the stored registrable form every competitor
// write and lookup uses, so a subdomain label never becomes a brand token.
// ---------------------------------------------------------------------------

test('normalizeCompetitorDomain reduces a subdomain to its registrable domain', () => {
  expect(normalizeCompetitorDomain('offers.quotebird.test')).toBe('quotebird.test')
  expect(normalizeCompetitorDomain('shop.rival.co.uk')).toBe('rival.co.uk')
})

test('normalizeCompetitorDomain strips scheme, www, path and case from a URL', () => {
  expect(normalizeCompetitorDomain('https://www.Rival.example/pricing?ref=1')).toBe('rival.example')
  expect(normalizeCompetitorDomain('WWW.RIVAL.EXAMPLE')).toBe('rival.example')
})

test('normalizeCompetitorDomain keeps a single-label host as its normalized host', () => {
  expect(normalizeCompetitorDomain('localhost')).toBe('localhost')
  expect(normalizeCompetitorDomain('  Intranet  ')).toBe('intranet')
})
