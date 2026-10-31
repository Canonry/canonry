import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  type LocationContext,
  type MeasurementPlanV2,
  type NormalizedQueryResult,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderHealthcheckResult,
  type RawQueryResult,
  type TrackedQueryInput,
} from '@canonry/canonry-contracts'
import { queueRunIfProjectIdle } from '@canonry/canonry-api-routes'
import {
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@canonry/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'

const NOW = '2026-08-01T00:00:00.000Z'
const NORTH: LocationContext = { label: 'north-city', city: 'North City', region: 'NC', country: 'US' }
const PLACEHOLDER_CHECKSUM = '0'.repeat(64)

interface NodeSpec {
  key: string
  providers: string[]
  models?: Record<string, string>
}

/** A published v2 revision: one question, one place, shared by every Property. */
function sharedNodePlan(targets: readonly string[], node: NodeSpec): MeasurementPlanV2 {
  const draft: MeasurementPlanV2 = {
    schemaVersion: 2,
    identities: {
      projectBrand: { canonicalHost: 'example.com', ownedHosts: ['example.com'], names: ['Planned Co'] },
    },
    targets: targets.map(key => ({
      stableKey: key,
      label: key,
      aliases: [key],
      urlMatchers: [{ kind: 'prefix', host: 'example.com', pathPrefix: `/${key}`, pathCase: 'insensitive' }],
      mentionNotApplicable: false,
      discoveryIdentity: null,
    })),
    groups: [],
    querySnapshots: [{
      queryId: 'q-1',
      queryText: 'widget pricing',
      provenance: { source: 'manual', sourceId: null, capturedAt: NOW },
    }],
    assignments: targets.map(targetKey => ({
      targetKey,
      queryId: 'q-1',
      queryClass: 'non-brand',
      executionNodeKey: node.key,
    })),
    executionNodes: [{
      stableKey: node.key,
      queryId: 'q-1',
      queryText: 'widget pricing',
      context: { providers: node.providers, models: node.models ?? {}, location: NORTH },
      expectedSnapshots: node.providers.length,
    }],
    usageEdges: targets.map(targetKey => ({ executionNodeKey: node.key, targetKey, queryId: 'q-1' })),
    compiledChecksum: PLACEHOLDER_CHECKSUM,
  }
  return {
    ...draft,
    compiledChecksum: crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(draft)).digest('hex'),
  }
}

function seedDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-job-runner-v2-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  return db
}

function seedPlannedProject(db: DatabaseClient, plan: MeasurementPlanV2) {
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'planned',
    displayName: 'Planned Co',
    canonicalDomain: 'example.com',
    aliases: ['Planned Co'],
    country: 'US',
    language: 'en',
    providers: [],
    locations: [NORTH],
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  db.insert(queries).values({ id: 'q-1', projectId, query: 'widget pricing', createdAt: NOW }).run()

  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId,
    projectId,
    revision: 1,
    canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'),
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()
  return projectId
}

interface CountingAdapterOptions {
  name: string
  calls: Array<{ provider: string; query: string; model: string | undefined }>
  /** What the provider claims it built the request with, however it was configured. */
  reportedModel?: string
  servedModel?: string
}

function countingAdapter(options: CountingAdapterOptions): ProviderAdapter {
  return {
    name: options.name,
    validateConfig(_config: ProviderConfig): ProviderHealthcheckResult {
      return { ok: true, provider: options.name, message: 'ok' }
    },
    async healthcheck(_config: ProviderConfig): Promise<ProviderHealthcheckResult> {
      return { ok: true, provider: options.name, message: 'ok' }
    },
    async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
      options.calls.push({ provider: options.name, query: input.query, model: config.model })
      return {
        provider: options.name,
        rawResponse: {},
        model: options.reportedModel ?? config.model ?? 'fake-model',
        ...(options.servedModel === undefined ? {} : { servedModel: options.servedModel }),
        groundingSources: [],
        searchQueries: [],
        retrievalStatus: 'used',
        retrievalContract: 'search-required-v1',
      }
    },
    normalizeResult(_raw: RawQueryResult): NormalizedQueryResult {
      return {
        provider: options.name,
        answerText: 'fake answer',
        citedDomains: [],
        groundingSources: [],
        searchQueries: [],
        retrievalStatus: 'used',
      }
    },
    async generateText(_prompt: string, _config: ProviderConfig): Promise<string> {
      return 'fake'
    },
  }
}

function registryFor(adapters: readonly ProviderAdapter[]) {
  const registry = new ProviderRegistry()
  for (const adapter of adapters) {
    registry.register(adapter, {
      provider: adapter.name,
      apiKey: 'test-key',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 600, maxRequestsPerDay: 1000 },
    })
  }
  return registry
}

describe('executing a published v2 revision', () => {
  it('calls each provider once for an execution node 194 Properties share', async () => {
    const db = seedDb()
    const targets = Array.from({ length: 194 }, (_, index) => `property-${String(index + 1).padStart(3, '0')}`)
    const projectId = seedPlannedProject(db, sharedNodePlan(targets, { key: 'exec-shared', providers: ['openai', 'gemini'] }))

    const queued = queueRunIfProjectIdle(db, { projectId })
    if (queued.conflict) throw new Error('unexpected conflict')

    const calls: Array<{ provider: string; query: string; model: string | undefined }> = []
    await new JobRunner(db, registryFor([
      countingAdapter({ name: 'openai', calls }),
      countingAdapter({ name: 'gemini', calls }),
    ])).executeRun(queued.runId, projectId)

    // Reuse across Properties is a usage edge, never a second provider request.
    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.provider).sort()).toEqual(['gemini', 'openai'])
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.runId, queued.runId)).all()).toHaveLength(2)
    expect(db.select().from(runs).where(eq(runs.id, queued.runId)).get()!.status).toBe('completed')
  })

  it('records the model the revision requested and the model the provider served', async () => {
    const db = seedDb()
    const projectId = seedPlannedProject(db, sharedNodePlan(['property-001'], {
      key: 'exec-shared',
      providers: ['openai'],
      models: { openai: 'gpt-planned' },
    }))

    const queued = queueRunIfProjectIdle(db, { projectId })
    if (queued.conflict) throw new Error('unexpected conflict')

    const calls: Array<{ provider: string; query: string; model: string | undefined }> = []
    await new JobRunner(db, registryFor([countingAdapter({
      name: 'openai',
      calls,
      // An adapter that reports its own default rather than echoing what it was
      // handed must not overwrite the request the revision recorded.
      reportedModel: 'gpt-adapter-default',
      servedModel: 'gpt-planned-2026-03-05',
    })])).executeRun(queued.runId, projectId)

    expect(calls.map(call => call.model)).toEqual(['gpt-planned'])
    const row = db.select().from(querySnapshots).where(eq(querySnapshots.runId, queued.runId)).get()!
    expect(row.model).toBe('gpt-planned')
    expect(row.servedModel).toBe('gpt-planned-2026-03-05')
    // Plan provenance: the snapshot names the frozen node it answers for, and
    // the run names the revision that froze it.
    expect(row.measurementExecutionId).toBe('exec-shared')
    expect(db.select().from(runs).where(eq(runs.id, queued.runId)).get()!.measurementPlanVersionId).toBeTruthy()
  })
})

