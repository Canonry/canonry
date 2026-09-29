import { describe, expect, it } from 'vitest'
import type { QueryClass } from '@ainyc/canonry-contracts'
import {
  answerChangePhrase,
  buildAnswerMovement,
  buildVisibilityRows,
  coverageTone,
  groupAnswerChanges,
  rowStatus,
  signalMovePhrase,
  visibilityStatusLabel,
  type VisibilityRow,
} from '../src/lib/answer-movement.js'
import { formatSweepInstant } from '../src/lib/format-helpers.js'
import type { CitationInsightVm, MovementComparisonVm, MovementSummaryVm } from '../src/view-models.js'
import {
  AINYC_PREVIOUS_RUN,
  ainycComparison,
  ainycEvidence,
  ainycMovement,
} from './ainyc-visibility-fixture.js'

const classifyFrom = (evidence: readonly CitationInsightVm[]) => {
  const known = new Map(evidence.map(row => [row.query, row.queryClass ?? null]))
  return (text: string): QueryClass | null => known.get(text) ?? (/canonry/i.test(text) ? 'branded' : 'non-brand')
}

function movement(gainedQueries: string[] = [], lostQueries: string[] = []): MovementSummaryVm {
  return { gained: gainedQueries.length, lost: lostQueries.length, tone: 'neutral', hasPreviousRun: true, gainedQueries, lostQueries }
}

function ainycRows(overrides: { mention?: MovementSummaryVm; citation?: MovementSummaryVm; comparison?: MovementComparisonVm; evidence?: CitationInsightVm[] } = {}) {
  const evidence = overrides.evidence ?? ainycEvidence()
  return buildVisibilityRows({
    evidence,
    mentionMovement: overrides.mention ?? ainycMovement(),
    citationMovement: overrides.citation ?? ainycMovement(),
    comparison: overrides.comparison ?? ainycComparison(),
    classify: classifyFrom(evidence),
  })
}

function ainycAnswers(evidence = ainycEvidence()) {
  return buildAnswerMovement({
    evidence,
    previousRunAt: AINYC_PREVIOUS_RUN.createdAt,
    addedQueries: ainycComparison().addedQueries,
    classify: classifyFrom(evidence),
  })
}

describe('buildVisibilityRows on ainyc stored data', () => {
  it('splits the 14 queries into non-brand 4 of 11 and branded 3 of 3, never 7 of 14', () => {
    const rows = ainycRows()
    expect(rows.map(row => [row.key, row.mentioned, row.cited, row.total])).toEqual([
      ['non-brand', 4, 4, 11],
      ['branded', 3, 3, 3],
    ])
    expect(rows.map(row => visibilityStatusLabel(row))).toEqual([
      { word: 'no change', suffix: null },
      { word: 'first AI sweep', suffix: null },
    ])
  })

  it('does not count a history-only row (its latest call errored) toward the latest sweep', () => {
    const evidence = ainycEvidence().map(row => row.query === 'AI SEO agency NYC' && row.provider === 'claude'
      ? { ...row, sourceRunId: null, answerMentioned: undefined, citationState: 'cited' as const, runHistory: row.runHistory.slice(0, 1) }
      : row)
    const [nonBrand] = ainycRows({ evidence })
    expect([nonBrand!.cited, nonBrand!.total]).toEqual([4, 11])
  })
})

describe('Visibility status words', () => {
  const base = { mention: { gained: 0, lost: 0 }, citation: { gained: 0, lost: 0 } }

  it('reads no change, up n, down n, and changed by the query counts', () => {
    expect(rowStatus(base.mention, base.citation)).toEqual({ kind: 'no-change' })
    expect(rowStatus({ gained: 2, lost: 0 }, { gained: 2, lost: 0 })).toEqual({ kind: 'up', count: 2 })
    expect(rowStatus({ gained: 0, lost: 1 }, { gained: 0, lost: 1 })).toEqual({ kind: 'down', count: 1 })
    // One moved, the other held.
    expect(rowStatus({ gained: 1, lost: 0 }, base.citation)).toEqual({ kind: 'up', count: 1 })
    expect(rowStatus(base.mention, { gained: 0, lost: 3 })).toEqual({ kind: 'down', count: 3 })
    // Opposite directions, different sizes, or gains and losses inside one signal.
    expect(rowStatus({ gained: 1, lost: 0 }, { gained: 0, lost: 1 })).toEqual({ kind: 'changed' })
    expect(rowStatus({ gained: 1, lost: 0 }, { gained: 2, lost: 0 })).toEqual({ kind: 'changed' })
    expect(rowStatus({ gained: 1, lost: 1 }, base.citation)).toEqual({ kind: 'changed' })
    // A split the page could not place reads changed, never no change.
    expect(rowStatus(null, base.citation)).toEqual({ kind: 'changed' })
  })

  it('suffixes "· n added" on any status but the first AI sweep', () => {
    const row = (status: VisibilityRow['status'], added: number) => visibilityStatusLabel({ status, added })
    expect(row({ kind: 'no-change' }, 2)).toEqual({ word: 'no change', suffix: '· 2 added' })
    expect(row({ kind: 'up', count: 1 }, 1)).toEqual({ word: 'up 1', suffix: '· 1 added' })
    expect(row({ kind: 'not-compared' }, 3)).toEqual({ word: 'not compared', suffix: '· 3 added' })
    expect(row({ kind: 'first-sweep' }, 3)).toEqual({ word: 'first AI sweep', suffix: null })
    expect(row({ kind: 'changed' }, 0)).toEqual({ word: 'changed', suffix: null })
  })

  it('adds to a row that already had queries and compares only the ones in both sweeps', () => {
    const comparison = { ...ainycComparison(), addedQueries: ['Canonry', 'best AEO agency New York'], addedQueryCount: 2, comparableQueryCount: 12 }
    const [nonBrand, branded] = ainycRows({ comparison })
    expect([nonBrand!.comparable, nonBrand!.added]).toEqual([10, 1])
    expect(visibilityStatusLabel(nonBrand!)).toEqual({ word: 'no change', suffix: '· 1 added' })
    expect([branded!.comparable, branded!.added]).toEqual([2, 1])
    expect(visibilityStatusLabel(branded!)).toEqual({ word: 'no change', suffix: '· 1 added' })
  })

  it('reads not compared when a row had queries last sweep but none are in both', () => {
    const comparison = { ...ainycComparison(), removedQueries: ['canonry pricing'], removedQueryCount: 1 }
    const [, branded] = ainycRows({ comparison })
    expect(visibilityStatusLabel(branded!)).toEqual({ word: 'not compared', suffix: '· 3 added' })
  })

  it('reads first AI sweep on every row when there is no earlier sweep', () => {
    const comparison = { ...ainycComparison(), hasPreviousRun: false, previousRunAt: null, addedQueries: [], addedQueryCount: 0 }
    expect(ainycRows({ comparison }).map(row => visibilityStatusLabel(row).word)).toEqual(['first AI sweep', 'first AI sweep'])
  })

  it('splits the server query movement by class', () => {
    const rows = ainycRows({
      mention: movement(['AI SEO agency NYC'], ['NYC AEO Agency']),
      citation: movement(['AI SEO agency NYC']),
    })
    expect(rows[0]!.mention).toEqual({ gained: 1, lost: 1 })
    expect(rows[0]!.citation).toEqual({ gained: 1, lost: 0 })
    expect(visibilityStatusLabel(rows[0]!).word).toBe('changed')
    expect(`mentioned ${signalMovePhrase(rows[0]!.mention!)}, cited ${signalMovePhrase(rows[0]!.citation!)}`)
      .toBe('mentioned up 1 and down 1, cited up 1')
  })

  it('reads changed, not no change, when a moved query has no text to place it by', () => {
    const unplaced = { ...movement(), gained: 1 }
    const rows = ainycRows({ mention: unplaced, comparison: { ...ainycComparison(), addedQueries: [], addedQueryCount: 0 } })
    expect(rows.map(row => visibilityStatusLabel(row).word)).toEqual(['changed', 'changed'])

    // With one row there is only one place the move can belong.
    const nonBrandOnly = ainycEvidence().filter(row => row.queryClass === 'non-brand')
    const [only] = ainycRows({ mention: unplaced, evidence: nonBrandOnly, comparison: { ...ainycComparison(), addedQueries: [], addedQueryCount: 0 } })
    expect(visibilityStatusLabel(only!).word).toBe('up 1')
  })

  it('keeps one unclassified row when the project cannot classify queries', () => {
    const evidence = ainycEvidence().map(row => ({ ...row, queryClass: null }))
    const rows = buildVisibilityRows({
      evidence,
      mentionMovement: ainycMovement(),
      citationMovement: ainycMovement(),
      comparison: ainycComparison(),
      classify: () => null,
    })
    expect(rows.map(row => [row.key, row.mentioned, row.total, row.added])).toEqual([['unclassified', 7, 14, 3]])
    expect(visibilityStatusLabel(rows[0]!)).toEqual({ word: 'no change', suffix: '· 3 added' })
  })
})

describe('buildAnswerMovement', () => {
  it('reproduces ainyc: 7 of 44 mentioned (was 6), 9 of 44 cited (was 8), Perplexity on NYC AEO Agency', () => {
    const answers = ainycAnswers()
    expect(answers.byRow.get('non-brand')).toEqual({ total: 44, mentionedNow: 7, mentionedBefore: 6, citedNow: 9, citedBefore: 8 })
    // The added branded queries have nothing to compare against.
    expect(answers.byRow.has('branded')).toBe(false)
    expect(answers.changes).toEqual([
      { provider: 'perplexity', location: 'nyc', query: 'NYC AEO Agency', mention: 'gained', citation: 'gained' },
    ])
    expect(groupAnswerChanges(answers.changes)).toEqual([
      { provider: 'perplexity', location: null, phrase: 'now mentions and cites you', queries: ['NYC AEO Agency'] },
    ])
  })

  it('leaves an engine whose previous call errored out of both counts instead of reading a gain', () => {
    // Perplexity errored on "NYC AEO Agency" last sweep: it has no point there.
    const evidence = ainycEvidence().map(row => row.query === 'NYC AEO Agency' && row.provider === 'perplexity'
      ? { ...row, runHistory: row.runHistory.filter(point => point.runId !== AINYC_PREVIOUS_RUN.id) }
      : row)
    const answers = ainycAnswers(evidence)
    expect(answers.byRow.get('non-brand')).toEqual({ total: 43, mentionedNow: 6, mentionedBefore: 6, citedNow: 8, citedBefore: 8 })
    expect(answers.changes).toEqual([])
  })

  it('leaves an engine whose latest call errored out of both counts', () => {
    // A history-only row: no latest snapshot, its last point is the earlier sweep.
    const evidence = ainycEvidence().map(row => row.query === 'AEO Agency NYC' && row.provider === 'gemini'
      ? { ...row, sourceRunId: null, answerMentioned: undefined, runHistory: row.runHistory.slice(0, 1) }
      : row)
    expect(ainycAnswers(evidence).byRow.get('non-brand')).toEqual({ total: 43, mentionedNow: 6, mentionedBefore: 5, citedNow: 8, citedBefore: 7 })
  })

  it('leaves out an answer with no mention result in either sweep', () => {
    const evidence = ainycEvidence().map(row => row.query === 'NYC AEO Agency' && row.provider === 'perplexity'
      ? { ...row, runHistory: row.runHistory.map(point => point.runId === AINYC_PREVIOUS_RUN.id ? { ...point, answerMentioned: undefined } : point) }
      : row)
    expect(ainycAnswers(evidence).byRow.get('non-brand')?.total).toBe(43)
    expect(ainycAnswers(evidence).changes).toEqual([])
  })

  it('ignores ambiguous and engine-pooled histories', () => {
    const evidence = ainycEvidence().map(row => {
      if (row.query === 'NYC AEO Agency' && row.provider === 'perplexity') {
        // Two points at the previous instant (a cross-location series): neither counts.
        return { ...row, runHistory: [row.runHistory[0]!, { ...row.runHistory[0]!, answerMentioned: true }, row.runHistory[1]!] }
      }
      if (row.query === 'AEO Agency NYC' && row.provider === 'gemini') return { ...row, historyScope: 'query' as const }
      return row
    })
    expect(ainycAnswers(evidence).byRow.get('non-brand')?.total).toBe(42)
  })

  it('lists both sides when one engine gains what another loses, so "was" can equal "now"', () => {
    // An answer that mentioned and cited you in both sweeps, other than the
    // Perplexity gain, now does neither.
    const lost = ainycEvidence().find(row => {
      if (row.provider === 'perplexity' && row.query === 'NYC AEO Agency') return false
      const now = row.runHistory.find(point => point.runId === row.sourceRunId)
      const before = row.runHistory.find(point => point.runId === AINYC_PREVIOUS_RUN.id)
      return now?.answerMentioned === true && before?.answerMentioned === true
        && now.citationState === 'cited' && before.citationState === 'cited'
    })!
    expect(lost).toBeTruthy()
    const evidence = ainycEvidence().map(row => row.id !== lost.id ? row : {
      ...row,
      runHistory: row.runHistory.map(point => point.runId === row.sourceRunId
        ? { ...point, answerMentioned: false, citationState: 'not-cited' as const }
        : point),
    })
    const answers = ainycAnswers(evidence)
    expect(answers.byRow.get('non-brand')).toEqual({ total: 44, mentionedNow: 6, mentionedBefore: 6, citedNow: 8, citedBefore: 8 })
    expect(answers.changes).toHaveLength(2)
    expect(groupAnswerChanges(answers.changes).map(group => group.phrase).sort()).toEqual([
      'no longer mentions or cites you',
      'now mentions and cites you',
    ])
  })

  it('compares nothing without a previous sweep', () => {
    const answers = buildAnswerMovement({ evidence: ainycEvidence(), previousRunAt: null, addedQueries: [], classify: () => 'non-brand' })
    expect(answers.byRow.size).toBe(0)
    expect(answers.changes).toEqual([])
  })

  it('matches the previous sweep by instant, not by string spelling', () => {
    const answers = buildAnswerMovement({
      evidence: ainycEvidence(),
      previousRunAt: '2026-09-29T05:41:26.139-04:00',
      addedQueries: ainycComparison().addedQueries,
      classify: () => 'non-brand',
    })
    expect(answers.byRow.get('non-brand')?.total).toBe(44)
  })
})

describe('answer change wording', () => {
  it('says what the engine now does differently', () => {
    expect(answerChangePhrase({ mention: 'gained', citation: 'gained' })).toBe('now mentions and cites you')
    expect(answerChangePhrase({ mention: 'gained', citation: null })).toBe('now mentions you')
    expect(answerChangePhrase({ mention: null, citation: 'gained' })).toBe('now cites you')
    expect(answerChangePhrase({ mention: 'lost', citation: 'lost' })).toBe('no longer mentions or cites you')
    expect(answerChangePhrase({ mention: 'lost', citation: null })).toBe('no longer mentions you')
    expect(answerChangePhrase({ mention: null, citation: 'lost' })).toBe('no longer cites you')
    expect(answerChangePhrase({ mention: 'gained', citation: 'lost' })).toBe('now mentions but no longer cites you')
    expect(answerChangePhrase({ mention: 'lost', citation: 'gained' })).toBe('now cites but no longer mentions you')
  })

  it('groups queries per engine and names a location only when changes span several', () => {
    const change = (provider: string, location: string | null, query: string) => ({ provider, location, query, mention: 'gained' as const, citation: null })
    expect(groupAnswerChanges([change('openai', 'nyc', 'b'), change('openai', 'nyc', 'a'), change('claude', 'nyc', 'c')])).toEqual([
      { provider: 'claude', location: null, phrase: 'now mentions you', queries: ['c'] },
      { provider: 'openai', location: null, phrase: 'now mentions you', queries: ['a', 'b'] },
    ])
    expect(groupAnswerChanges([change('openai', 'nyc', 'a'), change('openai', 'la', 'a')]).map(group => group.location)).toEqual(['la', 'nyc'])
  })
})

describe('coverageTone', () => {
  it('reads 70% and up positive and anything less caution, never negative', () => {
    expect(coverageTone(7, 10)).toBe('positive')
    expect(coverageTone(69, 100)).toBe('caution')
    expect(coverageTone(4, 10)).toBe('caution')
    // ainyc's non-brand 4 of 11 is amber on the approved card, and so is 0.
    expect(coverageTone(4, 11)).toBe('caution')
    expect(coverageTone(0, 11)).toBe('caution')
    expect(coverageTone(0, 0)).toBe('neutral')
  })
})

describe('formatSweepInstant', () => {
  const at = (year: number, month: number, day: number, hour: number, minute: number) => new Date(year, month - 1, day, hour, minute).toISOString()
  const now = new Date(2026, 8, 29, 12, 0)
  // Some ICU builds put a narrow no-break space before AM/PM.
  const format = (...args: Parameters<typeof formatSweepInstant>) => formatSweepInstant(...args).replace(/\u202f/g, ' ')

  it('shows only the time when the sentence already names the day', () => {
    expect(format(at(2026, 9, 29, 5, 41), at(2026, 9, 29, 5, 59), now)).toBe('5:41 AM')
  })

  it('names the day otherwise, and the year only outside the current one', () => {
    expect(format(at(2026, 7, 14, 2, 0), at(2026, 9, 29, 5, 59), now)).toBe('Jul 14, 2:00 AM')
    expect(format(at(2025, 9, 29, 5, 59), null, now)).toBe('Sep 29, 2025, 5:59 AM')
  })
})
