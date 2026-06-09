import { describe, it, expect } from 'vitest'
import { classifySurface, classifySurfaceFromCategory, surfaceClassFromCompetitorType, surfaceClassLabel, SurfaceClasses, surfaceClassSchema } from '../src/surface-class.js'
import { categorizeSource } from '../src/source-categories.js'
import { DiscoveryCompetitorTypes } from '../src/discovery.js'

const project = { projectDomains: ['acme.com', 'acme.io'], competitorDomains: ['rival.com', 'yelp.com'] }

describe('classifySurface', () => {
  it('classifies the project canonical domain as own', () => {
    expect(classifySurface('acme.com', project)).toBe(SurfaceClasses.own)
  })

  it('classifies an owned alias domain as own', () => {
    expect(classifySurface('acme.io', project)).toBe(SurfaceClasses.own)
  })

  it('classifies a subdomain of an owned domain as own', () => {
    expect(classifySurface('blog.acme.com', project)).toBe(SurfaceClasses.own)
  })

  it('own takes priority even if the domain also matches a category rule', () => {
    // acme.com is owned; even if it were a known directory it must read own.
    expect(classifySurface('www.acme.com', project)).toBe(SurfaceClasses.own)
  })

  it('classifies a tracked competitor as direct-competitor', () => {
    expect(classifySurface('rival.com', project)).toBe(SurfaceClasses['direct-competitor'])
  })

  it('classifies a subdomain of a tracked competitor as direct-competitor', () => {
    expect(classifySurface('shop.rival.com', project)).toBe(SurfaceClasses['direct-competitor'])
  })

  it('direct-competitor takes priority over the generic category', () => {
    // yelp.com is a directory by categorizeSource, but it is ALSO a tracked
    // competitor here — competitor membership must win.
    expect(classifySurface('yelp.com', project)).toBe(SurfaceClasses['direct-competitor'])
  })

  it('maps directory domains to ota-aggregator', () => {
    expect(classifySurface('https://www.tripadvisor.com/Hotel', project)).toBe(SurfaceClasses['ota-aggregator'])
    expect(classifySurface('homeadvisor.com', project)).toBe(SurfaceClasses['ota-aggregator'])
  })

  it('maps ecommerce domains to ota-aggregator', () => {
    expect(classifySurface('amazon.com', project)).toBe(SurfaceClasses['ota-aggregator'])
  })

  it('maps news domains to editorial-media', () => {
    expect(classifySurface('https://www.forbes.com/sites/x', project)).toBe(SurfaceClasses['editorial-media'])
  })

  it('maps blog domains to editorial-media', () => {
    expect(classifySurface('medium.com/@a/b', project)).toBe(SurfaceClasses['editorial-media'])
  })

  it('maps reference domains to editorial-media', () => {
    expect(classifySurface('https://en.wikipedia.org/wiki/Acme', project)).toBe(SurfaceClasses['editorial-media'])
  })

  it('maps social / forum / video / academic / unknown to other', () => {
    expect(classifySurface('reddit.com/r/x', project)).toBe(SurfaceClasses.other)
    expect(classifySurface('linkedin.com/in/x', project)).toBe(SurfaceClasses.other)
    expect(classifySurface('youtube.com/watch?v=x', project)).toBe(SurfaceClasses.other)
    expect(classifySurface('cs.stanford.edu/x', project)).toBe(SurfaceClasses.other)
    expect(classifySurface('some-random-site.io/page', project)).toBe(SurfaceClasses.other)
  })

  it('handles a bare hostname (no protocol) the same as a full URL', () => {
    expect(classifySurface('forbes.com', project)).toBe(SurfaceClasses['editorial-media'])
  })

  it('classifies against empty project/competitor lists as a pure category map', () => {
    const empty = { projectDomains: [], competitorDomains: [] }
    expect(classifySurface('acme.com', empty)).toBe(SurfaceClasses.other)
    expect(classifySurface('yelp.com', empty)).toBe(SurfaceClasses['ota-aggregator'])
  })

  it('falls back to other for malformed input', () => {
    expect(classifySurface('', project)).toBe(SurfaceClasses.other)
  })
})

describe('surfaceClassLabel', () => {
  it('returns a human label for every surface class', () => {
    for (const value of surfaceClassSchema.options) {
      expect(typeof surfaceClassLabel(value)).toBe('string')
      expect(surfaceClassLabel(value).length).toBeGreaterThan(0)
    }
  })

  it('uses distinct labels for OTA vs competitor (the actionable distinction)', () => {
    expect(surfaceClassLabel(SurfaceClasses['ota-aggregator'])).not.toBe(
      surfaceClassLabel(SurfaceClasses['direct-competitor']),
    )
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

  it('agrees with the classifySurface URI wrapper for the same source', () => {
    for (const uri of ['https://www.tripadvisor.com/Hotel', 'acme.io', 'rival.com', 'forbes.com', 'some-random.io/x']) {
      const { domain, category } = categorizeSource(uri)
      expect(classifySurfaceFromCategory(domain, category, project)).toBe(classifySurface(uri, project))
    }
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

  it('falls back to the heuristic when no stored class is supplied', () => {
    expect(classifySurfaceFromCategory('forbes.com', 'news', project, undefined)).toBe(SurfaceClasses['editorial-media'])
  })
})
