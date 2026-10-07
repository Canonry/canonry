import { expect, test } from 'vitest'
import type { NormalizedQueryResult } from '@ainyc/canonry-contracts'

import { determineCitationState } from '../src/citation-utils.js'

// The competitor matchers (`computeCompetitorOverlap`,
// `extractRecommendedCompetitors`) live in contracts and are tested in
// packages/contracts/test/competitor-matching.test.ts.

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

test('domain identity matching rejects hostname and prose substrings', () => {
  const result = buildResult('Acmeology links to notacme.com.', {
    groundingSources: [{ uri: 'https://notacme.com/path/acme.com', title: 'Not Acme' }],
  })
  expect(determineCitationState(result, ['acme.com'])).toBe('not-cited')
})

test('domain identity matching accepts a structured source subdomain', () => {
  const result = buildResult('No domain is written in prose.', {
    groundingSources: [{ uri: 'https://docs.acme.com/guide', title: 'Guide' }],
  })
  expect(determineCitationState(result, ['acme.com'])).toBe('cited')
})
