import { describe, expect, test } from 'vitest'
import { CC_BASE_URL, ccReleasePaths, RELEASE_ID_REGEX } from '../src/constants.js'

describe('ccReleasePaths', () => {
  test('builds the verified 2026-04 Common Crawl layout', () => {
    const paths = ccReleasePaths('cc-main-2026-jan-feb-mar')
    expect(paths.vertexUrl).toBe(
      `${CC_BASE_URL}/cc-main-2026-jan-feb-mar/domain/cc-main-2026-jan-feb-mar-domain-vertices.txt.gz`,
    )
    expect(paths.edgesUrl).toBe(
      `${CC_BASE_URL}/cc-main-2026-jan-feb-mar/domain/cc-main-2026-jan-feb-mar-domain-edges.txt.gz`,
    )
    expect(paths.vertexFilename).toBe('cc-main-2026-jan-feb-mar-domain-vertices.txt.gz')
    expect(paths.edgesFilename).toBe('cc-main-2026-jan-feb-mar-domain-edges.txt.gz')
  })
})

describe('RELEASE_ID_REGEX', () => {
  test('rejects trailing whitespace', () => {
    expect(RELEASE_ID_REGEX.test('cc-main-2024-jul-aug-sep\n')).toBe(false)
  })
})
