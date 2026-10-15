import { describe, expect, it } from 'vitest'
import { compileMeasurementPlan } from '@canonry/canonry-contracts'
import {
  classifyMeasurementSitemapUrls,
  type MeasurementDiscoveryInput,
} from '../src/measurement-discovery.js'

const rules: MeasurementDiscoveryInput['rules'] = {
  primary: { host: 'northstar.example', pathTemplate: '/locations/{slug}' },
  aliases: [{ host: 'homes.northstar.example', pathTemplate: '/{slug}' }],
  excludedSlugSuffixes: ['-region'],
}

function classify(urls: readonly string[], overrides: Partial<MeasurementDiscoveryInput> = {}) {
  return classifyMeasurementSitemapUrls({
    ownedHosts: ['northstar.example'],
    rules,
    urls,
    maxUrls: 50,
    ...overrides,
  })
}

describe('classifyMeasurementSitemapUrls', () => {
  it('uses the five-class review taxonomy with one reason per classified item', () => {
    const result = classify([
      'https://northstar.example/locations/harbor/',
      'https://homes.northstar.example/harbor/',
      'https://northstar.example/locations/lake-region/',
      'https://northstar.example/locations/',
      'https://northstar.example/about/',
    ])

    expect(result.proposed).toEqual([
      {
        classification: 'proposed',
        reason: 'primary-match',
        stableKey: 'target-harbor',
        slug: 'harbor',
        label: 'Harbor',
        primaryUrl: 'https://northstar.example/locations/harbor',
        aliasCoverageUrls: ['https://homes.northstar.example/harbor'],
      },
    ])
    expect(result.aliases).toEqual([
      {
        classification: 'alias',
        reason: 'exact-slug-match',
        slug: 'harbor',
        url: 'https://homes.northstar.example/harbor',
        targetStableKey: 'target-harbor',
      },
    ])
    expect(result.excluded).toEqual([
      expect.objectContaining({ classification: 'excluded', reason: 'excluded-slug' }),
    ])
    expect(result.shared).toEqual([
      expect.objectContaining({ classification: 'shared', reason: 'shared-path' }),
    ])
    expect(result.unmatched).toEqual([
      expect.objectContaining({ classification: 'unmatched', reason: 'unmatched-path' }),
    ])

    for (const item of [...result.proposed, ...result.aliases, ...result.excluded, ...result.shared, ...result.unmatched]) {
      expect(item).toHaveProperty('reason')
      expect(item).not.toHaveProperty('reasonCodes')
    }
  })

  it('attaches aliases only when an exact primary slug exists', () => {
    const result = classify([
      'https://homes.northstar.example/harbor/',
      'https://homes.northstar.example/ridge/',
      'https://northstar.example/locations/harbor/',
      'https://homes.northstar.example/harbor/floorplans/',
    ])

    expect(result.proposed[0]?.aliasCoverageUrls).toEqual(['https://homes.northstar.example/harbor'])
    expect(result.aliases).toHaveLength(1)
    expect(result.unmatched).toEqual([
      expect.objectContaining({ url: 'https://homes.northstar.example/harbor/floorplans', reason: 'unmatched-path' }),
      expect.objectContaining({ url: 'https://homes.northstar.example/ridge', reason: 'alias-without-primary' }),
    ])
  })

  it('turns proposed Targets and exact aliases directly into a compiled plan', () => {
    const discovered = classify([
      'https://northstar.example/locations/harbor/',
      'https://homes.northstar.example/harbor/',
    ])
    const compiled = compileMeasurementPlan({
      schemaVersion: 1,
      targets: discovered.proposed.map((target) => ({
        stableKey: target.stableKey,
        label: target.label,
        urls: [target.primaryUrl, ...target.aliasCoverageUrls].map((url) => ({
          kind: 'exact' as const,
          url,
          pathCase: 'insensitive' as const,
        })),
        aliases: [],
      })),
      targetQuerySelections: [{ targetKey: 'target-harbor', queryIds: ['q-1'] }],
    }, {
      canonicalDomain: 'northstar.example',
      ownedDomains: ['homes.northstar.example'],
      trackedQueries: [{ id: 'q-1', query: 'harbor homes' }],
      locations: [],
      expectedSnapshots: 2,
    })

    expect(compiled.targets.map((target) => target.stableKey)).toEqual(['target-harbor'])
    expect(compiled.executionNodes).toEqual([expect.objectContaining({ expectedSnapshots: 2 })])
  })

  it('normalizes www hosts and keeps ported URLs out of classified lanes', () => {
    const normalized = classify([
      'https://www.northstar.example/locations/harbor/',
      'https://www.homes.northstar.example/harbor/',
    ])
    expect(normalized.proposed[0]).toEqual(expect.objectContaining({
      primaryUrl: 'https://northstar.example/locations/harbor',
      aliasCoverageUrls: ['https://homes.northstar.example/harbor'],
    }))

    const ported = classify(['https://northstar.example:8443/locations/harbor/'])
    expect(ported.proposed).toEqual([])
    expect(ported.diagnostics).toEqual([
      { kind: 'invalid-url', url: 'https://northstar.example:8443/locations/harbor/', canonicalUrl: null },
    ])
  })

  it.each([
    'harbor%20point',
    'harbor-%E2%98%83',
    `harbor-${'x'.repeat(121)}`,
  ])('keeps unsupported slug %s unmatched for review', (slug) => {
    const result = classify([`https://northstar.example/locations/${slug}/`])
    expect(result.unmatched).toEqual([
      expect.objectContaining({ classification: 'unmatched', reason: 'unsupported-slug' }),
    ])
  })

  it('keeps invalid, unowned, duplicate, and cap outcomes as deterministic diagnostics', () => {
    const result = classify([
      'https://northstar.example/locations/zeta/?ref=one',
      'https://northstar.example/locations/alpha/',
      'https://northstar.example/locations/zeta',
      'https://outside.example/locations/omega/',
      'https://zebra.example/locations/peak/',
      'not a url',
    ], { maxUrls: 3 })

    expect(result.proposed.map((item) => item.slug)).toEqual(['alpha', 'zeta'])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: 'duplicate-url', url: 'https://northstar.example/locations/zeta/?ref=one' }),
      expect.objectContaining({ kind: 'invalid-url', url: 'not a url' }),
      expect.objectContaining({ kind: 'unowned-host', url: 'https://outside.example/locations/omega' }),
      expect.objectContaining({ kind: 'url-cap-reached', url: 'https://zebra.example/locations/peak' }),
    ])
  })

  it('is order-independent and validates literal template rules', () => {
    const urls = [
      'https://northstar.example/locations/bravo/',
      'https://northstar.example/locations/alpha/',
      'https://homes.northstar.example/alpha/',
    ]
    expect(classify(urls)).toEqual(classify([...urls].reverse()))
    expect(() => classify([], {
      rules: { primary: { host: 'northstar.example', pathTemplate: '/locations/{slug}-{kind}' } },
    })).toThrow('exactly one {slug} path segment')
  })

  it('supports generic subdomain rules and literal exclusion patterns', () => {
    const result = classifyMeasurementSitemapUrls({
      ownedHosts: ['saas.example'],
      rules: {
        primary: { host: 'app.saas.example', pathTemplate: '/customers/{slug}' },
        aliases: [{ host: 'www.saas.example', pathTemplate: '/customers/{slug}' }],
        excludedSlugPatterns: [
          { kind: 'exact', value: 'all-customers' },
          { kind: 'suffix', value: '-template' },
        ],
      },
      urls: [
        'https://app.saas.example/customers/harbor/',
        'https://www.saas.example/customers/harbor/',
        'https://app.saas.example/customers/all-customers/',
        'https://app.saas.example/customers/invoice-template/',
      ],
      maxUrls: 20,
    })

    expect(result.proposed).toEqual([expect.objectContaining({ stableKey: 'target-harbor' })])
    expect(result.aliases).toEqual([expect.objectContaining({ slug: 'harbor', targetStableKey: 'target-harbor' })])
    expect(result.excluded.map((item) => item.reason)).toEqual(['excluded-slug', 'excluded-slug'])
  })

  it('classifies a deterministic large sitemap with exclusions and exact alias coverage', () => {
    const targetSlugs = Array.from({ length: 180 }, (_, index) => `location-${String(index + 1).padStart(3, '0')}`)
    const excludedSlugs = Array.from({ length: 20 }, (_, index) => `region-${String(index + 1).padStart(2, '0')}-region`)
    const aliasSlugs = targetSlugs.slice(0, 160)
    const urls = [
      ...targetSlugs.map((slug) => `https://northstar.example/locations/${slug}/`),
      ...excludedSlugs.map((slug) => `https://northstar.example/locations/${slug}/`),
      ...aliasSlugs.map((slug) => `https://homes.northstar.example/${slug}/`),
    ]

    const forward = classify(urls, { maxUrls: 500 })
    const reverse = classify([...urls].reverse(), { maxUrls: 500 })
    expect(forward).toEqual(reverse)
    expect(forward.proposed).toHaveLength(180)
    expect(forward.excluded).toHaveLength(20)
    expect(forward.aliases).toHaveLength(160)
    expect(forward.proposed.reduce((total, target) => total + target.aliasCoverageUrls.length, 0)).toBe(160)
  })
})
