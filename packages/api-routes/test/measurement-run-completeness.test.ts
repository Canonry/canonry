import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createClient, migrate, projects, runs, querySnapshots } from '@ainyc/canonry-db'
import { measurementRunCompleteness } from '../src/measurement-run-completeness.js'

function harness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-completeness-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId, name: 'completeness-site', displayName: 'Completeness', canonicalDomain: 'example.com',
    ownedDomains: '[]', country: 'US', language: 'en', tags: '[]', labels: '{}',
    providers: '["gemini","openai"]', locations: '[]', defaultLocation: null,
    configSource: 'api', configRevision: 1, createdAt: now, updatedAt: now,
  } as never).run()
  return { db, projectId, now }
}

describe('measurementRunCompleteness', () => {
  it('does not let a stray row inflate the count past a slot nobody answered', () => {
    // Two rows exist and two slots are expected, but only one row is
    // attributable to an expected slot (e1/openai). The second carries no
    // execution id — it is not evidence that e2/gemini ran. A raw row count
    // of 2 against an expected count of 2 would say "complete"; the manifest
    // was not.
    const { db, projectId, now } = harness()
    const runId = 'r-stray-row'
    db.insert(runs).values({
      id: runId,
      projectId,
      status: 'partial',
      measurementPlanVersionId: null,
      measurementManifest: {
        schemaVersion: 1,
        expectedSlots: [
          { executionId: 'e1', queryText: 'widget pricing', provider: 'openai', context: null },
          { executionId: 'e2', queryText: 'widget pricing', provider: 'gemini', context: null },
        ],
      },
      createdAt: now,
    }).run()
    db.insert(querySnapshots).values([
      {
        id: crypto.randomUUID(), runId, queryId: null, provider: 'openai',
        citationState: 'cited', citedDomains: [], competitorOverlap: [],
        measurementExecutionId: 'e1', createdAt: now,
      },
      {
        id: crypto.randomUUID(), runId, queryId: null, provider: 'openai',
        citationState: 'not-cited', citedDomains: [], competitorOverlap: [],
        measurementExecutionId: null, createdAt: now,
      },
    ]).run()

    expect(measurementRunCompleteness(db, runId)).toEqual({
      planned: true, executed: 1, expected: 2, complete: false,
    })
  })

  it('reports complete once every expected slot has exactly one matching row', () => {
    const { db, projectId, now } = harness()
    const runId = 'r-filled'
    db.insert(runs).values({
      id: runId,
      projectId,
      status: 'completed',
      measurementPlanVersionId: null,
      measurementManifest: {
        schemaVersion: 1,
        expectedSlots: [
          { executionId: 'e1', queryText: 'widget pricing', provider: 'openai', context: null },
          { executionId: 'e2', queryText: 'widget pricing', provider: 'gemini', context: null },
        ],
      },
      createdAt: now,
    }).run()
    db.insert(querySnapshots).values([
      {
        id: crypto.randomUUID(), runId, queryId: null, provider: 'openai',
        citationState: 'cited', citedDomains: [], competitorOverlap: [],
        measurementExecutionId: 'e1', createdAt: now,
      },
      {
        id: crypto.randomUUID(), runId, queryId: null, provider: 'gemini',
        citationState: 'not-cited', citedDomains: [], competitorOverlap: [],
        measurementExecutionId: 'e2', createdAt: now,
      },
    ]).run()

    expect(measurementRunCompleteness(db, runId)).toEqual({
      planned: true, executed: 2, expected: 2, complete: true,
    })
  })

  it.each([null, '', '   '])('fails closed when an otherwise complete run has an unbound snapshot (%j)', (executionId) => {
    const { db, projectId, now } = harness()
    const runId = `r-unbound-${executionId === null ? 'null' : executionId.length}`
    db.insert(runs).values({
      id: runId,
      projectId,
      status: 'completed',
      measurementPlanVersionId: null,
      measurementManifest: {
        schemaVersion: 1,
        expectedSlots: [
          { executionId: 'e1', queryText: 'widget pricing', provider: 'openai', context: null },
          { executionId: 'e2', queryText: 'widget pricing', provider: 'gemini', context: null },
        ],
      },
      createdAt: now,
    }).run()
    db.insert(querySnapshots).values([
      {
        id: crypto.randomUUID(), runId, queryId: null, provider: 'openai',
        citationState: 'cited', citedDomains: [], competitorOverlap: [],
        measurementExecutionId: 'e1', createdAt: now,
      },
      {
        id: crypto.randomUUID(), runId, queryId: null, provider: 'gemini',
        citationState: 'not-cited', citedDomains: [], competitorOverlap: [],
        measurementExecutionId: 'e2', createdAt: now,
      },
      {
        id: crypto.randomUUID(), runId, queryId: null, provider: 'openai',
        citationState: 'cited', citedDomains: [], competitorOverlap: [],
        measurementExecutionId: executionId, createdAt: now,
      },
    ]).run()

    expect(measurementRunCompleteness(db, runId)).toEqual({
      planned: true, executed: 2, expected: 2, complete: false,
    })
  })

  it('reports planned:false for a run with no manifest', () => {
    const { db, projectId, now } = harness()
    const runId = 'r-planless'
    db.insert(runs).values({ id: runId, projectId, status: 'completed', createdAt: now }).run()

    expect(measurementRunCompleteness(db, runId)).toEqual({
      planned: false, executed: 0, expected: 0, complete: true,
    })
  })
})
