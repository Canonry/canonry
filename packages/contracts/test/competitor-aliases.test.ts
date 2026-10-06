import { describe, expect, it } from 'vitest'
import {
  AppError,
  COMPETITOR_ALIAS_LIMIT,
  competitorBrandAliases,
  competitorEntryParts,
  competitorEntrySchema,
  competitorNameAliases,
  effectiveBrandNames,
  MIN_BRAND_ALIAS_KEY_LENGTH,
  normalizeCompetitorAliases,
  planCompetitorAliases,
  projectConfigSchema,
  requireCompetitorAliasPlan,
  textContainsAnyBrandAlias,
} from '../src/index.js'

const PROJECT_BRAND = effectiveBrandNames({
  displayName: 'Roofwise',
  aliases: ['Roofwise Pros'],
  canonicalDomain: 'roofwise.example',
})

describe('normalizeCompetitorAliases', () => {
  it('trims, drops blanks and dedupes case-insensitively, keeping the first spelling', () => {
    expect(normalizeCompetitorAliases(['  FoamSeal ', '', '   ', 'foamseal', 'FOAMSEAL', 'Foam Seal']))
      .toEqual(['FoamSeal', 'Foam Seal'])
  })

  it('returns an empty list for null, undefined and empty input', () => {
    expect(normalizeCompetitorAliases(null)).toEqual([])
    expect(normalizeCompetitorAliases(undefined)).toEqual([])
    expect(normalizeCompetitorAliases([])).toEqual([])
  })
})

describe('competitor matcher identity', () => {
  it('layers curated aliases onto the domain label and written host', () => {
    expect(competitorBrandAliases({ domain: 'sealfoamworks.example', aliases: ['FoamSeal'] }))
      .toEqual(['sealfoamworks', 'FoamSeal', 'sealfoamworks.example'])
    expect(competitorNameAliases({ domain: 'sealfoamworks.example', aliases: ['FoamSeal'] }))
      .toEqual(['sealfoamworks', 'FoamSeal'])
  })

  it('keeps a 3-letter brand only when it is curated', () => {
    // The domain label `qvx` is below the domain floor (4) ...
    expect(competitorNameAliases({ domain: 'qvx.example' })).toEqual([])
    expect(competitorBrandAliases({ domain: 'qvx.example' })).toEqual(['qvx.example'])
    // ... but an operator-approved `QVX` takes the alias floor (3).
    expect(competitorNameAliases({ domain: 'qvx.example', aliases: ['QVX'] })).toEqual(['QVX'])
    expect(textContainsAnyBrandAlias('Try QVX for linen.', competitorNameAliases({ domain: 'qvx.example', aliases: ['QVX'] }))).toBe(true)
    expect(textContainsAnyBrandAlias('Great qvxshop deals.', competitorNameAliases({ domain: 'qvx.example', aliases: ['QVX'] }))).toBe(false)
  })

  it('drops a stored alias whose key is below the alias floor', () => {
    expect(MIN_BRAND_ALIAS_KEY_LENGTH).toBe(3)
    expect(competitorNameAliases({ domain: 'qvx.example', aliases: ['Q.V', 'QVX'] })).toEqual(['QVX'])
  })

  it('is unchanged for a competitor with no curated alias', () => {
    expect(competitorBrandAliases({ domain: 'ridgecrestbuildinc.example', aliases: [] }))
      .toEqual(['ridgecrestbuildinc', 'ridgecrestbuildinc.example'])
  })
})

describe('planCompetitorAliases', () => {
  it('normalizes and keeps valid explicit aliases', () => {
    const plan = planCompetitorAliases([
      { domain: 'sealfoamworks.example', aliases: [' FoamSeal ', 'foamseal'], explicit: true },
      { domain: 'ridgecrestbuildinc.example', aliases: ['Ridgecrest Roofing'], explicit: true },
      { domain: 'qvx.example', aliases: ['QVX'], explicit: true },
    ], PROJECT_BRAND)
    expect(plan.rejected).toEqual([])
    expect(plan.overLimit).toEqual([])
    expect(plan.competitors).toEqual([
      { domain: 'sealfoamworks.example', aliases: ['FoamSeal'] },
      { domain: 'ridgecrestbuildinc.example', aliases: ['Ridgecrest Roofing'] },
      { domain: 'qvx.example', aliases: ['QVX'] },
    ])
  })

  it('rejects too-short, too-long and project-brand aliases', () => {
    const tooLong = 'x'.repeat(81)
    const plan = planCompetitorAliases([
      { domain: 'qvx.example', aliases: ['QV', tooLong, 'Roofwise', 'roofwise-pros', 'QVX'], explicit: true },
    ], PROJECT_BRAND)
    expect(plan.rejected).toEqual([
      { domain: 'qvx.example', alias: 'QV', reason: 'too-short' },
      { domain: 'qvx.example', alias: tooLong, reason: 'too-long' },
      { domain: 'qvx.example', alias: 'Roofwise', reason: 'project-brand' },
      { domain: 'qvx.example', alias: 'roofwise-pros', reason: 'project-brand' },
    ])
    expect(plan.competitors).toEqual([{ domain: 'qvx.example', aliases: ['QVX'] }])
  })

  it('accepts exactly 80 characters and exactly the alias limit', () => {
    const eighty = 'y'.repeat(80)
    const aliases = Array.from({ length: COMPETITOR_ALIAS_LIMIT - 1 }, (_, i) => `Brand ${String.fromCharCode(65 + i)}`)
    const plan = planCompetitorAliases([{ domain: 'qvx.example', aliases: [...aliases, eighty], explicit: true }], [])
    expect(plan.rejected).toEqual([])
    expect(plan.overLimit).toEqual([])
    expect(plan.competitors[0]!.aliases).toHaveLength(COMPETITOR_ALIAS_LIMIT)
  })

  it('flags an explicit list over the limit after dedupe', () => {
    const aliases = Array.from({ length: COMPETITOR_ALIAS_LIMIT + 1 }, (_, i) => `Brand ${String.fromCharCode(65 + i)}`)
    const plan = planCompetitorAliases([{ domain: 'qvx.example', aliases: [...aliases, 'brand a'], explicit: true }], [])
    expect(plan.overLimit).toEqual([{ domain: 'qvx.example', count: COMPETITOR_ALIAS_LIMIT + 1 }])
  })

  it('rejects an explicit alias another competitor already answers to', () => {
    const plan = planCompetitorAliases([
      { domain: 'ridgecrest.example', aliases: [], explicit: false },
      { domain: 'ridgecrestbuildinc.example', aliases: ['Ridgecrest', 'Ridgecrest Roofing'], explicit: true },
      { domain: 'sealfoamworks.example', aliases: ['FoamSeal'], explicit: false },
      { domain: 'qvx.example', aliases: ['Foam Seal'], explicit: true },
    ], PROJECT_BRAND)
    expect(plan.rejected).toEqual([
      { domain: 'ridgecrestbuildinc.example', alias: 'Ridgecrest', reason: 'other-competitor', conflictsWith: 'ridgecrest.example' },
      { domain: 'qvx.example', alias: 'Foam Seal', reason: 'other-competitor', conflictsWith: 'sealfoamworks.example' },
    ])
    // The carried-over list is never stripped by the new write.
    expect(plan.competitors.find(c => c.domain === 'sealfoamworks.example')?.aliases).toEqual(['FoamSeal'])
    expect(plan.dropped).toEqual([])
  })

  it('drops a carried-over alias that no longer qualifies instead of failing', () => {
    const plan = planCompetitorAliases([
      { domain: 'sealfoamworks.example', aliases: ['FoamSeal', 'Roofwise'], explicit: false },
      { domain: 'qvx.example', aliases: ['ridgecrest'], explicit: false },
      { domain: 'ridgecrest.example', aliases: [], explicit: false },
    ], PROJECT_BRAND)
    expect(plan.rejected).toEqual([])
    expect(plan.dropped).toEqual([
      { domain: 'sealfoamworks.example', alias: 'Roofwise', reason: 'project-brand' },
      { domain: 'qvx.example', alias: 'ridgecrest', reason: 'other-competitor', conflictsWith: 'ridgecrest.example' },
    ])
    expect(plan.competitors).toEqual([
      { domain: 'sealfoamworks.example', aliases: ['FoamSeal'] },
      { domain: 'qvx.example', aliases: [] },
      { domain: 'ridgecrest.example', aliases: [] },
    ])
  })

  it('allows an alias equal to the competitor\'s own domain label', () => {
    const plan = planCompetitorAliases([{ domain: 'sealfoamworks.example', aliases: ['Seal Foam Works'], explicit: true }], [])
    expect(plan.rejected).toEqual([])
  })
})

describe('requireCompetitorAliasPlan', () => {
  it('throws one validation error naming every problem', () => {
    let caught: unknown
    try {
      requireCompetitorAliasPlan([{ domain: 'qvx.example', aliases: ['QV', 'Roofwise'], explicit: true }], PROJECT_BRAND)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AppError)
    const appError = caught as AppError
    expect(appError.code).toBe('VALIDATION_ERROR')
    expect(appError.message).toBe(
      'Invalid competitor aliases: qvx.example: "QV" is too short: an alias needs at least 3 letters or digits; '
      + 'qvx.example: "Roofwise" is one of the project\'s own brand names, so it would count the project as a competitor',
    )
    expect(appError.details).toMatchObject({
      rejectedAliases: [
        { domain: 'qvx.example', alias: 'QV', reason: 'too-short' },
        { domain: 'qvx.example', alias: 'Roofwise', reason: 'project-brand' },
      ],
      limit: COMPETITOR_ALIAS_LIMIT,
    })
  })

  it('returns the plan when every explicit alias passes', () => {
    expect(requireCompetitorAliasPlan([{ domain: 'qvx.example', aliases: ['QVX'], explicit: true }], PROJECT_BRAND).competitors)
      .toEqual([{ domain: 'qvx.example', aliases: ['QVX'] }])
  })
})

describe('competitor entries', () => {
  it('accepts a bare domain or an object, and splits them', () => {
    expect(competitorEntrySchema.parse('qvx.example')).toBe('qvx.example')
    expect(competitorEntrySchema.parse({ domain: 'qvx.example', aliases: ['QVX'] })).toEqual({ domain: 'qvx.example', aliases: ['QVX'] })
    expect(competitorEntryParts('qvx.example')).toEqual({ domain: 'qvx.example', aliases: undefined })
    expect(competitorEntryParts({ domain: 'qvx.example' })).toEqual({ domain: 'qvx.example', aliases: undefined })
    expect(competitorEntryParts({ domain: 'qvx.example', aliases: [] })).toEqual({ domain: 'qvx.example', aliases: [] })
  })

  it('keeps plain string competitors valid in a config spec', () => {
    const parsed = projectConfigSchema.parse({
      apiVersion: 'canonry/v1',
      kind: 'Project',
      metadata: { name: 'roofwise' },
      spec: {
        displayName: 'Roofwise',
        canonicalDomain: 'roofwise.example',
        country: 'US',
        language: 'en',
        competitors: ['ridgecrest.example', { domain: 'sealfoamworks.example', aliases: ['FoamSeal'] }],
      },
    })
    expect(parsed.spec.competitors).toEqual(['ridgecrest.example', { domain: 'sealfoamworks.example', aliases: ['FoamSeal'] }])
  })
})
