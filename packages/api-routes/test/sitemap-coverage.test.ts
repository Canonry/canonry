import { describe, expect, it } from 'vitest'
import type { EngineSitemapDto } from '@canonry/canonry-contracts'
import { bingSitemapState, buildSitemapCoverage, googleSitemapState, sitemapKey, type EngineList } from '../src/sitemap-coverage.js'

const S = 'https://example.com'
const row = (path: string, extra: Partial<EngineSitemapDto> = {}): EngineSitemapDto => ({
  url: `${S}${path}`, parentUrl: null, isIndex: false, type: 'sitemap', state: 'ok', statusLabel: 'Success',
  warnings: null, errors: null, urlCount: 1, submittedAt: '2026-10-01T00:00:00.000Z', lastReadAt: null, ...extra,
})
const list = (...sitemaps: EngineSitemapDto[]): EngineList => ({ syncedAt: '2026-11-04T00:00:00.000Z', sitemaps })
const site = (...paths: string[]) => ({ scannedAt: '2026-11-02T00:00:00.000Z', runId: 'scan', sitemaps: paths.map((path) => `${S}${path}`) })
const missingUrls = (missing: { url: string }[] | undefined) => missing?.map((entry) => entry.url.slice(S.length))

describe('buildSitemapCoverage', () => {
  it('lists what the site declares and the other engine submitted, and says where each was seen', () => {
    const result = buildSitemapCoverage({
      site: site('/pages.xml', '/news.xml'),
      google: list(row('/news.xml'), row('/video.xml')),
      bing: list(row('/pages.xml')),
    })
    expect(result.google!.missing).toEqual([{ url: `${S}/pages.xml`, foundIn: ['site', 'bing'] }])
    expect(result.bing!.missing).toEqual([
      { url: `${S}/news.xml`, foundIn: ['site', 'google'] },
      { url: `${S}/video.xml`, foundIn: ['google'] },
    ])
  })

  it('does not suggest a sitemap the other engine only found by itself, unless the site lists it', () => {
    const result = buildSitemapCoverage({
      site: site('/pages.xml'),
      google: list(),
      // Bing found both on its own (no submittedAt), for example on an old host.
      bing: list(row('/pages.xml', { submittedAt: null }), row('/stale.xml', { submittedAt: null })),
    })
    expect(result.google!.missing).toEqual([{ url: `${S}/pages.xml`, foundIn: ['site'] }])
  })

  it('counts a file an engine holds inside an index as present, and drops a file whose missing index covers it', () => {
    const index = `${S}/index.xml`
    const result = buildSitemapCoverage({
      // The scan reads pages through the files, not the index itself.
      site: site('/a.xml', '/b.xml'),
      google: list(row('/index.xml', { isIndex: true }), row('/a.xml', { parentUrl: index, submittedAt: null }), row('/b.xml', { parentUrl: index, submittedAt: null })),
      bing: list(),
    })
    expect(result.google!.missing).toEqual([])
    // Adding the index gives Bing both files, so only the index is suggested.
    expect(missingUrls(result.bing!.missing)).toEqual(['/index.xml'])
  })

  it('suggests the files when no engine has an index for them', () => {
    const result = buildSitemapCoverage({ site: site('/b.xml', '/a.xml'), google: list(), bing: null })
    expect(missingUrls(result.google!.missing)).toEqual(['/a.xml', '/b.xml'])
    expect(result.bing).toBeNull()
  })

  it('treats host case and a default port as the same sitemap, and another scheme as a different one', () => {
    expect(sitemapKey('https://EXAMPLE.com:443/sitemap.xml')).toBe(sitemapKey('https://example.com/sitemap.xml'))
    expect(sitemapKey('http://example.com/sitemap.xml')).not.toBe(sitemapKey('https://example.com/sitemap.xml'))
    const result = buildSitemapCoverage({
      site: { ...site(), sitemaps: ['https://EXAMPLE.com/sitemap.xml', 'http://example.com/sitemap.xml'] },
      google: list(row('/sitemap.xml')),
      bing: null,
    })
    expect(result.google!.missing.map((entry) => entry.url)).toEqual(['http://example.com/sitemap.xml'])
  })

  it('never calls a sitemap missing from an engine that cannot take it', () => {
    const result = buildSitemapCoverage({
      site: { ...site('/sitemap.xml'), sitemaps: [`${S}/sitemap.xml`, 'https://blog.other.com/sitemap.xml'] },
      google: list(),
      bing: list(),
      accepts: { google: (url) => url.startsWith(S) },
    })
    expect(missingUrls(result.google!.missing)).toEqual(['/sitemap.xml'])
    expect(result.bing!.missing.map((entry) => entry.url)).toEqual(['https://blog.other.com/sitemap.xml', `${S}/sitemap.xml`])
  })

  it('leaves an engine out until its list has been read, and compares only the engines that were', () => {
    const result = buildSitemapCoverage({ site: site('/sitemap.xml'), google: null, bing: null })
    expect(result).toEqual({ site: site('/sitemap.xml'), google: null, bing: null })
  })
})

describe('sitemap states', () => {
  it('words a Search Console sitemap as its console does', () => {
    expect(googleSitemapState({ isPending: true, errors: 3, warnings: 0 })).toEqual({ state: 'pending', statusLabel: 'Processing' })
    expect(googleSitemapState({ isPending: false, errors: 1, warnings: 2 })).toEqual({ state: 'errors', statusLabel: 'Errors' })
    expect(googleSitemapState({ isPending: false, errors: 0, warnings: 2 })).toEqual({ state: 'warnings', statusLabel: 'Warnings' })
    expect(googleSitemapState({ isPending: false, errors: null, warnings: null })).toEqual({ state: 'ok', statusLabel: 'Success' })
  })

  it('maps Bing status words onto the shared states', () => {
    expect(['Success', 'Pending', 'Processing', 'Error', 'Failed', 'Warning', 'Unknown'].map(bingSitemapState))
      .toEqual(['ok', 'pending', 'pending', 'errors', 'errors', 'warnings', 'other'])
  })
})
