import { describe, expect, test } from 'vitest'
import type {
  ContentTargetRowDto,
  RecommendedNextStep,
} from '@ainyc/canonry-contracts'
import { mapOpportunitiesToNextSteps } from '../src/next-steps.js'

function makeOpportunity(
  overrides: Partial<ContentTargetRowDto> & {
    query: string
    action: ContentTargetRowDto['action']
  },
): ContentTargetRowDto {
  return {
    targetRef: `ref-${overrides.query}`,
    query: overrides.query,
    action: overrides.action,
    ourBestPage: null,
    winningCompetitor: null,
    score: overrides.score ?? 50,
    scoreBreakdown: { demand: 0, competitor: 0, absence: 0, gapSeverity: 0 },
    drivers: overrides.drivers ?? [],
    demandSource: overrides.demandSource ?? 'gsc',
    actionConfidence: overrides.actionConfidence ?? 'medium',
    existingAction: null,
    ...overrides,
  }
}

describe('mapOpportunitiesToNextSteps', () => {
  test('returns existing steps unchanged when the input list is non-empty', () => {
    const existing: RecommendedNextStep[] = [
      { horizon: 'immediate', title: 'Resolve 2 critical regressions', rationale: 'X' },
    ]
    const out = mapOpportunitiesToNextSteps(
      [makeOpportunity({ query: 'foo', action: 'create', score: 90 })],
      existing,
    )
    expect(out).toBe(existing)
  })

  test('returns [] when both inputs are empty', () => {
    expect(mapOpportunitiesToNextSteps([], [])).toEqual([])
  })

  test('takes the top 5 opportunities by score, preserves input order', () => {
    const opps = [
      makeOpportunity({ query: 'a', action: 'create', score: 100 }),
      makeOpportunity({ query: 'b', action: 'refresh', score: 80 }),
      makeOpportunity({ query: 'c', action: 'expand', score: 60 }),
      makeOpportunity({ query: 'd', action: 'add-schema', score: 50 }),
      makeOpportunity({ query: 'e', action: 'create', score: 40 }),
      makeOpportunity({ query: 'f', action: 'create', score: 30 }),
      makeOpportunity({ query: 'g', action: 'create', score: 20 }),
    ]
    const out = mapOpportunitiesToNextSteps(opps, [])
    expect(out).toHaveLength(5)
    expect(out.map(s => s.title)).toEqual([
      'Create a page targeting "a"',
      'Refresh the page targeting "b"',
      'Expand coverage of "c"',
      'Add structured data to the page targeting "d"',
      'Create a page targeting "e"',
    ])
  })

  test('top three opportunities get horizon=immediate, the rest short-term', () => {
    const opps = Array.from({ length: 5 }, (_, i) =>
      makeOpportunity({ query: `q${i}`, action: 'create', score: 100 - i }),
    )
    const out = mapOpportunitiesToNextSteps(opps, [])
    expect(out.map(s => s.horizon)).toEqual([
      'immediate',
      'immediate',
      'immediate',
      'short-term',
      'short-term',
    ])
  })

  test('rationale references demandSource, score, and action confidence', () => {
    const out = mapOpportunitiesToNextSteps(
      [
        makeOpportunity({
          query: 'foo',
          action: 'create',
          score: 78,
          demandSource: 'both',
          actionConfidence: 'high',
        }),
      ],
      [],
    )
    expect(out[0]!.rationale).toContain('78')
    expect(out[0]!.rationale).toContain('both')
    expect(out[0]!.rationale).toContain('high')
  })

  test('action chip phrasing covers all four ContentAction enum values', () => {
    const out = mapOpportunitiesToNextSteps(
      [
        makeOpportunity({ query: 'a', action: 'create' }),
        makeOpportunity({ query: 'b', action: 'refresh' }),
        makeOpportunity({ query: 'c', action: 'expand' }),
        makeOpportunity({ query: 'd', action: 'add-schema' }),
      ],
      [],
    )
    expect(out[0]!.title).toMatch(/^Create /)
    expect(out[1]!.title).toMatch(/^Refresh /)
    expect(out[2]!.title).toMatch(/^Expand /)
    expect(out[3]!.title).toMatch(/^Add structured data /)
  })
})
