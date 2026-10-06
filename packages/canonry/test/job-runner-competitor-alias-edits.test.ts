import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  ProviderBatchStatuses,
  RunKinds,
  RunStatuses,
  RunTriggers,
  type LocationContext,
  type MeasurementPlanV2,
  type ProviderAdapter,
} from '@ainyc/canonry-contracts'
import { queueRunFill, queueRunIfProjectIdle } from '@ainyc/canonry-api-routes'
import {
  competitors,
  measurementPlans,
  measurementPlanVersions,
  projects,
  providerBatches,
  queries,
  querySnapshots,
  runs,
  simpleMeasurementDefinitions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'
import { backfillProjectAnswerMentions } from '../src/commands/backfill.js'
import { fakeAdapter } from './fake-measurement-provider.js'
import {
  batchRows,
  FakeBatchTransport,
  fakeAdapter as fakeBatchAdapter,
  queueBatchRun,
  registryOf,
  seedPlannedProject,
  succeeded,
  tempDb,
} from './provider-batch-harness.js'

// A curated alias saved while a writer is recording into a run. The server's
// `onCompetitorAliasesChanged` hook rescores the answers already stored, once;
// the writer still holds the names it read before the edit. Every answer of
// the run must still end up scored against the names saved last, whichever
// path wrote it.

const NOW = '2026-10-05T12:00:00.000Z'
const NORTH: LocationContext = { label: 'north-city', city: 'North City', region: 'NC', country: 'US' }
const RIVAL = 'spoketuneworks.example'
// Every question gets this answer, so every stored row must agree.
const ANSWER = [
  'Top picks for bike repair:',
  '- **TuneSpoke**: fast quotes and a long warranty.',
  '- **Rotorwise**: strong reviews.',
].join('\n')
/** One answer's stored competitor columns once "TuneSpoke" names the rival. */
const CURRENT = { competitorOverlap: [RIVAL], recommendedCompetitors: ['TuneSpoke'] }
const STALE = { competitorOverlap: [], recommendedCompetitors: [] }

beforeEach(() => {
  resetSharedProviderExecutionGates()
})

/** The alias write, then what the server's hook runs once it commits. */
function saveAlias(db: DatabaseClient, projectId: string, opts: { hook: boolean } = { hook: true }): void {
  db.update(competitors).set({ aliases: ['TuneSpoke'] }).where(eq(competitors.projectId, projectId)).run()
  if (opts.hook) backfillProjectAnswerMentions(db, projectId, { competitorFieldsOnly: true })
}

function competitorColumns(db: DatabaseClient, runId: string) {
  return db.select({
    competitorOverlap: querySnapshots.competitorOverlap,
    recommendedCompetitors: querySnapshots.recommendedCompetitors,
  }).from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
}

const runStatus = (db: DatabaseClient, runId: string) => db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get()!.status

/** Answers ANSWER, running `before[n]` just ahead of its nth call. */
function editingAdapter(name: string, before: Record<number, () => void>): ProviderAdapter {
  const base = fakeAdapter({ name, calls: [], answerText: ANSWER })
  let seen = 0
  return {
    ...base,
    async executeTrackedQuery(input, config) {
      seen += 1
      before[seen]?.()
      return base.executeTrackedQuery(input, config)
    },
  }
}

/** One call at a time, so each answer is stored before the next call starts. */
function serialRegistry(...adapters: ProviderAdapter[]): ProviderRegistry {
  const registry = new ProviderRegistry()
  for (const adapter of adapters) {
    registry.register(adapter, {
      provider: adapter.name,
      apiKey: 'test-key',
      quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 6000, maxRequestsPerDay: 1000 },
    })
  }
  return registry
}

function seedProject(db: DatabaseClient, providers: string[]): string {
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'rotorwise',
    displayName: 'Rotorwise',
    canonicalDomain: 'rotorwise.example',
    country: 'US',
    language: 'en',
    providers,
    locations: [NORTH],
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  db.insert(competitors).values({ id: crypto.randomUUID(), projectId, domain: RIVAL, createdAt: NOW }).run()
  return projectId
}

function seedSimpleProject(db: DatabaseClient, queryTexts = ['best bike repair shop', 'bike repair near me']): string {
  const projectId = seedProject(db, ['openai'])
  for (const query of queryTexts) {
    db.insert(queries).values({ id: crypto.randomUUID(), projectId, query, createdAt: NOW }).run()
  }
  return projectId
}

/** An Advanced portfolio: one Property, two questions, each answered by every provider. */
function seedAdvancedProject(db: DatabaseClient, providers: string[]): string {
  const projectId = seedProject(db, [])
  const questions = [{ id: 'q-1', text: 'best bike repair shop' }, { id: 'q-2', text: 'bike repair near me' }]
  const models = Object.fromEntries(providers.map(provider => [provider, `${provider}-planned`]))
  const draft: MeasurementPlanV2 = {
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'rotorwise.example', ownedHosts: ['rotorwise.example'], names: ['Rotorwise'] } },
    targets: [{
      stableKey: 'property-001',
      label: 'property-001',
      aliases: ['property-001'],
      urlMatchers: [{ kind: 'prefix', host: 'rotorwise.example', pathPrefix: '/property-001', pathCase: 'insensitive' }],
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
      context: { providers, models, location: NORTH },
      expectedSnapshots: providers.length,
    })),
    usageEdges: questions.map((q, index) => ({ executionNodeKey: `exec-${index + 1}`, targetKey: 'property-001', queryId: q.id })),
    compiledChecksum: '0'.repeat(64),
  }
  const revision = { ...draft, compiledChecksum: crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(draft)).digest('hex') }
  for (const q of questions) db.insert(queries).values({ id: q.id, projectId, query: q.text, createdAt: NOW }).run()
  const canonicalJson = canonicalMeasurementPlanV2Json(revision)
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId, projectId, revision: 1, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'),
    schemaVersion: 2, compiledChecksum: revision.compiledChecksum, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()
  return projectId
}

function queue(db: DatabaseClient, projectId: string): string {
  const queued = queueRunIfProjectIdle(db, { projectId })
  if (queued.conflict) throw new Error('unexpected conflict')
  return queued.runId
}

describe('a competitor alias saved while answers are being recorded', () => {
  it('a Simple sweep ends with every answer scored against it, and its frozen definition untouched', async () => {
    const db = tempDb('canonry-alias-edit-')
    const projectId = seedSimpleProject(db)
    const runId = queue(db, projectId)

    // The first answer is stored before the edit, so the hook rescores it; the
    // second is recorded after it.
    await new JobRunner(db, serialRegistry(editingAdapter('openai', { 2: () => saveAlias(db, projectId) }))).executeRun(runId, projectId)

    expect(runStatus(db, runId)).toBe(RunStatuses.completed)
    expect(competitorColumns(db, runId)).toEqual([CURRENT, CURRENT])
    // The definition records what the sweep dispatched with, not a later edit.
    expect(db.select().from(simpleMeasurementDefinitions).where(eq(simpleMeasurementDefinitions.runId, runId)).get()!
      .definition.competitors).toEqual([{ domain: RIVAL, label: 'spoketuneworks', aliases: ['spoketuneworks'] }])
  })

  it('a Simple sweep cancelled after the edit keeps its stored answers scored against it', async () => {
    const db = tempDb('canonry-alias-edit-')
    const projectId = seedSimpleProject(db, ['best bike repair shop', 'bike repair near me', 'bike tune up cost'])
    const runId = queue(db, projectId)
    const cancel = () => db.update(runs).set({ status: RunStatuses.cancelled }).where(eq(runs.id, runId)).run()

    // The third answer is discarded by the cancel; the second was stored after the edit.
    await new JobRunner(db, serialRegistry(editingAdapter('openai', { 2: () => saveAlias(db, projectId), 3: cancel }))).executeRun(runId, projectId)

    expect(runStatus(db, runId)).toBe(RunStatuses.cancelled)
    expect(competitorColumns(db, runId)).toEqual([CURRENT, CURRENT])
  })

  it('an Advanced sweep ends with every answer scored against it', async () => {
    const db = tempDb('canonry-alias-edit-')
    const projectId = seedAdvancedProject(db, ['openai'])
    const runId = queue(db, projectId)

    await new JobRunner(db, serialRegistry(editingAdapter('openai', { 2: () => saveAlias(db, projectId) }))).executeRun(runId, projectId)

    expect(runStatus(db, runId)).toBe(RunStatuses.completed)
    expect(competitorColumns(db, runId)).toEqual([CURRENT, CURRENT])
  })

  it('a fill ends with the answers it adds scored like the ones the sweep stored', async () => {
    const db = tempDb('canonry-alias-edit-')
    const projectId = seedAdvancedProject(db, ['openai', 'gemini'])
    const runId = queue(db, projectId)
    const failing = fakeAdapter({ name: 'openai', calls: [], answerText: ANSWER, failFromCall: 1 })
    const gemini = fakeAdapter({ name: 'gemini', calls: [], answerText: ANSWER })
    await new JobRunner(db, serialRegistry(failing, gemini)).executeRun(runId, projectId)
    expect(runStatus(db, runId)).toBe(RunStatuses.partial)
    expect(competitorColumns(db, runId)).toEqual([STALE, STALE])

    const admitted = queueRunFill(db, runId)
    if (admitted.kind !== 'queued') throw new Error(`expected a queued fill, got ${admitted.kind}`)
    await new JobRunner(db, serialRegistry(editingAdapter('openai', { 2: () => saveAlias(db, projectId) }), gemini)).executeRunFill(admitted.fill.id)

    expect(runStatus(db, runId)).toBe(RunStatuses.completed)
    expect(competitorColumns(db, runId)).toEqual([CURRENT, CURRENT, CURRENT, CURRENT])
  })

  it('a batch ingest ends with every answer scored against it', async () => {
    const { db, projectId } = seedPlannedProject({ count: 34, schema: 2, providers: ['claude'] })
    db.delete(competitors).where(eq(competitors.projectId, projectId)).run()
    db.insert(competitors).values({ id: crypto.randomUUID(), projectId, domain: RIVAL, createdAt: NOW }).run()
    const transport = new FakeBatchTransport()
    const runner = new JobRunner(db, registryOf([{ adapter: fakeBatchAdapter('claude', { transport }), config: { batch: { enabled: true } } }]))
    const runId = queueBatchRun(db, projectId)
    await runner.executeRun(runId, projectId)
    const batch = batchRows(db, runId)[0]!
    transport.end(batch.providerBatchId!, request => succeeded(request, { answer: ANSWER }))
    db.update(providerBatches).set({ status: ProviderBatchStatuses.ended }).where(eq(providerBatches.id, batch.id)).run()
    // The first 32 answers commit as one chunk before the edit; the last two
    // were read under the old names.
    transport.onResultLine = (index) => {
      if (index === 32) saveAlias(db, projectId)
    }

    expect(await runner.ingestProviderBatch(batch.id)).toEqual({ kind: 'ingested', recorded: 34, notRecorded: 0, released: 0 })

    expect(competitorColumns(db, runId)).toEqual(Array.from({ length: 34 }, () => CURRENT))
  })

  it('rescores only the run being recorded, even when no hook runs for the edit', async () => {
    const db = tempDb('canonry-alias-edit-')
    const projectId = seedSimpleProject(db)
    const earlierRunId = crypto.randomUUID()
    db.insert(runs).values({
      id: earlierRunId, projectId, kind: RunKinds['answer-visibility'], trigger: RunTriggers.manual,
      status: RunStatuses.completed, createdAt: NOW, finishedAt: NOW,
    }).run()
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(), runId: earlierRunId, provider: 'openai', citationState: 'not-cited', answerMentioned: true,
      answerText: ANSWER, citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: NOW,
    }).run()
    const runId = queue(db, projectId)

    await new JobRunner(db, serialRegistry(editingAdapter('openai', { 2: () => saveAlias(db, projectId, { hook: false }) }))).executeRun(runId, projectId)

    expect(competitorColumns(db, runId)).toEqual([CURRENT, CURRENT])
    // Earlier runs are the alias hook's to rescore.
    expect(competitorColumns(db, earlierRunId)).toEqual([STALE])
  })
})
