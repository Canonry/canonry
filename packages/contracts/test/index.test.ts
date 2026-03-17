import { describe, test, expect } from 'vitest'

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
  querySnapshotDtoSchema,
  auditLogEntrySchema,
  notificationEventSchema,
  effectiveDomains,
  normalizeProjectDomain,
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
