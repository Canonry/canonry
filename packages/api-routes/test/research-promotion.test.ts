import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auditLog,
  createClient,
  measurementOperationReceipts,
  measurementPlanDrafts,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  researchRunQueries,
  researchRuns,
  runs,
} from '@ainyc/canonry-db'
import {
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  ResearchQueryStatuses,
  ResearchRunStatuses,
} from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { compileMeasurementDraft } from '../src/measurement-draft-compile.js'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

const NOW = '2026-08-28T00:00:00.000Z'
const PROMOTION_PATH = '/api/v1/projects/project-a/research/runs/research-run-a/queries/research-query-a/promotion-preview'
const FIXTURE_LOCATION = { label: 'Fixture Location', city: 'Fixture City', region: 'FX', country: 'US' }
const SECOND_FIXTURE_LOCATION = { label: 'Second Fixture Location', city: 'Second Fixture City', region: 'SX', country: 'US' }

function harness(locations = [FIXTURE_LOCATION]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-research-promotion-'))
  const db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  db.insert(projects).values([
    {
      id: 'project-a', name: 'project-a', displayName: 'Sample Project', canonicalDomain: 'sample.test',
      country: 'US', language: 'en', providers: ['openai'],
      locations,
      createdAt: NOW, updatedAt: NOW,
    },
    {
      id: 'project-b', name: 'project-b', displayName: 'Other Project', canonicalDomain: 'other.test',
      country: 'US', language: 'en', providers: ['openai'], createdAt: NOW, updatedAt: NOW,
    },
  ]).run()
  db.insert(researchRuns).values({
    id: 'research-run-a', projectId: 'project-a', status: ResearchRunStatuses.completed,
    provider: 'openai', requestedModel: null, resolvedModel: 'test-model', totalQueries: 1,
    completedQueries: 1, failedQueries: 0, createdAt: NOW, finishedAt: NOW,
  }).run()
  db.insert(researchRunQueries).values({
    id: 'research-query-a', researchRunId: 'research-run-a', position: 0, queryText: 'Compare sample options',
    status: ResearchQueryStatuses.completed, requestedModel: null, resolvedModel: 'test-model', servedModel: 'test-model',
    answerText: 'Saved research answer that must not become official evidence.',
    groundingSources: [{ title: 'Saved source', uri: 'https://source.test/item' }],
    citedDomains: ['source.test'], searchQueries: ['sample research'], namedCompetitors: ['Other'],
    citedCompetitorDomains: ['other.test'], answerMentioned: true, citationState: 'cited', createdAt: NOW, finishedAt: NOW,
  }).run()
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { app, db }
}

function readOnlyRows(db: ReturnType<typeof createClient>) {
  return {
    queries: db.select().from(queries).all(),
    runs: db.select().from(runs).all(),
    plans: db.select().from(measurementPlans).all(),
    versions: db.select().from(measurementPlanVersions).all(),
    drafts: db.select().from(measurementPlanDrafts).all(),
    audit: db.select().from(auditLog).all(),
    receipts: db.select().from(measurementOperationReceipts).all(),
  }
}

function activateV2Plan(db: ReturnType<typeof createClient>) {
  db.insert(queries).values([
    { id: 'existing-plan-query', projectId: 'project-a', query: 'Existing sample question', createdAt: NOW },
    { id: 'override-plan-query', projectId: 'project-a', query: 'Override sample question', createdAt: NOW },
  ]).run()
  const compiled = compileMeasurementDraft({
    defaultContext: { providers: ['openai'], models: { openai: 'default-model' }, locations: [] },
    targets: [{
      stableKey: 'target-a', label: 'Target A', status: 'included', aliases: ['Target A'],
      urlMatchers: ['sample.test'], source: 'manual',
    }],
    groups: [{ stableKey: 'group-a', label: 'Group A', targetKeys: ['target-a'], competitors: [] }],
    assignments: [
      {
        targetKey: 'target-a', queryId: 'existing-plan-query', queryClass: 'non-brand', classificationSource: 'operator',
      },
      {
        targetKey: 'target-a', queryId: 'override-plan-query', queryClass: 'branded', classificationSource: 'operator',
        contextOverride: {
          providers: ['openai'], models: { openai: 'override-model' }, locations: ['Fixture Location'],
        },
      },
    ],
  }, {
    canonicalDomain: 'sample.test', ownedDomains: [], brandNames: ['Sample Project'],
    locations: [FIXTURE_LOCATION],
    trackedQueries: [
      { id: 'existing-plan-query', query: 'Existing sample question' },
      { id: 'override-plan-query', query: 'Override sample question' },
    ],
  })
  if (!compiled.ok) throw new Error(`Fixture did not compile: ${JSON.stringify(compiled.checks)}`)
  const plan = compiled.plan
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  const storedPlan = measurementPlanV2Schema.parse(JSON.parse(canonicalJson))
  db.insert(measurementPlanVersions).values({
    id: 'version-v2', projectId: 'project-a', revision: 2, canonicalJson,
    checksum: 'd'.repeat(64), schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId: 'project-a', activeVersionId: 'version-v2', createdAt: NOW, updatedAt: NOW }).run()
  return storedPlan
}

describe('research promotion preview route', () => {
  it('is deterministic and read-semantic: it projects a normalized simple tracked query without copying research evidence', async () => {
    const { app, db } = harness()
    db.insert(queries).values([
      { id: 'query-oldest', projectId: 'project-a', query: ' compare sample options ', createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'query-newer', projectId: 'project-a', query: 'COMPARE SAMPLE OPTIONS', createdAt: '2026-08-02T00:00:00.000Z' },
    ]).run()
    const before = readOnlyRows(db)

    const first = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: {} })
    const second = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: {} })

    expect(first.statusCode, first.body).toBe(200)
    expect(second.statusCode, second.body).toBe(200)
    expect(first.json()).toEqual(second.json())
    expect(first.json()).toMatchObject({
      mode: 'simple',
      source: {
        runId: 'research-run-a', queryId: 'research-query-a', query: 'Compare sample options',
        normalizedQuery: 'compare sample options', status: 'completed', completedAt: NOW,
      },
      trackedQuery: {
        state: 'existing', id: 'query-oldest', query: ' compare sample options ',
        normalizedQuery: 'compare sample options', proposedId: expect.any(String),
      },
      setup: { mode: 'simple', activeRevision: null, activeCompiledChecksum: null, draftEtag: null },
      previewChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(first.json().source).not.toHaveProperty('answerText')
    expect(first.json().source).not.toHaveProperty('groundingSources')
    expect(JSON.stringify(first.json())).not.toContain('Saved research answer')
    expect(readOnlyRows(db)).toEqual(before)
  })

  it('refuses an active v1 plan and an incomplete source without mutating any state', async () => {
    const { app, db } = harness()
    db.insert(measurementPlanVersions).values({
      id: 'version-v1', projectId: 'project-a', revision: 1, canonicalJson: '{}', checksum: 'b'.repeat(64),
      schemaVersion: 1, createdAt: NOW,
    }).run()
    db.insert(measurementPlans).values({ projectId: 'project-a', activeVersionId: 'version-v1', createdAt: NOW, updatedAt: NOW }).run()
    const before = readOnlyRows(db)
    const v1 = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: {} })
    expect(v1.statusCode, v1.body).toBe(200)
    expect(v1.json()).toMatchObject({ mode: 'refused', refusal: { reason: 'active-v1' } })
    expect(readOnlyRows(db)).toEqual(before)

    db.insert(researchRunQueries).values({
      id: 'research-query-incomplete', researchRunId: 'research-run-a', position: 1, queryText: 'Pending sample option',
      status: ResearchQueryStatuses.queued, requestedModel: null, resolvedModel: 'test-model',
      groundingSources: [], citedDomains: [], searchQueries: [], namedCompetitors: [], citedCompetitorDomains: [], createdAt: NOW,
    }).run()
    const incomplete = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/project-a/research/runs/research-run-a/queries/research-query-incomplete/promotion-preview',
      payload: {},
    })
    expect(incomplete.statusCode, incomplete.body).toBe(200)
    expect(incomplete.json()).toMatchObject({ mode: 'refused', refusal: { reason: 'source-not-completed' } })
  })

  it('projects an active v2 audience and research-only provenance without creating a draft or tracked query', async () => {
    const { app, db } = harness()
    const activePlan = activateV2Plan(db)
    const before = readOnlyRows(db)
    const request = { targetKeys: ['target-a'], groupKeys: ['group-a'], queryClass: 'non-brand' }

    const first = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: request })
    const second = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: request })

    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toEqual(second.json())
    expect(first.json()).toMatchObject({
      mode: 'advanced',
      trackedQuery: { state: 'new', id: expect.stringMatching(/^research-promotion-/) },
      audience: { targetKeys: ['target-a'], groups: [{ groupKey: 'group-a', memberCount: 1 }], overlapCount: 1 },
      assignments: { requested: 1, added: 1, alreadyPresent: 0, classifications: [{ targetKey: 'target-a', queryClass: 'non-brand' }] },
      execution: {
        addedNodes: 1, addedProviderCalls: 1,
        fullRunNodes: activePlan.executionNodes.length + 1,
        fullRunProviderCalls: activePlan.executionNodes.reduce((total, node) => total + node.expectedSnapshots, 0) + 1,
      },
      candidate: { plan: { schemaVersion: 2 } },
    })
    const preview = first.json()
    const overrideNode = activePlan.executionNodes.find(node => node.queryId === 'override-plan-query')
    expect(overrideNode?.context).toEqual({
      providers: ['openai'], models: { openai: 'override-model' },
      location: { label: 'Fixture Location', city: 'Fixture City', region: 'FX', country: 'US' },
    })
    expect(preview.candidate.plan.identities).toEqual(activePlan.identities)
    expect(preview.candidate.plan.targets).toEqual(activePlan.targets)
    expect(preview.candidate.plan.groups).toEqual(activePlan.groups)
    expect(preview.candidate.plan.querySnapshots.filter((snapshot: { queryId: string }) => snapshot.queryId !== preview.trackedQuery.id)).toEqual(activePlan.querySnapshots)
    expect(preview.candidate.plan.assignments.filter((assignment: { queryId: string }) => assignment.queryId !== preview.trackedQuery.id)).toEqual(activePlan.assignments)
    expect(preview.candidate.plan.executionNodes.filter((node: { queryId: string }) => node.queryId !== preview.trackedQuery.id)).toEqual(activePlan.executionNodes)
    expect(preview.candidate.plan.usageEdges.filter((edge: { queryId: string }) => edge.queryId !== preview.trackedQuery.id)).toEqual(activePlan.usageEdges)
    expect(preview.candidate.plan.compiledChecksum).toBe(
      crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(preview.candidate.plan)).digest('hex'),
    )
    const promotedSnapshot = preview.candidate.plan.querySnapshots.find((snapshot: { queryId: string }) => snapshot.queryId === preview.trackedQuery.id)
    expect(promotedSnapshot).toMatchObject({
      queryText: 'Compare sample options',
      provenance: { source: 'research', sourceId: 'research-run-a:research-query-a' },
    })
    expect(preview.source).not.toHaveProperty('answerText')
    expect(preview.source).not.toHaveProperty('provider')
    expect(readOnlyRows(db)).toEqual(before)
  })

  it('preserves manual provenance when promotion reuses an unplanned tracked query', async () => {
    const { app, db } = harness()
    activateV2Plan(db)
    db.insert(queries).values({
      id: 'manual-unplanned-query', projectId: 'project-a', query: ' compare sample options ',
      provenance: 'manual', createdAt: '2026-08-03T00:00:00.000Z',
    }).run()

    const response = await app.inject({
      method: 'POST',
      url: PROMOTION_PATH,
      payload: { targetKeys: ['target-a'], queryClass: 'non-brand' },
    })

    expect(response.statusCode, response.body).toBe(200)
    const preview = response.json()
    expect(preview).toMatchObject({
      mode: 'advanced',
      trackedQuery: { state: 'existing', id: 'manual-unplanned-query' },
    })
    const snapshot = preview.candidate.plan.querySnapshots.find(
      (candidate: { queryId: string }) => candidate.queryId === 'manual-unplanned-query',
    )
    expect(snapshot).toMatchObject({
      queryId: 'manual-unplanned-query',
      provenance: { source: 'manual', sourceId: null },
    })
  })

  it('keeps every location-specific assignment and usage edge for the promoted query', async () => {
    const { app, db } = harness([FIXTURE_LOCATION, SECOND_FIXTURE_LOCATION])
    activateV2Plan(db)
    const response = await app.inject({
      method: 'POST',
      url: PROMOTION_PATH,
      payload: { targetKeys: ['target-a'], queryClass: 'non-brand' },
    })

    expect(response.statusCode, response.body).toBe(200)
    const preview = response.json()
    expect(preview).toMatchObject({ mode: 'advanced', execution: { addedNodes: 2, addedProviderCalls: 2 } })
    const promotedAssignments = preview.candidate.plan.assignments.filter((assignment: { queryId: string }) => assignment.queryId === preview.trackedQuery.id)
    const promotedNodes = preview.candidate.plan.executionNodes.filter((node: { queryId: string }) => node.queryId === preview.trackedQuery.id)
    const promotedEdges = preview.candidate.plan.usageEdges.filter((edge: { queryId: string }) => edge.queryId === preview.trackedQuery.id)
    const nodeKeys = promotedNodes.map((node: { stableKey: string }) => node.stableKey).sort()

    expect(promotedNodes).toHaveLength(2)
    expect(promotedAssignments.map((assignment: { executionNodeKey: string }) => assignment.executionNodeKey).sort()).toEqual(nodeKeys)
    expect(promotedEdges.map((edge: { executionNodeKey: string }) => edge.executionNodeKey).sort()).toEqual(nodeKeys)
  })
})
