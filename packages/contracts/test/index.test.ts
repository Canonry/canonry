import assert from 'node:assert/strict'
import test from 'node:test'

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
} from '../src/index.js'

test('projectDtoSchema applies defaults for tags, labels, configSource, configRevision', () => {
  const project = projectDtoSchema.parse({
    id: 'project_1',
    name: 'Example',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
  })

  assert.deepEqual(project.tags, [])
  assert.deepEqual(project.labels, {})
  assert.deepEqual(project.ownedDomains, [])
  assert.equal(project.configSource, 'cli')
  assert.equal(project.configRevision, 1)
})

test('normalizeProjectDomain strips scheme and www prefix', () => {
  assert.equal(normalizeProjectDomain('https://www.Docs.Example.com/path'), 'docs.example.com')
  assert.equal(normalizeProjectDomain('WWW.example.com'), 'example.com')
})

test('effectiveDomains deduplicates canonical and owned domain variants', () => {
  const domains = effectiveDomains({
    canonicalDomain: 'https://www.example.com',
    ownedDomains: ['example.com', 'docs.example.com', 'https://www.docs.example.com/path', ''],
  })

  assert.deepEqual(domains, ['https://www.example.com', 'docs.example.com'])
})

test('run schemas accept expected values and reject invalid statuses', () => {
  const run = runDtoSchema.parse({
    id: 'run_1',
    projectId: 'project_1',
    kind: 'site-audit',
    status: 'queued',
    createdAt: '2026-03-09T00:00:00.000Z',
  })

  assert.equal(run.status, 'queued')
  assert.equal(run.trigger, 'manual')
  assert.equal(run.startedAt, undefined)
  assert.throws(() => runStatusSchema.parse('bogus'))
})

test('providerQuotaPolicySchema enforces positive integer limits', () => {
  const quota = providerQuotaPolicySchema.parse({
    maxConcurrency: 2,
    maxRequestsPerMinute: 10,
    maxRequestsPerDay: 1000,
  })

  assert.deepEqual(quota, {
    maxConcurrency: 2,
    maxRequestsPerMinute: 10,
    maxRequestsPerDay: 1000,
  })
  assert.throws(() => providerQuotaPolicySchema.parse({
    maxConcurrency: 0,
    maxRequestsPerMinute: 10,
    maxRequestsPerDay: 1000,
  }))
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

  assert.equal(config.metadata.name, 'my-project')
  assert.deepEqual(config.metadata.labels, {})
  assert.deepEqual(config.spec.keywords, [])
  assert.deepEqual(config.spec.competitors, [])
})

test('projectConfigSchema rejects invalid project names', () => {
  assert.throws(() => projectConfigSchema.parse({
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: 'UPPERCASE' },
    spec: {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    },
  }))

  assert.throws(() => projectConfigSchema.parse({
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: '-leading-hyphen' },
    spec: {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    },
  }))
})

test('citationStateSchema accepts only raw observation values', () => {
  assert.equal(citationStateSchema.parse('cited'), 'cited')
  assert.equal(citationStateSchema.parse('not-cited'), 'not-cited')
  assert.throws(() => citationStateSchema.parse('lost'))
  assert.throws(() => citationStateSchema.parse('emerging'))
})

test('computedTransitionSchema accepts all transition values', () => {
  for (const value of ['new', 'cited', 'lost', 'emerging', 'not-cited']) {
    assert.equal(computedTransitionSchema.parse(value), value)
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

  assert.equal(snapshot.provider, 'gemini')
  assert.deepEqual(snapshot.citedDomains, [])
  assert.deepEqual(snapshot.competitorOverlap, [])
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
    assert.equal(snapshot.provider, provider)
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

  assert.equal(entry.action, 'project.created')
  assert.equal(entry.projectId, undefined)
})

test('AppError serializes to JSON with code and message', () => {
  const err = notFound('Project', 'my-project')
  assert.equal(err.code, 'NOT_FOUND')
  assert.equal(err.statusCode, 404)
  assert.deepEqual(err.toJSON(), {
    error: { code: 'NOT_FOUND', message: "Project 'my-project' not found" },
  })
})

test('validationError includes details in JSON output', () => {
  const err = validationError('Invalid config', { field: 'name' })
  assert.equal(err.statusCode, 400)
  assert.deepEqual(err.toJSON(), {
    error: { code: 'VALIDATION_ERROR', message: 'Invalid config', details: { field: 'name' } },
  })
})

test('AppError is an instance of Error', () => {
  const err = new AppError('INTERNAL_ERROR', 'something broke', 500)
  assert.ok(err instanceof Error)
  assert.equal(err.name, 'AppError')
})

// --- Notification schema tests ---

test('notificationEventSchema accepts valid events', () => {
  for (const event of ['citation.lost', 'citation.gained', 'run.completed', 'run.failed']) {
    assert.equal(notificationEventSchema.parse(event), event)
  }
})

test('notificationEventSchema rejects invalid events', () => {
  assert.throws(() => notificationEventSchema.parse('invalid.event'))
})

// --- Config schema with schedule ---

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

  assert.ok(config.spec.schedule)
  assert.equal(config.spec.notifications.length, 1)
})

test('projectConfigSchema rejects schedule with both preset and cron', () => {
  assert.throws(() => projectConfigSchema.parse({
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
  }))
})
