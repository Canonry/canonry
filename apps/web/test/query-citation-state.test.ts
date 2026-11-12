import { describe, expect, test } from 'vitest'
import { queryCitationState } from '../src/lib/query-citation-state.js'
import type { CitationState } from '../src/view-models.js'

describe('queryCitationState', () => {
  const cases: Array<{ name: string; states: CitationState[]; reads: CitationState }> = [
    { name: 'no engine has answered', states: ['pending', 'pending'], reads: 'pending' },
    { name: 'an engine without sources beside one that cites', states: ['not-measured', 'cited'], reads: 'cited' },
    { name: 'a newly cited engine beside one without sources', states: ['not-measured', 'emerging'], reads: 'emerging' },
    { name: 'an engine still citing outranks one newly citing', states: ['emerging', 'cited'], reads: 'cited' },
    { name: 'a lost citation beside an engine without sources is still lost', states: ['not-measured', 'lost'], reads: 'lost' },
    { name: 'a checked miss beside an engine without sources is a miss', states: ['not-measured', 'not-cited'], reads: 'not-cited' },
    { name: 'only engines without sources, one still pending', states: ['not-measured', 'pending'], reads: 'not-measured' },
    { name: 'a lost engine beside a newly citing one reads emerging', states: ['lost', 'emerging'], reads: 'emerging' },
  ]

  test.each(cases)('$name', ({ states, reads }) => {
    expect(queryCitationState(states)).toBe(reads)
  })
})
