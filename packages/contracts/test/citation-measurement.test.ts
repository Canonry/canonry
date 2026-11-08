import { describe, expect, test } from 'vitest'
import { readCitationState, type CitationState, type RetrievalStatus } from '../src/index.js'

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
