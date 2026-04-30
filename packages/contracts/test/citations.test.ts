import { describe, it, expect } from 'vitest'
import {
  citationCoverageRowSchema,
  competitorGapRowSchema,
  citationVisibilityResponseSchema,
  emptyCitationVisibility,
  citationStateToCited,
} from '../src/citations.js'

describe('citationCoverageRowSchema', () => {
  it('accepts a row with mixed citation + mention states', () => {
    const row = {
      keywordId: 'kw-1',
      keyword: 'best CRM',
      providers: [
        { provider: 'gemini', citationState: 'cited' as const, cited: true, mentioned: true, runId: 'run-1', runCreatedAt: '2026-04-29T00:00:00Z' },
        { provider: 'claude', citationState: 'not-cited' as const, cited: false, mentioned: true, runId: 'run-1', runCreatedAt: '2026-04-29T00:00:00Z' },
      ],
      citedCount: 1,
      mentionedCount: 2,
      totalProviders: 2,
    }
    expect(() => citationCoverageRowSchema.parse(row)).not.toThrow()
  })

  it('rejects unknown citation states', () => {
    const bad = {
      keywordId: 'kw-1',
      keyword: 'foo',
      providers: [{ provider: 'gemini', citationState: 'pending', cited: false, mentioned: false, runId: 'r', runCreatedAt: 't' }],
      citedCount: 0,
      mentionedCount: 0,
      totalProviders: 1,
    }
    expect(() => citationCoverageRowSchema.parse(bad)).toThrow()
  })

  it('requires the mentioned flag on each provider', () => {
    const missing = {
      keywordId: 'kw-1',
      keyword: 'foo',
      providers: [{ provider: 'gemini', citationState: 'cited', cited: true, runId: 'r', runCreatedAt: 't' }],
      citedCount: 1,
      mentionedCount: 0,
      totalProviders: 1,
    }
    expect(() => citationCoverageRowSchema.parse(missing)).toThrow()
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
  it('round-trips a ready response with cross-tab buckets', () => {
    const response = {
      summary: {
        providersConfigured: 4,
        providersCiting: 1,
        providersMentioning: 2,
        totalKeywords: 10,
        keywordsCitedAndMentioned: 1,
        keywordsCitedOnly: 2,
        keywordsMentionedOnly: 1,
        keywordsInvisible: 6,
        latestRunId: 'run-1',
        latestRunAt: '2026-04-29T00:00:00Z',
      },
      byKeyword: [],
      competitorGaps: [],
      status: 'ready' as const,
    }
    const parsed = citationVisibilityResponseSchema.parse(response)
    expect(parsed.summary.providersCiting).toBe(1)
    expect(parsed.summary.providersMentioning).toBe(2)
    expect(parsed.summary.keywordsCitedAndMentioned).toBe(1)
    expect(parsed.status).toBe('ready')
  })

  it('round-trips a no-data sentinel', () => {
    const response = emptyCitationVisibility('no-runs-yet')
    const parsed = citationVisibilityResponseSchema.parse(response)
    expect(parsed.status).toBe('no-data')
    expect(parsed.reason).toBe('no-runs-yet')
    expect(parsed.summary.totalKeywords).toBe(0)
    expect(parsed.summary.providersMentioning).toBe(0)
    expect(parsed.summary.keywordsInvisible).toBe(0)
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
