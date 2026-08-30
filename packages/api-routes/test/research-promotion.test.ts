import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyReply } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apiKeys,
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
  parseStoredMeasurementPlanAnyVersion,
  ResearchQueryStatuses,
  ResearchRunStatuses,
} from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { buildResearchPromotionPreview } from '../src/research.js'
import { compileMeasurementDraft } from '../src/measurement-draft-compile.js'
import {
  MEASUREMENT_RECEIPT_TTL_MS,
  replayReceipt,
  sweepExpiredMeasurementReceipts,
  writeReceipt,
} from '../src/measurement-draft-repo.js'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

const NOW = '2026-08-28T00:00:00.000Z'
const PROMOTION_PATH = '/api/v1/projects/project-a/research/runs/research-run-a/queries/research-query-a/promotion-preview'
const PROMOTION_COMMIT_PATH = '/api/v1/projects/project-a/research/runs/research-run-a/queries/research-query-a/promotion'
const FIXTURE_LOCATION = { label: 'Fixture Location', city: 'Fixture City', region: 'FX', country: 'US' }
const SECOND_FIXTURE_LOCATION = { label: 'Second Fixture Location', city: 'Second Fixture City', region: 'SX', country: 'US' }

function harness(
  locations = [FIXTURE_LOCATION],
  opts: { skipAuth?: boolean } = {},
) {
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
  app.register(apiRoutes, { db, skipAuth: opts.skipAuth ?? true })
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { app, db }
}

function seedKey(db: ReturnType<typeof createClient>, token: string, scopes: string[]) {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: token,
    keyHash: hashApiKey(token),
    keyPrefix: token.slice(0, 9),
    scopes,
    projectId: null,
    createdAt: NOW,
  }).run()
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

describe('research promotion receipt helper', () => {
  it('replays an unexpired receipt but filters an expired receipt before replay', () => {
    const { db } = harness()
    const reply = { status: vi.fn() } as unknown as FastifyReply
    const fresh = { operation: 'research-promotion.commit', key: 'fresh-key', checksum: 'a'.repeat(64) }
    const expired = { operation: 'research-promotion.commit', key: 'expired-key', checksum: 'b'.repeat(64) }

    writeReceipt(db, 'project-a', fresh, { result: 'fresh' }, 200, new Date())
    writeReceipt(db, 'project-a', expired, { result: 'expired' }, 200, new Date('2000-01-01T00:00:00.000Z'))

    expect(replayReceipt(db, 'project-a', fresh, reply)).toEqual({ result: 'fresh' })
    expect(replayReceipt(db, 'project-a', expired, reply)).toBeNull()
  })

  it('sweeps a receipt that expires exactly at the replay cutoff', () => {
    const { db } = harness()
    const cutoff = new Date('2026-08-28T00:00:00.000Z')
    const lookup = { operation: 'research-promotion.commit', key: 'cutoff-key', checksum: 'c'.repeat(64) }
    writeReceipt(db, 'project-a', lookup, { result: 'cutoff' }, 200, new Date(cutoff.getTime() - MEASUREMENT_RECEIPT_TTL_MS))

    expect(db.select().from(measurementOperationReceipts).all()).toMatchObject([{ expiresAt: cutoff.toISOString() }])
    expect(sweepExpiredMeasurementReceipts(db, cutoff)).toBe(1)
    expect(db.select().from(measurementOperationReceipts).all()).toEqual([])
  })
})

describe('research promotion commit route', () => {
  it('requires measurement-plan.write before an idempotency receipt can replay', async () => {
    const { app, db } = harness(undefined, { skipAuth: false })
    const planWriter = 'cnry_sample_plan_writer'
    const unrelatedWriter = 'cnry_sample_keys_writer'
    seedKey(db, planWriter, ['measurement-plan.write'])
    seedKey(db, unrelatedWriter, ['keys.write'])
    const preview = await app.inject({
      method: 'POST', url: PROMOTION_PATH,
      headers: { authorization: `Bearer ${planWriter}` }, payload: {},
    })
    expect(preview.statusCode, preview.body).toBe(200)
    const payload = { previewChecksum: preview.json().previewChecksum, request: {} }
    const headers = { authorization: `Bearer ${planWriter}`, 'idempotency-key': 'scope-before-replay' }
    const allowed = await app.inject({ method: 'POST', url: PROMOTION_COMMIT_PATH, headers, payload })
    expect(allowed.statusCode, allowed.body).toBe(200)

    const denied = await app.inject({
      method: 'POST', url: PROMOTION_COMMIT_PATH,
      headers: { authorization: `Bearer ${unrelatedWriter}`, 'idempotency-key': 'scope-before-replay' },
      payload,
    })
    expect(denied.statusCode, denied.body).toBe(403)
    expect(db.select().from(auditLog).all()).toHaveLength(1)
  })

  it('creates a simple tracked query atomically and stores a replayable receipt', async () => {
    const { app, db } = harness()
    const preview = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: {} })
    expect(preview.statusCode, preview.body).toBe(200)

    const missingKey = await app.inject({
      method: 'POST', url: PROMOTION_COMMIT_PATH,
      payload: { previewChecksum: preview.json().previewChecksum, request: {} },
    })
    expect(missingKey.statusCode, missingKey.body).toBe(400)
    expect(readOnlyRows(db)).toEqual({
      ...readOnlyRows(db), queries: [], audit: [], receipts: [],
    })

    const response = await app.inject({
      method: 'POST',
      url: PROMOTION_COMMIT_PATH,
      headers: { 'idempotency-key': 'research-promotion-simple-create' },
      payload: { previewChecksum: preview.json().previewChecksum, request: {} },
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      status: 'tracked-awaiting-first-sweep',
      mode: 'simple',
      publishedRevision: null,
      compiledChecksum: null,
      trackedQuery: { state: 'new', query: 'Compare sample options' },
    })
    expect(db.select().from(queries).all()).toMatchObject([
      { query: 'Compare sample options', provenance: 'research:research-run-a:research-query-a' },
    ])
    expect(db.select().from(measurementOperationReceipts).all()).toMatchObject([
      { operation: 'research-promotion.commit', idempotencyKey: 'research-promotion-simple-create' },
    ])
    expect(db.select().from(runs).all()).toEqual([])
  })

  it('allows a completed row from an otherwise partial research batch', async () => {
    const { app, db } = harness()
    db.update(researchRuns).set({ status: ResearchRunStatuses.partial, failedQueries: 1 }).where(eq(researchRuns.id, 'research-run-a')).run()
    const preview = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: {} })
    const response = await app.inject({
      method: 'POST', url: PROMOTION_COMMIT_PATH, headers: { 'idempotency-key': 'research-promotion-partial-row' },
      payload: { previewChecksum: preview.json().previewChecksum, request: {} },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ status: 'tracked-awaiting-first-sweep', mode: 'simple' })
  })

  it('replays an identical key before checking current state, but refuses that key for another source', async () => {
    const { app, db } = harness()
    db.insert(researchRunQueries).values({
      id: 'research-query-b', researchRunId: 'research-run-a', position: 1, queryText: 'Second sample option',
      status: ResearchQueryStatuses.completed, requestedModel: null, resolvedModel: 'test-model', servedModel: 'test-model',
      answerText: 'A second saved answer.', groundingSources: [], citedDomains: [], searchQueries: [], namedCompetitors: [],
      citedCompetitorDomains: [], answerMentioned: false, citationState: 'not-cited', createdAt: NOW, finishedAt: NOW,
    }).run()
    const firstPreview = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: {} })
    const key = 'research-promotion-replay'
    const firstPayload = { previewChecksum: firstPreview.json().previewChecksum, request: {} }
    const first = await app.inject({ method: 'POST', url: PROMOTION_COMMIT_PATH, headers: { 'idempotency-key': key }, payload: firstPayload })
    expect(first.statusCode, first.body).toBe(200)

    // The receipt wins even though the current source state now sees an
    // already-tracked query, so a lost client response is always recoverable.
    const replay = await app.inject({ method: 'POST', url: PROMOTION_COMMIT_PATH, headers: { 'idempotency-key': key }, payload: firstPayload })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(first.json())
    expect(db.select().from(queries).all()).toHaveLength(1)
    expect(db.select().from(auditLog).all()).toHaveLength(1)

    const secondPreview = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/project-a/research/runs/research-run-a/queries/research-query-b/promotion-preview',
      payload: {},
    })
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/project-a/research/runs/research-run-a/queries/research-query-b/promotion',
      headers: { 'idempotency-key': key },
      payload: { previewChecksum: secondPreview.json().previewChecksum, request: {} },
    })
    expect(conflict.statusCode, conflict.body).toBe(409)
    expect(conflict.json()).toMatchObject({ error: { code: 'MEASUREMENT_IDEMPOTENCY_KEY_CONFLICT' } })
    expect(db.select().from(queries).all()).toHaveLength(1)

    const changedBodyPreview = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: { targetKeys: ['target-a'] } })
    const changedBody = await app.inject({
      method: 'POST', url: PROMOTION_COMMIT_PATH, headers: { 'idempotency-key': key },
      payload: { previewChecksum: changedBodyPreview.json().previewChecksum, request: { targetKeys: ['target-a'] } },
    })
    expect(changedBody.statusCode, changedBody.body).toBe(409)
    expect(changedBody.json()).toMatchObject({ error: { code: 'MEASUREMENT_IDEMPOTENCY_KEY_CONFLICT' } })
  })

  it('reuses the oldest normalized tracked query without changing its manual provenance', async () => {
    const { app, db } = harness()
    db.insert(queries).values([
      { id: 'manual-oldest', projectId: 'project-a', query: ' compare sample options ', provenance: 'manual', createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'manual-newer', projectId: 'project-a', query: 'COMPARE SAMPLE OPTIONS', provenance: 'manual', createdAt: '2026-08-02T00:00:00.000Z' },
    ]).run()
    const preview = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: {} })
    const response = await app.inject({
      method: 'POST', url: PROMOTION_COMMIT_PATH, headers: { 'idempotency-key': 'research-promotion-dedupe' },
      payload: { previewChecksum: preview.json().previewChecksum, request: {} },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      status: 'already-tracked',
      mode: 'simple',
      trackedQuery: { state: 'existing', id: 'manual-oldest' },
      publishedRevision: null,
      compiledChecksum: null,
    })
    expect(db.select().from(queries).all()).toMatchObject([
      { id: 'manual-oldest', provenance: 'manual' },
      { id: 'manual-newer', provenance: 'manual' },
    ])
  })

  it('returns an advanced no-op for an already-assigned query without moving the active pointer', async () => {
    const { app, db } = harness()
    activateV2Plan(db)
    db.update(researchRunQueries).set({ queryText: 'Existing sample question' })
      .where(eq(researchRunQueries.id, 'research-query-a')).run()
    const request = { targetKeys: ['target-a'], queryClass: 'non-brand' }
    const preview = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: request })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({
      mode: 'advanced',
      trackedQuery: { state: 'existing', id: 'existing-plan-query' },
      assignments: { added: 0, alreadyPresent: 1 },
    })

    const before = readOnlyRows(db)
    const payload = { previewChecksum: preview.json().previewChecksum, request }
    const commits = await Promise.all([
      app.inject({ method: 'POST', url: PROMOTION_COMMIT_PATH, headers: { 'idempotency-key': 'already-assigned-a' }, payload }),
      app.inject({ method: 'POST', url: PROMOTION_COMMIT_PATH, headers: { 'idempotency-key': 'already-assigned-b' }, payload }),
    ])

    for (const response of commits) {
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toMatchObject({
        status: 'already-tracked',
        mode: 'advanced',
        trackedQuery: { state: 'existing', id: 'existing-plan-query' },
        publishedRevision: null,
        compiledChecksum: null,
      })
    }
    expect(db.select().from(measurementPlans).where(eq(measurementPlans.projectId, 'project-a')).get()).toEqual(before.plans[0])
    expect(db.select().from(measurementPlanVersions).all()).toEqual(before.versions)
    expect(db.select().from(queries).all()).toEqual(before.queries)
    expect(db.select().from(measurementOperationReceipts).all()).toHaveLength(2)
  })

  it('uses the promotion-preview conflict for a stale simple projection', async () => {
    const { app, db } = harness()
    const preview = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: {} })
    expect(preview.statusCode, preview.body).toBe(200)
    db.insert(queries).values({
      id: 'concurrent-tracked-query', projectId: 'project-a', query: 'Compare sample options', createdAt: NOW,
    }).run()
    const before = readOnlyRows(db)

    const response = await app.inject({
      method: 'POST',
      url: PROMOTION_COMMIT_PATH,
      headers: { 'idempotency-key': 'stale-simple-preview' },
      payload: { previewChecksum: preview.json().previewChecksum, request: {} },
    })

    expect(response.statusCode, response.body).toBe(409)
    expect(response.json()).toMatchObject({
      error: {
        code: 'RESEARCH_PROMOTION_PREVIEW_CONFLICT',
        details: { expectedPreviewChecksum: preview.json().previewChecksum, actualPreviewChecksum: expect.any(String) },
      },
    })
    expect(readOnlyRows(db)).toEqual(before)
  })

  it('keeps a comparable completed run operational in the promotion setup projection', async () => {
    const { app, db } = harness()
    const activePlan = activateV2Plan(db)
    db.insert(measurementPlanVersions).values({
      id: 'version-v3',
      projectId: 'project-a',
      revision: 3,
      canonicalJson: canonicalMeasurementPlanV2Json(activePlan),
      checksum: 'e'.repeat(64),
      schemaVersion: 2,
      compiledChecksum: activePlan.compiledChecksum,
      comparableToVersionId: 'version-v2',
      createdAt: NOW,
    }).run()
    db.update(measurementPlans).set({ activeVersionId: 'version-v3', updatedAt: NOW })
      .where(eq(measurementPlans.projectId, 'project-a')).run()
    db.insert(runs).values({
      id: 'completed-comparable-run',
      projectId: 'project-a',
      status: 'completed',
      measurementPlanVersionId: 'version-v2',
      createdAt: NOW,
    }).run()

    const preview = await app.inject({
      method: 'POST',
      url: PROMOTION_PATH,
      payload: { targetKeys: ['target-a'], queryClass: 'non-brand' },
    })

    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ mode: 'advanced', setup: { state: 'operational', activeRevision: 3 } })
  })

  it('preserves research provenance when a simply promoted query is assigned to v2 later', async () => {
    const { app, db } = harness()
    const simplePreview = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: {} })
    const simple = await app.inject({
      method: 'POST', url: PROMOTION_COMMIT_PATH, headers: { 'idempotency-key': 'simple-before-v2' },
      payload: { previewChecksum: simplePreview.json().previewChecksum, request: {} },
    })
    expect(simple.statusCode, simple.body).toBe(200)
    const queryId = simple.json().trackedQuery.id as string
    expect(db.select().from(queries).where(eq(queries.id, queryId)).get()).toMatchObject({
      provenance: 'research:research-run-a:research-query-a',
    })

    activateV2Plan(db)
    const request = { targetKeys: ['target-a'], queryClass: 'non-brand' }
    const advancedPreview = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: request })
    expect(advancedPreview.json()).toMatchObject({ mode: 'advanced', trackedQuery: { state: 'existing', id: queryId } })
    const advanced = await app.inject({
      method: 'POST', url: PROMOTION_COMMIT_PATH, headers: { 'idempotency-key': 'research-provenance-v2' },
      payload: { previewChecksum: advancedPreview.json().previewChecksum, request },
    })
    expect(advanced.statusCode, advanced.body).toBe(200)

    const active = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, 'project-a')).get()!
    const version = db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, active.activeVersionId)).get()!
    const plan = parseStoredMeasurementPlanAnyVersion(version.canonicalJson)
    if (plan.schemaVersion !== 2) throw new Error('Expected v2 plan')
    expect(plan.querySnapshots.find(snapshot => snapshot.queryId === queryId)).toMatchObject({
      provenance: { source: 'research', sourceId: 'research-run-a:research-query-a' },
    })
  })

  it('publishes the exact advanced group/target/class projection with every location node and no research evidence', async () => {
    const { app, db } = harness([FIXTURE_LOCATION, SECOND_FIXTURE_LOCATION])
    const activePlan = activateV2Plan(db)
    const request = { targetKeys: ['target-a'], groupKeys: ['group-a'], queryClass: 'non-brand' }
    const previewResponse = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: request })
    expect(previewResponse.statusCode, previewResponse.body).toBe(200)
    const preview = previewResponse.json()
    const repeatedPreview = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: request })
    expect(repeatedPreview.json()).toEqual(preview)
    const project = db.select().from(projects).where(eq(projects.id, 'project-a')).get()!
    expect(db.transaction(tx => buildResearchPromotionPreview(tx, project, 'research-run-a', 'research-query-a', request, {}))).toEqual(preview)
    const response = await app.inject({
      method: 'POST', url: PROMOTION_COMMIT_PATH, headers: { 'idempotency-key': 'research-promotion-advanced' },
      payload: { previewChecksum: preview.previewChecksum, request },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      status: 'tracked-awaiting-first-sweep', mode: 'advanced', publishedRevision: 3,
      compiledChecksum: preview.candidate.compiledChecksum,
    })
    const active = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, 'project-a')).get()!
    const published = db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, active.activeVersionId)).get()!
    const plan = parseStoredMeasurementPlanAnyVersion(published.canonicalJson)
    expect(plan).toEqual(preview.candidate.plan)
    expect(plan.schemaVersion).toBe(2)
    if (plan.schemaVersion !== 2) throw new Error('Expected v2 plan')
    const promotedAssignments = plan.assignments.filter(assignment => assignment.queryId === response.json().trackedQuery.id)
    const promotedNodes = plan.executionNodes.filter(node => node.queryId === response.json().trackedQuery.id)
    const promotedEdges = plan.usageEdges.filter(edge => edge.queryId === response.json().trackedQuery.id)
    expect(promotedAssignments).toHaveLength(2)
    expect(promotedNodes).toHaveLength(2)
    expect(promotedEdges).toHaveLength(2)
    expect(promotedAssignments.every(assignment => assignment.queryClass === 'non-brand')).toBe(true)
    expect(plan.querySnapshots.find(snapshot => snapshot.queryId === response.json().trackedQuery.id)).toMatchObject({
      provenance: { source: 'research', sourceId: 'research-run-a:research-query-a' },
    })
    expect(plan.executionNodes.filter(node => node.queryId !== response.json().trackedQuery.id)).toEqual(activePlan.executionNodes)
    const official = JSON.stringify({ plan, queries: db.select().from(queries).all(), runs: db.select().from(runs).all() })
    expect(official).not.toContain('Saved research answer that must not become official evidence.')
    expect(official).not.toContain('https://source.test/item')
    expect(db.select().from(runs).all()).toEqual([])
  })

  it('keeps an existing manual query and its frozen plan provenance manual', async () => {
    const { app, db } = harness()
    activateV2Plan(db)
    db.insert(queries).values({
      id: 'manual-unplanned-query', projectId: 'project-a', query: ' compare sample options ', provenance: 'manual', createdAt: NOW,
    }).run()
    const request = { targetKeys: ['target-a'], queryClass: 'non-brand' }
    const preview = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: request })
    const response = await app.inject({
      method: 'POST', url: PROMOTION_COMMIT_PATH, headers: { 'idempotency-key': 'research-promotion-manual-reuse' },
      payload: { previewChecksum: preview.json().previewChecksum, request },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ mode: 'advanced', trackedQuery: { state: 'existing', id: 'manual-unplanned-query' } })
    expect(db.select().from(queries).where(eq(queries.id, 'manual-unplanned-query')).get()).toMatchObject({ provenance: 'manual' })
    const active = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, 'project-a')).get()!
    const version = db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, active.activeVersionId)).get()!
    const plan = parseStoredMeasurementPlanAnyVersion(version.canonicalJson)
    if (plan.schemaVersion !== 2) throw new Error('Expected v2 plan')
    expect(plan.querySnapshots.find(snapshot => snapshot.queryId === 'manual-unplanned-query')).toMatchObject({
      provenance: { source: 'manual', sourceId: null },
    })
  })

  it('does not replay an expired receipt: it performs a fresh deduplicated promotion', async () => {
    const { app, db } = harness()
    db.insert(queries).values({
      id: 'existing-query', projectId: 'project-a', query: 'Compare sample options', provenance: 'manual', createdAt: NOW,
    }).run()
    const preview = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: {} })
    const payload = { previewChecksum: preview.json().previewChecksum, request: {} }
    const headers = { 'idempotency-key': 'expired-research-promotion' }
    const first = await app.inject({ method: 'POST', url: PROMOTION_COMMIT_PATH, headers, payload })
    expect(first.statusCode, first.body).toBe(200)
    db.update(measurementOperationReceipts).set({ expiresAt: '2000-01-01T00:00:00.000Z' }).run()

    const retried = await app.inject({ method: 'POST', url: PROMOTION_COMMIT_PATH, headers, payload })
    expect(retried.statusCode, retried.body).toBe(200)
    expect(db.select().from(auditLog).all()).toHaveLength(2)
    expect(db.select().from(measurementOperationReceipts).all()).toMatchObject([
      { idempotencyKey: 'expired-research-promotion' },
    ])
    expect(db.select().from(measurementOperationReceipts).all()[0]?.expiresAt).not.toBe('2000-01-01T00:00:00.000Z')
  })

  it('refuses stale previews and an intervening draft without partial writes', async () => {
    const { app, db } = harness()
    activateV2Plan(db)
    const request = { targetKeys: ['target-a'], queryClass: 'non-brand' }
    const stalePreview = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: request })
    db.update(measurementPlanVersions).set({ compiledChecksum: 'e'.repeat(64) })
      .where(eq(measurementPlanVersions.id, 'version-v2')).run()
    const beforeStale = readOnlyRows(db)
    const stale = await app.inject({
      method: 'POST', url: PROMOTION_COMMIT_PATH, headers: { 'idempotency-key': 'research-promotion-stale' },
      payload: { previewChecksum: stalePreview.json().previewChecksum, request },
    })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(readOnlyRows(db)).toEqual(beforeStale)

    const freshPreview = await app.inject({ method: 'POST', url: PROMOTION_PATH, payload: request })
    db.insert(measurementPlanDrafts).values({
      id: 'intervening-draft', projectId: 'project-a', schemaVersion: 2, baseActiveVersionId: 'version-v2', baseActiveRevision: 2,
      authoringJson: '{}', etagVersion: 1, createdBy: 'system', updatedBy: 'system', createdAt: NOW, updatedAt: NOW,
    }).run()
    const beforeDraftConflict = readOnlyRows(db)
    const draftConflict = await app.inject({
      method: 'POST', url: PROMOTION_COMMIT_PATH, headers: { 'idempotency-key': 'research-promotion-draft' },
      payload: { previewChecksum: freshPreview.json().previewChecksum, request },
    })
    expect(draftConflict.statusCode, draftConflict.body).toBe(409)
    expect(readOnlyRows(db)).toEqual(beforeDraftConflict)
  })

  it('refuses missing, foreign, incomplete, v1, draft-only, and existing-draft sources before writes', async () => {
    const cases: Array<(db: ReturnType<typeof createClient>) => { path: string; request?: Record<string, unknown> }> = [
      () => ({ path: '/api/v1/projects/project-a/research/runs/missing/queries/research-query-a/promotion' }),
      (db) => {
        db.insert(researchRuns).values({ id: 'foreign-run', projectId: 'project-b', status: ResearchRunStatuses.completed, provider: 'openai', requestedModel: null, resolvedModel: 'test-model', totalQueries: 1, completedQueries: 1, failedQueries: 0, createdAt: NOW, finishedAt: NOW }).run()
        db.insert(researchRunQueries).values({ id: 'foreign-query', researchRunId: 'foreign-run', position: 0, queryText: 'Foreign sample', status: ResearchQueryStatuses.completed, requestedModel: null, resolvedModel: 'test-model', groundingSources: [], citedDomains: [], searchQueries: [], namedCompetitors: [], citedCompetitorDomains: [], createdAt: NOW, finishedAt: NOW }).run()
        return { path: '/api/v1/projects/project-a/research/runs/foreign-run/queries/foreign-query/promotion' }
      },
      (db) => {
        db.update(researchRunQueries).set({ status: ResearchQueryStatuses.queued }).where(eq(researchRunQueries.id, 'research-query-a')).run()
        return { path: PROMOTION_COMMIT_PATH }
      },
      (db) => {
        db.insert(measurementPlanVersions).values({ id: 'v1', projectId: 'project-a', revision: 1, canonicalJson: '{}', checksum: 'a'.repeat(64), schemaVersion: 1, createdAt: NOW }).run()
        db.insert(measurementPlans).values({ projectId: 'project-a', activeVersionId: 'v1', createdAt: NOW, updatedAt: NOW }).run()
        return { path: PROMOTION_COMMIT_PATH }
      },
      (db) => {
        db.insert(measurementPlanDrafts).values({ id: 'draft-only', projectId: 'project-a', schemaVersion: 2, baseActiveVersionId: null, baseActiveRevision: null, authoringJson: '{}', etagVersion: 1, createdBy: 'system', updatedBy: 'system', createdAt: NOW, updatedAt: NOW }).run()
        return { path: PROMOTION_COMMIT_PATH }
      },
      (db) => {
        activateV2Plan(db)
        db.insert(measurementPlanDrafts).values({ id: 'active-draft', projectId: 'project-a', schemaVersion: 2, baseActiveVersionId: 'version-v2', baseActiveRevision: 2, authoringJson: '{}', etagVersion: 1, createdBy: 'system', updatedBy: 'system', createdAt: NOW, updatedAt: NOW }).run()
        return { path: PROMOTION_COMMIT_PATH, request: { targetKeys: ['target-a'], queryClass: 'non-brand' } }
      },
    ]

    for (const [index, setup] of cases.entries()) {
      const { app, db } = harness()
      const { path, request = {} } = setup(db)
      const previewPath = path.replace(/\/promotion$/, '/promotion-preview')
      const preview = await app.inject({ method: 'POST', url: previewPath, payload: request })
      const before = readOnlyRows(db)
      const commit = await app.inject({
        method: 'POST', url: path, headers: { 'idempotency-key': `research-promotion-refusal-${index}` },
        payload: { previewChecksum: preview.statusCode === 200 ? preview.json().previewChecksum : 'a'.repeat(64), request },
      })
      expect(commit.statusCode, commit.body).toBeGreaterThanOrEqual(400)
      expect(readOnlyRows(db)).toEqual(before)
    }
  })
})
