import { describe, expect, it } from 'vitest'
import {
  AUTO_ALIAS_MIN_LIFT,
  AUTO_ALIAS_MIN_NAME_CASED_SHARE,
  AUTO_ALIAS_MIN_PRECISION,
  brandKeyFromText,
  competitorAliasProjectIdentity,
  createAutoAliasAccumulator,
  extractAnswerTextAnchors,
  hasDomainLabelAffinity,
  isAutoAliasNameShaped,
  resolveCompetitorAutoAliases,
  type AnchoredAnswerSpan,
  type AutoAliasAnswerInput,
  type AutoAliasScores,
  type CompetitorAutoAlias,
  type CompetitorAutoAliasState,
} from '../src/index.js'

// Answer-derived competitor names. Every input is a fictional stored answer:
// detection never reads a competitor's site.

const PROJECT = competitorAliasProjectIdentity({ displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example' })
const COMPETITORS = ['spoketuneworks.example', 'qvx.example', 'roofpro.example', 'rimdoctor.example'].map(domain => ({ domain }))
const NOW = '2026-10-06T00:00:00.000Z'

let sequence = 0
function answer(runId: string, text: string, citedDomains: string[] = [], anchors: AnchoredAnswerSpan[] = [], sweepKey?: string): AutoAliasAnswerInput {
  sequence++
  return {
    snapshotId: `snap-${sequence}`,
    runId,
    ...(sweepKey ? { sweepKey } : {}),
    createdAt: `2026-09-${String(10 + (sequence % 20)).padStart(2, '0')}T00:00:00.000Z`,
    answerText: text,
    citedDomains,
    anchors,
  }
}

/** A provider citation anchoring a list item to a page on `domain`. */
function windowAnchor(text: string, domain: string): AnchoredAnswerSpan {
  return { text, source: `https://${domain}/services`, kind: 'window', via: 'openai-annotation' }
}

/** Answers that name nothing and cite no tracked competitor: the contrast every lift needs. */
function background(count: number, cited: string[] = ['ridersguide.example']): AutoAliasAnswerInput[] {
  return Array.from({ length: count }, (_, index) => answer(`run-bg-${index % 3}`, 'Check your tire pressure before every ride.', cited))
}

function score(answers: readonly AutoAliasAnswerInput[], competitors = COMPETITORS): AutoAliasScores {
  const accumulator = createAutoAliasAccumulator({ competitors, project: PROJECT })
  for (const item of answers) accumulator.add(item)
  return accumulator.finish()
}

function evidence(scores: AutoAliasScores, domain: string, name: string) {
  return scores.byCompetitor.get(domain)?.get(brandKeyFromText(name))
}

/** A list item the answer pairs with `domain` through a provider citation, citing it. */
function paired(runId: string, name: string, domain: string, sweepKey?: string): AutoAliasAnswerInput {
  const line = `- **${name}** - recommended by riders.`
  return answer(runId, `Shops to try:\n${line}\n`, [domain], [windowAnchor(line, domain)], sweepKey)
}

describe('extractAnswerTextAnchors', () => {
  it('pairs a named link, a parenthetical host and a dashed host with their site', () => {
    const text = [
      'Try [TuneSpoke](https://spoketuneworks.example/book) for tune-ups.',
      '- **Rim Doctor** (rimdoctor.example): wheel truing.',
      'We also like QVX – www.qvx.example for parts.',
      '3. **Gear Loft** (gearloft.example) - list numbering is not part of the name.',
    ].join('\n')
    expect(extractAnswerTextAnchors(text)).toEqual([
      { text: 'TuneSpoke', source: 'https://spoketuneworks.example/book', kind: 'name', via: 'answer-link' },
      { text: 'Rim Doctor', source: 'rimdoctor.example', kind: 'name', via: 'answer-host' },
      { text: 'Gear Loft', source: 'gearloft.example', kind: 'name', via: 'answer-host' },
      { text: 'QVX', source: 'qvx.example', kind: 'name', via: 'answer-host' },
    ])
  })

  it('never reads a source address, a citation chip or a non-host parenthetical as a pairing', () => {
    const text = [
      'Sources: [spoketuneworks.example](https://spoketuneworks.example/) and [1](https://qvx.example/).',
      'Tune-ups are popular ([TuneSpoke](https://spoketuneworks.example/?utm_source=openai)).',
      'Prices rose (about 5.2 percent) this year (see above).',
    ].join('\n')
    expect(extractAnswerTextAnchors(text)).toEqual([])
  })
})

describe('isAutoAliasNameShaped', () => {
  it.each([
    ['TuneSpoke', true],
    ['Nuts N Bolts Cycles & Repair', true],
    ['The Spoke Shop of Springfield', true],
    ['QVX', true],
    ['3D Spoke Labs', true],
    ['1 Spoke Lane', true],
    ['A.J. Wheelworks', true],
    ['Why Stay Here', false],
    ['Top Picks', false],
    ['2x more leads', false],
    ['50% Off Tune-Ups', false],
    ['Pricing: Tiers', false],
    ['Is It Worth It?', false],
    ['24 Hours', false],
    ['7 Ways to Save', false],
    ['12', false],
    ['TuneSpoke.example', false],
    ['mobile tune-ups', false],
    ['One Two Three Four Five Six Seven', false],
  ])('%s -> %s', (name, shaped) => {
    expect(isAutoAliasNameShaped(name)).toBe(shaped)
  })
})

describe('hasDomainLabelAffinity', () => {
  const labels = ['rotorwise', 'spoketuneworks', 'foamandsealworks', 'spokegarage', 'spokeworks', 'qvx', 'airinspokes', 'getgoingbikes']
  it.each([
    ['TuneSpoke', 'spoketuneworks.example', true, 'its joined words sit inside the label'],
    ['QVX', 'qvx.example', true, 'its key equals a 3-letter label'],
    ['FoamSeal', 'foamandsealworks.example', true, 'its key is an in-order subsequence with the same first four letters'],
    ['AIR Spokes', 'airinspokes.example', true, 'its key is an in-order subsequence and the label starts with its first word'],
    ['Spoke Garage Bikes', 'spokegarage.example', true, 'it contains the whole label'],
    ['Get', 'getgoingbikes.example', false, 'a short word inside a long label proves nothing'],
    ['Spoke Masters', 'spokegarage.example', false, 'its only matching word is shared by two labels'],
    ['Quiet Vox Supply', 'qvx.example', false, 'nothing ties it to the label'],
  ])('%s for %s is %s: %s', (name, domain, expected) => {
    expect(hasDomainLabelAffinity(name, domain, labels)).toBe(expected)
  })
})

describe('createAutoAliasAccumulator', () => {
  it('scores precision, lift and casing exactly, and needs pairs from 2 sweeps', () => {
    const oneRun = [paired('run-1', 'TuneSpoke', 'spoketuneworks.example'), paired('run-1', 'TuneSpoke', 'spoketuneworks.example')]
    expect(evidence(score([...oneRun, ...background(6)]), 'spoketuneworks.example', 'TuneSpoke')).toMatchObject({ directPairs: 2, runs: 1, rejection: 'too-few-runs' })

    const twoRuns = [...oneRun, paired('run-2', 'TuneSpoke', 'spoketuneworks.example'), ...background(6)]
    const passed = evidence(score(twoRuns), 'spoketuneworks.example', 'TuneSpoke')!
    // 9 answers: 3 name and cite it, 6 do neither. Lift = (3/3) over the
    // smoothed rate in the other 6, (0 + 1) / (6 + 2) = 0.125, so 8.
    expect(passed).toMatchObject({
      name: 'TuneSpoke',
      key: 'tunespoke',
      directPairs: 3,
      runs: 2,
      // Each answer also cites the site and lays the name out as a business.
      cooccurrences: 3,
      namingAnswers: 3,
      citingAnswers: 3,
      nameCasedAnswers: 3,
      precision: 1,
      lift: 8,
      otherCompetitorPairs: 0,
      via: ['openai-annotation'],
      labelAffinity: true,
      rejection: null,
    })
    expect(passed.firstSeen <= passed.lastSeen).toBe(true)
  })

  it('counts the runs of one multi-location sweep as one sweep', () => {
    const oneSweep = ['run-a', 'run-b', 'run-c'].map(run => paired(run, 'TuneSpoke', 'spoketuneworks.example', '2026-09-01T00:00:00.000Z'))
    expect(evidence(score([...oneSweep, ...background(6)]), 'spoketuneworks.example', 'TuneSpoke'))
      .toMatchObject({ directPairs: 3, runs: 1, rejection: 'too-few-runs' })
  })

  it('needs 3 answers naming it, so precision has a denominator', () => {
    const scores = score([
      paired('run-1', 'Rim Doctor', 'rimdoctor.example'),
      paired('run-2', 'Rim Doctor', 'rimdoctor.example'),
      ...background(6),
    ])
    expect(evidence(scores, 'rimdoctor.example', 'Rim Doctor')).toMatchObject({ namingAnswers: 2, rejection: 'too-few-naming-answers' })
  })

  // A service heading the dominant source is cited for, and answers that say
  // the phrase in lowercase, half of them citing that source anyway.
  const serviceHeading = (backgroundCited: string[]) => [
    ...['run-1', 'run-2'].map((run) => {
      const line = '- **Roof Repair** - most leaks start at the flashing.'
      return answer(run, `What to budget for after hail:\n${line}\n`, ['roofpro.example'], [windowAnchor(line, 'roofpro.example')])
    }),
    ...Array.from({ length: 6 }, (_, index) => answer(`run-${index % 3 + 1}`, 'Roof repair after hail usually runs a few hundred dollars.', [index % 2 === 0 ? 'roofpro.example' : 'insurer.example'])),
    ...background(4, backgroundCited),
    ...background(4),
  ]

  it('rejects a generic phrase a dominant competitor is cited near: its precision passes, its lift does not', () => {
    // roofpro.example is cited in 9 of 16 answers, so any phrase looks precise.
    const generic = evidence(score(serviceHeading(['roofpro.example'])), 'roofpro.example', 'Roof Repair')!
    expect(generic).toMatchObject({ directPairs: 2, runs: 2, namingAnswers: 8, citingAnswers: 5, precision: 0.625, labelAffinity: true })
    // 0.625 over (9 - 5 + 1) / (16 - 8 + 2) = 0.5.
    expect(generic.lift).toBe(1.25)
    expect(generic.lift! < AUTO_ALIAS_MIN_LIFT).toBe(true)
    expect(generic.rejection).toBe('low-lift')
  })

  it('rejects a phrase answers write in lowercase even when its lift passes', () => {
    // The same answers with roofpro.example cited nowhere else: lift is
    // 0.625 / ((5 - 5 + 1) / 10) = 6.25, but 6 of 8 answers say "roof repair".
    const lowercase = evidence(score(serviceHeading(['insurer.example'])), 'roofpro.example', 'Roof Repair')!
    expect(lowercase).toMatchObject({ namingAnswers: 8, nameCasedAnswers: 2, precision: 0.625, lift: 6.25, rejection: 'lowercase-usage' })
    expect(lowercase.nameCasedAnswers < AUTO_ALIAS_MIN_NAME_CASED_SHARE * lowercase.namingAnswers).toBe(true)
  })

  it('keeps a precision floor under lift', () => {
    // Paired twice, named in 24 answers, cited in 2: precision 1/12. The site
    // is cited nowhere else, so lift alone (about 8.5) would pass.
    const scores = score([
      paired('run-1', 'Rim Doctor', 'rimdoctor.example'),
      paired('run-2', 'Rim Doctor', 'rimdoctor.example'),
      ...Array.from({ length: 22 }, (_, index) => answer(`run-${index % 3 + 1}`, 'Ask **Rim Doctor** about truing.', [])),
      ...background(100),
    ])
    const floor = evidence(scores, 'rimdoctor.example', 'Rim Doctor')!
    expect(floor).toMatchObject({ namingAnswers: 24, citingAnswers: 2, precision: 0.08333333, lift: 8.5, rejection: 'low-precision' })
    expect(floor.precision! < AUTO_ALIAS_MIN_PRECISION).toBe(true)
  })

  it('never scores a name backed only by co-occurrence', () => {
    const answers = ['run-1', 'run-2', 'run-3', 'run-4'].map(run =>
      answer(run, '- **Chain Gang Cycles** - parts and repairs.', ['spoketuneworks.example']))
    expect(evidence(score(answers), 'spoketuneworks.example', 'Chain Gang Cycles')).toBeUndefined()
  })

  it('gives a name paired as often with another tracked competitor to neither', () => {
    const answers = [
      paired('run-1', 'Wheel Hub', 'spoketuneworks.example'),
      paired('run-2', 'Wheel Hub', 'spoketuneworks.example'),
      paired('run-1', 'Wheel Hub', 'rimdoctor.example'),
      paired('run-2', 'Wheel Hub', 'rimdoctor.example'),
      ...background(6),
    ]
    const scores = score(answers)
    expect(evidence(scores, 'spoketuneworks.example', 'Wheel Hub')).toMatchObject({ directPairs: 2, otherCompetitorPairs: 2, rejection: 'other-competitor-dominates' })
    expect(evidence(scores, 'rimdoctor.example', 'Wheel Hub')).toMatchObject({ directPairs: 2, otherCompetitorPairs: 2, rejection: 'other-competitor-dominates' })
  })

  it('ignores anchors to the project\'s own site and answers with no stored text', () => {
    const own = ['run-1', 'run-2', 'run-3'].map(run =>
      answer(run, '- **Rotor Crew** - tune-ups', ['rotorwise.example'], [windowAnchor('- **Rotor Crew** - tune-ups', 'shop.rotorwise.example')]))
    const empty = { snapshotId: 'no-text', runId: 'run-9', createdAt: NOW, answerText: null, citedDomains: ['spoketuneworks.example'] }
    const accumulator = createAutoAliasAccumulator({ competitors: [...COMPETITORS, { domain: 'rotorwise.example' }], project: PROJECT })
    for (const item of [...own, empty]) accumulator.add(item)
    const scores = accumulator.finish()
    expect(scores.answers).toBe(3)
    expect(evidence(scores, 'rotorwise.example', 'Rotor Crew')).toBeUndefined()
  })

  it('scores a stored auto name with no pairing in the window, so contradicting answers can remove it', () => {
    const accumulator = createAutoAliasAccumulator({ competitors: COMPETITORS, project: PROJECT })
    for (const run of ['run-1', 'run-2', 'run-3']) accumulator.add(answer(run, 'Spoke Tune is a common phrase here.', []))
    const scores = accumulator.finish({ storedNames: [{ domain: 'spoketuneworks.example', name: 'Spoke Tune' }] })
    expect(evidence(scores, 'spoketuneworks.example', 'Spoke Tune')).toMatchObject({ directPairs: 0, namingAnswers: 3, citingAnswers: 0, precision: 0, lift: 0 })
  })

  describe('a name written with a possessive or a contraction', () => {
    const possessive = [{ domain: 'joesspokeshop.example' }]
    // The word segmenter splits `Joe's` into `Joe` and `s`; the clitic is part
    // of the word before it, so the name is still written as a name.
    it.each([
      ['a straight apostrophe', "Joe's Spokes"],
      ['a curly apostrophe', 'Joe’s Spokes'],
      ['a contraction', "Don't Spoke Out"],
    ])('counts %s as name casing, so the name applies', (_label, name) => {
      const answers = [...['run-1', 'run-2', 'run-3'].map(run => paired(run, name, 'joesspokeshop.example')), ...background(6)]
      expect(evidence(score(answers, possessive), 'joesspokeshop.example', name)).toMatchObject({
        name,
        namingAnswers: 3,
        nameCasedAnswers: 3,
        rejection: null,
      })
    })

    it('still counts the name written all in lowercase as a phrase', () => {
      const answers = [
        ...['run-1', 'run-2'].map(run => paired(run, "Joe's Spokes", 'joesspokeshop.example')),
        ...Array.from({ length: 4 }, (_, index) => answer(`run-${index % 2 + 1}`, "joe's spokes is a phrase here.", ['joesspokeshop.example'])),
        ...background(6),
      ]
      expect(evidence(score(answers, possessive), 'joesspokeshop.example', "Joe's Spokes")).toMatchObject({ namingAnswers: 6, nameCasedAnswers: 2, rejection: 'lowercase-usage' })
    })
  })

  describe('a name with accented or non-Latin letters', () => {
    it('learns an accented name from provider anchors exactly as its unaccented spelling', () => {
      const accented = [...['run-1', 'run-2', 'run-3'].map(run => paired(run, 'TuneSpóke', 'spoketuneworks.example')), ...background(6)]
      const plain = [...['run-1', 'run-2', 'run-3'].map(run => paired(run, 'TuneSpoke', 'spoketuneworks.example')), ...background(6)]
      const learned = evidence(score(accented), 'spoketuneworks.example', 'TuneSpóke')
      expect(learned).toMatchObject({ name: 'TuneSpóke', key: 'tunespoke', directPairs: 3, runs: 3, nameCasedAnswers: 3, rejection: null })
      const { name: _accentedName, firstSeen: _a1, lastSeen: _a2, ...accentedMeasures } = learned!
      const { name: _plainName, firstSeen: _p1, lastSeen: _p2, ...plainMeasures } = evidence(score(plain), 'spoketuneworks.example', 'TuneSpoke')!
      expect(accentedMeasures).toEqual(plainMeasures)
    })

    it('learns a name whose first letter carries a decomposed accent from provider anchors, as its composed spelling', () => {
      const competitors = [{ domain: 'oskvelbikes.example' }]
      // O plus a combining acute (U+0301), then the composed letter.
      const decomposed = [...['run-1', 'run-2', 'run-3'].map(run => paired(run, 'O\u0301skvel Bikes', 'oskvelbikes.example')), ...background(6)]
      const composed = [...['run-1', 'run-2', 'run-3'].map(run => paired(run, '\u00d3skvel Bikes', 'oskvelbikes.example')), ...background(6)]
      const learned = evidence(score(decomposed, competitors), 'oskvelbikes.example', 'Oskvel Bikes')
      expect(learned).toMatchObject({ name: 'O\u0301skvel Bikes', directPairs: 3, runs: 3, nameCasedAnswers: 3, rejection: null })
      const { name: _d, firstSeen: _d1, lastSeen: _d2, ...decomposedMeasures } = learned!
      const { name: _c, firstSeen: _c1, lastSeen: _c2, ...composedMeasures } = evidence(score(composed, competitors), 'oskvelbikes.example', 'Oskvel Bikes')!
      expect(decomposedMeasures).toEqual(composedMeasures)
    })

    it('reads an accented capital as a name and an accented lowercase word as a phrase', () => {
      const competitors = [{ domain: 'eclairvelo.example' }]
      const cased = [...['run-1', 'run-2', 'run-3'].map(run => paired(run, 'Éclair Vélo', 'eclairvelo.example')), ...background(6)]
      expect(evidence(score(cased, competitors), 'eclairvelo.example', 'Éclair Vélo')).toMatchObject({ nameCasedAnswers: 3, rejection: null })

      const lowercase = [
        ...['run-1', 'run-2'].map(run => paired(run, 'Éclair Vélo', 'eclairvelo.example')),
        ...Array.from({ length: 4 }, (_, index) => answer(`run-${index % 2 + 1}`, 'an éclair vélo ride is a phrase here.', ['eclairvelo.example'])),
        ...background(6),
      ]
      expect(evidence(score(lowercase, competitors), 'eclairvelo.example', 'Éclair Vélo')).toMatchObject({ namingAnswers: 6, nameCasedAnswers: 2, rejection: 'lowercase-usage' })
    })

    it('reads a caseless non-Latin name without breaking, scoring it as written', () => {
      const answers = [...['run-1', 'run-2', 'run-3'].map(run => paired(run, '東京スポーク', 'tokyospoke.example')), ...background(6)]
      const learned = evidence(score(answers, [{ domain: 'tokyospoke.example' }]), 'tokyospoke.example', '東京スポーク')
      expect(learned).toMatchObject({ name: '東京スポーク', directPairs: 3, namingAnswers: 3, nameCasedAnswers: 3 })
      // Nothing in a caseless script ties it to an ASCII domain label: listed for review, never applied.
      expect(learned!.labelAffinity).toBe(false)
    })
  })

  describe('a scoped competitor (one an Advanced market pins)', () => {
    const competitors = [{ domain: 'spoketuneworks.example', scoped: true }, { domain: 'rimdoctor.example' }]
    const inMarket = (item: AutoAliasAnswerInput): AutoAliasAnswerInput => ({ ...item, scopedCompetitors: ['www.spoketuneworks.example'] })

    it('counts only the answers that measure it, and leaves unscoped competitors on every answer', () => {
      const answers = [
        ...['run-1', 'run-2', 'run-3'].map(run => inMarket(paired(run, 'TuneSpoke', 'spoketuneworks.example'))),
        ...background(5).map(inMarket),
        // Another market: these name it and pair it with its site, but never measure it.
        ...Array.from({ length: 20 }, (_, index) => answer(`run-${index % 3 + 1}`, 'TuneSpoke gets a mention here.', [])),
        ...['run-1', 'run-2'].map(run => paired(run, 'TuneSpoke', 'spoketuneworks.example')),
        // An unscoped competitor is measured everywhere.
        ...['run-1', 'run-2', 'run-3'].map(run => paired(run, 'Rim Doctor', 'rimdoctor.example')),
      ]
      const scores = score(answers, competitors)
      // In scope: 8 answers, 3 name it and cite it. Lift 1 / ((3 - 3 + 1) / (8 - 3 + 2)) = 7.
      expect(evidence(scores, 'spoketuneworks.example', 'TuneSpoke')).toMatchObject({
        directPairs: 3,
        runs: 3,
        cooccurrences: 3,
        namingAnswers: 3,
        citingAnswers: 3,
        nameCasedAnswers: 3,
        precision: 1,
        lift: 7,
        rejection: null,
      })
      // Out of scope, the 22 other answers would have sunk its precision to 3 of 25.
      const unscoped = score(answers, [{ domain: 'spoketuneworks.example' }, { domain: 'rimdoctor.example' }])
      expect(evidence(unscoped, 'spoketuneworks.example', 'TuneSpoke')).toMatchObject({ directPairs: 5, namingAnswers: 25, citingAnswers: 5, precision: 0.2 })
      // 33 answers in all, 3 name and cite it: lift 1 / ((3 - 3 + 1) / (33 - 3 + 2)) = 32.
      expect(evidence(scores, 'rimdoctor.example', 'Rim Doctor')).toMatchObject({ directPairs: 3, namingAnswers: 3, citingAnswers: 3, lift: 32 })
      expect(scores.answers).toBe(33)
    })

    it('counts another scoped competitor\'s pairs only in the answers that measure this one', () => {
      // Two market-only competitors in separate markets, each paired with the
      // same name in its own market only: no answer measures both.
      const rivals = [{ domain: 'velquistnorthspokes.example', scoped: true }, { domain: 'velquistsouthspokes.example', scoped: true }]
      const north = (item: AutoAliasAnswerInput): AutoAliasAnswerInput => ({ ...item, scopedCompetitors: ['velquistnorthspokes.example'] })
      const south = (item: AutoAliasAnswerInput): AutoAliasAnswerInput => ({ ...item, scopedCompetitors: ['velquistsouthspokes.example'] })
      const answers = [
        ...['run-1', 'run-2', 'run-3'].map(run => north(paired(run, 'Velquist Spokes', 'velquistnorthspokes.example'))),
        ...background(6).map(north),
        ...['run-1', 'run-2', 'run-3'].map(run => south(paired(run, 'Velquist Spokes', 'velquistsouthspokes.example'))),
        ...background(6).map(south),
      ]
      const scores = score(answers, rivals)
      for (const domain of ['velquistnorthspokes.example', 'velquistsouthspokes.example']) {
        expect(evidence(scores, domain, 'Velquist Spokes')).toMatchObject({ directPairs: 3, otherCompetitorPairs: 0, labelAffinity: true, rejection: null })
      }
      // Names stay unique across competitors: both claims are dropped, each
      // naming the other competitor, never as one dominating the other.
      const resolved = resolveCompetitorAutoAliases(scores, rivals.map(({ domain }) => ({ domain, aliases: [], autoAliases: [], blockedAliases: [] })), PROJECT, NOW)
      expect(resolved.map(resolution => [resolution.domain, resolution.added, resolution.candidates.map(candidate => [candidate.name, candidate.status, candidate.reason, candidate.conflictsWith])])).toEqual([
        ['velquistnorthspokes.example', [], [['Velquist Spokes', 'rejected', 'other-competitor', 'velquistsouthspokes.example']]],
        ['velquistsouthspokes.example', [], [['Velquist Spokes', 'rejected', 'other-competitor', 'velquistnorthspokes.example']]],
      ])
    })

    it('still counts another competitor\'s pairs in the answers both are measured by', () => {
      const rivals = [{ domain: 'velquistnorthspokes.example', scoped: true }, { domain: 'velquistsouthspokes.example' }]
      const north = (item: AutoAliasAnswerInput): AutoAliasAnswerInput => ({ ...item, scopedCompetitors: ['velquistnorthspokes.example'] })
      const answers = [
        ...['run-1', 'run-2', 'run-3'].map(run => north(paired(run, 'Velquist Spokes', 'velquistnorthspokes.example'))),
        // The unscoped competitor is measured in the north market's answers too.
        ...['run-1', 'run-2'].map(run => north(paired(run, 'Velquist Spokes', 'velquistsouthspokes.example'))),
        // Out of the north market: not an answer the scoped competitor is measured by.
        ...['run-1', 'run-2', 'run-3'].map(run => paired(run, 'Velquist Spokes', 'velquistsouthspokes.example')),
        ...background(6).map(north),
      ]
      expect(evidence(score(answers, rivals), 'velquistnorthspokes.example', 'Velquist Spokes')).toMatchObject({ directPairs: 3, otherCompetitorPairs: 2, rejection: 'other-competitor-dominates' })
      expect(evidence(score(answers, rivals), 'velquistsouthspokes.example', 'Velquist Spokes')).toMatchObject({ directPairs: 5, otherCompetitorPairs: 3 })
    })

    it('scores nothing for it when no answer measures it', () => {
      const answers = ['run-1', 'run-2', 'run-3'].map(run => paired(run, 'TuneSpoke', 'spoketuneworks.example'))
      expect(evidence(score(answers, competitors), 'spoketuneworks.example', 'TuneSpoke')).toBeUndefined()
    })
  })

  it('scores the same in chunks as in one pass', async () => {
    const answers = [...['run-1', 'run-2', 'run-3'].map(run => paired(run, 'TuneSpoke', 'spoketuneworks.example')), ...background(6)]
    const chunked = createAutoAliasAccumulator({ competitors: COMPETITORS, project: PROJECT })
    for (const item of answers) chunked.add(item)
    let pauses = 0
    const scores = await chunked.finishInChunks(async () => { pauses++ })
    expect(evidence(scores, 'spoketuneworks.example', 'TuneSpoke')).toEqual(evidence(score(answers), 'spoketuneworks.example', 'TuneSpoke'))
    expect(pauses).toBe(0)
  })
})

describe('resolveCompetitorAutoAliases', () => {
  const passingAnswers = [
    ...['run-1', 'run-2', 'run-3'].flatMap(run => [
      paired(run, 'TuneSpoke', 'spoketuneworks.example'),
      paired(run, 'QVX', 'qvx.example'),
      paired(run, 'Quiet Vox Supply', 'qvx.example'),
    ]),
    ...background(9),
  ]
  const scores = score(passingAnswers)
  const state = (overrides: Partial<Record<string, Partial<CompetitorAutoAliasState>>> = {}, competitors = COMPETITORS): CompetitorAutoAliasState[] =>
    competitors.map(({ domain }) => ({ domain, aliases: [], autoAliases: [], blockedAliases: [], ...overrides[domain] }))
  const stored = (name: string, extra: Partial<CompetitorAutoAlias> = {}): CompetitorAutoAlias => ({
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
    ...extra,
  })
  const byDomain = (resolutions: ReturnType<typeof resolveCompetitorAutoAliases>) =>
    Object.fromEntries(resolutions.map(resolution => [resolution.domain, resolution]))

  it('adds the passing names with their evidence and lists short names and names without label affinity for review only', () => {
    const result = byDomain(resolveCompetitorAutoAliases(scores, state(), PROJECT, NOW))
    expect(result['spoketuneworks.example']!.added).toEqual(['TuneSpoke'])
    const tuneSpoke = evidence(scores, 'spoketuneworks.example', 'TuneSpoke')!
    expect(result['spoketuneworks.example']!.autoAliases).toEqual([{
      name: 'TuneSpoke', directPairs: 3, cooccurrences: 3, namingAnswers: 3, precision: 1, lift: tuneSpoke.lift, nameCasedAnswers: 3, runs: 3,
      firstSeen: tuneSpoke.firstSeen,
      lastSeen: tuneSpoke.lastSeen,
      addedAt: NOW,
    }])
    // A 3-letter name needs an operator's approval, as a 3-letter domain label does.
    expect(result['qvx.example']!.added).toEqual([])
    expect(result['qvx.example']!.candidates.map(candidate => [candidate.name, candidate.status, candidate.reason])).toEqual([
      ['Quiet Vox Supply', 'review', 'no-label-affinity'],
      ['QVX', 'review', 'needs-approval'],
    ])
    expect(result['qvx.example']!.namesChanged).toBe(false)
    expect(result['roofpro.example']!).toMatchObject({ added: [], removed: [], namesChanged: false, recordsChanged: false })
  })

  it('is idempotent: resolving against its own output changes nothing', () => {
    const first = resolveCompetitorAutoAliases(scores, state(), PROJECT, NOW)
    const again = resolveCompetitorAutoAliases(scores, COMPETITORS.map(({ domain }, index) => ({
      domain, aliases: [], autoAliases: first[index]!.autoAliases, blockedAliases: [],
    })), PROJECT, '2026-10-07T00:00:00.000Z')
    expect(again.map(resolution => [resolution.namesChanged, resolution.recordsChanged])).toEqual(COMPETITORS.map(() => [false, false]))
    expect(again[0]!.autoAliases[0]!.addedAt).toBe(NOW)
    expect(again[0]!.candidates.map(candidate => candidate.status)).toEqual(['kept'])
  })

  it('never applies a blocked name, compared by brand key', () => {
    const result = byDomain(resolveCompetitorAutoAliases(scores, state({ 'spoketuneworks.example': { blockedAliases: ['Tune Spoke'] } }), PROJECT, NOW))
    expect(result['spoketuneworks.example']!.added).toEqual([])
    expect(result['spoketuneworks.example']!.candidates).toEqual([expect.objectContaining({ name: 'TuneSpoke', status: 'rejected', reason: 'blocked' })])
  })

  describe('a short name and the longer names built on it', () => {
    const competitors = [{ domain: 'acmecycles.example' }, { domain: 'rimdoctor.example' }]
    const acme = score([
      ...['run-1', 'run-2', 'run-3'].flatMap(run => [
        paired(run, 'Acme', 'acmecycles.example'),
        paired(run, 'Acme Bike Co', 'acmecycles.example'),
        paired(run, 'Acme Bike Co', 'acmecycles.example'),
      ]),
      ...background(12),
    ], competitors)

    it('applies the shortest and drops the longer ones as subsumed', () => {
      const [result] = resolveCompetitorAutoAliases(acme, state({}, competitors), PROJECT, NOW)
      expect(result!.added).toEqual(['Acme'])
      expect(result!.candidates.find(candidate => candidate.name === 'Acme Bike Co')).toMatchObject({ status: 'rejected', reason: 'subsumed' })
    })

    it('applies the longer name once the operator blocks the short one', () => {
      const [result] = resolveCompetitorAutoAliases(acme, state({ 'acmecycles.example': { blockedAliases: ['Acme'] } }, competitors), PROJECT, NOW)
      expect(result!.added).toEqual(['Acme Bike Co'])
      expect(result!.candidates.map(candidate => [candidate.name, candidate.status, candidate.reason])).toEqual([
        ['Acme Bike Co', 'added', undefined],
        ['Acme', 'rejected', 'blocked'],
      ])
    })
  })

  it('lets curated identity win: its own curated alias, and another competitor\'s', () => {
    const own = byDomain(resolveCompetitorAutoAliases(scores, state({
      'spoketuneworks.example': { aliases: ['Tune Spoke'], autoAliases: [stored('Spoke Tune Works')] },
    }), PROJECT, NOW))
    expect(own['spoketuneworks.example']!.added).toEqual([])
    expect(own['spoketuneworks.example']!.candidates.find(candidate => candidate.name === 'TuneSpoke'))
      .toMatchObject({ status: 'rejected', reason: 'already-matched' })

    const other = byDomain(resolveCompetitorAutoAliases(scores, state({ 'rimdoctor.example': { aliases: ['Tune'] } }), PROJECT, NOW))
    expect(other['spoketuneworks.example']!.added).toEqual([])
    expect(other['spoketuneworks.example']!.candidates.find(candidate => candidate.name === 'TuneSpoke'))
      .toMatchObject({ status: 'rejected', reason: 'other-competitor', conflictsWith: 'rimdoctor.example' })
  })

  describe('a competitor an Advanced market pins under other names', () => {
    // qvx.example's pin in one market lists "TuneSpoke" as a plan alias.
    const pins = [{ domain: 'qvx.example', names: ['Quiet Vox', 'TuneSpoke'], markets: ['north'] }]

    it('keeps another competitor from learning a name its pin lists', () => {
      const result = byDomain(resolveCompetitorAutoAliases(scores, state(), PROJECT, NOW, pins))
      expect(result['spoketuneworks.example']!.added).toEqual([])
      expect(result['spoketuneworks.example']!.candidates.find(candidate => candidate.name === 'TuneSpoke'))
        .toMatchObject({ status: 'rejected', reason: 'other-competitor', conflictsWith: 'qvx.example' })
    })

    it('removes another competitor\'s stored name its pin now lists', () => {
      const result = byDomain(resolveCompetitorAutoAliases(scores, state({ 'spoketuneworks.example': { autoAliases: [stored('TuneSpoke')] } }), PROJECT, NOW, pins))
      expect(result['spoketuneworks.example']!).toMatchObject({ autoAliases: [], namesChanged: true })
      expect(result['spoketuneworks.example']!.removed).toEqual([{ name: 'TuneSpoke', reason: 'other-competitor', conflictsWith: 'qvx.example' }])
    })

    it('counts a pin only a superseded revision still scores, and a pin of an untracked domain, the same way', () => {
      const superseded = [{ domain: 'tunequotes.example', names: ['TuneSpoke'], markets: ['north'], supersededRevision: 2 }]
      const result = byDomain(resolveCompetitorAutoAliases(scores, state(), PROJECT, NOW, superseded))
      expect(result['spoketuneworks.example']!.added).toEqual([])
      expect(result['spoketuneworks.example']!.candidates.find(candidate => candidate.name === 'TuneSpoke'))
        .toMatchObject({ status: 'rejected', reason: 'other-competitor', conflictsWith: 'tunequotes.example' })
    })

    it('still lets the competitor itself learn a name its pin lists: outside those markets the pin does not name it', () => {
      const own = [{ domain: 'spoketuneworks.example', names: ['TuneSpoke'], markets: ['north'] }]
      const result = byDomain(resolveCompetitorAutoAliases(scores, state(), PROJECT, NOW, own))
      expect(result['spoketuneworks.example']!.added).toEqual(['TuneSpoke'])
    })
  })

  it('drops a stored auto name the competitor now carries as a curated alias', () => {
    const result = byDomain(resolveCompetitorAutoAliases(scores, state({
      'rimdoctor.example': { aliases: ['Rim Docs'], autoAliases: [stored('Rim Docs')] },
    }), PROJECT, NOW))
    expect(result['rimdoctor.example']!).toMatchObject({ autoAliases: [], added: [], namesChanged: true })
    expect(result['rimdoctor.example']!.removed).toEqual([{ name: 'Rim Docs', reason: 'already-matched' }])
  })

  it('drops a stored 3-letter auto name: the domain-label floor applies', () => {
    const result = byDomain(resolveCompetitorAutoAliases(scores, state({ 'qvx.example': { autoAliases: [stored('QVX')] } }), PROJECT, NOW))
    expect(result['qvx.example']!.removed).toEqual([{ name: 'QVX', reason: 'too-short' }])
  })

  it('keeps another competitor\'s stored auto name over a new candidate it contains', () => {
    const result = byDomain(resolveCompetitorAutoAliases(scores, state({
      'rimdoctor.example': { autoAliases: [stored('TuneSpoke Rims')] },
    }), PROJECT, NOW))
    expect(result['rimdoctor.example']!.autoAliases.map(record => record.name)).toEqual(['TuneSpoke Rims'])
    expect(result['spoketuneworks.example']!.added).toEqual([])
    expect(result['spoketuneworks.example']!.candidates.find(candidate => candidate.name === 'TuneSpoke'))
      .toMatchObject({ status: 'rejected', reason: 'other-competitor', conflictsWith: 'rimdoctor.example' })
  })

  it('keeps a stored name the window does not mention, and removes one the answers clearly contradict', () => {
    const contradicting = createAutoAliasAccumulator({ competitors: COMPETITORS, project: PROJECT })
    for (const item of passingAnswers) contradicting.add(item)
    for (const run of ['run-4', 'run-5', 'run-6']) contradicting.add(answer(run, 'Roof Repair costs vary by pitch.', []))
    const withContradiction = contradicting.finish({ storedNames: [{ domain: 'roofpro.example', name: 'Roof Repair' }] })
    const result = byDomain(resolveCompetitorAutoAliases(withContradiction, state({
      'roofpro.example': { autoAliases: [stored('Roof Repair')] },
      'rimdoctor.example': { autoAliases: [stored('Rim Docs')] },
    }), PROJECT, NOW))
    expect(result['roofpro.example']!).toMatchObject({ autoAliases: [], namesChanged: true })
    expect(result['roofpro.example']!.removed).toEqual([{ name: 'Roof Repair', reason: 'low-precision' }])
    // A removed name the window saw but never paired keeps its stored pairing dates.
    expect(result['roofpro.example']!.candidates).toEqual([expect.objectContaining({
      name: 'Roof Repair', status: 'removed', namingAnswers: 3, precision: 0, firstSeen: '2026-08-01T00:00:00.000Z', lastSeen: '2026-08-20T00:00:00.000Z',
    })])
    expect(result['rimdoctor.example']!).toMatchObject({ autoAliases: [stored('Rim Docs')], namesChanged: false, recordsChanged: false })
  })

  it('keeps a stored name between the remove and apply bounds, where a new name is not applied', () => {
    // Named in 30 answers, 2 pairing and citing it: precision 1/15, under
    // the 0.1 apply floor and over the 0.05 remove bound.
    const between = [
      ...['run-1', 'run-2'].map(run => paired(run, 'Spoke Doctor', 'rimdoctor.example')),
      ...Array.from({ length: 28 }, (_, index) => answer(`run-${index % 3 + 1}`, 'Ask **Spoke Doctor** about truing.', [])),
      ...background(200),
    ]
    const accumulator = createAutoAliasAccumulator({ competitors: COMPETITORS, project: PROJECT })
    for (const item of between) accumulator.add(item)
    const scored = accumulator.finish({ storedNames: [{ domain: 'rimdoctor.example', name: 'Spoke Doctor' }] })
    expect(evidence(scored, 'rimdoctor.example', 'Spoke Doctor')).toMatchObject({ namingAnswers: 30, citingAnswers: 2, precision: 0.06666667, rejection: 'low-precision' })

    const fresh = byDomain(resolveCompetitorAutoAliases(scored, state(), PROJECT, NOW))
    expect(fresh['rimdoctor.example']!.added).toEqual([])
    const kept = byDomain(resolveCompetitorAutoAliases(scored, state({ 'rimdoctor.example': { autoAliases: [stored('Spoke Doctor')] } }), PROJECT, NOW))
    expect(kept['rimdoctor.example']!).toMatchObject({ removed: [], namesChanged: false })
    expect(kept['rimdoctor.example']!.autoAliases.map(record => record.name)).toEqual(['Spoke Doctor'])
  })

  it('removes a stored name answers have started writing in lowercase', () => {
    const accumulator = createAutoAliasAccumulator({ competitors: COMPETITORS, project: PROJECT })
    for (const item of [...background(20), ...['run-1', 'run-2', 'run-3', 'run-4'].map(run => answer(run, 'Every rim doctor recommends tubeless.', ['rimdoctor.example']))]) accumulator.add(item)
    const scored = accumulator.finish({ storedNames: [{ domain: 'rimdoctor.example', name: 'Rim Doctor' }] })
    expect(evidence(scored, 'rimdoctor.example', 'Rim Doctor')).toMatchObject({ namingAnswers: 4, nameCasedAnswers: 0, precision: 1 })
    const result = byDomain(resolveCompetitorAutoAliases(scored, state({ 'rimdoctor.example': { autoAliases: [stored('Rim Doctor')] } }), PROJECT, NOW))
    expect(result['rimdoctor.example']!.removed).toEqual([{ name: 'Rim Doctor', reason: 'lowercase-usage' }])
  })

  it('keeps a stored possessive name the answers keep writing as a name', () => {
    const competitors = [{ domain: 'joesspokeshop.example' }]
    const accumulator = createAutoAliasAccumulator({ competitors, project: PROJECT })
    for (const item of [...['run-1', 'run-2', 'run-3', 'run-4'].map(run => paired(run, 'Joe’s Spokes', 'joesspokeshop.example')), ...background(8)]) accumulator.add(item)
    const scored = accumulator.finish({ storedNames: [{ domain: 'joesspokeshop.example', name: "Joe's Spokes" }] })
    const result = byDomain(resolveCompetitorAutoAliases(scored, state({ 'joesspokeshop.example': { autoAliases: [stored("Joe's Spokes")] } }, competitors), PROJECT, NOW))
    expect(result['joesspokeshop.example']!).toMatchObject({ removed: [], namesChanged: false })
    // Stored as written, with the window's evidence.
    expect(result['joesspokeshop.example']!.autoAliases).toEqual([expect.objectContaining({ name: "Joe's Spokes", namingAnswers: 4, nameCasedAnswers: 4 })])
  })

  it('refreshes a kept name\'s evidence from the window without touching when it was added', () => {
    const result = byDomain(resolveCompetitorAutoAliases(scores, state({
      'spoketuneworks.example': { autoAliases: [stored('TuneSpoke', { directPairs: 1, firstSeen: '2026-08-01T00:00:00.000Z' })] },
    }), PROJECT, NOW))
    expect(result['spoketuneworks.example']!.autoAliases).toEqual([expect.objectContaining({
      name: 'TuneSpoke', directPairs: 3, runs: 3, nameCasedAnswers: 3, firstSeen: '2026-08-01T00:00:00.000Z', addedAt: '2026-08-21T00:00:00.000Z',
    })])
    expect(result['spoketuneworks.example']!).toMatchObject({ namesChanged: false, recordsChanged: true, added: [] })
  })
})
