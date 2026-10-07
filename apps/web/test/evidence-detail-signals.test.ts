import { expect, test } from 'vitest'

import { evidenceCompetitorSignals } from '../src/components/layout/EvidenceDetailModal.js'

test('current evidence keeps cited-only and mentioned-only competitors separate', () => {
  expect(evidenceCompetitorSignals({
    citedCompetitorDomains: ['source-only.example'],
    mentionedCompetitorDomains: ['answer-only.example'],
  })).toEqual({
    citedCompetitorDomains: ['source-only.example'],
    mentionedCompetitorDomains: ['answer-only.example'],
  })
})

test('historical snapshot fields replace the matching current signal without crossing signals', () => {
  const current = {
    citedCompetitorDomains: ['current-source.example'],
    mentionedCompetitorDomains: ['current-answer.example'],
  }

  expect(evidenceCompetitorSignals({
    citedCompetitorDomains: ['historical-source.example'],
    mentionedCompetitorDomains: [],
  }, current)).toEqual({
    citedCompetitorDomains: ['historical-source.example'],
    mentionedCompetitorDomains: [],
  })
})

test('legacy mixed overlap is not promoted into either labelled signal', () => {
  expect(evidenceCompetitorSignals({ competitorDomains: ['legacy-mixed.example'] } as never)).toEqual({
    citedCompetitorDomains: [],
    mentionedCompetitorDomains: [],
  })
})

test('matched competitor terms travel with the mention signal they explain', () => {
  const current = {
    citedCompetitorDomains: [],
    mentionedCompetitorDomains: ['spoketuneworks.example'],
    mentionedCompetitorTerms: ['TuneSpoke'],
  }
  expect(evidenceCompetitorSignals(current)).toEqual(current)
  // A historical row with its own mention signal never borrows current terms.
  expect(evidenceCompetitorSignals({ mentionedCompetitorDomains: [], mentionedCompetitorTerms: [] }, current)).toEqual({
    citedCompetitorDomains: [],
    mentionedCompetitorDomains: [],
    mentionedCompetitorTerms: [],
  })
  // A row without a mention signal falls back to the current one, terms included.
  expect(evidenceCompetitorSignals({ citedCompetitorDomains: ['rival.example'] }, current)).toEqual({
    citedCompetitorDomains: ['rival.example'],
    mentionedCompetitorDomains: ['spoketuneworks.example'],
    mentionedCompetitorTerms: ['TuneSpoke'],
  })
})
