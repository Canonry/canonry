import { test, expect, onTestFinished, vi } from 'vitest'
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
  RetrievalContract,
  RetrievalStatus,
} from '@ainyc/canonry-contracts'
import { createClient, migrate, queries, projects, querySnapshots, runs } from '@ainyc/canonry-db'
import { openaiAdapter } from '@ainyc/canonry-provider-openai'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'

// Persistence guard for the retrieval contract. The provider packages pin how
// retrieval is detected, but nothing proved the value survived the JobRunner
// insert, and there are two insert branches (screenshot / no-screenshot) that
// each had to carry it.
//
// The invariant under test: a change in search policy must never produce an
// unmarked snapshot. A row that was answered without retrieval has to be
// distinguishable at rest from one that retrieved and cited nothing, because
// both store zero cited domains and otherwise look identical.

interface StubOptions {
  retrievalStatus: RetrievalStatus
  retrievalContract: RetrievalContract
  /** Cited domains on the normalized result; empty is the interesting case. */
  citedDomains?: string[]
  /** When set, the adapter reports this path so the screenshot branch runs. */
  screenshotPath?: string
}

function stubAdapter(opts: StubOptions): ProviderAdapter {
  const citedDomains = opts.citedDomains ?? []
  return {
    name: 'claude',
    validateConfig(_config: ProviderConfig): ProviderHealthcheckResult {
      return { ok: true, provider: 'claude', message: 'ok' }
    },
    async healthcheck(_config: ProviderConfig): Promise<ProviderHealthcheckResult> {
      return { ok: true, provider: 'claude', message: 'ok' }
    },
    async executeTrackedQuery(_input: TrackedQueryInput, _config: ProviderConfig): Promise<RawQueryResult> {
      return {
        provider: 'claude',
        rawResponse: { id: 'msg_stub' },
        model: 'claude-sonnet-5',
        ...(opts.screenshotPath === undefined ? {} : { screenshotPath: opts.screenshotPath }),
        groundingSources: [],
        searchQueries: [],
        retrievalStatus: opts.retrievalStatus,
        retrievalContract: opts.retrievalContract,
      }
    },
    normalizeResult(_raw: RawQueryResult): NormalizedQueryResult {
      return {
        provider: 'claude',
        answerText: 'stub answer',
        citedDomains,
        groundingSources: [],
        searchQueries: [],
        retrievalStatus: opts.retrievalStatus,
      }
    },
    async generateText(_prompt: string, _config: ProviderConfig): Promise<string> {
      return 'stub'
    },
  }
}

const quotaPolicy = { maxConcurrency: 1, maxRequestsPerMinute: 60, maxRequestsPerDay: 1000 }

/** Seed a project + query + queued run and execute it against the stub adapter. */
function runWithStub(prefix: string, opts: StubOptions) {
  return runWithAdapter(prefix, stubAdapter(opts), {
    provider: 'claude',
    apiKey: 'test-key',
    model: 'claude-sonnet-5',
    quotaPolicy,
  })
}

/** Seed a project + query + queued run and execute it against `adapter`. */
async function runWithAdapter(prefix: string, adapter: ProviderAdapter, config: ProviderConfig) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  // The screenshot branch renames into `os.homedir()/.canonry/screenshots`.
  const savedHome = process.env.HOME
  process.env.HOME = tmpDir
  onTestFinished(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
  })

  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const projectId = crypto.randomUUID()
  const queryId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const now = new Date().toISOString()

  const registry = new ProviderRegistry()
  registry.register(adapter, config)

  db.insert(projects).values({
    id: projectId,
    name: 'retrieval-contract-project',
    displayName: 'Retrieval Contract Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(queries).values({ id: queryId, projectId, query: 'test query', createdAt: now }).run()
  db.insert(runs).values({ id: runId, projectId, status: 'queued', createdAt: now }).run()

  await new JobRunner(db, registry).executeRun(runId, projectId)

  const [snapshot] = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
  return { snapshot }
}

test('JobRunner persists the retrieval contract on the plain insert branch', async () => {
  const { snapshot } = await runWithStub('canonry-retrieval-plain-', {
    retrievalStatus: 'used',
    retrievalContract: 'search-required-v1',
  })

  expect(snapshot).toBeDefined()
  expect(snapshot.screenshotPath).toBeNull()
  expect(snapshot.retrievalStatus).toBe('used')
  expect(snapshot.retrievalContract).toBe('search-required-v1')
})

test('JobRunner persists the retrieval contract on the screenshot insert branch too', async () => {
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-retrieval-shot-src-'))
  onTestFinished(() => fs.rmSync(shotDir, { recursive: true, force: true }))
  const screenshotPath = path.join(shotDir, 'shot.png')
  fs.writeFileSync(screenshotPath, 'not-a-real-png')

  const { snapshot } = await runWithStub('canonry-retrieval-shot-', {
    retrievalStatus: 'used',
    retrievalContract: 'search-required-v1',
    screenshotPath,
  })

  // Proves the screenshot branch actually ran: the two inserts are separate code
  // paths and only this one sets screenshot_path.
  expect(snapshot.screenshotPath).toMatch(/\.png$/)
  expect(snapshot.retrievalStatus).toBe('used')
  expect(snapshot.retrievalContract).toBe('search-required-v1')
})

test('an answer written without retrieval is distinguishable at rest from one that cited nothing', async () => {
  // This is the whole point of the field. Both rows below store zero cited
  // domains and are otherwise identical; only retrieval_status separates the
  // answer that never had a chance from the one that genuinely did not mention
  // the brand. Without it the first silently counts as a miss.
  const { snapshot: neverSearched } = await runWithStub('canonry-retrieval-none-', {
    retrievalStatus: 'not-used',
    retrievalContract: 'search-required-v1',
    citedDomains: [],
  })
  const { snapshot: searchedUncited } = await runWithStub('canonry-retrieval-uncited-', {
    retrievalStatus: 'used',
    retrievalContract: 'search-required-v1',
    citedDomains: [],
  })

  expect(neverSearched.citedDomains).toEqual([])
  expect(searchedUncited.citedDomains).toEqual([])
  expect(neverSearched.citationState).toBe(searchedUncited.citationState)

  expect(neverSearched.retrievalStatus).toBe('not-used')
  expect(searchedUncited.retrievalStatus).toBe('used')
})

test('a provider without retrieval detection records unknown rather than a fabricated status', async () => {
  const { snapshot } = await runWithStub('canonry-retrieval-unknown-', {
    retrievalStatus: 'unknown',
    retrievalContract: 'native-auto-v1',
  })

  // `unknown` must survive as itself. Coercing it to `not-used` would assert an
  // absence nobody observed and let the row count as a genuine miss.
  expect(snapshot.retrievalStatus).toBe('unknown')
  expect(snapshot.retrievalContract).toBe('native-auto-v1')
})

test('the OpenAI adapter persists the forced-search contract and the retrieval it observed', async () => {
  // End to end through the real adapter: the request sends tool_choice
  // "required" with web_search as the only tool, so the stored row must say
  // search-required-v1, and the status must come from the response's
  // web_search_call item rather than a hardcoded `unknown`.
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
    id: 'resp_stub',
    object: 'response',
    status: 'completed',
    model: 'gpt-5.4-2026-03-05',
    output: [
      { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'test query' } },
      {
        id: 'msg_1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'stub answer', annotations: [] }],
      },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  onTestFinished(() => { vi.unstubAllGlobals() })

  const { snapshot } = await runWithAdapter('canonry-retrieval-openai-', openaiAdapter, {
    provider: 'openai',
    apiKey: 'test-key',
    model: 'gpt-5.4',
    quotaPolicy,
  })

  expect(snapshot.provider).toBe('openai')
  expect(snapshot.retrievalContract).toBe('search-required-v1')
  expect(snapshot.retrievalStatus).toBe('used')
})

test('rows written before the contract existed stay null rather than being assumed', async () => {
  // Historical rows are deliberately not backfilled: they were produced under
  // provider-native behaviour, but writing that in would launder an assumption
  // into an observation. Readers must treat null as "predates the field", never
  // as `not-used`.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-retrieval-legacy-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const snapshotId = crypto.randomUUID()

  db.insert(projects).values({
    id: projectId,
    name: 'legacy-project',
    displayName: 'Legacy Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(runs).values({ id: runId, projectId, status: 'completed', createdAt: now }).run()

  // A row inserted without the new columns, as every pre-migration row is.
  db.insert(querySnapshots).values({
    id: snapshotId,
    runId,
    queryText: 'legacy query',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    citationState: 'not-cited',
    citedDomains: [],
    createdAt: now,
  }).run()

  const row = db.select().from(querySnapshots).where(eq(querySnapshots.id, snapshotId)).get()!
  expect(row.retrievalStatus).toBeNull()
  expect(row.retrievalContract).toBeNull()
})
