import { describe, expect, it } from 'vitest'

import {
  buildMeasurementOverview,
  buildMeasurementReport,
  classifyCitedUrl,
  normalizeMeasurementLocation,
  type MeasurementOverviewBuildOptions,
  type MeasurementOverviewInput,
  type MeasurementReportInput,
  type MeasurementTargetInput,
} from '../src/measurement-report.js'

/** Marks one observation's citation capture partial, leaving its answer text intact. */
function withPartialSources(ids: readonly string[]): Partial<MeasurementReportInput> {
  return {
    observations: baseInput().observations.map(observation => ids.includes(observation.id)
      ? { ...observation, citedUrlsComplete: false, historicalCitedUrlsComplete: false }
      : observation),
  }
}

const targets: MeasurementTargetInput[] = [
  {
    id: 'north',
    label: 'Northstar North',
    aliases: ['Northstar North', 'North'],
    urls: [{ id: 'north-url', mode: 'prefix', host: 'northstar.example', path: '/locations/north' }],
  },
  {
    id: 'harbor',
    label: 'Northstar Harbor',
    aliases: ['Northstar Harbor', 'Harbor'],
    urls: [{ id: 'harbor-url', mode: 'prefix', host: 'northstar.example', path: '/locations/harbor' }],
  },
  {
    id: 'shared-a',
    label: 'Shared A',
    aliases: ['Shared A'],
    urls: [{ id: 'shared-a-url', mode: 'prefix', host: 'northstar.example', path: '/shared' }],
  },
  {
    id: 'shared-b',
    label: 'Shared B',
    aliases: ['Shared B'],
    urls: [{ id: 'shared-b-url', mode: 'prefix', host: 'northstar.example', path: '/shared' }],
  },
]

function baseInput(overrides: Partial<MeasurementReportInput> = {}): MeasurementReportInput {
  return {
    revision: 7,
    ownedHosts: ['northstar.example'],
    projectBrandNames: ['Northstar'],
    projectDomain: 'northstar.example',
    targets,
    groups: [
      {
        id: 'north-region',
        label: 'North region',
        targetIds: ['north'],
        competitors: [{ domain: 'challenger.example', aliases: ['Challenger'] }],
      },
      {
        id: 'harbor-region',
        label: 'Harbor region',
        targetIds: ['north', 'harbor'],
        competitors: [{ domain: 'challenger.example', aliases: ['Challenger'] }],
      },
    ],
    expectedSlots: [
      { id: 'slot-openai', executionId: 'exec-shared', queryText: 'service near harbor', provider: 'openai', location: 'Harbor, EX' },
      { id: 'slot-gemini', executionId: 'exec-shared', queryText: 'service near harbor', provider: 'gemini', location: 'Harbor, EX' },
    ],
    usageEdges: [
      { id: 'baseline', type: 'baseline', executionId: 'exec-shared' },
      { id: 'north-edge', type: 'target', executionId: 'exec-shared', targetId: 'north' },
      { id: 'harbor-edge', type: 'target', executionId: 'exec-shared', targetId: 'harbor' },
    ],
    observations: [
      {
        id: 'observation-openai', executionId: 'exec-shared', queryText: 'service near harbor', provider: 'openai', location: 'Harbor, EX',
        answerText: 'Northstar Harbor and Challenger are comparable.',
        citedUrls: ['https://northstar.example/locations/harbor/details'], citedUrlsComplete: true,
      },
      {
        id: 'observation-gemini', executionId: null, queryText: 'service near harbor', provider: 'gemini', location: '  harbor,   ex ',
        answerText: 'Northstar North is another option.',
        citedUrls: null, citedUrlsComplete: false,
        historicalCitedUrls: ['https://northstar.example/locations/north'], historicalCitedUrlsComplete: true,
      },
    ],
    ...overrides,
  }
}

describe('attribution', () => {
  it('prefers exact over prefix over host and honors configured path case', () => {
    const routeTarget: MeasurementTargetInput = {
      id: 'route-target', label: 'Route target', aliases: [],
      urls: [
        { id: 'host', mode: 'host', host: 'northstar.example' },
        { id: 'prefix', mode: 'prefix', host: 'northstar.example', path: '/locations', pathCase: 'insensitive' },
        { id: 'exact', mode: 'exact', host: 'northstar.example', path: '/locations/Harbor' },
      ],
    }
    const edge = { id: 'route-edge', type: 'target' as const, executionId: 'exec', targetId: 'route-target' }

    expect(classifyCitedUrl('https://northstar.example/locations/Harbor', [routeTarget], [], edge))
      .toMatchObject({ classification: 'assigned', matchedUrlIds: ['exact'] })
    expect(classifyCitedUrl('https://northstar.example/locations/harbor/child', [routeTarget], [], edge))
      .toMatchObject({ classification: 'assigned', matchedUrlIds: ['prefix'] })
    expect(classifyCitedUrl('https://northstar.example/elsewhere', [routeTarget], [], edge))
      .toMatchObject({ classification: 'assigned', matchedUrlIds: ['host'] })
  })

  it('assigns all six stable attribution classes', () => {
    const targetEdge = { id: 'harbor-edge', type: 'target' as const, executionId: 'exec', targetId: 'harbor' }
    const cases = [
      ['https://northstar.example/locations/harbor/details', 'assigned'],
      ['https://northstar.example/locations/north', 'sibling'],
      ['https://northstar.example/unmapped', 'ownedUnmapped'],
      ['https://outside.example/article', 'external'],
      ['https://northstar.example/shared/article', 'ambiguous'],
      ['not a url', 'invalid'],
    ] as const

    expect(cases.map(([url]) => classifyCitedUrl(url, targets, ['northstar.example'], targetEdge).classification))
      .toEqual(cases.map(([, classification]) => classification))
  })

  it('classifies a matched URL relative to its target edge', () => {
    const url = 'https://northstar.example/locations/north'
    expect(classifyCitedUrl(url, targets, ['northstar.example'], {
      id: 'north-edge', type: 'target', executionId: 'exec', targetId: 'north',
    }).classification).toBe('assigned')
    expect(classifyCitedUrl(url, targets, ['northstar.example'], {
      id: 'harbor-edge', type: 'target', executionId: 'exec', targetId: 'harbor',
    }).classification).toBe('sibling')
  })

  it('keeps cached URL winners equivalent across assigned, sibling, and ambiguous edge projections', () => {
    const input: MeasurementReportInput = {
      revision: 1,
      ownedHosts: ['northstar.example'],
      projectBrandNames: ['Northstar'],
      projectDomain: 'northstar.example',
      targets,
      groups: [],
      expectedSlots: [{ id: 'slot', executionId: 'exec', queryText: 'query', provider: 'openai', location: null }],
      usageEdges: [
        { id: 'north', type: 'target', executionId: 'exec', targetId: 'north' },
        { id: 'harbor', type: 'target', executionId: 'exec', targetId: 'harbor' },
        { id: 'shared-a', type: 'target', executionId: 'exec', targetId: 'shared-a' },
      ],
      observations: [{
        id: 'observation', executionId: 'exec', queryText: 'query', provider: 'openai', location: null,
        answerText: 'Northstar Harbor',
        citedUrls: [
          'https://northstar.example/locations/harbor/details',
          'https://northstar.example/shared/article',
        ],
        citedUrlsComplete: true,
      }],
    }
    let uniqueSources = 0
    const report = buildMeasurementReport(input, { onSourceAttributionComputed: count => { uniqueSources = count } })
    const edges = new Map(input.usageEdges.map(edge => [edge.id, edge]))

    expect(uniqueSources).toBe(2)
    expect(report.evidence.map(row => row.classification)).toEqual([
      'assigned', 'ambiguous',
      'sibling', 'ambiguous',
      'sibling', 'ambiguous',
    ])
    for (const row of report.evidence) {
      expect(row.classification).toBe(classifyCitedUrl(
        row.sourceUrl,
        input.targets,
        input.ownedHosts,
        edges.get(row.usageEdgeId)!,
      ).classification)
    }
  })
})

describe('report kernel', () => {
  it('bridges a unique historical observation without a route or live provider read', () => {
    expect(normalizeMeasurementLocation('  Harbor,   EX ')).toBe('harbor, ex')

    const report = buildMeasurementReport(baseInput())

    expect(report.diagnostics.bridgedObservationIds).toEqual(['observation-gemini'])
    expect(report.evidence.find(row => row.observationId === 'observation-gemini')).toMatchObject({
      expectedSlotId: 'slot-gemini', bridged: true, historical: true,
    })
  })

  it('derives reporting-group population from target edges and deduplicates a shared execution', () => {
    const report = buildMeasurementReport(baseInput())
    const group = report.groups.find(candidate => candidate.id === 'harbor-region')!

    expect(group.completeness).toEqual({
      executed: 2, expected: 2, sourceCompleteObservations: 2, complete: true, sourceComplete: true, answerComplete: true,
    })
    expect(group.answerCoverage).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(group.targetCoverage).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(report.evidence.filter(row => row.usageEdgeType === 'target')).toHaveLength(4)
    expect(report.evidence.some(row => row.usageEdgeId === 'baseline')).toBe(true)
  })

  it('returns null numerator, denominator, and rate together for incomplete evidence', () => {
    const report = buildMeasurementReport(baseInput({ observations: [baseInput().observations[0]!] }))
    const group = report.groups.find(candidate => candidate.id === 'harbor-region')!

    expect(group.completeness).toMatchObject({ executed: 1, expected: 2, complete: false })
    expect(group.answerCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'incomplete' })
    expect(group.targetCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'incomplete' })
    expect(report.targets.find(target => target.id === 'harbor')?.mentionCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'incomplete' })
  })

  it('keeps every unavailable rate structurally null', () => {
    const evidenceIncomplete = buildMeasurementReport(baseInput(
      withPartialSources(['observation-openai', 'observation-gemini']),
    ))
    expect(evidenceIncomplete.groups.find(candidate => candidate.id === 'north-region')?.answerCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' })

    const noPopulation = buildMeasurementReport(baseInput({
      groups: [{ id: 'empty', label: 'Empty', targetIds: ['not-a-target'], competitors: [] }],
    }))
    expect(noPopulation.groups[0]?.answerCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'no-population' })

    const aliaslessTarget: MeasurementTargetInput = { id: 'aliasless', label: 'Aliasless', aliases: [], urls: [] }
    const aliasless = buildMeasurementReport(baseInput({
      targets: [...targets, aliaslessTarget],
      usageEdges: [...baseInput().usageEdges, { id: 'aliasless-edge', type: 'target', executionId: 'exec-shared', targetId: 'aliasless' }],
    }))
    expect(aliasless.targets.find(target => target.id === 'aliasless')?.mentionCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'aliasless' })
  })

  it('computes a source-dependent rate over the source-complete observations only', () => {
    const report = buildMeasurementReport(baseInput(withPartialSources(['observation-gemini'])))
    const harbor = report.groups.find(candidate => candidate.id === 'harbor-region')!
    const north = report.groups.find(candidate => candidate.id === 'north-region')!

    // Both slots executed; only the openai observation captured its citations in full.
    expect(harbor.completeness).toEqual({
      executed: 2, expected: 2, sourceCompleteObservations: 1, complete: true, sourceComplete: false, answerComplete: true,
    })
    // The openai observation cites the harbor target, so it counts under the harbor edge
    // and not under the north edge. The gemini row contributes to neither side of the ratio.
    expect(harbor.answerCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(north.answerCoverage).toEqual({ numerator: 0, denominator: 1, rate: 0 })
    expect(harbor.targetCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    expect(report.targets.find(target => target.id === 'harbor')?.citationCoverage)
      .toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(report.targets.find(target => target.id === 'north')?.citationCoverage)
      .toEqual({ numerator: 0, denominator: 1, rate: 0 })
  })

  it('exposes the partial basis next to every source-dependent rate', () => {
    const report = buildMeasurementReport(baseInput(withPartialSources(['observation-gemini'])))
    const harbor = report.groups.find(candidate => candidate.id === 'harbor-region')!

    // A reader can always tell a partial basis from a full one: sourceComplete is false and
    // the contributing count sits beside the executed count on the same completeness record.
    for (const status of [harbor.completeness, ...harbor.providers.map(provider => provider.completeness)]) {
      expect(status.sourceComplete).toBe(status.sourceCompleteObservations === status.executed)
    }
    expect(harbor.providers.map(provider => [
      provider.provider, provider.completeness.sourceCompleteObservations, provider.completeness.executed,
    ])).toEqual([['gemini', 0, 1], ['openai', 1, 1]])
    expect(report.diagnostics.evidenceIncompleteObservationIds).toEqual(['observation-gemini'])
    // The provider whose only observation is partial still has no basis at all.
    expect(harbor.providers.find(provider => provider.provider === 'gemini')?.answerCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' })
  })

  it('withholds a source-dependent rate only when no observation is source-complete', () => {
    const report = buildMeasurementReport(baseInput(withPartialSources(['observation-openai', 'observation-gemini'])))
    const group = report.groups.find(candidate => candidate.id === 'harbor-region')!

    expect(group.completeness).toEqual({
      executed: 2, expected: 2, sourceCompleteObservations: 0, complete: true, sourceComplete: false, answerComplete: true,
    })
    expect(group.answerCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' })
    expect(group.targetCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' })
    expect(report.targets.find(target => target.id === 'harbor')?.citationCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' })
  })

  it('still withholds an unexecuted population as incomplete when sources are also partial', () => {
    const partial = withPartialSources(['observation-openai']).observations ?? []
    const report = buildMeasurementReport(baseInput({
      observations: partial.filter(observation => observation.id === 'observation-openai'),
    }))
    const group = report.groups.find(candidate => candidate.id === 'harbor-region')!

    expect(group.completeness).toMatchObject({ executed: 1, expected: 2, complete: false, sourceCompleteObservations: 0 })
    expect(group.answerCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'incomplete' })
    expect(group.targetCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'incomplete' })
  })

  it('leaves answer-only metrics identical when citation capture is partial', () => {
    const answerOnly = (report: ReturnType<typeof buildMeasurementReport>) => ({
      sov: report.groups.map(group => ({ id: group.id, sov: group.sov })),
      answerComplete: report.groups.map(group => group.completeness.answerComplete),
      mentions: report.targets.map(target => ({
        id: target.id,
        mentionCoverage: target.mentionCoverage,
        providers: target.providers.map(provider => ({ provider: provider.provider, mentionCoverage: provider.mentionCoverage })),
      })),
    })

    const full = answerOnly(buildMeasurementReport(baseInput()))
    expect(answerOnly(buildMeasurementReport(baseInput(withPartialSources(['observation-gemini']))))).toEqual(full)
    expect(answerOnly(buildMeasurementReport(baseInput(
      withPartialSources(['observation-openai', 'observation-gemini']),
    )))).toEqual(full)
    expect(full.mentions.find(mention => mention.id === 'harbor')?.mentionCoverage)
      .toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
  })

  it('reproduces the fully captured numbers unchanged', () => {
    const report = buildMeasurementReport(baseInput())
    const harbor = report.groups.find(candidate => candidate.id === 'harbor-region')!
    const north = report.groups.find(candidate => candidate.id === 'north-region')!

    expect(harbor.answerCoverage).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(harbor.targetCoverage).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(north.answerCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    expect(north.targetCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(harbor.providers.map(provider => [provider.provider, provider.answerCoverage]))
      .toEqual([['gemini', { numerator: 1, denominator: 1, rate: 1 }], ['openai', { numerator: 1, denominator: 1, rate: 1 }]])
    expect(report.targets.find(target => target.id === 'harbor')?.citationCoverage)
      .toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    expect(report.targets.find(target => target.id === 'north')?.citationCoverage)
      .toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    expect(north.completeness.sourceCompleteObservations).toBe(2)
  })

  it('keeps project and competitor answer presence symmetric and revision-pinned', () => {
    const report = buildMeasurementReport(baseInput())
    const group = report.groups.find(candidate => candidate.id === 'north-region')!

    expect(group.sov.domains).toEqual([
      { domain: 'northstar.example', own: true, presentIn: 2, of: 2 },
      { domain: 'challenger.example', own: false, presentIn: 1, of: 2 },
    ])
    expect(group.sov.providers).toEqual([
      {
        provider: 'gemini',
        domains: [
          { domain: 'northstar.example', own: true, presentIn: 1, of: 1 },
          { domain: 'challenger.example', own: false, presentIn: 0, of: 1 },
        ],
      },
      {
        provider: 'openai',
        domains: [
          { domain: 'northstar.example', own: true, presentIn: 1, of: 1 },
          { domain: 'challenger.example', own: false, presentIn: 1, of: 1 },
        ],
      },
    ])

    const renamedTarget = buildMeasurementReport(baseInput({
      targets: targets.map(target => target.id === 'north' ? { ...target, label: 'Renamed target', aliases: ['Renamed target'] } : target),
    }))
    expect(renamedTarget.groups.find(candidate => candidate.id === 'north-region')?.sov.domains)
      .toEqual(group.sov.domains)
  })

  it('does not bridge an observation when its historical slot key is ambiguous', () => {
    const report = buildMeasurementReport(baseInput({
      expectedSlots: [
        ...baseInput().expectedSlots,
        { id: 'slot-gemini-duplicate', executionId: 'other-execution', queryText: 'service near harbor', provider: 'gemini', location: 'Harbor, EX' },
      ],
    }))

    expect(report.diagnostics.ambiguousObservationIds).toEqual(['observation-gemini'])
    expect(report.diagnostics.bridgedObservationIds).toEqual([])
  })

  it('withholds duplicate observations for one expected slot', () => {
    const duplicate = { ...baseInput().observations[0]!, id: 'observation-openai-duplicate' }
    const report = buildMeasurementReport(baseInput({ observations: [...baseInput().observations, duplicate] }))

    expect(report.diagnostics.ambiguousObservationIds).toEqual(['observation-openai', 'observation-openai-duplicate'])
    expect(report.evidence.some(row => row.expectedSlotId === 'slot-openai')).toBe(false)
  })

  it('uses the longest token-aware target alias and returns aliasless N/A', () => {
    const mentionTargets: MeasurementTargetInput[] = [
      { id: 'long', label: 'Long', aliases: ['Northstar Harbor'], urls: [] },
      { id: 'short', label: 'Short', aliases: ['Harbor'], urls: [] },
      { id: 'north', label: 'North', aliases: ['North'], urls: [] },
      { id: 'aliasless', label: 'Aliasless', aliases: [], urls: [] },
    ]
    const report = buildMeasurementReport({
      revision: 1, ownedHosts: ['northstar.example'], projectBrandNames: ['Northstar'], projectDomain: 'northstar.example',
      targets: mentionTargets, groups: [],
      expectedSlots: [{ id: 'slot', executionId: 'exec', queryText: 'query', provider: 'openai', location: null }],
      usageEdges: mentionTargets.map(target => ({ id: `edge-${target.id}`, type: 'target' as const, executionId: 'exec', targetId: target.id })),
      observations: [{
        id: 'observation', executionId: 'exec', queryText: 'query', provider: 'openai', location: null,
        answerText: 'Northstar Harbor is compared with North.', citedUrls: [], citedUrlsComplete: true,
      }],
    })

    expect(report.targets.find(target => target.id === 'long')?.mentionCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(report.targets.find(target => target.id === 'short')?.mentionCoverage).toEqual({ numerator: 0, denominator: 1, rate: 0 })
    expect(report.targets.find(target => target.id === 'north')?.mentionCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(report.targets.find(target => target.id === 'aliasless')?.mentionCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'aliasless' })
  })

  it('is deterministic when plan and observation collections are reordered', () => {
    const input = baseInput()
    const shuffled: MeasurementReportInput = {
      ...input,
      ownedHosts: [...input.ownedHosts].reverse(),
      targets: [...input.targets].reverse().map(target => ({ ...target, aliases: [...target.aliases].reverse(), urls: [...target.urls].reverse() })),
      groups: [...input.groups].reverse().map(group => ({ ...group, targetIds: [...group.targetIds].reverse(), competitors: [...group.competitors].reverse() })),
      expectedSlots: [...input.expectedSlots].reverse(),
      usageEdges: [...input.usageEdges].reverse(),
      observations: [...input.observations].reverse(),
    }

    expect(buildMeasurementReport(shuffled)).toEqual(buildMeasurementReport(input))
  })

  it('keeps a 225-target reporting denominator while attributing one shared source once', () => {
    const portfolioTargets: MeasurementTargetInput[] = Array.from({ length: 225 }, (_, index) => ({
      id: `target-${String(index).padStart(3, '0')}`,
      label: `Target ${index}`,
      aliases: [`Target ${index}`],
      urls: [{ id: `target-${index}-url`, mode: 'prefix', host: 'portfolio.example', path: `/targets/target-${index}` }],
    }))
    const targetIds = portfolioTargets.map(target => target.id)
    let uniqueSources = 0
    const report = buildMeasurementReport({
      revision: 1, ownedHosts: ['portfolio.example'], projectBrandNames: ['Portfolio'], projectDomain: 'portfolio.example',
      targets: portfolioTargets,
      groups: [{ id: 'portfolio', label: 'Portfolio', targetIds, competitors: [] }],
      expectedSlots: [{ id: 'slot', executionId: 'exec', queryText: 'query', provider: 'openai', location: null }],
      usageEdges: portfolioTargets.map(target => ({ id: `edge-${target.id}`, type: 'target' as const, executionId: 'exec', targetId: target.id })),
      observations: [{
        id: 'observation', executionId: 'exec', queryText: 'query', provider: 'openai', location: null,
        answerText: 'Target 199', citedUrls: ['https://portfolio.example/targets/target-199/details'], citedUrlsComplete: true,
      }],
    }, { onSourceAttributionComputed: count => { uniqueSources = count } })

    expect(report.groups[0]?.completeness).toMatchObject({ executed: 1, expected: 1, complete: true })
    expect(report.groups[0]?.targetCoverage).toEqual({ numerator: 1, denominator: 225, rate: 1 / 225 })
    expect(report.evidence.filter(row => row.usageEdgeType === 'target')).toHaveLength(225)
    expect(uniqueSources).toBe(1)
  })
})

function overviewInput(overrides: Partial<MeasurementOverviewInput> = {}): MeasurementOverviewInput {
  return { ...baseInput(), scopeTargetIds: ['north', 'harbor'], ...overrides }
}

describe('scoped overview', () => {
  it('counts a reused execution slot once however many properties share it', () => {
    const shared = buildMeasurementOverview(overviewInput())
    const single = buildMeasurementOverview(overviewInput({ scopeTargetIds: ['north'] }))

    // One execution answered for both properties. Two providers is two slots,
    // and adding the second property must not make it four.
    expect(shared.eligibleSlots).toBe(2)
    expect(shared.answeredSlots).toBe(2)
    expect(shared.mentionCoverage).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(single.eligibleSlots).toBe(2)
    expect(single.mentionCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
  })

  it('takes mention coverage over the answered slots rather than zeroing partial evidence', () => {
    const overview = buildMeasurementOverview(overviewInput({ observations: [baseInput().observations[0]!] }))

    expect(overview.eligibleSlots).toBe(2)
    expect(overview.answeredSlots).toBe(1)
    expect(overview.mentionCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
  })

  it('takes citation coverage over the source-complete slots only', () => {
    const overview = buildMeasurementOverview(overviewInput(withPartialSources(['observation-gemini'])))

    expect(overview.citationCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
  })

  it('withholds every metric with a reason instead of reporting zero', () => {
    const unanswered = buildMeasurementOverview(overviewInput({ observations: [] }))
    for (const metric of [
      unanswered.mentionCoverage,
      unanswered.citationCoverage,
      unanswered.brandPresence,
      unanswered.propertiesMentioned,
    ]) {
      expect(metric).toEqual({ numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' })
    }

    const unreached = buildMeasurementOverview(overviewInput({ scopeTargetIds: ['shared-a'] }))
    expect(unreached.eligibleSlots).toBe(0)
    expect(unreached.mentionCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'no-population' })

    const aliasless = buildMeasurementOverview(overviewInput({
      targets: [...targets, { id: 'aliasless', label: 'Aliasless', aliases: [], urls: [] }],
      usageEdges: [
        ...baseInput().usageEdges,
        { id: 'aliasless-edge', type: 'target', executionId: 'exec-shared', targetId: 'aliasless' },
      ],
      scopeTargetIds: ['aliasless'],
    }))
    expect(aliasless.mentionCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'aliasless' })
    expect(aliasless.propertiesMentioned).toEqual({ numerator: null, denominator: null, rate: null, reason: 'aliasless' })
  })

  it('reads brand presence as independent identity presence, not a shared denominator', () => {
    const overview = buildMeasurementOverview(overviewInput())

    // Both answers name the project and one also names a competitor. Presence is
    // per identity, so the competitor never subtracts from the project's rate.
    expect(overview.brandPresence).toEqual({ numerator: 2, denominator: 2, rate: 1 })
  })

  it('counts the properties mentioned at least once out of the mentionable ones', () => {
    expect(buildMeasurementOverview(overviewInput()).propertiesMentioned)
      .toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(buildMeasurementOverview(overviewInput({ scopeTargetIds: ['north'] })).propertiesMentioned)
      .toEqual({ numerator: 1, denominator: 1, rate: 1 })
  })

  it('sums one shared denominator of named presence credits', () => {
    const overview = buildMeasurementOverview(overviewInput({
      namedIdentities: [
        { key: 'project', aliases: ['Northstar'] },
        { key: 'challenger', aliases: ['Challenger'] },
      ],
    }))

    // The openai slot credits both identities, so the denominator counts named
    // presence credits rather than the two slots they were found in.
    expect(overview.namedShareOfVoice).toEqual({
      denominator: 3,
      entries: [
        { key: 'project', credits: 2, share: 2 / 3 },
        { key: 'challenger', credits: 1, share: 1 / 3 },
      ],
    })
  })

  it('leaves the named share absent when nothing named was found', () => {
    expect(buildMeasurementOverview(overviewInput()).namedShareOfVoice).toBeNull()
    expect(buildMeasurementOverview(overviewInput({
      namedIdentities: [{ key: 'absent', aliases: ['Absent Brand'] }],
    })).namedShareOfVoice).toBeNull()
  })

  it('flags the ambiguous attribution behind a property row', () => {
    const overview = buildMeasurementOverview(overviewInput({
      scopeTargetIds: ['shared-a', 'shared-b'],
      usageEdges: [
        ...baseInput().usageEdges,
        { id: 'shared-a-edge', type: 'target', executionId: 'exec-shared', targetId: 'shared-a' },
        { id: 'shared-b-edge', type: 'target', executionId: 'exec-shared', targetId: 'shared-b' },
      ],
      observations: [{ ...baseInput().observations[0]!, citedUrls: ['https://northstar.example/shared/article'] }],
    }))

    expect(overview.properties.map(row => [row.targetId, row.flags])).toEqual([['shared-a', 1], ['shared-b', 1]])
    expect(overview.flags).toBe(2)
  })

  it('indexes shared attribution evidence once before deriving every Property row', () => {
    const evidencePasses: number[] = []
    const options: MeasurementOverviewBuildOptions = {
      onEvidenceIndexed: rows => evidencePasses.push(rows),
    }

    const overview = buildMeasurementOverview(overviewInput(), options)

    // Two observations × three usage edges × one source URL. This asserts
    // deterministic structural work instead of a machine-dependent duration.
    expect(evidencePasses).toEqual([6])
    expect(overview.properties.map(row => row.targetId)).toEqual(['harbor', 'north'])
  })
})
