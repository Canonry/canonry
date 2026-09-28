import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { expect, onTestFinished } from 'vitest'
import {
  canonicalMeasurementPlanJson,
  canonicalMeasurementPlanV2Json,
  compileMeasurementPlan,
  measurementPlanV2ChecksumJson,
  ProviderBatchSubmitError,
  type LocationContext,
  type MeasurementPlanV2,
  type NormalizedQueryResult,
  type ProviderAdapter,
  type ProviderBatchCapability,
  type ProviderBatchPollStatus,
  type ProviderBatchRequestInput,
  type ProviderBatchResultLine,
  type ProviderConfig,
  type ProviderHealthcheckResult,
  type ProviderPricing,
  type RawQueryResult,
  type TrackedQueryInput,
} from '@ainyc/canonry-contracts'
import { queueRunIfProjectIdle } from '@ainyc/canonry-api-routes'
import {
  competitors,
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  providerBatches,
  providerBatchRequests,
  queries,
  querySnapshots,
  runs,
  usageCounters,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { ProviderRegistry } from '../src/provider-registry.js'

// Shared fixtures for the provider batch tests (#1201): a project with a
// published plan, an in-memory batch API the test drives by hand, and an
// adapter whose sync and batch halves read the same body the same way.

export const NOW = '2026-09-24T06:00:00.000Z'
export const NORTH: LocationContext = { label: 'north-city', city: 'North City', region: 'NC', country: 'US' }
export const ANSWER = [
  'Planned Co is a solid choice for widgets.',
  '- **Rivalry Widgets**: cheaper, see rivalrywidgets.com',
].join('\n')
export const SOURCES = [
  { uri: 'https://example.com/property-001/widgets', title: 'Planned Co widgets' },
  { uri: 'https://rivalrywidgets.com/pricing', title: 'Rivalry pricing' },
]
export const CLAUDE_MODEL = 'claude-sonnet-4-6'
export const GEMINI_MODEL = 'gemini-planned'

/** Usage every fake answer reports: 1,000 input and 200 output tokens, 2 searches. */
export const FAKE_USAGE = { input_tokens: 1000, output_tokens: 200, searches: 2 }

/**
 * `claude-sonnet-4-6` is in the built-in table ($3 / $15 per MTok, $10 per
 * 1,000 searches, batch halves tokens): tokens 1000×3 + 200×15 = 6,000 µ$,
 * searches 2 × 10,000 µ$ = 20,000 µ$.
 */
export const CLAUDE_STANDARD_COST = 26_000
export const CLAUDE_BATCH_COST = 3_000 + 20_000

/** The gemini override prices tokens only: 1000×1 + 200×4 = 1,800 µ$. */
export const GEMINI_PRICING: ProviderPricing = { models: { [GEMINI_MODEL]: { inputPerMTok: 1, outputPerMTok: 4 } } }
export const GEMINI_STANDARD_COST = 1_800

export function tempDb(prefix = 'canonry-batch-'): DatabaseClient {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  return db
}

function v2Plan(count: number, providers: readonly string[], modelsFor: (index: number) => Record<string, string>): MeasurementPlanV2 {
  const questions = Array.from({ length: count }, (_, index) => ({ id: `q-${index + 1}`, text: `widget question ${index + 1}` }))
  const draft: MeasurementPlanV2 = {
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'example.com', ownedHosts: ['example.com'], names: ['Planned Co'] } },
    targets: [{
      stableKey: 'property-001',
      label: 'property-001',
      aliases: ['property-001'],
      urlMatchers: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/property-001', pathCase: 'insensitive' }],
      mentionNotApplicable: false,
      discoveryIdentity: null,
    }],
    groups: [],
    querySnapshots: questions.map(q => ({ queryId: q.id, queryText: q.text, provenance: { source: 'manual', sourceId: null, capturedAt: NOW } })),
    assignments: questions.map((q, index) => ({ targetKey: 'property-001', queryId: q.id, queryClass: 'non-brand', executionNodeKey: `exec-${index + 1}` })),
    executionNodes: questions.map((q, index) => ({
      stableKey: `exec-${index + 1}`,
      queryId: q.id,
      queryText: q.text,
      context: { providers: [...providers], models: modelsFor(index), location: NORTH },
      expectedSnapshots: providers.length,
    })),
    usageEdges: questions.map((q, index) => ({ executionNodeKey: `exec-${index + 1}`, targetKey: 'property-001', queryId: q.id })),
    compiledChecksum: '0'.repeat(64),
  }
  return { ...draft, compiledChecksum: crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(draft)).digest('hex') }
}

export interface SeededProject {
  db: DatabaseClient
  projectId: string
}

/**
 * A project with `count` questions and a published plan measured by
 * `providers`: an Advanced (v2) portfolio that freezes each engine's model in
 * the revision, or a Simple (v1) plan whose models come from the queue.
 */
export function seedPlannedProject(options: {
  db?: DatabaseClient
  count: number
  providers?: readonly string[]
  schema?: 1 | 2
  /** v2 only: the claude model each question's node freezes, by index. */
  claudeModels?: readonly string[]
  /** The model an engine runs on, in place of its default here (e.g. a retired id). */
  models?: Readonly<Record<string, string>>
}): SeededProject {
  const db = options.db ?? tempDb()
  const providers = options.providers ?? ['claude', 'gemini']
  const models: Record<string, string> = {}
  for (const provider of providers) {
    models[provider] = options.models?.[provider]
      ?? (provider === 'claude' ? CLAUDE_MODEL : provider === 'gemini' ? GEMINI_MODEL : `${provider}-model`)
  }
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: `planned-${projectId.slice(0, 8)}`, displayName: 'Planned Co', canonicalDomain: 'example.com', aliases: ['Planned Co'],
    country: 'US', language: 'en', providers: [...providers], locations: [NORTH], defaultLocation: NORTH.label,
    providerModels: options.schema === 1 ? models : {}, createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(competitors).values({ id: crypto.randomUUID(), projectId, domain: 'rivalrywidgets.com', createdAt: NOW }).run()
  const questions = Array.from({ length: options.count }, (_, index) => ({ id: `${projectId}-q-${index + 1}`, text: `widget question ${index + 1}` }))
  for (const q of questions) db.insert(queries).values({ id: q.id, projectId, query: q.text, createdAt: NOW }).run()

  const versionId = crypto.randomUUID()
  if (options.schema === 1) {
    const plan = compileMeasurementPlan({
      schemaVersion: 1,
      targets: [{
        stableKey: 'north-branch',
        label: 'North branch',
        urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/north', pathCase: 'insensitive' }],
        aliases: ['North branch'],
      }],
      groups: [],
      targetQuerySelections: [{ targetKey: 'north-branch', queryIds: questions.map(q => q.id) }],
    }, {
      canonicalDomain: 'example.com',
      ownedDomains: [],
      brandNames: ['Planned Co'],
      defaultContext: NORTH,
      locations: [NORTH],
      trackedQueries: questions.map(q => ({ id: q.id, query: q.text })),
      expectedSnapshots: providers.length,
    })
    const canonicalJson = canonicalMeasurementPlanJson(plan)
    db.insert(measurementPlanVersions).values({
      id: versionId, projectId, revision: 1, canonicalJson,
      checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), createdAt: NOW,
    }).run()
  } else {
    const revision = v2Plan(options.count, providers, (index) => ({
      ...models,
      ...(options.claudeModels?.[index] && providers.includes('claude') ? { claude: options.claudeModels[index]! } : {}),
    }))
    // v2 questions carry their own ids; the tracked rows reuse them.
    db.delete(queries).where(eq(queries.projectId, projectId)).run()
    for (const q of revision.querySnapshots) db.insert(queries).values({ id: `${projectId}-${q.queryId}`, projectId, query: q.queryText, createdAt: NOW }).run()
    const canonicalJson = canonicalMeasurementPlanV2Json(revision)
    db.insert(measurementPlanVersions).values({
      id: versionId, projectId, revision: 1, canonicalJson,
      checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'),
      schemaVersion: 2, compiledChecksum: revision.compiledChecksum, createdAt: NOW,
    }).run()
  }
  db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()
  return { db, projectId }
}

/** Queue a full sweep that batches `batchable`, exactly as the run route would. */
export function queueBatchRun(db: DatabaseClient, projectId: string, batchable: readonly string[] = ['claude']): string {
  const queued = queueRunIfProjectIdle(db, {
    projectId,
    dispatchMode: 'batch',
    batchEligibleProviders: batchable,
    providerModels: { claude: CLAUDE_MODEL, gemini: GEMINI_MODEL },
  })
  if (queued.conflict) throw new Error('unexpected conflict')
  expect(db.select().from(runs).where(eq(runs.id, queued.runId)).get()?.providerDispatchModes)
    .toEqual(Object.fromEntries(batchable.map(provider => [provider, 'batch'])))
  return queued.runId
}

/** A deferred the test resolves by hand, to hold a provider call open. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

// --- The fake answer body both halves of the fake adapter read -------------

export interface FakeRequestBody extends Record<string, unknown> {
  model: string
  query: string
  location: string | null
}

/** What the fake provider "answers" for one request body. */
export function fakeAnswerBody(request: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `resp-${String(request.query)}`,
    query: request.query,
    model: request.model,
    answer: ANSWER,
    usage: FAKE_USAGE,
    stop_reason: 'end_turn',
    ...overrides,
  }
}

function parseFakeBody(name: string, body: Record<string, unknown>, model: string): RawQueryResult {
  if (typeof body.fail === 'string') throw new Error(`[fake-${name}] ${body.fail}`)
  const usage = body.usage as typeof FAKE_USAGE | undefined
  return {
    provider: name,
    rawResponse: body,
    model,
    servedModel: `${model}-served`,
    groundingSources: SOURCES,
    searchQueries: [String(body.query)],
    retrievalStatus: 'used',
    retrievalContract: 'search-required-v1',
    ...(usage
      ? { usage: { inputTokens: usage.input_tokens, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: usage.output_tokens, searchCount: usage.searches } }
      : {}),
    ...(typeof body.stop_reason === 'string' ? { stopReason: body.stop_reason } : {}),
  }
}

export interface FakeAdapterOptions {
  /** The in-memory batch API; omitted = a sync-only adapter. */
  transport?: FakeBatchTransport
  /** Held open before every sync call returns. */
  syncGate?: Promise<void>
  /** Called on every sync call, before it answers. */
  onSyncCall?: (input: TrackedQueryInput, config: ProviderConfig) => void
  /** Make a sync call fail with this message. */
  syncFailure?: (input: TrackedQueryInput) => string | null
}

/**
 * An adapter whose sync call is exactly build → answer → parse, like the real
 * adapters, so a sync fallback and a batch line are read by the same parser.
 */
export function fakeAdapter(name: string, options: FakeAdapterOptions = {}): ProviderAdapter {
  const build = (input: TrackedQueryInput, config: ProviderConfig) => ({
    endpoint: '/v1/fake',
    body: { model: config.model ?? `${name}-default`, query: input.query, location: input.location?.label ?? null } satisfies FakeRequestBody,
  })
  return {
    name,
    displayName: name,
    mode: 'api',
    supportsLocationContext: true,
    modelRegistry: { defaultModel: `${name}-default`, validationPattern: /./, validationHint: 'any', knownModels: [] },
    validateConfig(): ProviderHealthcheckResult { return { ok: true, provider: name, message: 'ok' } },
    async healthcheck(): Promise<ProviderHealthcheckResult> { return { ok: true, provider: name, message: 'ok' } },
    buildTrackedQueryRequest: build,
    parseTrackedQueryResponse: (body, model) => parseFakeBody(name, body, model),
    async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
      options.onSyncCall?.(input, config)
      if (options.syncGate) await options.syncGate
      const failure = options.syncFailure?.(input)
      if (failure) throw new Error(`[fake-${name}] ${failure}`)
      const request = build(input, config)
      return parseFakeBody(name, fakeAnswerBody(request.body), request.body.model)
    },
    ...(options.transport ? { batch: options.transport.capability } : {}),
    normalizeResult(raw: RawQueryResult): NormalizedQueryResult {
      return {
        provider: name,
        answerText: String(raw.rawResponse.answer ?? ''),
        citedDomains: ['example.com', 'rivalrywidgets.com'],
        groundingSources: raw.groundingSources,
        searchQueries: raw.searchQueries,
        retrievalStatus: 'used',
      }
    },
    async generateText(): Promise<string> { return 'fake' },
  }
}

// --- An in-memory batch API ------------------------------------------------

export interface FakeBatch {
  id: string
  requests: ProviderBatchRequestInput[]
  status: ProviderBatchPollStatus
  lines: ProviderBatchResultLine[]
  cancelled: boolean
}

export type SubmitOutcome = 'ok' | 'definite' | 'ambiguous' | ((requests: readonly ProviderBatchRequestInput[]) => Promise<void>)

/**
 * The provider side of a batch, driven by the test: `end()` finishes a batch
 * with the lines a callback chooses, and every call is recorded.
 */
export class FakeBatchTransport {
  readonly batches = new Map<string, FakeBatch>()
  readonly submitCalls: ProviderBatchRequestInput[][] = []
  readonly pollCalls: string[] = []
  readonly resultsCalls: string[] = []
  readonly cancelCalls: string[] = []
  /** Consumed one per submit; `ok` once exhausted. */
  submitOutcomes: SubmitOutcome[] = []
  /** Thrown by the next poll calls, one per call. */
  pollFailures: Error[] = []
  /** Thrown by `results` after this many lines, once. */
  breakResultsAfter: number | null = null
  /** Thrown by every `results` call while set. */
  resultsFailure: Error | null = null
  /** Called before each result line is handed over, with its index. */
  onResultLine: ((index: number) => void) | null = null
  private sequence = 0

  constructor(readonly limits: { maxRequestsPerBatch?: number; maxBytesPerBatch?: number; defaultDeadlineHours?: number } = {}) {}

  get capability(): ProviderBatchCapability {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the capability is a plain object whose methods close over the transport.
    const transport = this
    return {
      maxRequestsPerBatch: this.limits.maxRequestsPerBatch ?? 100_000,
      maxBytesPerBatch: this.limits.maxBytesPerBatch ?? 256 * 1024 * 1024,
      defaultDeadlineHours: this.limits.defaultDeadlineHours ?? 24,
      async submit(requests) {
        transport.submitCalls.push([...requests])
        const outcome = transport.submitOutcomes.shift() ?? 'ok'
        if (outcome === 'definite') throw new ProviderBatchSubmitError('[fake] batch submit failed: 400 invalid_request_error', { definite: true })
        if (outcome === 'ambiguous') throw new ProviderBatchSubmitError('[fake] batch submit failed: Request timed out', { definite: false })
        if (typeof outcome === 'function') await outcome(requests)
        const id = `fakebatch_${++transport.sequence}`
        transport.batches.set(id, { id, requests: [...requests], status: 'in_progress', lines: [], cancelled: false })
        return { providerBatchId: id, expiresAt: '2026-09-25T06:00:00.000Z' }
      },
      async poll(providerBatchId) {
        transport.pollCalls.push(providerBatchId)
        const failure = transport.pollFailures.shift()
        if (failure) throw failure
        const batch = transport.require(providerBatchId)
        return { status: batch.status, ...(batch.status === 'ended' ? { endedAt: NOW } : {}) }
      },
      async *results(providerBatchId) {
        transport.resultsCalls.push(providerBatchId)
        if (transport.resultsFailure) throw transport.resultsFailure
        const batch = transport.require(providerBatchId)
        if (batch.status !== 'ended') throw new Error(`[fake] batch ${providerBatchId} has not ended`)
        let sent = 0
        for (const line of batch.lines) {
          if (transport.breakResultsAfter !== null && sent === transport.breakResultsAfter) {
            transport.breakResultsAfter = null
            throw new Error('[fake] results stream dropped')
          }
          transport.onResultLine?.(sent)
          sent += 1
          yield line
        }
      },
      async cancel(providerBatchId) {
        transport.cancelCalls.push(providerBatchId)
        const batch = transport.require(providerBatchId)
        batch.cancelled = true
        if (batch.status === 'in_progress') batch.status = 'canceling'
      },
    }
  }

  require(providerBatchId: string): FakeBatch {
    const batch = this.batches.get(providerBatchId)
    if (!batch) throw new Error(`[fake] no batch ${providerBatchId}`)
    return batch
  }

  /** The only batch submitted so far. */
  only(): FakeBatch {
    expect(this.batches.size).toBe(1)
    return [...this.batches.values()][0]!
  }

  /**
   * End a batch. `lineFor` answers each request; the default answers every
   * one. Lines are returned in reverse order, since a provider promises none.
   */
  end(providerBatchId: string, lineFor?: (request: ProviderBatchRequestInput, index: number) => ProviderBatchResultLine | null): void {
    const batch = this.require(providerBatchId)
    batch.status = 'ended'
    batch.lines = batch.requests
      .map((request, index) => lineFor ? lineFor(request, index) : succeeded(request))
      .filter((line): line is ProviderBatchResultLine => line !== null)
      .reverse()
  }
}

export function succeeded(request: ProviderBatchRequestInput, overrides: Record<string, unknown> = {}): ProviderBatchResultLine {
  return { customId: request.customId, type: 'succeeded', body: fakeAnswerBody(request.request.body, overrides) }
}

// --- Registry and reads ----------------------------------------------------

export function registryOf(entries: ReadonlyArray<{ adapter: ProviderAdapter; config?: Partial<ProviderConfig> }>): ProviderRegistry {
  const registry = new ProviderRegistry()
  for (const { adapter, config } of entries) {
    registry.register(adapter, {
      provider: adapter.name,
      apiKey: 'test-key',
      quotaPolicy: { maxConcurrency: 4, maxRequestsPerMinute: 6000, maxRequestsPerDay: 1000 },
      ...config,
    })
  }
  return registry
}

export const runRow = (db: DatabaseClient, runId: string) => db.select().from(runs).where(eq(runs.id, runId)).get()!

export const batchRows = (db: DatabaseClient, runId: string) => db.select().from(providerBatches)
  .where(eq(providerBatches.runId, runId)).all()
  .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.model.localeCompare(right.model))

export const requestRows = (db: DatabaseClient, batchId: string) => db.select().from(providerBatchRequests)
  .where(eq(providerBatchRequests.batchId, batchId)).all()
  .sort((left, right) => left.executionId.localeCompare(right.executionId))

export const snapshotRows = (db: DatabaseClient, runId: string) => db.select().from(querySnapshots)
  .where(eq(querySnapshots.runId, runId)).all()
  .sort((left, right) => `${left.provider}:${left.measurementExecutionId}`.localeCompare(`${right.provider}:${right.measurementExecutionId}`))

/** Today's reserved-and-not-released `queries` count for one provider of a project. */
export const quotaUsed = (db: DatabaseClient, projectId: string, provider: string) => db.select({ count: usageCounters.count })
  .from(usageCounters)
  .where(and(eq(usageCounters.scope, `${projectId}:${provider}`), eq(usageCounters.metric, 'queries')))
  .get()?.count ?? 0

export const runsCounted = (db: DatabaseClient, projectId: string) => db.select({ count: usageCounters.count })
  .from(usageCounters)
  .where(and(eq(usageCounters.scope, projectId), eq(usageCounters.metric, 'runs')))
  .get()?.count ?? 0

/** The dispatch columns of one stored answer. */
export function dispatchOf(row: typeof querySnapshots.$inferSelect) {
  return {
    provider: row.provider,
    executionId: row.measurementExecutionId,
    dispatchMode: row.dispatchMode,
    providerBatchId: row.providerBatchId,
    stopReason: row.stopReason,
    usage: row.usage,
  }
}

export function usageOf(tier: 'standard' | 'batch', cost: number | null, source: 'default' | 'override' | null) {
  return {
    inputTokens: FAKE_USAGE.input_tokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: FAKE_USAGE.output_tokens,
    searchCount: FAKE_USAGE.searches,
    pricingTier: tier,
    estimatedCostMicros: cost,
    priceSource: source,
  }
}
