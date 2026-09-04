import { test, expect, onTestFinished, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type {
  MeasurementExecutionIdentity,
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  TrackedQueryInput,
  RawQueryResult,
  NormalizedQueryResult,
} from '@ainyc/canonry-contracts'
import {
  buildImplicitNativeEngineRoute,
  buildMeasurementExecutionIdentity,
  canonicalEngineRoutePolicyJson,
  canonicalMeasurementExecutionIdentityJson,
} from '@ainyc/canonry-contracts'
import { createClient, migrate, queries, projects, querySnapshots, runs } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { captureCitedUrls } from '../src/cited-url-capture.js'

vi.mock('../src/cited-url-capture.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cited-url-capture.js')>()
  return { ...actual, captureCitedUrls: vi.fn(actual.captureCitedUrls) }
})

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
  servedProvider?: string
  groundingUri?: string
  malformedGroundingSources?: boolean
  /** When set, the adapter reports this path so the screenshot insert branch runs. */
  screenshotPath?: string
  /** The live adapter endpoint, which may differ after a run was queued. */
  baseUrl?: string
  /** Queue-time provenance must survive execution without recomputation. */
  measurementExecutionIdentity?: MeasurementExecutionIdentity
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
        ...(opts.servedProvider === undefined ? {} : { servedProvider: opts.servedProvider }),
        ...(opts.screenshotPath === undefined ? {} : { screenshotPath: opts.screenshotPath }),
        groundingSources: [{ uri: opts.groundingUri ?? 'https://publisher.example/guides/answer#citation', title: 'Publisher' }],
        searchQueries: [],
        retrievalStatus: 'unknown',
        retrievalContract: 'native-auto-v1',
      }
    },
    normalizeResult(_raw: RawQueryResult): NormalizedQueryResult {
      return {
        provider: 'openai',
        answerText: 'stub answer',
        citedDomains: [],
        groundingSources: opts.malformedGroundingSources
          ? null as unknown as NormalizedQueryResult['groundingSources']
          : [{ uri: opts.groundingUri ?? 'https://publisher.example/guides/answer#citation', title: 'Publisher' }],
        searchQueries: [],
        retrievalStatus: 'unknown',
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
    baseUrl: opts.baseUrl,
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
  db.insert(runs).values({
    id: runId, projectId, status: 'queued',
    ...(opts.measurementExecutionIdentity ? { measurementExecutionIdentity: opts.measurementExecutionIdentity } : {}),
    createdAt: now,
  }).run()

  await new JobRunner(db, registry).executeRun(runId, projectId)

  const [snapshot] = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()!
  return { snapshot, tmpDir, run }
}

test('JobRunner persists servedModel to the column and the raw_response envelope (no-screenshot branch)', async () => {
  const { snapshot } = await runWithStub('canonry-served-model-plain-', { servedModel: SERVED_MODEL })

  expect(snapshot).toBeDefined()
  expect(snapshot.screenshotPath).toBeNull()

  // The queryable column carries what the provider served, not what we asked for.
  expect(snapshot.servedModel).toBe(SERVED_MODEL)
  expect(snapshot.model).toBe(CONFIGURED_MODEL)
  expect(snapshot.servedModel).not.toBe(snapshot.model)
  expect(snapshot.citationState).toBe('not-cited')
  expect(snapshot.citedUrls).toEqual(['https://publisher.example/guides/answer'])
  expect(snapshot.captureStatus).toBe('complete')
  expect(snapshot.sourceCount).toBe(1)
  expect(snapshot.resolvedCount).toBe(1)
  expect(snapshot.captureVersion).toBe(1)

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
  expect(snapshot.citationState).toBe('not-cited')
  expect(snapshot.citedUrls).toEqual(['https://publisher.example/guides/answer'])
  expect(snapshot.captureStatus).toBe('complete')
  expect(snapshot.sourceCount).toBe(1)
  expect(snapshot.resolvedCount).toBe(1)
  expect(snapshot.captureVersion).toBe(1)

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

test('JobRunner keeps requested adapter and response-disclosed served provider separate', async () => {
  const { snapshot } = await runWithStub('canonry-served-provider-', {
    servedModel: SERVED_MODEL,
    servedProvider: 'openai',
  })

  expect(snapshot.provider).toBe('openai')
  expect(snapshot.servedProvider).toBe('openai')
  const envelope = JSON.parse(snapshot.rawResponse ?? '{}') as Record<string, unknown>
  expect(envelope.servedProvider).toBe('openai')
})

test('JobRunner leaves an undisclosed served provider NULL rather than copying the requested adapter', async () => {
  const { snapshot } = await runWithStub('canonry-served-provider-absent-', { servedModel: SERVED_MODEL })

  expect(snapshot.provider).toBe('openai')
  expect(snapshot.servedProvider).toBeNull()
})

test('JobRunner preserves queue-stamped native endpoint provenance after the live adapter endpoint moves', async () => {
  const route = buildImplicitNativeEngineRoute({
    provider: 'openai', displayName: 'OpenAI', defaultModel: CONFIGURED_MODEL,
    capabilities: { kind: 'verified-measurement', fallback: 'disabled', retrieval: true, citations: true, location: true, servedModel: true },
  })
  const queuePolicy = crypto.createHash('sha256')
    .update(canonicalEngineRoutePolicyJson(route, undefined, 'https://gateway-before.example/v1'))
    .digest('hex')
  const livePolicy = crypto.createHash('sha256')
    .update(canonicalEngineRoutePolicyJson(route, undefined, 'https://gateway-after.example/v1'))
    .digest('hex')
  const identityInput = {
    providers: ['openai'],
    models: { openai: CONFIGURED_MODEL },
    routes: { openai: { routeId: route.id, routeRevision: route.revision, policyFingerprint: queuePolicy } },
  }
  const queuedIdentity = buildMeasurementExecutionIdentity(
    identityInput,
    crypto.createHash('sha256').update(canonicalMeasurementExecutionIdentityJson(identityInput)).digest('hex'),
  )

  const { run } = await runWithStub('canonry-queued-native-endpoint-', {
    servedModel: SERVED_MODEL,
    baseUrl: 'https://gateway-after.example/v1',
    measurementExecutionIdentity: queuedIdentity,
  })

  expect(queuePolicy).not.toBe(livePolicy)
  expect(run.measurementExecutionIdentity).toEqual(queuedIdentity)
  expect(run.measurementExecutionIdentity!.routes.openai!.policyFingerprint).toBe(queuePolicy)
})

test('JobRunner persists a route-capable query when Vertex resolution fails', async () => {
  const fetchImpl = vi.fn(async () => {
    throw new Error('redirect unavailable')
  })
  vi.stubGlobal('fetch', fetchImpl)
  onTestFinished(() => vi.unstubAllGlobals())

  const { snapshot, run } = await runWithStub('canonry-cited-url-failure-', {
    servedModel: SERVED_MODEL,
    groundingUri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/failing',
  })

  expect(fetchImpl).toHaveBeenCalledTimes(1)
  expect(snapshot.citationState).toBe('not-cited')
  expect(snapshot.citedUrls).toEqual([])
  expect(snapshot.captureStatus).toBe('failed')
  expect(snapshot.sourceCount).toBe(1)
  expect(snapshot.resolvedCount).toBe(0)
  expect(snapshot.captureVersion).toBe(1)
  expect(run.status).toBe('completed')
})

test('JobRunner fails open when cited URL capture throws', async () => {
  vi.mocked(captureCitedUrls).mockRejectedValueOnce(new Error('capture dependency fault'))

  const { snapshot, run } = await runWithStub('canonry-cited-url-capture-throws-', {
    servedModel: SERVED_MODEL,
  })

  expect(snapshot).toBeDefined()
  expect(snapshot.citedUrls).toEqual([])
  expect(snapshot.captureStatus).toBe('failed')
  expect(snapshot.sourceCount).toBe(1)
  expect(snapshot.resolvedCount).toBe(0)
  expect(snapshot.captureVersion).toBe(1)
  expect(run.status).toBe('completed')
})

test('JobRunner sanitizes malformed grounding sources after capture fails open', async () => {
  const { snapshot, run } = await runWithStub('canonry-malformed-grounding-sources-', {
    servedModel: SERVED_MODEL,
    malformedGroundingSources: true,
  })

  expect(snapshot).toBeDefined()
  expect(snapshot.citedUrls).toEqual([])
  expect(snapshot.captureStatus).toBe('failed')
  expect(snapshot.sourceCount).toBe(0)
  expect(snapshot.resolvedCount).toBe(0)
  expect(snapshot.captureVersion).toBe(1)
  expect(run.status).toBe('completed')

  const envelope = JSON.parse(snapshot.rawResponse ?? '{}') as Record<string, unknown>
  expect(envelope.groundingSources).toEqual([])
})
