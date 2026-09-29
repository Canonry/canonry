import type { BrandMetricsDto } from '@ainyc/canonry-contracts'

/**
 * GET /analytics/metrics responses around query-set changes, captured from the
 * real route (packages/api-routes/src/analytics.ts) on seeded queries, runs,
 * snapshots and basket revisions (query-basket.ts). Claude, Gemini and OpenAI
 * answered every query of every sweep, each answer citing and mentioning the
 * project or neither. The server restates every point to the queries tracked
 * now, and rejoins a removed query's old answers by its normalized text once it
 * is tracked again.
 */

const ENGINES = ['claude', 'gemini', 'openai'] as const

interface PointInput {
  day: string
  /** The point's first and last sweep, as `dataStartDate` and `dataEndDate`. */
  first: string
  last: string
  sweepCount: number
  /** Queries with answers in the point. */
  queryCount: number
  /** Answers per engine across the point's sweeps, and how many cited and mentioned the project. */
  answers: number
  cited: number
}

function point(input: PointInput) {
  const rate = input.cited / input.answers
  return {
    startDate: `${input.day}T00:00:00.000Z`,
    endDate: `${nextDay(input.day)}T00:00:00.000Z`,
    dataStartDate: input.first,
    dataEndDate: input.last,
    sweepCount: input.sweepCount,
    citationRate: rate,
    cited: ENGINES.length * input.cited,
    total: ENGINES.length * input.answers,
    queryCount: input.queryCount,
    mentionRate: rate,
    mentionedCount: ENGINES.length * input.cited,
    mentionShare: { scope: 'non-brand' as const, rate: null, projectMentionSnapshots: ENGINES.length * input.cited, competitorMentionSnapshots: 0 },
    byProvider: Object.fromEntries(ENGINES.map(engine => [engine, { citationRate: rate, cited: input.cited, total: input.answers, mentionRate: rate, mentionedCount: input.cited }])),
    modelEvidenceByProvider: Object.fromEntries(ENGINES.map(engine => [engine, { status: 'known' as const, model: `${engine}-model` }])),
    basketRevision: null,
  }
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)
}

function metrics(
  buckets: ReturnType<typeof point>[],
  basketChanges: BrandMetricsDto['basketChanges'],
  change: { first: number; latest: number; delta: number } | null,
): BrandMetricsDto {
  const cited = buckets.reduce((sum, bucket) => sum + bucket.cited, 0)
  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0)
  return {
    window: 'all',
    mentionShareScope: 'non-brand',
    buckets,
    overall: { citationRate: cited / total, cited, total, mentionRate: cited / total, mentionedCount: cited },
    byProvider: {},
    trend: 'stable',
    mentionTrend: 'stable',
    windowChange: { citationRate: change, mentionRate: change, mentionShare: null },
    queryChanges: [],
    basketChanges,
    executionIdentityChanges: [],
    referenceBasketRevision: (basketChanges.at(-1)?.revision ?? 1),
    modelAttribution: {},
  } as unknown as BrandMetricsDto
}

/**
 * Queries a and b swept Jul 1 (b cited). b was deleted and a swept alone Jul 3.
 * b was added back and both swept Jul 5, both cited. The first and latest
 * points both read a and b, and the server's citation change is +50 points.
 * `withMiddle: false` drops the Jul 3 point, as when the sweep that minted
 * revision 2 never became a point (run-queue.ts stamps it at queue time).
 */
export function removedAndReAddedMetrics({ withMiddle = true }: { withMiddle?: boolean } = {}): BrandMetricsDto {
  return metrics(
    [
      point({ day: '2026-07-01', first: '2026-07-01T09:00:00.000Z', last: '2026-07-01T09:00:00.000Z', sweepCount: 1, queryCount: 2, answers: 2, cited: 1 }),
      ...(withMiddle ? [point({ day: '2026-07-03', first: '2026-07-03T09:00:00.000Z', last: '2026-07-03T09:00:00.000Z', sweepCount: 1, queryCount: 1, answers: 1, cited: 0 })] : []),
      point({ day: '2026-07-05', first: '2026-07-05T09:00:00.000Z', last: '2026-07-05T09:00:00.000Z', sweepCount: 1, queryCount: 2, answers: 2, cited: 2 }),
    ],
    [
      { revision: 2, at: '2026-07-03T09:00:00.000Z', added: [], removed: ['query b'] },
      { revision: 3, at: '2026-07-05T09:00:00.000Z', added: ['query b'], removed: [] },
    ],
    { first: 0.5, latest: 1, delta: 0.5 },
  )
}

/**
 * One Jul 5 point pooling two sweeps. The 08:00 sweep read {a, b}. c and d
 * were added and the 09:00 sweep queued on them (revision 2) was cancelled; d
 * was deleted and the 10:00 sweep read {a, b, c} (revision 3). The two sweeps
 * differ by c alone.
 */
export function cancelledSweepBetweenMetrics(): BrandMetricsDto {
  return metrics(
    [point({ day: '2026-07-05', first: '2026-07-05T08:00:00.000Z', last: '2026-07-05T10:00:00.000Z', sweepCount: 2, queryCount: 3, answers: 5, cited: 3 })],
    [
      { revision: 2, at: '2026-07-05T09:00:00.000Z', added: ['query c', 'query d'], removed: [] },
      { revision: 3, at: '2026-07-05T10:00:00.000Z', added: [], removed: ['query d'] },
    ],
    null,
  )
}

/**
 * One Jul 1 point pooling a 09:00 and a 15:00 sweep, both of {a, b}. b was
 * deleted (revision 2 minted 12:00 by a sweep that never ran) and added back
 * before the 15:00 sweep (revision 3). Both sweeps read the same queries.
 * `sweepCount: 3` stands for a point with a sweep between them, at an unknown
 * time.
 */
export function roundTripInsidePointMetrics({ sweepCount = 2 }: { sweepCount?: number } = {}): BrandMetricsDto {
  return metrics(
    [point({ day: '2026-07-01', first: '2026-07-01T09:00:00.000Z', last: '2026-07-01T15:00:00.000Z', sweepCount, queryCount: 2, answers: 4, cited: 2 })],
    [
      { revision: 2, at: '2026-07-01T12:00:00.000Z', added: [], removed: ['query b'] },
      { revision: 3, at: '2026-07-01T15:00:00.000Z', added: ['query b'], removed: [] },
    ],
    null,
  )
}
