import { describe, expect, it } from 'vitest'
import {
  compileMeasurementPlan,
  measurementRunScopeIsEmpty,
  MeasurementRunScopeError,
  parseStoredMeasurementRunScope,
  resolveMeasurementRunScope,
  type MeasurementPlan,
  type MeasurementPlanInput,
} from '../src/measurement-plan.js'

const NORTH = { label: 'north-city', city: 'North City', region: 'NC', country: 'US' }
const SOUTH = { label: 'south-city', city: 'South City', region: 'SC', country: 'US' }

const TRACKED = [
  { id: 'q-pricing', query: 'widget pricing' },
  { id: 'q-repair', query: 'widget repair' },
  { id: 'q-shops', query: 'best widget shops' },
]

function planInput(overrides: Partial<MeasurementPlanInput> = {}): MeasurementPlanInput {
  return {
    schemaVersion: 1,
    targets: [
      { stableKey: 'north-branch', label: 'North branch', urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/north', pathCase: 'insensitive' }], aliases: ['North branch'] },
      { stableKey: 'south-branch', label: 'South branch', urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/south', pathCase: 'insensitive' }], aliases: ['South branch'] },
      { stableKey: 'depot', label: 'Depot', urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/depot', pathCase: 'insensitive' }], aliases: ['Depot'] },
    ],
    groups: [{ stableKey: 'metro-group', label: 'Metro group', targetKeys: ['north-branch'] }],
    targetQuerySelections: [
      { targetKey: 'north-branch', queryIds: ['q-pricing'] },
      { targetKey: 'south-branch', queryIds: ['q-repair'], context: SOUTH },
    ],
    ...overrides,
  }
}

function compiled(overrides: Partial<MeasurementPlanInput> = {}): MeasurementPlan {
  return compileMeasurementPlan(planInput(overrides), {
    canonicalDomain: 'example.com',
    ownedDomains: [],
    defaultContext: NORTH,
    locations: [NORTH, SOUTH],
    trackedQueries: TRACKED,
    expectedSnapshots: 2,
  })
}

function resolve(scope: { groups?: string[]; targets?: string[] }, plan = compiled()) {
  return resolveMeasurementRunScope(plan, scope)
}

describe('measurementRunScopeIsEmpty', () => {
  it('treats a missing or empty scope as a full sweep', () => {
    expect(measurementRunScopeIsEmpty(undefined)).toBe(true)
    expect(measurementRunScopeIsEmpty(null)).toBe(true)
    expect(measurementRunScopeIsEmpty({})).toBe(true)
    expect(measurementRunScopeIsEmpty({ groups: [], targets: [] })).toBe(true)
    expect(measurementRunScopeIsEmpty({ groups: ['metro-group'] })).toBe(false)
  })
})

describe('resolveMeasurementRunScope', () => {
  it('expands a group to the execution nodes its member targets selected', () => {
    const resolution = resolve({ groups: ['metro-group'] })

    expect(resolution.scope).toEqual({ groups: ['metro-group'], targets: [], queries: [], resolvedTargets: ['north-branch'] })
    expect(resolution.executionNodes.map(node => ({ queryText: node.queryText, context: node.context?.label ?? null })))
      .toEqual([{ queryText: 'widget pricing', context: 'north-city' }])
  })

  it('never pulls in a node only a baseline edge wanted', () => {
    const plan = compiled()
    const resolution = resolve({ groups: ['metro-group'] }, plan)

    // The plan measures three questions at baseline; the slice measures the one
    // its target selected, even though the other two share its context.
    expect(plan.executionNodes.length).toBeGreaterThan(resolution.executionNodes.length)
    const baselineOnly = plan.usageEdges
      .filter(edge => edge.kind === 'baseline')
      .map(edge => edge.executionNodeKey)
      .filter(key => !plan.usageEdges.some(edge => edge.kind !== 'baseline' && edge.executionNodeKey === key))
    expect(baselineOnly.length).toBeGreaterThan(0)
    for (const key of baselineOnly) {
      expect(resolution.executionNodes.some(node => node.stableKey === key)).toBe(false)
    }
  })

  it('keeps a target selection on its own context', () => {
    const resolution = resolve({ targets: ['south-branch'] })

    expect(resolution.scope).toEqual({ groups: [], targets: ['south-branch'], queries: [], resolvedTargets: ['south-branch'] })
    expect(resolution.executionNodes.map(node => node.context?.label ?? null)).toEqual(['south-city'])
  })

  it('unions groups and targets', () => {
    const resolved = resolveMeasurementRunScope(compiled(), { groups: ['metro-group', 'metro-group'], targets: ['south-branch', 'north-branch', 'south-branch'] })
    expect(resolved.scope).toEqual({ groups: ['metro-group'], targets: ['north-branch', 'south-branch'], queries: [], resolvedTargets: ['north-branch', 'south-branch'] })
    expect(resolved.executionNodes).toEqual([
      { stableKey: "execution-d2lkZ2V0IHByaWNpbmcAeyJjaXR5IjoiTm9ydGggQ2l0eSIsImNvdW50cnkiOiJVUyIsImxhYmVsIjoibm9ydGgtY2l0eSIsInJlZ2lvbiI6Ik5DIn0", queryText: 'widget pricing', context: NORTH, expectedSnapshots: 2 },
      { stableKey: "execution-d2lkZ2V0IHJlcGFpcgB7ImNpdHkiOiJTb3V0aCBDaXR5IiwiY291bnRyeSI6IlVTIiwibGFiZWwiOiJzb3V0aC1jaXR5IiwicmVnaW9uIjoiU0MifQ", queryText: 'widget repair', context: SOUTH, expectedSnapshots: 2 },
    ])
  })

  it('names an unknown group key', () => {
    expect(() => resolve({ groups: ['west-region'] })).toThrow(MeasurementRunScopeError)
    try {
      resolve({ groups: ['west-region'] })
    } catch (error) {
      const scopeError = error as MeasurementRunScopeError
      expect(scopeError.unknownGroups).toEqual(['west-region'])
      expect(scopeError.message).toContain('"west-region"')
      expect(scopeError.message).toContain('no group named')
    }
  })

  it('names an unknown target key', () => {
    try {
      resolve({ targets: ['east-branch'], groups: ['metro-group'] })
      throw new Error('expected a scope error')
    } catch (error) {
      const scopeError = error as MeasurementRunScopeError
      expect(scopeError.unknownTargets).toEqual(['east-branch'])
      expect(scopeError.unknownGroups).toEqual([])
      expect(scopeError.message).toContain('"east-branch"')
    }
  })

  it('refuses a scope that would measure nothing', () => {
    try {
      resolve({ targets: ['depot'] })
      throw new Error('expected a scope error')
    } catch (error) {
      const scopeError = error as MeasurementRunScopeError
      expect(scopeError.emptyTargets).toEqual(['depot'])
      expect(scopeError.message).toContain('"depot"')
      expect(scopeError.message).toContain('Nothing to measure')
    }
  })

  it('round-trips the stored descriptor', () => {
    const { scope } = resolve({ groups: ['metro-group'] })
    expect(parseStoredMeasurementRunScope(JSON.stringify(scope))).toEqual(scope)
    expect(() => parseStoredMeasurementRunScope({ groups: [] })).toThrow(/invalid/i)
  })
})
