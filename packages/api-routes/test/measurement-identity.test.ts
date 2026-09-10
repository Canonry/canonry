import { describe, expect, it } from 'vitest'
import {
  buildMeasurementEvidence,
  buildMeasurementObservationSignals,
  buildMeasurementOverview,
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
    expect(overview.mentionCoverage.reason).toBe('identity-ambiguous')
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
    expect(overview.properties[0]!.mentionCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'identity-ambiguous' })
    expect(overview.mentionCoverage.reason).toBe('identity-ambiguous')
  })

  it('preserves uncertainty for non-Latin property names', () => {
    const input = fixture()
    input.targets[0]!.aliases = ['海湾公寓']
    input.observations[0]!.answerText = 'Which 海湾公寓 do you mean?'
    expect(buildMeasurementEvidence(input).answers[0]!.mentioned).toBeNull()
    expect(buildMeasurementOverview(input).mentionCoverage.reason).toBe('identity-ambiguous')
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
    input.observations[0]!.citedUrls = ['https://northstar.example/harbor']
    input.observations[0]!.citedUrlsComplete = false
    const detailed = buildMeasurementEvidence(input).answers[0]!
    const compact = buildMeasurementObservationSignals(input).find(row => row.observationId === detailed.observationId)!
    expect(detailed).toMatchObject({ mentioned: null, cited: true, evidenceComplete: false })
    expect(compact).toMatchObject({ mentionedTargetIds: [], unknownMentionTargetIds: ['harbor'], citedTargetIds: ['harbor'], sourceComplete: false })
  })
})
