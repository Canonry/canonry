import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  canonicalMeasurementPlanV2Json, parseMeasurementRunManifestV1, runPreviewDtoSchema,
  RunKinds, RunTriggers, type RunPreviewDto,
} from '@canonry/canonry-contracts'
import {
  apiKeys, auditLog, createClient, measurementPlanDrafts, measurementPlans, measurementPlanVersions,
  migrate, projects, queries, runs,
} from '@canonry/canonry-db'
import { apiRoutes, queueRunIfProjectIdle } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { MEASUREMENT_PLAN_WRITE_SCOPE } from '../src/measurement-plan.js'
import { HARBOR_CONTEXT, measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const AT = '2026-09-01T12:00:00.000Z'
const READ = 'cnry_sweep_preview_read'
const WRITE = 'cnry_sweep_preview_write'
const EMPTY_DRAFT = JSON.stringify({ defaultContext: { providers: ['openai'], locations: [] }, targets: [], assignments: [], groups: [] })

async function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-run-preview-'))
  const db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  const dispatched: string[] = []
  const requestErrors: string[] = []
  let available = ['openai', 'gemini']
  const app = Fastify()
  app.addHook('onError', async (_request, _reply, error) => { requestErrors.push(error.message) })
  app.register(apiRoutes, {
    db, getRunnableProviderNames: () => available,
    getEffectiveProviderModels: () => ({ openai: 'gpt-5', gemini: 'gemini-2.5-flash' }),
    onRunCreated: (id: string) => { dispatched.push(id) },
  })
  await app.ready()
  onTestFinished(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  for (const name of ['northstar', 'other']) db.insert(projects).values({
    id: name, name, displayName: 'Northstar', canonicalDomain: 'northstar.example',
    country: 'US', language: 'en', providers: ['openai', 'gemini'],
    locations: [HARBOR_CONTEXT], defaultLocation: HARBOR_CONTEXT.label,
    createdAt: AT, updatedAt: AT,
  }).run()
  for (const [key, scopes] of [[READ, ['read']], [WRITE, ['read', 'runs.write']]] as const) db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: key, keyHash: hashApiKey(key), keyPrefix: key.slice(0, 9), scopes: [...scopes], projectId: 'northstar', createdAt: AT,
  }).run()
  db.insert(queries).values([
    { id: 'generic-a', projectId: 'northstar', query: 'best nearby service', createdAt: AT },
    { id: 'generic-b', projectId: 'northstar', query: 'find a local service', createdAt: AT },
    { id: 'branded', projectId: 'northstar', query: 'is Northstar reliable', createdAt: AT },
  ]).run()
  const preview = async (name = 'northstar') => app.inject({ method: 'GET', url: `/api/v1/projects/${name}/run-preview`, headers: { authorization: `Bearer ${READ}` } })
  const launch = async () => app.inject({ method: 'POST', url: '/api/v1/projects/northstar/runs', payload: {}, headers: { authorization: `Bearer ${WRITE}` } })
  return { app, db, preview, launch, dispatched, requestErrors, setAvailable: (value: string[]) => { available = value } }
}

describe('stored manual sweep preview', () => {
  it('projects saved Simple defaults and classes without dispatching or writing, then launches with the same location', async () => {
    const { db, preview, launch, dispatched } = await harness()
    const response = await preview()
    expect(response.statusCode, response.body).toBe(200)
    const body = runPreviewDtoSchema.parse(response.json())
    expect(body).toEqual({
      mode: 'simple', revision: null, queryCount: 3, assignmentCount: null,
      queryClasses: [
        { queryClass: 'non-brand', queryCount: 2, assignmentCount: null },
        { queryClass: 'branded', queryCount: 1, assignmentCount: null },
        { queryClass: 'unknown', queryCount: 0, assignmentCount: null },
      ],
      requestCount: 6, expectedRequestCount: 6,
      engines: [
        { provider: 'gemini', models: ['gemini-2.5-flash'], requestCount: 3, expectedRequestCount: 3, available: true },
        { provider: 'openai', models: ['gpt-5'], requestCount: 3, expectedRequestCount: 3, available: true },
      ],
      locations: [{ location: HARBOR_CONTEXT.label, requestCount: 6 }],
      admission: { refused: false, retryAfter: null, providers: {} }, activeRunId: null, canStart: true, blockedReason: null,
    })
    expect(db.select().from(runs).all()).toEqual([])
    expect(db.select().from(auditLog).all()).toEqual([])
    expect(dispatched).toEqual([])
    const started = await launch()
    expect(started.statusCode, started.body).toBe(201)
    expect(started.json()).toMatchObject({ location: HARBOR_CONTEXT.label, kind: RunKinds['answer-visibility'] })
    expect(dispatched).toEqual([started.json().id])
    expect((await preview()).json()).toMatchObject({ canStart: false, blockedReason: 'run-in-progress', activeRunId: started.json().id })
  })

  it('keeps unavailable engines in the planned total and never lets a project key inspect another project', async () => {
    const { preview, setAvailable } = await harness()
    setAvailable(['openai'])
    const body = (await preview()).json<RunPreviewDto>()
    expect(body).toMatchObject({ requestCount: 3, expectedRequestCount: 6, canStart: true })
    expect(body.engines).toContainEqual({ provider: 'gemini', models: ['gemini-2.5-flash'], requestCount: 0, expectedRequestCount: 3, available: false })
    expect((await preview('other')).statusCode).toBe(403)
    setAvailable([])
    expect((await preview()).json()).toMatchObject({ requestCount: 0, expectedRequestCount: 6, canStart: false, blockedReason: 'no-provider' })
  })

  it('deduplicates equivalent Advanced requests while retaining every assignment and its frozen class', async () => {
    const { db, preview, launch } = await harness()
    const base = measurementPlanV2Fixture()
    const reusedNode = 'exec-nearby-reused'
    const plan = measurementPlanV2Fixture({
      executionNodes: [...base.executionNodes, { ...base.executionNodes[0]!, stableKey: reusedNode }],
      assignments: base.assignments.map(assignment => assignment.targetKey === 'bayside'
        ? { ...assignment, executionNodeKey: reusedNode, queryClass: 'branded' }
        : assignment),
      usageEdges: base.usageEdges.map(edge => edge.targetKey === 'bayside' ? { ...edge, executionNodeKey: reusedNode } : edge),
    })
    db.insert(measurementPlanVersions).values({ id: 'v4', projectId: 'northstar', revision: 4, schemaVersion: 2, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'a'.repeat(64), compiledChecksum: plan.compiledChecksum, createdAt: AT }).run()
    db.insert(measurementPlans).values({ projectId: 'northstar', activeVersionId: 'v4', createdAt: AT, updatedAt: AT }).run()
    // Advanced measures frozen assignments even after the live query library changes.
    db.delete(queries).where(eq(queries.projectId, 'northstar')).run()
    const body = (await preview()).json<RunPreviewDto>()
    expect(body).toMatchObject({ mode: 'advanced', revision: 4, queryCount: 2, assignmentCount: 3, requestCount: 4, expectedRequestCount: 4, canStart: true })
    expect(body.queryClasses).toEqual([
      { queryClass: 'non-brand', queryCount: 1, assignmentCount: 1 },
      { queryClass: 'branded', queryCount: 2, assignmentCount: 2 },
      { queryClass: 'unknown', queryCount: 0, assignmentCount: 0 },
    ])
    const started = await launch()
    expect(started.statusCode, started.body).toBe(201)
    const row = db.select().from(runs).where(eq(runs.id, started.json().id)).get()!
    expect(row.measurementPlanVersionId).toBe('v4')
    expect(parseMeasurementRunManifestV1(row.measurementManifest).expectedSlots).toHaveLength(4)
    expect(row.location).toBeNull()
  })

  it('blocks an edited, unpublished Advanced draft in both the preview and launch instead of running the Simple library', async () => {
    const { app, db, preview, launch, dispatched } = await harness()
    // ETag version 2: an operator has edited the seeded draft at least once.
    db.insert(measurementPlanDrafts).values({
      id: 'draft', projectId: 'northstar', authoringJson: EMPTY_DRAFT, etagVersion: 2, createdBy: 'test', updatedBy: 'test', createdAt: AT, updatedAt: AT,
    }).run()
    const setup = await app.inject({ method: 'GET', url: '/api/v1/projects/northstar/measurement-setup', headers: { authorization: `Bearer ${READ}` } })
    expect(setup.json()).toMatchObject({ mode: 'draft-only', requiresPublication: true })
    expect((await preview()).json()).toMatchObject({ mode: 'advanced', revision: null, requestCount: 0, canStart: false, blockedReason: 'unpublished-plan' })
    const started = await launch()
    expect(started.statusCode).toBe(400)
    expect(started.json()).toMatchObject({ error: { message: 'Publish the Advanced Measurement draft before starting a sweep.' } })
    expect(db.select().from(runs).all()).toEqual([])
    expect(dispatched).toEqual([])
  })

  it('keeps measuring as Simple when Advanced setup was only opened', async () => {
    const { app, db, preview, launch, dispatched } = await harness()
    // Opening Advanced setup creates a seeded draft at ETag version 1; nothing has been set up yet.
    db.insert(measurementPlanDrafts).values({
      id: 'opened', projectId: 'northstar', authoringJson: EMPTY_DRAFT, createdBy: 'test', updatedBy: 'test', createdAt: AT, updatedAt: AT,
    }).run()
    const setup = await app.inject({ method: 'GET', url: '/api/v1/projects/northstar/measurement-setup', headers: { authorization: `Bearer ${READ}` } })
    expect(setup.json()).toMatchObject({ mode: 'draft-only', requiresPublication: false })
    expect((await preview()).json()).toMatchObject({ mode: 'simple', revision: null, queryCount: 3, requestCount: 6, canStart: true, blockedReason: null })
    const started = await launch()
    expect(started.statusCode, started.body).toBe(201)
    expect(db.select().from(runs).where(eq(runs.id, started.json().id)).get()?.measurementPlanVersionId).toBeNull()
    expect(dispatched).toEqual([started.json().id])
  })

  it('lets a schedule keep measuring while an edited draft holds manual sweeps', async () => {
    const { db, launch } = await harness()
    db.insert(measurementPlanDrafts).values({
      id: 'draft', projectId: 'northstar', authoringJson: EMPTY_DRAFT, etagVersion: 3, createdBy: 'test', updatedBy: 'test', createdAt: AT, updatedAt: AT,
    }).run()
    expect((await launch()).statusCode).toBe(400)
    const scheduled = queueRunIfProjectIdle(db, {
      projectId: 'northstar', kind: RunKinds['answer-visibility'], trigger: RunTriggers.scheduled, createdAt: AT,
      runnableProviders: ['openai', 'gemini'], providerModels: { openai: 'gpt-5', gemini: 'gemini-2.5-flash' },
    })
    expect(scheduled.conflict).toBe(false)
    if (scheduled.conflict || scheduled.refused) throw new Error('scheduled sweep was not queued')
    const row = db.select().from(runs).where(eq(runs.id, scheduled.runId)).get()
    expect(row).toMatchObject({ trigger: RunTriggers.scheduled, kind: RunKinds['answer-visibility'], measurementPlanVersionId: null })
    expect(db.select().from(runs).all()).toHaveLength(1)
  })

  it('returns to Simple after deactivation while keeping an unfinished Advanced edit', async () => {
    const { app, db, preview, launch, requestErrors } = await harness()
    const plan = measurementPlanV2Fixture()
    db.insert(measurementPlanVersions).values({ id: 'published', projectId: 'northstar', revision: 1, schemaVersion: 2, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'a'.repeat(64), compiledChecksum: plan.compiledChecksum, createdAt: AT }).run()
    db.insert(measurementPlans).values({ projectId: 'northstar', activeVersionId: 'published', createdAt: AT, updatedAt: AT }).run()
    db.insert(measurementPlanDrafts).values({
      id: 'retained-edit', projectId: 'northstar', baseActiveVersionId: 'published', baseActiveRevision: 1,
      authoringJson: EMPTY_DRAFT, createdBy: 'test', updatedBy: 'test', createdAt: AT, updatedAt: AT,
    }).run()
    db.update(apiKeys).set({ scopes: ['read', 'runs.write', MEASUREMENT_PLAN_WRITE_SCOPE] }).where(eq(apiKeys.keyHash, hashApiKey(WRITE))).run()
    const deactivated = await app.inject({
      method: 'POST', url: '/api/v1/projects/northstar/measurement-plan/actions/deactivate',
      headers: { authorization: `Bearer ${WRITE}`, 'idempotency-key': 'deactivate-preview' }, payload: { expectedActiveRevision: 1 },
    })
    expect(deactivated.statusCode, [deactivated.body, ...requestErrors].join('\n')).toBe(200)
    expect(db.select({ id: measurementPlanDrafts.id }).from(measurementPlanDrafts).all()).toEqual([{ id: 'retained-edit' }])
    const setup = await app.inject({ method: 'GET', url: '/api/v1/projects/northstar/measurement-setup', headers: { authorization: `Bearer ${READ}` } })
    expect(setup.json()).toMatchObject({ mode: 'draft-only', requiresPublication: false })
    expect((await preview()).json()).toMatchObject({ mode: 'simple', revision: null, queryCount: 3, requestCount: 6, canStart: true, blockedReason: null })
    const started = await launch()
    expect(started.statusCode, started.body).toBe(201)
    expect(db.select().from(runs).where(eq(runs.id, started.json().id)).get()?.measurementPlanVersionId).toBeNull()
  })

  it('keeps an empty basket distinct from a measured zero', async () => {
    const { db, preview } = await harness()
    db.delete(queries).where(eq(queries.projectId, 'northstar')).run()
    expect((await preview()).json()).toMatchObject({ queryCount: 0, expectedRequestCount: 0, requestCount: 0, canStart: false, blockedReason: 'no-queries' })
  })
})
