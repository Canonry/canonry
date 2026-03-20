import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { expect, onTestFinished, test } from 'vitest'
import type {
  NormalizedQueryResult,
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  RawQueryResult,
  TrackedQueryInput,
} from '@ainyc/canonry-contracts'
import { createClient, keywords, migrate, projects, querySnapshots, runs, usageCounters } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'

function createTempDb(prefix: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  return { db, tmpDir }
}

function buildAdapter(overrides?: Partial<ProviderAdapter>): ProviderAdapter {
  return {
    name: 'gemini',
    validateConfig(_config: ProviderConfig): ProviderHealthcheckResult {
      return { ok: true, provider: 'gemini', message: 'ok' }
    },
    async healthcheck(_config: ProviderConfig): Promise<ProviderHealthcheckResult> {
      return { ok: true, provider: 'gemini', message: 'ok' }
    },
    async executeTrackedQuery(_input: TrackedQueryInput, _config: ProviderConfig): Promise<RawQueryResult> {
      return {
        provider: 'gemini',
        rawResponse: {},
        model: 'stub-model',
        groundingSources: [],
        searchQueries: [],
      }
    },
    normalizeResult(_raw: RawQueryResult): NormalizedQueryResult {
      return {
        provider: 'gemini',
        answerText: 'stub answer',
        citedDomains: [],
        groundingSources: [],
        searchQueries: [],
      }
    },
    async generateText(_prompt: string, _config: ProviderConfig): Promise<string> {
      return 'stub'
    },
    ...overrides,
  }
}

function seedRunFixture(db: ReturnType<typeof createClient>, keywordCount: number) {
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()

  db.insert(projects).values({
    id: projectId,
    name: 'test-project',
    displayName: 'Test Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: '[]',
    createdAt: now,
    updatedAt: now,
  }).run()

  for (let index = 0; index < keywordCount; index++) {
    db.insert(keywords).values({
      id: crypto.randomUUID(),
      projectId,
      keyword: `keyword-${index + 1}`,
      createdAt: now,
    }).run()
  }

  db.insert(runs).values({
    id: runId,
    projectId,
    status: 'queued',
    createdAt: now,
  }).run()

  return { now, projectId, runId }
}

test('JobRunner ignores previous-day usage when enforcing maxRequestsPerDay', async () => {
  const { db } = createTempDb('canonry-job-runner-quota-')
  const { projectId, runId, now } = seedRunFixture(db, 1)

  const previousDay = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  db.insert(usageCounters).values({
    id: crypto.randomUUID(),
    scope: `${projectId}:gemini`,
    period: previousDay,
    metric: 'queries',
    count: 1,
    updatedAt: now,
  }).run()

  const registry = new ProviderRegistry()
  registry.register(buildAdapter(), {
    provider: 'gemini',
    apiKey: 'test-key',
    quotaPolicy: {
      maxConcurrency: 1,
      maxRequestsPerMinute: 60,
      maxRequestsPerDay: 1,
    },
  })

  const runner = new JobRunner(db, registry)
  await runner.executeRun(runId, projectId)

  const run = db.select().from(runs).where(eq(runs.id, runId)).get()
  expect(run?.status).toBe('completed')
  const snapshots = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
  expect(snapshots).toHaveLength(1)
})

test('JobRunner honors per-provider maxConcurrency for API providers', async () => {
  const { db } = createTempDb('canonry-job-runner-concurrency-')
  const { projectId, runId } = seedRunFixture(db, 3)

  let inFlight = 0
  let maxSeen = 0

  const registry = new ProviderRegistry()
  registry.register(buildAdapter({
    async executeTrackedQuery(_input: TrackedQueryInput, _config: ProviderConfig): Promise<RawQueryResult> {
      inFlight++
      maxSeen = Math.max(maxSeen, inFlight)
      await new Promise(resolve => setTimeout(resolve, 25))
      inFlight--
      return {
        provider: 'gemini',
        rawResponse: {},
        model: 'stub-model',
        groundingSources: [],
        searchQueries: [],
      }
    },
  }), {
    provider: 'gemini',
    apiKey: 'test-key',
    quotaPolicy: {
      maxConcurrency: 2,
      maxRequestsPerMinute: 60,
      maxRequestsPerDay: 100,
    },
  })

  const runner = new JobRunner(db, registry)
  await runner.executeRun(runId, projectId)

  expect(maxSeen).toBe(2)
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()
  expect(run?.status).toBe('completed')
})

test('JobRunner stops dispatching new work after a run is cancelled', async () => {
  const { db } = createTempDb('canonry-job-runner-cancel-')
  const { projectId, runId } = seedRunFixture(db, 2)

  let callCount = 0
  let releaseFirstCall: (() => void) | undefined
  const firstCallStarted = new Promise<void>((resolve) => {
    releaseFirstCall = resolve
  })
  let markFirstCallStarted: (() => void) | undefined
  const waitForFirstCall = new Promise<void>((resolve) => {
    markFirstCallStarted = resolve
  })

  const registry = new ProviderRegistry()
  registry.register(buildAdapter({
    async executeTrackedQuery(_input: TrackedQueryInput, _config: ProviderConfig): Promise<RawQueryResult> {
      callCount++
      if (callCount === 1) {
        markFirstCallStarted?.()
        await firstCallStarted
      }

      return {
        provider: 'gemini',
        rawResponse: {},
        model: 'stub-model',
        groundingSources: [],
        searchQueries: [],
      }
    },
  }), {
    provider: 'gemini',
    apiKey: 'test-key',
    quotaPolicy: {
      maxConcurrency: 1,
      maxRequestsPerMinute: 60,
      maxRequestsPerDay: 100,
    },
  })

  const runner = new JobRunner(db, registry)
  const execution = runner.executeRun(runId, projectId)

  await waitForFirstCall
  db.update(runs)
    .set({ status: 'cancelled', finishedAt: new Date().toISOString(), error: 'Cancelled by user' })
    .where(eq(runs.id, runId))
    .run()
  releaseFirstCall?.()

  await execution

  const run = db.select().from(runs).where(eq(runs.id, runId)).get()
  expect(run?.status).toBe('cancelled')
  expect(callCount).toBe(1)
  const snapshots = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
  expect(snapshots).toHaveLength(0)
})
