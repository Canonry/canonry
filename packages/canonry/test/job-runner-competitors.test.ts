import { expect, test } from 'vitest'
import type { NormalizedQueryResult } from '@ainyc/canonry-contracts'

import { computeCompetitorOverlap, extractRecommendedCompetitors } from '../src/citation-utils.js'

function buildResult(answer: string, overrides?: Partial<NormalizedQueryResult>): NormalizedQueryResult {
  return {
    provider: 'test',
    answerText: answer,
    citedDomains: [],
    groundingSources: [],
    searchQueries: [],
    ...overrides,
  }
}

test('extractRecommendedCompetitors excludes headings and the target brand', () => {
  const answer = [
    '### Why it stands out',
    'Use a provider with borough coverage.',
    '',
    '1. **Citypoint Dental** - the target brand',
    '2. **Downtown Smiles** - same-day care',
  ].join('\n')

  expect(
    extractRecommendedCompetitors(
      answer,
      ['citypointdental.com'],
      ['citypointdental.com', 'downtownsmiles.com'],
      [],
    ),
  ).toEqual(['Downtown Smiles'])
})

test('extractRecommendedCompetitors matches spaced company names to compact domains', () => {
  const answer = [
    '1. Regional Joint Care — broad orthopedic network',
    '2. Northstar Ortho — physician bios and outcomes',
  ].join('\n')

  expect(
    extractRecommendedCompetitors(
      answer,
      ['acmehealth.com'],
      ['regionaljointcare.com', 'northstarortho.com'],
      [],
    ),
  ).toEqual(['Regional Joint Care', 'Northstar Ortho'])
})

test('computeCompetitorOverlap does not match a subdomain label as a brand word', () => {
  // Regression: with stored competitor `offers.roofle.com`, the prior code
  // pulled `offers` from the leftmost label and word-boundary-matched it
  // against arbitrary prose. Use the registrable domain's brand label
  // (`roofle`) instead — the answer below should produce zero overlap.
  const answer = 'Energy Design Systems offers a white-label lead generation tool. Demand IQ uses AI-driven estimates.'
  const result = buildResult(answer)
  expect(computeCompetitorOverlap(result, ['offers.roofle.com'])).toEqual([])
})

test('computeCompetitorOverlap still flags the registrable brand of a subdomained competitor', () => {
  // Sanity: the brand label drawn from the eTLD+1 still matches when the
  // answer mentions the actual brand name.
  const answer = 'Brokers turn to Roofle for instant install quotes.'
  const result = buildResult(answer)
  expect(computeCompetitorOverlap(result, ['offers.roofle.com'])).toEqual(['offers.roofle.com'])
})

test('computeCompetitorOverlap matches the full registrable domain in the answer', () => {
  const answer = 'See pricing at roofle.com for details.'
  const result = buildResult(answer)
  expect(computeCompetitorOverlap(result, ['roofle.com'])).toEqual(['roofle.com'])
})

test('extractRecommendedCompetitors does not seed a brand from a subdomain label', () => {
  // The competitor `offers.roofle.com` should source brand keys from
  // `roofle.com` (keys: `rooflecom`, `roofle`) — never from `offers`. So
  // a heading like `### Offers` must not promote "Offers" to a recommended
  // competitor.
  const answer = [
    '### Offers',
    'Energy Design Systems is a major provider.',
    '',
    '1. **Roofle** - install-quote engine',
  ].join('\n')

  expect(
    extractRecommendedCompetitors(
      answer,
      ['demandiq.com'],
      [],
      ['offers.roofle.com'],
    ),
  ).toEqual(['Roofle'])
})
