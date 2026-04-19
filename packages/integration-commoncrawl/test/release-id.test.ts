import { describe, expect, test } from 'vitest'
import { formatReleaseId, isValidReleaseId, parseReleaseId } from '../src/release-id.js'

describe('isValidReleaseId', () => {
  test.each([
    'cc-main-2024-jul-aug-sep',
    'cc-main-2026-jan-feb-mar',
    'cc-main-2020-apr-may-jun',
    'cc-main-2030-oct-nov-dec',
  ])('accepts %s', (id) => {
    expect(isValidReleaseId(id)).toBe(true)
  })

  test.each([
    '',
    'cc-main',
    'cc-main-24-jan-feb-mar',
    'cc-main-2024-foo-bar-baz',
    'CC-MAIN-2024-jan-feb-mar',
    'cc-main-2024-jan-feb-mar ',
    ' cc-main-2024-jan-feb-mar',
    'cc-main-2024-jan',
  ])('rejects %s', (id) => {
    expect(isValidReleaseId(id)).toBe(false)
  })
})

describe('parseReleaseId', () => {
  test('extracts year + quarter', () => {
    expect(parseReleaseId('cc-main-2026-jan-feb-mar')).toEqual({ year: 2026, quarter: 'jan-feb-mar' })
    expect(parseReleaseId('cc-main-2024-oct-nov-dec')).toEqual({ year: 2024, quarter: 'oct-nov-dec' })
  })

  test('returns null for invalid ids', () => {
    expect(parseReleaseId('bad')).toBeNull()
  })
})

describe('formatReleaseId', () => {
  test('reconstructs the original id', () => {
    const parsed = parseReleaseId('cc-main-2026-jan-feb-mar')!
    expect(formatReleaseId(parsed.year, parsed.quarter)).toBe('cc-main-2026-jan-feb-mar')
  })
})
