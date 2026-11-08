import { describe, expect, test } from 'vitest'
import { combineCitationStates, readCitationState, type CitationState, type RetrievalStatus } from '../src/index.js'

describe('readCitationState', () => {
  const cases: Array<{ name: string; stored: CitationState; retrievalStatus: RetrievalStatus | null | undefined; reads: CitationState }> = [
    { name: 'a recorded not-measured stays not measured', stored: 'not-measured', retrievalStatus: 'not-applicable', reads: 'not-measured' },
    { name: 'a recorded not-measured stays not measured without a retrieval status', stored: 'not-measured', retrievalStatus: undefined, reads: 'not-measured' },
    // Rows written before `not-measured` existed: an engine with no retrieval step had nothing to cite.
    { name: 'an older not-cited from an engine with no retrieval step reads as not measured', stored: 'not-cited', retrievalStatus: 'not-applicable', reads: 'not-measured' },
    // A source link proves the citation, whatever else the row says.
    { name: 'a cited row always stands', stored: 'cited', retrievalStatus: 'not-applicable', reads: 'cited' },
    // Written before retrieval was recorded: nothing says it could not cite.
    { name: 'a not-cited row that predates retrieval status keeps its state', stored: 'not-cited', retrievalStatus: null, reads: 'not-cited' },
    // An engine that can cite but did not search this time is a measured answer.
    { name: 'a not-cited answer that ran no search is still a measured miss', stored: 'not-cited', retrievalStatus: 'not-used', reads: 'not-cited' },
    { name: 'an unknown retrieval status is never read as no sources', stored: 'not-cited', retrievalStatus: 'unknown', reads: 'not-cited' },
    { name: 'a searched miss stays a miss', stored: 'not-cited', retrievalStatus: 'used', reads: 'not-cited' },
  ]

  test.each(cases)('$name', ({ stored, retrievalStatus, reads }) => {
    expect(readCitationState({ citationState: stored, retrievalStatus })).toBe(reads)
  })
})

describe('combineCitationStates', () => {
  const cases: Array<{ name: string; states: CitationState[]; combined: CitationState | null }> = [
    { name: 'no answers has no state', states: [], combined: null },
    { name: 'any cited answer makes the query cited', states: ['not-measured', 'not-cited', 'cited'], combined: 'cited' },
    { name: 'one checked miss beside answers without sources is a miss', states: ['not-measured', 'not-cited', 'not-measured'], combined: 'not-cited' },
    { name: 'a miss checked before an answer without sources stays a miss', states: ['not-cited', 'not-measured'], combined: 'not-cited' },
    { name: 'only answers without sources is not measured', states: ['not-measured', 'not-measured'], combined: 'not-measured' },
  ]

  test.each(cases)('$name', ({ states, combined }) => {
    expect(combineCitationStates(states)).toBe(combined)
  })
})
