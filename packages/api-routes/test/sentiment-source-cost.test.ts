import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, projects, runs, querySnapshots, measurementPlanVersions, type DatabaseClient } from '@ainyc/canonry-db'
import * as contracts from '@ainyc/canonry-contracts'
import { canonicalMeasurementPlanV2Json } from '@ainyc/canonry-contracts'
import { selectSentimentSources } from '../src/sentiment-source.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'

// Count the plan decoder and the usage-edge key without changing what they return.
vi.mock('@ainyc/canonry-contracts', async importOriginal => {
  const actual = await importOriginal<typeof import('@ainyc/canonry-contracts')>()
  return { ...actual, parseStoredMeasurementPlanAnyVersion: vi.fn(actual.parseStoredMeasurementPlanAnyVersion), measurementV2UsageEdgeKey: vi.fn(actual.measurementV2UsageEdgeKey) }
})

let db: DatabaseClient
const now = '2026-09-28T00:00:00.000Z'
beforeEach(() => {
  db = createClient(':memory:'); migrate(db)
  db.insert(projects).values({ id: 'p', name: 'test', displayName: 'Northstar', canonicalDomain: 'northstar.example', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
})
afterEach(() => { db.$client.close() })

describe('sentiment source selection cost', () => {
  it('parses and keys a shared frozen revision once per selection, however many runs and snapshots use it', () => {
    const plan = measurementPlanV2Fixture()
    plan.reportingScopes = [
      { stableKey: 'nearby-market', label: 'Nearby', kind: 'market', usageEdges: plan.usageEdges.filter(edge => edge.executionNodeKey === 'exec-nearby') },
      { stableKey: 'all-market', label: 'All', kind: 'market', usageEdges: plan.usageEdges },
    ]
    db.insert(measurementPlanVersions).values({ id: 'v', projectId: 'p', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'v', schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: now }).run()
    const runIds = ['r1', 'r2', 'r3', 'r4']
    for (const runId of runIds) {
      db.insert(runs).values({ id: runId, projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: 'v', measurementManifest: buildMeasurementPlanV2Manifest(plan), measurementExecutionIdentity: { schemaVersion: 1, providers: ['gemini', 'openai'], models: {}, checksum: 'a'.repeat(64), language: 'en' }, createdAt: now }).run()
      for (const node of plan.executionNodes) for (const provider of node.context.providers) db.insert(querySnapshots).values({ id: `${runId}-${node.stableKey}-${provider}`, runId, measurementExecutionId: node.stableKey, queryText: node.queryText, provider, model: 'gpt-test', servedModel: 'gpt-test-v1', answerText: 'Harbor Homes and Bayside Homes offer homes.', citationState: 'cited', createdAt: now }).run()
    }
    const parse = vi.mocked(contracts.parseStoredMeasurementPlanAnyVersion)
    const edgeKey = vi.mocked(contracts.measurementV2UsageEdgeKey)
    parse.mockClear(); edgeKey.mockClear()
    const selected = selectSentimentSources(db, 'p', { runIds, queryClass: 'non-brand' })
    expect(selected.assessments).toHaveLength(runIds.length * 4)
    expect(selected.assessments[0]!.edges[0]!.marketKeys).toEqual(['all-market', 'nearby-market'])
    expect(parse).toHaveBeenCalledTimes(1)
    // One key per assignment, usage edge and market member, never one per snapshot, Property and edge.
    const indexSize = plan.assignments.length + plan.usageEdges.length + plan.reportingScopes.reduce((sum, scope) => sum + scope.usageEdges.length, 0)
    expect(edgeKey.mock.calls.length).toBeLessThanOrEqual(indexSize)
  })
})
