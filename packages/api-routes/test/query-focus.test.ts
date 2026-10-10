import { describe, expect, it } from 'vitest'
import type { MeasurementPlanV2, QueryClass } from '@ainyc/canonry-contracts'
import { planQueryFocus } from '../src/query-focus.js'
import { HARBOR_CONTEXT, measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

/** [query, location, class (default non-brand), execution node (default `exec-<query>`)] */
type Pairing = readonly [queryId: string, targetKey: string, queryClass?: QueryClass, nodeKey?: string]
/** [query, location, execution node (default `exec-<query>`)] */
type MarketEdge = readonly [queryId: string, targetKey: string, nodeKey?: string]

const nodeOf = (queryId: string, nodeKey?: string) => nodeKey ?? `exec-${queryId}`

/** The fixture's Harbor and Bayside plus Cove, with exactly these pairings and markets. */
function planOf(pairings: readonly Pairing[], markets: Record<string, readonly MarketEdge[]> = {}): MeasurementPlanV2 {
  const base = measurementPlanV2Fixture()
  const queryIds = [...new Set(pairings.map(([queryId]) => queryId))]
  const nodes = new Map(pairings.map(([queryId, , , nodeKey]) => [nodeOf(queryId, nodeKey), queryId]))
  return measurementPlanV2Fixture({
    targets: [...base.targets, { ...base.targets[0]!, stableKey: 'cove', label: 'Cove Homes', aliases: ['Cove Homes'] }],
    querySnapshots: queryIds.map(queryId => ({
      queryId, queryText: queryId, provenance: { source: 'manual', sourceId: null, capturedAt: '2026-07-01T00:00:00.000Z' },
    })),
    assignments: pairings.map(([queryId, targetKey, queryClass, nodeKey]) => ({
      targetKey, queryId, queryClass: queryClass ?? 'non-brand', executionNodeKey: nodeOf(queryId, nodeKey),
    })),
    executionNodes: [...nodes].map(([stableKey, queryId]) => ({
      stableKey, queryId, queryText: queryId,
      context: { providers: ['openai'], models: {}, location: HARBOR_CONTEXT }, expectedSnapshots: 1,
    })),
    usageEdges: pairings.map(([queryId, targetKey, , nodeKey]) => ({ executionNodeKey: nodeOf(queryId, nodeKey), targetKey, queryId })),
    reportingScopes: Object.entries(markets).map(([stableKey, edges]) => ({
      stableKey, label: stableKey, kind: 'market' as const,
      usageEdges: edges.map(([queryId, targetKey, nodeKey]) => ({ executionNodeKey: nodeOf(queryId, nodeKey), targetKey, queryId })),
    })),
  })
}

describe('planQueryFocus', () => {
  it('reads the shared fixture: one location with no market is that Location, two are Custom', () => {
    const focusOf = planQueryFocus(measurementPlanV2Fixture())

    expect(focusOf('q-brand')).toEqual({ kind: 'property', key: 'harbor' })
    expect(focusOf('q-nearby')).toEqual({ kind: 'custom' })
  })

  it('is the Market when a question covers every location of its one market, whatever its Type', () => {
    const focusOf = planQueryFocus(planOf([
      ['q-market', 'harbor'], ['q-market', 'bayside'],
      ['q-branded', 'harbor', 'branded'], ['q-branded', 'bayside', 'branded'],
      ['q-mixed', 'harbor', 'branded'], ['q-mixed', 'bayside'],
    ], {
      metro: [['q-market', 'harbor'], ['q-market', 'bayside'], ['q-branded', 'harbor'], ['q-branded', 'bayside'], ['q-mixed', 'harbor'], ['q-mixed', 'bayside']],
    }))

    expect(focusOf('q-market')).toEqual({ kind: 'market', key: 'metro' })
    expect(focusOf('q-branded')).toEqual({ kind: 'market', key: 'metro' })
    expect(focusOf('q-mixed')).toEqual({ kind: 'market', key: 'metro' })
  })

  it('is the Location only when the question sits in every market that location belongs to', () => {
    const focusOf = planQueryFocus(planOf([
      ['q-west', 'harbor'], ['q-west', 'bayside'],
      ['q-east', 'harbor'], ['q-east', 'cove'],
      ['q-both', 'harbor', 'branded'],
      ['q-one', 'harbor', 'branded'],
    ], {
      west: [['q-west', 'harbor'], ['q-west', 'bayside'], ['q-both', 'harbor'], ['q-one', 'harbor']],
      east: [['q-east', 'harbor'], ['q-east', 'cove'], ['q-both', 'harbor']],
    }))

    expect(focusOf('q-both')).toEqual({ kind: 'property', key: 'harbor' })
    expect(focusOf('q-one')).toEqual({ kind: 'custom' })
  })

  it('is the Location for a Non-brand question at one location of a larger market', () => {
    const focusOf = planQueryFocus(planOf([
      ['q-metro', 'harbor'], ['q-metro', 'bayside'],
      ['q-harbor', 'harbor'],
    ], {
      metro: [['q-metro', 'harbor'], ['q-metro', 'bayside'], ['q-harbor', 'harbor']],
    }))

    expect(focusOf('q-harbor')).toEqual({ kind: 'property', key: 'harbor' })
  })

  it('is Custom when a question misses one of its market locations or reaches outside it', () => {
    const focusOf = planQueryFocus(planOf([
      ['q-metro', 'harbor'], ['q-metro', 'bayside'], ['q-metro', 'cove'],
      ['q-partial', 'harbor'], ['q-partial', 'bayside'],
      ['q-outside', 'harbor'], ['q-outside', 'bayside'], ['q-outside', 'cove'],
    ], {
      metro: [
        ['q-metro', 'harbor'], ['q-metro', 'bayside'], ['q-metro', 'cove'],
        ['q-partial', 'harbor'], ['q-partial', 'bayside'],
        ['q-outside', 'harbor'], ['q-outside', 'bayside'],
      ],
    }))

    expect(focusOf('q-metro')).toEqual({ kind: 'market', key: 'metro' })
    expect(focusOf('q-partial')).toEqual({ kind: 'custom' })
    expect(focusOf('q-outside')).toEqual({ kind: 'custom' })
  })

  it('names the one market of two with the same locations, and is Custom in both', () => {
    const focusOf = planQueryFocus(planOf([
      ['q-first', 'harbor'], ['q-first', 'bayside'],
      ['q-second', 'harbor'], ['q-second', 'bayside'],
      ['q-both', 'harbor'], ['q-both', 'bayside'],
    ], {
      first: [['q-first', 'harbor'], ['q-first', 'bayside'], ['q-both', 'harbor'], ['q-both', 'bayside']],
      second: [['q-second', 'harbor'], ['q-second', 'bayside'], ['q-both', 'harbor'], ['q-both', 'bayside']],
    }))

    expect(focusOf('q-first')).toEqual({ kind: 'market', key: 'first' })
    expect(focusOf('q-second')).toEqual({ kind: 'market', key: 'second' })
    expect(focusOf('q-both')).toEqual({ kind: 'custom' })
  })

  it('lets Type break the tie only for a market of one location', () => {
    const focusOf = planQueryFocus(planOf([
      ['q-branded', 'harbor', 'branded'],
      ['q-nonbrand', 'harbor'],
      ['q-mixed', 'harbor', 'branded', 'exec-mixed-a'], ['q-mixed', 'harbor', 'non-brand', 'exec-mixed-b'],
    ], {
      'harbor-only': [['q-branded', 'harbor'], ['q-nonbrand', 'harbor'], ['q-mixed', 'harbor', 'exec-mixed-a'], ['q-mixed', 'harbor', 'exec-mixed-b']],
    }))

    expect(focusOf('q-branded')).toEqual({ kind: 'property', key: 'harbor' })
    expect(focusOf('q-nonbrand')).toEqual({ kind: 'market', key: 'harbor-only' })
    expect(focusOf('q-mixed')).toEqual({ kind: 'market', key: 'harbor-only' })
  })

  it('is the Market, not the Location, when the one-location market is one of two the location belongs to', () => {
    const focusOf = planQueryFocus(planOf([
      ['q-first', 'harbor', 'branded'],
      ['q-both', 'harbor', 'branded'],
    ], {
      first: [['q-first', 'harbor'], ['q-both', 'harbor']],
      second: [['q-both', 'harbor']],
    }))

    expect(focusOf('q-first')).toEqual({ kind: 'market', key: 'first' })
    expect(focusOf('q-both')).toEqual({ kind: 'property', key: 'harbor' })
  })

  it('is Custom for Branded questions on several locations without a market', () => {
    const focusOf = planQueryFocus(planOf([['q-brand', 'harbor', 'branded'], ['q-brand', 'bayside', 'branded']]))

    expect(focusOf('q-brand')).toEqual({ kind: 'custom' })
  })

  it('is Custom for a location-only add at a location that belongs to a market', () => {
    const focusOf = planQueryFocus(planOf([
      ['q-metro', 'harbor'], ['q-metro', 'bayside'],
      ['q-added', 'harbor', 'branded'],
    ], {
      metro: [['q-metro', 'harbor'], ['q-metro', 'bayside']],
    }))

    expect(focusOf('q-added')).toEqual({ kind: 'custom' })
  })

  it('is Not asked for a question with no pairings', () => {
    const plan = planOf([['q-metro', 'harbor']])
    const focusOf = planQueryFocus({
      ...plan,
      querySnapshots: [...plan.querySnapshots, { queryId: 'q-idle', queryText: 'q-idle', provenance: plan.querySnapshots[0]!.provenance }],
    })

    expect(focusOf('q-idle')).toEqual({ kind: 'not-asked' })
    expect(focusOf('q-unknown')).toEqual({ kind: 'not-asked' })
  })

  it('collapses several search locations into one Subject', () => {
    const focusOf = planQueryFocus(planOf([
      ['q-metro', 'harbor', 'non-brand', 'exec-metro-a'], ['q-metro', 'bayside', 'non-brand', 'exec-metro-a'],
      ['q-metro', 'harbor', 'non-brand', 'exec-metro-b'], ['q-metro', 'bayside', 'non-brand', 'exec-metro-b'],
      ['q-extra', 'harbor', 'non-brand', 'exec-extra-a'], ['q-extra', 'bayside', 'non-brand', 'exec-extra-a'],
      ['q-extra', 'harbor', 'non-brand', 'exec-extra-b'],
    ], {
      metro: [
        ['q-metro', 'harbor', 'exec-metro-a'], ['q-metro', 'bayside', 'exec-metro-a'],
        ['q-metro', 'harbor', 'exec-metro-b'], ['q-metro', 'bayside', 'exec-metro-b'],
        ['q-extra', 'harbor', 'exec-extra-a'], ['q-extra', 'bayside', 'exec-extra-a'],
      ],
    }))

    expect(focusOf('q-metro')).toEqual({ kind: 'market', key: 'metro' })
    // A pairing sits in a market when any of its search locations does.
    expect(focusOf('q-extra')).toEqual({ kind: 'market', key: 'metro' })
  })
})
