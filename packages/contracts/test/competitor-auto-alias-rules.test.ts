import { describe, expect, it } from 'vitest'
import {
  brandKeyFromText,
  COMPETITOR_ALIAS_LIMIT,
  competitorAliasProjectIdentity,
  createAutoAliasAccumulator,
  hasDomainLabelAffinity,
  isAutoAliasNameShaped,
  planCompetitorAutoAliases,
  resolveCompetitorAutoAliases,
  type AnchoredAnswerSpan,
  type AutoAliasAnswerInput,
  type AutoAliasCompetitorInput,
  type AutoAliasScores,
  type CompetitorAutoAlias,
  type CompetitorAutoAliasState,
} from '../src/index.js'

// The detection rules that keep places, neighbouring businesses, truncations
// of a competitor's own name and other identities out of its learned names.
// Every input is a fictional stored answer.

const PROJECT = competitorAliasProjectIdentity({ displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example' })
const NO_PROJECT = { brandNames: [], domains: [] }
const NOW = '2026-10-08T00:00:00.000Z'

let sequence = 0
function answer(runId: string, text: string, citedDomains: string[] = [], anchors: AnchoredAnswerSpan[] = []): AutoAliasAnswerInput {
  sequence++
  return {
    snapshotId: `snap-${sequence}`,
    runId,
    createdAt: `2026-09-${String(10 + (sequence % 20)).padStart(2, '0')}T00:00:00.000Z`,
    answerText: text,
    citedDomains,
    anchors,
  }
}

function windowAnchor(text: string, domain: string): AnchoredAnswerSpan {
  return { text, source: `https://${domain}/stay`, kind: 'window', via: 'openai-annotation' }
}

/** A list item a provider citation pairs with `domain`, citing it. */
function paired(runId: string, name: string, domain: string): AutoAliasAnswerInput {
  const line = `- **${name}** - recommended by riders.`
  return answer(runId, `Shops to try:\n${line}\n`, [domain], [windowAnchor(line, domain)])
}

/** Answers that name nothing and cite no tracked competitor: the contrast every lift needs. */
function background(count: number): AutoAliasAnswerInput[] {
  return Array.from({ length: count }, (_, index) => answer(`run-bg-${index % 3}`, 'Check your tire pressure before every ride.', ['ridersguide.example']))
}

function score(
  answers: readonly AutoAliasAnswerInput[],
  competitors: readonly AutoAliasCompetitorInput[],
  storedNames: { domain: string; name: string }[] = [],
): AutoAliasScores {
  const accumulator = createAutoAliasAccumulator({ competitors, project: PROJECT })
  for (const item of answers) accumulator.add(item)
  return accumulator.finish({ storedNames })
}

function evidence(scores: AutoAliasScores, domain: string, name: string) {
  return scores.byCompetitor.get(domain)?.get(brandKeyFromText(name))
}

function states(domains: readonly string[], overrides: Record<string, Partial<CompetitorAutoAliasState>> = {}): CompetitorAutoAliasState[] {
  return domains.map(domain => ({ domain, aliases: [], autoAliases: [], blockedAliases: [], ...overrides[domain] }))
}

function stored(name: string): CompetitorAutoAlias {
  return {
    name,
    directPairs: 4,
    cooccurrences: 2,
    namingAnswers: 5,
    precision: 0.8,
    lift: 12,
    nameCasedAnswers: 5,
    runs: 3,
    firstSeen: '2026-08-01T00:00:00.000Z',
    lastSeen: '2026-08-20T00:00:00.000Z',
    addedAt: '2026-08-21T00:00:00.000Z',
  }
}

const statusOf = (resolution: { candidates: { name: string; status: string; reason?: string; conflictsWith?: string }[] }, name: string) => {
  const candidate = resolution.candidates.find(item => item.name === name)
  return candidate ? [candidate.status, candidate.reason, candidate.conflictsWith] : undefined
}

describe('hasDomainLabelAffinity: one shared word is not enough', () => {
  const labels = [
    'roofmaxaustin', 'hillcountryroofs', 'doctorspokes', 'velolarkfield', 'vexc', 'roofr', 'nest',
    'galeshieldrc', 'owlhavencycle', 'thehotelwren', 'myspokeiq', 'larkbaysuites', 'rotorwise',
    'detroitroofing', 'austinroofs', 'austinroofingandsiding', 'spoketuneworks', 'acmecycles', 'editionhotels',
  ]
  it.each([
    ['Austin', 'roofmaxaustin.example', false, 'a place the label ends with'],
    ['Rim Doctor', 'doctorspokes.example', false, 'a neighbouring business sharing the one word the label opens with'],
    ['Larkfield', 'velolarkfield.example', false, 'a one-word name inside the label that does not open it'],
    ['Detroit', 'detroitroofing.example', false, 'a one-word place that opens the label and covers half of it'],
    ['Austin', 'austinroofs.example', false, 'a one-word place that opens the label and covers most of it'],
    ['Austin', 'austinroofingandsiding.example', false, 'a one-word place whose letters open the label'],
    ['Acme', 'acmecycles.example', false, 'a one-word name shorter than the label: listed for review'],
    ['EDITION', 'editionhotels.example', false, 'a one-word name shorter than the label: listed for review'],
    ['Austin Roof Pros', 'roofmaxaustin.example', false, 'a neighbour sharing the opener and a place further on, not back to back'],
    ['Gale Shield', 'galeshieldrc.example', true, 'two words open the label back to back'],
    ['Owl Haven', 'owlhavencycle.example', true, 'two words open the label back to back'],
    ['TuneSpoke', 'spoketuneworks.example', true, 'its words open the label back to back, in another order'],
    ['Hotel Wren', 'thehotelwren.example', true, 'two words open the label after a marketing lead word'],
    ['VEX City Gate', 'vexc.example', false, 'the label spans a word boundary into a partial word'],
    ['Roof Rescue', 'roofr.example', false, 'the label spans a word boundary into a partial word'],
    ['Honest Spokes', 'nest.example', false, 'the label sits inside a word'],
    ['Gale Shield Roofing', 'galeshieldrc.example', true, 'two of its words open the label and cover most of it'],
    ['Owl Haven Cycling', 'owlhavencycle.example', true, 'two of its words open the label, though its last word only starts the rest'],
    ['Hotel Wren West LA', 'thehotelwren.example', true, 'two of its words open the label after a marketing lead word'],
    ['SpokeIQ', 'myspokeiq.example', true, 'the whole name opens the label after a marketing lead word'],
    ['Lark Bay', 'larkbaysuites.example', true, 'the whole name opens the label and covers half of it'],
  ])('%s for %s is %s: %s', (name, domain, expected) => {
    expect(hasDomainLabelAffinity(name, domain, labels)).toBe(expected)
  })

  it('needs one of the words to be distinctive, not an industry word two tracked labels share', () => {
    expect(hasDomainLabelAffinity('Gale Shield Pros', 'galeshieldrc.example', ['galeshieldrc'])).toBe(true)
    expect(hasDomainLabelAffinity('Gale Shield Pros', 'galeshieldrc.example', ['galeshieldrc', 'galeshieldroofing'])).toBe(false)
  })
})

describe('a place or a neighbour that passes every scoring rule', () => {
  // Local competitors are cited only in their own market's answers, so a
  // city that market's answers keep writing rises with the site.
  it('is listed for review, never applied: a one-word city the label opens with', () => {
    const competitors = ['detroitroofing.example', 'hillcountryroofs.example', 'capitolgutters.example'].map(domain => ({ domain }))
    const answers = [
      ...['run-1', 'run-2'].map(run => answer(run, 'Detroit Roofing Co is a crew based in Detroit (detroitroofing.example).', ['detroitroofing.example'])),
      ...Array.from({ length: 40 }, (_, index) => answer(`run-${index % 3 + 1}`, 'Roofers in Detroit book up after storms.', [index % 4 === 0 ? 'detroitroofing.example' : 'roofnews.example'])),
      ...Array.from({ length: 200 }, (_, index) => answer(`run-${index % 3 + 1}`, 'Roofers in Larkfield book up after storms.', ['roofnews.example'])),
    ]
    const scores = score(answers, competitors)
    // 42 answers write "Detroit"; the 2 pairing ones and 10 of the 40 cite the site.
    expect(evidence(scores, 'detroitroofing.example', 'Detroit')).toMatchObject({
      directPairs: 2, runs: 2, namingAnswers: 42, citingAnswers: 12, via: ['answer-host'], labelAffinity: false, rejection: null,
    })
    const [result] = resolveCompetitorAutoAliases(scores, states(competitors.map(item => item.domain)), PROJECT, NOW)
    expect(result!.added).toEqual([])
    expect(statusOf(result!, 'Detroit')).toEqual(['review', 'no-label-affinity', undefined])
  })

  it('is listed for review, never applied: a neighbour sharing the opener and a place further on in the label', () => {
    const competitors = ['roofmaxaustin.example', 'hillcountryroofs.example', 'capitolgutters.example'].map(domain => ({ domain }))
    const answers = [
      ...['run-1', 'run-2'].map(run => paired(run, 'Austin Roof Pros', 'roofmaxaustin.example')),
      ...Array.from({ length: 10 }, (_, index) => answer(`run-${index % 3 + 1}`, 'Call Austin Roof Pros after hail.', [index % 3 === 0 ? 'roofmaxaustin.example' : 'roofnews.example'])),
      ...background(100),
    ]
    const scores = score(answers, competitors)
    expect(evidence(scores, 'roofmaxaustin.example', 'Austin Roof Pros')).toMatchObject({ directPairs: 2, runs: 2, labelAffinity: false, rejection: null })
    const [result] = resolveCompetitorAutoAliases(scores, states(competitors.map(item => item.domain)), PROJECT, NOW)
    expect(result!.added).toEqual([])
    expect(statusOf(result!, 'Austin Roof Pros')).toEqual(['review', 'no-label-affinity', undefined])
  })
})

describe('isAutoAliasNameShaped: place shapes', () => {
  it.each([
    ['Larkfield, CO', false],
    ['Larkfield, CO.', false],
    ['Larkfield, Colorado', false],
    ['Oakvale County', false],
    ['Oakvale County, Michigan', false],
    ['Metro Larkfield', false],
    ['Greater Larkfield', false],
    ['Downtown Larkfield', false],
    ['West LA', false],
    ['Larkfield Area', false],
    ['Erie, PA', false],
    ['Washington, DC', false],
    // Lossy on purpose: a two-word business reads like "Metro Larkfield".
    ['Metro Diner', false],
    ['Metro Roofing Supply', true],
    ['Greater Good Roofing', true],
    ['Greater Goods Coffee', true],
    ['Smith & Jones, PA', true],
    ['Jane Lee, MD', true],
    ['Back in Line, DC', true],
    ['Spoke Labs, Inc.', true],
    ['Spoke Labs, Co', true],
    ['West Elm Spokes', true],
    ['North Shore Cycles', true],
    ['Westward Spokes', true],
  ])('%s -> %s', (name, shaped) => {
    expect(isAutoAliasNameShaped(name)).toBe(shaped)
  })
})

describe('a truncation of the competitor\'s own name', () => {
  // "Lark Bay" opens larkbaysuites.example, so it has label affinity. Every
  // answer that writes the brand "Lark Bay Suites" also writes "Lark Bay"
  // as words; only the answers that write "Lark Bay" on its own say what the
  // shorter name means: here, a boardwalk the hotel's neighbours share.
  const competitors = [{ domain: 'larkbaysuites.example' }]
  const line = '- **Lark Bay:** Lark Bay Suites is steps from the sand.'
  const answers = [
    ...['run-1', 'run-2'].map(run => answer(run, `Stays near the boardwalk:\n${line}\n`, ['larkbaysuites.example'], [windowAnchor(line, 'larkbaysuites.example')])),
    ...Array.from({ length: 20 }, (_, index) => answer(`run-${index % 3 + 1}`, 'Book Lark Bay Suites for the boardwalk.', ['larkbaysuites.example'])),
    ...Array.from({ length: 10 }, (_, index) => answer(`run-${index % 3 + 1}`, 'Walk the Lark Bay boardwalk, then stay at Abbot Inn.', [])),
    ...background(30),
  ]

  it('is measured only by the answers that write it outside a longer name of the competitor', () => {
    // 62 answers, 22 cite the site. 12 write "Lark Bay" on its own and 2 of
    // those cite the site: lift (2/12) / ((22 - 2 + 1) / (62 - 12 + 2)) = 0.41.
    expect(evidence(score(answers, competitors), 'larkbaysuites.example', 'Lark Bay')).toMatchObject({
      directPairs: 2,
      runs: 2,
      namingAnswers: 12,
      citingAnswers: 2,
      nameCasedAnswers: 12,
      precision: 0.16666667,
      lift: 0.41,
      labelAffinity: true,
      rejection: 'low-lift',
    })
  })

  it('is never applied, and a stored one is removed', () => {
    const [fresh] = resolveCompetitorAutoAliases(score(answers, competitors), states(['larkbaysuites.example']), PROJECT, NOW)
    expect(fresh!.added).toEqual([])
    const [kept] = resolveCompetitorAutoAliases(
      score(answers, competitors, [{ domain: 'larkbaysuites.example', name: 'Lark Bay' }]),
      states(['larkbaysuites.example'], { 'larkbaysuites.example': { autoAliases: [stored('Lark Bay')] } }),
      PROJECT,
      NOW,
    )
    expect(kept!.removed).toEqual([{ name: 'Lark Bay', reason: 'low-lift' }])
  })

  it('reads name casing from the occurrences written on their own', () => {
    // Each of these writes the brand capitalized and the shorter name in
    // lowercase: the brand's capitals say nothing about the shorter name.
    const mixed = [
      ...answers,
      ...Array.from({ length: 4 }, (_, index) => answer(`run-${index % 3 + 1}`, 'Walk the lark bay boardwalk past Lark Bay Suites.', [])),
    ]
    expect(evidence(score(mixed, competitors), 'larkbaysuites.example', 'Lark Bay')).toMatchObject({ namingAnswers: 16, nameCasedAnswers: 12 })
  })

  it('also masks a curated alias that contains it', () => {
    // A curated "Lark Bay Inn" covers "Lark Bay" for larkbay.example, whose
    // label ("larkbay") equals the name and so masks nothing.
    const curated = [{ domain: 'larkbay.example', aliases: ['Lark Bay Inn'] }]
    const inn = [
      ...['run-1', 'run-2'].map(run => paired(run, 'Lark Bay', 'larkbay.example')),
      ...Array.from({ length: 6 }, (_, index) => answer(`run-${index % 3 + 1}`, 'Book Lark Bay Inn for the boardwalk.', ['larkbay.example'])),
      ...background(10),
    ]
    expect(evidence(score(inn, curated), 'larkbay.example', 'Lark Bay')).toMatchObject({ namingAnswers: 2, citingAnswers: 2 })
    expect(evidence(score(inn, [{ domain: 'larkbay.example' }]), 'larkbay.example', 'Lark Bay')).toMatchObject({ namingAnswers: 8, citingAnswers: 8 })
  })
})

describe('a stored name the answers now give to another competitor, or that lost label affinity', () => {
  it('is removed when another tracked competitor now holds at least twice its pairs', () => {
    const competitors = [{ domain: 'spoketuneworks.example' }, { domain: 'tsworks.example' }]
    const answers = [
      ...['run-1', 'run-2'].map(run => paired(run, 'Tune Spoke Works', 'spoketuneworks.example')),
      ...['run-1', 'run-2', 'run-3', 'run-1', 'run-2', 'run-3'].map(run => paired(run, 'Tune Spoke Works', 'tsworks.example')),
      ...background(10),
    ]
    const scores = score(answers, competitors, [{ domain: 'spoketuneworks.example', name: 'Tune Spoke Works' }])
    expect(evidence(scores, 'spoketuneworks.example', 'Tune Spoke Works')).toMatchObject({ directPairs: 2, otherCompetitorPairs: 6, labelAffinity: true })
    const [owner] = resolveCompetitorAutoAliases(
      scores,
      states(['spoketuneworks.example', 'tsworks.example'], { 'spoketuneworks.example': { autoAliases: [stored('Tune Spoke Works')] } }),
      PROJECT,
      NOW,
    )
    expect(owner!).toMatchObject({ autoAliases: [], namesChanged: true })
    expect(owner!.removed).toEqual([{ name: 'Tune Spoke Works', reason: 'other-competitor-dominates' }])
  })

  it('is judged on its stored spelling, not on how the window\'s answers most often write it', () => {
    // "Tunespoke" reads as one word, so it opens no label back to back; the
    // stored "TuneSpoke" is two words that do.
    const competitors = [{ domain: 'spoketuneworks.example' }]
    const answers = [
      ...['run-1', 'run-2', 'run-3', 'run-1', 'run-2', 'run-3'].map(run => paired(run, 'Tunespoke', 'spoketuneworks.example')),
      paired('run-1', 'TuneSpoke', 'spoketuneworks.example'),
      ...background(30),
    ]
    const scores = score(answers, competitors, [{ domain: 'spoketuneworks.example', name: 'TuneSpoke' }])
    expect(evidence(scores, 'spoketuneworks.example', 'TuneSpoke')).toMatchObject({ name: 'Tunespoke', directPairs: 7, labelAffinity: true })
    const [result] = resolveCompetitorAutoAliases(scores, states(['spoketuneworks.example'], { 'spoketuneworks.example': { autoAliases: [stored('TuneSpoke')] } }), PROJECT, NOW)
    expect(result!).toMatchObject({ added: [], removed: [], namesChanged: false })
    expect(result!.autoAliases.map(record => record.name)).toEqual(['TuneSpoke'])
  })

  it('is removed when a newly tracked label shares its words', () => {
    const answers = [...['run-1', 'run-2', 'run-3'].map(run => paired(run, 'Gale Shield Pros', 'galeshieldrc.example')), ...background(20)]
    const storedState = states(['galeshieldrc.example', 'galeshieldroofing.example'], { 'galeshieldrc.example': { autoAliases: [stored('Gale Shield Pros')] } })
    const alone = score(answers, [{ domain: 'galeshieldrc.example' }], [{ domain: 'galeshieldrc.example', name: 'Gale Shield Pros' }])
    expect(evidence(alone, 'galeshieldrc.example', 'Gale Shield Pros')).toMatchObject({ labelAffinity: true })
    const both = score(answers, [{ domain: 'galeshieldrc.example' }, { domain: 'galeshieldroofing.example' }], [{ domain: 'galeshieldrc.example', name: 'Gale Shield Pros' }])
    const [result] = resolveCompetitorAutoAliases(both, storedState, PROJECT, NOW)
    expect(result!.removed).toEqual([{ name: 'Gale Shield Pros', reason: 'no-label-affinity' }])
  })

  it('is removed when it no longer has label affinity', () => {
    const competitors = [{ domain: 'doctorspokes.example' }]
    const answers = [...['run-1', 'run-2', 'run-3'].map(run => paired(run, 'Rim Doctor', 'doctorspokes.example')), ...background(10)]
    const scores = score(answers, competitors, [{ domain: 'doctorspokes.example', name: 'Rim Doctor' }])
    expect(evidence(scores, 'doctorspokes.example', 'Rim Doctor')).toMatchObject({ directPairs: 3, labelAffinity: false, rejection: null })
    const [result] = resolveCompetitorAutoAliases(scores, states(['doctorspokes.example'], { 'doctorspokes.example': { autoAliases: [stored('Rim Doctor')] } }), PROJECT, NOW)
    expect(result!.removed).toEqual([{ name: 'Rim Doctor', reason: 'no-label-affinity' }])
    expect(statusOf(result!, 'Rim Doctor')).toEqual(['removed', 'no-label-affinity', undefined])
  })
})

describe('the auto name cap', () => {
  it('keeps the strongest names, not the shortest', () => {
    // 12 names for qvx.example, each written with its 3-letter label as a
    // word: 10 paired in 3 answers, 2 shorter ones paired in only 2.
    const strong = ['Alderwood', 'Birchmont', 'Cedarbrook', 'Driftwood', 'Elmhurst', 'Fernhill', 'Glenmoor', 'Hollybrook', 'Ironwood', 'Juniper'].map(word => `QVX ${word}`)
    const weak = ['QVX Ab', 'QVX Cd']
    const competitors = [{ domain: 'qvx.example' }]
    const answers = [
      ...strong.flatMap(name => ['run-1', 'run-2', 'run-3'].map(run => paired(run, name, 'qvx.example'))),
      ...weak.flatMap(name => [paired('run-1', name, 'qvx.example'), paired('run-2', name, 'qvx.example'), answer('run-3', `Ask ${name} about parts.`, ['qvx.example'])]),
      ...background(300),
    ]
    const scores = score(answers, competitors)
    for (const name of [...strong, ...weak]) expect(evidence(scores, 'qvx.example', name)!.rejection).toBeNull()
    const [result] = resolveCompetitorAutoAliases(scores, states(['qvx.example']), PROJECT, NOW)
    expect(result!.added).toHaveLength(COMPETITOR_ALIAS_LIMIT)
    expect([...result!.added].sort()).toEqual([...strong].sort())
    expect(weak.map(name => statusOf(result!, name))).toEqual([['rejected', 'over-limit', undefined], ['rejected', 'over-limit', undefined]])
  })

  it('drops a stored name a newly accepted shorter name covers', () => {
    const plan = planCompetitorAutoAliases([
      { domain: 'spoketuneworks.example', aliases: [], autoAliases: ['Velo Hub Springfield', 'Gear Loft'], candidates: ['Velo Hub'] },
    ], NO_PROJECT)
    expect(plan.competitors).toEqual([{ domain: 'spoketuneworks.example', autoAliases: ['Velo Hub', 'Gear Loft'] }])
    expect(plan.dropped).toEqual([{ domain: 'spoketuneworks.example', alias: 'Velo Hub Springfield', reason: 'subsumed', stored: true }])
  })

  it('lets a shorter candidate cover a longer one whatever order the candidates come in', () => {
    const plan = planCompetitorAutoAliases([
      { domain: 'spoketuneworks.example', aliases: [], autoAliases: [], candidates: ['Velo Hub Springfield', 'Velo Hub'] },
    ], NO_PROJECT)
    expect(plan.competitors).toEqual([{ domain: 'spoketuneworks.example', autoAliases: ['Velo Hub'] }])
    expect(plan.dropped).toEqual([{ domain: 'spoketuneworks.example', alias: 'Velo Hub Springfield', reason: 'subsumed', stored: false }])
  })

  it('fills the cap in the order the candidates are given (strongest first)', () => {
    const candidates = Array.from({ length: COMPETITOR_ALIAS_LIMIT + 2 }, (_, i) => `${'Velo'.repeat(COMPETITOR_ALIAS_LIMIT + 2 - i)} ${String.fromCharCode(65 + i)}x`)
    const plan = planCompetitorAutoAliases([{ domain: 'spoketuneworks.example', aliases: [], autoAliases: [], candidates }], NO_PROJECT)
    expect(plan.competitors[0]!.autoAliases).toEqual(candidates.slice(0, COMPETITOR_ALIAS_LIMIT))
    expect(plan.dropped.map(drop => [drop.alias, drop.reason])).toEqual(candidates.slice(COMPETITOR_ALIAS_LIMIT).map(alias => [alias, 'over-limit']))
  })
})

describe('review suggestions', () => {
  // Names laid out next to spoketuneworks.example's citations that pass every
  // scoring rule but have no label affinity: the project's own brand,
  // another tracked competitor, a market pin of another domain, a place, and
  // a business the operator may verify.
  const competitors = [{ domain: 'spoketuneworks.example' }, { domain: 'rimdoctor.example' }]
  const names = ['Rotorwise', 'Rim Doctor', 'Gear Loft', 'Larkfield, CO', 'Chain Gang Cycles']
  const scores = score([
    ...names.flatMap(name => ['run-1', 'run-2', 'run-3'].map(run => paired(run, name, 'spoketuneworks.example'))),
    ...background(60),
  ], competitors)
  const pins = [{ domain: 'tunequotes.example', names: ['Gear Loft'], markets: ['north'] }]

  it('lists only names no other identity answers to', () => {
    const [result] = resolveCompetitorAutoAliases(scores, states(['spoketuneworks.example', 'rimdoctor.example']), PROJECT, NOW, pins)
    expect(result!.candidates.filter(candidate => candidate.status === 'review').map(candidate => candidate.name)).toEqual(['Chain Gang Cycles'])
    expect(names.map(name => statusOf(result!, name))).toEqual([
      ['rejected', 'project-brand', undefined],
      ['rejected', 'other-competitor', 'rimdoctor.example'],
      ['rejected', 'other-competitor', 'tunequotes.example'],
      ['rejected', 'name-shape', undefined],
      ['review', 'no-label-affinity', undefined],
    ])
  })
})

describe('the competitor\'s own Advanced plan pins', () => {
  it('count as its identity for a new name: one an active or draft pin covers spends no slot', () => {
    const entry = { domain: 'spoketuneworks.example', aliases: [], autoAliases: [], candidates: ['Velo Hub Downtown', 'Gear Loft'] }
    const own = [{ domain: 'www.spoketuneworks.example', names: ['Velo Hub'], markets: ['north'] }]
    const plan = planCompetitorAutoAliases([entry], NO_PROJECT, own)
    expect(plan.competitors).toEqual([{ domain: 'spoketuneworks.example', autoAliases: ['Gear Loft'] }])
    expect(plan.dropped).toEqual([{ domain: 'spoketuneworks.example', alias: 'Velo Hub Downtown', reason: 'already-matched', stored: false }])
  })

  it('never drop a stored name: project-frame reads do not count pin names', () => {
    // A draft pin of the tracked competitor in one market, by the very name
    // it is learned by: the write path re-plans stored names only.
    const draft = [{ domain: 'spoketuneworks.example', names: ['TuneSpoke'], markets: ['north'] }]
    const plan = planCompetitorAutoAliases([{ domain: 'spoketuneworks.example', aliases: [], autoAliases: ['TuneSpoke', 'Velo Hub Springfield'] }], PROJECT, [
      ...draft,
      { domain: 'spoketuneworks.example', names: ['Velo Hub'], markets: ['south'] },
    ])
    expect(plan).toMatchObject({ competitors: [{ domain: 'spoketuneworks.example', autoAliases: ['TuneSpoke', 'Velo Hub Springfield'] }], dropped: [] })

    // Detection keeps it too, with its evidence refreshed.
    const scores = score([
      ...['run-1', 'run-2', 'run-3'].map(run => paired(run, 'TuneSpoke', 'spoketuneworks.example')),
      ...background(20),
    ], [{ domain: 'spoketuneworks.example' }], [{ domain: 'spoketuneworks.example', name: 'TuneSpoke' }])
    const [result] = resolveCompetitorAutoAliases(scores, states(['spoketuneworks.example'], { 'spoketuneworks.example': { autoAliases: [stored('TuneSpoke')] } }), PROJECT, NOW, draft)
    expect(result!).toMatchObject({ added: [], removed: [], namesChanged: false })
    expect(result!.autoAliases.map(record => [record.name, record.directPairs])).toEqual([['TuneSpoke', 3]])
  })

  it('but not a superseded revision\'s pin, which names nothing in new answers', () => {
    const entry = { domain: 'spoketuneworks.example', aliases: [], autoAliases: ['Velo Hub Springfield'], candidates: ['Velo Hub Downtown'] }
    const superseded = [{ domain: 'spoketuneworks.example', names: ['Velo Hub'], markets: ['north'], supersededRevision: 2 }]
    expect(planCompetitorAutoAliases([entry], NO_PROJECT, superseded).competitors[0]!.autoAliases).toEqual(['Velo Hub Springfield', 'Velo Hub Downtown'])
  })
})
