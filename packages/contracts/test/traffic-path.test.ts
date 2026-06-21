import { describe, expect, it } from 'vitest'
import {
  classifyTrafficPath,
  segmentCrawlerHits,
  sumInfraHits,
  emptyCrawlerSegments,
  TrafficPathClasses,
} from '../src/traffic-path.js'

describe('classifyTrafficPath', () => {
  it('classifies content document paths as content', () => {
    expect(classifyTrafficPath('/')).toBe('content')
    expect(classifyTrafficPath('/about')).toBe('content')
    expect(classifyTrafficPath('/blog/my-post')).toBe('content')
    expect(classifyTrafficPath('/products/:id')).toBe('content')
    // trailing slash → directory-style page, still content
    expect(classifyTrafficPath('/blog/my-post/')).toBe('content')
    // explicit document extensions
    expect(classifyTrafficPath('/index.html')).toBe('content')
    expect(classifyTrafficPath('/page.php')).toBe('content')
    expect(classifyTrafficPath('/legacy.aspx')).toBe('content')
  })

  it('classifies sitemap variants as sitemap', () => {
    expect(classifyTrafficPath('/sitemap_index.xml')).toBe('sitemap')
    expect(classifyTrafficPath('/sitemap.xml')).toBe('sitemap')
    expect(classifyTrafficPath('/sitemap.xml.gz')).toBe('sitemap')
    expect(classifyTrafficPath('/sitemaps/posts-1.xml')).toBe('sitemap')
    expect(classifyTrafficPath('/news-sitemap.xml')).toBe('sitemap')
    // any *.xml is treated as a sitemap-class feed fetch, not content
    expect(classifyTrafficPath('/feed.xml')).toBe('sitemap')
    // extensionless sitemap conventions
    expect(classifyTrafficPath('/sitemap')).toBe('sitemap')
    expect(classifyTrafficPath('/sitemap_index')).toBe('sitemap')
    expect(classifyTrafficPath('/sitemap-index')).toBe('sitemap')
  })

  it('does not over-match content slugs that merely start with "sitemap"', () => {
    // a blog post about sitemaps is content, not a sitemap fetch
    expect(classifyTrafficPath('/sitemap-best-practices')).toBe('content')
    expect(classifyTrafficPath('/sitemapping-guide')).toBe('content')
    expect(classifyTrafficPath('/blog/sitemap-tips')).toBe('content')
  })

  it('keeps dotted content slugs (versions, usernames, SKUs) as content, not other', () => {
    // unrecognized dotted suffix → a content page, never dropped into "other"
    expect(classifyTrafficPath('/release-notes-3.14')).toBe('content')
    expect(classifyTrafficPath('/products/3.5mm-adapter')).toBe('content')
    expect(classifyTrafficPath('/u/jane.doe')).toBe('content')
    expect(classifyTrafficPath('/pricing/team.enterprise')).toBe('content')
    expect(classifyTrafficPath('/blog/next.js-13-guide')).toBe('content')
  })

  it('strips a trailing slash before classifying', () => {
    expect(classifyTrafficPath('/sitemap.xml/')).toBe('sitemap')
    expect(classifyTrafficPath('/styles/app.css/')).toBe('asset')
    expect(classifyTrafficPath('/robots.txt/')).toBe('robots')
    expect(classifyTrafficPath('/about/')).toBe('content')
    // bare root stays content
    expect(classifyTrafficPath('/')).toBe('content')
    expect(classifyTrafficPath('///')).toBe('content')
  })

  it('classifies robots / llms control files as robots', () => {
    expect(classifyTrafficPath('/robots.txt')).toBe('robots')
    expect(classifyTrafficPath('/llms.txt')).toBe('robots')
    expect(classifyTrafficPath('/llms-full.txt')).toBe('robots')
  })

  it('classifies static-asset extensions as asset', () => {
    for (const p of [
      '/styles/app.css',
      '/bundle.js',
      '/chunk.mjs',
      '/app.js.map',
      '/data.json',
      '/img/logo.png',
      '/photo.JPG',
      '/photo.jpeg',
      '/hero.webp',
      '/anim.gif',
      '/icon.svg',
      '/favicon.ico',
      '/font.woff',
      '/font.woff2',
    ]) {
      expect(classifyTrafficPath(p)).toBe('asset')
    }
  })

  it('classifies recognized non-page downloads / feeds as other', () => {
    expect(classifyTrafficPath('/whitepaper.pdf')).toBe('other')
    expect(classifyTrafficPath('/export.csv')).toBe('other')
    expect(classifyTrafficPath('/archive.zip')).toBe('other')
    expect(classifyTrafficPath('/notes.txt')).toBe('other')
    expect(classifyTrafficPath('/feed.rss')).toBe('other')
    expect(classifyTrafficPath('/report.xlsx')).toBe('other')
  })

  it('routes WordPress infrastructure endpoints to other, not content', () => {
    // XML-RPC and cron carry a .php document extension but are pure polling
    expect(classifyTrafficPath('/xmlrpc.php')).toBe('other')
    expect(classifyTrafficPath('/wp-cron.php')).toBe('other')
    // WP REST API
    expect(classifyTrafficPath('/wp-json')).toBe('other')
    expect(classifyTrafficPath('/wp-json/wp/v2/posts')).toBe('other')
    expect(classifyTrafficPath('/wp-json/wp/v2/pages/:id')).toBe('other')
    expect(classifyTrafficPath('/wp-json/oembed/1.0/embed')).toBe('other')
    // RSS / comment feeds: extensionless, at /feed and /<path>/feed[/...]
    expect(classifyTrafficPath('/feed')).toBe('other')
    expect(classifyTrafficPath('/feed/')).toBe('other')
    expect(classifyTrafficPath('/blog/my-post/feed/')).toBe('other')
    expect(classifyTrafficPath('/comments/feed/')).toBe('other')
    expect(classifyTrafficPath('/feed/rss2/')).toBe('other')
  })

  it('does not over-match content slugs that merely contain "feed"', () => {
    expect(classifyTrafficPath('/news-feed')).toBe('content')
    expect(classifyTrafficPath('/feeds')).toBe('content')
    expect(classifyTrafficPath('/feedback')).toBe('content')
    expect(classifyTrafficPath('/blog/feed-reader-roundup')).toBe('content')
    expect(classifyTrafficPath('/products/cattle-feed')).toBe('content')
  })

  it('treats empty / missing paths as other (defensive fallback)', () => {
    expect(classifyTrafficPath('')).toBe('other')
    expect(classifyTrafficPath('   ')).toBe('other')
  })

  it('is case-insensitive and strips a stray query/hash', () => {
    expect(classifyTrafficPath('/ROBOTS.TXT')).toBe('robots')
    expect(classifyTrafficPath('/SITEMAP.XML')).toBe('sitemap')
    expect(classifyTrafficPath('/styles/APP.CSS')).toBe('asset')
    expect(classifyTrafficPath('/sitemap.xml?foo=bar')).toBe('sitemap')
    expect(classifyTrafficPath('/about#frag')).toBe('content')
  })

  it('only emits the five documented classes', () => {
    const seen = new Set<string>()
    for (const p of ['/', '/robots.txt', '/sitemap.xml', '/app.css', '/x.pdf']) {
      seen.add(classifyTrafficPath(p))
    }
    expect([...seen].sort()).toEqual(['asset', 'content', 'other', 'robots', 'sitemap'])
    expect(Object.values(TrafficPathClasses).sort()).toEqual([
      'asset',
      'content',
      'other',
      'robots',
      'sitemap',
    ])
  })
})

describe('segmentCrawlerHits', () => {
  it('buckets and sums hits by class, and the buckets sum to the total', () => {
    const rows = [
      { pathNormalized: '/blog/foo', hits: 6 },
      { pathNormalized: '/', hits: 4 },
      { pathNormalized: '/sitemap_index.xml', hits: 50 },
      { pathNormalized: '/news-sitemap.xml', hits: 12 },
      { pathNormalized: '/robots.txt', hits: 20 },
      { pathNormalized: '/styles/app.css', hits: 3 },
      { pathNormalized: '/report.pdf', hits: 5 },
    ]
    const seg = segmentCrawlerHits(rows)
    expect(seg.content).toBe(10) // 6 + 4
    expect(seg.sitemap).toBe(62) // 50 + 12
    expect(seg.robots).toBe(20)
    expect(seg.asset).toBe(3)
    expect(seg.other).toBe(5)

    const total = rows.reduce((acc, r) => acc + r.hits, 0)
    expect(seg.content + seg.sitemap + seg.robots + seg.asset + seg.other).toBe(total)
    // the headline invariant the issue calls out: content + infra + other == total
    expect(seg.content + sumInfraHits(seg) + seg.other).toBe(total)
  })

  it('reads 0 content for an all-infrastructure source', () => {
    const seg = segmentCrawlerHits([
      { pathNormalized: '/sitemap_index.xml', hits: 100 },
      { pathNormalized: '/robots.txt', hits: 40 },
      { pathNormalized: '/assets/main.js', hits: 7 },
    ])
    expect(seg.content).toBe(0)
    expect(sumInfraHits(seg)).toBe(147)
    expect(seg.content + sumInfraHits(seg) + seg.other).toBe(147)
  })

  it('routes WordPress feed/api/xmlrpc polling to other, out of content', () => {
    const seg = segmentCrawlerHits([
      { pathNormalized: '/', hits: 10 },
      { pathNormalized: '/blog/post/feed/', hits: 30 },
      { pathNormalized: '/wp-json/wp/v2/pages/:id', hits: 25 },
      { pathNormalized: '/xmlrpc.php', hits: 15 },
      { pathNormalized: '/sitemap_index.xml', hits: 100 },
    ])
    expect(seg.content).toBe(10) // only the real page, not the WP infra
    expect(seg.other).toBe(70) // feed + wp-json + xmlrpc
    expect(seg.sitemap).toBe(100)
    const total = 10 + 30 + 25 + 15 + 100
    expect(seg.content + sumInfraHits(seg) + seg.other).toBe(total)
  })

  it('returns an all-zero breakdown for no rows', () => {
    expect(segmentCrawlerHits([])).toEqual(emptyCrawlerSegments())
    expect(sumInfraHits(emptyCrawlerSegments())).toBe(0)
  })
})
