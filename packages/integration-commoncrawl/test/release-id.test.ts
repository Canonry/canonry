import { describe, expect, test } from 'vitest'
import { formatReleaseId, isValidReleaseId, parseReleaseId } from '../src/release-id.js'

describe('isValidReleaseId', () => {
  test.each([
    // Legacy fixed quarters — still published as a subset of the monthly cadence.
    'cc-main-2024-jul-aug-sep',
    'cc-main-2026-jan-feb-mar',
    'cc-main-2020-apr-may-jun',
    'cc-main-2030-oct-nov-dec',
    // Rolling, monthly-stepped windows — the current Common Crawl cadence.
    'cc-main-2025-may-jun-jul',
    'cc-main-2025-aug-sep-oct',
    'cc-main-2026-feb-mar-apr',
    'cc-main-2026-mar-apr-may',
    // Cross-year windows are accepted at the SHAPE layer by design. A
    // well-formed-but-unpublished slug just 404s at probe/download time —
    // validation gates shape, the HEAD probe is the authoritative existence check.
    'cc-main-2025-nov-dec-jan',
    'cc-main-2025-dec-jan-feb',
  ])('accepts %s', (id) => {
    expect(isValidReleaseId(id)).toBe(true)
  })

  test.each([
    '',
    'cc-main',
    'cc-main-24-jan-feb-mar', // 2-digit year
    'cc-main-2024-foo-bar-baz', // non-month tokens
    'CC-MAIN-2024-jan-feb-mar', // uppercase
    'cc-main-2024-jan-feb-mar ', // trailing space
    ' cc-main-2024-jan-feb-mar', // leading space
    'cc-main-2024-jan', // single token
    'cc-main-2024-jan-feb', // two tokens
    'cc-main-2024-jan-feb-mar-apr', // four tokens
  ])('rejects %s', (id) => {
    expect(isValidReleaseId(id)).toBe(false)
  })

  test('accepts the issue exemplar rolling window cc-main-2026-mar-apr-may', () => {
    expect(isValidReleaseId('cc-main-2026-mar-apr-may')).toBe(true)
  })
})

describe('parseReleaseId', () => {
  test('extracts year + window + months for a rolling window', () => {
    expect(parseReleaseId('cc-main-2026-mar-apr-may')).toEqual({
      year: 2026,
      window: 'mar-apr-may',
      months: ['mar', 'apr', 'may'],
    })
  })

  test('extracts a legacy fixed quarter', () => {
    expect(parseReleaseId('cc-main-2024-oct-nov-dec')).toEqual({
      year: 2024,
      window: 'oct-nov-dec',
      months: ['oct', 'nov', 'dec'],
    })
  })

  test('returns null for invalid ids', () => {
    expect(parseReleaseId('bad')).toBeNull()
  })
})

describe('formatReleaseId', () => {
  test('reconstructs the original id from a parsed window', () => {
    const parsed = parseReleaseId('cc-main-2026-mar-apr-may')!
    expect(formatReleaseId(parsed.year, parsed.window)).toBe('cc-main-2026-mar-apr-may')
  })
})
