import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RunStatuses,
  RunTriggers,
  canonicalMeasurementPlanJson,
  canonicalMeasurementPlanV2Json,
  compileMeasurementPlan,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  measurementPlanVersions,
  measurementPlans,
  measurementPlanDrafts,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-08-28T10:00:00.000Z'

let directory: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let projectId: string

function insertProject(): void {
  projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'demo-project',
    displayName: 'Demo Project',
    canonicalDomain: 'demo.example.test',
    ownedDomains: [],
    country: 'US',
    language: 'en',
    locations: [],
    providers: [],
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
}

function insertTrackedQueries(): void {
  db.insert(queries).values([
    { id: 'query-zeta', projectId, query: 'zeta question', createdAt: NOW },
    { id: 'q-nearby', projectId, query: 'homes near harbor', createdAt: NOW },
    { id: 'q-brand', projectId, query: 'northstar reviews', createdAt: NOW },
  ]).run()
}

function insertV2Version(
  revision = 1,
  plan = measurementPlanV2Fixture(),
): { id: string; plan: ReturnType<typeof measurementPlanV2Fixture> } {
  const id = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id,
    projectId,
    revision,
    canonicalJson: canonicalMeasurementPlanV2Json(plan),
    checksum: 'a'.repeat(64),
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    createdAt: NOW,
  }).run()
  return { id, plan }
}

function activate(versionId: string): void {
  db.insert(measurementPlans).values({
    projectId,
    activeVersionId: versionId,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
}

function insertRun(
  versionId: string,
  plan: ReturnType<typeof measurementPlanV2Fixture>,
  values: Partial<typeof runs.$inferInsert> = {},
): string {
  const id = crypto.randomUUID()
  db.insert(runs).values({
    id,
    projectId,
    kind: 'answer-visibility',
    status: RunStatuses.completed,
    trigger: RunTriggers.manual,
    measurementPlanVersionId: versionId,
    measurementManifest: buildMeasurementPlanV2Manifest(plan),
    createdAt: NOW,
    finishedAt: NOW,
    ...values,
  }).run()
  return id
}

function fillRun(
  runId: string,
  plan: ReturnType<typeof measurementPlanV2Fixture>,
  onlyExecutionIds?: readonly string[],
  model?: string,
): void {
  const allowed = onlyExecutionIds ? new Set(onlyExecutionIds) : null
  for (const node of plan.executionNodes) {
    if (allowed && !allowed.has(node.stableKey)) continue
    for (const provider of node.context.providers) {
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(),
        runId,
        queryId: node.queryId,
        queryText: node.queryText,
        provider,
        citationState: 'cited',
        answerMentioned: true,
        citedDomains: [],
        competitorOverlap: [],
        recommendedCompetitors: [],
        measurementExecutionId: node.stableKey,
        requestedContext: node.context.location,
        ...(model ? { model } : {}),
        createdAt: NOW,
      }).run()
    }
  }
}

async function statuses() {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/projects/demo-project/measurement-query-statuses',
  })
  return { status: response.statusCode, body: response.json() }
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-query-statuses-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  insertProject()
  insertTrackedQueries()
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('measurement query statuses', () => {
  it('returns a stable current-query row for every tracked query when no active v2 plan exists', async () => {
    const result = await statuses()

    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      setupMode: 'simple',
      activeRevision: null,
      latestOfficialFullRun: null,
      queries: [
        { queryId: 'q-nearby', status: 'not_in_plan' },
        { queryId: 'q-brand', status: 'not_in_plan' },
        { queryId: 'query-zeta', status: 'not_in_plan' },
      ],
    })
  })

  it('keeps draft-only and v1 setup out of the v2 denominator', async () => {
    db.insert(measurementPlanDrafts).values({
      id: crypto.randomUUID(),
      projectId,
      schemaVersion: 2,
      authoringJson: '{}',
      etagVersion: 1,
      createdBy: 'test',
      updatedBy: 'test',
      createdAt: NOW,
      updatedAt: NOW,
    }).run()

    const draftOnly = await statuses()
    expect(draftOnly.body).toMatchObject({ setupMode: 'simple', activeRevision: null, latestOfficialFullRun: null })
    expect(draftOnly.body.queries.every((row: { status: string }) => row.status === 'not_in_plan')).toBe(true)

    const v1 = compileMeasurementPlan({
      schemaVersion: 1,
      targets: [{
        stableKey: 'demo-target',
        label: 'Demo Target',
        urls: [{ kind: 'host', host: 'demo.example.test' }],
        aliases: ['Demo Target'],
      }],
      groups: [],
      targetQuerySelections: [{ targetKey: 'demo-target', queryIds: ['q-nearby'] }],
    }, {
      canonicalDomain: 'demo.example.test',
      ownedDomains: [],
      brandNames: ['Demo'],
      trackedQueries: [{ id: 'q-nearby', query: 'homes near harbor' }],
      locations: [],
      defaultContext: null,
      expectedSnapshots: 1,
    })
    const versionId = crypto.randomUUID()
    db.insert(measurementPlanVersions).values({
      id: versionId,
      projectId,
      revision: 2,
      canonicalJson: canonicalMeasurementPlanJson(v1),
      checksum: 'b'.repeat(64),
      schemaVersion: 1,
      createdAt: NOW,
    }).run()
    activate(versionId)

    const result = await statuses()
    expect(result.body.setupMode).toBe('active-v1')
    expect(result.body.activeRevision).toBe(2)
    expect(result.body.queries.every((row: { status: string }) => row.status === 'not_in_plan')).toBe(true)
  })

  it('uses only the latest official full terminal run for the active revision', async () => {
    const old = insertV2Version(1)
    const active = insertV2Version(2)
    activate(active.id)
    const oldRun = insertRun(old.id, old.plan, { createdAt: '2026-08-28T09:00:00.000Z' })
    fillRun(oldRun, old.plan)
    insertRun(active.id, active.plan, { status: RunStatuses.queued, createdAt: '2026-08-28T11:00:00.000Z', finishedAt: null })
    insertRun(active.id, active.plan, { status: RunStatuses.failed, createdAt: '2026-08-28T12:00:00.000Z', finishedAt: NOW })
    insertRun(active.id, active.plan, {
      trigger: RunTriggers.probe,
      createdAt: '2026-08-28T13:00:00.000Z',
    })
    insertRun(active.id, active.plan, {
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
      createdAt: '2026-08-28T14:00:00.000Z',
    })

    const result = await statuses()
    expect(result.body.latestOfficialFullRun).toBeNull()
    expect(result.body.queries).toEqual([
      { queryId: 'q-nearby', status: 'awaiting_first_sweep' },
      { queryId: 'q-brand', status: 'awaiting_first_sweep' },
      { queryId: 'query-zeta', status: 'not_in_plan' },
    ])
  })

  it('keeps the last eligible completed full run when newer queued, failed, probe, and scoped runs arrive', async () => {
    const active = insertV2Version()
    activate(active.id)
    const completed = insertRun(active.id, active.plan, { createdAt: '2026-08-28T09:00:00.000Z' })
    fillRun(completed, active.plan)
    insertRun(active.id, active.plan, { status: RunStatuses.queued, createdAt: '2026-08-28T11:00:00.000Z', finishedAt: null })
    insertRun(active.id, active.plan, { status: RunStatuses.failed, createdAt: '2026-08-28T12:00:00.000Z' })
    insertRun(active.id, active.plan, { trigger: RunTriggers.probe, createdAt: '2026-08-28T13:00:00.000Z' })
    insertRun(active.id, active.plan, {
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
      createdAt: '2026-08-28T14:00:00.000Z',
    })

    const result = await statuses()
    expect(result.body.latestOfficialFullRun).toMatchObject({ id: completed, status: 'completed' })
    expect(result.body.queries).toEqual([
      { queryId: 'q-nearby', status: 'measured' },
      { queryId: 'q-brand', status: 'measured' },
      { queryId: 'query-zeta', status: 'not_in_plan' },
    ])
  })

  it('marks a partial terminal run and missing or corrupt execution evidence Partial', async () => {
    const active = insertV2Version()
    activate(active.id)
    const partial = insertRun(active.id, active.plan, { status: RunStatuses.partial })
    fillRun(partial, active.plan)

    const first = await statuses()
    expect(first.body.latestOfficialFullRun).toMatchObject({ id: partial, status: 'partial' })
    expect(first.body.queries.filter((row: { queryId: string }) => row.queryId !== 'query-zeta'))
      .toEqual([{ queryId: 'q-nearby', status: 'partial' }, { queryId: 'q-brand', status: 'partial' }])

    db.update(runs).set({ status: RunStatuses.completed, measurementManifest: null })
      .where(eq(runs.id, partial)).run()
    const missingManifest = await statuses()
    expect(missingManifest.body.queries.filter((row: { queryId: string }) => row.queryId !== 'query-zeta'))
      .toEqual([{ queryId: 'q-nearby', status: 'partial' }, { queryId: 'q-brand', status: 'partial' }])

    db.update(runs).set({ measurementManifest: { schemaVersion: 1, expectedSlots: [] } })
      .where(eq(runs.id, partial)).run()
    const corrupt = await statuses()
    expect(corrupt.body.queries.filter((row: { queryId: string }) => row.queryId !== 'query-zeta'))
      .toEqual([{ queryId: 'q-nearby', status: 'partial' }, { queryId: 'q-brand', status: 'partial' }])
  })

  it('marks only a fully evidenced assigned query Measured and fails missing query slots closed', async () => {
    const active = insertV2Version()
    activate(active.id)
    const runId = insertRun(active.id, active.plan)
    fillRun(runId, active.plan, ['exec-nearby'])

    const partial = await statuses()
    expect(partial.body.latestOfficialFullRun).toMatchObject({ id: runId, status: 'completed' })
    expect(partial.body.queries).toEqual([
      { queryId: 'q-nearby', status: 'measured' },
      { queryId: 'q-brand', status: 'partial' },
      { queryId: 'query-zeta', status: 'not_in_plan' },
    ])

    fillRun(runId, active.plan, ['exec-brand'])
    const completed = await statuses()
    expect(completed.body.queries).toEqual([
      { queryId: 'q-nearby', status: 'measured' },
      { queryId: 'q-brand', status: 'measured' },
      { queryId: 'query-zeta', status: 'not_in_plan' },
    ])
  })

  it('fails a corrupt snapshot closed without erasing another query’s valid evidence', async () => {
    const active = insertV2Version()
    activate(active.id)
    const runId = insertRun(active.id, active.plan)
    fillRun(runId, active.plan)
    const corruptSnapshot = db.select().from(querySnapshots)
      .where(eq(querySnapshots.runId, runId))
      .all()
      .find(snapshot => snapshot.measurementExecutionId === 'exec-brand')
    if (!corruptSnapshot) throw new Error('Expected a demo execution snapshot')
    db.update(querySnapshots).set({ queryText: 'corrupt demo query' })
      .where(eq(querySnapshots.id, corruptSnapshot.id)).run()

    const result = await statuses()

    expect(result.body.queries).toEqual([
      { queryId: 'q-nearby', status: 'measured' },
      { queryId: 'q-brand', status: 'partial' },
      { queryId: 'query-zeta', status: 'not_in_plan' },
    ])
  })

  it('carries a pinned v2 model into the expected manifest and fails substituted snapshots or manifests closed', async () => {
    const fixture = measurementPlanV2Fixture()
    const plan = measurementPlanV2Fixture({
      executionNodes: fixture.executionNodes.map(node => ({
        ...node,
        context: { ...node.context, models: Object.fromEntries(node.context.providers.map(provider => [provider, 'model-a'])) },
      })),
    })
    const active = insertV2Version(1, plan)
    activate(active.id)
    const expected = buildMeasurementPlanV2Manifest(plan)
    expect(expected.expectedSlots.every(slot => slot.requestedModel === 'model-a')).toBe(true)
    const runId = insertRun(active.id, plan)
    fillRun(runId, plan, undefined, 'model-a')

    const matching = await statuses()
    expect(matching.body.queries).toEqual([
      { queryId: 'q-nearby', status: 'measured' },
      { queryId: 'q-brand', status: 'measured' },
      { queryId: 'query-zeta', status: 'not_in_plan' },
    ])

    db.update(querySnapshots).set({ model: 'model-b' })
      .where(eq(querySnapshots.runId, runId)).run()
    const substitutedSnapshots = await statuses()
    expect(substitutedSnapshots.body.queries).toEqual([
      { queryId: 'q-nearby', status: 'partial' },
      { queryId: 'q-brand', status: 'partial' },
      { queryId: 'query-zeta', status: 'not_in_plan' },
    ])

    db.update(runs).set({
      measurementManifest: {
        ...expected,
        expectedSlots: expected.expectedSlots.map(slot => ({ ...slot, requestedModel: 'model-b' })),
      },
    }).where(eq(runs.id, runId)).run()

    const substitutedManifest = await statuses()

    expect(substitutedManifest.body.queries).toEqual([
      { queryId: 'q-nearby', status: 'partial' },
      { queryId: 'q-brand', status: 'partial' },
      { queryId: 'query-zeta', status: 'not_in_plan' },
    ])
  })

  it.each([null, '', '   '])('fails an otherwise complete terminal sweep closed when it contains an unbound snapshot (%j)', async (measurementExecutionId) => {
    const active = insertV2Version()
    activate(active.id)
    const runId = insertRun(active.id, active.plan)
    fillRun(runId, active.plan)
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      queryId: 'q-nearby',
      queryText: 'homes near harbor',
      provider: 'openai',
      citationState: 'cited',
      answerMentioned: true,
      citedDomains: [],
      competitorOverlap: [],
      recommendedCompetitors: [],
      measurementExecutionId,
      requestedContext: null,
      createdAt: NOW,
    }).run()

    const result = await statuses()

    expect(result.body.queries).toEqual([
      { queryId: 'q-nearby', status: 'partial' },
      { queryId: 'q-brand', status: 'partial' },
      { queryId: 'query-zeta', status: 'not_in_plan' },
    ])
  })
})
