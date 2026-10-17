import { describe, expect, test } from 'vitest'
import type { MeasurementDraftTarget } from '@canonry/canonry-contracts'
import { classifyMeasurementSitemapUrls } from '../src/measurement-discovery.js'
import {
  measurementDiscoveryIdentity,
  parseMeasurementDiscoveryIdentity,
  proposeMeasurementDiscoveryBindings,
} from '../src/measurement-discovery-v2.js'

const HOST = 'northstar.example'

const rule = (pathTemplate: string) => ({ primary: { host: HOST, pathTemplate } })

function candidates(pathTemplate: string, slugs: readonly string[]) {
  return classifyMeasurementSitemapUrls({
    ownedHosts: [HOST],
    rules: rule(pathTemplate),
    urls: slugs.map(slug => `https://${HOST}${pathTemplate.replace('{slug}', slug)}`),
    maxUrls: 100,
  }).proposed
}

function target(overrides: Partial<MeasurementDraftTarget> & { stableKey: string }): MeasurementDraftTarget {
  return {
    label: 'Existing',
    status: 'included',
    aliases: [],
    urlMatchers: [],
    source: 'sitemap',
    ...overrides,
  }
}

function discovered(pathTemplate: string, slug: string, overrides: Partial<MeasurementDraftTarget> = {}): MeasurementDraftTarget {
  return target({
    stableKey: `target-${slug}`,
    discoveredUrl: `https://${HOST}${pathTemplate.replace('{slug}', slug)}`,
    discoveryIdentity: measurementDiscoveryIdentity({ host: HOST, pathTemplate, slug }),
    ...overrides,
  })
}

function propose(input: {
  pathTemplate: string
  slugs: readonly string[]
  targets?: readonly MeasurementDraftTarget[]
  exclusions?: readonly string[]
}) {
  return proposeMeasurementDiscoveryBindings({
    candidates: candidates(input.pathTemplate, input.slugs),
    rule: rule(input.pathTemplate),
    exclusions: input.exclusions ?? [],
    targets: input.targets ?? [],
  })
}

describe('discovery identity', () => {
  test('is equal for equal structure and different for every component that differs', () => {
    const base = { host: HOST, pathTemplate: '/locations/{slug}', slug: 'north-park' }

    expect(measurementDiscoveryIdentity(base)).toBe(measurementDiscoveryIdentity({ ...base }))
    expect(measurementDiscoveryIdentity({ ...base, host: 'other.example' })).not.toBe(measurementDiscoveryIdentity(base))
    expect(measurementDiscoveryIdentity({ ...base, pathTemplate: '/areas/{slug}' })).not.toBe(measurementDiscoveryIdentity(base))
    expect(measurementDiscoveryIdentity({ ...base, slug: 'south-park' })).not.toBe(measurementDiscoveryIdentity(base))
  })

  test('round-trips through the parser so a rebind can compare structure, not text', () => {
    const parts = { host: HOST, pathTemplate: '/locations/{slug}', slug: 'north-park' }
    expect(parseMeasurementDiscoveryIdentity(measurementDiscoveryIdentity(parts))).toEqual(parts)
    expect(parseMeasurementDiscoveryIdentity('north-park')).toBeNull()
  })

  test('is structural: the display label neither makes nor breaks it', () => {
    const [first] = propose({ pathTemplate: '/locations/{slug}', slugs: ['north-park'] }).proposals
    const [second] = propose({ pathTemplate: '/locations/{slug}', slugs: ['north-park'] }).proposals

    expect(first!.discoveryIdentity).toBe(second!.discoveryIdentity)
    // Same label, different structure: the labels collide and the identities do not.
    const relabelled = measurementDiscoveryIdentity({ host: HOST, pathTemplate: '/areas/{slug}', slug: 'north-park' })
    expect(relabelled).not.toBe(first!.discoveryIdentity)
  })
})

describe('rebind proposals', () => {
  test('proposes nothing for a Target already bound to the discovered identity', () => {
    const result = propose({
      pathTemplate: '/locations/{slug}',
      slugs: ['north-park'],
      targets: [discovered('/locations/{slug}', 'north-park')],
    })

    expect(result.proposals).toEqual([])
    expect(result.unchanged).toEqual(['target-north-park'])
  })

  test('proposes a rebind when exactly one Target crosses the threshold', () => {
    const result = propose({
      pathTemplate: '/areas/{slug}',
      slugs: ['north-park'],
      targets: [discovered('/locations/{slug}', 'north-park', { stableKey: 'target-legacy' })],
    })

    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]).toMatchObject({ kind: 'rebind', rebindTargetKey: 'target-legacy', slug: 'north-park' })
    expect(result.proposals[0]!.candidates.map(entry => entry.targetKey)).toEqual(['target-legacy'])
  })

  test('proposes a new Target when nothing crosses the threshold', () => {
    const result = propose({
      pathTemplate: '/locations/{slug}',
      slugs: ['north-park'],
      targets: [discovered('/locations/{slug}', 'harbour-quay', { stableKey: 'target-harbour-quay' })],
    })

    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]).toMatchObject({ kind: 'new-target', candidates: [] })
    expect(result.proposals[0]!.rebindTargetKey).toBeUndefined()
  })

  test('refuses to pick when two Targets cross the threshold', () => {
    const result = propose({
      pathTemplate: '/areas/{slug}',
      slugs: ['north-park'],
      targets: [
        discovered('/locations/{slug}', 'north-park', { stableKey: 'target-north-park-one' }),
        discovered('/regions/{slug}', 'north-park', { stableKey: 'target-north-park-two' }),
      ],
    })

    expect(result.proposals[0]).toMatchObject({ kind: 'ambiguous' })
    expect(result.proposals[0]!.rebindTargetKey).toBeUndefined()
    expect(result.proposals[0]!.candidates.map(entry => entry.targetKey))
      .toEqual(['target-north-park-one', 'target-north-park-two'])
  })

  test('never treats a manual Target as a rebind candidate, however well its label matches', () => {
    const result = propose({
      pathTemplate: '/areas/{slug}',
      slugs: ['north-park'],
      targets: [target({ stableKey: 'target-manual', label: 'North Park', source: 'manual' })],
    })

    expect(result.proposals[0]).toMatchObject({ kind: 'new-target', candidates: [] })
  })

  /**
   * A Target can be manual and still carry an identity — an operator takes over
   * a discovered Target and the structural fields stay on the row. The source is
   * what decides, so the identity being present and missing from the sitemap is
   * not on its own enough to move it.
   */
  test('never rebinds a manual Target that still carries a discovery identity', () => {
    const result = propose({
      pathTemplate: '/areas/{slug}',
      slugs: ['north-park'],
      targets: [discovered('/locations/{slug}', 'north-park', { stableKey: 'target-manual', source: 'manual' })],
    })

    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]).toMatchObject({ kind: 'new-target', candidates: [] })
    expect(result.proposals[0]!.rebindTargetKey).toBeUndefined()
  })

  test('never rebinds onto a Target the same sitemap still covers', () => {
    const result = propose({
      pathTemplate: '/locations/{slug}',
      slugs: ['north-park', 'north-park-village'],
      targets: [discovered('/locations/{slug}', 'north-park')],
    })

    expect(result.unchanged).toEqual(['target-north-park'])
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]).toMatchObject({ slug: 'north-park-village', kind: 'new-target' })
  })

  test('drops an excluded candidate by slug or by identity', () => {
    const bySlug = propose({ pathTemplate: '/locations/{slug}', slugs: ['north-park', 'harbour-quay'], exclusions: ['north-park'] })
    expect(bySlug.proposals.map(proposal => proposal.slug)).toEqual(['harbour-quay'])

    const identity = measurementDiscoveryIdentity({ host: HOST, pathTemplate: '/locations/{slug}', slug: 'harbour-quay' })
    const byIdentity = propose({ pathTemplate: '/locations/{slug}', slugs: ['north-park', 'harbour-quay'], exclusions: [identity] })
    expect(byIdentity.proposals.map(proposal => proposal.slug)).toEqual(['north-park'])
  })

  test('orders proposals by identity so two runs over the same inputs agree', () => {
    const forward = propose({ pathTemplate: '/locations/{slug}', slugs: ['north-park', 'harbour-quay', 'east-bay'] })
    const reversed = propose({ pathTemplate: '/locations/{slug}', slugs: ['east-bay', 'harbour-quay', 'north-park'] })

    expect(forward.proposals.map(proposal => proposal.slug)).toEqual(['east-bay', 'harbour-quay', 'north-park'])
    expect(reversed).toEqual(forward)
  })
})
