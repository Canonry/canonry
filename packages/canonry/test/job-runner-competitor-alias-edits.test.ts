import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  runFills,
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
const TWO_QUESTIONS = ['best bike repair shop', 'bike repair near me']
const THREE_QUESTIONS = [...TWO_QUESTIONS, 'bike tune up cost']

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

const fillOutcome = (db: DatabaseClient, fillId: string) => db
  .select({ status: runFills.status, filled: runFills.filled, error: runFills.error })
  .from(runFills).where(eq(runFills.id, fillId)).get()

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

function seedSimpleProject(db: DatabaseClient, queryTexts = TWO_QUESTIONS): string {
  const projectId = seedProject(db, ['openai'])
  for (const query of queryTexts) {
    db.insert(queries).values({ id: crypto.randomUUID(), projectId, query, createdAt: NOW }).run()
  }
  return projectId
}

/** An Advanced portfolio: one Property whose questions are each answered by every provider. */
function seedAdvancedProject(db: DatabaseClient, providers: string[], questionTexts = TWO_QUESTIONS): string {
  const projectId = seedProject(db, [])
  const questions = questionTexts.map((text, index) => ({ id: `q-${index + 1}`, text }))
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

const gemini = () => fakeAdapter({ name: 'gemini', calls: [], answerText: ANSWER })

/**
 * An Advanced sweep in which every openai call failed and gemini answered
 * every question before any alias was saved, plus the fill admitted for the
 * openai answers it is missing.
 */
async function partialRunWithQueuedFill(db: DatabaseClient, questionTexts: string[]) {
  const projectId = seedAdvancedProject(db, ['openai', 'gemini'], questionTexts)
  const runId = queue(db, projectId)
  const failing = fakeAdapter({ name: 'openai', calls: [], answerText: ANSWER, failFromCall: 1 })
  await new JobRunner(db, serialRegistry(failing, gemini())).executeRun(runId, projectId)
  expect(runStatus(db, runId)).toBe(RunStatuses.partial)
  expect(competitorColumns(db, runId)).toEqual(questionTexts.map(() => STALE))

  const admitted = queueRunFill(db, runId)
  if (admitted.kind !== 'queued') throw new Error(`expected a queued fill, got ${admitted.kind}`)
  return { projectId, runId, fillId: admitted.fill.id }
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
    const { projectId, runId, fillId } = await partialRunWithQueuedFill(db, TWO_QUESTIONS)

    await new JobRunner(db, serialRegistry(editingAdapter('openai', { 2: () => saveAlias(db, projectId) }), gemini())).executeRunFill(fillId)

    expect(runStatus(db, runId)).toBe(RunStatuses.completed)
    expect(competitorColumns(db, runId)).toEqual([CURRENT, CURRENT, CURRENT, CURRENT])
  })

  it('a fill stopped by a newer sweep after the edit ends with every stored answer scored against it', async () => {
    const db = tempDb('canonry-alias-edit-')
    const { projectId, runId, fillId } = await partialRunWithQueuedFill(db, THREE_QUESTIONS)
    // A partial run cannot be cancelled; a sweep queued meanwhile is what stops
    // its fill. The second filled answer is recorded after the edit, and the
    // sweep queued with it stops the fill before the third call.
    const editThenQueueSweep = () => {
      saveAlias(db, projectId)
      queue(db, projectId)
    }

    await new JobRunner(db, serialRegistry(editingAdapter('openai', { 2: editThenQueueSweep }), gemini())).executeRunFill(fillId)

    expect(fillOutcome(db, fillId)).toEqual({
      status: 'partial',
      filled: 2,
      error: 'Stopped because a newer sweep started; no answers were added behind it.',
    })
    expect(runStatus(db, runId)).toBe(RunStatuses.partial)
    // Three sweep answers, then the two the fill recorded.
    expect(competitorColumns(db, runId)).toEqual([CURRENT, CURRENT, CURRENT, CURRENT, CURRENT])
  })

  it('a fill that fails fatally after the edit ends with every stored answer scored against it', async () => {
    const db = tempDb('canonry-alias-edit-')
    const { projectId, runId, fillId } = await partialRunWithQueuedFill(db, THREE_QUESTIONS)
    // The database fails the fill's attempt check before its third call. No
    // per-answer handler catches that, so the fill fails with two answers
    // recorded, the second after the edit.
    const prepare = db.$client.prepare.bind(db.$client)
    let failNextAttemptRead = false
    vi.spyOn(db.$client, 'prepare').mockImplementation(((source: string) => {
      if (failNextAttemptRead && source.includes('from "run_fills"')) {
        failNextAttemptRead = false
        throw new Error('disk I/O error')
      }
      return prepare(source)
    }) as typeof db.$client.prepare)
    const editThenFailDatabase = () => {
      saveAlias(db, projectId)
      failNextAttemptRead = true
    }

    await new JobRunner(db, serialRegistry(editingAdapter('openai', { 2: editThenFailDatabase }), gemini())).executeRunFill(fillId)

    expect(failNextAttemptRead).toBe(false)
    expect(fillOutcome(db, fillId)).toEqual({ status: 'partial', filled: 2, error: 'disk I/O error' })
    expect(runStatus(db, runId)).toBe(RunStatuses.partial)
    // Three sweep answers, then the two the fill recorded.
    expect(competitorColumns(db, runId)).toEqual([CURRENT, CURRENT, CURRENT, CURRENT, CURRENT])
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

describe('any other identity change while answers are being recorded', () => {
  const mentioned = (db: DatabaseClient, runId: string) => db.select({ answerMentioned: querySnapshots.answerMentioned })
    .from(querySnapshots).where(eq(querySnapshots.runId, runId)).all().map(row => row.answerMentioned)

  it('a detection pass that stores an auto-detected name mid-sweep ends with every answer scored against it', async () => {
    const db = tempDb('canonry-alias-edit-')
    const projectId = seedSimpleProject(db)
    const runId = queue(db, projectId)
    // What a detection pass writes, then the recompute its names change runs.
    const storeAutoName = () => {
      db.update(competitors).set({
        autoAliases: [{
          name: 'TuneSpoke', directPairs: 4, cooccurrences: 2, namingAnswers: 5, precision: 0.8, lift: 12,
          nameCasedAnswers: 5, runs: 3, firstSeen: NOW, lastSeen: NOW, addedAt: NOW,
        }],
      }).where(eq(competitors.projectId, projectId)).run()
      backfillProjectAnswerMentions(db, projectId, { competitorFieldsOnly: true })
    }

    await new JobRunner(db, serialRegistry(editingAdapter('openai', { 2: storeAutoName }))).executeRun(runId, projectId)

    expect(runStatus(db, runId)).toBe(RunStatuses.completed)
    expect(competitorColumns(db, runId)).toEqual([CURRENT, CURRENT])
  })

  it('a project alias saved mid-sweep ends with every answer\'s mention scored against it', async () => {
    const db = tempDb('canonry-alias-edit-')
    const projectId = seedSimpleProject(db)
    // The project goes by another name, so "Rotorwise" in the answer is not
    // its mention until the edit adds the alias.
    db.update(projects).set({ displayName: 'Quiet Vox', canonicalDomain: 'quietvox.example' }).where(eq(projects.id, projectId)).run()
    const runId = queue(db, projectId)
    // The project alias write, then the full rescore the server's hook runs.
    const saveProjectAlias = () => {
      db.update(projects).set({ aliases: ['Rotorwise'] }).where(eq(projects.id, projectId)).run()
      backfillProjectAnswerMentions(db, projectId)
    }

    await new JobRunner(db, serialRegistry(editingAdapter('openai', { 2: saveProjectAlias }))).executeRun(runId, projectId)

    expect(runStatus(db, runId)).toBe(RunStatuses.completed)
    expect(mentioned(db, runId)).toEqual([true, true])
  })
})
