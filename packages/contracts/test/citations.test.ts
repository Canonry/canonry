import { describe, it, expect } from 'vitest'
import {
  citationCoverageRowSchema,
  competitorGapRowSchema,
  citationVisibilityResponseSchema,
  emptyCitationVisibility,
  citationStateToCited,
} from '../src/citations.js'

describe('citationCoverageRowSchema', () => {
  it('accepts a row with mixed citation states', () => {
    const row = {
      keywordId: 'kw-1',
      keyword: 'best CRM',
      providers: [
        { provider: 'gemini', citationState: 'cited' as const, cited: true, runId: 'run-1', runCreatedAt: '2026-04-29T00:00:00Z' },
        { provider: 'claude', citationState: 'not-cited' as const, cited: false, runId: 'run-1', runCreatedAt: '2026-04-29T00:00:00Z' },
      ],
      citedCount: 1,
      totalProviders: 2,
    }
    expect(() => citationCoverageRowSchema.parse(row)).not.toThrow()
  })

  it('rejects unknown citation states', () => {
    const bad = {
      keywordId: 'kw-1',
      keyword: 'foo',
      providers: [{ provider: 'gemini', citationState: 'pending', cited: false, runId: 'r', runCreatedAt: 't' }],
      citedCount: 0,
      totalProviders: 1,
    }
    expect(() => citationCoverageRowSchema.parse(bad)).toThrow()
  })
})

describe('competitorGapRowSchema', () => {
  it('accepts a gap with a list of citing competitors', () => {
    const gap = {
      keywordId: 'kw-2',
      keyword: 'CRM software',
      provider: 'gemini',
      citingCompetitors: ['salesforce.com', 'hubspot.com'],
      runId: 'run-1',
      runCreatedAt: '2026-04-29T00:00:00Z',
    }
    expect(() => competitorGapRowSchema.parse(gap)).not.toThrow()
  })
})

describe('citationVisibilityResponseSchema', () => {
  it('round-trips a ready response', () => {
    const response = {
      summary: {
        providersConfigured: 4,
        providersCiting: 1,
        totalKeywords: 10,
        keywordsCited: 3,
        keywordsFullyCovered: 0,
        keywordsUncovered: 7,
        latestRunId: 'run-1',
        latestRunAt: '2026-04-29T00:00:00Z',
      },
      byKeyword: [],
      competitorGaps: [],
      status: 'ready' as const,
    }
    const parsed = citationVisibilityResponseSchema.parse(response)
    expect(parsed.summary.providersCiting).toBe(1)
    expect(parsed.status).toBe('ready')
  })

  it('round-trips a no-data sentinel', () => {
    const response = emptyCitationVisibility('no-runs-yet')
    const parsed = citationVisibilityResponseSchema.parse(response)
    expect(parsed.status).toBe('no-data')
    expect(parsed.reason).toBe('no-runs-yet')
    expect(parsed.summary.totalKeywords).toBe(0)
  })
})

describe('citationStateToCited', () => {
  it('maps cited to true', () => {
    expect(citationStateToCited('cited')).toBe(true)
  })
  it('maps not-cited to false', () => {
    expect(citationStateToCited('not-cited')).toBe(false)
  })
})
