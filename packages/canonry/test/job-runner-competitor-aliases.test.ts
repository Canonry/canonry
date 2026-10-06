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
  'Top picks for roof coatings:',
  '- **FoamSeal**: fast quotes and a long warranty.',
  '- **Roofwise**: strong reviews.',
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
    name: 'roofwise',
    displayName: 'Roofwise',
    canonicalDomain: 'roofwise.example',
    country: 'US',
    language: 'en',
    providers: ['openai'],
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  db.insert(queries).values({ id: crypto.randomUUID(), projectId, query: 'best roof coating contractor', createdAt: NOW }).run()
  db.insert(competitors).values({
    id: crypto.randomUUID(),
    projectId,
    domain: 'sealfoamworks.example',
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
    const { projectId, runId } = seed(db, ['FoamSeal', 'sealfoamworks'])
    await new JobRunner(db, registry([])).executeRun(runId, projectId)

    const definition = db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, runId)).get()!.definition
    // The label is not repeated when an alias spells it.
    expect(definition.competitors).toEqual([
      { domain: 'sealfoamworks.example', label: 'sealfoamworks', aliases: ['sealfoamworks', 'FoamSeal'] },
    ])

    const snapshot = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).get()!
    expect(snapshot.competitorOverlap).toEqual(['sealfoamworks.example'])
    expect(snapshot.recommendedCompetitors).toEqual(['FoamSeal'])
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
      { domain: 'sealfoamworks.example', label: 'sealfoamworks', aliases: ['sealfoamworks'] },
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
    db.update(competitors).set({ aliases: ['FoamSeal'] }).where(eq(competitors.projectId, projectId)).run()

    const result = backfillProjectAnswerMentions(db, projectId)
    expect(result.examined).toBe(1)
    expect(result.updated).toBe(1)
    const snapshot = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).get()!
    expect(snapshot.competitorOverlap).toEqual(['sealfoamworks.example'])
    expect(snapshot.recommendedCompetitors).toEqual(['FoamSeal'])
    // A frozen definition is never relabelled from live config.
    expect(db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, runId)).get()!.definition.competitors?.[0]?.aliases).toEqual(['sealfoamworks'])
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
      identity: { displayName: 'Roofwise', aliases: [], canonicalDomain: 'roofwise.example', ownedDomains: [] },
      country: 'US',
      language: 'en',
      location: null,
      engines: [{ provider: 'openai', requestedModel: 'fake-model' }],
      competitors: [{ domain: 'sealfoamworks.example', label: 'sealfoamworks', aliases }],
      queries: [{ queryId, queryText: 'best roof coating contractor', provenance: null }],
    })
    captureSimpleMeasurementDefinition(db, { projectId, runId, definition: definitionWith(['sealfoamworks']) })
    // Identical replay is idempotent.
    expect(() => captureSimpleMeasurementDefinition(db, { projectId, runId, definition: definitionWith(['sealfoamworks']) })).not.toThrow()
    expect(() => captureSimpleMeasurementDefinition(db, { projectId, runId, definition: definitionWith(['sealfoamworks', 'FoamSeal']) }))
      .toThrow('This run already has a captured measurement definition. Start a new run for changed inputs.')
  } finally {
    db.$client.close()
  }
})
