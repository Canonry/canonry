import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import {
  FAILURE_STREAK_SAMPLE_AFTER,
  FAILURE_STREAK_SAMPLE_RATE,
  buildProviderOutcomeProps,
  buildRunCompletedProps,
  buildSiteAuditCompletedProps,
  describeRunFailure,
  failureStreakSampling,
  runFailureSite,
  extractRegistrableHost,
  hashDomain,
} from '../src/run-telemetry.js'

describe('extractRegistrableHost', () => {
  it('returns null for empty/whitespace input', () => {
    expect(extractRegistrableHost(null)).toBe(null)
    expect(extractRegistrableHost(undefined)).toBe(null)
    expect(extractRegistrableHost('')).toBe(null)
    expect(extractRegistrableHost('   ')).toBe(null)
  })

  it('strips protocol, port, path, and query', () => {
    expect(extractRegistrableHost('https://example.com:8080/blog/foo?bar=1')).toBe('example.com')
    expect(extractRegistrableHost('http://example.com')).toBe('example.com')
  })

  it('strips a leading www.', () => {
    expect(extractRegistrableHost('https://www.example.com')).toBe('example.com')
    expect(extractRegistrableHost('www.example.com')).toBe('example.com')
  })

  it('lowercases the host', () => {
    expect(extractRegistrableHost('HTTPS://EXAMPLE.COM')).toBe('example.com')
  })

  it('accepts bare hostnames without a scheme', () => {
    expect(extractRegistrableHost('example.com')).toBe('example.com')
    expect(extractRegistrableHost('shop.example.co.uk')).toBe('shop.example.co.uk')
  })

  it('returns null for inputs that cannot be parsed as a host', () => {
    // Plain words have no dot and so don't qualify as a host for ICP buckets.
    expect(extractRegistrableHost('localhost')).toBe(null)
    // Single-component host without a dot — discarded.
    expect(extractRegistrableHost('foo')).toBe(null)
  })
})

describe('hashDomain', () => {
  it('hashes example.com to a known SHA-256 of "example.com"', () => {
    // Pre-computed: SHA256("example.com") = a379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947
    expect(hashDomain('example.com')).toBe('a379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947')
  })

  it('produces the same hash for equivalent domains regardless of casing/scheme/www', () => {
    const expected = hashDomain('example.com')
    expect(hashDomain('EXAMPLE.COM')).toBe(expected)
    expect(hashDomain('https://www.example.com')).toBe(expected)
    expect(hashDomain('http://example.com:443/page')).toBe(expected)
  })

  it('produces different hashes for different registrable hosts', () => {
    expect(hashDomain('example.com')).not.toBe(hashDomain('example.org'))
    expect(hashDomain('shop.example.com')).not.toBe(hashDomain('example.com'))
  })

  it('returns null when the input cannot be parsed as a host', () => {
    expect(hashDomain(null)).toBe(null)
    expect(hashDomain('')).toBe(null)
    expect(hashDomain('localhost')).toBe(null)
  })

  it('matches a manual SHA-256 of the normalized host', () => {
    const host = 'shop.example.co.uk'
    const expected = crypto.createHash('sha256').update(host).digest('hex')
    expect(hashDomain(host)).toBe(expected)
  })
})

describe('buildRunCompletedProps', () => {
  const baseInput = {
    status: 'completed' as const,
    providerCount: 2,
    providers: ['openai', 'gemini'],
    queryCount: 5,
    startTime: Date.now() - 1000,
  }

  it('always emits the core run shape', () => {
    const props = buildRunCompletedProps(baseInput)
    expect(props.status).toBe('completed')
    expect(props.providerCount).toBe(2)
    expect(props.providers).toEqual(['openai', 'gemini'])
    expect(props.queryCount).toBe(5)
    expect(typeof props.durationMs).toBe('number')
    expect(props.durationMs).toBeGreaterThan(0)
  })

  it('omits trigger/domainHash/phases/location when not provided', () => {
    const props = buildRunCompletedProps(baseInput)
    expect(props.trigger).toBe(undefined)
    expect(props.domainHash).toBe(undefined)
    expect(props.phases).toBe(undefined)
    expect(props.location).toBe(undefined)
  })

  it('plumbs trigger and location through unchanged', () => {
    const props = buildRunCompletedProps({
      ...baseInput,
      trigger: 'scheduled',
      location: 'New York, NY',
    })
    expect(props.trigger).toBe('scheduled')
    expect(props.location).toBe('New York, NY')
  })

  it('hashes a canonical domain to a stable SHA-256 hex string', () => {
    // Each call should produce the same hash for the same input.
    const a = buildRunCompletedProps({ ...baseInput, canonicalDomain: 'example.com' })
    const b = buildRunCompletedProps({ ...baseInput, canonicalDomain: 'EXAMPLE.com' })
    const c = buildRunCompletedProps({ ...baseInput, canonicalDomain: 'https://www.example.com/path' })
    expect(a.domainHash).toBe('a379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947')
    expect(b.domainHash).toBe(a.domainHash)
    expect(c.domainHash).toBe(a.domainHash)
  })

  it('omits domainHash when canonical domain is null/undefined/empty', () => {
    expect(buildRunCompletedProps({ ...baseInput, canonicalDomain: null }).domainHash).toBe(undefined)
    expect(buildRunCompletedProps({ ...baseInput, canonicalDomain: undefined }).domainHash).toBe(undefined)
    expect(buildRunCompletedProps({ ...baseInput, canonicalDomain: '' }).domainHash).toBe(undefined)
  })

  it('uses phases.total_ms when phases are provided rather than recomputing', () => {
    const phases = { setup_ms: 12, provider_call_ms: 28000, total_ms: 28100 }
    const props = buildRunCompletedProps({ ...baseInput, phases })
    expect(props.phases).toEqual(phases)
    expect(props.durationMs).toBe(28100)
  })
})

describe('buildSiteAuditCompletedProps', () => {
  const crawl = {
    complete: true,
    termination: null,
    pagesDiscovered: 40,
    pagesFetched: 38,
    pagesAudited: 35,
    pagesErrored: 3,
    aggregateScore: 72,
    pageBudget: 1000,
    checkDeadLinks: false,
    deadLinksFound: 0,
  }

  it('reports status, duration, and identity only when no crawl summary exists', () => {
    const props = buildSiteAuditCompletedProps({
      status: 'failed',
      startTime: Date.now() - 5_000,
      trigger: 'scheduled',
      canonicalDomain: 'https://www.example.com/',
    })
    expect(Object.keys(props).sort()).toEqual(['domainHash', 'durationMs', 'status', 'trigger'])
    expect(props.domainHash).toBe('a379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947')
    expect(props.durationMs).toBeGreaterThanOrEqual(5_000)
  })

  it('carries the crawl counts and score of a published crawl', () => {
    const props = buildSiteAuditCompletedProps({ status: 'completed', startTime: Date.now(), crawl })
    expect(props).toMatchObject({
      complete: true,
      pagesDiscovered: 40,
      pagesFetched: 38,
      pagesAudited: 35,
      pagesErrored: 3,
      aggregateScore: 72,
      pageBudget: 1000,
      checkDeadLinks: false,
    })
  })

  // The collector's property schema has no null: one null value rejects the
  // whole event, so every unknown is an omitted key.
  it('never emits a null, and omits values that were not measured', () => {
    const props = buildSiteAuditCompletedProps({
      status: 'partial',
      startTime: Date.now(),
      trigger: null,
      canonicalDomain: null,
      crawl: { ...crawl, complete: false, termination: null, aggregateScore: null },
    })
    expect(Object.values(props)).not.toContain(null)
    expect(Object.values(props)).not.toContain(undefined)
    for (const key of ['trigger', 'domainHash', 'termination', 'aggregateScore', 'deadLinksFound']) {
      expect(props).not.toHaveProperty(key)
    }
  })

  it('does not report a score for a crawl that audited no page', () => {
    const props = buildSiteAuditCompletedProps({
      status: 'partial',
      startTime: Date.now(),
      crawl: { ...crawl, pagesAudited: 0, aggregateScore: 0 },
    })
    expect(props.pagesAudited).toBe(0)
    expect(props).not.toHaveProperty('aggregateScore')
  })

  it('reports dead links found only when the crawl checked them', () => {
    const checked = buildSiteAuditCompletedProps({
      status: 'completed',
      startTime: Date.now(),
      crawl: { ...crawl, termination: 'max-pages', checkDeadLinks: true, deadLinksFound: 4 },
    })
    expect(checked).toMatchObject({ termination: 'max-pages', checkDeadLinks: true, deadLinksFound: 4 })
  })
})

describe('buildProviderOutcomeProps', () => {
  it('sends nothing when every provider succeeded', () => {
    expect(buildProviderOutcomeProps(['gemini', 'openai'], new Map())).toEqual({})
  })

  it('reports which provider failed and why, alongside the ones that did not', () => {
    const props = buildProviderOutcomeProps(['gemini', 'openai', 'claude'], new Map([
      ['openai', '[provider-openai] 401 Incorrect API key provided'],
      ['claude', '[provider-claude] 529 {"type":"error","error":{"type":"overloaded_error"}}'],
    ]))
    expect(props).toEqual({
      providerOutcomes: { gemini: 'ok', openai: 'PROVIDER_AUTH', claude: 'PROVIDER_UNAVAILABLE' },
      providerHttpStatus: { openai: 401, claude: 529 },
    })
  })

  it('omits providerHttpStatus when no failure carried a status', () => {
    expect(buildProviderOutcomeProps(['gemini'], new Map([['gemini', 'fetch failed']]))).toEqual({
      providerOutcomes: { gemini: 'NETWORK' },
    })
  })

  it('stays within the collector limit of 12 nested keys', () => {
    const providers = Array.from({ length: 15 }, (_, i) => `p${i}`)
    const props = buildProviderOutcomeProps(providers, new Map([['p0', 'boom']]))
    expect(Object.keys(props.providerOutcomes!)).toHaveLength(12)
  })
})

describe('describeRunFailure', () => {
  it('sends the class name and system code, never the message', () => {
    const err = Object.assign(new TypeError('secret path /Users/me/x'), { code: 'SQLITE_BUSY' })
    const props = describeRunFailure(err, 'provider_call')
    expect(props).toEqual({ errorName: 'TypeError', errorSysCode: 'SQLITE_BUSY', errorSite: 'provider_call' })
    expect(JSON.stringify(props)).not.toContain('secret')
  })

  it('drops values that do not look like identifiers', () => {
    const err = Object.assign(new Error('x'), { code: 'not a code' })
    err.name = 'has spaces in it'
    expect(describeRunFailure(err)).toEqual({})
  })

  it('describes a non-Error throw by its type', () => {
    expect(describeRunFailure('boom', 'setup')).toEqual({ errorName: 'string', errorSite: 'setup' })
  })
})

describe('runFailureSite', () => {
  it('places the failure by which provider phase had started and ended', () => {
    expect(runFailureSite(undefined, undefined)).toBe('setup')
    expect(runFailureSite(1, undefined)).toBe('provider_call')
    expect(runFailureSite(1, 2)).toBe('finalize')
  })
})

describe('failureStreakSampling', () => {
  it('always reports a success, without streak fields', () => {
    expect(failureStreakSampling('completed', 40, 'run-1')).toEqual({ report: true, props: {} })
  })

  it('reports every failure early in a streak, stamped with the streak', () => {
    for (let streak = 0; streak < FAILURE_STREAK_SAMPLE_AFTER; streak++) {
      expect(failureStreakSampling('failed', streak, `run-${streak}`)).toEqual({ report: true, props: { failureStreak: streak } })
    }
  })

  it('samples a long streak at a stable 1-in-N, stamped so it can be weighted back up', () => {
    const decisions = Array.from({ length: 2000 }, (_, i) => failureStreakSampling('partial', 30, `run-${i}`))
    for (const d of decisions) expect(d.props).toEqual({ failureStreak: 30, sampleRate: FAILURE_STREAK_SAMPLE_RATE })
    const reported = decisions.filter(d => d.report).length
    expect(reported).toBeGreaterThan(2000 / FAILURE_STREAK_SAMPLE_RATE / 2)
    expect(reported).toBeLessThan(2000 / FAILURE_STREAK_SAMPLE_RATE * 2)
    // Same run id, same answer: a retried emission cannot double-count.
    expect(failureStreakSampling('failed', 30, 'run-7').report).toBe(decisions[7]!.report)
  })
})
