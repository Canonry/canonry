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
})
