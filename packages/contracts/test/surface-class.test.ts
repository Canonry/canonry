import { describe, it, expect } from 'vitest'
import { classifySurfaceFromCategory, classifyCitedSurface, surfaceClassFromCompetitorType, surfaceClassLabel, SurfaceClasses } from '../src/surface-class.js'
import { DiscoveryCompetitorTypes } from '../src/discovery.js'

const project = { projectDomains: ['acme.com', 'acme.io'], competitorDomains: ['rival.com', 'yelp.com'] }

describe('classifyCitedSurface heuristic classifications', () => {
  it('classifies the project canonical domain as own', () => {
    expect(classifyCitedSurface([{ domain: 'acme.com' }], project).get('acme.com')).toBe(SurfaceClasses.own)
  })

  it('classifies an owned alias domain as own', () => {
    expect(classifyCitedSurface([{ domain: 'acme.io' }], project).get('acme.io')).toBe(SurfaceClasses.own)
  })

  it('classifies a subdomain of an owned domain as own', () => {
    expect(classifyCitedSurface([{ domain: 'blog.acme.com' }], project).get('blog.acme.com')).toBe(SurfaceClasses.own)
  })

  it('own takes priority even if the domain also matches a category rule', () => {
    const owner = { projectDomains: ['booking.com'], competitorDomains: project.competitorDomains }
    expect(classifyCitedSurface([{ domain: 'booking.com' }], owner).get('booking.com')).toBe(SurfaceClasses.own)
    expect(classifySurfaceFromCategory('www.acme.com', 'other', project)).toBe(SurfaceClasses.own)
  })

  it('classifies a tracked competitor as direct-competitor', () => {
    expect(classifyCitedSurface([{ domain: 'rival.com' }], project).get('rival.com')).toBe(SurfaceClasses['direct-competitor'])
  })

  it('classifies a subdomain of a tracked competitor as direct-competitor', () => {
    expect(classifyCitedSurface([{ domain: 'shop.rival.com' }], project).get('shop.rival.com')).toBe(SurfaceClasses['direct-competitor'])
  })

  it('direct-competitor takes priority over the generic category', () => {
    // yelp.com is a directory by categorizeSource, but it is ALSO a tracked
    // competitor here — competitor membership must win.
    expect(classifyCitedSurface([{ domain: 'yelp.com' }], project).get('yelp.com')).toBe(SurfaceClasses['direct-competitor'])
  })

  it('maps directory domains to ota-aggregator', () => {
    expect(classifyCitedSurface([{ domain: 'tripadvisor.com' }, { domain: 'homeadvisor.com' }], project)).toEqual(new Map([
      ['tripadvisor.com', SurfaceClasses['ota-aggregator']],
      ['homeadvisor.com', SurfaceClasses['ota-aggregator']],
    ]))
  })

  it('maps ecommerce domains to ota-aggregator', () => {
    expect(classifyCitedSurface([{ domain: 'amazon.com' }], project).get('amazon.com')).toBe(SurfaceClasses['ota-aggregator'])
  })

  it('maps news domains to editorial-media', () => {
    expect(classifyCitedSurface([{ domain: 'forbes.com' }], project).get('forbes.com')).toBe(SurfaceClasses['editorial-media'])
  })

  it('maps blog domains to editorial-media', () => {
    expect(classifyCitedSurface([{ domain: 'medium.com' }], project).get('medium.com')).toBe(SurfaceClasses['editorial-media'])
  })

  it('maps reference domains to editorial-media', () => {
    expect(classifyCitedSurface([{ domain: 'en.wikipedia.org' }], project).get('en.wikipedia.org')).toBe(SurfaceClasses['editorial-media'])
  })

  it('omits social / forum / video / academic / unknown domains', () => {
    expect(classifyCitedSurface([
      { domain: 'reddit.com' },
      { domain: 'linkedin.com' },
      { domain: 'youtube.com' },
      { domain: 'cs.stanford.edu' },
      { domain: 'some-random-site.io' },
    ], project)).toEqual(new Map())
  })

  it('classifies against empty project/competitor lists as a pure category map', () => {
    const empty = { projectDomains: [], competitorDomains: [] }
    expect(classifyCitedSurface([{ domain: 'acme.com' }, { domain: 'yelp.com' }], empty)).toEqual(new Map([
      ['yelp.com', SurfaceClasses['ota-aggregator']],
    ]))
  })
})

describe('surfaceClassLabel', () => {
  it.each([
    [SurfaceClasses.own, 'Your domains'],
    [SurfaceClasses['direct-competitor'], 'Direct competitors'],
    [SurfaceClasses['ota-aggregator'], 'Aggregators & marketplaces'],
    [SurfaceClasses['editorial-media'], 'Editorial & media'],
    [SurfaceClasses.other, 'Other sources'],
  ] as const)('labels %s as %s', (surfaceClass, label) => {
    expect(surfaceClassLabel(surfaceClass)).toBe(label)
  })
})

describe('classifySurfaceFromCategory', () => {
  it('honors the own > competitor > category priority order from pre-categorized input', () => {
    // acme.com is owned even when handed a directory category.
    expect(classifySurfaceFromCategory('acme.com', 'directory', project)).toBe(SurfaceClasses.own)
    // yelp.com is a tracked competitor here, so competitor wins over its directory category.
    expect(classifySurfaceFromCategory('yelp.com', 'directory', project)).toBe(SurfaceClasses['direct-competitor'])
    // unowned, untracked directory maps to the aggregator class.
    expect(classifySurfaceFromCategory('booking.com', 'directory', project)).toBe(SurfaceClasses['ota-aggregator'])
    expect(classifySurfaceFromCategory('forbes.com', 'news', project)).toBe(SurfaceClasses['editorial-media'])
    expect(classifySurfaceFromCategory('reddit.com', 'forum', project)).toBe(SurfaceClasses.other)
  })

  it('matches subdomains of owned / competitor domains', () => {
    expect(classifySurfaceFromCategory('blog.acme.com', 'other', project)).toBe(SurfaceClasses.own)
    expect(classifySurfaceFromCategory('shop.rival.com', 'other', project)).toBe(SurfaceClasses['direct-competitor'])
  })
})

describe('surfaceClassFromCompetitorType', () => {
  it('maps discovery competitor types onto the surface-class taxonomy', () => {
    expect(surfaceClassFromCompetitorType(DiscoveryCompetitorTypes['direct-competitor'])).toBe(SurfaceClasses['direct-competitor'])
    expect(surfaceClassFromCompetitorType(DiscoveryCompetitorTypes['ota-aggregator'])).toBe(SurfaceClasses['ota-aggregator'])
    expect(surfaceClassFromCompetitorType(DiscoveryCompetitorTypes['editorial-media'])).toBe(SurfaceClasses['editorial-media'])
    expect(surfaceClassFromCompetitorType(DiscoveryCompetitorTypes.other)).toBe(SurfaceClasses.other)
  })

  it('returns undefined for unknown so the caller falls back to the heuristic', () => {
    expect(surfaceClassFromCompetitorType(DiscoveryCompetitorTypes.unknown)).toBeUndefined()
  })
})

describe('classifySurfaceFromCategory with a stored (LLM) classification', () => {
  it('prefers the stored class over the heuristic category map', () => {
    // categorizeSource('niche-ota.io') → 'other' → heuristic would say 'other';
    // a discovery LLM run classified it ota-aggregator. Stored wins.
    expect(classifySurfaceFromCategory('niche-ota.io', 'other', project, SurfaceClasses['ota-aggregator']))
      .toBe(SurfaceClasses['ota-aggregator'])
  })

  it('still lets own and tracked-competitor membership win over a stored class', () => {
    // Even if a stale stored row says otherwise, own/competitor are authoritative.
    expect(classifySurfaceFromCategory('acme.com', 'other', project, SurfaceClasses['ota-aggregator']))
      .toBe(SurfaceClasses.own)
    expect(classifySurfaceFromCategory('rival.com', 'other', project, SurfaceClasses['editorial-media']))
      .toBe(SurfaceClasses['direct-competitor'])
  })
})

describe('classifyCitedSurface', () => {
  it('recognizes a well-known aggregator via the allow-list with no stored class (the gate-coverage fix)', () => {
    const map = classifyCitedSurface([{ domain: 'booking.com' }, { domain: 'booking.com' }], project)
    expect(map).toEqual(new Map([['booking.com', SurfaceClasses['ota-aggregator']]]))
  })

  it('keeps own and tracked competitor authoritative over the heuristic', () => {
    const map = classifyCitedSurface([{ domain: 'acme.com' }, { domain: 'yelp.com' }], project)
    // yelp.com is in this project's competitorDomains, so it reads as a competitor
    // surface here even though the allow-list would call it an aggregator.
    expect(map).toEqual(new Map([
      ['acme.com', SurfaceClasses.own],
      ['yelp.com', SurfaceClasses['direct-competitor']],
    ]))
  })

  it('omits domains that resolve to `other` so the map reflects only recognized surfaces', () => {
    const map = classifyCitedSurface([{ domain: 'midwest-roof-restoration-llc.com' }], project)
    expect(map.has('midwest-roof-restoration-llc.com')).toBe(false)
    expect(map.size).toBe(0)
  })

  it('lets a stored discovery class enrich recall for a domain the allow-list dumps into `other`', () => {
    const stored = new Map([['niche-regional-listings.com', DiscoveryCompetitorTypes['ota-aggregator']]])
    const map = classifyCitedSurface([{ domain: 'niche-regional-listings.com' }], project, stored)
    expect(map.get('niche-regional-listings.com')).toBe(SurfaceClasses['ota-aggregator'])
  })
})
