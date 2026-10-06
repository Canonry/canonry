import { describe, expect, it } from 'vitest'
import {
  AppError,
  brandKeyFromText,
  COMPETITOR_ALIAS_LIMIT,
  competitorBrandAliases,
  competitorDomainProjectClaim,
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
  usableBrandAliases,
  type CompetitorAliasPlanEntry,
  type CompetitorAliasProjectIdentity,
} from '../src/index.js'

const PROJECT_BRAND = competitorAliasProjectIdentity({
  displayName: 'Rotorwise',
  aliases: ['Rotorwise Pros'],
  canonicalDomain: 'rotorwise.example',
})
const NO_PROJECT = { brandNames: [], domains: [] }

/**
 * Every way an answer can write `token` as words: its brand key split at any
 * two places ("tunespoke" as "tune spoke", "t unes poke", ...), plus the
 * token as written. The readers match a key against complete adjacent words
 * under any of these, so an accepted alias must survive all of them.
 */
function spellings(token: string): string[] {
  const key = brandKeyFromText(token)
  const result = new Set([token])
  for (let i = 0; i <= key.length; i++) {
    for (let j = i; j <= key.length; j++) {
      result.add([key.slice(0, i), key.slice(i, j), key.slice(j)].filter(Boolean).join(' '))
    }
  }
  return [...result]
}

/** The spellings of `tokens` that the readers would also count for `names`. */
function doubleCounted(tokens: readonly string[], names: readonly string[]): string[] {
  if (names.length === 0) return []
  return tokens.flatMap(token => spellings(token).filter(spelling => textContainsAnyBrandAlias(spelling, names)))
}

/**
 * The invariant every accepted plan must hold: no spelling of one
 * competitor's alias counts another competitor or the project, and no
 * spelling of another competitor's name or the project's names counts the
 * alias. Two competitors' domain names are not compared (out of scope).
 */
function expectNoDoubleCount(plan: { competitors: { domain: string; aliases: string[] }[] }, project: CompetitorAliasProjectIdentity) {
  const projectNames = [...project.brandNames, ...project.domains]
  for (const owner of plan.competitors) {
    const aliases = usableBrandAliases(owner.aliases)
    expect(doubleCounted(aliases, projectNames), `${owner.domain} alias counts the project`).toEqual([])
    expect(doubleCounted(projectNames, aliases), `a project name counts ${owner.domain}`).toEqual([])
    for (const other of plan.competitors) {
      if (other.domain === owner.domain) continue
      expect(doubleCounted(aliases, competitorBrandAliases(other)), `${owner.domain} alias counts ${other.domain}`).toEqual([])
      expect(doubleCounted(competitorBrandAliases({ domain: other.domain }), aliases), `${other.domain} domain counts ${owner.domain}`).toEqual([])
    }
  }
}

/** Every ordering of `items`. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]))
}

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
      // `ravenwood`, the other domain's label, is a complete word of it.
      { domain: 'ravenwoodbikeinc.example', alias: 'Ravenwood Cycling', reason: 'other-competitor', conflictsWith: 'ravenwood.example', conflictingName: 'ravenwood' },
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

  it('rejects an alias whose key overlaps a project name or written project host', () => {
    // An answer naming "Acme Cycles (acmecycles.example)" in some spelling
    // would also name any of these, so each would count the project as the
    // competitor.
    const project = competitorAliasProjectIdentity({
      displayName: 'Acme Cycles',
      canonicalDomain: 'https://www.acmecycles.example/shop',
      ownedDomains: ['acme-service.example'],
    })
    expect(project.domains).toEqual(['acmecycles.example', 'acme-service.example'])
    const plan = planCompetitorAliases([
      {
        domain: 'rival.example',
        aliases: ['Acme', 'Cycles', 'acmecycles.example', 'www.acmecycles.example', 'shop.acme-service.example', 'acme-service.example', 'Acme Cycles', 'Acme Cycle Works', 'Acmecycles Outlet', 'Acme Cyclesworks'],
        explicit: true,
      },
    ], project)
    expect(plan.rejected).toEqual([
      { domain: 'rival.example', alias: 'Acme', reason: 'project-brand', conflictingName: 'Acme Cycles' },
      { domain: 'rival.example', alias: 'Cycles', reason: 'project-brand', conflictingName: 'Acme Cycles' },
      { domain: 'rival.example', alias: 'acmecycles.example', reason: 'project-brand' },
      // A host on the project's own site contains the project's key.
      { domain: 'rival.example', alias: 'www.acmecycles.example', reason: 'project-brand', conflictingName: 'Acme Cycles' },
      { domain: 'rival.example', alias: 'shop.acme-service.example', reason: 'project-brand', conflictingName: 'acme-service' },
      { domain: 'rival.example', alias: 'acme-service.example', reason: 'project-brand' },
      { domain: 'rival.example', alias: 'Acme Cycles', reason: 'project-brand' },
      // The reverse containment: the key `acmecycles` sits inside these, so
      // "Acme Cycles Outlet" and "Acme Cycles Works" name the project too.
      { domain: 'rival.example', alias: 'Acmecycles Outlet', reason: 'project-brand', conflictingName: 'Acme Cycles' },
      { domain: 'rival.example', alias: 'Acme Cyclesworks', reason: 'project-brand', conflictingName: 'Acme Cycles' },
    ])
    // `acmecycleworks` neither contains `acmecycles` nor sits inside a project
    // key, so no spelling of it names the project.
    expect(plan.competitors).toEqual([{ domain: 'rival.example', aliases: ['Acme Cycle Works'] }])
    expectNoDoubleCount(plan, project)
  })

  it('rejects an alias that contains one of the project\'s own names, joined words included', () => {
    const plan = planCompetitorAliases([
      { domain: 'qvx.example', aliases: ['Rotorwise Rivals', 'Rotorwiser', 'Rotor', 'Rotor Wire'], explicit: true },
    ], PROJECT_BRAND)
    expect(plan.rejected).toEqual([
      { domain: 'qvx.example', alias: 'Rotorwise Rivals', reason: 'project-brand', conflictingName: 'Rotorwise' },
      // A joined-word lookalike no answer would split, rejected deliberately:
      // containment is the only rule that holds for every spelling.
      { domain: 'qvx.example', alias: 'Rotorwiser', reason: 'project-brand', conflictingName: 'Rotorwise' },
      // "Rotor Wise" is a spelling of the project's one-word name.
      { domain: 'qvx.example', alias: 'Rotor', reason: 'project-brand', conflictingName: 'Rotorwise' },
    ])
    expect(textContainsAnyBrandAlias('Ask Rotor Wise first.', PROJECT_BRAND.brandNames)).toBe(true)
    expect(plan.competitors).toEqual([{ domain: 'qvx.example', aliases: ['Rotor Wire'] }])
    expectNoDoubleCount(plan, PROJECT_BRAND)
  })

  it('checks a project name shorter than the alias floor as complete words only', () => {
    // Containment of two letters would refuse nearly every alias; the readers
    // match such a name as complete words, so that is what is checked.
    const project = competitorAliasProjectIdentity({ displayName: 'AI', canonicalDomain: 'qai.example' })
    const plan = planCompetitorAliases([{ domain: 'rival.example', aliases: ['Mail Pros', 'Rival AI'], explicit: true }], project)
    expect(plan.rejected).toEqual([{ domain: 'rival.example', alias: 'Rival AI', reason: 'project-brand', conflictingName: 'AI' }])
    expect(plan.competitors).toEqual([{ domain: 'rival.example', aliases: ['Mail Pros'] }])
  })

  it('rejects a part of a one-word project name, which an answer may split', () => {
    // The project writes itself as one word; answers write "Acme Cycles".
    const project = competitorAliasProjectIdentity({ displayName: 'AcmeCycles', canonicalDomain: 'acmecycles.example' })
    expect(textContainsAnyBrandAlias('Acme Cycles has the best fit.', project.brandNames)).toBe(true)
    const plan = planCompetitorAliases([{ domain: 'rival.example', aliases: ['Acme', 'Cycles', 'Rival Wheels'], explicit: true }], project)
    expect(plan.rejected).toEqual([
      { domain: 'rival.example', alias: 'Acme', reason: 'project-brand', conflictingName: 'AcmeCycles' },
      { domain: 'rival.example', alias: 'Cycles', reason: 'project-brand', conflictingName: 'AcmeCycles' },
    ])
    expect(plan.competitors).toEqual([{ domain: 'rival.example', aliases: ['Rival Wheels'] }])
    expectNoDoubleCount(plan, project)
  })

  it('drops a carried-over alias the project identity now contains', () => {
    const plan = planCompetitorAliases(
      [{ domain: 'rival.example', aliases: ['Acme', 'Rival Wheels'], explicit: false }],
      competitorAliasProjectIdentity({ displayName: 'Acme Cycles', canonicalDomain: 'acmecycles.example' }),
    )
    expect(plan.rejected).toEqual([])
    expect(plan.dropped).toEqual([{ domain: 'rival.example', alias: 'Acme', reason: 'project-brand', conflictingName: 'Acme Cycles' }])
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

  // The readers count a competitor when any of its identity tokens (curated
  // aliases, gated domain label, written host) matches the answer as complete
  // adjacent words, under any word split. Two competitors whose tokens' keys
  // contain one another both count for one answer, so the write rule rejects
  // that containment.
  it('rejects an explicit alias found inside another competitor\'s alias, or containing it', () => {
    const answer = 'For wheel truing, Tune Spoke is the shop most riders pick.'
    expect(textContainsAnyBrandAlias(answer, competitorBrandAliases({ domain: 'qvx.example', aliases: ['Tune'] }))).toBe(true)
    expect(textContainsAnyBrandAlias(answer, competitorBrandAliases({ domain: 'wheelwright.example', aliases: ['Tune Spoke'] }))).toBe(true)

    const inside = planCompetitorAliases([
      { domain: 'wheelwright.example', aliases: ['Tune Spoke'], explicit: false },
      { domain: 'qvx.example', aliases: ['Tune'], explicit: true },
    ], PROJECT_BRAND)
    expect(inside.rejected).toEqual([
      { domain: 'qvx.example', alias: 'Tune', reason: 'other-competitor', conflictsWith: 'wheelwright.example', conflictingName: 'Tune Spoke' },
    ])

    const contains = planCompetitorAliases([
      { domain: 'qvx.example', aliases: ['Tune'], explicit: false },
      { domain: 'wheelwright.example', aliases: ['Tune Spoke', 'Wheel Wrights Crew'], explicit: true },
    ], PROJECT_BRAND)
    expect(contains.rejected).toEqual([
      { domain: 'wheelwright.example', alias: 'Tune Spoke', reason: 'other-competitor', conflictsWith: 'qvx.example', conflictingName: 'Tune' },
    ])
    // The stored list the write collides with is never stripped.
    expect(contains.competitors).toEqual([
      { domain: 'qvx.example', aliases: ['Tune'] },
      { domain: 'wheelwright.example', aliases: ['Wheel Wrights Crew'] },
    ])
    expect(contains.dropped).toEqual([])
    expectNoDoubleCount(contains, PROJECT_BRAND)
  })

  // Reported: "Tune" was accepted next to the one-word "TuneSpoke" or a
  // domain label `tunespoke`, yet an answer writing "Tune Spoke" counted both.
  it('rejects an alias whose key sits inside a one-word name, however that name is stored', () => {
    const answer = 'For truing, Tune Spoke is the shop most riders pick.'
    for (const [owner, stored] of [
      ['wheelwright.example', ['TuneSpoke']],
      ['wheelwright.example', ['Tunespoke']],
      ['tunespoke.example', []],
      ['spoketuneworks.example', []],
    ] as const) {
      const ownerTokens = competitorBrandAliases({ domain: owner, aliases: stored })
      // The readers count the stored name in some spelling that also writes
      // "Tune" as a word.
      expect(spellings(ownerTokens.find(token => brandKeyFromText(token).includes('tune'))!).some(spelling =>
        textContainsAnyBrandAlias(spelling, ownerTokens) && textContainsAnyBrandAlias(spelling, ['Tune']))).toBe(true)
      for (const entries of permutations<CompetitorAliasPlanEntry>([
        { domain: owner, aliases: stored, explicit: false },
        { domain: 'qvx.example', aliases: ['Tune'], explicit: true },
      ])) {
        const plan = planCompetitorAliases(entries, NO_PROJECT)
        expect(plan.rejected, `${owner} ${stored.join()}`).toEqual([
          expect.objectContaining({ domain: 'qvx.example', alias: 'Tune', reason: 'other-competitor', conflictsWith: owner }),
        ])
      }
    }
    expect(textContainsAnyBrandAlias(answer, competitorBrandAliases({ domain: 'tunespoke.example' }))).toBe(true)
    // The stored one-word alias written after "Tune" is rejected the same way.
    const later = planCompetitorAliases([
      { domain: 'qvx.example', aliases: ['Tune'], explicit: false },
      { domain: 'wheelwright.example', aliases: ['TuneSpoke'], explicit: true },
    ], NO_PROJECT)
    expect(later.rejected).toEqual([
      { domain: 'wheelwright.example', alias: 'TuneSpoke', reason: 'other-competitor', conflictsWith: 'qvx.example', conflictingName: 'Tune' },
    ])
  })

  it('blocks adding a domain whose label contains another competitor\'s stored alias', () => {
    const plan = planCompetitorAliases([
      { domain: 'qvx.example', aliases: ['Tune'], explicit: false },
      { domain: 'tunespoke.example', aliases: [], explicit: false, added: true },
    ], NO_PROJECT)
    expect(plan.rejected).toEqual([
      { domain: 'tunespoke.example', alias: 'Tune', reason: 'claimed-by-alias', conflictsWith: 'qvx.example', conflictingName: 'tunespoke' },
    ])
    expect(plan.dropped).toEqual([])
  })

  it('blocks an add the same way in every order, even when stored lists already overlap', () => {
    // Stored lists that overlap each other (written by an older build) and a
    // new domain that overlaps both: the add fails whichever conflict is
    // found first, and no curated alias is stripped.
    const entries: CompetitorAliasPlanEntry[] = [
      { domain: 'wheelwright.example', aliases: ['Tune Spoke'], explicit: false },
      { domain: 'qvx.example', aliases: ['Tune'], explicit: false },
      { domain: 'tune.example', aliases: [], explicit: false, added: true },
    ]
    for (const order of permutations(entries)) {
      const plan = planCompetitorAliases(order, NO_PROJECT)
      expect([...plan.rejected].sort((a, b) => a.alias.localeCompare(b.alias)), order.map(entry => entry.domain).join()).toEqual([
        { domain: 'tune.example', alias: 'Tune', reason: 'claimed-by-alias', conflictsWith: 'qvx.example' },
        { domain: 'tune.example', alias: 'Tune Spoke', reason: 'claimed-by-alias', conflictsWith: 'wheelwright.example', conflictingName: 'tune' },
      ])
      expect(plan.dropped).toEqual([])
      expect(plan.competitors.find(c => c.domain === 'wheelwright.example')!.aliases).toEqual(['Tune Spoke'])
      expect(plan.competitors.find(c => c.domain === 'qvx.example')!.aliases).toEqual(['Tune'])
    }
  })

  it('checks another competitor\'s domain label and written host with the same matcher', () => {
    const plan = planCompetitorAliases([
      { domain: 'spoketuneworks.example', aliases: [], explicit: false },
      { domain: 'qvx.example', aliases: ['Spoke Tune Works Outlet', 'Example', 'Spoketuneworker', 'Tuner'], explicit: true },
    ], NO_PROJECT)
    expect(plan.rejected).toEqual([
      // Contains the label `spoketuneworks`.
      { domain: 'qvx.example', alias: 'Spoke Tune Works Outlet', reason: 'other-competitor', conflictsWith: 'spoketuneworks.example', conflictingName: 'spoketuneworks' },
      // Inside the written host `spoketuneworks.example`.
      { domain: 'qvx.example', alias: 'Example', reason: 'other-competitor', conflictsWith: 'spoketuneworks.example', conflictingName: 'spoketuneworks.example' },
    ])
    // Neither key contains the other: `spoketuneworker` is not
    // `spoketuneworks`, and `tuner` is not inside `spoketuneworks`.
    expect(plan.competitors[1]).toEqual({ domain: 'qvx.example', aliases: ['Spoketuneworker', 'Tuner'] })
  })

  it('blocks a new competitor whose domain name is found inside another competitor\'s stored alias', () => {
    const plan = planCompetitorAliases([
      { domain: 'wheelwright.example', aliases: ['Tune Spoke'], explicit: false },
      { domain: 'tune.example', aliases: [], explicit: false, added: true },
    ], PROJECT_BRAND)
    expect(plan.rejected).toEqual([
      { domain: 'tune.example', alias: 'Tune Spoke', reason: 'claimed-by-alias', conflictsWith: 'wheelwright.example', conflictingName: 'tune' },
    ])
    expect(plan.dropped).toEqual([])
    expect(plan.competitors[0]).toEqual({ domain: 'wheelwright.example', aliases: ['Tune Spoke'] })
  })

  it('drops both carried-over aliases when stored lists already overlap', () => {
    const plan = planCompetitorAliases([
      { domain: 'qvx.example', aliases: ['Tune', 'QVX'], explicit: false },
      { domain: 'wheelwright.example', aliases: ['Tune Spoke'], explicit: false },
    ], PROJECT_BRAND)
    expect(plan.rejected).toEqual([])
    expect(plan.dropped).toEqual([
      { domain: 'qvx.example', alias: 'Tune', reason: 'other-competitor', conflictsWith: 'wheelwright.example', conflictingName: 'Tune Spoke' },
      { domain: 'wheelwright.example', alias: 'Tune Spoke', reason: 'other-competitor', conflictsWith: 'qvx.example', conflictingName: 'Tune' },
    ])
    expect(plan.competitors).toEqual([
      { domain: 'qvx.example', aliases: ['QVX'] },
      { domain: 'wheelwright.example', aliases: [] },
    ])
  })

  it('treats two spellings of one stored competitor as the same competitor', () => {
    // A legacy row stored as a subdomain and its registrable form share the
    // label `spoketuneworks`; that is one competitor, not a collision.
    const plan = planCompetitorAliases([
      { domain: 'spoketuneworks.example', aliases: ['Spoke Tune Works'], explicit: false },
      { domain: 'offers.spoketuneworks.example', aliases: [], explicit: false },
    ], NO_PROJECT)
    expect(plan.dropped).toEqual([])
    expect(plan.competitors[0]).toEqual({ domain: 'spoketuneworks.example', aliases: ['Spoke Tune Works'] })
  })

  it('leaves no accepted alias that any spelling would credit to two competitors or the project', () => {
    const plan = planCompetitorAliases([
      { domain: 'spoketuneworks.example', aliases: ['Spoke Tune Pros', 'TuneSpoke Crew', 'STW Wheels'], explicit: true },
      { domain: 'qvx.example', aliases: ['QVX', 'Tune', 'QVX Linen', 'Spoke'], explicit: true },
      { domain: 'ravenwoodbikeinc.example', aliases: ['Ravenwood Cycling', 'Raven Wheels', 'Tuner', 'Rotor Bikes'], explicit: true },
      { domain: 'wheelwright.example', aliases: ['TuneSpoke', 'Wright Wheels'], explicit: true },
    ], PROJECT_BRAND)
    expect(plan.rejected.map(rejection => `${rejection.domain} ${rejection.alias}`).sort()).toEqual([
      'qvx.example Spoke',
      'qvx.example Tune',
      'ravenwoodbikeinc.example Tuner',
      'spoketuneworks.example Spoke Tune Pros',
      'spoketuneworks.example TuneSpoke Crew',
      'wheelwright.example TuneSpoke',
    ])
    expect(plan.competitors).toEqual([
      { domain: 'spoketuneworks.example', aliases: ['STW Wheels'] },
      { domain: 'qvx.example', aliases: ['QVX', 'QVX Linen'] },
      { domain: 'ravenwoodbikeinc.example', aliases: ['Ravenwood Cycling', 'Raven Wheels', 'Rotor Bikes'] },
      { domain: 'wheelwright.example', aliases: ['Wright Wheels'] },
    ])
    expectNoDoubleCount(plan, PROJECT_BRAND)
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

  it('names the alias, the overlapping name and the other competitor', () => {
    expect(() => requireCompetitorAliasPlan([
      { domain: 'qvx.example', aliases: ['Tune'], explicit: false },
      { domain: 'wheelwright.example', aliases: ['Tune Spoke'], explicit: true },
    ], PROJECT_BRAND)).toThrow(
      'Invalid competitor aliases: wheelwright.example: "Tune Spoke" contains "Tune", a name of qvx.example, so one answer would count both competitors',
    )
    expect(() => requireCompetitorAliasPlan([
      { domain: 'wheelwright.example', aliases: ['TuneSpoke'], explicit: false },
      { domain: 'qvx.example', aliases: ['Tune'], explicit: true },
    ], PROJECT_BRAND)).toThrow(
      'Invalid competitor aliases: qvx.example: "Tune" is found inside "TuneSpoke", a name of wheelwright.example, so one answer would count both competitors',
    )
    expect(() => requireCompetitorAliasPlan([
      { domain: 'wheelwright.example', aliases: ['Tune Spoke'], explicit: false },
      { domain: 'tune.example', aliases: [], explicit: false, added: true },
    ], PROJECT_BRAND)).toThrow(
      'Invalid competitor aliases: tune.example: cannot be added while "Tune Spoke" is a curated alias of wheelwright.example (it contains "tune", a name of tune.example, so one answer would count both competitors); remove or restate that alias first',
    )
    expect(() => requireCompetitorAliasPlan([
      { domain: 'qvx.example', aliases: ['Rotorwise Rivals', 'Rotor'], explicit: true },
    ], PROJECT_BRAND)).toThrow(
      'Invalid competitor aliases: qvx.example: "Rotorwise Rivals" contains "Rotorwise", one of the project\'s own names, so one answer would count both the project and qvx.example; '
      + 'qvx.example: "Rotor" is found inside "Rotorwise", one of the project\'s own names, so one answer would count both the project and qvx.example',
    )
  })

  it('returns the plan when every explicit alias passes', () => {
    expect(requireCompetitorAliasPlan([{ domain: 'qvx.example', aliases: ['QVX'], explicit: true }], PROJECT_BRAND).competitors)
      .toEqual([{ domain: 'qvx.example', aliases: ['QVX'] }])
  })
})

describe('competitorDomainProjectClaim', () => {
  it('names the project domain a competitor domain is, sits under, or sits above', () => {
    const domains = ['rotorwise.example', 'rotorwise.pagehost.example']
    expect(competitorDomainProjectClaim('rotorwise.example', domains)).toBe('rotorwise.example')
    expect(competitorDomainProjectClaim('blog.rotorwise.example', domains)).toBe('rotorwise.example')
    expect(competitorDomainProjectClaim('www.Rotorwise.example', domains)).toBe('rotorwise.example')
    expect(competitorDomainProjectClaim('pagehost.example', domains)).toBe('rotorwise.pagehost.example')
    expect(competitorDomainProjectClaim('rivalbikes.pagehost.example', domains)).toBeNull()
    expect(competitorDomainProjectClaim('rotorwiser.example', domains)).toBeNull()
    expect(competitorDomainProjectClaim('qvx.example', [])).toBeNull()
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
