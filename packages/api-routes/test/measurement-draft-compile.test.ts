import { describe, expect, it } from 'vitest'
import { measurementDraftAuthoringSchema } from '@ainyc/canonry-contracts'
import { compileMeasurementDraft } from '../src/measurement-draft-compile.js'

describe('measurement draft compiler', () => {
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
