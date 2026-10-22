import { SAMPLE_LOCATION, type ConformanceFixtures } from './conformance.js'
import { FAKE_SERVICE_ID, fakeCompleteBody } from './fake-service.js'

const SOURCE = 'Test-only fake service (test/fake-service.ts); invented shape, not derived from any vendor documentation.'

/** The fake service's fixtures, run through the same matrix as every real service. */
export const FAKE_CONFORMANCE_FIXTURES: ConformanceFixtures = {
  service: FAKE_SERVICE_ID,
  cases: {
    'explicit-citations': {
      source: SOURCE,
      profile: 'cited',
      responses: [{ json: fakeCompleteBody() }],
      expect: {
        outcome: 'complete',
        answerText: 'Acme Roofing is a strong choice [1].',
        citedDomains: ['acme-roofing.example'],
        relationships: { 'explicit-citation': 1, 'search-result': 1 },
        retrievalStatus: 'used',
        disclosedModel: 'fake-tier-2',
        costBasis: 'estimated',
        requests: 1,
      },
    },
    'sources-not-cited': {
      source: SOURCE,
      profile: 'results',
      responses: [{ json: fakeCompleteBody({ citations: [{ url: 'https://ignored.example/', marker: 1 }], cost_usd: undefined, searches: undefined }) }],
      expect: {
        outcome: 'complete',
        citedDomains: [],
        relationships: { 'search-result': 1 },
        retrievalStatus: 'used',
        costBasis: 'unknown',
      },
    },
    'empty-sources': {
      source: SOURCE,
      profile: 'cited',
      responses: [{ json: fakeCompleteBody({ citations: [], results: [], searches: [] }) }],
      expect: { outcome: 'complete', citedDomains: [], relationships: {}, retrievalStatus: 'not-used' },
    },
    partial: {
      source: SOURCE,
      profile: 'cited',
      responses: [{ json: fakeCompleteBody({ status: 'incomplete', finish_reason: 'max_output_tokens' }) }],
      expect: { outcome: 'partial' },
    },
    pending: {
      source: SOURCE,
      profile: 'cited',
      responses: [{ json: { id: 'fake-job-7', status: 'queued' } }],
      expect: { outcome: 'pending' },
    },
    failed: {
      source: SOURCE,
      profile: 'cited',
      responses: [{ json: { id: 'fake-req-9', status: 'failed', error: { message: 'search backend unavailable' } } }],
      expect: { outcome: 'failed' },
    },
    'unknown-model': {
      source: SOURCE,
      profile: 'cited',
      responses: [{ json: fakeCompleteBody({ model: undefined }) }],
      expect: { outcome: 'complete', disclosedModel: null },
    },
    'long-query': {
      source: SOURCE,
      profile: 'cited',
      query: 'x'.repeat(201),
      responses: [{ json: fakeCompleteBody() }],
      expect: { outcome: 'refused-before-request', requests: 0 },
    },
    'unsupported-location': {
      source: SOURCE,
      // A country-only profile offered a country outside the fake service's accepted list.
      profile: 'cited',
      location: { ...SAMPLE_LOCATION, label: 'Dublin', city: 'Dublin', region: 'Leinster', country: 'IE' },
      responses: [{ json: fakeCompleteBody() }],
      expect: { outcome: 'complete', locationStatus: 'ignored', sentLocation: null },
    },
    'http-401': {
      source: SOURCE,
      profile: 'cited',
      responses: [{ status: 401, json: { error: { message: 'bad key' } } }],
      expect: { outcome: 'http-error', httpStatus: 401, requests: 1 },
    },
    'http-403': {
      source: SOURCE,
      profile: 'cited',
      responses: [{ status: 403, json: { error: { message: 'not allowed' } } }],
      expect: { outcome: 'http-error', httpStatus: 403, requests: 1 },
    },
    'http-429': {
      source: SOURCE,
      profile: 'cited',
      responses: [{ status: 429, headers: { 'retry-after': '0' }, json: { error: { message: 'slow down' } } }, { json: fakeCompleteBody() }],
      expect: { outcome: 'complete', requests: 2 },
    },
    'http-5xx': {
      source: SOURCE,
      profile: 'cited',
      responses: [{ status: 500, json: { error: { message: 'internal' } } }],
      expect: { outcome: 'http-error', httpStatus: 500, requests: 1 },
    },
  },
  notApplicable: {},
}
