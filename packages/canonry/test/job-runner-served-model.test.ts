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

// Persistence guard for the served-model wiring. `extractServedModel` is pinned in
// each provider package, but nothing proved the value survived the JobRunner insert —
// both insert branches (screenshot / no-screenshot) write `served_model` AND embed it
// in the `raw_response` envelope, and every one of those four lines was free to be
// deleted without a test failing.
//
// The invariant under test: `model` is what we ASKED for, `served_model` is what the
// provider SAID it served, and an undisclosed served model persists as NULL — never as
// an echo of the configured model.

const CONFIGURED_MODEL = 'gpt-5.6'
const SERVED_MODEL = 'gpt-5.6-2026-03-05'

interface StubOptions {
  servedModel?: string
  /** When set, the adapter reports this path so the screenshot insert branch runs. */
  screenshotPath?: string
}

function stubAdapter(opts: StubOptions): ProviderAdapter {
  return {
    name: 'openai',
    validateConfig(_config: ProviderConfig): ProviderHealthcheckResult {
      return { ok: true, provider: 'openai', message: 'ok' }
    },
    async healthcheck(_config: ProviderConfig): Promise<ProviderHealthcheckResult> {
      return { ok: true, provider: 'openai', message: 'ok' }
    },
    async executeTrackedQuery(_input: TrackedQueryInput, _config: ProviderConfig): Promise<RawQueryResult> {
      return {
        provider: 'openai',
        rawResponse: { model: opts.servedModel, id: 'resp_stub' },
        model: CONFIGURED_MODEL,
        ...(opts.servedModel === undefined ? {} : { servedModel: opts.servedModel }),
        ...(opts.screenshotPath === undefined ? {} : { screenshotPath: opts.screenshotPath }),
        groundingSources: [],
        searchQueries: [],
      }
    },
    normalizeResult(_raw: RawQueryResult): NormalizedQueryResult {
      return {
        provider: 'openai',
        answerText: 'stub answer',
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

/** Seed a project + query + queued run and execute it against the stub adapter. */
async function runWithStub(prefix: string, opts: StubOptions) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  // The screenshot branch renames into `os.homedir()/.canonry/screenshots` — point HOME
  // at the temp dir so the test never writes to the real home.
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
  registry.register(stubAdapter(opts), {
    provider: 'openai',
    apiKey: 'test-key',
    model: CONFIGURED_MODEL,
    quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 60, maxRequestsPerDay: 1000 },
  })

  db.insert(projects).values({
    id: projectId,
    name: 'served-model-project',
    displayName: 'Served Model Project',
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
  return { snapshot, tmpDir }
}

test('JobRunner persists servedModel to the column and the raw_response envelope (no-screenshot branch)', async () => {
  const { snapshot } = await runWithStub('canonry-served-model-plain-', { servedModel: SERVED_MODEL })

  expect(snapshot).toBeDefined()
  expect(snapshot.screenshotPath).toBeNull()

  // The queryable column carries what the provider served, not what we asked for.
  expect(snapshot.servedModel).toBe(SERVED_MODEL)
  expect(snapshot.model).toBe(CONFIGURED_MODEL)
  expect(snapshot.servedModel).not.toBe(snapshot.model)

  // ...and the stored envelope carries both, so a re-read of an archived row can tell
  // the requested and served identities apart without joining the column back in.
  const envelope = JSON.parse(snapshot.rawResponse ?? '{}') as Record<string, unknown>
  expect(envelope.servedModel).toBe(SERVED_MODEL)
  expect(envelope.model).toBe(CONFIGURED_MODEL)
})

test('JobRunner persists servedModel on the screenshot insert branch too', async () => {
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-served-model-shot-src-'))
  onTestFinished(() => fs.rmSync(shotDir, { recursive: true, force: true }))
  const screenshotPath = path.join(shotDir, 'shot.png')
  fs.writeFileSync(screenshotPath, 'not-a-real-png')

  const { snapshot } = await runWithStub('canonry-served-model-shot-', {
    servedModel: SERVED_MODEL,
    screenshotPath,
  })

  // Proves the screenshot branch actually ran — the two inserts are separate code
  // paths and only this one sets screenshot_path.
  expect(snapshot.screenshotPath).toMatch(/\.png$/)

  expect(snapshot.servedModel).toBe(SERVED_MODEL)
  expect(snapshot.model).toBe(CONFIGURED_MODEL)

  const envelope = JSON.parse(snapshot.rawResponse ?? '{}') as Record<string, unknown>
  expect(envelope.servedModel).toBe(SERVED_MODEL)
  expect(envelope.model).toBe(CONFIGURED_MODEL)
})

test('JobRunner persists an undisclosed servedModel as NULL, never as the configured model', async () => {
  const { snapshot } = await runWithStub('canonry-served-model-absent-', { servedModel: undefined })

  // The whole point of the field: absence of a disclosure must stay absent. Echoing
  // `model` here would launder a guess as an observation.
  expect(snapshot.servedModel).toBeNull()
  expect(snapshot.servedModel).not.toBe(CONFIGURED_MODEL)
  expect(snapshot.model).toBe(CONFIGURED_MODEL)

  const envelope = JSON.parse(snapshot.rawResponse ?? '{}') as Record<string, unknown>
  expect(envelope.servedModel).toBeNull()
  expect(envelope.model).toBe(CONFIGURED_MODEL)
})
