import { describe, it, expect } from 'vitest'
import type {
  AttentionItemDto,
  MovementComparisonDto,
  MovementSummaryDto,
  RunStatus,
} from '@ainyc/canonry-contracts'
import {
  buildPortfolioChangeFeed,
  PORTFOLIO_CHANGE_FEED_LIMIT,
  type PortfolioChangeFeedProjectInput,
} from '../src/portfolio-change-feed.js'

const NOW = '2026-06-27T12:00:00.000Z'

function movement(partial: Partial<MovementSummaryDto> = {}): MovementSummaryDto {
  return { gained: 0, lost: 0, tone: 'neutral', hasPreviousRun: true, ...partial }
}

function comparison(partial: Partial<MovementComparisonDto> = {}): MovementComparisonDto {
  return {
    hasPreviousRun: true,
    comparable: true,
    querySetChanged: false,
    previousRunAt: '2026-06-20T00:00:00.000Z',
    currentQueryCount: 10,
    previousQueryCount: 10,
    comparableQueryCount: 10,
    addedQueryCount: 0,
    removedQueryCount: 0,
    addedQueries: [],
    removedQueries: [],
    ...partial,
  }
}

function project(partial: Partial<PortfolioChangeFeedProjectInput> = {}): PortfolioChangeFeedProjectInput {
  return {
    projectName: 'Acme',
    projectSlug: 'acme',
    citationMovement: movement(),
    mentionMovement: movement(),
    movementComparison: comparison(),
    attentionItems: [],
    latestRun: { runId: 'r1', status: 'completed' as RunStatus, occurredAt: '2026-06-27T00:00:00.000Z', error: null },
    trackedQueryCount: 10,
    projectCreatedAt: '2026-06-01T00:00:00.000Z',
    ...partial,
  }
}

describe('buildPortfolioChangeFeed — ordering', () => {
  it('orders recency desc, then severity within one sweep, then by id', () => {
    const inputs: PortfolioChangeFeedProjectInput[] = [
      // A: citation-lost at 03:00
      project({
        projectName: 'Alpha',
        projectSlug: 'alpha',
        citationMovement: movement({ lost: 1, lostQueries: ['a-lost'] }),
        latestRun: { runId: 'rA', status: 'completed' as RunStatus, occurredAt: '2026-06-27T03:00:00.000Z', error: null },
      }),
      // B: citation-gained at 05:00 (newest)
      project({
        projectName: 'Bravo',
        projectSlug: 'bravo',
        citationMovement: movement({ gained: 2, gainedQueries: ['b-gain'] }),
        latestRun: { runId: 'rB', status: 'completed' as RunStatus, occurredAt: '2026-06-27T05:00:00.000Z', error: null },
      }),
      // C: mention-lost AND mention-gained at the same 01:00 sweep (oldest)
      project({
        projectName: 'Charlie',
        projectSlug: 'charlie',
        mentionMovement: movement({ gained: 1, lost: 1, gainedQueries: ['c-gain'], lostQueries: ['c-lost'] }),
        latestRun: { runId: 'rC', status: 'completed' as RunStatus, occurredAt: '2026-06-27T01:00:00.000Z', error: null },
      }),
    ]

    const { changeFeed } = buildPortfolioChangeFeed(inputs, NOW)
    expect(changeFeed.map(c => c.id)).toEqual([
      'bravo:citation-gained:rB', // 05:00, newest
      'alpha:citation-lost:rA', // 03:00
      'charlie:mention-lost:rC', // 01:00, negative before positive within the sweep
      'charlie:mention-gained:rC',
    ])
  })
})

describe('buildPortfolioChangeFeed — dedup', () => {
  it('collapses a multi-query loss into ONE row, not one per query', () => {
    const { changeFeed } = buildPortfolioChangeFeed(
      [project({ citationMovement: movement({ lost: 3, lostQueries: ['q1', 'q2', 'q3'] }) })],
      NOW,
    )
    const lostRows = changeFeed.filter(c => c.changeType === 'citation-lost')
    expect(lostRows).toHaveLength(1)
    expect(lostRows[0]!.title).toBe('Acme lost 3 cited queries')
    expect(lostRows[0]!.detail).toBe('"q1", "q2", "q3"')
  })

  it('emits both a citation gain and a mention loss for one run (distinct change types)', () => {
    const { changeFeed } = buildPortfolioChangeFeed(
      [project({
        citationMovement: movement({ gained: 1, gainedQueries: ['g'] }),
        mentionMovement: movement({ lost: 1, lostQueries: ['m'] }),
      })],
      NOW,
    )
    expect(new Set(changeFeed.map(c => c.changeType))).toEqual(new Set(['citation-gained', 'mention-lost']))
    expect(changeFeed).toHaveLength(2)
  })

  it('truncates "+N more" affected queries past the first three', () => {
    const { changeFeed } = buildPortfolioChangeFeed(
      [project({ citationMovement: movement({ lost: 5, lostQueries: ['a', 'b', 'c', 'd', 'e'] }) })],
      NOW,
    )
    expect(changeFeed[0]!.detail).toBe('"a", "b", "c" +2 more')
  })
})

describe('buildPortfolioChangeFeed — comparability gate', () => {
  it('emits movement when comparable', () => {
    const { changeFeed } = buildPortfolioChangeFeed(
      [project({ citationMovement: movement({ lost: 2, lostQueries: ['x', 'y'] }) })],
      NOW,
    )
    expect(changeFeed.map(c => c.changeType)).toEqual(['citation-lost'])
  })

  it('suppresses ALL movement when not comparable, emitting query-set-changed instead', () => {
    const { changeFeed } = buildPortfolioChangeFeed(
      [project({
        // Counts present but must be ignored because the basket is not comparable.
        citationMovement: movement({ lost: 5, lostQueries: ['x'] }),
        mentionMovement: movement({ gained: 3, gainedQueries: ['y'] }),
        movementComparison: comparison({
          comparable: false,
          querySetChanged: true,
          addedQueryCount: 2,
          removedQueryCount: 1,
        }),
      })],
      NOW,
    )
    expect(changeFeed.map(c => c.changeType)).toEqual(['query-set-changed'])
    expect(changeFeed[0]!.detail).toBe('+2 added · −1 removed since last sweep — movement compares the shared queries')
    // Added queries are never presented as a loss/gain.
    expect(changeFeed.some(c => c.changeType === 'citation-lost' || c.changeType === 'mention-gained')).toBe(false)
  })
})

describe('buildPortfolioChangeFeed — empty states', () => {
  it('awaiting-second-sweep when no project has a comparable sweep', () => {
    const result = buildPortfolioChangeFeed(
      [project({ movementComparison: comparison({ hasPreviousRun: false, comparable: false }) })],
      NOW,
    )
    expect(result.changeFeed).toHaveLength(0)
    expect(result.feedEmptyState?.kind).toBe('awaiting-second-sweep')
    expect(result.comparableProjectCount).toBe(0)
    expect(result.firstSweepProjectCount).toBe(1)
  })

  it('all-clear (neutral) when projects ran comparably and nothing moved', () => {
    const result = buildPortfolioChangeFeed([project(), project({ projectSlug: 'b', projectName: 'B' })], NOW)
    expect(result.changeFeed).toHaveLength(0)
    expect(result.feedEmptyState?.kind).toBe('all-clear')
    expect(result.feedEmptyState?.detail).toContain('2 projects')
    expect(result.comparableProjectCount).toBe(2)
  })

  it('never folds an all-single-run portfolio into all-clear', () => {
    const firstSweep = project({ movementComparison: comparison({ hasPreviousRun: false, comparable: false }) })
    const result = buildPortfolioChangeFeed(
      [firstSweep, { ...firstSweep, projectSlug: 'b', projectName: 'B' }],
      NOW,
    )
    expect(result.feedEmptyState?.kind).toBe('awaiting-second-sweep')
  })
})

describe('buildPortfolioChangeFeed — vocabulary separation', () => {
  it('citation-lost traces to citationMovement, mention-lost to mentionMovement — never crossed', () => {
    const { changeFeed } = buildPortfolioChangeFeed(
      [project({
        citationMovement: movement({ lost: 1, lostQueries: ['cited-query'] }),
        mentionMovement: movement({ lost: 1, lostQueries: ['mention-query'] }),
      })],
      NOW,
    )
    const citation = changeFeed.find(c => c.changeType === 'citation-lost')!
    const mention = changeFeed.find(c => c.changeType === 'mention-lost')!
    expect(citation.title).toContain('cited')
    expect(citation.detail).toContain('cited-query')
    expect(citation.detail).not.toContain('mention-query')
    expect(mention.title).toContain('answer')
    expect(mention.detail).toContain('mention-query')
    expect(mention.detail).not.toContain('cited-query')
  })
})

describe('buildPortfolioChangeFeed — attention + onboarding', () => {
  it('maps critical/high insight echoes and stale-visibility into rows (feed not empty)', () => {
    const attentionItems: AttentionItemDto[] = [
      { id: 'insight_abc', tone: 'negative', title: 'Lost top citation', detail: 'On query: roofing', actionLabel: 'Critical', href: '#insight-abc' },
      { id: 'insight_def', tone: 'caution', title: 'Competitor surging', detail: '', actionLabel: 'High', href: '#insight-def' },
      { id: 'stale_visibility', tone: 'caution', title: 'Stale visibility data', detail: 'x', actionLabel: 'Stale', href: '#runs' },
    ]
    const { changeFeed, feedEmptyState } = buildPortfolioChangeFeed([project({ attentionItems })], NOW)
    expect(feedEmptyState).toBeNull()
    expect(changeFeed.map(c => c.changeType).sort()).toEqual(['insight-critical', 'insight-high', 'stale-visibility'])
    const critical = changeFeed.find(c => c.changeType === 'insight-critical')!
    expect(critical.title).toBe('Lost top citation')
    expect(critical.tone).toBe('negative')
  })

  it('emits a project-never-run onboarding row anchored to project creation', () => {
    const { changeFeed } = buildPortfolioChangeFeed(
      [project({ latestRun: null, trackedQueryCount: 7, projectCreatedAt: '2026-06-10T00:00:00.000Z' })],
      NOW,
    )
    expect(changeFeed).toHaveLength(1)
    const row = changeFeed[0]!
    expect(row.changeType).toBe('project-never-run')
    expect(row.title).toBe('Acme has no completed sweep yet')
    expect(row.detail).toBe('7 queries tracked — run a sweep to start measuring.')
    expect(row.occurredAt).toBe('2026-06-10T00:00:00.000Z')
  })

  it('emits a run-failed row with the one-line error', () => {
    const { changeFeed } = buildPortfolioChangeFeed(
      [project({
        latestRun: {
          runId: 'rf',
          status: 'failed' as RunStatus,
          occurredAt: '2026-06-27T06:00:00.000Z',
          error: { code: 'PROVIDER_ERROR', message: 'Gemini quota exhausted' },
        },
      })],
      NOW,
    )
    const failed = changeFeed.find(c => c.changeType === 'run-failed')!
    expect(failed.tone).toBe('negative')
    expect(failed.detail).toContain('Gemini quota exhausted')
  })
})

describe('buildPortfolioChangeFeed — display cap', () => {
  it('caps the feed and reports the pre-cap total', () => {
    const inputs = Array.from({ length: PORTFOLIO_CHANGE_FEED_LIMIT + 1 }, (_, i) =>
      project({
        projectName: `P${i}`,
        projectSlug: `p${i}`,
        citationMovement: movement({ lost: 1, lostQueries: [`q${i}`] }),
        latestRun: {
          runId: `r${i}`,
          status: 'completed' as RunStatus,
          // Distinct, descending timestamps so order is deterministic.
          occurredAt: `2026-06-27T${String(i).padStart(2, '0')}:00:00.000Z`,
          error: null,
        },
      }),
    )
    const { changeFeed, changeFeedTotal } = buildPortfolioChangeFeed(inputs, NOW)
    expect(changeFeedTotal).toBe(PORTFOLIO_CHANGE_FEED_LIMIT + 1)
    expect(changeFeed).toHaveLength(PORTFOLIO_CHANGE_FEED_LIMIT)
  })
})
