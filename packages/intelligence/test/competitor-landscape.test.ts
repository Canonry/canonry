import { describe, expect, it } from 'vitest'
import type { GroundingSource } from '@ainyc/canonry-contracts'
import {
  buildCompetitorLandscape,
  type CompetitorLandscapeQueryLookup,
  type CompetitorLandscapeSnapshot,
} from '../src/competitor-landscape.js'

function snap(overrides: Partial<CompetitorLandscapeSnapshot> = {}): CompetitorLandscapeSnapshot {
  return {
    queryId: 'q1',
    citedDomains: [],
    competitorOverlap: [],
    groundingSources: [],
    ...overrides,
  }
}

function lookup(entries: Array<[string, string]>): CompetitorLandscapeQueryLookup {
  return { byId: new Map(entries) }
}

const PROJECT_DOMAINS = ['example.com']

describe('buildCompetitorLandscape', () => {
  it('returns zeroed rows for empty snapshots while preserving competitor list', () => {
    const result = buildCompetitorLandscape([], ['rival.com', 'foe.com'], PROJECT_DOMAINS, lookup([]))
    expect(result.projectCitationCount).toBe(0)
    expect(result.competitors.map(c => c.domain).sort()).toEqual(['foe.com', 'rival.com'])
    expect(result.competitors.every(c => c.citationCount === 0 && c.pressureLabel === 'None')).toBe(true)
  })

  it('counts a project citation when any cited domain belongs to the project', () => {
    const snapshots = [snap({ citedDomains: ['example.com'] })]
    const result = buildCompetitorLandscape(snapshots, ['rival.com'], PROJECT_DOMAINS, lookup([['q1', 'best CRM']]))
    expect(result.projectCitationCount).toBe(1)
  })

  it('counts a competitor citation when any cited domain belongs to that competitor', () => {
    const snapshots = [
      snap({ queryId: 'q1', citedDomains: ['rival.com'] }),
      snap({ queryId: 'q2', competitorOverlap: ['rival.com'] }),
    ]
    const result = buildCompetitorLandscape(
      snapshots,
      ['rival.com'],
      PROJECT_DOMAINS,
      lookup([['q1', 'a'], ['q2', 'b']]),
    )
    const rival = result.competitors.find(c => c.domain === 'rival.com')!
    expect(rival.citationCount).toBe(2)
    expect(rival.citedQueries).toEqual(['a', 'b'])
  })

  it('counts a competitor citation regardless of queryId presence in the lookup', () => {
    const snapshots = [snap({ queryId: 'unknown-q', citedDomains: ['rival.com'] })]
    const result = buildCompetitorLandscape(snapshots, ['rival.com'], PROJECT_DOMAINS, lookup([]))
    const rival = result.competitors.find(c => c.domain === 'rival.com')!
    expect(rival.citationCount).toBe(1)
    expect(rival.citedQueries).toEqual([])
  })

  it('labels pressure as High when ratio >= 0.5', () => {
    const snapshots = [
      snap({ queryId: 'q1', citedDomains: ['rival.com'] }),
      snap({ queryId: 'q2', citedDomains: ['rival.com'] }),
      snap({ queryId: 'q3', citedDomains: [] }),
    ]
    const result = buildCompetitorLandscape(
      snapshots,
      ['rival.com'],
      PROJECT_DOMAINS,
      lookup([['q1', 'a'], ['q2', 'b'], ['q3', 'c']]),
    )
    expect(result.competitors[0]?.pressureLabel).toBe('High')
  })

  it('labels pressure as Moderate when ratio in [0.2, 0.5)', () => {
    const snapshots = [
      ...Array.from({ length: 2 }, (_, i) => snap({ queryId: `q${i}`, citedDomains: ['rival.com'] })),
      ...Array.from({ length: 6 }, (_, i) => snap({ queryId: `q${i + 2}`, citedDomains: [] })),
    ]
    const result = buildCompetitorLandscape(snapshots, ['rival.com'], PROJECT_DOMAINS, lookup([]))
    expect(result.competitors[0]?.pressureLabel).toBe('Moderate')
  })

  it('labels pressure as Low when ratio in (0, 0.2)', () => {
    const snapshots = [
      snap({ citedDomains: ['rival.com'] }),
      ...Array.from({ length: 9 }, (_, i) => snap({ queryId: `q${i}`, citedDomains: [] })),
    ]
    const result = buildCompetitorLandscape(snapshots, ['rival.com'], PROJECT_DOMAINS, lookup([]))
    expect(result.competitors[0]?.pressureLabel).toBe('Low')
  })

  it('computes sharePct against the project + all-competitor citation total', () => {
    const snapshots = [
      snap({ queryId: 'q1', citedDomains: ['example.com'] }),
      snap({ queryId: 'q2', citedDomains: ['rival.com'] }),
      snap({ queryId: 'q3', citedDomains: ['rival.com'] }),
    ]
    const result = buildCompetitorLandscape(
      snapshots,
      ['rival.com'],
      PROJECT_DOMAINS,
      lookup([['q1', 'a'], ['q2', 'b'], ['q3', 'c']]),
    )
    expect(result.projectCitationCount).toBe(1)
    expect(result.competitors[0]?.sharePct).toBe(67) // 2 of 3 total
  })

  it('extracts cited pages from grounding sources whose host matches the competitor', () => {
    const groundingSources: GroundingSource[] = [
      { uri: 'https://blog.rival.com/post-1', title: 'A' },
      { uri: 'https://www.rival.com/page', title: 'B' },
      { uri: 'https://unrelated.com/x', title: 'C' },
    ]
    const snapshots = [snap({ queryId: 'q1', groundingSources })]
    const result = buildCompetitorLandscape(
      snapshots,
      ['rival.com'],
      PROJECT_DOMAINS,
      lookup([['q1', 'best CRM']]),
    )
    const pages = result.competitors[0]?.theirCitedPages ?? []
    const urls = pages.map(p => p.url).sort()
    expect(urls).toEqual([
      'https://blog.rival.com/post-1',
      'https://www.rival.com/page',
    ])
    expect(pages.every(p => p.citedFor.includes('best CRM'))).toBe(true)
  })

  it('sorts competitor rows by citation count descending', () => {
    const snapshots = [
      snap({ queryId: 'q1', citedDomains: ['rival.com'] }),
      snap({ queryId: 'q2', citedDomains: ['rival.com'] }),
      snap({ queryId: 'q3', citedDomains: ['foe.com'] }),
    ]
    const result = buildCompetitorLandscape(
      snapshots,
      ['foe.com', 'rival.com'],
      PROJECT_DOMAINS,
      lookup([['q1', 'a'], ['q2', 'b'], ['q3', 'c']]),
    )
    expect(result.competitors.map(c => c.domain)).toEqual(['rival.com', 'foe.com'])
  })

  it('sorts each competitor row\'s theirCitedPages by citedFor count descending', () => {
    const groundingSources: GroundingSource[] = [
      { uri: 'https://rival.com/popular', title: 'Popular' },
      { uri: 'https://rival.com/single', title: 'Single' },
    ]
    const snapshots = [
      snap({ queryId: 'q1', groundingSources }),
      snap({ queryId: 'q2', groundingSources: [{ uri: 'https://rival.com/popular', title: 'Popular' }] }),
    ]
    const result = buildCompetitorLandscape(
      snapshots,
      ['rival.com'],
      PROJECT_DOMAINS,
      lookup([['q1', 'a'], ['q2', 'b']]),
    )
    const pages = result.competitors[0]?.theirCitedPages ?? []
    expect(pages[0]?.url).toBe('https://rival.com/popular')
    expect(pages[0]?.citedFor.length).toBe(2)
    expect(pages[1]?.citedFor.length).toBe(1)
  })

  it('returns sharePct of 0 when no citations exist on either side', () => {
    const result = buildCompetitorLandscape(
      [snap({ citedDomains: [] })],
      ['rival.com'],
      PROJECT_DOMAINS,
      lookup([['q1', 'a']]),
    )
    expect(result.competitors[0]?.sharePct).toBe(0)
  })
})
