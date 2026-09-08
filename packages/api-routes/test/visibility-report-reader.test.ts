import { describe, expect, it } from 'vitest'
import {
  buildVisibilityReport,
  type VisibilityReportReaderInput,
} from '../src/visibility-report-reader.js'

const AT = '2026-09-04T12:00:00.000Z'

function input(overrides: Partial<VisibilityReportReaderInput> = {}): VisibilityReportReaderInput {
  return {
    mode: 'advanced',
    activeRevision: 2,
    pendingAssignmentCount: 0,
    selection: {
      queryClass: 'all',
      scope: 'project',
      location: { kind: 'all' },
      limit: 50,
    },
    activeDefinition: definition(2),
    runs: [run()],
    ...overrides,
  }
}

function definition(revision: number) {
  return {
    revision,
    provenance: { kind: 'frozen-advanced' as const, definitionRevision: revision },
    scopeOptions: [
      { id: 'project', label: 'Project', kind: 'project' as const, targetCount: 2 },
      { id: 'north', label: 'North', kind: 'property' as const, targetCount: 1 },
      { id: 'south', label: 'South', kind: 'property' as const, targetCount: 1 },
      { id: 'collection', label: 'Collection', kind: 'group' as const, targetCount: 2 },
      { id: 'alpha', label: 'Alpha', kind: 'market' as const, targetCount: 1 },
      { id: 'beta', label: 'Beta', kind: 'market' as const, targetCount: 1 },
    ],
    targets: [
      { id: 'north', label: 'North', mentionEligible: true },
      { id: 'south', label: 'South', mentionEligible: true },
    ],
    groups: [{ id: 'collection', label: 'Collection', targetKeys: ['north', 'south'] }],
    competitorAvailability: { state: 'available' as const },
    slots: [
      { id: 'alpha-slot', executionId: 'alpha-exec', queryKey: 'nearby:alpha', queryId: 'nearby', query: 'Best service nearby?', provider: 'openai', location: 'Alpha' },
      { id: 'beta-slot', executionId: 'beta-exec', queryKey: 'nearby:beta', queryId: 'nearby', query: 'Best service nearby?', provider: 'openai', location: 'Beta' },
      { id: 'brand-slot', executionId: 'brand-exec', queryKey: 'brand:alpha', queryId: 'brand', query: 'Is North reliable?', provider: 'openai', location: 'Alpha' },
    ],
    edges: [
      // Same Target, two contexts. A market must select exactly one of these.
      { id: 'north-alpha', executionId: 'alpha-exec', targetKey: 'north', queryId: 'nearby', queryClass: 'non-brand' as const, groupKeys: ['collection'], marketKeys: ['alpha'], competitorDomains: ['rival.example'] },
      { id: 'north-beta', executionId: 'beta-exec', targetKey: 'north', queryId: 'nearby', queryClass: 'non-brand' as const, groupKeys: ['collection'], marketKeys: ['beta'], competitorDomains: ['rival.example'] },
      { id: 'south-alpha', executionId: 'alpha-exec', targetKey: 'south', queryId: 'nearby', queryClass: 'unknown' as const, groupKeys: ['collection'], marketKeys: ['alpha'], competitorDomains: ['rival.example'] },
      { id: 'north-brand', executionId: 'brand-exec', targetKey: 'north', queryId: 'brand', queryClass: 'branded' as const, groupKeys: ['collection'], marketKeys: ['alpha'], competitorDomains: ['rival.example'] },
    ],
  }
}

function run(overrides: Partial<VisibilityReportReaderInput['runs'][number]> = {}) {
  return {
    id: 'run-2',
    createdAt: AT,
    completedAt: AT,
    state: 'measured' as const,
    probe: false,
    definition: definition(2),
    definitionId: 'v2',
    comparableDefinitionIds: [],
    modelFingerprint: 'openai:gpt-5',
    observations: [
      {
        slotId: 'alpha-slot', answerId: 'answer-alpha', model: 'gpt-5', answerText: 'North is recommended; Rival is also listed.',
        mentionedTargetKeys: ['north'], citedTargetKeys: ['north'], citationComplete: true,
        competitorMentionDomains: ['rival.example'], competitorCitationDomains: [], observedCompetitorNames: [],
        sources: ['https://north.example/alpha'], createdAt: AT,
      },
      {
        slotId: 'beta-slot', answerId: 'answer-beta', model: 'gpt-5', answerText: 'North is not named.',
        mentionedTargetKeys: [], citedTargetKeys: [], citationComplete: true,
        competitorMentionDomains: [], competitorCitationDomains: ['rival.example'], observedCompetitorNames: [],
        sources: ['https://rival.example/beta'], createdAt: AT,
      },
      {
        slotId: 'brand-slot', answerId: 'answer-brand', model: null, answerText: 'North is reliable.',
        mentionedTargetKeys: ['north'], citedTargetKeys: [], citationComplete: true,
        competitorMentionDomains: [], competitorCitationDomains: [], observedCompetitorNames: [],
        sources: [], createdAt: AT,
      },
    ],
    ...overrides,
  }
}

describe('buildVisibilityReport', () => {
  it('returns all classes as independent populations and never a pooled headline', () => {
    const report = buildVisibilityReport(input())

    expect(report.populations.map(population => population.queryClass)).toEqual(['branded', 'non-brand', 'unknown'])
    expect(report.populations.find(population => population.queryClass === 'non-brand')?.summary.mentionCoverage)
      .toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    expect(report.populations.find(population => population.queryClass === 'unknown')?.summary.mentionCoverage)
      .toEqual({ numerator: 0, denominator: 1, rate: 0 })
  })

  it('keeps a scoped Property denominator when a class has no assignment for one Property', () => {
    const report = buildVisibilityReport(input({
      selection: { queryClass: 'non-brand', scope: 'project', location: { kind: 'all' }, limit: 50 },
    }))
    const population = report.populations[0]!

    expect(population.summary.outcomes).toEqual({
      bothSignals: 1,
      mentionedOnly: 0,
      citedOnly: 0,
      neither: 0,
      notMeasured: 1,
      total: 2,
    })
    // The second Property has no non-brand assignment, so a reach percentage
    // would invent a measured zero. Its fixed scope population is instead
    // visible in the outcome partition and the unavailable server-owned rate.
    expect(population.summary.propertyReach)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' })
    expect(population.breakdown.properties).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'south', queryCount: 0 }),
    ]))
  })

  it('selects a market from exact frozen edge membership, not every edge for its Target', () => {
    const report = buildVisibilityReport(input({
      selection: { queryClass: 'non-brand', scope: 'market', scopeKey: 'alpha', location: { kind: 'all' }, limit: 50 },
    }))
    const population = report.populations[0]!

    expect(population.summary.answerCount).toBe(1)
    expect(population.queries.items.map(row => row.location)).toEqual(['Alpha'])
    expect(population.queries.total).toBe(1)
  })

  it('narrows a group’s shared-answer signals to the group’s own target edges', () => {
    const multiClass = run()
    multiClass.definition = {
      ...multiClass.definition,
      groups: [
        { id: 'north-only', label: 'North only', targetKeys: ['north'] },
        { id: 'south-only', label: 'South only', targetKeys: ['south'] },
      ],
      scopeOptions: [
        ...multiClass.definition.scopeOptions.filter(option => option.id !== 'collection'),
        { id: 'north-only', label: 'North only', kind: 'group', targetCount: 1 },
        { id: 'south-only', label: 'South only', kind: 'group', targetCount: 1 },
      ],
      // Both group edges intentionally share alpha's one answer. The old
      // aggregate group path would let South's mention make North look named.
      edges: multiClass.definition.edges.map(edge => {
        if (edge.id === 'north-alpha') return { ...edge, groupKeys: ['north-only'] }
        if (edge.id === 'south-alpha') return { ...edge, queryClass: 'non-brand' as const, groupKeys: ['south-only'] }
        return edge
      }),
    }
    multiClass.observations = multiClass.observations.map(observation => observation.slotId === 'alpha-slot'
      ? { ...observation, mentionedTargetKeys: ['south'] }
      : observation)

    const report = buildVisibilityReport(input({ runs: [multiClass] }))
    expect(report.populations.find(population => population.queryClass === 'non-brand')?.breakdown.groups)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'north-only',
          mentionCoverage: { numerator: 0, denominator: 2, rate: 0 },
        }),
      ]))
  })

  it('uses each frozen competitor identity only for its own group-local answers', () => {
    const twoGroups = run()
    twoGroups.definition = {
      ...twoGroups.definition,
      groups: [
        { id: 'north-group', label: 'North group', targetKeys: ['north'] },
        { id: 'south-group', label: 'South group', targetKeys: ['south'] },
      ],
      scopeOptions: [
        ...twoGroups.definition.scopeOptions.filter(option => option.id !== 'collection'),
        { id: 'north-group', label: 'North group', kind: 'group', targetCount: 1 },
        { id: 'south-group', label: 'South group', kind: 'group', targetCount: 1 },
      ],
      edges: twoGroups.definition.edges.map(edge => {
        if (edge.id === 'north-alpha') {
          return { ...edge, groupKeys: ['north-group'], competitorDomains: ['north-rival.example'] }
        }
        if (edge.id === 'north-beta') {
          return {
            ...edge,
            targetKey: 'south',
            groupKeys: ['south-group'],
            competitorDomains: ['south-rival.example'],
          }
        }
        return edge
      }),
    }
    twoGroups.observations = twoGroups.observations.map(observation => {
      if (observation.slotId === 'alpha-slot') {
        return { ...observation, competitorMentionDomains: ['north-rival.example'] }
      }
      if (observation.slotId === 'beta-slot') {
        return { ...observation, competitorMentionDomains: ['south-rival.example'], competitorCitationDomains: [] }
      }
      return observation
    })

    const report = buildVisibilityReport(input({
      runs: [twoGroups],
      selection: { queryClass: 'non-brand', scope: 'project', location: { kind: 'all' }, limit: 50 },
    }))

    expect(report.populations[0]!.competitors).toEqual([
      expect.objectContaining({
        domain: 'north-rival.example',
        answerCount: 1,
        mentionCoverage: { numerator: 1, denominator: 1, rate: 1 },
      }),
      expect.objectContaining({
        domain: 'south-rival.example',
        answerCount: 1,
        mentionCoverage: { numerator: 1, denominator: 1, rate: 1 },
      }),
    ])
  })

  it('does not infer a model: a model filter includes only exact observed evidence', () => {
    const report = buildVisibilityReport(input({
      selection: { queryClass: 'all', scope: 'project', model: 'gpt-5', location: { kind: 'all' }, limit: 50 },
    }))

    expect(report.filterOptions.models).toEqual([{ provider: 'openai', model: 'gpt-5' }])
    expect(report.populations.find(population => population.queryClass === 'branded')?.summary.answerCount).toBe(0)
    expect(report.populations.find(population => population.queryClass === 'non-brand')?.summary.answerCount).toBe(2)
  })

  it('fans one frozen execution edge into each provider slot without mixing providers', () => {
    const multipleProviders = run()
    multipleProviders.definition = {
      ...multipleProviders.definition,
      slots: [
        ...multipleProviders.definition.slots,
        {
          id: 'alpha-claude-slot', executionId: 'alpha-exec', queryKey: 'nearby:alpha', queryId: 'nearby',
          query: 'Best service nearby?', provider: 'claude', location: 'Alpha',
        },
      ],
    }
    multipleProviders.observations = [
      ...multipleProviders.observations,
      {
        slotId: 'alpha-claude-slot', answerId: 'answer-alpha-claude', model: 'claude-sonnet', answerText: 'North is recommended.',
        mentionedTargetKeys: ['north'], citedTargetKeys: [], citationComplete: true,
        competitorMentionDomains: [], competitorCitationDomains: [], observedCompetitorNames: [], sources: [], createdAt: AT,
      },
    ]

    const report = buildVisibilityReport(input({
      runs: [multipleProviders],
      selection: { queryClass: 'non-brand', scope: 'project', provider: 'claude', location: { kind: 'all' }, limit: 50 },
    }))

    expect(report.populations[0]!.summary.answerCount).toBe(1)
    expect(report.populations[0]!.queries.items).toEqual([
      expect.objectContaining({ provider: 'claude', model: 'claude-sonnet' }),
    ])
  })

  it('excludes probe runs even when a caller names their id', () => {
    const report = buildVisibilityReport(input({
      selection: { queryClass: 'non-brand', scope: 'project', runId: 'probe', location: { kind: 'all' }, limit: 50 },
      runs: [run({ id: 'probe', probe: true })],
    }))

    expect(report.selection.run.id).toBeNull()
    expect(report.selection.measurement.state).toBe('not-measured')
  })

  it('keeps answer text out of aggregate lists and returns it only for bounded query detail', () => {
    const aggregate = buildVisibilityReport(input({
      selection: { queryClass: 'non-brand', scope: 'project', location: { kind: 'all' }, limit: 50 },
    }))
    expect(aggregate.populations[0]!.evidence.items).toEqual([])

    const detail = buildVisibilityReport(input({
      selection: { queryClass: 'non-brand', scope: 'project', queryKey: 'nearby:alpha', location: { kind: 'all' }, limit: 50 },
    }))
    expect(detail.populations[0]!.evidence.items).toEqual([
      expect.objectContaining({ answerId: 'answer-alpha', answerText: 'North is recommended; Rival is also listed.' }),
    ])

    const idDetail = buildVisibilityReport(input({
      selection: { queryClass: 'non-brand', scope: 'project', queryId: 'nearby', location: { kind: 'all' }, limit: 50 },
    }))
    expect(idDetail.populations[0]!.evidence.items).toEqual([
      expect.objectContaining({ answerId: 'answer-alpha', answerText: null }),
      expect.objectContaining({ answerId: 'answer-beta', answerText: null }),
    ])
  })

  it('paginates query and evidence collections independently with selection-bound cursors', () => {
    const selection = {
      queryClass: 'non-brand' as const,
      scope: 'project' as const,
      queryId: 'nearby',
      location: { kind: 'all' as const },
      limit: 1,
    }
    const first = buildVisibilityReport(input({ selection }))
    const population = first.populations[0]!
    const queryCursor = population.queries.nextCursor
    const evidenceCursor = population.evidence.nextCursor
    expect(queryCursor).not.toBeNull()
    expect(evidenceCursor).not.toBeNull()

    const queryPage = buildVisibilityReport(input({ selection: { ...selection, cursor: queryCursor! } }))
    expect(queryPage.populations[0]!.queries.items.map(row => row.location)).toEqual(['Beta'])
    // A query cursor cannot accidentally page evidence; it remains its own
    // first page rather than rejecting the otherwise valid selection.
    expect(queryPage.populations[0]!.evidence.items.map(row => row.answerId)).toEqual(['answer-alpha'])

    const evidencePage = buildVisibilityReport(input({ selection: { ...selection, cursor: evidenceCursor! } }))
    expect(evidencePage.populations[0]!.evidence.items.map(row => row.answerId)).toEqual(['answer-beta'])
    expect(evidencePage.populations[0]!.queries.items.map(row => row.location)).toEqual(['Alpha'])
  })

  it('keeps a materially superseded run on its own frozen definition and breaks the trend', () => {
    const historicalDefinition = definition(1)
    historicalDefinition.edges = historicalDefinition.edges.filter(edge => edge.id !== 'south-alpha')
    const oldRun = run({
      id: 'run-1',
      createdAt: '2026-09-03T12:00:00.000Z',
      completedAt: '2026-09-03T12:00:00.000Z',
      definition: historicalDefinition,
      definitionId: 'v1',
      comparableDefinitionIds: [],
    })
    const active = definition(2)
    const report = buildVisibilityReport(input({
      activeRevision: 2,
      pendingAssignmentCount: 1,
      activeDefinition: active,
      runs: [oldRun],
      selection: { queryClass: 'all', scope: 'project', location: { kind: 'all' }, limit: 50 },
    }))

    expect(report.selection.revision).toBe(1)
    expect(report.selection.measurement).toMatchObject({ activeRevision: 2, measuredRevision: 1, awaitingSweep: true, pendingAssignmentCount: 1 })
    expect(report.populations.find(population => population.queryClass === 'unknown')?.summary.queryCount).toBe(0)
    expect(report.populations.find(population => population.queryClass === 'non-brand')?.trend[0]?.continuity)
      .toEqual({ state: 'first', comparedRunId: null })
  })

  it('preserves the label-only comparable chain but marks a model change as a break', () => {
    const first = run({
      id: 'run-1',
      createdAt: '2026-09-03T12:00:00.000Z',
      completedAt: '2026-09-03T12:00:00.000Z',
      definitionId: 'v1',
      comparableDefinitionIds: [],
    })
    const second = run({
      id: 'run-2',
      definitionId: 'v2',
      comparableDefinitionIds: ['v1'],
    })
    const report = buildVisibilityReport(input({ runs: [first, second] }))
    const trend = report.populations.find(population => population.queryClass === 'non-brand')!.trend

    expect(trend.map(point => point.continuity)).toEqual([
      { state: 'first', comparedRunId: null },
      { state: 'comparable', comparedRunId: 'run-1' },
    ])

    const modelBreak = buildVisibilityReport(input({ runs: [first, run({ definitionId: 'v2', comparableDefinitionIds: ['v1'], modelFingerprint: 'openai:gpt-6' })] }))
    expect(modelBreak.populations.find(population => population.queryClass === 'non-brand')!.trend[1]!.continuity)
      .toEqual({ state: 'model-changed', comparedRunId: 'run-1' })
  })

  it('keeps legacy simple history explicitly unknown instead of inferring a frozen non-brand class', () => {
    const simple = definition(1)
    simple.provenance = { kind: 'legacy-simple', definitionRevision: null }
    simple.revision = null
    simple.edges = simple.edges.map(edge => ({ ...edge, queryClass: 'unknown' as const }))
    const report = buildVisibilityReport(input({
      mode: 'simple',
      activeRevision: null,
      activeDefinition: simple,
      runs: [run({ definition: simple, definitionId: null, comparableDefinitionIds: [] })],
      selection: { queryClass: 'non-brand', scope: 'project', location: { kind: 'all' }, limit: 50 },
    }))

    expect(report.selection.provenance).toEqual({ kind: 'legacy-simple', definitionRevision: null })
    expect(report.populations[0]!.summary.queryCount).toBe(0)
  })

  it('applies search before query paging without changing the summary', () => {
    const base = buildVisibilityReport(input({
      selection: { queryClass: 'non-brand', scope: 'project', location: { kind: 'all' }, limit: 1 },
    }))
    const searched = buildVisibilityReport(input({
      selection: { queryClass: 'non-brand', scope: 'project', location: { kind: 'all' }, search: 'nearby', limit: 1 },
    }))

    expect(searched.populations[0]!.summary).toEqual(base.populations[0]!.summary)
    expect(searched.populations[0]!.queries.items).toHaveLength(1)
    expect(searched.populations[0]!.queries.items[0]!.query).toContain('nearby')
  })
})
