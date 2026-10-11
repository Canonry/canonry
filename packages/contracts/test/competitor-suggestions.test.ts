import { describe, expect, it } from 'vitest'
import {
  competitorSuggestionSchema,
  competitorSuggestionsQuerySchema,
  competitorSuggestionsResponseSchema,
} from '../src/index.js'

describe('competitor suggestion contracts', () => {
  it('parses bounded filters and candidate evidence', () => {
    expect(competitorSuggestionsQuerySchema.parse({})).toEqual({})
    expect(competitorSuggestionsQuerySchema.safeParse({ window: '60d' }).success).toBe(false)
    expect(competitorSuggestionSchema.parse({
      domain: 'northstar.example',
      label: 'northstar',
      names: [{ name: 'Northstar', answerCount: 3, pairedAnswers: 3 }],
      namingAnswers: 3,
      citingAnswers: 3,
      bothAnswers: 3,
      pairedAnswers: 3,
      namedByOtherNameAnswers: 0,
      sweeps: 2,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-02T00:00:00.000Z',
      surfaceClass: 'unknown',
      tracked: false,
      status: 'suggested',
      reason: null,
      sampleUrls: [],
    })).toHaveProperty('domain', 'northstar.example')
  })

  it('keeps response evidence and count units explicit', () => {
    const response = {
      project: 'subject',
      window: '30d',
      scope: { kind: 'project' },
      filters: { queryClass: 'non-brand', groupKey: null, limit: 25, minAnswers: 3 },
      thresholds: { minAnswers: 3 },
      candidates: [],
      candidatesTotal: 0,
      excludedCounts: {},
      unresolvedNames: [],
      evidence: { answeredResults: 0, sourceResults: 0, excludedProbeResults: 0, excludedNonCompletedResults: 0 },
      runCount: 0,
      runIds: [],
      countUnits: { answers: ['namingAnswers'], distinctNames: ['unresolvedNames'], runs: ['sweeps'] },
      truncated: false,
    }
    expect(competitorSuggestionsResponseSchema.parse(response).filters.queryClass).toBe('non-brand')
  })
})
