import { describe, expect, test } from 'vitest'
import { CC_BASE_URL, ccReleasePaths, RELEASE_ID_REGEX } from '../src/constants.js'

describe('ccReleasePaths', () => {
  test('builds the verified Common Crawl layout', () => {
    const paths = ccReleasePaths('cc-main-2026-mar-apr-may')
    expect(paths.vertexUrl).toBe(
      `${CC_BASE_URL}/cc-main-2026-mar-apr-may/domain/cc-main-2026-mar-apr-may-domain-vertices.txt.gz`,
    )
    expect(paths.edgesUrl).toBe(
      `${CC_BASE_URL}/cc-main-2026-mar-apr-may/domain/cc-main-2026-mar-apr-may-domain-edges.txt.gz`,
    )
    expect(paths.vertexFilename).toBe('cc-main-2026-mar-apr-may-domain-vertices.txt.gz')
    expect(paths.edgesFilename).toBe('cc-main-2026-mar-apr-may-domain-edges.txt.gz')
  })
})

describe('RELEASE_ID_REGEX', () => {
  test('rejects trailing whitespace', () => {
    expect(RELEASE_ID_REGEX.test('cc-main-2024-jul-aug-sep\n')).toBe(false)
  })

  test.each([
    'cc-main-2025-oct-nov-dec', // legacy fixed quarter
    'cc-main-2026-mar-apr-may', // rolling monthly window
    'cc-main-2025-may-jun-jul', // rolling monthly window
    // Cross-year window: accepted at the shape layer by design (404s at probe time).
    'cc-main-2025-nov-dec-jan',
  ])('accepts %s', (id) => {
    expect(RELEASE_ID_REGEX.test(id)).toBe(true)
  })

  test.each([
    'cc-main-2025-jan-feb', // two tokens
    'cc-main-2025-jan-feb-mar-apr', // four tokens
    'cc-main-2025-foo-bar-baz', // non-month tokens
    'cc-main-25-jan-feb-mar', // 2-digit year
  ])('rejects %s', (id) => {
    expect(RELEASE_ID_REGEX.test(id)).toBe(false)
  })
})
