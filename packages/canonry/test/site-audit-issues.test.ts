import { describe, expect, it } from 'vitest'
import { buildSiteCrawlIssueEvidence } from '../src/site-audit-issues.js'

function metadataPage(url: string, value: string) {
  return {
    state: 'html' as const,
    indexability: { state: 'indexable' as const },
    finalUrl: url,
    audit: { metadata: { pageTitle: value, metaDescription: value } },
  }
}

describe('stored duplicate metadata identities', () => {
  it('retains identity across membership changes while separating full values and metadata fields', () => {
    const prefix = 'An exact shared metadata value. '.repeat(5)
    const value = `${prefix}first ending`
    const differentValue = `${prefix}second ending`
    const a = 'https://example.test/a'
    const b = 'https://example.test/b'
    const c = 'https://example.test/c'
    const makeGroup = (code: string, message: string, affectedUrls: string[]) => ({ code, message, affectedUrls })
    const before = buildSiteCrawlIssueEvidence([
      makeGroup('site.duplicate-title', `2 pages: ${value.slice(0, 120)}`, [b, a, b]),
    ], [metadataPage(a, ` ${value} `), metadataPage(b, value)])!
    const after = buildSiteCrawlIssueEvidence([
      makeGroup('site.duplicate-title', `3 pages: ${value.slice(0, 120)}`, [c, b, a]),
    ], [metadataPage(c, value), metadataPage(b, value), metadataPage(a, value)])!
    const changed = buildSiteCrawlIssueEvidence([
      makeGroup('site.duplicate-title', `2 pages: ${differentValue.slice(0, 120)}`, [a, b]),
      makeGroup('site.duplicate-meta-description', `2 pages: ${value.slice(0, 120)}`, [a, b]),
    ], [
      { ...metadataPage(a, differentValue), audit: { metadata: { pageTitle: differentValue, metaDescription: value } } },
      { ...metadataPage(b, differentValue), audit: { metadata: { pageTitle: differentValue, metaDescription: value } } },
    ])!

    expect(before.siteIssues[0].affectedUrls).toEqual([a, b])
    expect(before.siteIssues[0].key).toMatch(/^site-issue:[a-f0-9]{64}$/)
    expect(after.siteIssues[0].key).toBe(before.siteIssues[0].key)
    expect(after.siteIssues[0].affectedUrls).toEqual([a, b, c])
    expect(changed.siteIssues.map((issue) => issue.key)).not.toContain(before.siteIssues[0].key)
    expect(new Set(changed.siteIssues.map((issue) => issue.key)).size).toBe(2)
  })

  it('preserves groups without inventing an identity from unavailable or conflicting metadata', () => {
    const a = 'https://example.test/a'
    const b = 'https://example.test/b'
    const groups = [
      { code: 'site.future-observation', message: 'Future evidence', affectedUrls: [b, a] },
      { code: 'site.duplicate-title', message: 'Metadata was not retained', affectedUrls: [a, b] },
      { code: 'site.duplicate-meta-description', message: 'Conflicting metadata', affectedUrls: [a, b] },
    ]
    const evidence = buildSiteCrawlIssueEvidence(groups, [
      { ...metadataPage(a, 'First'), audit: { metadata: { pageTitle: '', metaDescription: 'First' } } },
      { ...metadataPage(b, 'Second'), audit: { metadata: { pageTitle: '', metaDescription: 'Second' } } },
    ])!
    expect(evidence.siteIssues).toHaveLength(3)
    expect(evidence.siteIssues.every((issue) => issue.key === null)).toBe(true)
    expect(evidence.siteIssues.map((issue) => issue.message).sort()).toEqual(groups.map((issue) => issue.message).sort())
    for (const issue of evidence.siteIssues) expect(issue.affectedUrls).toEqual([a, b])
  })
})
