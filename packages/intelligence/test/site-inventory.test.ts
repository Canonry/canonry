import { describe, it, expect } from 'vitest'

import { buildInventory } from '../src/site-inventory.js'

describe('buildInventory', () => {
  describe('source aggregation', () => {
    it('collects blog-shaped pages from every input source', () => {
      const inventory = buildInventory({
        gscPages: [
          'https://example.com/blog/email-marketing-comparison',
          'https://example.com/glossary/mrr',
        ],
        ga4LandingPages: [
          'https://example.com/blog/email-marketing-comparison',
          '/blog/saas-billing',
        ],
        sitemapUrls: [],
        wpPosts: [],
      })

      const urls = inventory.map((p) => p.url).sort()
      expect(urls).toEqual([
        '/blog/email-marketing-comparison',
        '/blog/saas-billing',
        '/glossary/mrr',
      ])
    })

    it('deduplicates URLs that appear in multiple sources', () => {
      const inventory = buildInventory({
        gscPages: ['https://example.com/blog/x'],
        ga4LandingPages: ['/blog/x'],
        sitemapUrls: ['/blog/x'],
        wpPosts: [],
      })

      expect(inventory).toHaveLength(1)
      expect(inventory[0].sources.sort()).toEqual(['ga4', 'gsc', 'sitemap'])
    })

    it('records the precise sources where each URL appeared', () => {
      const inventory = buildInventory({
        gscPages: ['/blog/x'],
        ga4LandingPages: ['/blog/x'],
        sitemapUrls: [],
        wpPosts: ['/blog/x'],
      })

      expect(inventory[0].sources).toContain('gsc')
      expect(inventory[0].sources).toContain('ga4')
      expect(inventory[0].sources).toContain('wp')
      expect(inventory[0].sources).not.toContain('sitemap')
    })
  })

  describe('blog-shaped path filter', () => {
    it.each([
      '/blog/x',
      '/posts/x',
      '/articles/x',
      '/guides/x',
      '/learn/x',
      '/resources/x',
      '/glossary/x',
    ])('includes %s', (path) => {
      const inventory = buildInventory({
        gscPages: [path],
        ga4LandingPages: [],
        sitemapUrls: [],
        wpPosts: [],
      })
      expect(inventory).toHaveLength(1)
      expect(inventory[0].url).toBe(path)
    })

    it.each([
      '/pricing',
      '/about',
      '/contact',
      '/products/crm',
      '/services/marketing',
      '/',
      '/landing/page',
    ])('excludes %s', (path) => {
      const inventory = buildInventory({
        gscPages: [path],
        ga4LandingPages: [],
        sitemapUrls: [],
        wpPosts: [],
      })
      expect(inventory).toHaveLength(0)
    })
  })

  describe('URL normalization', () => {
    it('extracts paths from full URLs', () => {
      const inventory = buildInventory({
        gscPages: ['https://example.com/blog/x', 'http://example.com/blog/y'],
        ga4LandingPages: [],
        sitemapUrls: [],
        wpPosts: [],
      })
      expect(inventory.map((p) => p.url).sort()).toEqual(['/blog/x', '/blog/y'])
    })

    it('strips trailing slashes', () => {
      const inventory = buildInventory({
        gscPages: ['/blog/x/'],
        ga4LandingPages: [],
        sitemapUrls: [],
        wpPosts: [],
      })
      expect(inventory[0].url).toBe('/blog/x')
    })

    it('treats trailing-slash and bare path as the same URL', () => {
      const inventory = buildInventory({
        gscPages: ['/blog/x'],
        ga4LandingPages: ['/blog/x/'],
        sitemapUrls: [],
        wpPosts: [],
      })
      expect(inventory).toHaveLength(1)
      expect(inventory[0].sources.sort()).toEqual(['ga4', 'gsc'])
    })
  })

  describe('empty inputs', () => {
    it('returns empty inventory when no sources provide any pages', () => {
      const inventory = buildInventory({
        gscPages: [],
        ga4LandingPages: [],
        sitemapUrls: [],
        wpPosts: [],
      })
      expect(inventory).toEqual([])
    })

    it('ignores empty / whitespace URL entries', () => {
      const inventory = buildInventory({
        gscPages: ['', '   ', '/blog/x'],
        ga4LandingPages: [],
        sitemapUrls: [],
        wpPosts: [],
      })
      expect(inventory).toHaveLength(1)
      expect(inventory[0].url).toBe('/blog/x')
    })
  })
})
