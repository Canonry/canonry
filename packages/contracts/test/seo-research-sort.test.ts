import { describe, expect, it } from 'vitest'
import { compareSeoCompetitorsBy, compareSeoKeywordGapsBy } from '../src/seo-research-sort.js'
import { seoCompetitorQuerySchema, seoKeywordGapQuerySchema, type SeoCompetitor, type SeoKeywordGap } from '../src/seo.js'

const target = { kind: 'domain' as const, value: 'example.com', includeSubdomains: true }
const competitor = { ...target, value: 'rival.com' }
const provenance = { provider: 'dataforseo' as const, dataset: 'google/domain-intersection', engine: 'google' as const, locationCode: 2840, languageCode: 'en', device: 'unspecified' as const, collectedAt: '2026-10-27T12:00:00Z', sourceUpdatedAt: null }
const gapBase = { target, competitor, targetUrl: null, competitorUrl: null, keywordDifficulty: null, cpcUsd: null, provenance }
const gaps: SeoKeywordGap[] = [
  { ...gapBase, keyword: 'Delta', targetRankOrganic: null, competitorRankOrganic: 7, rankGap: null, searchVolume: 20, kind: 'missing' },
  { ...gapBase, keyword: 'Bravo', targetRankOrganic: 3, competitorRankOrganic: 12, rankGap: -9, searchVolume: 100, kind: 'shared' },
  { ...gapBase, keyword: 'charlie', targetRankOrganic: 5, competitorRankOrganic: 5, rankGap: 0, searchVolume: null, kind: 'shared' },
  { ...gapBase, keyword: 'alpha', targetRankOrganic: 12, competitorRankOrganic: 3, rankGap: 9, searchVolume: 0, kind: 'outranked' },
]
const competitors: SeoCompetitor[] = [
  { target, domain: 'delta.com', sharedKeywords: 5, averagePosition: 9, estimatedOrganicTraffic: 20, organicKeywords: null, provenance },
  { target, domain: 'bravo.com', sharedKeywords: 10, averagePosition: null, estimatedOrganicTraffic: 0, organicKeywords: null, provenance },
  { target, domain: 'charlie.com', sharedKeywords: null, averagePosition: 1.2, estimatedOrganicTraffic: null, organicKeywords: null, provenance },
  { target, domain: 'alpha.com', sharedKeywords: 0, averagePosition: 4.5, estimatedOrganicTraffic: 120, organicKeywords: null, provenance },
]

describe('keyword-gap ordering', () => {
  it.each([
    ['keyword', ['alpha', 'Bravo', 'charlie', 'Delta']],
    ['-keyword', ['Delta', 'charlie', 'Bravo', 'alpha']],
    ['kind', ['Delta', 'alpha', 'Bravo', 'charlie']],
    ['-kind', ['Bravo', 'charlie', 'alpha', 'Delta']],
    ['target-rank', ['Bravo', 'charlie', 'alpha', 'Delta']],
    ['-target-rank', ['alpha', 'charlie', 'Bravo', 'Delta']],
    ['competitor-rank', ['alpha', 'charlie', 'Delta', 'Bravo']],
    ['-competitor-rank', ['Bravo', 'Delta', 'charlie', 'alpha']],
    ['rank-gap', ['Bravo', 'charlie', 'alpha', 'Delta']],
    ['-rank-gap', ['alpha', 'charlie', 'Bravo', 'Delta']],
    ['volume', ['alpha', 'Delta', 'Bravo', 'charlie']],
    ['-volume', ['Bravo', 'Delta', 'alpha', 'charlie']],
  ] as const)('%s orders observed values exactly and keeps unknown values last', (sort, expected) => {
    expect([...gaps].sort(compareSeoKeywordGapsBy(sort)).map(row => row.keyword)).toEqual(expected)
  })

  it.each([0, null])('keeps domain-pair and keyword tie-breaks ascending for volume %s in either direction', searchVolume => {
    const rows = [
      { ...gaps[0]!, target: { ...target, value: 'b.com' }, competitor: { ...competitor, value: 'a.com' }, keyword: 'Tea', searchVolume },
      { ...gaps[0]!, target: { ...target, value: 'a.com' }, competitor: { ...competitor, value: 'b.com' }, keyword: 'Tea', searchVolume },
      { ...gaps[0]!, target: { ...target, value: 'a.com' }, competitor: { ...competitor, value: 'a.com' }, keyword: 'tea', searchVolume },
      { ...gaps[0]!, target: { ...target, value: 'a.com' }, competitor: { ...competitor, value: 'a.com' }, keyword: 'Tea', searchVolume },
    ]
    for (const sort of ['volume', '-volume'] as const) {
      expect([...rows].sort(compareSeoKeywordGapsBy(sort)).map(row => `${row.target.value}/${row.competitor.value}/${row.keyword}`)).toEqual([
        'a.com/a.com/Tea', 'a.com/a.com/tea', 'a.com/b.com/Tea', 'b.com/a.com/Tea',
      ])
    }
  })
})

describe('organic-competitor ordering', () => {
  it.each([
    ['domain', ['alpha.com', 'bravo.com', 'charlie.com', 'delta.com']],
    ['-domain', ['delta.com', 'charlie.com', 'bravo.com', 'alpha.com']],
    ['shared', ['alpha.com', 'delta.com', 'bravo.com', 'charlie.com']],
    ['-shared', ['bravo.com', 'delta.com', 'alpha.com', 'charlie.com']],
    ['position', ['charlie.com', 'alpha.com', 'delta.com', 'bravo.com']],
    ['-position', ['delta.com', 'alpha.com', 'charlie.com', 'bravo.com']],
    ['traffic', ['bravo.com', 'delta.com', 'alpha.com', 'charlie.com']],
    ['-traffic', ['alpha.com', 'delta.com', 'bravo.com', 'charlie.com']],
  ] as const)('%s orders observed values exactly and keeps unknown values last', (sort, expected) => {
    expect([...competitors].sort(compareSeoCompetitorsBy(sort)).map(row => row.domain)).toEqual(expected)
  })

  it.each([0, null])('keeps target/domain tie-breaks ascending for traffic %s in either direction', estimatedOrganicTraffic => {
    const rows = [
      { ...competitors[0]!, target: { ...target, value: 'b.com' }, domain: 'a.com', estimatedOrganicTraffic },
      { ...competitors[0]!, target: { ...target, value: 'a.com' }, domain: 'b.com', estimatedOrganicTraffic },
      { ...competitors[0]!, target: { ...target, value: 'a.com' }, domain: 'a.com', estimatedOrganicTraffic },
    ]
    for (const sort of ['traffic', '-traffic'] as const) {
      expect([...rows].sort(compareSeoCompetitorsBy(sort)).map(row => `${row.target.value}/${row.domain}`)).toEqual(['a.com/a.com', 'a.com/b.com', 'b.com/a.com'])
    }
  })
})

describe('organic-research sort requests', () => {
  it('keeps omitted order absent and rejects orders belonging to another dataset', () => {
    expect(seoCompetitorQuerySchema.parse({ profileId: 'saved' })).toEqual({ profileId: 'saved' })
    expect(seoKeywordGapQuerySchema.parse({ kind: 'missing', sort: '-volume' })).toEqual({ kind: 'missing', sort: '-volume' })
    expect(seoCompetitorQuerySchema.safeParse({ sort: '-volume' }).success).toBe(false)
    expect(seoKeywordGapQuerySchema.safeParse({ sort: 'traffic' }).success).toBe(false)
  })
})
