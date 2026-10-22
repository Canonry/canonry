/**
 * The shared conformance matrix every answer service runs. A vendor supplies
 * documentation-derived fixtures (one per case) and never test logic; the
 * assertions below are the same for every service.
 */
import type { CostBasis, LocationContext, LocationTreatmentStatus, RetrievalStatus, SentLocation, SourceRelationship } from '@canonry/canonry-contracts'

/** Every case a service must cover, or declare not applicable with a reason. */
export const CONFORMANCE_CASES = [
  'explicit-citations',
  'sources-not-cited',
  'empty-sources',
  'partial',
  'pending',
  'failed',
  'unknown-model',
  'long-query',
  'unsupported-location',
  'http-401',
  'http-403',
  'http-429',
  'http-5xx',
] as const
export type ConformanceCaseKind = (typeof CONFORMANCE_CASES)[number]

export interface ConformanceResponse {
  status?: number
  headers?: Record<string, string>
  /** A JSON body exactly as the vendor documents it, including fields the parser ignores. */
  json?: unknown
  /** A complete SSE body for streamed profiles. */
  sse?: string
}

export interface ConformanceExpectation {
  outcome: 'complete' | 'partial' | 'failed' | 'pending' | 'http-error' | 'refused-before-request'
  answerText?: string
  citedDomains?: string[]
  /** Exact number of sources per relationship. */
  relationships?: Partial<Record<SourceRelationship, number>>
  retrievalStatus?: RetrievalStatus
  disclosedModel?: string | null
  costBasis?: CostBasis
  locationStatus?: LocationTreatmentStatus
  /** The location the request carried, as the builder reported it (null: none). */
  sentLocation?: SentLocation | null
  httpStatus?: number
  /** Requests sent, retries included. */
  requests?: number
}

export interface ConformanceCase {
  /** Where the fixture's shape comes from; must say whether it is documentation-derived. */
  source: string
  profile: string
  query?: string
  location?: LocationContext
  /** Responses in order; the last repeats. */
  responses: ConformanceResponse[]
  expect: ConformanceExpectation
}

export interface ConformanceFixtures {
  service: string
  cases: Partial<Record<ConformanceCaseKind, ConformanceCase>>
  /** Cases that cannot happen for this service, each with the documented reason. */
  notApplicable: Partial<Record<ConformanceCaseKind, string>>
}

export const SAMPLE_LOCATION: LocationContext = { label: 'Springfield', city: 'Springfield', region: 'Illinois', country: 'US' }
