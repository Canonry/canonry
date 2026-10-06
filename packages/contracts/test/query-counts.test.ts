import { describe, expect, it } from 'vitest'
import { CitationStates } from '../src/run.js'
import { summarizeObservedQueryCounts, type IdentifiedQuerySignal } from '../src/query-counts.js'

const cases: Array<{ name: string; snapshots: IdentifiedQuerySignal[]; expected: { totalQueries: number; citedQueries: number; mentionedQueries: number } }> = [
  { name: 'no observed queries', snapshots: [], expected: { totalQueries: 0, citedQueries: 0, mentionedQueries: 0 } },
  {
    name: 'opposite signals and repeated answers for one query',
    snapshots: [
      { queryId: 'q1', citationState: CitationStates.cited, answerMentioned: false },
      { queryId: 'q1', citationState: CitationStates['not-cited'], answerMentioned: true },
      { queryId: 'q1', citationState: CitationStates.cited, answerMentioned: true },
      { queryId: 'q1', citationState: CitationStates['not-cited'], answerMentioned: false },
    ],
    expected: { totalQueries: 1, citedQueries: 1, mentionedQueries: 1 },
  },
  {
    name: 'independent cited-only, mentioned-only, both and neither populations',
    snapshots: [
      { queryId: 'q1', citationState: CitationStates.cited, answerMentioned: false },
      { queryId: 'q2', citationState: CitationStates['not-cited'], answerMentioned: true },
      { queryId: 'q3', citationState: CitationStates.cited, answerMentioned: true },
      { queryId: 'q4', citationState: CitationStates['not-cited'], answerMentioned: false },
    ],
    expected: { totalQueries: 4, citedQueries: 2, mentionedQueries: 2 },
  },
  {
    name: 'nullable legacy mention signals do not invent a mention or erase citations',
    snapshots: [
      { queryId: 'q1', citationState: CitationStates.cited, answerMentioned: null },
      { queryId: 'q2', citationState: CitationStates['not-cited'], answerMentioned: undefined },
    ],
    expected: { totalQueries: 2, citedQueries: 1, mentionedQueries: 0 },
  },
]

describe('observed query counts', () => {
  it.each(cases)('$name', ({ snapshots, expected }) => {
    expect(summarizeObservedQueryCounts(snapshots)).toEqual(expected)
  })
})
