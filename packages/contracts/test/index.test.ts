import { describe, test, it, expect } from 'vitest'

import {
  resolveProviderInput,
  isBrowserProvider,
} from '../src/provider.js'

import {
  AppError,
  notFound,
  validationError,
  projectConfigSchema,
  projectConfigExportSchema,
  resolveConfigSpecQueries,
  resolveSnapshotRequestQueries,
  snapshotRequestSchema,
  projectDtoSchema,
  providerQuotaPolicySchema,
  runDtoSchema,
  runStatusSchema,
  citationStateSchema,
  computedTransitionSchema,
  determineAnswerMentioned,
  extractAnswerMentions,
  mentionStateFromAnswerMentioned,
  querySnapshotDtoSchema,
  auditLogEntrySchema,
  notificationDtoSchema,
  notificationEventSchema,
  effectiveDomains,
  effectiveBrandNames,
  normalizeProjectAliases,
  normalizeProjectDomain,
  registrableDomain,
  brandLabelFromDomain,
  locationContextSchema,
  resolveLocations,
  resultsExportRecordSchema,
  projectSearchSnapshotHitSchema,
} from '../src/index.js'

import type { LocationContext } from '../src/index.js'

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
  expect(project.providerModels).toEqual({})
  expect(project.configSource).toBe('cli')
  expect(project.configRevision).toBe(1)
})

test('results export records preserve cited URL capture and legacy nulls', () => {
  const record = resultsExportRecordSchema.parse({
    runId: 'run_1', runKind: 'answer-visibility', runStatus: 'completed', runTrigger: 'manual',
    runCreatedAt: '2026-07-01T00:00:00.000Z', runStartedAt: null, runFinishedAt: null,
    snapshotId: 'snapshot_1', snapshotCreatedAt: '2026-07-01T00:00:00.000Z', queryId: 'query_1', query: 'query',
    provider: 'gemini', model: null, location: null, citationState: 'not-cited', cited: false,
    answerMentioned: null, mentionState: null, citedDomains: [], competitorOverlap: [], recommendedCompetitors: [],
    answerText: null, groundingSources: [], searchQueries: [],
    citedUrls: null, captureStatus: null, sourceCount: null, resolvedCount: null, captureVersion: null,
  })
  expect(record).toEqual({
    runId: 'run_1', runKind: 'answer-visibility', runStatus: 'completed', runTrigger: 'manual',
    runCreatedAt: '2026-07-01T00:00:00.000Z', runStartedAt: null, runFinishedAt: null,
    snapshotId: 'snapshot_1', snapshotCreatedAt: '2026-07-01T00:00:00.000Z', queryId: 'query_1', query: 'query',
    provider: 'gemini', model: null, location: null, citationState: 'not-cited', cited: false,
    answerMentioned: null, mentionState: null, citedDomains: [], competitorOverlap: [], recommendedCompetitors: [],
    answerText: null, groundingSources: [], searchQueries: [],
    citedUrls: null, captureStatus: null, sourceCount: null, resolvedCount: null, captureVersion: null,
  })
  const captured = resultsExportRecordSchema.parse({
    runId: 'run_captured', runKind: 'answer-visibility', runStatus: 'completed', runTrigger: 'probe',
    runCreatedAt: '2026-07-02T10:00:00.000Z', runStartedAt: '2026-07-02T10:00:01.000Z', runFinishedAt: '2026-07-02T10:00:05.000Z',
    snapshotId: 'snapshot_captured', snapshotCreatedAt: '2026-07-02T10:00:04.000Z', queryId: null, query: 'removed query',
    provider: 'perplexity', model: 'sonar', location: 'nyc', citationState: 'cited', cited: true,
    answerMentioned: false, mentionState: 'not-mentioned', citedDomains: ['example.com'],
    competitorOverlap: ['competitor.test'], recommendedCompetitors: ['recommended.test'],
    answerText: 'A source supports this answer.', groundingSources: [{ uri: 'https://example.com/source', title: 'Source' }],
    searchQueries: ['source evidence'], citedUrls: ['https://example.com/source'],
    captureStatus: 'partial', sourceCount: 2, resolvedCount: 1, captureVersion: 1,
  })
  expect(captured).toEqual({
    runId: 'run_captured', runKind: 'answer-visibility', runStatus: 'completed', runTrigger: 'probe',
    runCreatedAt: '2026-07-02T10:00:00.000Z', runStartedAt: '2026-07-02T10:00:01.000Z', runFinishedAt: '2026-07-02T10:00:05.000Z',
    snapshotId: 'snapshot_captured', snapshotCreatedAt: '2026-07-02T10:00:04.000Z', queryId: null, query: 'removed query',
    provider: 'perplexity', model: 'sonar', location: 'nyc', citationState: 'cited', cited: true,
    answerMentioned: false, mentionState: 'not-mentioned', citedDomains: ['example.com'],
    competitorOverlap: ['competitor.test'], recommendedCompetitors: ['recommended.test'],
    answerText: 'A source supports this answer.', groundingSources: [{ uri: 'https://example.com/source', title: 'Source' }],
    searchQueries: ['source evidence'], citedUrls: ['https://example.com/source'],
    captureStatus: 'partial', sourceCount: 2, resolvedCount: 1, captureVersion: 1,
  })
})

test('project search snapshot hits classify cited URL matches', () => {
  expect(projectSearchSnapshotHitSchema.parse({
    kind: 'snapshot', id: 'snapshot_1', runId: 'run_1', query: 'query', provider: 'gemini', model: null,
    citationState: 'not-cited', matchedField: 'citedUrls', snippet: 'https://publisher.example/guides/cited-url-needle-path',
    createdAt: '2026-07-01T00:00:00.000Z',
  }).matchedField).toBe('citedUrls')
})

test('normalizeProjectDomain strips scheme and www prefix', () => {
  expect(normalizeProjectDomain('https://www.Docs.Example.com/path')).toBe('docs.example.com')
  expect(normalizeProjectDomain('WWW.example.com')).toBe('example.com')
})

describe('registrableDomain', () => {
  it('returns the eTLD+1 for a subdomained host', () => {
    expect(registrableDomain('offers.roofquill.test')).toBe('roofquill.test')
    expect(registrableDomain('app.example.io')).toBe('example.io')
    expect(registrableDomain('blog.news.example.org')).toBe('example.org')
  })

  it('returns the input unchanged when there is no subdomain', () => {
    expect(registrableDomain('roofquill.test')).toBe('roofquill.test')
    expect(registrableDomain('example.ai')).toBe('example.ai')
  })

  it('strips scheme, port, path, and www prefix before parsing', () => {
    expect(registrableDomain('https://www.offers.Roofquill.test/foo?x=1')).toBe('roofquill.test')
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
    expect(registrableDomain(registrableDomain('offers.roofquill.test'))).toBe('roofquill.test')
    expect(registrableDomain(registrableDomain('news.bbc.co.uk'))).toBe('bbc.co.uk')
  })
})

describe('brandLabelFromDomain', () => {
  it('returns the leftmost label of the registrable domain', () => {
    expect(brandLabelFromDomain('offers.roofquill.test')).toBe('roofquill')
    expect(brandLabelFromDomain('roofquill.test')).toBe('roofquill')
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

describe('normalizeProjectAliases', () => {
  it('trims, drops empties, and case-insensitively dedupes', () => {
    expect(normalizeProjectAliases('LlamaIndex', ['  LlamaParse ', '', 'llamaparse', 'LlamaParse']))
      .toEqual(['LlamaParse'])
  })

  it('silently filters aliases equal to displayName (case-insensitive)', () => {
    expect(normalizeProjectAliases('LlamaIndex', ['llamaindex', 'LlamaParse', 'LLAMAINDEX']))
      .toEqual(['LlamaParse'])
  })

  it('returns empty array for empty/null inputs', () => {
    expect(normalizeProjectAliases('Brand', [])).toEqual([])
    expect(normalizeProjectAliases('Brand', null)).toEqual([])
    expect(normalizeProjectAliases('Brand', undefined)).toEqual([])
  })

  it('handles null displayName without crashing', () => {
    expect(normalizeProjectAliases(null, ['Alias'])).toEqual(['Alias'])
  })

  it('preserves original casing of the first occurrence', () => {
    expect(normalizeProjectAliases('Brand', ['LlamaParse', 'llamaparse'])).toEqual(['LlamaParse'])
  })
})

describe('effectiveBrandNames', () => {
  it('returns displayName followed by normalized aliases', () => {
    expect(effectiveBrandNames({ displayName: 'LlamaIndex', aliases: ['LlamaParse'] }))
      .toEqual(['LlamaIndex', 'LlamaParse'])
  })

  it('omits displayName when empty/null', () => {
    expect(effectiveBrandNames({ displayName: '', aliases: ['Alias'] })).toEqual(['Alias'])
    expect(effectiveBrandNames({ displayName: null, aliases: ['Alias'] })).toEqual(['Alias'])
  })

  it('returns empty array when neither displayName nor aliases are set', () => {
    expect(effectiveBrandNames({})).toEqual([])
  })

  it('filters aliases that match displayName', () => {
    expect(effectiveBrandNames({ displayName: 'LlamaIndex', aliases: ['llamaindex', 'LlamaParse'] }))
      .toEqual(['LlamaIndex', 'LlamaParse'])
  })

  it('includes every owned domain label with extractAnswerMentions identity semantics', () => {
    expect(effectiveBrandNames({ canonicalDomain: 'www.Example.co.uk' }))
      .toEqual(['example'])
    expect(effectiveBrandNames({
      canonicalDomain: 'www.Example.co.uk',
      ownedDomains: ['bookings.example-group.com', 'www.Example.co.uk'],
      aliases: ['Example'],
    }))
      .toEqual(['Example', 'example-group'])
  })

  it('keeps exact short domains without approving their bare labels', () => {
    expect(effectiveBrandNames({
      canonicalDomain: 'www.ai.com',
      ownedDomains: ['go.io', 'four.com'],
    })).toEqual(['ai.com', 'go.io', 'four'])

    expect(effectiveBrandNames({
      canonicalDomain: 'www.ai.com',
      ownedDomains: ['go.io', 'four.com'],
      displayName: 'AI',
      aliases: ['Go'],
    }))
      .toEqual(['AI', 'Go', 'ai.com', 'go.io', 'four'])
  })

  it('keeps an owned-domain label distinct from the canonical-domain label', () => {
    expect(effectiveBrandNames({
      canonicalDomain: 'example.com',
      ownedDomains: ['booking.example-group.com'],
    }))
      .toEqual(['example', 'example-group'])
  })
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
  const valid = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }
  expect(providerQuotaPolicySchema.parse(valid)).toEqual({
    maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000,
  })
  for (const field of ['maxConcurrency', 'maxRequestsPerMinute', 'maxRequestsPerDay'] as const) {
    for (const value of [0, 0.5]) {
      const result = providerQuotaPolicySchema.safeParse({ ...valid, [field]: value })
      expect(result.success, `${field} rejects ${value}`).toBe(false)
      expect(result.error?.issues.map(issue => issue.path), `${field} issue path for ${value}`).toEqual([[field]])
    }
    const result = providerQuotaPolicySchema.safeParse({ ...valid, [field]: 1 })
    expect(result.success, `${field} accepts 1`).toBe(true)
    expect(result.data?.[field], `${field} preserves 1`).toBe(1)
  }
})

test('projectConfigSchema validates canonry.yaml structure', () => {
  const config = projectConfigSchema.parse({
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: 'my-project' },
    spec: {
      displayName: 'My Project', canonicalDomain: 'example.com', country: 'US', language: 'en',
    },
  })
  expect(config).toEqual({
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: 'my-project', labels: {} },
    spec: {
      displayName: 'My Project', canonicalDomain: 'example.com', country: 'US', language: 'en',
      ownedDomains: [], aliases: [], competitors: [], providers: [], providerModels: {}, locations: [],
      measurement: { marketingHosts: [], brandTerms: [], leadEventNames: ['generate_lead'] },
      notifications: [], autoExtractBacklinks: false,
    },
  })
  expect(Object.hasOwn(config.spec, 'queries')).toBe(false)
  expect(Object.hasOwn(config.spec, 'keywords')).toBe(false)
  expect(resolveConfigSpecQueries(config.spec)).toEqual([])
})

test('project config trims provider model overrides and rejects blank model IDs', () => {
  const config = projectConfigSchema.parse({
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: 'model-project' },
    spec: {
      displayName: 'Model Project', canonicalDomain: 'example.com', country: 'US', language: 'en',
      providerModels: { gemini: ' gemini-2.5-pro ' },
    },
  })
  expect(config.spec.providerModels).toEqual({ gemini: 'gemini-2.5-pro' })
  expect(() => projectConfigSchema.parse({
    apiVersion: 'canonry/v1', kind: 'Project', metadata: { name: 'bad-model-project' },
    spec: { displayName: 'Bad', canonicalDomain: 'example.com', country: 'US', language: 'en', providerModels: { gemini: '   ' } },
  })).toThrow()
})

test('projectConfigSchema accepts legacy spec.keywords as queries', () => {
  const config = projectConfigSchema.parse({
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: 'legacy-project' },
    spec: {
      displayName: 'Legacy Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      keywords: ['answer visibility tools'],
    },
  })

  expect(resolveConfigSpecQueries(config.spec)).toEqual(['answer visibility tools'])
})

test('projectConfigSchema rejects mixed spec.queries and legacy spec.keywords', () => {
  expect(() => projectConfigSchema.parse({
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: 'mixed-project' },
    spec: {
      displayName: 'Mixed Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      queries: ['answer visibility tools'],
      keywords: ['legacy phrase'],
    },
  })).toThrow(/legacy alias/)
})

test('snapshotRequestSchema accepts legacy phrases as queries', () => {
  const request = snapshotRequestSchema.parse({
    companyName: 'Acme',
    domain: 'example.com',
    phrases: ['best widget provider'],
  })

  expect(resolveSnapshotRequestQueries(request)).toEqual(['best widget provider'])
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

test('projectConfigExportSchema keeps the cross-field checks POST /apply runs', () => {
  const nyc = { label: 'nyc', city: 'New York', region: 'NY', country: 'US' }
  const exported = {
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: 'my-project', labels: {} },
    spec: {
      displayName: 'My Project', canonicalDomain: 'example.com', ownedDomains: [], aliases: [],
      country: 'US', language: 'en', queries: ['answer visibility tools'], competitors: [], providers: [],
      locations: [nyc],
      measurement: { marketingHosts: [], brandTerms: [], leadEventNames: ['generate_lead'] },
      notifications: [],
      schedule: { preset: 'daily', timezone: 'UTC', providers: [], enabled: true },
    },
  }
  expect(projectConfigExportSchema.parse(exported)).toEqual(exported)

  for (const [spec, message] of [
    [{ keywords: ['legacy phrase'] }, /legacy alias/],
    [{ locations: [nyc, { ...nyc, city: 'Brooklyn' }] }, /Duplicate location labels/],
    [{ defaultLocation: 'sf' }, /defaultLocation/],
    [{ schedule: { ...exported.spec.schedule, cron: '0 6 * * *' } }, /Exactly one of/],
  ] as const) {
    expect(() => projectConfigExportSchema.parse({ ...exported, spec: { ...exported.spec, ...spec } })).toThrow(message)
  }
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
    queryId: 'q_1',
    provider: 'gemini',
    citationState: 'cited',
    createdAt: '2026-03-09T00:00:00.000Z',
  })

  expect(snapshot.provider).toBe('gemini')
  expect(snapshot.citedDomains).toEqual([])
  expect(snapshot.citedUrls).toBeNull()
  expect(snapshot.captureStatus).toBeNull()
  expect(snapshot.sourceCount).toBeNull()
  expect(snapshot.resolvedCount).toBeNull()
  expect(snapshot.captureVersion).toBeNull()
  expect(snapshot.competitorOverlap).toEqual([])
  expect(snapshot.citedCompetitorDomains).toEqual([])
  expect(snapshot.mentionedCompetitorDomains).toEqual([])
  expect(snapshot.recommendedCompetitors).toEqual([])
  expect(snapshot.matchedTerms).toEqual([])
  expect(snapshot.answerMentioned).toBeUndefined()
  expect(snapshot.visibilityState).toBeUndefined()
  expect(snapshot.mentionState).toBeUndefined()
})

test('querySnapshotDtoSchema accepts the new mentionState field', () => {
  for (const state of ['mentioned', 'not-mentioned'] as const) {
    const snapshot = querySnapshotDtoSchema.parse({
      id: 'snap_1',
      runId: 'run_1',
      queryId: 'q_1',
      provider: 'gemini',
      citationState: 'cited',
      mentionState: state,
      createdAt: '2026-03-09T00:00:00.000Z',
    })
    expect(snapshot.mentionState).toBe(state)
  }
})

test('mentionStateFromAnswerMentioned mirrors the legacy visibility helper with the new vocabulary', () => {
  expect(mentionStateFromAnswerMentioned(true)).toBe('mentioned')
  expect(mentionStateFromAnswerMentioned(false)).toBe('not-mentioned')
  expect(mentionStateFromAnswerMentioned(null)).toBe('not-mentioned')
  expect(mentionStateFromAnswerMentioned(undefined)).toBe('not-mentioned')
})

test('querySnapshotDtoSchema accepts all provider names', () => {
  for (const provider of ['gemini', 'openai', 'claude', 'perplexity', 'cdp:chatgpt', 'lab:engine']) {
    const result = querySnapshotDtoSchema.safeParse({
      id: 'snap_1', runId: 'run_1', queryId: 'q_1', provider,
      citationState: 'cited', createdAt: '2026-03-09T00:00:00.000Z',
    })
    expect(result.success, `snapshot accepts ${provider}`).toBe(true)
    expect(result.data?.provider, `snapshot preserves ${provider}`).toBe(provider)
  }
})

test('auditLogEntrySchema validates log entries', () => {
  const entry = auditLogEntrySchema.parse({
    id: 'log_1', actor: 'cli', action: 'project.created', entityType: 'project',
    entityId: 'project_1', createdAt: '2026-03-09T00:00:00.000Z',
  })
  expect(entry).toEqual({
    id: 'log_1', actor: 'cli', action: 'project.created', entityType: 'project',
    entityId: 'project_1', createdAt: '2026-03-09T00:00:00.000Z',
  })
  expect(Object.hasOwn(entry, 'projectId')).toBe(false)
})

test('notificationDtoSchema accepts redacted runtime notification payloads', () => {
  const notification = notificationDtoSchema.parse({
    id: 'notif_1', projectId: 'project_1', channel: 'webhook',
    url: 'https://hooks.example.com/redacted', urlDisplay: 'hooks.example.com/redacted', urlHost: 'hooks.example.com',
    events: ['run.completed'], enabled: true,
    createdAt: '2026-03-09T00:00:00.000Z', updatedAt: '2026-03-09T00:00:00.000Z',
  })
  expect(notification).toEqual({
    id: 'notif_1', projectId: 'project_1', channel: 'webhook',
    url: 'https://hooks.example.com/redacted', urlDisplay: 'hooks.example.com/redacted', urlHost: 'hooks.example.com',
    events: ['run.completed'], enabled: true,
    createdAt: '2026-03-09T00:00:00.000Z', updatedAt: '2026-03-09T00:00:00.000Z',
  })
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

  expect(config.spec.schedule).toEqual({ preset: 'daily', timezone: 'America/New_York', providers: [] })
  expect(config.spec.notifications).toEqual([{
    channel: 'webhook', url: 'https://hooks.example.com/test', events: ['citation.lost'],
  }])
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
  expect(project.locations).toEqual([
    { label: 'nyc', city: 'New York', region: 'New York', country: 'US' },
    { label: 'london', city: 'London', region: 'England', country: 'GB', timezone: 'Europe/London' },
  ])
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

describe('resolveLocations', () => {

const MICHIGAN: LocationContext = { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' }
const FLORIDA: LocationContext = { label: 'florida', city: 'Miami', region: 'Florida', country: 'US' }
const TEXAS: LocationContext = { label: 'texas', city: 'Austin', region: 'Texas', country: 'US' }
const PROJECT_LOCATIONS = [MICHIGAN, FLORIDA, TEXAS]

test('returns every project location when no override is given', () => {
  expect(resolveLocations(PROJECT_LOCATIONS, undefined)).toEqual(PROJECT_LOCATIONS)
})

test('returns every project location when the override is an empty array', () => {
  expect(resolveLocations(PROJECT_LOCATIONS, [])).toEqual(PROJECT_LOCATIONS)
})

test('treats an all-blank override as no override (falls back to all)', () => {
  expect(resolveLocations(PROJECT_LOCATIONS, ['', '   '])).toEqual(PROJECT_LOCATIONS)
})

test('returns an empty array for a project with no locations and no override', () => {
  expect(resolveLocations([], undefined)).toEqual([])
})

test('resolves a subset in requested order, not project order', () => {
  expect(resolveLocations(PROJECT_LOCATIONS, ['florida', 'michigan'])).toEqual([FLORIDA, MICHIGAN])
})

test('matches labels case-insensitively and trims whitespace', () => {
  expect(resolveLocations(PROJECT_LOCATIONS, ['  MICHIGAN  ', 'Florida'])).toEqual([MICHIGAN, FLORIDA])
})

test('dedupes repeated labels in the override', () => {
  expect(resolveLocations(PROJECT_LOCATIONS, ['michigan', 'MICHIGAN', 'michigan'])).toEqual([MICHIGAN])
})

test('throws validationError for a label not configured on the project', () => {
  expect(() => resolveLocations(PROJECT_LOCATIONS, ['california'])).toThrow(/not configured/i)
})

test('throws when any override label is unknown even if others match', () => {
  expect(() => resolveLocations(PROJECT_LOCATIONS, ['michigan', 'california'])).toThrow(/california/)
})

test('throws when an override is passed but the project has no locations', () => {
  expect(() => resolveLocations([], ['michigan'])).toThrow(/not configured/i)
})

}) // end resolveLocations

describe('querySnapshotDtoSchema location', () => {

test('querySnapshotDtoSchema accepts location string', () => {
  const snapshot = querySnapshotDtoSchema.parse({
    id: 'snap_1',
    runId: 'run_1',
    queryId: 'q_1',
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
    queryId: 'q_1',
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
    queryId: 'q_1',
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
    expect(resolveProviderInput('cdp')).toEqual(['cdp:chatgpt'])
  })

  it('expands "CDP" (case-insensitive) to all CDP targets', () => {
    expect(resolveProviderInput('CDP')).toEqual(['cdp:chatgpt'])
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
      ['Example Inc'],
      ['example.com'],
    )).toBe(true)
  })

  it('matches display name mentions when the domain is not present', () => {
    expect(determineAnswerMentioned(
      'Example Health is frequently recommended for this workflow.',
      ['Example Health'],
      ['examplehealth.com'],
    )).toBe(true)
  })

  it('returns false when neither domain nor brand appears', () => {
    expect(determineAnswerMentioned(
      'Top picks include Contoso and Fabrikam.',
      ['Example Health'],
      ['examplehealth.com'],
    )).toBe(false)
  })
})

describe('extractAnswerMentions', () => {
  it('returns matched domain terms', () => {
    const result = extractAnswerMentions(
      'Top picks include example.com and other vendors.',
      ['Example Inc'],
      ['example.com'],
    )
    expect(result).toEqual({ mentioned: true, matchedTerms: ['example.com'] })
  })

  it('returns matched display name', () => {
    const result = extractAnswerMentions(
      'Example Health is frequently recommended for this workflow.',
      ['Example Health'],
      ['examplehealth.com'],
    )
    expect(result).toEqual({ mentioned: true, matchedTerms: ['Example Health', 'examplehealth'] })
  })

  it('returns empty matchedTerms when nothing matches', () => {
    const result = extractAnswerMentions(
      'Top picks include Contoso and Fabrikam.',
      ['Example Health'],
      ['examplehealth.com'],
    )
    expect(result.mentioned).toBe(false)
    expect(result.matchedTerms).toEqual([])
  })

  it('returns both domain and display name when both match', () => {
    const result = extractAnswerMentions(
      'According to Example Inc at example.com, this is the best approach.',
      ['Example Inc'],
      ['example.com'],
    )
    expect(result).toEqual({ mentioned: true, matchedTerms: ['example.com', 'Example Inc'] })
  })

  it('deduplicates matched terms', () => {
    const result = extractAnswerMentions(
      'Visit ainyc.ai for details. AINYC.AI is great.',
      ['AI NYC'],
      ['ainyc.ai'],
    )
    expect(result).toEqual({ mentioned: true, matchedTerms: ['ainyc.ai'] })
  })

  it('handles null answer text', () => {
    const result = extractAnswerMentions(null, ['Example'], ['example.com'])
    expect(result.mentioned).toBe(false)
    expect(result.matchedTerms).toEqual([])
  })

  it('matches when display name has no spaces but the answer spaces it out', () => {
    // Illustrative example of a real-world shape: project registered as
    // "zyloqcoatings" with domain zyloqcoatingsllc.test; answer says
    // "Zyloq Coatings (Springfield Area)".
    const result = extractAnswerMentions(
      'Local contractors include Zyloq Coatings (Springfield Area), specializing in polyurea roof restoration.',
      ['zyloqcoatings'],
      ['zyloqcoatingsllc.test'],
    )
    expect(result).toEqual({ mentioned: true, matchedTerms: ['zyloqcoatings'] })
  })

  it('matches when display name has spaces but the answer concatenates it', () => {
    const result = extractAnswerMentions(
      'Visit ZyloqCoatings for industrial polyurea systems.',
      ['Zyloq Coatings'],
      ['zyloqcoatingsllc.test'],
    )
    expect(result).toEqual({ mentioned: true, matchedTerms: ['Zyloq Coatings'] })
  })

  it('does not concatenate across unrelated words to manufacture a match', () => {
    const result = extractAnswerMentions(
      'Find the pa cme report in the archive.',
      ['Acme'],
      ['acme.io'],
    )
    expect(result.mentioned).toBe(false)
    expect(result.matchedTerms).toEqual([])
  })

  it('does not invent an alias by stripping a legal suffix', () => {
    const result = extractAnswerMentions(
      'Bobsled racing is fun this winter.',
      ['Bob Inc'],
      ['bob.example.com'],
    )
    expect(result.mentioned).toBe(false)
    expect(result.matchedTerms).toEqual([])

    // "Bob" is a separate identity and must be configured as an alias before
    // it can affect mention KPIs.
    expect(extractAnswerMentions(
      'Bob is great at fixing things.',
      ['Bob Inc', 'Bob'],
      ['bob.example.com'],
    ).mentioned).toBe(true)
  })

  it('requires a configured alias when an answer drops a legal classifier', () => {
    expect(extractAnswerMentions(
      'Local contractors include Zyloq Coatings (Springfield Area).',
      ['Zyloq Coatings LLC'],
      ['zyloqcoatingsllc.test'],
    ).mentioned).toBe(false)

    expect(extractAnswerMentions(
      'Local contractors include Zyloq Coatings (Springfield Area).',
      ['Zyloq Coatings LLC', 'Zyloq Coatings'],
      ['zyloqcoatingsllc.test'],
    ).mentioned).toBe(true)

    // A domain-derived identity can still provide the exact shorter name.
    expect(extractAnswerMentions(
      'According to Kestrelmoor Paints the finish is the best.',
      ['Kestrelmoor Paints Inc'],
      ['kestrelmoorpaints.test'],
    ).mentioned).toBe(true)

    expect(extractAnswerMentions(
      'Microsoft is launching a new product line.',
      ['Microsoft Corporation'],
      ['microsoft.com'],
    ).mentioned).toBe(true)
  })

  it('requires a configured alias when an answer drops a category word', () => {
    expect(extractAnswerMentions(
      'Vantrell is a popular Harborview restaurant.',
      ['Vantrell Hotel'],
      ['vantrellhotel.test'],
    ).mentioned).toBe(false)

    expect(extractAnswerMentions(
      'Vantrell is a popular Harborview restaurant.',
      ['Vantrell Hotel', 'Vantrell'],
      ['vantrellhotel.test'],
    ).mentioned).toBe(true)

    expect(extractAnswerMentions(
      'Vantell is a different spelling.',
      ['Vantrell Hotel', 'Vantrell'],
      ['vantrellhotel.test'],
    ).mentioned).toBe(false)
  })

  it('does not match the leftmost subdomain label as a brand token', () => {
    // Regression: a project with own domain `offers.example.com` must not
    // word-boundary match the literal word "offers" in the answer prose. Only
    // the registrable domain's brand label (`example`) is a valid token.
    const result = extractAnswerMentions(
      'Harborline Energy Systems offers a white-label lead generation tool.',
      ['Vexlo IQ'],
      ['offers.example.com'],
    )
    expect(result.mentioned).toBe(false)
    expect(result.matchedTerms).toEqual([])
  })

  it('still matches the registrable brand of a subdomained own domain', () => {
    for (const { brandNames, matchedTerms } of [
      { brandNames: ['Roofquill'], matchedTerms: ['Roofquill'] },
      { brandNames: [], matchedTerms: ['roofquill'] },
    ]) {
      const result = extractAnswerMentions(
        'Brokers turn to Roofquill when they need quick install quotes.',
        brandNames,
        ['offers.roofquill.test'],
      )
      expect(result, `registrable identity with names ${brandNames.join(',')}`).toEqual({ mentioned: true, matchedTerms })
    }
  })

  it('matches a short classifier-only display name only when it appears as a whole word', () => {
    // Edge case: displayName is just "Inc" (3 chars). It must NOT false-match
    // inside "incident" (substring) but MUST match when "Inc" appears as a
    // standalone word.
    expect(extractAnswerMentions(
      'The incident report is attached.',
      ['Inc'],
      ['inc.example.com'],
    ).mentioned).toBe(false)

    expect(extractAnswerMentions(
      'Inc said in their filing today.',
      ['Inc'],
      ['inc.example.com'],
    ).mentioned).toBe(true)
  })

  it('matches short normalized display names only as whole words, not as substrings', () => {
    // Regression: a project with displayName "LI" must not flag every
    // commercial-flooring answer as "mentioned" because the 2-letter "li"
    // appears inside "polished", "compliance", etc. — but MUST still match
    // when "LI" appears as a standalone word.

    // --- Negative cases (false positives the fix prevents) ---
    expect(extractAnswerMentions(
      'We install ceramic tile, vinyl, and polished concrete in commercial buildings.',
      ['LI'],
      ['lorvaneinteriors.example.com'],
    ).mentioned).toBe(false)

    expect(extractAnswerMentions(
      'The compliance review is scheduled for next week.',
      ['LI'],
      ['lorvaneinteriors.example.com'],
    ).mentioned).toBe(false)

    // --- Positive cases (legitimate matches the fix preserves) ---
    expect(extractAnswerMentions(
      'LI is great for commercial flooring projects.',
      ['LI'],
      ['lorvaneinteriors.example.com'],
    ).mentioned).toBe(true)

    expect(extractAnswerMentions(
      'According to LI, their new line ships in Q3.',
      ['LI'],
      ['lorvaneinteriors.example.com'],
    ).mentioned).toBe(true)

    // --- Domain and full-brand paths still work for short names ---
    expect(extractAnswerMentions(
      'Visit lorvaneinteriors.example.com for commercial flooring quotes.',
      ['LI'],
      ['lorvaneinteriors.example.com'],
    ).mentioned).toBe(true)

    expect(extractAnswerMentions(
      'Lorvane Interiors has installed flooring across the tri-county area since 1978.',
      ['Lorvane Interiors'],
      ['lorvaneinteriors.example.com'],
    ).mentioned).toBe(true)
  })

  it('matches multi-word short display names as whole phrases', () => {
    // Regression: short multi-word brands like "AB LLC" or "AI NYC" have a
    // brand key below MIN_BRAND_KEY_LENGTH and tokens that are individually
    // too short or generic. The whole-phrase normalized match is the only
    // text path available — it must work when the phrase appears verbatim
    // and must NOT fire on substring noise.

    // "AB LLC" appears as a phrase
    expect(extractAnswerMentions(
      'AB LLC offers commercial flooring across the region.',
      ['AB LLC'],
      ['ab-llc.example.com'],
    ).mentioned).toBe(true)

    // "AB LLC" does not appear; should not fire
    expect(extractAnswerMentions(
      'The lab llc-equivalent regulations took effect last year.',
      ['AB LLC'],
      ['ab-llc.example.com'],
    ).mentioned).toBe(false)

    // "AI NYC" appears as a phrase
    expect(extractAnswerMentions(
      'AI NYC just shipped their new agent platform.',
      ['AI NYC'],
      ['ainyc.ai'],
    ).mentioned).toBe(true)

    // "AI NYC" does not appear (note "ai" alone embedded in "said" must not
    // false-match the candidate "ai nyc")
    expect(extractAnswerMentions(
      'She said the report is due tomorrow.',
      ['AI NYC'],
      ['ainyc.ai'],
    ).mentioned).toBe(false)
  })

  it('does not flag a multi-word brand on the trailing descriptor word alone', () => {
    // Regression: a project "Quillmere Roofing" must not be considered mentioned
    // when the answer only contains the generic word "roofing" — even when
    // it appears many times. Standalone descriptor words like "Roofing",
    // "Plumbing", "Construction" are too common in industry prose to be a
    // reliable signal of brand presence on their own.
    for (const answer of [
      'Roofing repair work requires permits and trained inspectors. Most homeowners pay $300 for a basic roofing inspection.',
      'Most homeowners pay $300 for a basic roofing inspection.',
    ]) {
      const result = extractAnswerMentions(answer, ['Quillmere Roofing'], ['quillmereroofing.test'])
      expect(result, answer).toEqual({ mentioned: false, matchedTerms: [] })
    }
  })

  it('does not surface trailing descriptor words as matched terms when the full phrase is present', () => {
    // The brand IS mentioned (full phrase appears + many "roofing" mentions
    // in surrounding prose). The match itself is correct, but matchedTerms
    // must NOT surface "roofing" — otherwise it gets shown as a chip in the
    // UI and highlighted everywhere the generic word appears, which is
    // misleading. Only the configured displayName and exact domain-derived
    // identity should be exposed as evidence.
    const result = extractAnswerMentions(
      'Metro-area picks: Brightcrest Exteriors (commercial roofing), Stonevale Roofing & Exteriors (storm damage), and Quillmere Roofing for residential work. Budget around $11,000 for a full roofing replacement.',
      ['Quillmere Roofing'],
      ['quillmereroofing.test'],
    )
    expect(result.mentioned).toBe(true)
    expect(result.matchedTerms).toContain('Quillmere Roofing')
    expect(result.matchedTerms).toContain('quillmereroofing')
    expect(result.matchedTerms).not.toContain('roofing')
  })

  // ─── Aliases / multi-identity brand matching ────────────────────────────

  it('fires on a standalone alias mention even when displayName is absent', () => {
    // The LlamaIndex / LlamaParse case. Project displayName="LlamaIndex"
    // with aliases=["LlamaParse"]; answer mentions only "LlamaParse".
    // Each approved brand name is matched as its own identity.
    const result = extractAnswerMentions(
      'LlamaParse is a great parser for PDFs.',
      ['LlamaIndex', 'LlamaParse'],
      ['llamaindex.ai'],
    )
    expect(result.mentioned).toBe(true)
    expect(result.matchedTerms).toContain('LlamaParse')
  })

  it("explicit alias fires even when displayName tokens don't match", () => {
    for (const domains of [
      ['llamaindex.ai', 'llamaparse.com'],
      ['llamaindex.ai', 'document-tools.test'],
    ]) {
      const result = extractAnswerMentions(
        'LlamaParse is a great tool for parsing.',
        ['LlamaIndex', 'LlamaParse'],
        domains,
      )
      expect(result, `approved alias with domains ${domains.join(',')}`).toEqual({ mentioned: true, matchedTerms: ['LlamaParse'] })
    }
  })

  it('empty brandNames array still allows domain-only matching', () => {
    const result = extractAnswerMentions(
      'Read more at example.com.',
      [],
      ['example.com'],
    )
    expect(result.mentioned).toBe(true)
    expect(result.matchedTerms).toContain('example.com')
  })

  it('empty brandNames with no domain match returns not-mentioned', () => {
    const result = extractAnswerMentions(
      'Nothing relevant here.',
      [],
      ['example.com'],
    )
    expect(result.mentioned).toBe(false)
    expect(result.matchedTerms).toEqual([])
  })

  it('skips empty / whitespace-only brand names without crashing', () => {
    const result = extractAnswerMentions(
      'Example Health is great.',
      ['', '   ', 'Example Health'],
      ['examplehealth.com'],
    )
    expect(result.mentioned).toBe(true)
    expect(result.matchedTerms).toContain('Example Health')
  })
})
