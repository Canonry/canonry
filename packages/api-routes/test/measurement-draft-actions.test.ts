import { describe, expect, it } from 'vitest'
import {
  MEASUREMENT_DRAFT_MAX_ASSIGNMENTS,
  MEASUREMENT_DRAFT_MAX_AUTHORING_BYTES,
  MEASUREMENT_DRAFT_MAX_GROUPS,
  measurementDraftAuthoringSchema,
} from '@canonry/canonry-contracts'
import {
  applyAssignmentsToAuthoring,
  applyDraftAction,
  assertMeasurementDraftAuthoringLimits,
  replaceAssignmentsInAuthoring,
  resolveDraftAudience,
  routeMarketsInAuthoring,
} from '../src/measurement-draft-actions.js'
import { compileMeasurementDraft } from '../src/measurement-draft-compile.js'

function audienceFixture() {
  return measurementDraftAuthoringSchema.parse({
    defaultContext: { providers: ['gemini'], models: { gemini: 'gemini-test' }, locations: [] },
    targets: [
      { stableKey: 'dallas-1', label: 'Dallas One', status: 'included', aliases: [], urlMatchers: ['https://portfolio.example/dallas-1'], source: 'manual' },
      { stableKey: 'dallas-2', label: 'Dallas Two', status: 'included', aliases: [], urlMatchers: ['https://portfolio.example/dallas-2'], source: 'manual' },
      { stableKey: 'proposed-1', label: 'Proposed One', status: 'proposed', aliases: [], urlMatchers: ['https://portfolio.example/proposed-1'], source: 'manual' },
      { stableKey: 'excluded-1', label: 'Excluded One', status: 'excluded', aliases: [], urlMatchers: ['https://portfolio.example/excluded-1'], source: 'manual' },
    ],
    assignments: [],
    groups: [
      { stableKey: 'dallas', label: 'Dallas', targetKeys: ['dallas-1', 'dallas-2'], competitors: [] },
      { stableKey: 'luxury', label: 'Luxury', targetKeys: ['dallas-2'], competitors: [] },
      { stableKey: 'empty', label: 'Empty', targetKeys: [], competitors: [] },
      { stableKey: 'future', label: 'Future', targetKeys: ['proposed-1'], competitors: [] },
      { stableKey: 'retired', label: 'Retired', targetKeys: ['excluded-1'], competitors: [] },
      { stableKey: 'missing', label: 'Missing', targetKeys: ['unknown-1'], competitors: [] },
    ],
  })
}

const audienceContext = {
  brandNames: ['Example Portfolio'],
  queriesById: new Map([['q-market', 'best apartments downtown'], ['q-delivery', 'apartment delivery times']]),
}

describe('measurement draft assignment scale', () => {
  it.each(['apply-assignments', 'replace-assignments', 'apply-paired-assignments'] as const)(
    'preserves mutable locations when %s changes only the engine',
    (action) => {
      const dallas = { label: 'dallas', city: 'Dallas', region: 'TX', country: 'US', timezone: 'America/Chicago' }
      const austin = { label: 'austin', city: 'Austin', region: 'TX', country: 'US' }
      const route = 'openrouter:google/gemini-2.5-flash'
      for (const { locations, expected } of [
        { locations: ['dallas'], expected: [dallas] },
        { locations: [], expected: [null] },
        { locations: ['dallas', 'austin'], expected: [dallas, austin] },
      ]) {
        const authoring = audienceFixture()
        authoring.defaultContext.locations = ['austin']
        authoring.groups = []
        authoring.assignments = [{
          targetKey: 'dallas-1', queryId: 'q-market', queryClass: 'non-brand', classificationSource: 'operator',
          contextOverride: { providers: ['gemini'], locations },
        }]
        const selection = action === 'apply-paired-assignments'
          ? { pairs: [{ targetKey: 'dallas-1', queryId: 'q-market' }] }
          : { targetKeys: ['dallas-1'], queryIds: ['q-market'] }
        const changed = applyDraftAction(action, authoring, {
          ...selection, contextOverride: { providers: [route], models: {} },
        }, audienceContext)
        const compileContext = {
          canonicalDomain: 'portfolio.example', ownedDomains: [], brandNames: ['Example Portfolio'],
          locations: [dallas, austin], trackedQueries: [{ id: 'q-market', query: 'best apartments downtown' }],
        }
        const compiled = compileMeasurementDraft(changed.authoring, compileContext)
        expect(compiled.ok).toBe(true)
        if (!compiled.ok) throw new Error('Engine changes should preserve valid locations')
        expect(compiled.plan.executionNodes).toHaveLength(expected.length)
        expect(compiled.plan.executionNodes.map(node => node.context.location)).toEqual(expect.arrayContaining(expected))
        expect(compiled.plan.executionNodes.every(node => node.context.providers[0] === route)).toBe(true)

        // Explicit location changes, including a location-free request, still replace the old choice.
        const cleared = applyDraftAction(action, changed.authoring, {
          ...selection, contextOverride: { providers: ['gemini'], models: {}, locations: [] },
        }, audienceContext)
        const clearedPlan = compileMeasurementDraft(cleared.authoring, compileContext)
        expect(clearedPlan.ok).toBe(true)
        if (!clearedPlan.ok) throw new Error('Explicit location changes should compile')
        expect(clearedPlan.plan.executionNodes.map(node => node.context.location)).toEqual([null])
      }
    },
  )

  it.each(['apply-assignments', 'apply-paired-assignments'] as const)('keeps frozen contexts until %s explicitly replaces them', (action) => {
    const authoring = audienceFixture()
    authoring.assignments = [{
      targetKey: 'dallas-1', queryId: 'q-market', queryClass: 'non-brand', classificationSource: 'operator',
      executionContexts: [{ providers: ['openai'], models: {}, location: null, executionNodeKey: 'imported-context' }],
      queryProvenance: { source: 'research', sourceId: 'saved-test', capturedAt: '2026-08-01T00:00:00.000Z' },
    }]
    const selection = action === 'apply-assignments'
      ? { targetKey: 'dallas-1', queryIds: ['q-market'] }
      : { pairs: [{ targetKey: 'dallas-1', queryId: 'q-market' }] }
    const unchanged = applyDraftAction(action, authoring, selection, audienceContext)
    expect(unchanged.authoring.assignments).toEqual(authoring.assignments)
    const changed = applyDraftAction(action, authoring, {
      ...selection, contextOverride: { providers: ['gemini'], locations: [] },
    }, audienceContext)
    expect(changed.authoring.assignments[0]!.executionContexts).toBeUndefined()
    expect(changed.authoring.assignments[0]!.contextOverride).toEqual({ providers: ['gemini'], locations: [] })
    expect(changed.authoring.assignments[0]!.queryProvenance).toEqual(authoring.assignments[0]!.queryProvenance)
    expect(measurementDraftAuthoringSchema.safeParse(changed.authoring).success).toBe(true)
    expect(authoring.assignments[0]!.executionContexts).toHaveLength(1)
  })

  it.each(['apply-assignments', 'replace-assignments', 'apply-paired-assignments'] as const)(
    'reroutes frozen contexts without widening locations through %s',
    (action) => {
      const nyc = { label: 'nyc', city: 'New York', region: 'NY', country: 'US' }
      const la = { label: 'la', city: 'Los Angeles', region: 'CA', country: 'US' }
      const authoring = audienceFixture()
      authoring.assignments = [{
        targetKey: 'dallas-1', queryId: 'q-market', queryClass: 'non-brand', classificationSource: 'operator',
        executionContexts: [
          { providers: ['openai'], models: { openai: 'gpt-a' }, location: nyc, executionNodeKey: 'nyc-a' },
          { providers: ['openai'], models: { openai: 'gpt-b' }, location: nyc, executionNodeKey: 'nyc-b' },
          { providers: ['gemini'], models: { gemini: 'gemini-a' }, location: la, executionNodeKey: 'la-a' },
        ],
      }]
      authoring.reportingScopes = [{
        stableKey: 'primary-market', label: 'Primary market', kind: 'market',
        usageEdges: [
          { targetKey: 'dallas-1', queryId: 'q-market', executionNodeKey: 'nyc-a' },
          { targetKey: 'dallas-1', queryId: 'q-market', executionNodeKey: 'nyc-b' },
          { targetKey: 'dallas-1', queryId: 'q-market', executionNodeKey: 'la-a' },
        ],
      }]
      const route = 'openrouter:google/gemini-2.5-flash'
      const selection = action === 'apply-paired-assignments'
        ? { pairs: [{ targetKey: 'dallas-1', queryId: 'q-market' }] }
        : { targetKeys: ['dallas-1'], queryIds: ['q-market'] }
      const result = applyDraftAction(action, authoring, {
        ...selection,
        contextOverride: { providers: [route], models: { [route]: 'google/gemini-2.5-flash' } },
      }, audienceContext)

      const assignment = result.authoring.assignments[0]!
      expect(assignment.contextOverride).toBeUndefined()
      expect(assignment.executionContexts).toHaveLength(2)
      expect(assignment.executionContexts?.map(context => context.location)).toEqual([nyc, la])
      expect(assignment.executionContexts?.every(context => context.providers[0] === route)).toBe(true)
      expect(assignment.executionContexts?.every(context => context.executionNodeKey?.startsWith('execution-'))).toBe(true)
      expect(new Set(result.authoring.reportingScopes?.[0]?.usageEdges.map(edge => edge.executionNodeKey)).size).toBe(2)

      const compiled = compileMeasurementDraft({ ...result.authoring, groups: [] }, {
        canonicalDomain: 'portfolio.example', ownedDomains: [], brandNames: ['Example Portfolio'],
        locations: [nyc, la], trackedQueries: [{ id: 'q-market', query: 'best apartments downtown' }],
      })
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) throw new Error('Rerouted exact contexts should compile')
      expect(compiled.plan.executionNodes).toHaveLength(2)
      expect(compiled.plan.reportingScopes?.[0]?.usageEdges).toHaveLength(2)
    },
  )

  it('reroutes one Property without moving a shared execution edge on another Property or market', () => {
    const nyc = { label: 'nyc', city: 'New York', region: 'NY', country: 'US' }
    const authoring = audienceFixture()
    const frozen = { providers: ['openai'], models: { openai: 'gpt-4.1' }, location: nyc, executionNodeKey: 'shared-node' }
    authoring.assignments = ['dallas-1', 'dallas-2'].map(targetKey => ({
      targetKey, queryId: 'q-market', queryClass: 'non-brand' as const, classificationSource: 'operator' as const,
      executionContexts: [frozen],
    }))
    authoring.reportingScopes = [
      { stableKey: 'first-market', label: 'First', kind: 'market', usageEdges: [{ targetKey: 'dallas-1', queryId: 'q-market', executionNodeKey: 'shared-node' }] },
      { stableKey: 'second-market', label: 'Second', kind: 'market', usageEdges: [{ targetKey: 'dallas-2', queryId: 'q-market', executionNodeKey: 'shared-node' }] },
    ]

    const result = applyAssignmentsToAuthoring(authoring, {
      targetKeys: ['dallas-1'], queryIds: ['q-market'],
      contextOverride: { providers: ['gemini'], models: { gemini: 'gemini-test' } },
    }, audienceContext)
    const firstKey = result.authoring.assignments[0]!.executionContexts![0]!.executionNodeKey
    expect(firstKey).not.toBe('shared-node')
    expect(result.authoring.assignments[1]).toEqual(authoring.assignments[1])
    expect(result.authoring.reportingScopes?.[0]?.usageEdges[0]?.executionNodeKey).toBe(firstKey)
    expect(result.authoring.reportingScopes?.[1]?.usageEdges[0]?.executionNodeKey).toBe('shared-node')
  })

  it('preserves market membership for a one-to-one explicit location override', () => {
    const authoring = audienceFixture()
    authoring.assignments = [{
      targetKey: 'dallas-1', queryId: 'q-market', queryClass: 'non-brand', classificationSource: 'operator',
      executionContexts: [{ providers: ['openai'], models: {}, location: null, executionNodeKey: 'old-node' }],
    }]
    authoring.reportingScopes = [{
      stableKey: 'primary-market', label: 'Primary market', kind: 'market',
      usageEdges: [{ targetKey: 'dallas-1', queryId: 'q-market', executionNodeKey: 'old-node' }],
    }]

    const changed = applyAssignmentsToAuthoring(authoring, {
      targetKeys: ['dallas-1'], queryIds: ['q-market'],
      contextOverride: { providers: ['gemini'], models: { gemini: 'gemini-test' }, locations: [] },
    }, audienceContext)
    expect(changed.authoring.reportingScopes?.[0]?.usageEdges).toEqual(authoring.reportingScopes[0]!.usageEdges)

    const compiled = compileMeasurementDraft({ ...changed.authoring, groups: [] }, {
      canonicalDomain: 'portfolio.example', ownedDomains: [], brandNames: ['Example Portfolio'],
      locations: [], trackedQueries: [{ id: 'q-market', query: 'best apartments downtown' }],
    })
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) throw new Error('One-to-one context replacement should compile')
    expect(compiled.plan.reportingScopes?.[0]?.usageEdges).toHaveLength(1)
    expect(compiled.plan.reportingScopes?.[0]?.usageEdges[0]?.executionNodeKey).not.toBe('old-node')

    const routed = routeMarketsInAuthoring(changed.authoring, {
      marketKeys: ['primary-market'],
      contextOverride: { providers: ['openai'], models: { openai: 'gpt-test' } },
    }, audienceContext)
    expect(routed).toMatchObject({ matchedEdges: 1, changedEdges: 1 })
    expect(routed.authoring.assignments[0]?.contextOverride).toBeUndefined()
    expect(routed.authoring.assignments[0]?.executionContexts).toEqual([
      expect.objectContaining({ providers: ['openai'], models: { openai: 'gpt-test' }, location: null }),
    ])
    expect(routed.authoring.reportingScopes?.[0]?.usageEdges[0]?.executionNodeKey)
      .toBe(routed.authoring.assignments[0]?.executionContexts?.[0]?.executionNodeKey)
  })

  it('applies one query to 200 selected Targets without mutating the input', () => {
    const authoring = measurementDraftAuthoringSchema.parse({
      defaultContext: { providers: ['gemini'], models: { gemini: 'gemini-test' }, locations: [] },
      targets: Array.from({ length: 200 }, (_, index) => ({
        stableKey: `property-${String(index + 1).padStart(3, '0')}`,
        label: `Property ${String(index + 1).padStart(3, '0')}`,
        status: 'included',
        aliases: [],
        urlMatchers: [`https://portfolio.example/properties/${index + 1}`],
        source: 'manual',
      })),
      assignments: [],
      groups: [],
    })
    const targetKeys = authoring.targets.map(target => target.stableKey)

    const result = applyDraftAction(
      'apply-assignments',
      authoring,
      { targetKeys, queryIds: ['q-nearby'] },
      { brandNames: ['Example Portfolio'], queriesById: new Map([['q-nearby', 'apartments nearby']]) },
    )

    expect(result.authoring.assignments).toHaveLength(200)
    expect(new Set(result.authoring.assignments.map(assignment => assignment.targetKey))).toEqual(new Set(targetKeys))
    expect(authoring.assignments).toEqual([])
  })

  it('addresses mutation warnings by authoring path instead of prose', () => {
    const authoring = measurementDraftAuthoringSchema.parse({
      defaultContext: { providers: ['gemini'], locations: [] },
      targets: [{
        stableKey: 'property-001',
        label: 'Property 001',
        status: 'included',
        aliases: ['Property 001'],
        urlMatchers: ['https://portfolio.example/properties/1'],
        source: 'manual',
      }],
      assignments: [{
        targetKey: 'property-001',
        queryId: 'q-nearby',
        queryClass: 'non-brand',
        classificationSource: 'operator',
      }],
      groups: [],
    })
    const context = { brandNames: ['Example Portfolio'], queriesById: new Map([['q-nearby', 'apartments nearby']]) }

    expect(applyDraftAction('merge-targets', authoring, {
      targetKey: 'property-001',
      mergedKeys: ['property-001'],
    }, context).warnings).toEqual([
      expect.objectContaining({ code: 'merge-targets-noop', path: ['targets', 0] }),
    ])
    expect(applyDraftAction('exclude-target', authoring, {
      targetKey: 'property-001',
    }, context).warnings).toEqual([
      expect.objectContaining({ code: 'excluded-target-has-assignments', path: ['targets', 0, 'assignments'] }),
    ])
    expect(applyDraftAction('upsert-group', authoring, {
      group: {
        stableKey: 'group-target-stores',
        label: 'Target Stores',
        targetKeys: ['missing-property'],
        competitors: [],
      },
    }, context).warnings).toEqual([
      expect.objectContaining({ code: 'group-unknown-target', path: ['groups', 0, 'targetKeys'] }),
    ])
  })
})

describe('measurement draft assignment audiences', () => {
  it('resolves overlapping groups once and produces the same concrete assignments as explicit Targets', () => {
    const authoring = audienceFixture()
    const audience = resolveDraftAudience(authoring, { groupKeys: ['dallas', 'luxury'] })
    expect(audience).toEqual({
      targetKeys: ['dallas-1', 'dallas-2'],
      groups: [
        { groupKey: 'dallas', label: 'Dallas', memberCount: 2 },
        { groupKey: 'luxury', label: 'Luxury', memberCount: 1 },
      ],
      overlapCount: 1,
    })

    const viaGroups = applyAssignmentsToAuthoring(authoring, { groupKeys: ['dallas', 'luxury'], queryIds: ['q-market'] }, audienceContext)
    const explicit = applyAssignmentsToAuthoring(authoring, { targetKeys: ['dallas-1', 'dallas-2'], queryIds: ['q-market'] }, audienceContext)
    expect(viaGroups.authoring.assignments).toEqual(explicit.authoring.assignments)
    expect(viaGroups.assignments).toEqual({ requested: 2, added: 2, alreadyPresent: 0 })
  })

  it('names the invalid group before it calculates an assignment count', () => {
    const authoring = audienceFixture()
    expect(() => resolveDraftAudience(authoring, { groupKeys: ['empty'] })).toThrow(/Group "Empty"/)
    expect(() => resolveDraftAudience(authoring, { groupKeys: ['future'] })).toThrow(/Group "Future".*proposed/)
    expect(() => resolveDraftAudience(authoring, { groupKeys: ['retired'] })).toThrow(/Group "Retired".*excluded/)
    expect(() => resolveDraftAudience(authoring, { groupKeys: ['missing'] })).toThrow(/Group "Missing".*unknown Property/)
    expect(() => resolveDraftAudience(authoring, { groupKeys: ['not-a-group'] })).toThrow(/selected group is no longer available/i)
  })

  it('replaces only the named questions across their complete prior audience', () => {
    const authoring = audienceFixture()
    const first = applyAssignmentsToAuthoring(authoring, {
      targetKeys: ['dallas-1', 'dallas-2'],
      queryIds: ['q-market', 'q-delivery'],
    }, audienceContext)
    const replaced = replaceAssignmentsInAuthoring(first.authoring, {
      targetKeys: ['dallas-2'],
      queryIds: ['q-market'],
    }, audienceContext)
    expect(replaced.authoring.assignments.map(assignment => `${assignment.targetKey}/${assignment.queryId}`).sort()).toEqual([
      'dallas-1/q-delivery',
      'dallas-2/q-delivery',
      'dallas-2/q-market',
    ])
  })

  it('preserves surviving operator classifications and context overrides during replacement', () => {
    const authoring = audienceFixture()
    const original = {
      targetKey: 'dallas-1',
      queryId: 'q-market',
      contextOverride: { providers: ['gemini'] },
      queryClass: 'branded' as const,
      classificationSource: 'operator' as const,
    }
    const withAssignments = {
      ...authoring,
      assignments: [
        original,
        { ...original, targetKey: 'dallas-2', contextOverride: { providers: ['openai'] } },
      ],
    }

    const unchanged = replaceAssignmentsInAuthoring(withAssignments, {
      targetKeys: ['dallas-2', 'dallas-1'],
      queryIds: ['q-market'],
    }, audienceContext)
    expect(unchanged.authoring.assignments).toEqual(withAssignments.assignments)

    const narrowed = replaceAssignmentsInAuthoring(withAssignments, {
      targetKeys: ['dallas-1'],
      queryIds: ['q-market'],
    }, audienceContext)
    expect(narrowed.authoring.assignments).toEqual([original])
  })

  it('keeps additive reapply a no-op at the authoring level', () => {
    const authoring = audienceFixture()
    const once = applyAssignmentsToAuthoring(authoring, { groupKeys: ['dallas'], queryIds: ['q-market'] }, audienceContext)
    const twice = applyAssignmentsToAuthoring(once.authoring, { groupKeys: ['dallas'], queryIds: ['q-market'] }, audienceContext)
    expect(twice.assignments).toEqual({ requested: 2, added: 0, alreadyPresent: 2 })
    expect(twice.authoring).toEqual(once.authoring)
  })
})

describe('measurement draft market routing', () => {
  const nyc = { label: 'nyc', city: 'New York', region: 'NY', country: 'US' }
  const la = { label: 'la', city: 'Los Angeles', region: 'CA', country: 'US' }

  function marketAuthoring() {
    const authoring = audienceFixture()
    authoring.assignments = [{
      targetKey: 'dallas-1', queryId: 'q-market', queryClass: 'non-brand', classificationSource: 'operator',
      executionContexts: [
        { providers: ['openai'], models: { openai: 'gpt-4.1' }, location: nyc, executionNodeKey: 'shared-nyc' },
        { providers: ['openai'], models: { openai: 'gpt-4.1' }, location: la, executionNodeKey: 'north-la' },
      ],
    }]
    authoring.reportingScopes = [
      {
        stableKey: 'north', label: 'North', kind: 'market',
        usageEdges: [
          { targetKey: 'dallas-1', queryId: 'q-market', executionNodeKey: 'shared-nyc' },
          { targetKey: 'dallas-1', queryId: 'q-market', executionNodeKey: 'north-la' },
        ],
      },
      {
        stableKey: 'enterprise', label: 'Enterprise', kind: 'market',
        usageEdges: [{ targetKey: 'dallas-1', queryId: 'q-market', executionNodeKey: 'shared-nyc' }],
      },
    ]
    return authoring
  }

  it('clones a shared edge, rewrites an exclusive edge, and preserves every exact location', () => {
    const route = 'openrouter:google/gemini-2.5-flash'
    const result = routeMarketsInAuthoring(marketAuthoring(), {
      marketKeys: ['north'],
      contextOverride: { providers: [route], models: { [route]: 'google/gemini-2.5-flash' } },
    }, audienceContext)

    expect(result.markets).toEqual([{ marketKey: 'north', label: 'North', matchedEdges: 2, changedEdges: 2 }])
    expect(result.matchedEdges).toBe(2)
    expect(result.changedEdges).toBe(2)
    const contexts = result.authoring.assignments[0]!.executionContexts!
    expect(contexts).toHaveLength(3)
    expect(contexts).toContainEqual(expect.objectContaining({ executionNodeKey: 'shared-nyc', location: nyc, providers: ['openai'] }))
    expect(contexts.filter(context => context.providers[0] === route).map(context => context.location)).toEqual([nyc, la])

    const northKeys = result.authoring.reportingScopes?.find(scope => scope.stableKey === 'north')!.usageEdges.map(edge => edge.executionNodeKey)
    expect(northKeys).toHaveLength(2)
    expect(northKeys).not.toContain('shared-nyc')
    expect(northKeys).not.toContain('north-la')
    expect(result.authoring.reportingScopes?.find(scope => scope.stableKey === 'enterprise')!.usageEdges)
      .toEqual([{ targetKey: 'dallas-1', queryId: 'q-market', executionNodeKey: 'shared-nyc' }])

    const compiled = compileMeasurementDraft({ ...result.authoring, groups: [] }, {
      canonicalDomain: 'portfolio.example', ownedDomains: [], brandNames: ['Example Portfolio'],
      locations: [nyc, la], trackedQueries: [{ id: 'q-market', query: 'best apartments downtown' }],
    })
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) throw new Error('Market-routed exact contexts should compile')
    expect(compiled.plan.executionNodes).toHaveLength(3)
    expect(compiled.plan.reportingScopes?.find(scope => scope.stableKey === 'north')?.usageEdges).toHaveLength(2)
    expect(compiled.plan.reportingScopes?.find(scope => scope.stableKey === 'enterprise')?.usageEdges)
      .toEqual([{ targetKey: 'dallas-1', queryId: 'q-market', executionNodeKey: 'shared-nyc' }])
  })

  it('validates market, Property, and query filters and leaves a valid non-match as a no-op', () => {
    const request = { marketKeys: ['north'], contextOverride: { providers: ['gemini'] } }
    expect(() => routeMarketsInAuthoring(marketAuthoring(), { ...request, marketKeys: ['missing'] }, audienceContext)).toThrow(/market.*no longer available/i)
    expect(() => routeMarketsInAuthoring(marketAuthoring(), { ...request, targetKeys: ['missing'] }, audienceContext)).toThrow(/Target/i)
    expect(() => routeMarketsInAuthoring(marketAuthoring(), { ...request, queryIds: ['missing'] }, audienceContext)).toThrow(/project has no query/i)
    const noMatch = routeMarketsInAuthoring(marketAuthoring(), { ...request, targetKeys: ['dallas-2'] }, audienceContext)
    expect(noMatch).toMatchObject({ matchedEdges: 0, changedEdges: 0 })
    expect(noMatch.authoring).toEqual(marketAuthoring())
  })

  it.each([
    ['replace-assignments', { targetKeys: ['dallas-2'], queryIds: ['q-market'] }],
    ['remove-assignment', { targetKey: 'dallas-1', queryId: 'q-market' }],
    ['clear-assignments', { targetKey: 'dallas-1' }],
    ['exclude-target', { targetKey: 'dallas-1', cleanup: 'assignments-and-group-memberships' }],
  ] as const)('prunes stale market membership after %s so routing remains usable', (action, request) => {
    const changed = applyDraftAction(action, marketAuthoring(), request, audienceContext)
    expect(changed.authoring.reportingScopes?.flatMap(scope => scope.usageEdges)).toEqual([])

    const routed = routeMarketsInAuthoring(changed.authoring, {
      marketKeys: ['north'],
      contextOverride: { providers: ['gemini'], models: { gemini: 'gemini-test' } },
    }, audienceContext)
    expect(routed).toMatchObject({ matchedEdges: 0, changedEdges: 0 })
    expect(routed.authoring.reportingScopes?.flatMap(scope => scope.usageEdges)).toEqual([])
  })

  it('remaps market membership when merging an assigned Property into the survivor', () => {
    const authoring = marketAuthoring()
    authoring.assignments.push({
      targetKey: 'dallas-2', queryId: 'q-market', queryClass: 'branded', classificationSource: 'operator',
      executionContexts: [{ providers: ['gemini'], models: { gemini: 'gemini-test' }, location: null, executionNodeKey: 'survivor-node' }],
    })
    authoring.reportingScopes![1]!.usageEdges.push({
      targetKey: 'dallas-2', queryId: 'q-market', executionNodeKey: 'survivor-node',
    })

    const merged = applyDraftAction('merge-targets', authoring, {
      targetKey: 'dallas-2',
      mergedKeys: ['dallas-1'],
    }, audienceContext)
    expect(merged.authoring.assignments).toEqual([
      expect.objectContaining({ targetKey: 'dallas-2', queryId: 'q-market' }),
    ])
    expect(merged.authoring.reportingScopes?.flatMap(scope => scope.usageEdges).every(edge => edge.targetKey === 'dallas-2')).toBe(true)
    const exactKeys = new Set(merged.authoring.assignments[0]!.executionContexts?.map(context => context.executionNodeKey))
    expect(merged.authoring.reportingScopes?.flatMap(scope => scope.usageEdges).every(edge => exactKeys.has(edge.executionNodeKey))).toBe(true)
    expect(merged.authoring.assignments[0]).toMatchObject({ queryClass: 'branded', classificationSource: 'operator' })

    const routed = routeMarketsInAuthoring(merged.authoring, {
      marketKeys: ['north'],
      contextOverride: { providers: ['gemini'], models: { gemini: 'gemini-test' } },
    }, audienceContext)
    expect(routed).toMatchObject({ matchedEdges: 2, changedEdges: 2 })
  })

  it.each(['dynamic-first', 'exact-first'] as const)(
    'rejects a mixed exact/dynamic duplicate merge in %s assignment order',
    (order) => {
      const authoring = audienceFixture()
      const dynamic = {
        targetKey: 'dallas-1', queryId: 'q-market', queryClass: 'non-brand' as const, classificationSource: 'operator' as const,
        contextOverride: { providers: ['gemini'], locations: [] },
      }
      const exact = {
        targetKey: 'dallas-2', queryId: 'q-market', queryClass: 'non-brand' as const, classificationSource: 'operator' as const,
        executionContexts: [{ providers: ['openai'], models: {}, location: null, executionNodeKey: 'absorbed-exact' }],
      }
      authoring.assignments = order === 'dynamic-first' ? [dynamic, exact] : [exact, dynamic]
      authoring.reportingScopes = [{
        stableKey: 'absorbed-market', label: 'Absorbed market', kind: 'market',
        usageEdges: [{ targetKey: 'dallas-2', queryId: 'q-market', executionNodeKey: 'absorbed-exact' }],
      }]

      expect(() => applyDraftAction('merge-targets', authoring, {
        targetKey: 'dallas-1', mergedKeys: ['dallas-2'],
      }, audienceContext)).toThrow(/exact and editable execution contexts/i)
      expect(authoring.reportingScopes[0]!.usageEdges[0]).toEqual({
        targetKey: 'dallas-2', queryId: 'q-market', executionNodeKey: 'absorbed-exact',
      })
    },
  )

  it.each(['survivor-first', 'absorbed-first'] as const)(
    'rejects differing editable duplicate contexts in %s assignment order',
    (order) => {
      const authoring = audienceFixture()
      const survivor = {
        targetKey: 'dallas-1', queryId: 'q-market', queryClass: 'non-brand' as const, classificationSource: 'operator' as const,
        contextOverride: { providers: ['gemini'], models: { gemini: 'gemini-test' }, locations: [] },
      }
      const absorbed = {
        targetKey: 'dallas-2', queryId: 'q-market', queryClass: 'non-brand' as const, classificationSource: 'operator' as const,
        contextOverride: { providers: ['openai'], models: { openai: 'gpt-test' }, locations: [] },
      }
      authoring.assignments = order === 'survivor-first' ? [survivor, absorbed] : [absorbed, survivor]

      expect(() => applyDraftAction('merge-targets', authoring, {
        targetKey: 'dallas-1', mergedKeys: ['dallas-2'],
      }, audienceContext)).toThrow(/editable execution contexts differ/i)
    },
  )

  it('allows duplicate editable assignments whose effective contexts are equivalent', () => {
    const authoring = audienceFixture()
    authoring.defaultContext.locations = ['nyc', 'la']
    authoring.assignments = [
      {
        targetKey: 'dallas-1', queryId: 'q-market', queryClass: 'non-brand', classificationSource: 'operator',
      },
      {
        targetKey: 'dallas-2', queryId: 'q-market', queryClass: 'non-brand', classificationSource: 'operator',
        contextOverride: { providers: ['gemini'], models: { gemini: 'gemini-test' }, locations: ['la', 'nyc'] },
      },
    ]
    const merged = applyDraftAction('merge-targets', authoring, {
      targetKey: 'dallas-1', mergedKeys: ['dallas-2'],
    }, audienceContext)
    expect(merged.authoring.assignments).toHaveLength(1)
  })

  it('self-heals stale market edges already stored in a draft and excludes them from preview counts', () => {
    const stale = marketAuthoring()
    stale.assignments = []

    const routed = routeMarketsInAuthoring(stale, {
      marketKeys: ['north'],
      contextOverride: { providers: ['gemini'], models: { gemini: 'gemini-test' } },
    }, audienceContext)
    expect(routed).toMatchObject({
      markets: [{ marketKey: 'north', label: 'North', matchedEdges: 2, changedEdges: 2 }],
      matchedEdges: 2,
      changedEdges: 2,
    })
    expect(routed.authoring.reportingScopes?.flatMap(scope => scope.usageEdges)).toEqual([])
  })
})

describe('measurement draft authoring ceilings', () => {
  it('refuses group, assignment, and serialized authoring growth past each global ceiling', () => {
    const before = audienceFixture()
    expect(() => assertMeasurementDraftAuthoringLimits(before, {
      ...before,
      groups: Array.from({ length: MEASUREMENT_DRAFT_MAX_GROUPS + 1 }, (_, index) => ({
        stableKey: `group-${index}`,
        label: `Group ${index}`,
        targetKeys: [],
        competitors: [],
      })),
    })).toThrow(/groups limit exceeded/i)

    expect(() => assertMeasurementDraftAuthoringLimits(before, {
      ...before,
      assignments: Array.from({ length: MEASUREMENT_DRAFT_MAX_ASSIGNMENTS + 1 }, (_, index) => ({
        targetKey: 'dallas-1',
        queryId: `q-${index}`,
        queryClass: 'non-brand' as const,
        classificationSource: 'rule' as const,
      })),
    })).toThrow(/assignments limit exceeded/i)

    expect(() => assertMeasurementDraftAuthoringLimits(before, {
      ...before,
      defaultContext: {
        ...before.defaultContext,
        models: { oversized: 'x'.repeat(MEASUREMENT_DRAFT_MAX_AUTHORING_BYTES) },
      },
    })).toThrow(/authoring size limit exceeded/i)
  })
})

describe('pairing a question to the Property it names', () => {
  /** 40 Properties, each with a question generated from its own name. */
  function portfolio(size: number) {
    return measurementDraftAuthoringSchema.parse({
      defaultContext: { providers: ['gemini'], models: { gemini: 'gemini-test' }, locations: [] },
      targets: Array.from({ length: size }, (_, index) => ({
        stableKey: `property-${String(index + 1).padStart(3, '0')}`,
        label: `Harbour ${String(index + 1).padStart(3, '0')}`,
        status: 'included',
        aliases: [],
        urlMatchers: [`https://portfolio.example/properties/${index + 1}`],
        source: 'manual',
      })),
      assignments: [],
      groups: [],
    })
  }

  function generatedQuestions(size: number) {
    return new Map(Array.from({ length: size }, (_, index) => [
      `q-${index + 1}`,
      `is Harbour ${String(index + 1).padStart(3, '0')} a good place to live`,
    ]))
  }

  const context = (size: number) => ({
    brandNames: ['Example Portfolio'],
    queriesById: generatedQuestions(size),
  })

  it('produces one assignment per pair, not the cross product', () => {
    const size = 40
    const authoring = portfolio(size)
    const pairs = authoring.targets.map((target, index) => ({
      targetKey: target.stableKey,
      queryId: `q-${index + 1}`,
    }))

    const result = applyDraftAction('apply-paired-assignments', authoring, { pairs }, context(size))

    // The cross product of the same inputs would be 1,600.
    expect(result.authoring.assignments).toHaveLength(size)
    for (const assignment of result.authoring.assignments) {
      const index = Number(assignment.queryId.replace('q-', ''))
      expect(assignment.targetKey).toBe(`property-${String(index).padStart(3, '0')}`)
    }
  })

  it('classifies a question naming its own Property as branded', () => {
    const authoring = portfolio(3)
    const result = applyDraftAction(
      'apply-paired-assignments',
      authoring,
      { pairs: [{ targetKey: 'property-001', queryId: 'q-1' }] },
      context(3),
    )
    // "Harbour 001" is not a project brand name; the Property's own label is
    // what makes this branded.
    expect(result.authoring.assignments[0]!.queryClass).toBe('branded')
  })

  it('leaves a question that names no Property as non-brand', () => {
    const authoring = portfolio(3)
    const result = applyDraftAction(
      'apply-paired-assignments',
      authoring,
      { pairs: [{ targetKey: 'property-001', queryId: 'q-market' }] },
      { brandNames: ['Example Portfolio'], queriesById: new Map([['q-market', 'best apartments downtown']]) },
    )
    expect(result.authoring.assignments[0]!.queryClass).toBe('non-brand')
  })

  it('is idempotent: re-applying the same pairs does not duplicate', () => {
    const size = 10
    const authoring = portfolio(size)
    const pairs = authoring.targets.map((target, index) => ({
      targetKey: target.stableKey,
      queryId: `q-${index + 1}`,
    }))
    const once = applyDraftAction('apply-paired-assignments', authoring, { pairs }, context(size))
    const twice = applyDraftAction('apply-paired-assignments', once.authoring, { pairs }, context(size))
    expect(twice.authoring.assignments).toHaveLength(size)
  })

  it('refuses a pair naming a Property that does not exist', () => {
    expect(() => applyDraftAction(
      'apply-paired-assignments',
      portfolio(3),
      { pairs: [{ targetKey: 'property-999', queryId: 'q-1' }] },
      context(3),
    )).toThrow()
  })
})

describe('the cross product cap', () => {
  function portfolio(size: number) {
    return measurementDraftAuthoringSchema.parse({
      defaultContext: { providers: ['gemini'], models: { gemini: 'gemini-test' }, locations: [] },
      targets: Array.from({ length: size }, (_, index) => ({
        stableKey: `property-${String(index + 1).padStart(3, '0')}`,
        label: `Harbour ${String(index + 1).padStart(3, '0')}`,
        status: 'included',
        aliases: [],
        urlMatchers: [`https://portfolio.example/properties/${index + 1}`],
        source: 'manual',
      })),
      assignments: [],
      groups: [],
    })
  }

  it('refuses the incident: every generated question onto every Property', () => {
    const size = 213
    const authoring = portfolio(size)
    const queriesById = new Map(Array.from({ length: size }, (_, index) => [
      `q-${index + 1}`,
      `is Harbour ${String(index + 1).padStart(3, '0')} a good place to live`,
    ]))

    expect(() => applyDraftAction(
      'apply-assignments',
      authoring,
      { targetKeys: authoring.targets.map(target => target.stableKey), queryIds: [...queriesById.keys()] },
      { brandNames: ['Example Portfolio'], queriesById },
    )).toThrow(/45,369 assignments/)
  })

  it('still allows one question across the whole portfolio', () => {
    const authoring = portfolio(40)
    const result = applyDraftAction(
      'apply-assignments',
      authoring,
      { targetKeys: authoring.targets.map(target => target.stableKey), queryIds: ['q-market'] },
      { brandNames: ['Example Portfolio'], queriesById: new Map([['q-market', 'best apartments downtown']]) },
    )
    expect(result.authoring.assignments).toHaveLength(40)
  })

  it('allows 20 market questions across the 50 Properties of one market', () => {
    const authoring = portfolio(60)
    const queriesById = new Map(Array.from({ length: 20 }, (_, i) => [`q-${i}`, `best apartments option ${i}`]))
    const result = applyDraftAction(
      'apply-assignments',
      authoring,
      {
        targetKeys: authoring.targets.slice(0, 50).map(target => target.stableKey),
        queryIds: [...queriesById.keys()],
      },
      { brandNames: ['Example Portfolio'], queriesById },
    )
    expect(result.authoring.assignments).toHaveLength(1_000)
  })

  it('still allows several questions on a small selection', () => {
    const authoring = portfolio(40)
    const result = applyDraftAction(
      'apply-assignments',
      authoring,
      { targetKeys: ['property-001', 'property-002'], queryIds: ['q-a', 'q-b', 'q-c'] },
      {
        brandNames: ['Example Portfolio'],
        queriesById: new Map([['q-a', 'one'], ['q-b', 'two'], ['q-c', 'three']]),
      },
    )
    expect(result.authoring.assignments).toHaveLength(6)
  })
})

describe('measurement draft group hierarchy', () => {
  it('preserves a parent across legacy group edits and rejects removing it while children remain', () => {
    const authoring = audienceFixture()
    const withChild = applyDraftAction('upsert-group', authoring, { group: { stableKey: 'downtown', label: 'Downtown', parentGroupKey: 'dallas', targetKeys: ['dallas-1'] } }, audienceContext).authoring
    const legacyEdit = applyDraftAction('upsert-group', withChild, { group: { stableKey: 'downtown', label: 'Downtown', targetKeys: ['dallas-1'] } }, audienceContext).authoring
    expect(legacyEdit.groups.find(group => group.stableKey === 'downtown')?.parentGroupKey).toBe('dallas')
    const detached = applyDraftAction('upsert-group', legacyEdit, { group: { stableKey: 'downtown', label: 'Downtown', parentGroupKey: null, targetKeys: ['dallas-1'] } }, audienceContext).authoring
    expect(detached.groups.find(group => group.stableKey === 'downtown')?.parentGroupKey).toBeUndefined()
    expect(() => applyDraftAction('remove-group', legacyEdit, { groupKey: 'dallas' }, audienceContext)).toThrow(/explicit parent/)
  })
})


it('configures a named market from exact frozen memberships and an explicit containing group without changing assignments', () => {
  const authoring = audienceFixture()
  authoring.assignments = [{
    targetKey: 'dallas-1', queryId: 'q-market', queryClass: 'non-brand', classificationSource: 'operator',
    executionContexts: [{ providers: ['openai'], models: {}, location: null, executionNodeKey: 'existing-context' }],
  }]
  const edge = { executionNodeKey: 'existing-context', targetKey: 'dallas-1', queryId: 'q-market' }
  const market = { stableKey: 'uptown', kind: 'market', label: 'Uptown', groupKey: 'dallas', usageEdges: [edge] }
  const added = applyDraftAction('upsert-market', authoring, { market }, audienceContext).authoring
  expect(added.reportingScopes).toEqual([market])
  expect(added.assignments).toEqual(authoring.assignments)
  expect(added.groups).toEqual(authoring.groups)
  expect(authoring.reportingScopes).toBeUndefined()
  const renamed = applyDraftAction('upsert-market', added, { market: { ...market, label: 'Uptown district' } }, audienceContext).authoring
  expect(renamed.reportingScopes).toHaveLength(1)
  expect(renamed.reportingScopes?.[0]?.label).toBe('Uptown district')
  expect(renamed.reportingScopes?.[0]?.groupKey).toBe('dallas')
  expect(() => applyDraftAction('upsert-market', authoring, { market: { ...market, usageEdges: [{ ...edge, executionNodeKey: 'unpublished' }] } }, audienceContext)).toThrow(/existing frozen assignments/)
  expect(() => applyDraftAction('upsert-market', authoring, { market: { ...market, usageEdges: [edge, edge] } }, audienceContext)).toThrow(/duplicate assignment/)
  expect(() => applyDraftAction('upsert-market', authoring, { market: { ...market, groupKey: 'missing' } }, audienceContext)).toThrow(/existing group containing all its assigned properties/)
  expect(() => applyDraftAction('upsert-market', authoring, { market: { ...market, groupKey: 'luxury' } }, audienceContext)).toThrow(/existing group containing all its assigned properties/)
})
