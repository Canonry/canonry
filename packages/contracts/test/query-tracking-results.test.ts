import { describe, expect, it } from 'vitest'
import {
  queryTrackingEngineResultSchema,
  queryTrackingResultsRequestSchema,
  queryTrackingResultsResponseSchema,
} from '../src/query-tracking-results.js'

/** One engine entry as a server sent it before any optional field existed: three answers, one mentioned, one cited. */
const ENTRY = {
  provider: 'gemini', expectedAnswers: 3, answers: 3, mentionedAnswers: 1, citedAnswers: 1, uncheckedSourceAnswers: 1, mentioned: true, cited: true,
}
const ANSWER_ROW = {
  resultId: 'answer-1', searchLocation: 'riverside', targetKeys: ['harbor-point'], mentioned: false, cited: null,
  mentionedTargetKeys: [], citedTargetKeys: [], namedInstead: ['Oakline Residences'],
}
const issues = (entry: Record<string, unknown>) => {
  const parsed = queryTrackingEngineResultSchema.safeParse(entry)
  return parsed.success ? [] : parsed.error.issues.map(issue => issue.path.join('.'))
}

describe('query tracking results contract', () => {
  it('reads an engine entry with none of the optional fields, and one with all of them', () => {
    expect(queryTrackingEngineResultSchema.parse(ENTRY)).toStrictEqual(ENTRY)
    const full = {
      ...ENTRY,
      // Two answers do not mention the row: one names another location, one could not be tied to a location.
      unattributedMentionAnswers: 1,
      mentionedTargetKeys: ['harbor-point'], citedTargetKeys: ['pier-house'],
      otherLocationMentionedAnswers: 1, otherLocationMentionedTargetKeys: ['lakeshore'],
      // One answer has checked sources and does not cite the row.
      otherLocationCitedAnswers: 1, otherLocationCitedTargetKeys: ['lakeshore'],
      answerRows: [ANSWER_ROW, ANSWER_ROW, ANSWER_ROW],
    }
    expect(queryTrackingEngineResultSchema.parse(full)).toStrictEqual(full)
  })

  it('refuses another-location counts that cannot be true of the answers beside them', () => {
    // A count is sent with the locations it counted, and the locations with their count.
    expect(issues({ ...ENTRY, otherLocationMentionedAnswers: 1 })).toEqual(['otherLocationMentionedTargetKeys'])
    expect(issues({ ...ENTRY, otherLocationMentionedTargetKeys: ['lakeshore'] })).toEqual(['otherLocationMentionedTargetKeys'])
    expect(issues({ ...ENTRY, otherLocationCitedAnswers: 1 })).toEqual(['otherLocationCitedTargetKeys'])
    // Nothing to report is an absent field, never a zero or an empty list.
    expect(issues({ ...ENTRY, otherLocationMentionedAnswers: 0, otherLocationMentionedTargetKeys: [] })).toEqual(['otherLocationMentionedAnswers', 'otherLocationMentionedTargetKeys'])
    expect(issues({ ...ENTRY, mentionedTargetKeys: [] })).toEqual(['mentionedTargetKeys'])
    expect(issues({ ...ENTRY, unattributedMentionAnswers: 0 })).toEqual(['unattributedMentionAnswers'])

    // Only an answer that does not mention the row can name another location: 3 answers, 1 mentioned, so 2 at most.
    const mentioned = { otherLocationMentionedTargetKeys: ['lakeshore'] }
    expect(issues({ ...ENTRY, ...mentioned, otherLocationMentionedAnswers: 2 })).toEqual([])
    expect(issues({ ...ENTRY, ...mentioned, otherLocationMentionedAnswers: 3 })).toEqual(['otherLocationMentionedAnswers'])
    // An answer left unchecked is not one that names another location: with 1 unchecked, 1 is left.
    expect(issues({ ...ENTRY, ...mentioned, otherLocationMentionedAnswers: 1, unattributedMentionAnswers: 1 })).toEqual([])
    expect(issues({ ...ENTRY, ...mentioned, otherLocationMentionedAnswers: 2, unattributedMentionAnswers: 1 })).toEqual(['otherLocationMentionedAnswers'])
    expect(issues({ ...ENTRY, unattributedMentionAnswers: 3 })).toEqual(['unattributedMentionAnswers'])
    // Only an answer with checked sources that does not cite the row can cite another: 3 answers, 1 cited, 1 unchecked, so 1.
    const cited = { otherLocationCitedTargetKeys: ['lakeshore'] }
    expect(issues({ ...ENTRY, ...cited, otherLocationCitedAnswers: 1 })).toEqual([])
    expect(issues({ ...ENTRY, ...cited, otherLocationCitedAnswers: 2 })).toEqual(['otherLocationCitedAnswers'])
  })

  it('needs one answer row per expected answer', () => {
    expect(issues({ ...ENTRY, answerRows: [ANSWER_ROW, ANSWER_ROW, ANSWER_ROW] })).toEqual([])
    expect(issues({ ...ENTRY, answerRows: [ANSWER_ROW] })).toEqual(['answerRows'])
    // An expected answer that was never saved is still a row, with nothing to open.
    const missing = { ...ANSWER_ROW, resultId: null, searchLocation: null, mentioned: null, namedInstead: [] }
    expect(queryTrackingEngineResultSchema.parse({ ...ENTRY, expectedAnswers: 4, answerRows: [ANSWER_ROW, ANSWER_ROW, ANSWER_ROW, missing] }).answerRows?.[3]).toStrictEqual(missing)
  })

  it('takes one query in the selection, and refuses a blank one', () => {
    expect(queryTrackingResultsRequestSchema.parse({ queryId: 'q-1' })).toStrictEqual({ scope: 'project', queryId: 'q-1' })
    expect(queryTrackingResultsRequestSchema.parse({ scope: 'market', scopeKey: 'lakeshore-metro', queryId: 'q-1' }))
      .toStrictEqual({ scope: 'market', scopeKey: 'lakeshore-metro', queryId: 'q-1' })
    expect(queryTrackingResultsRequestSchema.safeParse({ queryId: ' ' }).success).toBe(false)
  })

  it('reads a response with totals and ranked weak markets, and one from a server that sends neither', () => {
    const older = {
      mode: 'advanced', scope: { kind: 'project', key: null },
      run: { id: 'run-1', createdAt: '2026-10-07T12:00:00.000Z', completedAt: '2026-10-07T12:00:00.000Z', status: 'completed', revision: 1, matchesCurrentTracking: true },
      engines: ['gemini'],
      rows: [{ queryId: 'q-1', queryText: 'best homes in lakeshore metro', queryClass: 'non-brand', engines: [ENTRY] }],
      pendingRows: 0,
      weakMarkets: { rule: 'no-mention-latest-sweep', queryClass: 'non-brand', count: 1, marketKeys: ['lakeshore-metro'] },
    }
    expect(queryTrackingResultsResponseSchema.parse(older)).toStrictEqual(older)

    const current = {
      ...older,
      totals: [{
        queryClass: 'non-brand', queries: 1, answers: 3,
        mentionCoverage: { numerator: 1, denominator: 3, rate: 1 / 3 },
        // One answer's sources were partly saved, so it is in neither side.
        citationCoverage: { numerator: 1, denominator: 2, rate: 0.5, unchecked: 1 },
      }],
      weakMarkets: {
        ...older.weakMarkets,
        markets: [{ marketKey: 'lakeshore-metro', queries: 4, mentionCheckedAnswers: 11, mentionedAnswers: 0, otherLocationMentionedAnswers: 2, citationCheckedAnswers: 10, citedAnswers: 1 }],
      },
    }
    expect(queryTrackingResultsResponseSchema.parse(current)).toStrictEqual(current)
    // A total is the report's own rate: a number without its denominator is refused.
    const broken = { ...current, totals: [{ ...current.totals[0]!, mentionCoverage: { numerator: 1, denominator: null, rate: null } }] }
    expect(queryTrackingResultsResponseSchema.safeParse(broken).success).toBe(false)
  })
})
