import { describe, expect, it } from 'vitest'
import {
  AppError,
  COMPETITOR_ALIAS_LIMIT,
  competitorBrandAliases,
  competitorEntryParts,
  competitorEntrySchema,
  competitorAliasProjectIdentity,
  competitorNameAliases,
  MIN_BRAND_ALIAS_KEY_LENGTH,
  normalizeCompetitorAliases,
  planCompetitorAliases,
  projectConfigSchema,
  requireCompetitorAliasPlan,
  textContainsAnyBrandAlias,
} from '../src/index.js'

const PROJECT_BRAND = competitorAliasProjectIdentity({
  displayName: 'Rotorwise',
  aliases: ['Rotorwise Pros'],
  canonicalDomain: 'rotorwise.example',
})
const NO_PROJECT = { brandNames: [], domains: [] }

describe('normalizeCompetitorAliases', () => {
  it('trims, drops blanks and dedupes case-insensitively, keeping the first spelling', () => {
    expect(normalizeCompetitorAliases(['  TuneSpoke ', '', '   ', 'tunespoke', 'TUNESPOKE', 'Tune Spoke']))
      .toEqual(['TuneSpoke', 'Tune Spoke'])
  })

  it('returns an empty list for null, undefined and empty input', () => {
    expect(normalizeCompetitorAliases(null)).toEqual([])
    expect(normalizeCompetitorAliases(undefined)).toEqual([])
    expect(normalizeCompetitorAliases([])).toEqual([])
  })
})

describe('competitor matcher identity', () => {
  it('layers curated aliases onto the domain label and written host', () => {
    expect(competitorBrandAliases({ domain: 'spoketuneworks.example', aliases: ['TuneSpoke'] }))
      .toEqual(['spoketuneworks', 'TuneSpoke', 'spoketuneworks.example'])
    expect(competitorNameAliases({ domain: 'spoketuneworks.example', aliases: ['TuneSpoke'] }))
      .toEqual(['spoketuneworks', 'TuneSpoke'])
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
    expect(competitorBrandAliases({ domain: 'ravenwoodbikeinc.example', aliases: [] }))
      .toEqual(['ravenwoodbikeinc', 'ravenwoodbikeinc.example'])
  })
})

describe('planCompetitorAliases', () => {
  it('normalizes and keeps valid explicit aliases', () => {
    const plan = planCompetitorAliases([
      { domain: 'spoketuneworks.example', aliases: [' TuneSpoke ', 'tunespoke'], explicit: true },
      { domain: 'ravenwoodbikeinc.example', aliases: ['Ravenwood Cycling'], explicit: true },
      { domain: 'qvx.example', aliases: ['QVX'], explicit: true },
    ], PROJECT_BRAND)
    expect(plan.rejected).toEqual([])
    expect(plan.overLimit).toEqual([])
    expect(plan.competitors).toEqual([
      { domain: 'spoketuneworks.example', aliases: ['TuneSpoke'] },
      { domain: 'ravenwoodbikeinc.example', aliases: ['Ravenwood Cycling'] },
      { domain: 'qvx.example', aliases: ['QVX'] },
    ])
  })

  it('rejects too-short, too-long and project-brand aliases', () => {
    const tooLong = 'x'.repeat(81)
    const plan = planCompetitorAliases([
      { domain: 'qvx.example', aliases: ['QV', tooLong, 'Rotorwise', 'rotorwise-pros', 'QVX'], explicit: true },
    ], PROJECT_BRAND)
    expect(plan.rejected).toEqual([
      { domain: 'qvx.example', alias: 'QV', reason: 'too-short' },
      { domain: 'qvx.example', alias: tooLong, reason: 'too-long' },
      { domain: 'qvx.example', alias: 'Rotorwise', reason: 'project-brand' },
      { domain: 'qvx.example', alias: 'rotorwise-pros', reason: 'project-brand' },
    ])
    expect(plan.competitors).toEqual([{ domain: 'qvx.example', aliases: ['QVX'] }])
  })

  it('accepts exactly 80 characters and exactly the alias limit', () => {
    const eighty = 'y'.repeat(80)
    const aliases = Array.from({ length: COMPETITOR_ALIAS_LIMIT - 1 }, (_, i) => `Brand ${String.fromCharCode(65 + i)}`)
    const plan = planCompetitorAliases([{ domain: 'qvx.example', aliases: [...aliases, eighty], explicit: true }], NO_PROJECT)
    expect(plan.rejected).toEqual([])
    expect(plan.overLimit).toEqual([])
    expect(plan.competitors[0]!.aliases).toHaveLength(COMPETITOR_ALIAS_LIMIT)
  })

  it('flags an explicit list over the limit after dedupe', () => {
    const aliases = Array.from({ length: COMPETITOR_ALIAS_LIMIT + 1 }, (_, i) => `Brand ${String.fromCharCode(65 + i)}`)
    const plan = planCompetitorAliases([{ domain: 'qvx.example', aliases: [...aliases, 'brand a'], explicit: true }], NO_PROJECT)
    expect(plan.overLimit).toEqual([{ domain: 'qvx.example', count: COMPETITOR_ALIAS_LIMIT + 1 }])
  })

  it('rejects an explicit alias another competitor already answers to', () => {
    const plan = planCompetitorAliases([
      { domain: 'ravenwood.example', aliases: [], explicit: false },
      { domain: 'ravenwoodbikeinc.example', aliases: ['Ravenwood', 'Ravenwood Cycling'], explicit: true },
      { domain: 'spoketuneworks.example', aliases: ['TuneSpoke'], explicit: false },
      { domain: 'qvx.example', aliases: ['Tune Spoke'], explicit: true },
    ], PROJECT_BRAND)
    expect(plan.rejected).toEqual([
      { domain: 'ravenwoodbikeinc.example', alias: 'Ravenwood', reason: 'other-competitor', conflictsWith: 'ravenwood.example' },
      { domain: 'qvx.example', alias: 'Tune Spoke', reason: 'other-competitor', conflictsWith: 'spoketuneworks.example' },
    ])
    // The carried-over list is never stripped by the new write.
    expect(plan.competitors.find(c => c.domain === 'spoketuneworks.example')?.aliases).toEqual(['TuneSpoke'])
    expect(plan.dropped).toEqual([])
  })

  it('drops a carried-over alias that no longer qualifies instead of failing', () => {
    const plan = planCompetitorAliases([
      { domain: 'spoketuneworks.example', aliases: ['TuneSpoke', 'Rotorwise'], explicit: false },
      { domain: 'qvx.example', aliases: ['ravenwood'], explicit: false },
      { domain: 'ravenwood.example', aliases: [], explicit: false },
    ], PROJECT_BRAND)
    expect(plan.rejected).toEqual([])
    expect(plan.dropped).toEqual([
      { domain: 'spoketuneworks.example', alias: 'Rotorwise', reason: 'project-brand' },
      { domain: 'qvx.example', alias: 'ravenwood', reason: 'other-competitor', conflictsWith: 'ravenwood.example' },
    ])
    expect(plan.competitors).toEqual([
      { domain: 'spoketuneworks.example', aliases: ['TuneSpoke'] },
      { domain: 'qvx.example', aliases: [] },
      { domain: 'ravenwood.example', aliases: [] },
    ])
  })

  it('rejects an alias found as whole words in a project name or written project host', () => {
    // The matcher counts complete adjacent words, so any of these would count
    // every mention of "Acme Cycles (acmecycles.example)" as the competitor.
    const project = competitorAliasProjectIdentity({
      displayName: 'Acme Cycles',
      canonicalDomain: 'https://www.acmecycles.example/shop',
      ownedDomains: ['acme-service.example'],
    })
    expect(project.domains).toEqual(['acmecycles.example', 'acme-service.example'])
    const plan = planCompetitorAliases([
      {
        domain: 'rival.example',
        aliases: ['Acme', 'Cycles', 'acmecycles.example', 'www.acmecycles.example', 'shop.acme-service.example', 'acme-service.example', 'Acme Cycles', 'Acme Cycle Works', 'Acmecycles Outlet'],
        explicit: true,
      },
    ], project)
    expect(plan.rejected).toEqual([
      { domain: 'rival.example', alias: 'Acme', reason: 'project-brand' },
      { domain: 'rival.example', alias: 'Cycles', reason: 'project-brand' },
      { domain: 'rival.example', alias: 'acmecycles.example', reason: 'project-brand' },
      { domain: 'rival.example', alias: 'www.acmecycles.example', reason: 'project-brand' },
      { domain: 'rival.example', alias: 'shop.acme-service.example', reason: 'project-brand' },
      { domain: 'rival.example', alias: 'acme-service.example', reason: 'project-brand' },
      { domain: 'rival.example', alias: 'Acme Cycles', reason: 'project-brand' },
    ])
    // A different word sequence is a different name: "Acme Cycle Works" and
    // "Acmecycles Outlet" are never found inside the project's names.
    expect(plan.competitors).toEqual([
      { domain: 'rival.example', aliases: ['Acme Cycle Works', 'Acmecycles Outlet'] },
    ])
  })

  it('drops a carried-over alias the project identity now contains', () => {
    const plan = planCompetitorAliases(
      [{ domain: 'rival.example', aliases: ['Acme', 'Rival Wheels'], explicit: false }],
      competitorAliasProjectIdentity({ displayName: 'Acme Cycles', canonicalDomain: 'acmecycles.example' }),
    )
    expect(plan.rejected).toEqual([])
    expect(plan.dropped).toEqual([{ domain: 'rival.example', alias: 'Acme', reason: 'project-brand' }])
    expect(plan.competitors).toEqual([{ domain: 'rival.example', aliases: ['Rival Wheels'] }])
  })

  it('blocks a new competitor whose domain identifies another competitor\'s stored alias', () => {
    const plan = planCompetitorAliases([
      { domain: 'spoketuneworks.example', aliases: ['TuneSpoke', 'Spoke Tune Pros'], explicit: false },
      { domain: 'tunespoke.example', aliases: [], explicit: false, added: true },
    ], PROJECT_BRAND)
    expect(plan.rejected).toEqual([
      { domain: 'tunespoke.example', alias: 'TuneSpoke', reason: 'claimed-by-alias', conflictsWith: 'spoketuneworks.example' },
    ])
    // Nothing is stripped: the write fails instead.
    expect(plan.dropped).toEqual([])
    expect(plan.competitors[0]).toEqual({ domain: 'spoketuneworks.example', aliases: ['TuneSpoke', 'Spoke Tune Pros'] })
  })

  it('lets a write that restates the alias owner\'s list add the domain', () => {
    const plan = planCompetitorAliases([
      { domain: 'spoketuneworks.example', aliases: ['Spoke Tune Pros'], explicit: true },
      { domain: 'tunespoke.example', aliases: [], explicit: false, added: true },
    ], PROJECT_BRAND)
    expect(plan.rejected).toEqual([])
    expect(plan.competitors).toEqual([
      { domain: 'spoketuneworks.example', aliases: ['Spoke Tune Pros'] },
      { domain: 'tunespoke.example', aliases: [] },
    ])
  })

  it('allows an alias equal to the competitor\'s own domain label', () => {
    const plan = planCompetitorAliases([{ domain: 'spoketuneworks.example', aliases: ['Spoke Tune Works'], explicit: true }], NO_PROJECT)
    expect(plan.rejected).toEqual([])
  })
})

describe('requireCompetitorAliasPlan', () => {
  it('throws one validation error naming every problem', () => {
    let caught: unknown
    try {
      requireCompetitorAliasPlan([{ domain: 'qvx.example', aliases: ['QV', 'Rotorwise'], explicit: true }], PROJECT_BRAND)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AppError)
    const appError = caught as AppError
    expect(appError.code).toBe('VALIDATION_ERROR')
    expect(appError.message).toBe(
      'Invalid competitor aliases: qvx.example: "QV" is too short: an alias needs at least 3 letters or digits; '
      + 'qvx.example: "Rotorwise" is one of the project\'s own brand names, so it would count the project as a competitor',
    )
    expect(appError.details).toMatchObject({
      rejectedAliases: [
        { domain: 'qvx.example', alias: 'QV', reason: 'too-short' },
        { domain: 'qvx.example', alias: 'Rotorwise', reason: 'project-brand' },
      ],
      limit: COMPETITOR_ALIAS_LIMIT,
    })
  })

  it('names a blocked add and the alias to remove', () => {
    expect(() => requireCompetitorAliasPlan([
      { domain: 'spoketuneworks.example', aliases: ['TuneSpoke'], explicit: false },
      { domain: 'tunespoke.example', aliases: [], explicit: false, added: true },
    ], PROJECT_BRAND)).toThrow(
      'Invalid competitor aliases: tunespoke.example: cannot be added while "TuneSpoke" is a curated alias of spoketuneworks.example; remove or restate that alias first',
    )
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
      metadata: { name: 'rotorwise' },
      spec: {
        displayName: 'Rotorwise',
        canonicalDomain: 'rotorwise.example',
        country: 'US',
        language: 'en',
        competitors: ['ravenwood.example', { domain: 'spoketuneworks.example', aliases: ['TuneSpoke'] }],
      },
    })
    expect(parsed.spec.competitors).toEqual(['ravenwood.example', { domain: 'spoketuneworks.example', aliases: ['TuneSpoke'] }])
  })
})
