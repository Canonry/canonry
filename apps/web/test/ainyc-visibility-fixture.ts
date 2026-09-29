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

/**
 * ainyc's stored GET /analytics/metrics responses, as the page receives them:
 * the All window (five points, the last pooling both Sep 29 sweeps) and the 7
 * day window (that one point, with every model change inherited from before
 * it). Copied from the API, not idealized.
 */
const AINYC_METRICS_ALL = {
  window: 'all',
  mentionShareScope: 'non-brand',
  buckets: [
    { startDate: '2026-03-14T00:00:00.000Z', endDate: '2026-04-13T00:00:00.000Z', dataStartDate: '2026-03-14T00:11:00.638Z', dataEndDate: '2026-04-08T14:02:09.256Z', sweepCount: 41, citationRate: 0.2, cited: 222, total: 1110, queryCount: 11, mentionRate: 0.2054, mentionedCount: 228, mentionShare: { scope: 'non-brand', rate: 0.34650456, projectMentionSnapshots: 228, competitorMentionSnapshots: 430 }, byProvider: { claude: { citationRate: 0.5194, cited: 147, total: 283, mentionRate: 0.5194, mentionedCount: 147 }, gemini: { citationRate: 0.0261, cited: 8, total: 307, mentionRate: 0.0326, mentionedCount: 10 }, openai: { citationRate: 0.2233, cited: 67, total: 300, mentionRate: 0.2233, mentionedCount: 67 }, perplexity: { citationRate: 0, cited: 0, total: 220, mentionRate: 0.0182, mentionedCount: 4 } }, modelEvidenceByProvider: { claude: { status: 'mixed', models: ['claude-opus-4-6', 'claude-sonnet-4-6'], includesUnknown: false }, gemini: { status: 'mixed', models: ['gemini-2.5-flash', 'gemini-3-flash-preview'], includesUnknown: false }, openai: { status: 'mixed', models: ['gpt-4o', 'gpt-5.4'], includesUnknown: false }, perplexity: { status: 'known', model: 'sonar' } }, basketRevision: null },
    { startDate: '2026-04-13T00:00:00.000Z', endDate: '2026-05-13T00:00:00.000Z', dataStartDate: '2026-04-14T02:20:55.865Z', dataEndDate: '2026-05-12T06:00:00.007Z', sweepCount: 7, citationRate: 0.1721, cited: 53, total: 308, queryCount: 11, mentionRate: 0.1851, mentionedCount: 57, mentionShare: { scope: 'non-brand', rate: 0.33928571, projectMentionSnapshots: 57, competitorMentionSnapshots: 111 }, byProvider: { perplexity: { citationRate: 0, cited: 0, total: 77, mentionRate: 0.013, mentionedCount: 1 }, openai: { citationRate: 0.3117, cited: 24, total: 77, mentionRate: 0.2987, mentionedCount: 23 }, claude: { citationRate: 0.3766, cited: 29, total: 77, mentionRate: 0.3766, mentionedCount: 29 }, gemini: { citationRate: 0, cited: 0, total: 77, mentionRate: 0.0519, mentionedCount: 4 } }, modelEvidenceByProvider: { perplexity: { status: 'known', model: 'sonar' }, openai: { status: 'known', model: 'gpt-5.4' }, claude: { status: 'known', model: 'claude-sonnet-4-6' }, gemini: { status: 'known', model: 'gemini-3-flash-preview' } }, basketRevision: null },
    { startDate: '2026-05-13T00:00:00.000Z', endDate: '2026-06-12T00:00:00.000Z', dataStartDate: '2026-05-13T06:00:00.007Z', dataEndDate: '2026-05-28T20:30:59.109Z', sweepCount: 2, citationRate: 0.1705, cited: 15, total: 88, queryCount: 11, mentionRate: 0.2045, mentionedCount: 18, mentionShare: { scope: 'non-brand', rate: 0.33962264, projectMentionSnapshots: 18, competitorMentionSnapshots: 35 }, byProvider: { gemini: { citationRate: 0, cited: 0, total: 22, mentionRate: 0, mentionedCount: 0 }, perplexity: { citationRate: 0, cited: 0, total: 22, mentionRate: 0.0455, mentionedCount: 1 }, claude: { citationRate: 0.3636, cited: 8, total: 22, mentionRate: 0.3636, mentionedCount: 8 }, openai: { citationRate: 0.3182, cited: 7, total: 22, mentionRate: 0.4091, mentionedCount: 9 } }, modelEvidenceByProvider: { gemini: { status: 'known', model: 'gemini-3-flash-preview' }, perplexity: { status: 'known', model: 'sonar' }, claude: { status: 'known', model: 'claude-sonnet-4-6' }, openai: { status: 'known', model: 'gpt-5.4' } }, basketRevision: null },
    { startDate: '2026-07-12T00:00:00.000Z', endDate: '2026-08-11T00:00:00.000Z', dataStartDate: '2026-07-14T06:00:00.016Z', dataEndDate: '2026-07-14T06:00:00.016Z', sweepCount: 1, citationRate: 0.0455, cited: 2, total: 44, queryCount: 11, mentionRate: 0.0455, mentionedCount: 2, mentionShare: { scope: 'non-brand', rate: 0.14285714, projectMentionSnapshots: 2, competitorMentionSnapshots: 12 }, byProvider: { gemini: { citationRate: 0, cited: 0, total: 11, mentionRate: 0, mentionedCount: 0 }, openai: { citationRate: 0, cited: 0, total: 11, mentionRate: 0, mentionedCount: 0 }, perplexity: { citationRate: 0, cited: 0, total: 11, mentionRate: 0, mentionedCount: 0 }, claude: { citationRate: 0.1818, cited: 2, total: 11, mentionRate: 0.1818, mentionedCount: 2 } }, modelEvidenceByProvider: { gemini: { status: 'known', model: 'gemini-3-flash-preview' }, openai: { status: 'known', model: 'gpt-5.4' }, perplexity: { status: 'known', model: 'sonar' }, claude: { status: 'known', model: 'claude-sonnet-4-6' } }, basketRevision: null },
    { startDate: '2026-09-10T00:00:00.000Z', endDate: '2026-10-10T00:00:00.000Z', dataStartDate: '2026-09-29T09:41:26.139Z', dataEndDate: '2026-09-29T09:59:38.415Z', sweepCount: 2, citationRate: 0.27, cited: 27, total: 100, queryCount: 14, mentionRate: 0.25, mentionedCount: 25, mentionShare: { scope: 'non-brand', rate: 0.31707317, projectMentionSnapshots: 13, competitorMentionSnapshots: 28 }, byProvider: { gemini: { citationRate: 0.36, cited: 9, total: 25, mentionRate: 0.36, mentionedCount: 9 }, openai: { citationRate: 0.08, cited: 2, total: 25, mentionRate: 0.12, mentionedCount: 3 }, perplexity: { citationRate: 0.4, cited: 10, total: 25, mentionRate: 0.32, mentionedCount: 8 }, claude: { citationRate: 0.24, cited: 6, total: 25, mentionRate: 0.2, mentionedCount: 5 } }, modelEvidenceByProvider: { gemini: { status: 'known', model: 'gemini-3.5-flash' }, openai: { status: 'known', model: 'chat-latest' }, perplexity: { status: 'known', model: 'fast' }, claude: { status: 'known', model: 'claude-sonnet-5' } }, basketRevision: null },
  ],
  overall: { citationRate: 0.1933, cited: 319, total: 1650, mentionRate: 0.2, mentionedCount: 330 },
  byProvider: { claude: { citationRate: 0.4593, cited: 192, total: 418, mentionRate: 0.4569, mentionedCount: 191 }, gemini: { citationRate: 0.0385, cited: 17, total: 442, mentionRate: 0.052, mentionedCount: 23 }, openai: { citationRate: 0.2299, cited: 100, total: 435, mentionRate: 0.2345, mentionedCount: 102 }, perplexity: { citationRate: 0.0282, cited: 10, total: 355, mentionRate: 0.0394, mentionedCount: 14 } },
  trend: 'stable',
  mentionTrend: 'stable',
  windowChange: { citationRate: { first: 0.2, latest: 0.27, delta: 0.07 }, mentionRate: { first: 0.2054, latest: 0.25, delta: 0.0446 }, mentionShare: { first: 0.34650456, latest: 0.31707317, delta: -0.02943139 } },
  queryChanges: [{ date: '2026-09-29T00:00:00.000Z', delta: 3, label: '+3 kp' }],
  basketChanges: [{ revision: 2, at: '2026-09-29T09:59:38.415Z', added: ['canonry', 'canonry aeo agency', 'canonry reviews'], removed: [] }],
  executionIdentityChanges: [],
  referenceBasketRevision: 2,
  modelAttribution: {
    claude: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'claude-sonnet-5' } }, events: [{ observedAt: '2026-03-15T02:02:55.024Z', bucketStartDate: '2026-03-14T00:00:00.000Z', from: { status: 'known', model: 'claude-sonnet-4-6' }, to: { status: 'known', model: 'claude-opus-4-6' } }, { observedAt: '2026-03-20T22:20:16.712Z', bucketStartDate: '2026-03-14T00:00:00.000Z', from: { status: 'known', model: 'claude-opus-4-6' }, to: { status: 'known', model: 'claude-sonnet-4-6' } }, { observedAt: '2026-09-29T09:41:26.139Z', bucketStartDate: '2026-09-10T00:00:00.000Z', from: { status: 'known', model: 'claude-sonnet-4-6' }, to: { status: 'known', model: 'claude-sonnet-5' } }], eventTotal: 3 },
    gemini: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'gemini-3.5-flash' } }, events: [{ observedAt: '2026-03-15T02:08:10.978Z', bucketStartDate: '2026-03-14T00:00:00.000Z', from: { status: 'known', model: 'gemini-2.5-flash' }, to: { status: 'known', model: 'gemini-3-flash-preview' } }, { observedAt: '2026-03-26T23:45:36.350Z', bucketStartDate: '2026-03-14T00:00:00.000Z', from: { status: 'known', model: 'gemini-3-flash-preview' }, to: { status: 'known', model: 'gemini-2.5-flash' } }, { observedAt: '2026-04-08T00:42:29.051Z', bucketStartDate: '2026-03-14T00:00:00.000Z', from: { status: 'known', model: 'gemini-2.5-flash' }, to: { status: 'known', model: 'gemini-3-flash-preview' } }, { observedAt: '2026-09-29T09:41:26.139Z', bucketStartDate: '2026-09-10T00:00:00.000Z', from: { status: 'known', model: 'gemini-3-flash-preview' }, to: { status: 'known', model: 'gemini-3.5-flash' } }], eventTotal: 4 },
    openai: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'chat-latest' } }, events: [{ observedAt: '2026-03-15T02:02:55.024Z', bucketStartDate: '2026-03-14T00:00:00.000Z', from: { status: 'known', model: 'gpt-4o' }, to: { status: 'known', model: 'gpt-5.4' } }, { observedAt: '2026-09-29T09:41:26.139Z', bucketStartDate: '2026-09-10T00:00:00.000Z', from: { status: 'known', model: 'gpt-5.4' }, to: { status: 'known', model: 'chat-latest' } }], eventTotal: 2 },
    perplexity: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'fast' } }, events: [{ observedAt: '2026-09-29T09:41:26.139Z', bucketStartDate: '2026-09-10T00:00:00.000Z', from: { status: 'known', model: 'sonar' }, to: { status: 'known', model: 'fast' } }], eventTotal: 1 },
  },
  servedModelAttribution: {
    claude: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'claude-sonnet-5' } }, events: [{ observedAt: '2026-03-15T02:02:55.024Z', bucketStartDate: '2026-03-14T00:00:00.000Z', from: { status: 'known', model: 'claude-sonnet-4-6' }, to: { status: 'known', model: 'claude-opus-4-6' } }, { observedAt: '2026-03-20T22:20:16.712Z', bucketStartDate: '2026-03-14T00:00:00.000Z', from: { status: 'known', model: 'claude-opus-4-6' }, to: { status: 'known', model: 'claude-sonnet-4-6' } }, { observedAt: '2026-09-29T09:41:26.139Z', bucketStartDate: '2026-09-10T00:00:00.000Z', from: { status: 'known', model: 'claude-sonnet-4-6' }, to: { status: 'known', model: 'claude-sonnet-5' } }], eventTotal: 3, latestServedModelIds: ['claude-sonnet-5'] },
    gemini: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'gemini-3.5-flash' } }, events: [], eventTotal: 0, latestServedModelIds: ['gemini-3.5-flash'] },
    openai: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'chat-latest' } }, events: [{ observedAt: '2026-03-15T02:02:55.024Z', bucketStartDate: '2026-03-14T00:00:00.000Z', from: { status: 'known', model: 'gpt-4o' }, to: { status: 'known', model: 'gpt-5.4' } }, { observedAt: '2026-09-29T09:41:26.139Z', bucketStartDate: '2026-09-10T00:00:00.000Z', from: { status: 'known', model: 'gpt-5.4' }, to: { status: 'known', model: 'chat-latest' } }], eventTotal: 2, latestServedModelIds: ['chat-latest'] },
    perplexity: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'openai/gpt-6-luna' } }, events: [{ observedAt: '2026-09-29T09:41:26.139Z', bucketStartDate: '2026-09-10T00:00:00.000Z', from: { status: 'known', model: 'sonar' }, to: { status: 'known', model: 'openai/gpt-6-luna' } }], eventTotal: 1, latestServedModelIds: ['openai/gpt-6-luna'] },
  },
  modelServiceMismatch: { perplexity: { observedAt: '2026-09-29T09:59:38.415Z', configured: { status: 'known', model: 'fast' }, served: { status: 'known', model: 'openai/gpt-6-luna' } } },
  modelPointerChanges: { openai: { status: 'no-known-change', modelIds: ['chat-latest'], changes: [], changeCount: 0, unverifiedChangeCount: 0, knownGoodAsOf: '2026-07-20', checkedThroughPeriodEnd: false } },
}

const AINYC_METRICS_7D = {
  window: '7d',
  mentionShareScope: 'non-brand',
  buckets: [
    { startDate: '2026-09-29T00:00:00.000Z', endDate: '2026-09-30T00:00:00.000Z', dataStartDate: '2026-09-29T09:41:26.139Z', dataEndDate: '2026-09-29T09:59:38.415Z', sweepCount: 2, citationRate: 0.27, cited: 27, total: 100, queryCount: 14, mentionRate: 0.25, mentionedCount: 25, mentionShare: { scope: 'non-brand', rate: 0.31707317, projectMentionSnapshots: 13, competitorMentionSnapshots: 28 }, byProvider: { gemini: { citationRate: 0.36, cited: 9, total: 25, mentionRate: 0.36, mentionedCount: 9 }, openai: { citationRate: 0.08, cited: 2, total: 25, mentionRate: 0.12, mentionedCount: 3 }, perplexity: { citationRate: 0.4, cited: 10, total: 25, mentionRate: 0.32, mentionedCount: 8 }, claude: { citationRate: 0.24, cited: 6, total: 25, mentionRate: 0.2, mentionedCount: 5 } }, modelEvidenceByProvider: { gemini: { status: 'known', model: 'gemini-3.5-flash' }, openai: { status: 'known', model: 'chat-latest' }, perplexity: { status: 'known', model: 'fast' }, claude: { status: 'known', model: 'claude-sonnet-5' } }, basketRevision: null },
  ],
  overall: { citationRate: 0.27, cited: 27, total: 100, mentionRate: 0.25, mentionedCount: 25 },
  byProvider: { gemini: { citationRate: 0.36, cited: 9, total: 25, mentionRate: 0.36, mentionedCount: 9 }, openai: { citationRate: 0.08, cited: 2, total: 25, mentionRate: 0.12, mentionedCount: 3 }, perplexity: { citationRate: 0.4, cited: 10, total: 25, mentionRate: 0.32, mentionedCount: 8 }, claude: { citationRate: 0.24, cited: 6, total: 25, mentionRate: 0.2, mentionedCount: 5 } },
  trend: 'stable',
  mentionTrend: 'stable',
  windowChange: { citationRate: null, mentionRate: null, mentionShare: null },
  queryChanges: [],
  basketChanges: [{ revision: 2, at: '2026-09-29T09:59:38.415Z', added: ['canonry', 'canonry aeo agency', 'canonry reviews'], removed: [] }],
  executionIdentityChanges: [],
  referenceBasketRevision: 2,
  modelAttribution: {
    claude: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'claude-sonnet-5' } }, events: [{ observedAt: '2026-09-29T09:41:26.139Z', bucketStartDate: '2026-09-29T00:00:00.000Z', from: { status: 'known', model: 'claude-sonnet-4-6' }, to: { status: 'known', model: 'claude-sonnet-5' }, fromPreWindowAnchor: true, anchorObservedAt: '2026-07-14T06:00:00.016Z' }], eventTotal: 1 },
    gemini: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'gemini-3.5-flash' } }, events: [{ observedAt: '2026-09-29T09:41:26.139Z', bucketStartDate: '2026-09-29T00:00:00.000Z', from: { status: 'known', model: 'gemini-3-flash-preview' }, to: { status: 'known', model: 'gemini-3.5-flash' }, fromPreWindowAnchor: true, anchorObservedAt: '2026-07-14T06:00:00.016Z' }], eventTotal: 1 },
    openai: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'chat-latest' } }, events: [{ observedAt: '2026-09-29T09:41:26.139Z', bucketStartDate: '2026-09-29T00:00:00.000Z', from: { status: 'known', model: 'gpt-5.4' }, to: { status: 'known', model: 'chat-latest' }, fromPreWindowAnchor: true, anchorObservedAt: '2026-07-14T06:00:00.016Z' }], eventTotal: 1 },
    perplexity: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'fast' } }, events: [{ observedAt: '2026-09-29T09:41:26.139Z', bucketStartDate: '2026-09-29T00:00:00.000Z', from: { status: 'known', model: 'sonar' }, to: { status: 'known', model: 'fast' }, fromPreWindowAnchor: true, anchorObservedAt: '2026-07-14T06:00:00.016Z' }], eventTotal: 1 },
  },
  servedModelAttribution: {
    claude: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'claude-sonnet-5' } }, events: [{ observedAt: '2026-09-29T09:41:26.139Z', bucketStartDate: '2026-09-29T00:00:00.000Z', from: { status: 'known', model: 'claude-sonnet-4-6' }, to: { status: 'known', model: 'claude-sonnet-5' }, fromPreWindowAnchor: true, anchorObservedAt: '2026-07-14T06:00:00.016Z' }], eventTotal: 1, latestServedModelIds: ['claude-sonnet-5'] },
    gemini: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'gemini-3.5-flash' } }, events: [], eventTotal: 0, anchorUnavailable: true, latestServedModelIds: ['gemini-3.5-flash'] },
    openai: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'chat-latest' } }, events: [{ observedAt: '2026-09-29T09:41:26.139Z', bucketStartDate: '2026-09-29T00:00:00.000Z', from: { status: 'known', model: 'gpt-5.4' }, to: { status: 'known', model: 'chat-latest' }, fromPreWindowAnchor: true, anchorObservedAt: '2026-07-14T06:00:00.016Z' }], eventTotal: 1, latestServedModelIds: ['chat-latest'] },
    perplexity: { latestObservation: { observedAt: '2026-09-29T09:59:38.415Z', state: { status: 'known', model: 'openai/gpt-6-luna' } }, events: [{ observedAt: '2026-09-29T09:41:26.139Z', bucketStartDate: '2026-09-29T00:00:00.000Z', from: { status: 'known', model: 'sonar' }, to: { status: 'known', model: 'openai/gpt-6-luna' }, fromPreWindowAnchor: true, anchorObservedAt: '2026-07-14T06:00:00.016Z' }], eventTotal: 1, latestServedModelIds: ['openai/gpt-6-luna'] },
  },
  modelServiceMismatch: { perplexity: { observedAt: '2026-09-29T09:59:38.415Z', configured: { status: 'known', model: 'fast' }, served: { status: 'known', model: 'openai/gpt-6-luna' } } },
  modelPointerChanges: { openai: { status: 'no-known-change', modelIds: ['chat-latest'], changes: [], changeCount: 0, unverifiedChangeCount: 0, knownGoodAsOf: '2026-07-20', checkedThroughPeriodEnd: false } },
}

export function ainycMetrics(window: 'all' | '7d') {
  return structuredClone(window === 'all' ? AINYC_METRICS_ALL : AINYC_METRICS_7D)
}

/** ainyc's recent sweeps (`recentRuns`, probe excluded), newest first. */
export const AINYC_SWEEP_TIMES = [
  AINYC_LATEST_RUN.createdAt,
  AINYC_PREVIOUS_RUN.createdAt,
  '2026-07-14T06:00:00.016Z',
  '2026-05-28T20:30:59.109Z',
]
