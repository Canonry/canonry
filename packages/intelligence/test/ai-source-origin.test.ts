import { describe, expect, it } from 'vitest'
import {
  buildAiSourceOrigin,
  DEFAULT_TOP_SOURCE_DOMAINS_LIMIT,
  type AiSourceOriginSnapshot,
} from '../src/ai-source-origin.js'

function snap(citedDomains: string[]): AiSourceOriginSnapshot {
  return { citedDomains }
}

const PROJECT_DOMAINS = ['example.com']
const COMPETITOR_DOMAINS = ['rival.com']

describe('buildAiSourceOrigin', () => {
  it('returns empty categories and topDomains for empty input', () => {
    expect(buildAiSourceOrigin([], PROJECT_DOMAINS, COMPETITOR_DOMAINS)).toEqual({
      categories: [],
      topDomains: [],
    })
  })

  it('excludes the project\'s own cited domains from the origin breakdown', () => {
    const snapshots = [snap(['example.com', 'blog.example.com', 'wikipedia.org'])]
    const result = buildAiSourceOrigin(snapshots, PROJECT_DOMAINS, COMPETITOR_DOMAINS)
    const domains = result.topDomains.map(d => d.domain)
    expect(domains).not.toContain('example.com')
    expect(domains).not.toContain('blog.example.com')
    expect(domains).toContain('wikipedia.org')
  })

  it('flags competitor domains with isCompetitor=true in topDomains', () => {
    const snapshots = [snap(['rival.com', 'unrelated.com'])]
    const result = buildAiSourceOrigin(snapshots, PROJECT_DOMAINS, COMPETITOR_DOMAINS)
    const rival = result.topDomains.find(d => d.domain === 'rival.com')
    const unrelated = result.topDomains.find(d => d.domain === 'unrelated.com')
    expect(rival?.isCompetitor).toBe(true)
    expect(unrelated?.isCompetitor).toBe(false)
  })

  it('sums counts per source domain across snapshots', () => {
    const snapshots = [
      snap(['wikipedia.org']),
      snap(['wikipedia.org', 'reddit.com']),
      snap(['wikipedia.org']),
    ]
    const result = buildAiSourceOrigin(snapshots, PROJECT_DOMAINS, COMPETITOR_DOMAINS)
    const wiki = result.topDomains.find(d => d.domain === 'wikipedia.org')
    const reddit = result.topDomains.find(d => d.domain === 'reddit.com')
    expect(wiki?.count).toBe(3)
    expect(reddit?.count).toBe(1)
  })

  it('sorts topDomains by count descending', () => {
    const snapshots = [
      snap(['a.com']),
      snap(['b.com', 'b.com']),
      snap(['c.com', 'c.com', 'c.com']),
    ]
    const result = buildAiSourceOrigin(snapshots, PROJECT_DOMAINS, COMPETITOR_DOMAINS)
    expect(result.topDomains.map(d => d.domain)).toEqual(['c.com', 'b.com', 'a.com'])
  })

  it('caps topDomains at the provided limit', () => {
    const snapshots = [
      snap(['a.com', 'b.com', 'c.com', 'd.com', 'e.com']),
    ]
    const result = buildAiSourceOrigin(snapshots, PROJECT_DOMAINS, COMPETITOR_DOMAINS, 3)
    expect(result.topDomains).toHaveLength(3)
  })

  it('defaults the topDomains cap to DEFAULT_TOP_SOURCE_DOMAINS_LIMIT', () => {
    expect(DEFAULT_TOP_SOURCE_DOMAINS_LIMIT).toBe(20)
    const domains = Array.from({ length: 25 }, (_, i) => `d${i}.com`)
    const result = buildAiSourceOrigin([snap(domains)], PROJECT_DOMAINS, COMPETITOR_DOMAINS)
    expect(result.topDomains).toHaveLength(20)
  })

  it('rounds category sharePct to integer percent', () => {
    const snapshots = [
      snap(['wikipedia.org', 'wikipedia.org', 'reddit.com']),
    ]
    const result = buildAiSourceOrigin(snapshots, PROJECT_DOMAINS, COMPETITOR_DOMAINS)
    // The exact category names are owned by categorizeSource — assert that sharePct sums sensibly
    const totalShare = result.categories.reduce((s, c) => s + c.sharePct, 0)
    expect(totalShare).toBeGreaterThanOrEqual(99)
    expect(totalShare).toBeLessThanOrEqual(101)
  })

  it('sorts categories by count descending', () => {
    const snapshots = [
      snap(['wikipedia.org', 'reddit.com', 'reddit.com', 'reddit.com']),
    ]
    const result = buildAiSourceOrigin(snapshots, PROJECT_DOMAINS, COMPETITOR_DOMAINS)
    if (result.categories.length >= 2) {
      expect(result.categories[0]!.count).toBeGreaterThanOrEqual(result.categories[1]!.count)
    }
  })

  it('returns sharePct of 0 for all categories when no citations exist', () => {
    const snapshots = [snap(['example.com'])] // only project domains, all excluded
    const result = buildAiSourceOrigin(snapshots, PROJECT_DOMAINS, COMPETITOR_DOMAINS)
    expect(result.categories).toEqual([])
    expect(result.topDomains).toEqual([])
  })

  it('groups tracked competitor citations into the dedicated competitor bucket', () => {
    // Without competitor bucketing this test exercises the regression that
    // motivated the rework: rivals were spread across "other" alongside
    // unrelated business sites and the donut became unreadable.
    const snapshots = [
      snap(['rival.com', 'rival.com', 'unrelated.com', 'wikipedia.org']),
    ]
    const result = buildAiSourceOrigin(snapshots, PROJECT_DOMAINS, COMPETITOR_DOMAINS)
    const competitor = result.categories.find(c => c.category === 'competitor')
    expect(competitor?.count).toBe(2)
    expect(competitor?.label).toBe('Tracked competitors')
    // The rival domain still appears in topDomains with its competitor flag.
    const rival = result.topDomains.find(d => d.domain === 'rival.com')
    expect(rival?.isCompetitor).toBe(true)
  })

  it('routes known directories to the directory bucket instead of "Other"', () => {
    const snapshots = [snap(['yelp.com', 'angi.com', 'g2.com', 'unrelated.com'])]
    const result = buildAiSourceOrigin(snapshots, PROJECT_DOMAINS, COMPETITOR_DOMAINS)
    const directory = result.categories.find(c => c.category === 'directory')
    expect(directory?.count).toBe(3)
    expect(directory?.label).toBe('Directories & review sites')
  })
})
