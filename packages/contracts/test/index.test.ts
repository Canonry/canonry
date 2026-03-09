import assert from 'node:assert/strict'
import test from 'node:test'

import { projectDtoSchema, providerQuotaPolicySchema, runDtoSchema, runStatusSchema } from '../src/index.js'

test('projectDtoSchema applies defaults for tags', () => {
  const project = projectDtoSchema.parse({
    id: 'project_1',
    name: 'Example',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
  })

  assert.deepEqual(project.tags, [])
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
