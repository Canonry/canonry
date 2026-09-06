import { describe, expect, it } from 'vitest'
import { measurementDraftAuthoringSchema } from '@ainyc/canonry-contracts'
import { compileMeasurementDraft } from '../src/measurement-draft-compile.js'

describe('measurement draft compiler', () => {
  it.each([
    ['America/New_York', 'America/Chicago'],
    ['America/New_York', undefined],
    [undefined, 'America/New_York'],
  ])('refuses frozen timezone drift from %s to %s', (frozenTimezone, configuredTimezone) => {
    const place = { label: 'market', city: 'Example City', region: 'EX', country: 'US' }
    const authoring = measurementDraftAuthoringSchema.parse({
      defaultContext: { providers: ['openai'], locations: ['market'] },
      targets: [{
        stableKey: 'widgets', label: 'Widgets', status: 'included', aliases: [],
        urlMatchers: ['https://northwind.example/widgets/*'], source: 'manual',
      }],
      assignments: [{
        targetKey: 'widgets', queryId: 'question-one', queryClass: 'non-brand', classificationSource: 'operator',
        executionContexts: [{
          providers: ['openai'], models: {}, executionNodeKey: 'frozen-market-context',
          location: { ...place, ...(frozenTimezone === undefined ? {} : { timezone: frozenTimezone }) },
        }],
      }],
      groups: [],
    })
    const result = compileMeasurementDraft(authoring, {
      canonicalDomain: 'northwind.example', ownedDomains: [], brandNames: ['Northwind'],
      locations: [{ ...place, ...(configuredTimezone === undefined ? {} : { timezone: configuredTimezone }) }],
      trackedQueries: [{ id: 'question-one', query: 'first question' }],
    })
    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({ ruleId: 'execution-context-location-mismatch', severity: 'fail' }))
  })

  it('gives newly authored exact contexts distinct keys when only timezone differs', () => {
    const keys = ['America/New_York', 'America/Chicago'].map(timezone => {
      const location = { label: 'market', city: 'Example City', region: 'EX', country: 'US', timezone }
      const authoring = measurementDraftAuthoringSchema.parse({
        defaultContext: { providers: ['openai'], locations: [] },
        targets: [{
          stableKey: 'widgets', label: 'Widgets', status: 'included', aliases: [],
          urlMatchers: ['https://northwind.example/widgets/*'], source: 'manual',
        }],
        assignments: [{
          targetKey: 'widgets', queryId: 'question-one', queryClass: 'non-brand', classificationSource: 'operator',
          executionContexts: [{ providers: ['openai'], models: {}, location }],
        }],
        groups: [],
      })
      const result = compileMeasurementDraft(authoring, {
        canonicalDomain: 'northwind.example', ownedDomains: [], brandNames: ['Northwind'], locations: [location],
        trackedQueries: [{ id: 'question-one', query: 'first question' }],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('Expected a valid exact context')
      return result.plan.executionNodes[0]!.stableKey
    })
    expect(keys[0]).not.toBe(keys[1])
  })

  it('refuses a frozen execution key reused by a different question', () => {
    const authoring = measurementDraftAuthoringSchema.parse({
      defaultContext: { providers: ['openai'], locations: [] },
      targets: [{
        stableKey: 'widgets', label: 'Widgets', status: 'included', aliases: [],
        urlMatchers: ['https://northwind.example/widgets/*'], source: 'manual',
      }],
      assignments: ['question-one', 'question-two'].map(queryId => ({
        targetKey: 'widgets', queryId, queryClass: 'non-brand', classificationSource: 'operator',
        executionContexts: [{ providers: ['openai'], models: {}, location: null, executionNodeKey: 'shared-imported-key' }],
      })),
      groups: [],
    })
    const result = compileMeasurementDraft(authoring, {
      canonicalDomain: 'northwind.example', ownedDomains: [], brandNames: ['Northwind'], locations: [],
      trackedQueries: [{ id: 'question-one', query: 'first question' }, { id: 'question-two', query: 'second question' }],
    })
    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({ ruleId: 'execution-key-conflict', severity: 'fail' }))
  })

  it('uses original Property indices for every unassigned Property', () => {
    const authoring = measurementDraftAuthoringSchema.parse({
      defaultContext: { providers: ['openai'], locations: [] },
      targets: [
        {
          stableKey: 'widgets',
          label: 'Widgets',
          status: 'included',
          aliases: ['Northwind Widgets'],
          urlMatchers: ['https://northwind.example/widgets/*'],
          source: 'manual',
        },
        {
          stableKey: 'archived',
          label: 'Archived',
          status: 'excluded',
          aliases: ['Northwind Archived'],
          urlMatchers: ['https://northwind.example/archived/*'],
          source: 'manual',
        },
        {
          stableKey: 'gadgets',
          label: 'Gadgets',
          status: 'included',
          aliases: ['Northwind Gadgets'],
          urlMatchers: ['https://northwind.example/gadgets/*'],
          source: 'manual',
        },
        {
          stableKey: 'services',
          label: 'Services',
          status: 'included',
          aliases: ['Northwind Services'],
          urlMatchers: ['https://northwind.example/services/*'],
          source: 'manual',
        },
      ],
      assignments: [{
        targetKey: 'widgets',
        queryId: 'q-best-widgets',
        queryClass: 'non-brand',
        classificationSource: 'operator',
      }],
      groups: [],
    })

    const result = compileMeasurementDraft(authoring, {
      canonicalDomain: 'northwind.example',
      ownedDomains: [],
      brandNames: ['Northwind'],
      locations: [],
      trackedQueries: [{ id: 'q-best-widgets', query: 'best widget supplier' }],
    })

    expect(result.ok).toBe(true)
    expect(result.checks.filter(check => check.ruleId === 'target-without-assignments'))
      .toEqual([
        expect.objectContaining({ path: ['targets', 2] }),
        expect.objectContaining({ path: ['targets', 3] }),
      ])
  })

  it('retains exact market edge membership and rebuilds one unambiguous successor', () => {
    const base = measurementDraftAuthoringSchema.parse({
      defaultContext: { providers: ['openai'], locations: [] },
      targets: [{
        stableKey: 'widgets', label: 'Widgets', status: 'included', aliases: ['Northwind Widgets'],
        urlMatchers: ['https://northwind.example/widgets/*'], source: 'manual',
      }],
      assignments: [{ targetKey: 'widgets', queryId: 'q-best-widgets', queryClass: 'non-brand', classificationSource: 'operator' }],
      groups: [],
    })
    const context = {
      canonicalDomain: 'northwind.example', ownedDomains: [], brandNames: ['Northwind'], locations: [],
      trackedQueries: [{ id: 'q-best-widgets', query: 'best widget supplier' }],
    }
    const initial = compileMeasurementDraft(base, context)
    expect(initial.ok).toBe(true)
    if (!initial.ok) return
    const edge = initial.plan.usageEdges[0]!

    const changed = compileMeasurementDraft({
      ...base,
      defaultContext: { providers: ['gemini'], locations: [] },
      reportingScopes: [{ stableKey: 'alpha', label: 'Alpha', kind: 'market', usageEdges: [edge] }],
    }, context)

    expect(changed.ok).toBe(true)
    if (!changed.ok) return
    expect(changed.plan.reportingScopes?.[0]?.usageEdges).toEqual(changed.plan.usageEdges)
    expect(changed.checks).toContainEqual(expect.objectContaining({ ruleId: 'reporting-scope-edge-rebuilt', severity: 'warn' }))
  })

  it('prunes a removed market member explicitly rather than broadening its Target scope', () => {
    const authoring = measurementDraftAuthoringSchema.parse({
      defaultContext: { providers: ['openai'], locations: [] },
      targets: [{
        stableKey: 'widgets', label: 'Widgets', status: 'included', aliases: ['Northwind Widgets'],
        urlMatchers: ['https://northwind.example/widgets/*'], source: 'manual',
      }],
      assignments: [],
      groups: [],
      reportingScopes: [{
        stableKey: 'alpha', label: 'Alpha', kind: 'market',
        usageEdges: [{ executionNodeKey: 'old-execution', targetKey: 'widgets', queryId: 'q-removed' }],
      }],
    })
    const result = compileMeasurementDraft(authoring, {
      canonicalDomain: 'northwind.example', ownedDomains: [], brandNames: ['Northwind'], locations: [],
      trackedQueries: [],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.reportingScopes?.[0]?.usageEdges).toEqual([])
    expect(result.checks).toContainEqual(expect.objectContaining({ ruleId: 'reporting-scope-edge-pruned', severity: 'warn' }))
  })
})
