import { describe, expect, it } from 'vitest'
import {
  measurementQueryStatusSchema,
  measurementQueryStatusesResponseSchema,
} from '../src/index.js'

describe('measurement query status contract', () => {
  it('accepts the server-owned statuses and explicit qualifying-run provenance', () => {
    expect(measurementQueryStatusSchema.options).toEqual([
      'not_in_plan',
      'awaiting_first_sweep',
      'partial',
      'measured',
    ])

    expect(measurementQueryStatusesResponseSchema.parse({
      setupMode: 'active-v2',
      activeRevision: 3,
      latestOfficialFullRun: {
        id: 'run-demo',
        status: 'completed',
        createdAt: '2026-08-28T10:00:00.000Z',
        finishedAt: '2026-08-28T10:01:00.000Z',
      },
      queries: [
        { queryId: 'query-alpha', status: 'measured' },
        { queryId: 'query-beta', status: 'partial' },
      ],
    })).toEqual(expect.objectContaining({ setupMode: 'active-v2', activeRevision: 3 }))
  })

  it('does not let callers omit the null provenance or add untyped row fields', () => {
    expect(() => measurementQueryStatusesResponseSchema.parse({
      setupMode: 'simple',
      activeRevision: null,
      queries: [],
    })).toThrow()

    expect(() => measurementQueryStatusesResponseSchema.parse({
      setupMode: 'simple',
      activeRevision: null,
      latestOfficialFullRun: null,
      queries: [{ queryId: 'query-alpha', status: 'measured', inferredInBrowser: true }],
    })).toThrow()
  })

  it('models catalog state, legacy-safe unavailable scope, v2 class facts, and frozen-plan orphans', () => {
    const parsed = measurementQueryStatusesResponseSchema.parse({
      setupMode: 'active-v2',
      activeRevision: 3,
      latestOfficialFullRun: null,
      queries: [
        {
          queryId: 'query-alpha',
          status: 'awaiting_first_sweep',
          catalogState: 'current',
          currentQueryText: 'Alpha question',
          assignmentScope: {
            mode: 'advanced_assigned',
            activePlanQueryText: 'Alpha question',
            queryTextMatchesPlan: true,
            assignedTargetCount: 2,
            classState: 'mixed',
            queryClasses: ['branded', 'non-brand'],
            classCounts: [
              { queryClass: 'branded', assignedTargetCount: 1 },
              { queryClass: 'non-brand', assignedTargetCount: 1 },
            ],
            groupCoverage: [{
              groupKey: 'metro',
              label: 'Metro',
              memberCount: 3,
              assignedMemberCount: 2,
              coverage: 'partial',
              classCounts: [
                { queryClass: 'branded', assignedTargetCount: 1 },
                { queryClass: 'non-brand', assignedTargetCount: 1 },
              ],
            }],
          },
        },
        {
          queryId: 'query-beta',
          status: 'not_in_plan',
          catalogState: 'current',
          currentQueryText: 'Beta question',
          assignmentScope: {
            mode: 'advanced_unassigned',
            activePlanQueryText: null,
            queryTextMatchesPlan: null,
            assignedTargetCount: 0,
            classState: 'none',
            queryClasses: [],
            classCounts: [],
            groupCoverage: [],
          },
        },
      ],
      activePlanOrphans: [{
        queryId: 'query-gone',
        status: 'awaiting_first_sweep',
        catalogState: 'missing',
        currentQueryText: null,
        assignmentScope: {
          mode: 'advanced_assigned',
          activePlanQueryText: 'Frozen question',
          queryTextMatchesPlan: null,
          assignedTargetCount: 1,
          classState: 'branded',
          queryClasses: ['branded'],
          classCounts: [{ queryClass: 'branded', assignedTargetCount: 1 }],
          groupCoverage: [],
        },
      }],
    })

    expect(parsed.queries[0]?.assignmentScope?.classState).toBe('mixed')
    expect(parsed.activePlanOrphans[0]?.catalogState).toBe('missing')

    expect(() => measurementQueryStatusesResponseSchema.parse({
      setupMode: 'active-v1',
      activeRevision: 1,
      latestOfficialFullRun: null,
      queries: [{
        queryId: 'query-legacy',
        status: 'not_in_plan',
        catalogState: 'current',
        currentQueryText: 'Legacy question',
        assignmentScope: {
          mode: 'legacy',
          activePlanQueryText: null,
          queryTextMatchesPlan: null,
          assignedTargetCount: 0,
          classState: 'none',
          queryClasses: [],
          classCounts: [],
          groupCoverage: [],
        },
      }],
      activePlanOrphans: [],
    })).toThrow()
  })
})
