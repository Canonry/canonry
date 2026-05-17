import { test, expect, onTestFinished } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type {
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  TrackedQueryInput,
  RawQueryResult,
  NormalizedQueryResult,
} from '@ainyc/canonry-contracts'
import { createClient, migrate, queries, projects, querySnapshots, runs } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'

function buildEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-scoped-queries-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  return { db }
}

function buildStubAdapter(seenQueries: string[]): ProviderAdapter {
  return {
    name: 'gemini',
    validateConfig(_config: ProviderConfig): ProviderHealthcheckResult {
      return { ok: true, provider: 'gemini', message: 'ok' }
    },
    async healthcheck(_config: ProviderConfig): Promise<ProviderHealthcheckResult> {
      return { ok: true, provider: 'gemini', message: 'ok' }
    },
    async executeTrackedQuery(input: TrackedQueryInput, _config: ProviderConfig): Promise<RawQueryResult> {
      seenQueries.push(input.query)
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
        answerText: 'stub',
        citedDomains: [],
        groundingSources: [],
        searchQueries: [],
      }
    },
    async generateText(_prompt: string, _config: ProviderConfig): Promise<string> {
      return 'stub'
    },
  }
}

function buildRegistry(adapter: ProviderAdapter): ProviderRegistry {
  const registry = new ProviderRegistry()
  registry.register(adapter, {
    provider: 'gemini',
    apiKey: 'test-key',
    quotaPolicy: {
      maxConcurrency: 2,
      maxRequestsPerMinute: 60,
      maxRequestsPerDay: 1000,
    },
  })
  return registry
}

function seed(db: ReturnType<typeof createClient>, queriesList: string[], runQueries: string[] | null) {
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: projectId,
    name: 'scoped',
    displayName: 'Scoped Project',
    canonicalDomain: 'example.com',
    ownedDomains: [],
    country: 'US',
    language: 'en',
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  for (const q of queriesList) {
    db.insert(queries).values({
      id: crypto.randomUUID(),
      projectId,
      query: q,
      createdAt: now,
    }).run()
  }

  db.insert(runs).values({
    id: runId,
    projectId,
    status: 'queued',
    queries: runQueries,
    createdAt: now,
  }).run()

  return { projectId, runId }
}

test('JobRunner sweeps only the scoped queries when runs.queries is set', async () => {
  const { db } = buildEnv()
  const seen: string[] = []
  const registry = buildRegistry(buildStubAdapter(seen))

  const { projectId, runId } = seed(db, ['alpha', 'beta', 'gamma'], ['alpha', 'beta'])

  const runner = new JobRunner(db, registry)
  await runner.executeRun(runId, projectId)

  expect(seen.sort()).toEqual(['alpha', 'beta'])

  const snapshots = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
  expect(snapshots).toHaveLength(2)

  const finalRun = db.select().from(runs).where(eq(runs.id, runId)).get()
  expect(finalRun?.status).toBe('completed')
})

test('JobRunner falls back to full sweep when runs.queries is null', async () => {
  const { db } = buildEnv()
  const seen: string[] = []
  const registry = buildRegistry(buildStubAdapter(seen))

  const { projectId, runId } = seed(db, ['alpha', 'beta', 'gamma'], null)

  const runner = new JobRunner(db, registry)
  await runner.executeRun(runId, projectId)

  expect(seen.sort()).toEqual(['alpha', 'beta', 'gamma'])

  const snapshots = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
  expect(snapshots).toHaveLength(3)
})
