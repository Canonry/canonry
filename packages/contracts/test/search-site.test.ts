import { describe, expect, it } from 'vitest'
import { bingProjectSiteUrl } from '../src/bing.js'
import { defaultSearchSitemapUrl, isSitemapOwnedByProperty } from '../src/url-normalize.js'

describe('Bing project site identity', () => {
  it('defaults a bare host to HTTPS and preserves the scope of an explicit site URL', () => {
    expect(bingProjectSiteUrl('WWW.Example.com')).toBe('https://www.example.com/')
    expect(bingProjectSiteUrl('http://WWW.Example.com:8080/Shop/')).toBe('http://www.example.com:8080/Shop/')
  })

  it.each(['', 'ftp://example.com/', 'https://user@example.com/', 'https://example.com/?q=foo', 'https://example.com/#shop'])(
    'refuses a value that cannot identify a Bing property: %s', value => {
      expect(bingProjectSiteUrl(value)).toBeNull()
    },
  )
})

describe('default inspection sitemap', () => {
  it('keeps the project subdomain for a domain property and falls back to the domain property if the project lies outside it', () => {
    expect(defaultSearchSitemapUrl('sc-domain:example.com', 'https://uk.example.com')).toBe('https://uk.example.com/sitemap.xml')
    expect(defaultSearchSitemapUrl('sc-domain:www.example.com', 'example.com')).toBe('https://www.example.com/sitemap.xml')
    expect(isSitemapOwnedByProperty('https://example.com/map.xml', 'sc-domain:www.example.com', 'example.com')).toBe(false)
  })

  it('resolves historical numeric properties from the project and refuses invalid URL prefixes', () => {
    expect(defaultSearchSitemapUrl('1234', 'http://example.com/tenant')).toBe('http://example.com/tenant/sitemap.xml')
    expect(defaultSearchSitemapUrl('ftp://example.com', 'example.com')).toBeNull()
  })
})
