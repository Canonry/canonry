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
      queryId: 'q-1',
      query: 'best CRM',
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
      queryId: 'q-1',
      query: 'foo',
      providers: [{ provider: 'gemini', citationState: 'pending', cited: false, mentioned: false, runId: 'r', runCreatedAt: 't' }],
      citedCount: 0,
      mentionedCount: 0,
      totalProviders: 1,
    }
    expect(() => citationCoverageRowSchema.parse(bad)).toThrow()
  })

  it('requires the mentioned flag on each provider', () => {
    const missing = {
      queryId: 'q-1',
      query: 'foo',
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
      queryId: 'q-2',
      query: 'CRM software',
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
        totalQueries: 10,
        queriesCitedAndMentioned: 1,
        queriesCitedOnly: 2,
        queriesMentionedOnly: 1,
        queriesInvisible: 6,
        latestRunId: 'run-1',
        latestRunAt: '2026-04-29T00:00:00Z',
      },
      byQuery: [],
      competitorGaps: [],
      status: 'ready' as const,
    }
    const parsed = citationVisibilityResponseSchema.parse(response)
    expect(parsed.summary.providersCiting).toBe(1)
    expect(parsed.summary.providersMentioning).toBe(2)
    expect(parsed.summary.queriesCitedAndMentioned).toBe(1)
    expect(parsed.status).toBe('ready')
  })

  it('round-trips a no-data sentinel', () => {
    const response = emptyCitationVisibility('no-runs-yet')
    const parsed = citationVisibilityResponseSchema.parse(response)
    expect(parsed.status).toBe('no-data')
    expect(parsed.reason).toBe('no-runs-yet')
    expect(parsed.summary.totalQueries).toBe(0)
    expect(parsed.summary.providersMentioning).toBe(0)
    expect(parsed.summary.queriesInvisible).toBe(0)
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
