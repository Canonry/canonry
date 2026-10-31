import { describe, expect, test } from 'vitest'
import { ccReleasePaths } from '../src/constants.js'

describe('ccReleasePaths', () => {
  test('builds the verified Common Crawl layout', () => {
    const paths = ccReleasePaths('cc-main-2026-mar-apr-may')
    expect(paths.vertexUrl).toBe(
      'https://data.commoncrawl.org/projects/hyperlinkgraph/cc-main-2026-mar-apr-may/domain/cc-main-2026-mar-apr-may-domain-vertices.txt.gz',
    )
    expect(paths.edgesUrl).toBe(
      'https://data.commoncrawl.org/projects/hyperlinkgraph/cc-main-2026-mar-apr-may/domain/cc-main-2026-mar-apr-may-domain-edges.txt.gz',
    )
    expect(paths.vertexFilename).toBe('cc-main-2026-mar-apr-may-domain-vertices.txt.gz')
    expect(paths.edgesFilename).toBe('cc-main-2026-mar-apr-may-domain-edges.txt.gz')
  })
})
