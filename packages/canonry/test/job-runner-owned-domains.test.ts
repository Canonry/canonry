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
import { createClient, migrate, keywords, projects, querySnapshots, runs } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'

test('JobRunner marks citations on owned domains as cited', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-owned-domains-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const projectId = crypto.randomUUID()
  const keywordId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const now = new Date().toISOString()
  let receivedDomains: string[] = []

  const adapter: ProviderAdapter = {
    name: 'gemini',
    validateConfig(_config: ProviderConfig): ProviderHealthcheckResult {
      return { ok: true, provider: 'gemini', message: 'ok' }
    },
    async healthcheck(_config: ProviderConfig): Promise<ProviderHealthcheckResult> {
      return { ok: true, provider: 'gemini', message: 'ok' }
    },
    async executeTrackedQuery(input: TrackedQueryInput, _config: ProviderConfig): Promise<RawQueryResult> {
      receivedDomains = input.canonicalDomains
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
        citedDomains: ['docs.example.com'],
        groundingSources: [],
        searchQueries: [],
      }
    },
    async generateText(_prompt: string, _config: ProviderConfig): Promise<string> {
      return 'stub'
    },
  }

  const registry = new ProviderRegistry()
  registry.register(adapter, {
    provider: 'gemini',
    apiKey: 'test-key',
    quotaPolicy: {
      maxConcurrency: 1,
      maxRequestsPerMinute: 60,
      maxRequestsPerDay: 1000,
    },
  })

  db.insert(projects).values({
    id: projectId,
    name: 'owned-project',
    displayName: 'Owned Project',
    canonicalDomain: 'example.com',
    ownedDomains: '["https://www.docs.example.com/path"]',
    country: 'US',
    language: 'en',
    providers: '[]',
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(keywords).values({
    id: keywordId,
    projectId,
    keyword: 'test keyword',
    createdAt: now,
  }).run()

  db.insert(runs).values({
    id: runId,
    projectId,
    status: 'queued',
    createdAt: now,
  }).run()

  const runner = new JobRunner(db, registry)
  await runner.executeRun(runId, projectId)

  expect(receivedDomains).toEqual(['example.com', 'https://www.docs.example.com/path'])

  const [snapshot] = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
  expect(snapshot?.citationState).toBe('cited')
  expect(JSON.parse(snapshot.citedDomains)).toEqual(['docs.example.com'])
})
