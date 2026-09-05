import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  buildSimpleMeasurementDefinition,
  canonicalSimpleMeasurementDefinitionJson,
  RunKinds,
  RunStatuses,
  RunTriggers,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  competitors,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
  simpleMeasurementDefinitions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { captureSimpleMeasurementDefinition } from '../src/simple-measurement-definitions.js'

let db: DatabaseClient
const capturedAt = '2026-09-04T16:00:00.000Z'

function definition(queryId = 'query-a') {
  return buildSimpleMeasurementDefinition({
    capturedAt,
    identity: {
      displayName: 'Northstar', aliases: ['Northstar Living'],
      canonicalDomain: 'https://northstar.example/', ownedDomains: [],
    },
    country: 'US', language: 'en', location: null,
    engines: [{ provider: 'gemini', requestedModel: 'fixture-model' }],
    queries: [{ queryId, queryText: 'Northstar reviews', provenance: 'manual' }],
  })
}

beforeEach(() => {
  db = createClient(':memory:')
  migrate(db)
  for (const suffix of ['a', 'b']) {
    db.insert(projects).values({
      id: `project-${suffix}`, name: `project-${suffix}`, displayName: 'Northstar',
      canonicalDomain: 'northstar.example', country: 'US', language: 'en',
      createdAt: capturedAt, updatedAt: capturedAt,
    }).run()
    db.insert(queries).values({
      id: `query-${suffix}`, projectId: `project-${suffix}`, query: 'Northstar reviews',
      provenance: 'manual', createdAt: capturedAt,
    }).run()
    db.insert(runs).values({
      id: `run-${suffix}`, projectId: `project-${suffix}`, kind: RunKinds['answer-visibility'],
      trigger: RunTriggers.manual, status: RunStatuses.running, createdAt: capturedAt,
    }).run()
  }
})

afterEach(() => db.$client.close())

describe('simple measurement definition capture', () => {
  it('stores a validated dispatch snapshot and canonical checksum', () => {
    const frozen = definition()
    expect(captureSimpleMeasurementDefinition(db, {
      projectId: 'project-a', runId: 'run-a', definition: frozen,
    })).toEqual(frozen)
    const row = db.select().from(simpleMeasurementDefinitions).get()!
    expect(row).toEqual({
      projectId: 'project-a', runId: 'run-a', capturedAt, definition: frozen,
      checksum: crypto.createHash('sha256').update(canonicalSimpleMeasurementDefinitionJson(frozen)).digest('hex'),
    })
  })

  it('replays identical capture but refuses a changed definition', () => {
    const frozen = definition()
    const input = { projectId: 'project-a', runId: 'run-a', definition: frozen }
    captureSimpleMeasurementDefinition(db, input)
    expect(captureSimpleMeasurementDefinition(db, input)).toEqual(frozen)
    expect(() => captureSimpleMeasurementDefinition(db, {
      ...input, definition: { ...frozen, language: 'fr' },
    })).toThrow(/already.*captured/i)
    expect(db.select().from(simpleMeasurementDefinitions).all()).toHaveLength(1)
    expect(db.select().from(simpleMeasurementDefinitions).get()!.definition).toEqual(frozen)
  })

  it('keeps an old omitted competitor sidecar unavailable on a current retry', () => {
    const historical = definition()
    captureSimpleMeasurementDefinition(db, {
      projectId: 'project-a', runId: 'run-a', definition: historical,
    })

    const replayed = captureSimpleMeasurementDefinition(db, {
      projectId: 'project-a',
      runId: 'run-a',
      // New dispatch code always records its competitor set. That additive
      // field must not rewrite a historical omission as frozen-empty.
      definition: { ...historical, competitors: [] },
    })

    expect(replayed).toEqual(historical)
    expect(db.select().from(simpleMeasurementDefinitions).get()!.definition.competitors).toBeUndefined()
  })

  it('refuses mismatched project/run and project/query ownership', () => {
    expect(() => captureSimpleMeasurementDefinition(db, {
      projectId: 'project-b', runId: 'run-a', definition: definition('query-b'),
    })).toThrow()
    expect(() => captureSimpleMeasurementDefinition(db, {
      projectId: 'project-a', runId: 'run-a', definition: definition('query-b'),
    })).toThrow(/quer.*project/i)
    expect(db.select().from(simpleMeasurementDefinitions).all()).toEqual([])
  })

  it('retains the original capture time when identical inputs are captured later', () => {
    const frozen = definition()
    const input = { projectId: 'project-a', runId: 'run-a', definition: frozen }
    captureSimpleMeasurementDefinition(db, input)
    expect(captureSimpleMeasurementDefinition(db, {
      ...input, definition: { ...frozen, capturedAt: '2026-09-04T17:00:00.000Z' },
    })).toEqual(frozen)
    const rows = db.select().from(simpleMeasurementDefinitions).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.capturedAt).toBe(capturedAt)
    expect(rows[0]!.checksum).toBe(crypto.createHash('sha256')
      .update(canonicalSimpleMeasurementDefinitionJson(frozen)).digest('hex'))
  })

  it('refuses a query class that contradicts the captured identity and text', () => {
    const frozen = definition()
    expect(() => captureSimpleMeasurementDefinition(db, {
      projectId: 'project-a', runId: 'run-a',
      definition: {
        ...frozen, queries: [{ ...frozen.queries[0]!, queryClass: 'non-brand' }],
      },
    })).toThrow(/class.*captured/i)
    expect(db.select().from(simpleMeasurementDefinitions).all()).toEqual([])
  })

  it.each([
    { kind: RunKinds['answer-visibility'], trigger: RunTriggers.probe },
    { kind: RunKinds['aeo-discover-probe'], trigger: RunTriggers.manual },
    { kind: RunKinds['site-audit'], trigger: RunTriggers.manual },
  ])('never stamps $kind/$trigger as official simple measurement', (fields) => {
    db.update(runs).set(fields).where(eq(runs.id, 'run-a')).run()
    expect(captureSimpleMeasurementDefinition(db, {
      projectId: 'project-a', runId: 'run-a', definition: definition(),
    })).toBeNull()
    expect(db.select().from(simpleMeasurementDefinitions).all()).toEqual([])
  })

  it('does not infer frozen definitions for old completed runs', () => {
    db.update(runs).set({ status: RunStatuses.completed }).where(eq(runs.id, 'run-a')).run()
    expect(() => captureSimpleMeasurementDefinition(db, {
      projectId: 'project-a', runId: 'run-a', definition: definition(),
    })).toThrow(/running/i)
    expect(db.select().from(simpleMeasurementDefinitions).all()).toEqual([])
  })

  it('does not attach a new definition after a running run already stored answers', () => {
    db.insert(querySnapshots).values({
      id: 'existing-answer', runId: 'run-a', queryId: 'query-a',
      queryText: 'Earlier query text', provider: 'gemini', model: 'fixture-model',
      citationState: 'not-cited', createdAt: capturedAt,
    }).run()
    expect(() => captureSimpleMeasurementDefinition(db, {
      projectId: 'project-a', runId: 'run-a', definition: definition(),
    })).toThrow(/already.*answers/i)
    expect(db.select().from(simpleMeasurementDefinitions).all()).toEqual([])
    expect(db.select().from(querySnapshots).all()).toHaveLength(1)
  })

  it('keeps the frozen text, identity and class after live inputs change', () => {
    const frozen = definition()
    captureSimpleMeasurementDefinition(db, { projectId: 'project-a', runId: 'run-a', definition: frozen })
    db.update(projects).set({ displayName: 'Eastbank', aliases: [] }).where(eq(projects.id, 'project-a')).run()
    db.update(queries).set({ query: 'apartments near transit' }).where(eq(queries.id, 'query-a')).run()
    expect(db.select().from(simpleMeasurementDefinitions).get()!.definition).toEqual(frozen)
    expect(frozen.queries[0]!.queryClass).toBe('branded')
  })

  it('accepts historical omitted competitors but validates a new frozen competitor set against dispatch state', () => {
    db.insert(competitors).values({
      id: 'competitor-a', projectId: 'project-a', domain: 'challenger.example', createdAt: capturedAt,
    }).run()
    // Old sidecars lacked this optional field, so their legitimate historical
    // shape stays accepted rather than being retroactively rejected.
    expect(captureSimpleMeasurementDefinition(db, {
      projectId: 'project-a', runId: 'run-a', definition: definition(),
    })).toEqual(definition())

    db.insert(competitors).values({
      id: 'competitor-b', projectId: 'project-b', domain: 'challenger.example', createdAt: capturedAt,
    }).run()
    const mismatched = buildSimpleMeasurementDefinition({
      capturedAt,
      identity: { displayName: 'Northstar', aliases: ['Northstar Living'], canonicalDomain: 'northstar.example', ownedDomains: [] },
      country: 'US', language: 'en', location: null,
      engines: [{ provider: 'gemini', requestedModel: 'fixture-model' }],
      competitors: [{ domain: 'other.example', label: 'Other', aliases: [] }],
      queries: [{ queryId: 'query-b', queryText: 'Northstar reviews', provenance: 'manual' }],
    })
    expect(() => captureSimpleMeasurementDefinition(db, {
      projectId: 'project-b', runId: 'run-b', definition: mismatched,
    })).toThrow(/competitors.*exactly match/i)
  })
})
