import { describe, expect, it } from 'vitest'
import { CitationStates } from '../src/run.js'
import { summarizeObservedQueryCounts, summarizeObservedQueryCountsByClass, type IdentifiedQuerySignal } from '../src/query-counts.js'
import { QueryClasses, type QueryClass } from '../src/query-class.js'

const cases: Array<{ name: string; snapshots: IdentifiedQuerySignal[]; expected: { totalQueries: number; citedQueries: number; mentionedQueries: number; citationNotMeasuredQueries: number } }> = [
  { name: 'no observed queries', snapshots: [], expected: { totalQueries: 0, citedQueries: 0, mentionedQueries: 0, citationNotMeasuredQueries: 0 } },
  {
    name: 'opposite signals and repeated answers for one query',
    snapshots: [
      { queryId: 'q1', citationState: CitationStates.cited, answerMentioned: false },
      { queryId: 'q1', citationState: CitationStates['not-cited'], answerMentioned: true },
      { queryId: 'q1', citationState: CitationStates.cited, answerMentioned: true },
      { queryId: 'q1', citationState: CitationStates['not-cited'], answerMentioned: false },
    ],
    expected: { totalQueries: 1, citedQueries: 1, mentionedQueries: 1, citationNotMeasuredQueries: 0 },
  },
  {
    name: 'independent cited-only, mentioned-only, both and neither populations',
    snapshots: [
      { queryId: 'q1', citationState: CitationStates.cited, answerMentioned: false },
      { queryId: 'q2', citationState: CitationStates['not-cited'], answerMentioned: true },
      { queryId: 'q3', citationState: CitationStates.cited, answerMentioned: true },
      { queryId: 'q4', citationState: CitationStates['not-cited'], answerMentioned: false },
    ],
    expected: { totalQueries: 4, citedQueries: 2, mentionedQueries: 2, citationNotMeasuredQueries: 0 },
  },
  {
    name: 'nullable legacy mention signals do not invent a mention or erase citations',
    snapshots: [
      { queryId: 'q1', citationState: CitationStates.cited, answerMentioned: null },
      { queryId: 'q2', citationState: CitationStates['not-cited'], answerMentioned: undefined },
    ],
    expected: { totalQueries: 2, citedQueries: 1, mentionedQueries: 0, citationNotMeasuredQueries: 0 },
  },
  {
    // An engine with no sources leaves a query's citation unmeasured unless
    // another engine checked it; its mention still counts.
    name: 'answers without sources leave citation unmeasured but still mention',
    snapshots: [
      { queryId: 'q1', citationState: CitationStates['not-measured'], answerMentioned: true },
      { queryId: 'q2', citationState: CitationStates['not-measured'], answerMentioned: false },
      { queryId: 'q2', citationState: CitationStates['not-cited'], answerMentioned: false },
      { queryId: 'q3', citationState: CitationStates['not-measured'], answerMentioned: false },
      { queryId: 'q3', citationState: CitationStates.cited, answerMentioned: false },
    ],
    expected: { totalQueries: 3, citedQueries: 1, mentionedQueries: 1, citationNotMeasuredQueries: 1 },
  },
]

describe('observed query counts', () => {
  it.each(cases)('$name', ({ snapshots, expected }) => {
    expect(summarizeObservedQueryCounts(snapshots)).toEqual(expected)
  })
})

describe('observed query counts by class', () => {
  const classes = new Map<string, QueryClass | null>([
    ['n1', QueryClasses['non-brand']],
    ['n2', QueryClasses['non-brand']],
    ['b1', QueryClasses.branded],
    ['u1', null],
  ])
  const classOf = (queryId: string) => classes.get(queryId) ?? null
  const zero = { totalQueries: 0, citedQueries: 0, mentionedQueries: 0, citationNotMeasuredQueries: 0 }

  it('counts each query once, in its own class, and the classes add up to the pooled total', () => {
    const snapshots: IdentifiedQuerySignal[] = [
      { queryId: 'n1', citationState: CitationStates.cited, answerMentioned: false },
      { queryId: 'n1', citationState: CitationStates['not-cited'], answerMentioned: true },
      { queryId: 'n2', citationState: CitationStates['not-measured'], answerMentioned: false },
      { queryId: 'b1', citationState: CitationStates['not-cited'], answerMentioned: true },
      { queryId: 'u1', citationState: CitationStates.cited, answerMentioned: true },
    ]
    const split = summarizeObservedQueryCountsByClass(snapshots, classOf)
    expect(split).toEqual({
      nonBrand: { totalQueries: 2, citedQueries: 1, mentionedQueries: 1, citationNotMeasuredQueries: 1 },
      branded: { totalQueries: 1, citedQueries: 0, mentionedQueries: 1, citationNotMeasuredQueries: 0 },
      unclassifiedQueries: 1,
    })
    // No query is double counted or dropped: the classes and the unclassified ones make up the pooled total.
    const pooled = summarizeObservedQueryCounts(snapshots)
    expect(pooled.totalQueries).toBe(4)
    expect(split!.nonBrand.totalQueries + split!.branded.totalQueries + split!.unclassifiedQueries).toBe(pooled.totalQueries)
  })

  it('is null when queries were observed and none has a class, so the counts can only be pooled', () => {
    expect(summarizeObservedQueryCountsByClass([
      { queryId: 'u1', citationState: CitationStates.cited, answerMentioned: true },
      { queryId: 'u1', citationState: CitationStates['not-cited'], answerMentioned: false },
    ], classOf)).toBeNull()
  })

  it('reports zero for both classes when no query was observed', () => {
    expect(summarizeObservedQueryCountsByClass([], classOf)).toEqual({ nonBrand: zero, branded: zero, unclassifiedQueries: 0 })
  })
})
