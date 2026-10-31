import { describe, expect, it } from 'vitest'
import {
  ANSWER_SOURCE_EXCERPT_MAX_CHARS,
  ANSWER_SOURCE_MAX_EXCERPTS,
  answerCostBasisLabel,
  answerEvidenceSchema,
  answerSourceSchema,
  citationBasisFor,
  clampAnswerSourceExcerpts,
  finalizeLocationTreatment,
  hasDirectCitedUrls,
  citationEligibleSources,
  deriveCitedDomains,
  deriveRetrievalStatus,
  groundingSourcesFromEvidence,
  resolveLocationTreatment,
  unknownUsageObservation,
  usageObservationSchema,
  usdToMicros,
  type AnswerSource,
} from '../src/answer-evidence.js'

function source(url: string, relationship: AnswerSource['relationship'], title: string | null = null): AnswerSource {
  return { url, title, relationship, rank: null, publishedAt: null, upstreamId: null }
}

const LOCATION = { label: 'Springfield', city: 'Springfield', region: 'Illinois', country: 'US' }

describe('citation evidence', () => {
  const sources = [
    source('https://www.alpha.example/a', 'explicit-citation', 'Alpha'),
    source('https://blog.alpha.example/b', 'answer-support'),
    source('https://www.alpha.example/a', 'explicit-citation'),
    source('https://results.example/list', 'search-result'),
    source('https://read.example/page', 'page-read'),
    source('ftp://files.example/x', 'explicit-citation'),
    source('not a url', 'answer-support'),
  ]

  it('derives cited domains from citation-eligible sources only, deduped in first-seen order', () => {
    // Search results and page reads are evidence, never citations; invalid URLs drop out.
    expect(deriveCitedDomains(sources)).toEqual(['alpha.example'])
    expect(citationEligibleSources(sources).map(item => item.url)).toEqual(['https://www.alpha.example/a', 'https://blog.alpha.example/b'])
  })

  it('builds legacy grounding sources from the same eligible set, titling untitled ones by host', () => {
    expect(groundingSourcesFromEvidence(sources)).toEqual([
      { uri: 'https://www.alpha.example/a', title: 'Alpha' },
      { uri: 'https://blog.alpha.example/b', title: 'blog.alpha.example' },
    ])
  })

  it('names the citation basis a set of relationships supports', () => {
    expect(citationBasisFor(['explicit-citation', 'search-result'])).toBe('explicit-citation')
    expect(citationBasisFor(['answer-support'])).toBe('answer-support')
    expect(citationBasisFor(['answer-support', 'explicit-citation'])).toBe('mixed')
    expect(citationBasisFor(['search-result', 'page-read'])).toBe('none')
  })
})

describe('retrieval status', () => {
  const complete = { status: 'complete' as const }
  it('is used on any source, search event or reported search', () => {
    expect(deriveRetrievalStatus({ sources: [source('https://a.example', 'search-result')], searchEventCount: 0, reportedSearchCount: null, observability: 'none', completion: complete })).toBe('used')
    expect(deriveRetrievalStatus({ sources: [], searchEventCount: 1, reportedSearchCount: null, observability: 'sources', completion: complete })).toBe('used')
    expect(deriveRetrievalStatus({ sources: [], searchEventCount: 0, reportedSearchCount: 2, observability: 'sources', completion: complete })).toBe('used')
  })

  it('is not-used only for a complete response from a service that reports searches as events', () => {
    expect(deriveRetrievalStatus({ sources: [], searchEventCount: 0, reportedSearchCount: null, observability: 'events', completion: complete })).toBe('not-used')
  })

  it.each([
    ['sources', 'complete'],
    ['none', 'complete'],
    ['events', 'partial'],
    ['events', 'failed'],
  ] as const)('stays unknown, never not-used, for observability %s and completion %s', (observability, status) => {
    expect(deriveRetrievalStatus({ sources: [], searchEventCount: 0, reportedSearchCount: 0, observability, completion: { status } })).toBe('unknown')
  })
})

describe('location treatment', () => {
  it('records what each granularity sends and whether every requested field arrived', () => {
    expect(resolveLocationTreatment(LOCATION, { granularity: 'full', strength: 'hint' })).toEqual({
      requested: LOCATION, sent: { country: 'US', region: 'Illinois', city: 'Springfield' }, strength: 'hint', serviceDefault: null, status: 'applied',
    })
    expect(resolveLocationTreatment(LOCATION, { granularity: 'country', strength: 'hint' })).toMatchObject({ sent: { country: 'US' }, status: 'partial' })
    expect(resolveLocationTreatment(LOCATION, { granularity: 'none', strength: null })).toMatchObject({ sent: null, strength: null, status: 'ignored' })
    expect(resolveLocationTreatment(null, { granularity: 'full', strength: 'filter' }, { country: 'us' })).toEqual({
      requested: null, sent: null, strength: null, serviceDefault: { country: 'us' }, status: 'not-requested',
    })
  })
})

describe('location actually sent', () => {
  const countryOnly = resolveLocationTreatment(LOCATION, { granularity: 'country', strength: 'hint' })
  const full = resolveLocationTreatment(LOCATION, { granularity: 'full', strength: 'filter' })

  it('takes its status from the fields the request carries, not from the granularity', () => {
    expect(finalizeLocationTreatment(countryOnly, { country: 'US' })).toEqual(countryOnly)
    // A builder that drops a country its vendor cannot take: nothing reached the request.
    expect(finalizeLocationTreatment(countryOnly, null)).toEqual({ requested: LOCATION, sent: null, strength: null, serviceDefault: null, status: 'ignored' })
    expect(finalizeLocationTreatment(full, { country: 'US', region: 'Illinois', city: 'Springfield' })).toMatchObject({ status: 'applied', strength: 'filter' })
    expect(finalizeLocationTreatment(full, { region: 'Illinois', city: 'Springfield' })).toMatchObject({ status: 'partial', sent: { region: 'Illinois', city: 'Springfield' } })
    // A vendor encoding is kept as sent; blank values count as not sent.
    expect(finalizeLocationTreatment(countryOnly, { country: 'united states' })).toMatchObject({ status: 'partial', sent: { country: 'united states' } })
    expect(finalizeLocationTreatment(countryOnly, { country: ' ' })).toMatchObject({ status: 'ignored', sent: null })
  })

  it('needs every requested field, the timezone included, to be applied', () => {
    const withZone = resolveLocationTreatment({ ...LOCATION, timezone: 'America/Chicago' }, { granularity: 'full', strength: 'hint' })
    expect(finalizeLocationTreatment(withZone, { country: 'US', region: 'Illinois', city: 'Springfield' }).status).toBe('partial')
    expect(finalizeLocationTreatment(withZone, { country: 'US', region: 'Illinois', city: 'Springfield', timezone: 'America/Chicago' }).status).toBe('applied')
  })

  it('refuses a field the profile does not offer and a location nobody requested', () => {
    expect(() => finalizeLocationTreatment(countryOnly, { country: 'US', city: 'Springfield' })).toThrow('does not offer: city')
    const none = resolveLocationTreatment(null, { granularity: 'full', strength: 'hint' })
    expect(finalizeLocationTreatment(none, null)).toEqual(none)
    expect(() => finalizeLocationTreatment(none, { country: 'US' })).toThrow('none was requested')
  })
})

describe('source excerpts', () => {
  it('keeps passages as separate items and rejects a joined or oversized excerpt list', () => {
    const base = source('https://a.example/x', 'explicit-citation')
    expect(answerSourceSchema.parse({ ...base, excerpts: ['passage one', 'passage two'] }).excerpts).toEqual(['passage one', 'passage two'])
    expect(answerSourceSchema.safeParse({ ...base, excerpts: ['x'.repeat(ANSWER_SOURCE_EXCERPT_MAX_CHARS + 1)] }).success).toBe(false)
    expect(answerSourceSchema.safeParse({ ...base, excerpts: Array.from({ length: ANSWER_SOURCE_MAX_EXCERPTS + 1 }, () => 'x') }).success).toBe(false)
  })

  it('clamps count and length, marks only the sources it changed, and never splits a surrogate pair', () => {
    const base = source('https://a.example/x', 'explicit-citation')
    const pair = '\u{1F600}'
    const straddling = `${'a'.repeat(ANSWER_SOURCE_EXCERPT_MAX_CHARS - 1)}${pair}`
    const [clamped, untouched, bare] = clampAnswerSourceExcerpts([
      { ...base, excerpts: [straddling, ...Array.from({ length: ANSWER_SOURCE_MAX_EXCERPTS }, (_, index) => `p${index}`)] },
      { ...base, excerpts: ['kept'] },
      base,
    ])
    expect(clamped!.excerpts).toHaveLength(ANSWER_SOURCE_MAX_EXCERPTS)
    expect(clamped!.excerpts![0]).toBe('a'.repeat(ANSWER_SOURCE_EXCERPT_MAX_CHARS - 1))
    expect(clamped!.excerpts![1]).toBe('p0')
    expect(clamped!.excerptsTruncated).toBe(true)
    expect(answerSourceSchema.safeParse(clamped).success).toBe(true)
    expect(untouched).toEqual({ ...base, excerpts: ['kept'] })
    expect(bare).toBe(base)
  })
})

describe('direct source URLs', () => {
  it('stores cited page URLs only when citations are measurable and the URLs are the pages themselves', () => {
    expect(hasDirectCitedUrls({ citationMeasurable: true, directSourceUrls: true })).toBe(true)
    expect(hasDirectCitedUrls({ citationMeasurable: true, directSourceUrls: false })).toBe(false)
    expect(hasDirectCitedUrls({ citationMeasurable: false, directSourceUrls: true })).toBe(false)
  })
})

describe('usage and cost basis', () => {
  it('labels a cost by its basis and, for an estimate, by who made it', () => {
    expect(answerCostBasisLabel({ basis: 'reported', estimatedBy: null })).toBe('Reported by the service')
    expect(answerCostBasisLabel({ basis: 'estimated', estimatedBy: 'provider' })).toBe('Estimated by the service')
    expect(answerCostBasisLabel({ basis: 'estimated', estimatedBy: 'canonry' })).toBe('Estimated by Canonry')
    expect(answerCostBasisLabel({ basis: 'unknown', estimatedBy: null })).toBe('Not reported')
  })

  it('keeps unknown counts and cost null, never zero', () => {
    const usage = unknownUsageObservation()
    expect(usage.cost).toEqual({ micros: null, currency: 'USD', basis: 'unknown', estimatedBy: null })
    expect(usage.tokens).toEqual({ input: null, output: null, reasoning: null, basis: 'unknown' })
    expect(usageObservationSchema.safeParse(usage).success).toBe(true)
  })

  it('rejects a zero cost labelled unknown and an estimate with no estimator', () => {
    const usage = unknownUsageObservation()
    expect(usageObservationSchema.safeParse({ ...usage, cost: { ...usage.cost, micros: 0 } }).success).toBe(false)
    expect(usageObservationSchema.safeParse({ ...usage, cost: { micros: 4500, currency: 'USD', basis: 'estimated', estimatedBy: null } }).success).toBe(false)
    expect(usageObservationSchema.safeParse({ ...usage, searches: { count: 0, basis: 'unknown' } }).success).toBe(false)
  })

  it('converts a reported USD amount to integer micros', () => {
    expect(usdToMicros(0.0045)).toBe(4500)
    expect(usdToMicros(0)).toBe(0)
    expect([usdToMicros(-1), usdToMicros('0.1'), usdToMicros(Number.NaN), usdToMicros(undefined)]).toEqual([null, null, null, null])
  })
})

describe('answer evidence envelope', () => {
  const evidence = {
    version: 1,
    identity: { connection: 'acme', route: 'acme:fast', service: 'acme', product: 'answer', profile: 'fast', settings: { depth: 'basic' }, requestedServiceModel: 'tier-1', disclosedModel: null, disclosedModelKind: null, requestPolicy: 'v1', parserVersion: 'p1' },
    completion: { status: 'pending', finishReason: null, upstreamStatus: 'queued', upstreamRequestId: 'r1', upstreamJobId: 'job-1', error: null },
    usage: unknownUsageObservation(),
    sources: [],
    searchQueries: [],
    retrievalStatus: 'unknown',
    citationBasis: 'explicit-citation',
    citationMeasurable: true,
    directSourceUrls: true,
    location: resolveLocationTreatment(null, { granularity: 'none', strength: null }),
    rawTruncated: false,
  }

  it('accepts a pending completion that keeps its upstream job id', () => {
    expect(answerEvidenceSchema.parse(evidence).completion.upstreamJobId).toBe('job-1')
  })

  it('rejects a pending completion without a job id and a measurability that contradicts the basis', () => {
    expect(answerEvidenceSchema.safeParse({ ...evidence, completion: { ...evidence.completion, upstreamJobId: null } }).success).toBe(false)
    expect(answerEvidenceSchema.safeParse({ ...evidence, citationBasis: 'none' }).success).toBe(false)
  })
})
