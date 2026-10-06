import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeEach, expect, test } from 'vitest'
import { buildSimpleMeasurementDefinition, RunKinds, RunStatuses, RunTriggers, type ProviderAdapter } from '@ainyc/canonry-contracts'
import { captureSimpleMeasurementDefinition } from '@ainyc/canonry-api-routes'
import {
  competitors,
  createClient,
  migrate,
  projects,
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
import { fakeAdapter, type RecordedCall } from './fake-measurement-provider.js'

// Curated competitor aliases reach the values a planless sweep freezes: the
// Simple measurement definition's competitor identity and the per-snapshot
// `competitor_overlap` / `recommended_competitors` columns.

const NOW = '2026-10-05T12:00:00.000Z'
const ANSWER = [
  'Top picks for bike repair:',
  '- **TuneSpoke**: fast quotes and a long warranty.',
  '- **Rotorwise**: strong reviews.',
].join('\n')

function buildDb(): DatabaseClient {
  const db = createClient(':memory:')
  migrate(db)
  return db
}

function seed(db: DatabaseClient, competitorAliases: string[]) {
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'rotorwise',
    displayName: 'Rotorwise',
    canonicalDomain: 'rotorwise.example',
    country: 'US',
    language: 'en',
    providers: ['openai'],
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  db.insert(queries).values({ id: crypto.randomUUID(), projectId, query: 'best bike repair shop', createdAt: NOW }).run()
  db.insert(competitors).values({
    id: crypto.randomUUID(),
    projectId,
    domain: 'spoketuneworks.example',
    aliases: competitorAliases,
    createdAt: NOW,
  }).run()
  db.insert(runs).values({
    id: runId,
    projectId,
    kind: RunKinds['answer-visibility'],
    trigger: RunTriggers.manual,
    status: RunStatuses.queued,
    createdAt: NOW,
  }).run()
  return { projectId, runId }
}

function registry(calls: RecordedCall[]): ProviderRegistry {
  const providers = new ProviderRegistry()
  providers.register(fakeAdapter({ name: 'openai', calls, answerText: ANSWER }) as ProviderAdapter, {
    provider: 'openai',
    apiKey: 'test-key',
    model: 'fake-model',
    quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 600, maxRequestsPerDay: 100 },
  })
  return providers
}

beforeEach(() => {
  resetSharedProviderExecutionGates()
})

test('freezes curated aliases into the Simple definition and scores the planless answer with them', async () => {
  const db = buildDb()
  try {
    const { projectId, runId } = seed(db, ['TuneSpoke', 'spoketuneworks'])
    await new JobRunner(db, registry([])).executeRun(runId, projectId)

    const definition = db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, runId)).get()!.definition
    // The label is not repeated when an alias spells it.
    expect(definition.competitors).toEqual([
      { domain: 'spoketuneworks.example', label: 'spoketuneworks', aliases: ['spoketuneworks', 'TuneSpoke'] },
    ])

    const snapshot = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).get()!
    expect(snapshot.competitorOverlap).toEqual(['spoketuneworks.example'])
    expect(snapshot.recommendedCompetitors).toEqual(['TuneSpoke'])
  } finally {
    db.$client.close()
  }
})

test('a competitor without curated aliases freezes exactly as before', async () => {
  const db = buildDb()
  try {
    const { projectId, runId } = seed(db, [])
    await new JobRunner(db, registry([])).executeRun(runId, projectId)

    expect(db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, runId)).get()!.definition.competitors).toEqual([
      { domain: 'spoketuneworks.example', label: 'spoketuneworks', aliases: ['spoketuneworks'] },
    ])
    const snapshot = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).get()!
    expect(snapshot.competitorOverlap).toEqual([])
    expect(snapshot.recommendedCompetitors).toEqual([])
  } finally {
    db.$client.close()
  }
})

test('the mention backfill refreshes stored competitor columns after an alias is added, leaving the frozen definition alone', async () => {
  const db = buildDb()
  try {
    const { projectId, runId } = seed(db, [])
    await new JobRunner(db, registry([])).executeRun(runId, projectId)
    db.update(competitors).set({ aliases: ['TuneSpoke'] }).where(eq(competitors.projectId, projectId)).run()

    const result = backfillProjectAnswerMentions(db, projectId)
    expect(result.examined).toBe(1)
    expect(result.updated).toBe(1)
    const snapshot = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).get()!
    expect(snapshot.competitorOverlap).toEqual(['spoketuneworks.example'])
    expect(snapshot.recommendedCompetitors).toEqual(['TuneSpoke'])
    // A frozen definition is never relabelled from live config.
    expect(db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, runId)).get()!.definition.competitors?.[0]?.aliases).toEqual(['spoketuneworks'])
  } finally {
    db.$client.close()
  }
})

test('an alias edit between capture and a retry is a changed input, like a competitor edit', () => {
  const db = buildDb()
  try {
    const { projectId, runId } = seed(db, [])
    db.update(runs).set({ status: RunStatuses.running }).where(eq(runs.id, runId)).run()
    const queryId = db.select({ id: queries.id }).from(queries).where(eq(queries.projectId, projectId)).get()!.id
    const definitionWith = (aliases: string[]) => buildSimpleMeasurementDefinition({
      capturedAt: NOW,
      identity: { displayName: 'Rotorwise', aliases: [], canonicalDomain: 'rotorwise.example', ownedDomains: [] },
      country: 'US',
      language: 'en',
      location: null,
      engines: [{ provider: 'openai', requestedModel: 'fake-model' }],
      competitors: [{ domain: 'spoketuneworks.example', label: 'spoketuneworks', aliases }],
      queries: [{ queryId, queryText: 'best bike repair shop', provenance: null }],
    })
    captureSimpleMeasurementDefinition(db, { projectId, runId, definition: definitionWith(['spoketuneworks']) })
    // Identical replay is idempotent.
    expect(() => captureSimpleMeasurementDefinition(db, { projectId, runId, definition: definitionWith(['spoketuneworks']) })).not.toThrow()
    expect(() => captureSimpleMeasurementDefinition(db, { projectId, runId, definition: definitionWith(['spoketuneworks', 'TuneSpoke']) }))
      .toThrow('This run already has a captured measurement definition. Start a new run for changed inputs.')
  } finally {
    db.$client.close()
  }
})

test('the competitor-only backfill leaves answer_mentioned alone and skips snapshots with no stored answer', async () => {
  const db = buildDb()
  try {
    const { projectId, runId } = seed(db, [])
    await new JobRunner(db, registry([])).executeRun(runId, projectId)
    const sweep = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).get()!
    expect(sweep.answerMentioned).toBe(true)
    // A legacy row with no stored answer text: its mention and competitor
    // columns came from the run and cannot be recomputed.
    db.insert(querySnapshots).values({
      id: 'legacy-no-text',
      runId,
      queryId: sweep.queryId,
      provider: 'openai',
      citationState: 'not-cited',
      answerMentioned: true,
      answerText: null,
      citedDomains: [],
      competitorOverlap: ['spoketuneworks.example'],
      recommendedCompetitors: ['TuneSpoke'],
      createdAt: NOW,
    }).run()
    // An identity change a full pass would act on. The alias hook must not.
    db.update(projects).set({ displayName: 'Renamed Shop', canonicalDomain: 'renamed-shop.example' }).where(eq(projects.id, projectId)).run()
    db.update(competitors).set({ aliases: ['TuneSpoke'] }).where(eq(competitors.projectId, projectId)).run()

    const result = backfillProjectAnswerMentions(db, projectId, { competitorFieldsOnly: true })
    expect(result).toEqual({ examined: 1, updated: 1, mentioned: 1 })
    const refreshed = db.select().from(querySnapshots).where(eq(querySnapshots.id, sweep.id)).get()!
    expect(refreshed.answerMentioned).toBe(true)
    expect(refreshed.competitorOverlap).toEqual(['spoketuneworks.example'])
    expect(refreshed.recommendedCompetitors).toEqual(['TuneSpoke'])
    const legacy = db.select().from(querySnapshots).where(eq(querySnapshots.id, 'legacy-no-text')).get()!
    expect(legacy).toMatchObject({ answerMentioned: true, competitorOverlap: ['spoketuneworks.example'], recommendedCompetitors: ['TuneSpoke'] })
    // The full pass would rewrite both rows: the sweep's mention flips (the
    // identity no longer matches) and the legacy row's competitor columns are
    // recomputed from no text. The legacy mention itself stays stored.
    expect(backfillProjectAnswerMentions(db, projectId, { dryRun: true })).toEqual({ examined: 2, updated: 0, wouldUpdate: 2, mentioned: 1 })
  } finally {
    db.$client.close()
  }
})

test('the full mention backfill keeps a stored mention when no answer text was stored', async () => {
  const db = buildDb()
  try {
    const { projectId, runId } = seed(db, [])
    await new JobRunner(db, registry([])).executeRun(runId, projectId)
    const sweep = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).get()!
    db.insert(querySnapshots).values({
      id: 'legacy-no-text',
      runId,
      queryId: sweep.queryId,
      provider: 'openai',
      citationState: 'not-cited',
      answerMentioned: true,
      answerText: null,
      citedDomains: [],
      competitorOverlap: [],
      recommendedCompetitors: [],
      createdAt: NOW,
    }).run()

    const result = backfillProjectAnswerMentions(db, projectId)
    expect(result).toMatchObject({ examined: 2, mentioned: 2 })
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.id, 'legacy-no-text')).get()!.answerMentioned).toBe(true)
  } finally {
    db.$client.close()
  }
})
