import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { beforeEach, expect, onTestFinished, test } from 'vitest'
import { buildMeasurementRunManifestV1 } from '@ainyc/canonry-contracts'
import { createClient, measurementPlanVersions, migrate, projects, queries, runs, usageCounters } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'
import { getCurrentUsageDay } from '../src/usage-quota.js'
import { fakeAdapter, type RecordedCall } from './fake-measurement-provider.js'

beforeEach(() => {
  resetSharedProviderExecutionGates()
})

test('an unknown route is never considered measurement-ready', () => {
  expect(new ProviderRegistry().isMeasurementReady('route:missing')).toBe(false)
})

function buildDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-engine-route-safety-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  return db
}

function seedProjectRun(input: {
  db: ReturnType<typeof createClient>
  providers?: string[]
  manifestProvider?: string
}) {
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  input.db.insert(projects).values({
    id: projectId,
    name: `engine-route-${projectId}`,
    displayName: 'Engine Route Test',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: input.providers ?? [],
    createdAt: now,
    updatedAt: now,
  }).run()
  input.db.insert(queries).values({
    id: crypto.randomUUID(), projectId, query: 'who sells widgets?', createdAt: now,
  }).run()

  const manifest = input.manifestProvider
    ? buildMeasurementRunManifestV1({
        expectedSlots: [{
          executionId: 'widget-question',
          queryText: 'who sells widgets?',
          provider: input.manifestProvider,
          context: null,
        }],
      })
    : null
  const measurementPlanVersionId = manifest ? crypto.randomUUID() : undefined
  if (measurementPlanVersionId) {
    input.db.insert(measurementPlanVersions).values({
      id: measurementPlanVersionId,
      projectId,
      revision: 1,
      canonicalJson: '{}',
      checksum: crypto.createHash('sha256').update('{}').digest('hex'),
      createdAt: now,
    }).run()
  }
  input.db.insert(runs).values({
    id: runId,
    projectId,
    status: 'queued',
    ...(manifest ? { measurementPlanVersionId, measurementManifest: manifest } : {}),
    createdAt: now,
  }).run()
  return { projectId, runId }
}

function textOnlyRegistry(calls: RecordedCall[]) {
  const registry = new ProviderRegistry()
  registry.register(fakeAdapter({ name: 'route:text-only', calls }), {
    provider: 'route:text-only',
    connectionId: 'shared-gateway',
    measurementReady: false,
    quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 60, maxRequestsPerDay: 10 },
  })
  return registry
}

test('a manifest naming a text-only route fails closed and names that route', async () => {
  const db = buildDb()
  const calls: RecordedCall[] = []
  const { projectId, runId } = seedProjectRun({ db, manifestProvider: 'route:text-only' })

  await new JobRunner(db, textOnlyRegistry(calls)).executeRun(runId, projectId)

  const run = db.select().from(runs).where(eq(runs.id, runId)).get()!
  expect(run.status).toBe('failed')
  expect(run.error).toMatch(/route:text-only.*cannot run an answer-visibility sweep/i)
  expect(run.error).not.toMatch(/no providers configured/i)
  expect(calls).toEqual([])
})

test('a planless explicit text-only override fails closed rather than disappearing from selection', async () => {
  const db = buildDb()
  const calls: RecordedCall[] = []
  const { projectId, runId } = seedProjectRun({ db })

  await new JobRunner(db, textOnlyRegistry(calls)).executeRun(runId, projectId, ['route:text-only'])

  const run = db.select().from(runs).where(eq(runs.id, runId)).get()!
  expect(run.status).toBe('failed')
  expect(run.error).toMatch(/route:text-only.*does not prove retrieval, citation, location, and served-model evidence/i)
  expect(run.error).not.toMatch(/no providers configured/i)
  expect(calls).toEqual([])
})

test('two route ids on one connection consume one shared daily budget across projects', async () => {
  const db = buildDb()
  const calls: RecordedCall[] = []
  const registry = new ProviderRegistry()
  const quota = { maxConcurrency: 1, maxRequestsPerMinute: 60, maxRequestsPerDay: 1 }
  for (const name of ['route:one', 'route:two']) {
    registry.register(fakeAdapter({ name, calls }), {
      provider: name,
      connectionId: 'gateway-one',
      measurementReady: true,
      quotaPolicy: quota,
    })
  }
  const first = seedProjectRun({ db, providers: ['route:one'] })
  const second = seedProjectRun({ db, providers: ['route:two'] })

  const runner = new JobRunner(db, registry)
  await runner.executeRun(first.runId, first.projectId)
  await runner.executeRun(second.runId, second.projectId)

  expect(db.select().from(runs).where(eq(runs.id, first.runId)).get()?.status).toBe('completed')
  const secondRun = db.select().from(runs).where(eq(runs.id, second.runId)).get()!
  expect(secondRun.status).toBe('failed')
  expect(secondRun.error).toMatch(/daily quota exceeded for route:two/i)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.provider).toBe('route:one')
  expect(db.select().from(usageCounters).where(and(
    eq(usageCounters.scope, 'connection:gateway-one'),
    eq(usageCounters.period, getCurrentUsageDay()),
    eq(usageCounters.metric, 'queries'),
  )).get()?.count).toBe(1)
})
