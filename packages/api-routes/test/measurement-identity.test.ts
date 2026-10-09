import { describe, expect, it } from 'vitest'
import {
  buildMeasurementEvidence,
  buildMeasurementObservationSignals,
  buildMeasurementOverview,
  buildMeasurementReport,
  createTargetMentionReader,
  type MeasurementOverviewInput,
} from '../src/measurement-report.js'

function fixture(): MeasurementOverviewInput {
  const ids = ['harbor', 'loft']
  return {
    revision: 1, ownedHosts: ['northstar.example'], projectDomain: 'northstar.example', projectBrandNames: ['Northstar'],
    targets: ids.map((id, index) => ({ id, label: ['Harbor Point', 'Sail Loft'][index]!, aliases: [['Harbor Point'], ['Sail Loft']][index]!, urls: [{ id: `url-${id}`, mode: 'prefix', host: 'northstar.example', path: `/${id}` }] })),
    groups: [{ id: 'region', label: 'Region', targetIds: ids, competitors: [] }],
    usageEdges: ids.map(id => ({ id: `edge-${id}`, type: 'target', targetId: id, executionId: `exec-${id}` })),
    expectedSlots: ids.map(id => ({ id: `slot-${id}`, executionId: `exec-${id}`, queryText: `services near ${id}`, provider: 'openai', location: null })),
    observations: ids.map(id => ({ id: `answer-${id}`, executionId: `exec-${id}`, queryText: `services near ${id}`, provider: 'openai', location: null, answerText: '', citedUrls: [], citedUrlsComplete: true })),
    scopeTargetIds: ids,
  }
}

describe('property mentions read the answer prose, not its citations', () => {
  // Shape of an OpenAI web-search answer: property pages are cited through
  // inline chips whose URL path, and sometimes label, carries the name.
  const CHIPS = '([northstar.example](https://northstar.example/harbor/harbor-point-apartments/?utm_source=chatgpt.com), [Sail Loft](https://northstar.example/loft/?utm_source=chatgpt.com))'

  it('does not count an alias found only in a chip URL path or chip label, and still counts the citation', () => {
    const input = fixture()
    input.observations[0]!.answerText = `Pet fees in the area run $300 to $400 per pet. ${CHIPS}`
    input.observations[0]!.citedUrls = ['https://northstar.example/harbor/harbor-point-apartments/']
    input.observations[1]!.answerText = `Most waterfront units have in-unit laundry. ${CHIPS}`

    const evidence = buildMeasurementEvidence(input).answers
    expect(evidence.map(row => [row.usageEdgeId, row.mentioned, row.cited])).toEqual([
      ['edge-harbor', false, true],
      ['edge-loft', false, false],
    ])
    expect(buildMeasurementObservationSignals(input).map(row => row.mentionedTargetIds)).toEqual([[], []])
    const overview = buildMeasurementOverview(input)
    expect(overview.mentionCoverage).toEqual({ numerator: 0, denominator: 2, rate: 0 })
    expect(overview.citationCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    // The project brand appears only as a chip label: presence is a prose read too.
    expect(overview.brandPresence).toEqual({ numerator: 0, denominator: 2, rate: 0 })
  })

  it('counts the same aliases written in prose, including a prose link label', () => {
    const input = fixture()
    input.observations[0]!.answerText = `Harbor Point charges $350 per pet. ${CHIPS}`
    input.observations[1]!.answerText = `[Sail Loft](https://northstar.example/loft/) has in-unit laundry, and Northstar manages it. ${CHIPS}`

    expect(buildMeasurementEvidence(input).answers.map(row => [row.usageEdgeId, row.mentioned])).toEqual([
      ['edge-harbor', true],
      ['edge-loft', true],
    ])
    const overview = buildMeasurementOverview(input)
    expect(overview.mentionCoverage).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(overview.brandPresence).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
  })

  it('counts group share of voice from the prose, never from a competitor or project chip', () => {
    const input = fixture()
    input.groups[0]!.competitors = [{ domain: 'rivalhomes.example', aliases: ['Rival Homes'] }]
    const rivalChips = '([Rival Homes](https://rivalhomes.example/pets/?utm_source=chatgpt.com), [rivalhomes.example](https://rivalhomes.example/rival-homes-oakland/?utm_source=chatgpt.com))'
    input.observations[0]!.answerText = `Pet fees in the area run $300 to $400 per pet. ${rivalChips} ${CHIPS}`
    input.observations[1]!.answerText = `Most waterfront units have in-unit laundry. ${rivalChips}`
    const sov = () => buildMeasurementReport(input).groups[0]!.sov.domains

    expect(sov()).toEqual([
      { domain: 'northstar.example', own: true, presentIn: 0, of: 2 },
      { domain: 'rivalhomes.example', own: false, presentIn: 0, of: 2 },
    ])

    input.observations[0]!.answerText = `Rival Homes charges less per pet than Northstar. ${rivalChips} ${CHIPS}`
    expect(sov()).toEqual([
      { domain: 'northstar.example', own: true, presentIn: 1, of: 2 },
      { domain: 'rivalhomes.example', own: false, presentIn: 1, of: 2 },
    ])
  })
})

describe('assignment-aware identity attribution', () => {
  it('never credits a sibling named only in another property’s assigned answer', () => {
    const input = fixture()
    input.observations[0]!.answerText = 'Sail Loft is mentioned.'
    const overview = buildMeasurementOverview(input)
    expect(overview.mentionCoverage).toEqual({ numerator: 0, denominator: 2, rate: 0 })
    expect(overview.propertiesMentioned).toEqual({ numerator: 0, denominator: 2, rate: 0 })
    expect(overview.properties.map(row => row.mentionCoverage)).toEqual([
      { numerator: 0, denominator: 1, rate: 0 }, { numerator: 0, denominator: 1, rate: 0 },
    ])
  })

  it('does not call an answer negative when all its assigned properties have no mention identity', () => {
    const input = fixture()
    input.targets[1]!.aliases = []
    input.observations[0]!.answerText = 'Harbor Point is listed.'
    const overview = buildMeasurementOverview(input)
    expect(overview.mentionCoverage.reason).toBe('aliasless')
    expect(overview.propertiesMentioned).toEqual({ numerator: 1, denominator: 1, rate: 1 })
  })

  it('retains property reach when a separate assigned answer is ambiguous', () => {
    const input = fixture()
    input.usageEdges.push({ id: 'second-harbor', type: 'target', targetId: 'harbor', executionId: 'exec-loft' })
    input.observations[0]!.answerText = 'Harbor Point offers convenient service.'
    input.observations[1]!.answerText = 'Which Harbor Point do you mean?'
    const overview = buildMeasurementOverview(input)
    // The uncertain answer leaves the rate rather than blanking it: the one
    // attributable answer names Harbor Point, and one answer is left out.
    expect(overview.mentionCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1, unattributed: 1 })
    expect(overview.properties.map(row => row.mentionCoverage)).toEqual([
      { numerator: 1, denominator: 1, rate: 1, unattributed: 1 },
      { numerator: 0, denominator: 1, rate: 0 },
    ])
    expect(overview.propertiesMentioned).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
  })

  it.each([
    'Which Harbor Point are you asking about? There are several places.',
    'Harbor Point turns out to refer to several different places.',
    'Because Harbor Point can refer to a few different entities, here are the possibilities.',
    'Harbor Point is a name shared by several very different places.',
    'Which Harbor Point do you mean: Eastport or Westhaven?',
    'Which specific Harbor Point are you referring to?',
    'Which Harbor Point were you talking about?',
    'Which Harbor Point did you mean?',
    'Tell me which Harbor Point you mean.',
    'Let me know which Harbor Point you’re asking about.',
    'Tell me which Harbor Point you are referring to.',
  ])('preserves explicit identity uncertainty: %s', answer => {
    const input = fixture()
    input.observations[0]!.answerText = answer
    const evidence = buildMeasurementEvidence(input)
    expect(evidence.answers.find(row => row.usageEdgeId === 'edge-harbor')?.mentioned).toBeNull()
    expect(evidence.answers.find(row => row.usageEdgeId === 'edge-loft')?.mentioned).toBe(false)
    const overview = buildMeasurementOverview(input)
    // Harbor's only answer is uncertain, so its own rate has nothing to measure.
    expect(overview.properties[0]!.mentionCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'identity-ambiguous' })
    // The portfolio still measures the answer that could be attributed.
    expect(overview.mentionCoverage).toEqual({ numerator: 0, denominator: 1, rate: 0, unattributed: 1 })
  })

  it('preserves uncertainty for non-Latin property names', () => {
    const input = fixture()
    input.targets[0]!.aliases = ['海湾公寓']
    input.observations[0]!.answerText = 'Which 海湾公寓 do you mean?'
    expect(buildMeasurementEvidence(input).answers[0]!.mentioned).toBeNull()
    const overview = buildMeasurementOverview(input)
    expect(overview.properties[0]!.mentionCoverage.reason).toBe('identity-ambiguous')
    expect(overview.mentionCoverage).toEqual({ numerator: 0, denominator: 1, rate: 0, unattributed: 1 })
  })

  it.each([
    'Which Harbor Point amenity are you asking about?',
    'Which Harbor Point floor plan are you asking about?',
    'Which Harbor Point lease term do you mean?',
    'Tell me which Harbor Point floor plan you’re asking about.',
  ])('does not mistake a property attribute question for uncertain identity: %s', answer => {
    const input = fixture()
    input.observations[0]!.answerText = answer
    expect(buildMeasurementEvidence(input).answers[0]!.mentioned).toBe(true)
    expect(buildMeasurementOverview(input).mentionCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
  })

  it('does not infer uncertainty from a negative review or from several amenities', () => {
    const input = fixture()
    input.observations[0]!.answerText = 'Harbor Point offers several amenities but the service is terrible.'
    expect(buildMeasurementOverview(input).mentionCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
  })

  it('requires explicit qualified identity or its own cited URL when the frozen target requests it', () => {
    const input = fixture()
    input.targets[0]!.identityAliases = ['Harbor Point in Eastport']
    input.observations[0]!.answerText = 'Harbor Point has several amenities.'
    const mentioned = () => buildMeasurementEvidence(input).answers.find(row => row.usageEdgeId === 'edge-harbor')?.mentioned
    expect(mentioned()).toBeNull()
    input.observations[0]!.citedUrls = ['https://northstar.example/loft']
    expect(mentioned()).toBeNull()
    input.observations[0]!.citedUrls = ['https://northstar.example/harbor/details']
    expect(mentioned()).toBe(true)
    input.observations[0]!.citedUrls = []
    input.observations[0]!.answerText = 'Harbor Point in Eastport has poor service.'
    expect(mentioned()).toBe(true)
    input.observations[0]!.answerText = 'Which Harbor Point are you asking about? Harbor Point in Eastport or another one?'
    expect(mentioned()).toBeNull()
  })

  it('counts an identified property in a multi-entity discussion without accepting another entity’s source', () => {
    const input = fixture()
    input.observations[0]!.answerText = 'Harbor Point can refer to several places. Harbor Point has poor service.'
    const mentioned = () => buildMeasurementEvidence(input).answers[0]!.mentioned
    input.observations[0]!.citedUrls = ['https://other-property.example/harbor-point']
    expect(mentioned()).toBeNull()
    input.observations[0]!.citedUrls = ['https://northstar.example/']
    expect(mentioned()).toBeNull()
    input.observations[0]!.citedUrls = ['https://northstar.example/harbor/details']
    expect(mentioned()).toBe(true)
    input.observations[0]!.citedUrls = []
    input.targets[0]!.identityAliases = ['Harbor Point in Eastport']
    input.observations[0]!.answerText += ' Harbor Point in Eastport provides a community shuttle.'
    expect(mentioned()).toBe(true)
    input.observations[0]!.answerText = 'Which Harbor Point do you mean? Harbor Point in Eastport or Westhaven?'
    expect(mentioned()).toBeNull()
  })

  it('keeps compact attribution identical to detailed evidence, including uncertainty and partial positive citations', () => {
    const input = fixture()
    input.observations[0]!.answerText = 'Which Harbor Point do you mean?'
    // A sibling's page settles nothing about Harbor Point.
    input.observations[0]!.citedUrls = ['https://northstar.example/loft']
    input.observations[0]!.citedUrlsComplete = false
    const read = () => {
      const detailed = buildMeasurementEvidence(input).answers[0]!
      return { detailed, compact: buildMeasurementObservationSignals(input).find(row => row.observationId === detailed.observationId)! }
    }
    const uncertain = read()
    expect(uncertain.detailed).toMatchObject({ mentioned: null, cited: null, evidenceComplete: false })
    expect(uncertain.compact).toMatchObject({ mentionedTargetIds: [], unknownMentionTargetIds: ['harbor'], citedTargetIds: ['loft'], sourceComplete: false })

    // Its own page, captured before capture failed, is a positive citation
    // and settles which Harbor Point the answer meant.
    input.observations[0]!.citedUrls = ['https://northstar.example/harbor']
    const settled = read()
    expect(settled.detailed).toMatchObject({ mentioned: true, cited: true, evidenceComplete: false })
    expect(settled.compact).toMatchObject({ mentionedTargetIds: ['harbor'], unknownMentionTargetIds: [], citedTargetIds: ['harbor'], sourceComplete: false })
  })
})

/**
 * Harbor Point on twelve branded answers split across two engines: nine name
 * it, two do not, and one asks which Harbor Point was meant. Sail Loft keeps
 * its one answer, which names nothing.
 */
const HARBOR_ANSWERS = [
  ...Array.from({ length: 9 }, () => 'Harbor Point is a strong choice for families.'),
  'Several nearby communities are worth a visit.',
  'Nothing in particular stands out.',
  'Which Harbor Point do you mean? There are several places with that name.',
] as const

/**
 * The queries name only the brand, never the Property, so an answer asking
 * which Harbor Point was meant has nothing to settle it and stays unresolved.
 */
function brandedPopulation(answers: readonly string[] = HARBOR_ANSWERS): MeasurementOverviewInput {
  const input = fixture()
  const provider = (index: number) => index % 2 === 0 ? 'openai' : 'gemini'
  input.usageEdges = [
    ...answers.map((_, index) => ({ id: `edge-harbor-${index}`, type: 'target' as const, targetId: 'harbor', executionId: `exec-harbor-${index}`, queryClass: 'branded' as const })),
    { id: 'edge-loft', type: 'target', targetId: 'loft', executionId: 'exec-loft', queryClass: 'branded' },
  ]
  input.expectedSlots = [
    ...answers.map((_, index) => ({ id: `slot-harbor-${index}`, executionId: `exec-harbor-${index}`, queryText: 'is northstar a good landlord', provider: provider(index), location: null })),
    { id: 'slot-loft', executionId: 'exec-loft', queryText: 'northstar reviews', provider: 'openai', location: null },
  ]
  input.observations = [
    ...answers.map((answerText, index) => ({ id: `answer-harbor-${index}`, executionId: `exec-harbor-${index}`, queryText: 'is northstar a good landlord', provider: provider(index), location: null, answerText, citedUrls: [], citedUrlsComplete: true })),
    { id: 'answer-loft', executionId: 'exec-loft', queryText: 'northstar reviews', provider: 'openai', location: null, answerText: 'No recommendation today.', citedUrls: [], citedUrlsComplete: true },
  ]
  return input
}

describe('unattributable answers leave the mention rate instead of blanking it', () => {
  it('measures the attributable answers and counts the one it left out', () => {
    const overview = buildMeasurementOverview(brandedPopulation())
    const harbor = overview.properties.find(row => row.targetId === 'harbor')!
    // 9 of the 11 attributable answers; the uncertain twelfth is in neither side.
    expect(harbor.mentionCoverage).toEqual({ numerator: 9, denominator: 11, rate: 9 / 11, unattributed: 1 })
    expect(harbor.mentionCoverage.denominator! + harbor.mentionCoverage.unattributed!).toBe(HARBOR_ANSWERS.length)
    // Each engine is measured the same way over its own answers. Only gemini
    // received the uncertain answer, so only its row carries the count.
    expect(harbor.providers.map(row => [row.provider, row.mentionCoverage])).toEqual([
      ['gemini', { numerator: 4, denominator: 5, rate: 0.8, unattributed: 1 }],
      ['openai', { numerator: 5, denominator: 6, rate: 5 / 6 }],
    ])
    // Portfolio: Sail Loft's one answer is a measured negative and stays in.
    expect(overview.mentionCoverage).toEqual({ numerator: 9, denominator: 12, rate: 0.75, unattributed: 1 })
    expect(overview.properties.find(row => row.targetId === 'loft')!.mentionCoverage).toEqual({ numerator: 0, denominator: 1, rate: 0 })
    // Mention and citation stay independent: the excluded answer does not move citation's denominator.
    expect(overview.citationCoverage).toEqual({ numerator: 0, denominator: 13, rate: 0 })
  })

  it('never reads the unattributable answer as not mentioned', () => {
    const evidence = buildMeasurementEvidence(brandedPopulation()).answers
    expect(evidence.filter(row => row.mentioned === null).map(row => row.observationId)).toEqual(['answer-harbor-11'])
    expect(evidence.filter(row => row.mentioned === false).map(row => row.observationId).sort())
      .toEqual(['answer-harbor-10', 'answer-harbor-9', 'answer-loft'])
  })

  it('applies the same rule to the revision report', () => {
    const report = buildMeasurementReport(brandedPopulation())
    const harbor = report.targets.find(row => row.id === 'harbor')!
    expect(harbor.mentionCoverage).toEqual({ numerator: 9, denominator: 11, rate: 9 / 11, unattributed: 1 })
    expect(harbor.providers.map(row => [row.provider, row.mentionCoverage])).toEqual([
      ['gemini', { numerator: 4, denominator: 5, rate: 0.8, unattributed: 1 }],
      ['openai', { numerator: 5, denominator: 6, rate: 5 / 6 }],
    ])
  })

  it('stays unavailable when every answer is unattributable', () => {
    const input = brandedPopulation(['Which Harbor Point do you mean?', 'Harbor Point can refer to several different places.'])
    input.observations.find(row => row.id === 'answer-loft')!.answerText = 'Which Sail Loft are you asking about?'
    const unavailable = { numerator: null, denominator: null, rate: null, reason: 'identity-ambiguous' }
    const overview = buildMeasurementOverview(input)
    expect(overview.mentionCoverage).toEqual(unavailable)
    expect(overview.properties.map(row => row.mentionCoverage)).toEqual([unavailable, unavailable])
    expect(buildMeasurementReport(input).targets.map(row => row.mentionCoverage)).toEqual([unavailable, unavailable])
  })

  it('still withholds the rate when an answer is missing, whatever else is uncertain', () => {
    const input = brandedPopulation()
    input.observations = input.observations.filter(row => row.id !== 'answer-harbor-0')
    const overview = buildMeasurementOverview(input)
    expect(overview.mentionCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' })
    expect(overview.properties.find(row => row.targetId === 'harbor')!.mentionCoverage.reason).toBe('evidence-incomplete')
  })
})

/**
 * A branded query that names a brand-less Property, as stored: the frozen
 * execution asks about Harbor Point by name, every engine answers it, and
 * one engine replies only with a clarifying question.
 */
function clarifiedPopulation(queryText = 'is Harbor Point a good place to live'): MeasurementOverviewInput {
  const input = fixture()
  input.usageEdges = [
    { id: 'edge-harbor', type: 'target', targetId: 'harbor', executionId: 'exec-harbor', queryClass: 'branded' },
    { id: 'edge-loft', type: 'target', targetId: 'loft', executionId: 'exec-loft', queryClass: 'branded' },
  ]
  input.expectedSlots = [
    { id: 'slot-harbor-openai', executionId: 'exec-harbor', queryText, provider: 'openai', location: null },
    { id: 'slot-harbor-gemini', executionId: 'exec-harbor', queryText, provider: 'gemini', location: null },
    { id: 'slot-loft', executionId: 'exec-loft', queryText: 'northstar reviews', provider: 'openai', location: null },
  ]
  input.observations = [
    { id: 'answer-harbor-openai', executionId: 'exec-harbor', queryText, provider: 'openai', location: null, answerText: 'Harbor Point is popular with families.', citedUrls: [], citedUrlsComplete: true },
    { id: 'answer-harbor-gemini', executionId: 'exec-harbor', queryText, provider: 'gemini', location: null, answerText: 'Which Harbor Point do you mean? There are a few apartment communities with that name.', citedUrls: [], citedUrlsComplete: true },
    { id: 'answer-loft', executionId: 'exec-loft', queryText: 'northstar reviews', provider: 'openai', location: null, answerText: 'No recommendation today.', citedUrls: [], citedUrlsComplete: true },
  ]
  return input
}

describe('a clarifying question is settled by the Property\'s own page or by its branded query that names it', () => {
  const harborRate = (input: MeasurementOverviewInput) => buildMeasurementOverview(input).properties.find(row => row.targetId === 'harbor')!.mentionCoverage
  const clarifying = (input: MeasurementOverviewInput) => buildMeasurementEvidence(input).answers
    .find(row => row.observationId === 'answer-harbor-gemini' && row.usageEdgeId === 'edge-harbor')!

  it('names the Property when its branded query names it', () => {
    const input = clarifiedPopulation()
    expect(clarifying(input).mentioned).toBe(true)
    // Both answers count: 2 of 2, nothing left out.
    expect(harborRate(input)).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(buildMeasurementReport(input).targets.find(row => row.id === 'harbor')!.mentionCoverage).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(buildMeasurementObservationSignals(input).find(row => row.observationId === 'answer-harbor-gemini'))
      .toMatchObject({ mentionedTargetIds: ['harbor'], unknownMentionTargetIds: [] })
  })

  it('names the Property when the answer cites its own page, whatever the query', () => {
    const input = clarifiedPopulation('northstar apartments reviews')
    expect(clarifying(input).mentioned).toBeNull()
    expect(harborRate(input)).toEqual({ numerator: 1, denominator: 1, rate: 1, unattributed: 1 })

    input.observations[1]!.citedUrls = ['https://northstar.example/harbor/floor-plans']
    expect(clarifying(input)).toMatchObject({ mentioned: true, cited: true })
    expect(harborRate(input)).toEqual({ numerator: 2, denominator: 2, rate: 1 })
  })

  it('stays not checked when only a sibling\'s page is cited and the query does not name the Property', () => {
    const input = clarifiedPopulation('northstar apartments reviews')
    input.observations[1]!.citedUrls = ['https://northstar.example/loft']
    expect(clarifying(input).mentioned).toBeNull()
    expect(harborRate(input)).toEqual({ numerator: 1, denominator: 1, rate: 1, unattributed: 1 })
  })

  it('stays not checked when a non-brand query uses the Property\'s name as a place', () => {
    const input = clarifiedPopulation('best apartments near Harbor Point')
    // The same question is now a market query for both Properties: the name
    // reads as a neighbourhood, not as this Property.
    input.usageEdges = [
      { id: 'edge-harbor', type: 'target', targetId: 'harbor', executionId: 'exec-harbor', queryClass: 'non-brand' },
      { id: 'edge-loft-market', type: 'target', targetId: 'loft', executionId: 'exec-harbor', queryClass: 'non-brand' },
      { id: 'edge-loft', type: 'target', targetId: 'loft', executionId: 'exec-loft', queryClass: 'branded' },
    ]
    expect(clarifying(input).mentioned).toBeNull()
    expect(buildMeasurementObservationSignals(input).find(row => row.observationId === 'answer-harbor-gemini'))
      .toMatchObject({ mentionedTargetIds: [], unknownMentionTargetIds: ['harbor'] })
    // The clarifying answer leaves the rate: the plain mention is 1 of 1.
    expect(harborRate(input)).toEqual({ numerator: 1, denominator: 1, rate: 1, unattributed: 1 })
    const overview = buildMeasurementOverview(input)
    expect(overview.mentionCoverage).toMatchObject({ numerator: 1, denominator: 2, unattributed: 1 })
  })

  it('stays not checked on a schema v1 assignment, which records no query class', () => {
    const input = clarifiedPopulation()
    input.usageEdges = input.usageEdges.map(edge => edge.type === 'target' ? { ...edge, queryClass: null } : edge)
    expect(clarifying(input).mentioned).toBeNull()
  })

  it('gives nothing to a Property the query names but was not assigned', () => {
    const input = clarifiedPopulation()
    // The same execution now serves Sail Loft only.
    input.usageEdges = [
      { id: 'edge-loft-harbor-query', type: 'target', targetId: 'loft', executionId: 'exec-harbor', queryClass: 'non-brand' },
      { id: 'edge-loft', type: 'target', targetId: 'loft', executionId: 'exec-loft', queryClass: 'branded' },
    ]
    expect(buildMeasurementObservationSignals(input).find(row => row.observationId === 'answer-harbor-gemini'))
      .toMatchObject({ mentionedTargetIds: [], unknownMentionTargetIds: ['harbor'] })
  })

  it('reads the query with the longest-name rule, so a query naming a longer sibling name does not name the shorter one', () => {
    const input = clarifiedPopulation('is Harbor Point East a good place to live')
    input.targets = [
      ...input.targets,
      { id: 'east', label: 'Harbor Point East', aliases: ['Harbor Point East'], urls: [{ id: 'url-east', mode: 'prefix', host: 'northstar.example', path: '/east' }] },
    ]
    input.usageEdges.push({ id: 'edge-east', type: 'target', targetId: 'east', executionId: 'exec-harbor', queryClass: 'branded' })
    expect(clarifying(input).mentioned).toBeNull()
  })

  it('keeps the stricter rules for a "refers to several places" answer and for a Property with qualified names', () => {
    const several = clarifiedPopulation()
    several.observations[1]!.answerText = 'Harbor Point can refer to several different places.'
    expect(clarifying(several).mentioned).toBeNull()

    const qualified = clarifiedPopulation()
    qualified.targets[0]!.identityAliases = ['Harbor Point in Eastport']
    expect(clarifying(qualified).mentioned).toBeNull()
    qualified.observations[1]!.citedUrls = ['https://northstar.example/harbor']
    expect(clarifying(qualified).mentioned).toBe(true)
  })

  it('applies the same rule to a single stored answer read with its frozen query', () => {
    const read = createTargetMentionReader(fixture().targets, ['northstar.example'])
    const answer = 'Which Harbor Point do you mean?'
    const branded = { text: 'is Harbor Point a good place to live', brandedTargetIds: ['harbor'] }
    expect(read(answer, ['harbor'])).toBeNull()
    expect(read(answer, ['harbor'], [], branded)).toBe(true)
    expect(read(answer, ['loft'], [], branded)).toBe(false)
    expect(read(answer, ['harbor'], ['https://northstar.example/harbor'])).toBe(true)
    // A non-brand query containing the name settles nothing.
    expect(read(answer, ['harbor', 'loft'], [], { text: 'best apartments near Harbor Point', brandedTargetIds: [] })).toBeNull()
    expect(read(answer, ['harbor', 'loft'], [], { text: 'best apartments near Harbor Point', brandedTargetIds: ['loft'] })).toBeNull()
  })
})
