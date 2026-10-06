import { expect, test } from 'vitest'

import { computeCompetitorOverlap, extractRecommendedCompetitors } from '../src/competitor-matching.js'
import type { NormalizedQueryResult } from '../src/provider.js'

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
  // Regression: with stored competitor `offers.quotebird.test`, the prior code
  // pulled `offers` from the leftmost label and word-boundary-matched it
  // against arbitrary prose. Use the registrable domain's brand label
  // (`quotebird`) instead — the answer below should produce zero overlap.
  const answer = 'Northwind Solar Systems offers a white-label lead generation tool. Acme IQ uses AI-driven estimates.'
  const result = buildResult(answer)
  expect(computeCompetitorOverlap(result, ['offers.quotebird.test'])).toEqual([])
})

test('computeCompetitorOverlap still flags the registrable brand of a subdomained competitor', () => {
  // Sanity: the brand label drawn from the eTLD+1 still matches when the
  // answer mentions the actual brand name.
  const answer = 'Brokers turn to Quotebird for instant install quotes.'
  const result = buildResult(answer)
  expect(computeCompetitorOverlap(result, ['offers.quotebird.test'])).toEqual(['offers.quotebird.test'])
})

test('computeCompetitorOverlap matches the full registrable domain in the answer', () => {
  const answer = 'See pricing at quotebird.example.com for details.'
  const result = buildResult(answer)
  expect(computeCompetitorOverlap(result, ['quotebird.example.com'])).toEqual(['quotebird.example.com'])
})

test('computeCompetitorOverlap rejects hostname and prose substrings', () => {
  const result = buildResult('Acmeology links to notacme.com.', {
    groundingSources: [{ uri: 'https://notacme.com/path/acme.com', title: 'Not Acme' }],
  })
  expect(computeCompetitorOverlap(result, ['acme.com'])).toEqual([])
})

test('extractRecommendedCompetitors does not seed a brand from a subdomain label', () => {
  // The competitor `offers.quotebird.test` should source brand keys from
  // `quotebird.test` (keys: `quotebirdtest`, `quotebird`) — never from `offers`. So
  // a heading like `### Offers` must not promote "Offers" to a recommended
  // competitor.
  const answer = [
    '### Offers',
    'Northwind Solar Systems is a major provider.',
    '',
    '1. **Quotebird** - install-quote engine',
  ].join('\n')

  expect(
    extractRecommendedCompetitors(
      answer,
      ['acmeiq.test'],
      [],
      ['offers.quotebird.test'],
    ),
  ).toEqual(['Quotebird'])
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

test('extractRecommendedCompetitors never recommends a rival named only in a citation chip', () => {
  // Shape of an OpenAI web-search answer: sources are inline chips whose
  // labels can be a site name. A chip is a citation, not a recommendation.
  const chipOnly = 'Pet fees at Bayside Flats run $300 to $400 per pet. ([Rival Homes](https://rivalhomes.example/pets/?utm_source=chatgpt.com), [harborview.com](https://harborview.com/pets/?utm_source=chatgpt.com))'
  expect(extractRecommendedCompetitors(chipOnly, ['harborview.com'], ['rivalhomes.example', 'harborview.com'], [], ['Harborview Living'])).toEqual([])
  // The same rival linked in a sentence is named by the answer.
  const prose = `For lower fees, [Rival Homes](https://rivalhomes.example/pets) charges $200 per pet. ${chipOnly.slice(chipOnly.indexOf('(['))}`
  expect(extractRecommendedCompetitors(prose, ['harborview.com'], ['rivalhomes.example', 'harborview.com'], [], ['Harborview Living'])).toEqual(['Rival Homes'])
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
