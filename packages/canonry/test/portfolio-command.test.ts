import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PortfolioDto } from '@ainyc/canonry-contracts'
import { renderHuman } from '../src/commands/portfolio.js'

function fixture(): PortfolioDto {
  return {
    generatedAt: '2026-06-27T12:00:00.000Z',
    lastSweepAt: '2026-06-27T10:00:00.000Z', // 2h before generatedAt
    projectCount: 1,
    comparableProjectCount: 1,
    firstSweepProjectCount: 0,
    changeFeedTotal: 1,
    feedEmptyState: null,
    changeFeed: [
      {
        id: 'acme:citation-lost:r2',
        projectName: 'Acme',
        projectSlug: 'acme',
        changeType: 'citation-lost',
        tone: 'negative',
        title: 'Acme lost 1 cited query',
        detail: '"best AEO platform"',
        occurredAt: '2026-06-27T10:00:00.000Z',
        href: '/projects/acme',
        actionLabel: 'Open project',
        comparable: true,
      },
    ],
    recentRuns: [
      {
        runId: 'r2',
        projectName: 'Acme',
        projectSlug: 'acme',
        kindLabel: 'Answer visibility sweep',
        status: 'completed',
        createdAt: '2026-06-27T11:00:00.000Z',
        startedAt: '2026-06-27T10:59:30.000Z',
        finishedAt: '2026-06-27T11:00:00.000Z', // 1h before generatedAt
        durationMs: 30_000,
        mentionedCount: 1,
        citedCount: 0,
        totalCount: 2,
        errorSummary: null,
      },
    ],
    projects: [
      {
        projectSlug: 'acme',
        projectName: 'Acme',
        canonicalDomain: 'acme.example.com',
        mentionScore: 50,
        mentionTone: 'caution',
        mentionedOfTotal: { mentioned: 1, total: 2 },
        citedOfTotal: { cited: 0, total: 2 },
        mentionDelta: { gained: 0, lost: 1, comparable: true },
        citationDelta: { gained: 0, lost: 1, comparable: true },
        competitorPressureLabel: 'Low',
        mentionTrend: [100, 50],
        lastRunAt: '2026-06-27T11:00:30.000Z',
        hasEverRun: true,
      },
    ],
  }
}

describe('canonry portfolio — human output', () => {
  const logs: string[] = []
  let spy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    spy?.mockRestore()
    logs.length = 0
  })

  function render(p: PortfolioDto): string {
    spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '))
    })
    renderHuman(p)
    return logs.join('\n')
  }

  it('shows an honest freshness line anchored to generatedAt (not the wall clock)', () => {
    expect(render(fixture())).toContain('last sweep 2h ago')
  })

  it('renders the change feed with a relative timestamp', () => {
    const out = render(fixture())
    expect(out).toContain('Acme lost 1 cited query')
    expect(out).toContain('(2h ago)')
    expect(out).toContain('"best AEO platform"')
  })

  it('renders recent runs with both result signals, a timestamp, and a duration', () => {
    const out = render(fixture())
    expect(out).toContain('M mentioned in answer · C cited in sources')
    expect(out).toContain('M 1/2 · C 0/2')
    expect(out).toContain('finished 1h ago')
    expect(out).toContain('30s')
  })

  it('renders the project state row with distinct mention and cited counts + delta', () => {
    const out = render(fixture())
    expect(out).toContain('M 1/2')
    expect(out).toContain('C 0/2')
    expect(out).toContain('-1 mentioned')
  })

  it('renders the honest empty state instead of a "stable" lie when the feed is empty', () => {
    const empty = fixture()
    empty.changeFeed = []
    empty.changeFeedTotal = 0
    empty.feedEmptyState = { kind: 'all-clear', title: 'No changes since the last sweep', detail: 'All 1 project held their coverage.' }
    const out = render(empty)
    expect(out).toContain('No changes since the last sweep')
    expect(out).not.toContain('All projects stable')
  })
})
