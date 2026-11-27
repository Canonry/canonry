import { describe, expect, test } from 'vitest'
import { compareReleaseIds, formatReleaseId, formatReleaseWindow, isValidReleaseId, releaseWindowEndMonth } from '../src/release-id.js'

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
    'cc-main-2024-jul-aug-sep\n', // trailing newline
    ' cc-main-2024-jan-feb-mar', // leading space
    'cc-main-2024-jan', // single token
    'cc-main-2024-jan-feb', // two tokens
    'cc-main-2024-jan-feb-mar-apr', // four tokens
  ])('rejects %s', (id) => {
    expect(isValidReleaseId(id)).toBe(false)
  })
})

describe('formatReleaseId', () => {
  test('formats a year and monthly window as a release id', () => {
    expect(formatReleaseId(2026, 'mar-apr-may')).toBe('cc-main-2026-mar-apr-may')
  })
})

describe('release windows', () => {
  test('orders releases by crawl window, not by id text or sync order', () => {
    const synced = ['cc-main-2026-aug-sep-oct', 'cc-main-2026-jun-jul-aug', 'cc-main-2025-nov-dec-jan', 'cc-main-2026-may-jun-jul', 'not-a-release']
    expect([...synced].sort(compareReleaseIds)).toEqual([
      'not-a-release',
      // Named by its first month's year: Nov 2025 to Jan 2026 comes before May 2026.
      'cc-main-2025-nov-dec-jan',
      'cc-main-2026-may-jun-jul',
      'cc-main-2026-jun-jul-aug',
      'cc-main-2026-aug-sep-oct',
    ])
  })

  test('dates a release by its last month and names its window', () => {
    expect(releaseWindowEndMonth('cc-main-2026-may-jun-jul')).toBe('2026-07-01')
    expect(releaseWindowEndMonth('cc-main-2025-nov-dec-jan')).toBe('2026-01-01')
    expect(formatReleaseWindow('cc-main-2026-may-jun-jul')).toBe('May-Jul 2026')
    expect(formatReleaseWindow('cc-main-2025-dec-jan-feb')).toBe('Dec 2025-Feb 2026')
    expect(releaseWindowEndMonth('bing-2026-10')).toBeNull()
    expect(formatReleaseWindow('bing-2026-10')).toBeNull()
  })
})
