import { describe, expect, it } from 'vitest'
import {
  MEASUREMENT_DRAFT_MAX_ASSIGNMENTS,
  MEASUREMENT_DRAFT_MAX_AUTHORING_BYTES,
  MEASUREMENT_DRAFT_MAX_GROUPS,
  measurementDraftAuthoringSchema,
} from '@ainyc/canonry-contracts'
import {
  applyAssignmentsToAuthoring,
  applyDraftAction,
  assertMeasurementDraftAuthoringLimits,
  replaceAssignmentsInAuthoring,
  resolveDraftAudience,
} from '../src/measurement-draft-actions.js'

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
