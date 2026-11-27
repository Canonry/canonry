import { describe, expect, test } from 'vitest'
import { combineCitationStates, readCitationState, type CitationState, type RetrievalStatus } from '../src/index.js'

describe('readCitationState', () => {
  const cases: Array<{ name: string; provider: string; stored: CitationState; retrievalStatus: RetrievalStatus | null | undefined; reads: CitationState }> = [
    { name: 'a recorded not-measured stays not measured', provider: 'local', stored: 'not-measured', retrievalStatus: 'not-applicable', reads: 'not-measured' },
    { name: 'a recorded not-measured stays not measured without a retrieval status', provider: 'local', stored: 'not-measured', retrievalStatus: undefined, reads: 'not-measured' },
    // Local has never returned a source link, so no row of it observed a citation.
    { name: 'an older Local not-cited with retrieval not applicable reads as not measured', provider: 'local', stored: 'not-cited', retrievalStatus: 'not-applicable', reads: 'not-measured' },
    { name: 'a Local not-cited from before retrieval status was recorded reads as not measured', provider: 'local', stored: 'not-cited', retrievalStatus: null, reads: 'not-measured' },
    // Before #871 Local took "cited" domains from the answer text: a mention, never a source link.
    { name: 'a Local cited taken from answer text reads as not measured', provider: 'local', stored: 'cited', retrievalStatus: null, reads: 'not-measured' },
    // Any other engine that reports no retrieval step had no sources to check.
    { name: 'another engine with no retrieval step reads its not-cited as not measured', provider: 'future-engine', stored: 'not-cited', retrievalStatus: 'not-applicable', reads: 'not-measured' },
    // A source link proves the citation for an engine that returns sources.
    { name: 'a cited row from an engine with sources always stands', provider: 'future-engine', stored: 'cited', retrievalStatus: 'not-applicable', reads: 'cited' },
    // Written before retrieval was recorded by an engine with sources: nothing says it could not cite.
    { name: 'a not-cited row that predates retrieval status keeps its state', provider: 'gemini', stored: 'not-cited', retrievalStatus: null, reads: 'not-cited' },
    // An engine that can cite but did not search this time is a measured answer.
    { name: 'a not-cited answer that ran no search is still a measured miss', provider: 'claude', stored: 'not-cited', retrievalStatus: 'not-used', reads: 'not-cited' },
    { name: 'an unknown retrieval status is never read as no sources', provider: 'cdp:chatgpt', stored: 'not-cited', retrievalStatus: 'unknown', reads: 'not-cited' },
    { name: 'a searched miss stays a miss', provider: 'openai', stored: 'not-cited', retrievalStatus: 'used', reads: 'not-cited' },
  ]

  test.each(cases)('$name', ({ provider, stored, retrievalStatus, reads }) => {
    expect(readCitationState({ provider, citationState: stored, retrievalStatus })).toBe(reads)
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
