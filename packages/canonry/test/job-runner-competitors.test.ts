import { expect, test } from 'vitest'
import type { NormalizedQueryResult } from '@ainyc/canonry-contracts'

import {
  computeCompetitorOverlap,
  determineCitationState,
  extractRecommendedCompetitors,
} from '../src/citation-utils.js'

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

test('domain identity matching rejects hostname and prose substrings', () => {
  const result = buildResult('Acmeology links to notacme.com.', {
    groundingSources: [{ uri: 'https://notacme.com/path/acme.com', title: 'Not Acme' }],
  })
  expect(computeCompetitorOverlap(result, ['acme.com'])).toEqual([])
  expect(determineCitationState(result, ['acme.com'])).toBe('not-cited')
})

test('domain identity matching accepts a structured source subdomain', () => {
  const result = buildResult('No domain is written in prose.', {
    groundingSources: [{ uri: 'https://docs.acme.com/guide', title: 'Guide' }],
  })
  expect(determineCitationState(result, ['acme.com'])).toBe('cited')
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

test('extractRecommendedCompetitors never recommends a cited listing marketplace, but keeps a real rival', () => {
  const answer = [
    'Here are the best options:',
    '',
    '1. **Apartments.com** - the biggest listing site',
    '2. **Rival Homes** - well reviewed downtown buildings',
  ].join('\n')
  expect(extractRecommendedCompetitors(answer, ['brand.example'], ['apartments.com', 'rivalhomes.example'], [], ['Brand'])).toEqual(['Rival Homes'])
})

test('extractRecommendedCompetitors still recommends a marketplace the operator tracks as a competitor', () => {
  const answer = '1. **Zillow** - search every listing in one place\n2. **Other Pick** - an alternative'
  expect(extractRecommendedCompetitors(answer, ['brand.example'], ['zillow.com'], ['zillow.com'], ['Brand'])).toEqual(['Zillow'])
})

test('extractRecommendedCompetitors keeps a cited OTA as a rival: only listing marketplaces are ruled out', () => {
  const answer = '1. **Booking.com** - compare rates\n2. **Apartments.com** - browse rentals'
  expect(extractRecommendedCompetitors(answer, ['hotel.example'], ['booking.com', 'apartments.com'], [], ['Hotel'])).toEqual(['Booking.com'])
})

test('a competitor\'s operator-approved name counts in overlap and recommendations without a citation', () => {
  const aliases = new Map([['maac.com', ['MAA', 'Mid-America Apartment Communities']]])
  const answer = 'Consider these operators:\n\n1. **MAA** - large portfolio in the metro\n2. **Other Option** - smaller'
  expect(computeCompetitorOverlap(buildResult(answer), ['maac.com'], aliases)).toEqual(['maac.com'])
  expect(extractRecommendedCompetitors(answer, ['brand.example'], [], ['maac.com'], ['Brand'], aliases)).toEqual(['MAA'])
  // Without the plan's names, the domain label "maac" never matches "MAA".
  expect(computeCompetitorOverlap(buildResult(answer), ['maac.com'])).toEqual([])
})
