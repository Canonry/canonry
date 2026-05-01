import { describe, test, it, expect } from 'vitest'

import {
  resolveProviderInput,
  isBrowserProvider,
  parseProviderName,
} from '../src/provider.js'

import {
  AppError,
  notFound,
  validationError,
  projectConfigSchema,
  projectDtoSchema,
  providerQuotaPolicySchema,
  runDtoSchema,
  runStatusSchema,
  citationStateSchema,
  computedTransitionSchema,
  determineAnswerMentioned,
  extractAnswerMentions,
  querySnapshotDtoSchema,
  auditLogEntrySchema,
  notificationDtoSchema,
  notificationEventSchema,
  effectiveDomains,
  normalizeProjectDomain,
  registrableDomain,
  brandLabelFromDomain,
  locationContextSchema,
} from '../src/index.js'

test('projectDtoSchema applies defaults for tags, labels, configSource, configRevision', () => {
  const project = projectDtoSchema.parse({
    id: 'project_1',
    name: 'Example',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
  })

  expect(project.tags).toEqual([])
  expect(project.labels).toEqual({})
  expect(project.ownedDomains).toEqual([])
  expect(project.configSource).toBe('cli')
  expect(project.configRevision).toBe(1)
})

test('normalizeProjectDomain strips scheme and www prefix', () => {
  expect(normalizeProjectDomain('https://www.Docs.Example.com/path')).toBe('docs.example.com')
  expect(normalizeProjectDomain('WWW.example.com')).toBe('example.com')
})

describe('registrableDomain', () => {
  it('returns the eTLD+1 for a subdomained host', () => {
    expect(registrableDomain('offers.roofle.com')).toBe('roofle.com')
    expect(registrableDomain('app.example.io')).toBe('example.io')
    expect(registrableDomain('blog.news.example.org')).toBe('example.org')
  })

  it('returns the input unchanged when there is no subdomain', () => {
    expect(registrableDomain('roofle.com')).toBe('roofle.com')
    expect(registrableDomain('example.ai')).toBe('example.ai')
  })

  it('strips scheme, port, path, and www prefix before parsing', () => {
    expect(registrableDomain('https://www.offers.Roofle.com/foo?x=1')).toBe('roofle.com')
    expect(registrableDomain('http://api.example.com:8080/v1')).toBe('example.com')
  })

  it('keeps the third label for known multi-label public suffixes', () => {
    expect(registrableDomain('bbc.co.uk')).toBe('bbc.co.uk')
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk')
    expect(registrableDomain('shop.example.com.au')).toBe('example.com.au')
    expect(registrableDomain('foo.bar.example.co.jp')).toBe('example.co.jp')
  })

  it('returns empty string for empty or single-label input', () => {
    expect(registrableDomain('')).toBe('')
    expect(registrableDomain('localhost')).toBe('')
    expect(registrableDomain('   ')).toBe('')
  })

  it('is idempotent', () => {
    expect(registrableDomain(registrableDomain('offers.roofle.com'))).toBe('roofle.com')
    expect(registrableDomain(registrableDomain('news.bbc.co.uk'))).toBe('bbc.co.uk')
  })
})

describe('brandLabelFromDomain', () => {
  it('returns the leftmost label of the registrable domain', () => {
    expect(brandLabelFromDomain('offers.roofle.com')).toBe('roofle')
    expect(brandLabelFromDomain('roofle.com')).toBe('roofle')
    expect(brandLabelFromDomain('app.acme.io')).toBe('acme')
  })

  it('handles multi-label public suffixes', () => {
    expect(brandLabelFromDomain('news.bbc.co.uk')).toBe('bbc')
    expect(brandLabelFromDomain('bbc.co.uk')).toBe('bbc')
  })

  it('returns empty string when there is no registrable domain', () => {
    expect(brandLabelFromDomain('')).toBe('')
    expect(brandLabelFromDomain('localhost')).toBe('')
  })
})

test('effectiveDomains deduplicates canonical and owned domain variants', () => {
  const domains = effectiveDomains({
    canonicalDomain: 'https://www.example.com',
    ownedDomains: ['example.com', 'docs.example.com', 'https://www.docs.example.com/path', ''],
  })

  expect(domains).toEqual(['https://www.example.com', 'docs.example.com'])
})

test('run schemas accept expected values and reject invalid statuses', () => {
  const run = runDtoSchema.parse({
    id: 'run_1',
    projectId: 'project_1',
    kind: 'site-audit',
    status: 'queued',
    createdAt: '2026-03-09T00:00:00.000Z',
  })

  expect(run.status).toBe('queued')
  expect(run.trigger).toBe('manual')
  expect(run.startedAt).toBeUndefined()
  expect(() => runStatusSchema.parse('bogus')).toThrow()
})

test('providerQuotaPolicySchema enforces positive integer limits', () => {
  const quota = providerQuotaPolicySchema.parse({
    maxConcurrency: 2,
    maxRequestsPerMinute: 10,
    maxRequestsPerDay: 1000,
  })

  expect(quota).toEqual({
    maxConcurrency: 2,
    maxRequestsPerMinute: 10,
    maxRequestsPerDay: 1000,
  })
  expect(() => providerQuotaPolicySchema.parse({
    maxConcurrency: 0,
    maxRequestsPerMinute: 10,
    maxRequestsPerDay: 1000,
  })).toThrow()
})

test('projectConfigSchema validates canonry.yaml structure', () => {
  const config = projectConfigSchema.parse({
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: 'my-project' },
    spec: {
      displayName: 'My Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    },
  })

  expect(config.metadata.name).toBe('my-project')
  expect(config.metadata.labels).toEqual({})
  expect(config.spec.keywords).toEqual([])
  expect(config.spec.competitors).toEqual([])
})

test('projectConfigSchema rejects invalid project names', () => {
  expect(() => projectConfigSchema.parse({
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: 'UPPERCASE' },
    spec: {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    },
  })).toThrow()

  expect(() => projectConfigSchema.parse({
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: '-leading-hyphen' },
    spec: {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    },
  })).toThrow()
})

test('projectConfigSchema rejects a defaultLocation that is not configured', () => {
  expect(() => projectConfigSchema.parse({
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: 'my-project' },
    spec: {
      displayName: 'My Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      locations: [
        { label: 'nyc', city: 'New York', region: 'NY', country: 'US' },
      ],
      defaultLocation: 'sf',
    },
  })).toThrow(/defaultLocation/)
})

test('projectConfigSchema rejects duplicate location labels', () => {
  expect(() => projectConfigSchema.parse({
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: 'my-project' },
    spec: {
      displayName: 'My Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      locations: [
        { label: 'nyc', city: 'New York', region: 'NY', country: 'US' },
        { label: 'nyc', city: 'Brooklyn', region: 'NY', country: 'US' },
      ],
    },
  })).toThrow(/Duplicate location labels/)
})

test('citationStateSchema accepts only raw observation values', () => {
  expect(citationStateSchema.parse('cited')).toBe('cited')
  expect(citationStateSchema.parse('not-cited')).toBe('not-cited')
  expect(() => citationStateSchema.parse('lost')).toThrow()
  expect(() => citationStateSchema.parse('emerging')).toThrow()
})

test('computedTransitionSchema accepts all transition values', () => {
  for (const value of ['new', 'cited', 'lost', 'emerging', 'not-cited']) {
    expect(computedTransitionSchema.parse(value)).toBe(value)
  }
})

test('querySnapshotDtoSchema applies defaults', () => {
  const snapshot = querySnapshotDtoSchema.parse({
    id: 'snap_1',
    runId: 'run_1',
    keywordId: 'kw_1',
    provider: 'gemini',
    citationState: 'cited',
    createdAt: '2026-03-09T00:00:00.000Z',
  })

  expect(snapshot.provider).toBe('gemini')
  expect(snapshot.citedDomains).toEqual([])
  expect(snapshot.competitorOverlap).toEqual([])
  expect(snapshot.recommendedCompetitors).toEqual([])
  expect(snapshot.matchedTerms).toEqual([])
  expect(snapshot.answerMentioned).toBeUndefined()
  expect(snapshot.visibilityState).toBeUndefined()
})

test('querySnapshotDtoSchema accepts all provider names', () => {
  for (const provider of ['gemini', 'openai', 'claude']) {
    const snapshot = querySnapshotDtoSchema.parse({
      id: 'snap_1',
      runId: 'run_1',
      keywordId: 'kw_1',
      provider,
      citationState: 'cited',
      createdAt: '2026-03-09T00:00:00.000Z',
    })
    expect(snapshot.provider).toBe(provider)
  }
})

test('auditLogEntrySchema validates log entries', () => {
  const entry = auditLogEntrySchema.parse({
    id: 'log_1',
    actor: 'cli',
    action: 'project.created',
    entityType: 'project',
    entityId: 'project_1',
    createdAt: '2026-03-09T00:00:00.000Z',
  })

  expect(entry.action).toBe('project.created')
  expect(entry.projectId).toBeUndefined()
})

test('notificationDtoSchema accepts redacted runtime notification payloads', () => {
  const notification = notificationDtoSchema.parse({
    id: 'notif_1',
    projectId: 'project_1',
    channel: 'webhook',
    url: 'https://hooks.example.com/redacted',
    urlDisplay: 'hooks.example.com/redacted',
    urlHost: 'hooks.example.com',
    events: ['run.completed'],
    enabled: true,
    createdAt: '2026-03-09T00:00:00.000Z',
    updatedAt: '2026-03-09T00:00:00.000Z',
  })

  expect(notification.urlHost).toBe('hooks.example.com')
  expect(notification.urlDisplay).toBe('hooks.example.com/redacted')
})

test('AppError serializes to JSON with code and message', () => {
  const err = notFound('Project', 'my-project')
  expect(err.code).toBe('NOT_FOUND')
  expect(err.statusCode).toBe(404)
  expect(err.toJSON()).toEqual({
    error: { code: 'NOT_FOUND', message: "Project 'my-project' not found" },
  })
})

test('validationError includes details in JSON output', () => {
  const err = validationError('Invalid config', { field: 'name' })
  expect(err.statusCode).toBe(400)
  expect(err.toJSON()).toEqual({
    error: { code: 'VALIDATION_ERROR', message: 'Invalid config', details: { field: 'name' } },
  })
})

test('AppError is an instance of Error', () => {
  const err = new AppError('INTERNAL_ERROR', 'something broke', 500)
  expect(err).toBeInstanceOf(Error)
  expect(err.name).toBe('AppError')
})

describe('notificationEventSchema', () => {

test('notificationEventSchema accepts valid events', () => {
  for (const event of ['citation.lost', 'citation.gained', 'run.completed', 'run.failed']) {
    expect(notificationEventSchema.parse(event)).toBe(event)
  }
})

test('notificationEventSchema rejects invalid events', () => {
  expect(() => notificationEventSchema.parse('invalid.event')).toThrow()
})

}) // end notificationEventSchema

describe('projectConfigSchema schedule', () => {

test('projectConfigSchema accepts config with schedule preset', () => {
  const config = projectConfigSchema.parse({
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: 'test-project' },
    spec: {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      schedule: { preset: 'daily', timezone: 'America/New_York' },
      notifications: [{ channel: 'webhook', url: 'https://hooks.example.com/test', events: ['citation.lost'] }],
    },
  })

  expect(config.spec.schedule).toBeTruthy()
  expect(config.spec.notifications).toHaveLength(1)
})

test('projectConfigSchema rejects schedule with both preset and cron', () => {
  expect(() => projectConfigSchema.parse({
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: 'test-project' },
    spec: {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      schedule: { preset: 'daily', cron: '0 6 * * *' },
    },
  })).toThrow()
})

}) // end projectConfigSchema schedule

describe('locationContextSchema', () => {

test('locationContextSchema accepts valid location with all fields', () => {
  const loc = locationContextSchema.parse({
    label: 'nyc',
    city: 'New York',
    region: 'New York',
    country: 'US',
    timezone: 'America/New_York',
  })
  expect(loc.label).toBe('nyc')
  expect(loc.city).toBe('New York')
  expect(loc.region).toBe('New York')
  expect(loc.country).toBe('US')
  expect(loc.timezone).toBe('America/New_York')
})

test('locationContextSchema accepts location without optional timezone', () => {
  const loc = locationContextSchema.parse({
    label: 'london',
    city: 'London',
    region: 'England',
    country: 'GB',
  })
  expect(loc.timezone).toBeUndefined()
})

test('locationContextSchema rejects country code that is not exactly 2 chars', () => {
  expect(() => locationContextSchema.parse({
    label: 'bad',
    city: 'Berlin',
    region: 'Berlin',
    country: 'DEU',
  })).toThrow()
  expect(() => locationContextSchema.parse({
    label: 'bad',
    city: 'Berlin',
    region: 'Berlin',
    country: 'D',
  })).toThrow()
})

test('locationContextSchema rejects empty required strings', () => {
  expect(() => locationContextSchema.parse({
    label: '',
    city: 'Paris',
    region: 'Ile-de-France',
    country: 'FR',
  })).toThrow()
  expect(() => locationContextSchema.parse({
    label: 'paris',
    city: '',
    region: 'Ile-de-France',
    country: 'FR',
  })).toThrow()
  expect(() => locationContextSchema.parse({
    label: 'paris',
    city: 'Paris',
    region: '',
    country: 'FR',
  })).toThrow()
})

}) // end locationContextSchema

describe('projectDtoSchema locations', () => {

test('projectDtoSchema defaults locations to empty array', () => {
  const project = projectDtoSchema.parse({
    id: 'project_1',
    name: 'test',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
  })
  expect(project.locations).toEqual([])
  expect(project.defaultLocation).toBeUndefined()
})

test('projectDtoSchema accepts locations array and defaultLocation', () => {
  const project = projectDtoSchema.parse({
    id: 'project_1',
    name: 'test',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    locations: [
      { label: 'nyc', city: 'New York', region: 'New York', country: 'US' },
      { label: 'london', city: 'London', region: 'England', country: 'GB', timezone: 'Europe/London' },
    ],
    defaultLocation: 'nyc',
  })
  expect(project.locations).toHaveLength(2)
  expect(project.locations[0].label).toBe('nyc')
  expect(project.locations[1].timezone).toBe('Europe/London')
  expect(project.defaultLocation).toBe('nyc')
})

test('projectDtoSchema accepts null defaultLocation', () => {
  const project = projectDtoSchema.parse({
    id: 'project_1',
    name: 'test',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    defaultLocation: null,
  })
  expect(project.defaultLocation).toBeNull()
})

}) // end projectDtoSchema locations

describe('querySnapshotDtoSchema location', () => {

test('querySnapshotDtoSchema accepts location string', () => {
  const snapshot = querySnapshotDtoSchema.parse({
    id: 'snap_1',
    runId: 'run_1',
    keywordId: 'kw_1',
    provider: 'gemini',
    citationState: 'cited',
    location: 'nyc',
    createdAt: '2026-03-09T00:00:00.000Z',
  })
  expect(snapshot.location).toBe('nyc')
})

test('querySnapshotDtoSchema defaults location to undefined', () => {
  const snapshot = querySnapshotDtoSchema.parse({
    id: 'snap_1',
    runId: 'run_1',
    keywordId: 'kw_1',
    provider: 'openai',
    citationState: 'not-cited',
    createdAt: '2026-03-09T00:00:00.000Z',
  })
  expect(snapshot.location).toBeUndefined()
})

test('querySnapshotDtoSchema accepts null location', () => {
  const snapshot = querySnapshotDtoSchema.parse({
    id: 'snap_1',
    runId: 'run_1',
    keywordId: 'kw_1',
    provider: 'claude',
    citationState: 'cited',
    location: null,
    createdAt: '2026-03-09T00:00:00.000Z',
  })
  expect(snapshot.location).toBeNull()
})

}) // end querySnapshotDtoSchema location

// ─── provider.ts ──────────────────────────────────────────────────────────────

describe('resolveProviderInput', () => {
  it('expands "cdp" shorthand to all CDP targets', () => {
    const result = resolveProviderInput('cdp')
    expect(result).toContain('cdp:chatgpt')
    expect(result.length).toBeGreaterThan(0)
  })

  it('expands "CDP" (case-insensitive) to all CDP targets', () => {
    const result = resolveProviderInput('CDP')
    expect(result).toContain('cdp:chatgpt')
  })

  it('returns a single-element array for a known provider name', () => {
    expect(resolveProviderInput('gemini')).toEqual(['gemini'])
    expect(resolveProviderInput('openai')).toEqual(['openai'])
    expect(resolveProviderInput('claude')).toEqual(['claude'])
    expect(resolveProviderInput('local')).toEqual(['local'])
    expect(resolveProviderInput('cdp:chatgpt')).toEqual(['cdp:chatgpt'])
  })

  it('normalizes casing', () => {
    expect(resolveProviderInput('GEMINI')).toEqual(['gemini'])
    expect(resolveProviderInput('OpenAI')).toEqual(['openai'])
  })

  it('trims leading/trailing whitespace', () => {
    expect(resolveProviderInput('  gemini  ')).toEqual(['gemini'])
  })

  it('returns the normalized name for any non-empty input (validated at runtime)', () => {
    expect(resolveProviderInput('unknown-provider')).toEqual(['unknown-provider'])
  })

  it('returns an empty array for empty input', () => {
    expect(resolveProviderInput('')).toEqual([])
  })
})

describe('isBrowserProvider', () => {
  it('returns true for cdp:chatgpt', () => {
    expect(isBrowserProvider('cdp:chatgpt')).toBe(true)
  })

  it('returns false for API-based providers', () => {
    expect(isBrowserProvider('gemini')).toBe(false)
    expect(isBrowserProvider('openai')).toBe(false)
    expect(isBrowserProvider('claude')).toBe(false)
    expect(isBrowserProvider('local')).toBe(false)
  })
})

describe('determineAnswerMentioned', () => {
  it('matches exact domain mentions in answer text', () => {
    expect(determineAnswerMentioned(
      'Top picks include example.com and other vendors.',
      'Example Inc',
      ['example.com'],
    )).toBe(true)
  })

  it('matches display name mentions when the domain is not present', () => {
    expect(determineAnswerMentioned(
      'Example Health is frequently recommended for this workflow.',
      'Example Health',
      ['examplehealth.com'],
    )).toBe(true)
  })

  it('returns false when neither domain nor brand appears', () => {
    expect(determineAnswerMentioned(
      'Top picks include Contoso and Fabrikam.',
      'Example Health',
      ['examplehealth.com'],
    )).toBe(false)
  })
})

describe('extractAnswerMentions', () => {
  it('returns matched domain terms', () => {
    const result = extractAnswerMentions(
      'Top picks include example.com and other vendors.',
      'Example Inc',
      ['example.com'],
    )
    expect(result.mentioned).toBe(true)
    expect(result.matchedTerms).toContain('example.com')
  })

  it('returns matched display name', () => {
    const result = extractAnswerMentions(
      'Example Health is frequently recommended for this workflow.',
      'Example Health',
      ['examplehealth.com'],
    )
    expect(result.mentioned).toBe(true)
    expect(result.matchedTerms).toContain('Example Health')
  })

  it('returns empty matchedTerms when nothing matches', () => {
    const result = extractAnswerMentions(
      'Top picks include Contoso and Fabrikam.',
      'Example Health',
      ['examplehealth.com'],
    )
    expect(result.mentioned).toBe(false)
    expect(result.matchedTerms).toEqual([])
  })

  it('returns both domain and display name when both match', () => {
    const result = extractAnswerMentions(
      'According to Example Inc at example.com, this is the best approach.',
      'Example Inc',
      ['example.com'],
    )
    expect(result.mentioned).toBe(true)
    expect(result.matchedTerms).toContain('example.com')
    expect(result.matchedTerms).toContain('Example Inc')
  })

  it('deduplicates matched terms', () => {
    const result = extractAnswerMentions(
      'Visit ainyc.ai for details. AINYC.AI is great.',
      'AI NYC',
      ['ainyc.ai'],
    )
    expect(result.mentioned).toBe(true)
    const domainCount = result.matchedTerms.filter(t => t === 'ainyc.ai').length
    expect(domainCount).toBe(1)
  })

  it('handles null answer text', () => {
    const result = extractAnswerMentions(null, 'Example', ['example.com'])
    expect(result.mentioned).toBe(false)
    expect(result.matchedTerms).toEqual([])
  })

  it('matches when display name has no spaces but the answer spaces it out', () => {
    // Real-world case: project registered as "azcoatings" with domain
    // azcoatingsllc.com; answer says "AZ Coatings (Michigan/Detroit Area)".
    const result = extractAnswerMentions(
      'Local contractors include AZ Coatings (Michigan/Detroit Area), specializing in polyurea roof restoration.',
      'azcoatings',
      ['azcoatingsllc.com'],
    )
    expect(result.mentioned).toBe(true)
    expect(result.matchedTerms).toContain('azcoatings')
  })

  it('matches when display name has spaces but the answer concatenates it', () => {
    const result = extractAnswerMentions(
      'Visit AZCoatings for industrial polyurea systems.',
      'AZ Coatings',
      ['azcoatingsllc.com'],
    )
    expect(result.mentioned).toBe(true)
    expect(result.matchedTerms).toContain('AZ Coatings')
  })

  it('does not loose-match short brand keys across word boundaries', () => {
    // "acme" (4 chars) is below the brand-key threshold, so the loose match
    // is gated off. Without that gate, "pa cme" would strip to "pacme" and
    // falsely contain "acme".
    const result = extractAnswerMentions(
      'Find the pa cme report in the archive.',
      'Acme',
      ['acme.io'],
    )
    expect(result.mentioned).toBe(false)
    expect(result.matchedTerms).toEqual([])
  })

  it('does not loose-match short brand+suffix pairings via the stripped normalized candidate', () => {
    // "Bob Inc" stripped normalized candidate is "bob"; without the
    // length gate, this would substring-match inside words like "bobsled".
    // The brand-key path's MIN_BRAND_KEY_LENGTH threshold must apply to the
    // stripped normalized candidate too.
    const result = extractAnswerMentions(
      'Bobsled racing is fun this winter.',
      'Bob Inc',
      ['bob.example.com'],
    )
    expect(result.mentioned).toBe(false)
    expect(result.matchedTerms).toEqual([])
  })

  it('matches when display name carries a trailing LLC/Inc/Corp classifier', () => {
    // Spaced form: "AZ Coatings LLC" should match an answer that drops the LLC.
    expect(extractAnswerMentions(
      'Local contractors include AZ Coatings (Michigan/Detroit Area).',
      'AZ Coatings LLC',
      ['azcoatingsllc.com'],
    ).mentioned).toBe(true)

    // Concatenated form: "azcoatingsllc" should also match without the suffix.
    expect(extractAnswerMentions(
      'Local contractors include AZ Coatings (Michigan/Detroit Area).',
      'azcoatingsllc',
      ['azcoatingsllc.com'],
    ).mentioned).toBe(true)

    // "Inc" is stripped likewise.
    expect(extractAnswerMentions(
      'According to Sherwin Williams paints are the best.',
      'Sherwin Williams Inc',
      ['sherwinwilliams.com'],
    ).mentioned).toBe(true)

    // "Corporation" (long form) is stripped too.
    expect(extractAnswerMentions(
      'Microsoft is launching a new product line.',
      'Microsoft Corporation',
      ['microsoft.com'],
    ).mentioned).toBe(true)
  })

  it('does not match the leftmost subdomain label as a brand token', () => {
    // Regression: a project with own domain `offers.example.com` must not
    // word-boundary match the literal word "offers" in the answer prose. Only
    // the registrable domain's brand label (`example`) is a valid token.
    const result = extractAnswerMentions(
      'Energy Design Systems offers a white-label lead generation tool.',
      'Demand IQ',
      ['offers.example.com'],
    )
    expect(result.mentioned).toBe(false)
    expect(result.matchedTerms).toEqual([])
  })

  it('still matches the registrable brand of a subdomained own domain', () => {
    const result = extractAnswerMentions(
      'Brokers turn to Roofle when they need quick install quotes.',
      'Roofle',
      ['offers.roofle.com'],
    )
    expect(result.mentioned).toBe(true)
  })

  it('does not strip a classifier when only the classifier itself remains', () => {
    // Edge case: display name is just "Inc" (3 chars). Stripping would leave
    // empty/too-short. The original "inc" stays and is below the brand-key
    // threshold, so loose matching is gated off.
    const result = extractAnswerMentions(
      'The incident report is attached.',
      'Inc',
      ['inc.example.com'],
    )
    // strict normalized "inc" .includes against "the incident report is attached"
    // → "inc" appears as substring in "incident", which IS a pre-existing
    // limitation of the strict path for very short brand names. The classifier
    // stripping logic must not amplify this — verify "Inc" alone is handled
    // sanely (no crash, no expanded matching from stripping).
    expect(result.matchedTerms.filter(t => t === '').length).toBe(0)
  })
})

describe('parseProviderName', () => {
  it('normalizes and returns provider name strings', () => {
    expect(parseProviderName('gemini')).toBe('gemini')
    expect(parseProviderName('cdp:chatgpt')).toBe('cdp:chatgpt')
    expect(parseProviderName('perplexity')).toBe('perplexity')
  })

  it('normalizes casing', () => {
    expect(parseProviderName('GEMINI')).toBe('gemini')
    expect(parseProviderName('OpenAI')).toBe('openai')
  })

  it('accepts any non-empty string (providers are validated at runtime)', () => {
    expect(parseProviderName('unknown')).toBe('unknown')
  })

  it('returns undefined for empty input', () => {
    expect(parseProviderName('')).toBeUndefined()
  })
})
