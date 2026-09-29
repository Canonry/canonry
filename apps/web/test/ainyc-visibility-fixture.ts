import type { QueryClass } from '@ainyc/canonry-contracts'
import type { CitationInsightVm, MovementComparisonVm, MovementSummaryVm, RunHistoryPoint } from '../src/view-models.js'

/**
 * ainyc's two Sep 29 sweeps, in the shape the dashboard builds from stored
 * data: run ccc39ad8 (09:41 UTC, 11 non-brand queries) and run f70b8315 (09:59
 * UTC, the same 11 plus 3 branded ones). Each state is "MC" (mentioned and
 * cited), "M-", "-C" or "--", per engine in ENGINES order; `null` means the
 * query was not in the earlier sweep.
 */
export const AINYC_PREVIOUS_RUN = { id: 'ccc39ad8-af1d-4efd-b134-9876b85174ab', createdAt: '2026-09-29T09:41:26.139Z' }
export const AINYC_LATEST_RUN = { id: 'f70b8315-de44-44b8-b90e-74e253dbb362', createdAt: '2026-09-29T09:59:38.415Z' }

const ENGINES = ['claude', 'gemini', 'openai', 'perplexity'] as const
type State = 'MC' | 'M-' | '-C' | '--'

const QUERIES: ReadonlyArray<[query: string, queryClass: QueryClass, previous: readonly State[] | null, latest: readonly State[]]> = [
  ['AEO Agency NYC', 'non-brand', ['--', 'MC', '--', 'MC'], ['--', 'MC', '--', 'MC']],
  ['AEO Agency in NYC', 'non-brand', ['--', 'MC', '--', 'MC'], ['--', 'MC', '--', 'MC']],
  ['AI SEO agency NYC', 'non-brand', ['--', '--', '--', '--'], ['--', '--', '--', '--']],
  ['Answer Engine Optimization Agency NYC', 'non-brand', ['MC', '--', '--', '-C'], ['MC', '--', '--', '-C']],
  ['Canonry', 'branded', null, ['M-', 'MC', 'M-', 'MC']],
  ['Canonry AEO agency', 'branded', null, ['MC', 'MC', 'MC', 'MC']],
  ['Canonry reviews', 'branded', null, ['MC', 'MC', 'MC', 'MC']],
  ['NYC AEO Agency', 'non-brand', ['-C', 'MC', '--', '--'], ['-C', 'MC', '--', 'MC']],
  ['best AEO agency New York', 'non-brand', ['--', '--', '--', '--'], ['--', '--', '--', '--']],
  ['generative engine optimization agency NYC', 'non-brand', ['--', '--', '--', '--'], ['--', '--', '--', '--']],
  ['how to appear in AI search results', 'non-brand', ['--', '--', '--', '--'], ['--', '--', '--', '--']],
  ['how to get my business cited by AI', 'non-brand', ['--', '--', '--', '--'], ['--', '--', '--', '--']],
  ['how to rank on ChatGPT', 'non-brand', ['--', '--', '--', '--'], ['--', '--', '--', '--']],
  ['optimize website for AI search', 'non-brand', ['--', '--', '--', '--'], ['--', '--', '--', '--']],
]

function point(run: { id: string; createdAt: string }, state: State): RunHistoryPoint {
  return {
    runId: run.id,
    createdAt: run.createdAt,
    citationState: state.endsWith('C') ? 'cited' : 'not-cited',
    answerMentioned: state.startsWith('M'),
  }
}

/** One evidence row per query and engine, as `buildEvidenceFromTimeline` emits them. */
export function ainycEvidence(): CitationInsightVm[] {
  return QUERIES.flatMap(([query, queryClass, previous, latest]) => ENGINES.map((provider, index): CitationInsightVm => {
    const now = latest[index]!
    const before = previous?.[index]
    return {
      id: `evidence_ainyc_${query}_${provider}`,
      query,
      queryClass,
      provider,
      model: null,
      location: 'nyc',
      sourceRunId: AINYC_LATEST_RUN.id,
      sourceSnapshotId: `snapshot_${query}_${provider}`,
      citationState: now.endsWith('C') ? (before && !before.endsWith('C') ? 'emerging' : 'cited') : 'not-cited',
      answerMentioned: now.startsWith('M'),
      changeLabel: '',
      answerSnippet: '',
      citedDomains: [],
      evidenceUrls: [],
      competitorDomains: [],
      groundingSources: [],
      relatedTechnicalSignals: [],
      summary: '',
      historyScope: 'provider',
      runHistory: [
        ...(before ? [point(AINYC_PREVIOUS_RUN, before)] : []),
        point(AINYC_LATEST_RUN, now),
      ],
    }
  }))
}

/** `movementComparison` from ainyc's stored GET /overview. */
export function ainycComparison(): MovementComparisonVm {
  return {
    hasPreviousRun: true,
    comparable: false,
    querySetChanged: true,
    previousRunAt: AINYC_PREVIOUS_RUN.createdAt,
    currentQueryCount: 14,
    previousQueryCount: 11,
    comparableQueryCount: 11,
    addedQueryCount: 3,
    removedQueryCount: 0,
    addedQueries: ['Canonry', 'Canonry AEO agency', 'Canonry reviews'],
    removedQueries: [],
  }
}

/** ainyc's `mentionMovement` and `citationMovement`: no query gained or lost. */
export function ainycMovement(): MovementSummaryVm {
  return { gained: 0, lost: 0, tone: 'neutral', hasPreviousRun: true, gainedQueries: [], lostQueries: [] }
}
