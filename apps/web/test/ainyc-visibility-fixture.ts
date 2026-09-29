import type { CitationVisibilityResponse, CompetitorLandscapeResponse, CompetitorLandscapeRow, GapAnalysisDto, GapCategory, GapQuery, QueryClass, RunDto } from '@ainyc/canonry-contracts'
import type { CitationInsightVm, MovementComparisonVm, MovementSummaryVm, ProjectCommandCenterVm, RunHistoryPoint } from '../src/view-models.js'

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

/** ainyc's query classes as the page's classifier resolves them (brand "Canonry"). */
export function ainycClassify(text: string): QueryClass | null {
  return QUERIES.find(([query]) => query.toLowerCase() === text.trim().toLowerCase())?.[1] ?? null
}

/** `scores.mentionShare` from ainyc's stored GET /overview (latest sweep). */
export function ainycMentionShare(): ProjectCommandCenterVm['mentionShareSummary'] {
  return {
    label: 'Mention Share',
    value: '33.3%',
    delta: '7 of 21 brand mentions · non-brand queries',
    tone: 'caution',
    description: '',
    tooltip: '',
    trend: [],
    progress: 33.333333,
    scope: 'non-brand',
    breakdown: {
      projectMentionSnapshots: 7,
      competitorMentionSnapshots: 14,
      combinedMentionSnapshots: 21,
      perCompetitor: [{ domain: 'pbjmarketing.com', mentionSnapshots: 14, shareOfCompetitiveTotal: 100 }],
      ranking: [
        { kind: 'competitor', domain: 'pbjmarketing.com', mentionSnapshots: 14, share: 0.6666666666666666 },
        { kind: 'project', domain: null, mentionSnapshots: 7, share: 0.3333333333333333 },
      ],
      snapshotsWithAnswerText: 44,
      snapshotsTotal: 44,
      score: 33.333333,
    },
    branded: {
      projectMentionSnapshots: 12,
      competitorMentionSnapshots: 0,
      combinedMentionSnapshots: 12,
      perCompetitor: [],
      ranking: [
        { kind: 'project', domain: null, mentionSnapshots: 12, share: 1 },
        { kind: 'competitor', domain: 'pbjmarketing.com', mentionSnapshots: 0, share: 0 },
      ],
      snapshotsWithAnswerText: 12,
      snapshotsTotal: 12,
      score: 100,
    },
  }
}

/** Query id and all-window consistency (cited, mentioned, total time points) per query. */
const AINYC_GAP_QUERIES: Record<string, [queryId: string, citedRuns: number, mentionedRuns: number, totalRuns: number]> = {
  'AEO Agency in NYC': ['9881c0a1-1740-4f2a-a380-01eba2058530', 45, 45, 53],
  'AEO Agency NYC': ['e21078a9-59a8-4078-8b7a-d2d7536b4900', 45, 45, 53],
  'Answer Engine Optimization Agency NYC': ['6eaf55b5-e790-4cd6-9aee-6062bd554c07', 46, 46, 53],
  'Canonry': ['7100603e-ca6f-49d8-9d75-d5de40f72443', 1, 1, 1],
  'Canonry AEO agency': ['33c95d3c-6da9-4273-8b75-03efb43ec1e2', 1, 1, 1],
  'Canonry reviews': ['c755e394-994c-4a98-ae66-d6e711bbdbc2', 1, 1, 1],
  'NYC AEO Agency': ['f02adaf9-3b91-4230-9ec1-4e24b46449a5', 46, 46, 52],
  'best AEO agency New York': ['ee8b1897-33f9-4db7-a04f-961f75149163', 10, 11, 41],
  'AI SEO agency NYC': ['67714690-6f1e-4c97-b32a-c81a5f560d35', 14, 17, 41],
  'generative engine optimization agency NYC': ['254866d9-0e6e-48a2-a0ff-1101e042c3dc', 16, 16, 41],
  'how to appear in AI search results': ['6eb8391d-d2fe-41ef-812e-38bc8df492b8', 0, 1, 41],
  'how to get my business cited by AI': ['3d0fa777-1a3d-4ec2-85db-1c3fc7f82308', 0, 3, 41],
  'how to rank on ChatGPT': ['85ae4b60-b96a-46d9-ada3-c7b75b1917ab', 0, 0, 41],
  'optimize website for AI search': ['cc47352d-88f5-4f01-b5d0-16c0c9216237', 0, 2, 41],
}

/** pbjmarketing.com is named and cited on these queries; no other tracked competitor appears. */
const AINYC_COMPETITOR_QUERIES = new Set(['AEO Agency in NYC', 'AEO Agency NYC', 'Answer Engine Optimization Agency NYC', 'NYC AEO Agency', 'best AEO agency New York'])

function gapRow(query: string, category: GapCategory, providers: string[]): GapQuery {
  const [queryId, citedRuns, mentionedRuns, totalRuns] = AINYC_GAP_QUERIES[query]!
  const competitors = AINYC_COMPETITOR_QUERIES.has(query) ? ['pbjmarketing.com'] : []
  return { query, queryId, category, providers, competitorsCiting: competitors, competitorsMentioned: competitors, consistency: { citedRuns, totalRuns, mentionedRuns } }
}

const AINYC_UNCITED = ['AI SEO agency NYC', 'generative engine optimization agency NYC', 'how to appear in AI search results', 'how to get my business cited by AI', 'how to rank on ChatGPT', 'optimize website for AI search']

/** ainyc's stored GET /analytics/gaps: the latest sweep's lanes, in the server's order. */
export function ainycGaps(): GapAnalysisDto {
  return {
    cited: [
      gapRow('AEO Agency in NYC', 'cited', ['perplexity', 'gemini']),
      gapRow('AEO Agency NYC', 'cited', ['perplexity', 'gemini']),
      gapRow('Answer Engine Optimization Agency NYC', 'cited', ['perplexity', 'claude']),
      gapRow('Canonry', 'cited', ['perplexity', 'gemini']),
      gapRow('Canonry AEO agency', 'cited', ['gemini', 'openai', 'claude', 'perplexity']),
      gapRow('Canonry reviews', 'cited', ['perplexity', 'claude', 'gemini', 'openai']),
      gapRow('NYC AEO Agency', 'cited', ['gemini', 'claude', 'perplexity']),
    ],
    gap: [gapRow('best AEO agency New York', 'gap', [])],
    uncited: AINYC_UNCITED.map(query => gapRow(query, 'uncited', [])),
    mentionedQueries: [
      gapRow('AEO Agency in NYC', 'cited', ['perplexity', 'gemini']),
      gapRow('AEO Agency NYC', 'cited', ['perplexity', 'gemini']),
      gapRow('Answer Engine Optimization Agency NYC', 'cited', ['claude']),
      gapRow('Canonry', 'cited', ['perplexity', 'gemini', 'claude', 'openai']),
      gapRow('Canonry AEO agency', 'cited', ['gemini', 'openai', 'claude', 'perplexity']),
      gapRow('Canonry reviews', 'cited', ['perplexity', 'claude', 'gemini', 'openai']),
      gapRow('NYC AEO Agency', 'cited', ['gemini', 'perplexity']),
    ],
    mentionGap: [gapRow('best AEO agency New York', 'gap', [])],
    notMentioned: AINYC_UNCITED.map(query => gapRow(query, 'uncited', [])),
    runId: AINYC_LATEST_RUN.id,
    window: 'all',
  }
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

/**
 * GET /citations/visibility for ainyc (`av/cv.json`): each query's latest
 * answer per engine, from the same states as the evidence, and the 8
 * competitor-gap answers (all non-brand, all pbjmarketing.com).
 */
export function ainycCitationVisibility(): CitationVisibilityResponse {
  const gaps: ReadonlyArray<[query: string, provider: string]> = [
    ['AEO Agency in NYC', 'claude'], ['AEO Agency in NYC', 'openai'],
    ['AEO Agency NYC', 'claude'], ['AEO Agency NYC', 'openai'],
    ['Answer Engine Optimization Agency NYC', 'openai'],
    ['best AEO agency New York', 'claude'], ['best AEO agency New York', 'perplexity'],
    ['NYC AEO Agency', 'openai'],
  ]
  const byQuery = QUERIES.map(([query, , , latest], index) => {
    const providers = ENGINES.map((provider, engine) => ({
      provider,
      citationState: latest[engine]!.endsWith('C') ? 'cited' as const : 'not-cited' as const,
      cited: latest[engine]!.endsWith('C'),
      mentioned: latest[engine]!.startsWith('M'),
      runId: AINYC_LATEST_RUN.id,
      runCreatedAt: AINYC_LATEST_RUN.createdAt,
    }))
    return {
      queryId: `query_${index}`,
      query,
      providers,
      citedCount: providers.filter(entry => entry.cited).length,
      mentionedCount: providers.filter(entry => entry.mentioned).length,
      totalProviders: providers.length,
    }
  })
  return {
    summary: {
      providersConfigured: 4, providersCiting: 4, providersMentioning: 4, totalQueries: 14,
      queriesCitedAndMentioned: 7, queriesCitedOnly: 0, queriesMentionedOnly: 0, queriesInvisible: 7,
      latestRunId: AINYC_LATEST_RUN.id, latestRunAt: AINYC_LATEST_RUN.createdAt,
    },
    byQuery,
    competitorGaps: gaps.map(([query, provider]) => ({
      queryId: byQuery.find(row => row.query === query)!.queryId,
      query,
      provider,
      citingCompetitors: ['pbjmarketing.com'],
      runId: AINYC_LATEST_RUN.id,
      runCreatedAt: AINYC_LATEST_RUN.createdAt,
    })),
    status: 'ready',
  }
}

const OBSERVED_NAMES: ReadonlyArray<[string, number]> = [
  ['PBJ Marketing', 25], ['Web Tonic', 18], ['Fuel Online', 15], ['AEO Engine', 12], ['NoGood', 9], ['Winston Digital Marketing', 8],
  ['Lemniscate Growth', 6], ['AI Search Rankings', 5], ['AI Search Rankings NYC', 5], ['CBI Digital', 3], ['Mimvi', 3], ['Primary Position', 3],
  ['Busylike', 2], ['CB/I Digital', 2], ['Digital Agency Network', 2], ['GetCito', 2], ['GoodFirms', 2], ['Hozio', 2], ['KSM Media Hut', 2],
  ['Localplus', 2], ['Mimvi SEO', 2], ['Mulder Agency', 2], ['New York SEO Company (NYSEO/CO)', 2], ['NYC SEO', 2], ['Percepture', 2],
  ['RankSystem', 2], ['SemNexus', 2], ['Thrive Agency', 2], ['WebFlur', 2], ['WebFX', 2], ['50Pros', 1], ['Agency AEO', 1],
  ['AI Search Rankings (NYC)', 1], ['Angora Media', 1], ['Avenue Z (Flatiron District, NYC)', 1], ['Blurn & BX Studio', 1], ['BX Studio', 1],
  ['CEO of GEO', 1], ['Choose iPullRank', 1], ['Choose NoGood', 1], ['Coalition Technologies', 1], ['DASH TWO', 1],
  ['Dominate Reddit (r/AskNYC, r/Brooklyn, etc.)', 1], ['Dominate Reddit and Quora', 1], ['Engage with Google and Yelp Reviews', 1],
  ['Forte on Forums (Reddit & Quora)', 1], ['Google Business Profile', 1], ['Google now offers native reporting', 1],
  ['Great Bear Marketing & BX Studio', 1], ['Klikcy', 1],
]

function landscapeRow(row: Partial<CompetitorLandscapeRow> & Pick<CompetitorLandscapeRow, 'domain' | 'label'>): CompetitorLandscapeRow {
  return {
    surfaceClass: 'unknown', pinned: false, mentionCount: 0, shareOfVoice: null, citationCount: 0, answeredResults: 88,
    firstSeenAt: '2026-09-29T09:41:30.494Z', lastSeenAt: '2026-09-29T10:00:52.249Z', sampleUrls: [],
    ...row,
  }
}

/**
 * GET /analytics/competitors?window=30d&queryClass=non-brand for ainyc
 * (`av/land30nb.json`). The first three other sources are the stored ones; the
 * other 97 up to the server's cap of 100 are placeholders.
 */
export function ainycLandscape(): CompetitorLandscapeResponse {
  return {
    window: '30d',
    scope: { kind: 'project' },
    basis: 'tracked',
    availability: 'measured',
    reason: null,
    comparison: [{ domain: 'pbjmarketing.com', mentions: 28 }],
    observedNames: OBSERVED_NAMES.map(([name, answerCount]) => ({ name, answerCount })),
    observedNamesTotal: 59,
    project: landscapeRow({
      domain: 'canonry.ai', label: 'Canonry', surfaceClass: 'own', mentionCount: 13, shareOfVoice: 31.707317, citationCount: 17,
      sampleUrls: ['https://canonry.ai/how-to-choose-an-nyc-aeo-agency', 'https://ainyc.ai/', 'https://canonry.ai/about'],
    }),
    pinned: [landscapeRow({
      domain: 'pbjmarketing.com', label: 'pbjmarketing', surfaceClass: 'direct-competitor', pinned: true, mentionCount: 28, shareOfVoice: 68.292683, citationCount: 28,
      sampleUrls: ['https://pbjmarketing.com/aeo-location/nyc-aeo-agency?utm_source=openai', 'https://pbjmarketing.com/aeo-location/nyc-aeo-agency', 'https://pbjmarketing.com/location/nyc-aeo-agency'],
    })],
    observed: [],
    otherSources: [
      landscapeRow({ domain: 'webtonic.io', label: 'webtonic', citationCount: 27, sampleUrls: ['https://www.webtonic.io/locations/new-york-city-geo-aeo'] }),
      landscapeRow({ domain: 'aeoengine.ai', label: 'aeoengine', citationCount: 21, sampleUrls: ['https://aeoengine.ai/'] }),
      landscapeRow({ domain: 'semrush.com', label: 'semrush', citationCount: 20, sampleUrls: ['https://www.semrush.com/blog/ai-citations/'] }),
      ...Array.from({ length: 97 }, (_, index) => landscapeRow({ domain: `site-${index + 1}.example`, label: `site-${index + 1}`, citationCount: 1 })),
    ],
    evidence: { answeredResults: 88, sourceResults: 86, missingAnswerTextResults: 0, mentionCredits: 41, incompleteSourceResults: 2, excludedProbeResults: 0, excludedNonCompletedResults: 0 },
    marketState: null,
    filters: { scope: 'project', groupKey: null, provider: null, queryClass: 'non-brand', location: null, runId: null },
    truncated: true,
    runCount: 2,
    runIds: [AINYC_LATEST_RUN.id, AINYC_PREVIOUS_RUN.id],
  }
}

/**
 * ainyc's five latest answer-visibility runs (`av/runs.json`), newest first,
 * the May 17 probe included. Times are UTC; the page shows them in the
 * viewer's zone.
 */
export function ainycRuns(): RunDto[] {
  const run = (id: string, trigger: RunDto['trigger'], createdAt: string, startedAt: string, finishedAt: string): RunDto => ({
    id, projectId: 'project_ainyc', kind: 'answer-visibility', status: 'completed', trigger, location: 'nyc', createdAt, startedAt, finishedAt, error: null,
  })
  return [
    run(AINYC_LATEST_RUN.id, 'manual', AINYC_LATEST_RUN.createdAt, '2026-09-29T09:59:38.446Z', '2026-09-29T10:02:07.340Z'),
    run(AINYC_PREVIOUS_RUN.id, 'manual', AINYC_PREVIOUS_RUN.createdAt, '2026-09-29T09:41:26.165Z', '2026-09-29T09:43:36.998Z'),
    run('8891101e-7224-4843-8912-5c88d2579095', 'scheduled', '2026-07-14T06:00:00.016Z', '2026-07-14T06:00:00.021Z', '2026-07-14T06:03:53.977Z'),
    run('f79e7929-841c-4f07-ac12-106ec43d325b', 'manual', '2026-05-28T20:30:59.109Z', '2026-05-28T20:30:59.112Z', '2026-05-28T20:34:53.187Z'),
    run('cae71507-b133-4f49-ab69-fc3707eae805', 'probe', '2026-05-17T02:28:46.270Z', '2026-05-17T02:28:46.287Z', '2026-05-17T02:28:51.415Z'),
  ]
}
