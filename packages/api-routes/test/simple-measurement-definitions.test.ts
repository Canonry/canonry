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
  it('requires exact stored competitor identifiers, not normalized approximations', () => {
    db.insert(competitors).values({
      id: 'peer', projectId: 'project-a', domain: ' Peer.example ', createdAt: capturedAt,
    }).run()
    const frozen = { ...definition(), competitors: [{ domain: 'peer.example', label: 'peer', aliases: [] }] }
    expect(() => captureSimpleMeasurementDefinition(db, {
      projectId: 'project-a', runId: 'run-a', definition: frozen,
    })).toThrow(/exactly match/i)
    expect(db.select().from(simpleMeasurementDefinitions).all()).toEqual([])
    frozen.competitors[0]!.domain = ' Peer.example '
    expect(captureSimpleMeasurementDefinition(db, {
      projectId: 'project-a', runId: 'run-a', definition: frozen,
    }).competitors).toEqual(frozen.competitors)
  })

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

function qualifiedDefinition(qualifiedAliases?: string[], aliases = ['Northstar Living', 'NSLNYC', 'NSL NYC']) {
  return buildSimpleMeasurementDefinition({
    capturedAt,
    identity: {
      displayName: 'Northstar', aliases,
      canonicalDomain: 'https://northstar.example/', ownedDomains: [],
      ...(qualifiedAliases === undefined ? {} : { qualifiedAliases }),
    },
    country: 'US', language: 'en', location: null,
    engines: [{ provider: 'gemini', requestedModel: 'fixture-model' }],
    queries: [{ queryId: 'query-a', queryText: 'Northstar reviews', provenance: 'manual' }],
  })
}

describe('simple measurement definition capture: qualified aliases', () => {
  const capture = (definition: ReturnType<typeof qualifiedDefinition>) =>
    captureSimpleMeasurementDefinition(db, { projectId: 'project-a', runId: 'run-a', definition })
  const storedRow = () => db.select().from(simpleMeasurementDefinitions).get()!

  it.each([
    ['added', undefined, ['NSLNYC']],
    ['changed', ['NSLNYC'], ['NSL NYC']],
    ['cleared', ['NSL NYC', 'NSLNYC'], []],
  ] as const)('replay keeps the first capture when the live list was %s', (_label, first, live) => {
    const frozen = qualifiedDefinition(first === undefined ? undefined : [...first])
    capture(frozen)
    const row = storedRow()

    const replayed = capture({ ...qualifiedDefinition([...live]), capturedAt: '2026-09-04T17:00:00.000Z' })

    expect(replayed).toEqual(frozen)
    expect(db.select().from(simpleMeasurementDefinitions).all()).toHaveLength(1)
    expect(storedRow()).toEqual(row)
  })

  it('replays a pre-feature sidecar after the project opts in and returns it with no key', () => {
    // A sidecar stored before the field existed, byte for byte.
    const legacy = qualifiedDefinition()
    expect(legacy.identity).not.toHaveProperty('qualifiedAliases')
    capture(legacy)

    const replayed = capture(qualifiedDefinition(['NSLNYC', 'NSL NYC']))

    expect(replayed).toEqual(legacy)
    expect(replayed!.identity).not.toHaveProperty('qualifiedAliases')
    expect(storedRow().definition.identity).not.toHaveProperty('qualifiedAliases')
  })

  it('still refuses a replay whose aliases changed', () => {
    capture(qualifiedDefinition(['NSLNYC']))
    expect(() => capture(qualifiedDefinition(['NSLNYC'], ['Northstar Living', 'NSLNYC'])))
      .toThrow(/already.*captured/i)
    expect(() => capture(qualifiedDefinition(undefined, ['Northstar Living', 'NSLNYC', 'NSL NYC', 'Northstar Homes'])))
      .toThrow(/already.*captured/i)
  })

  it('refuses a first capture whose list is not a sorted subset of the captured aliases', () => {
    const valid = qualifiedDefinition(['NSLNYC', 'NSL NYC'])
    expect(valid.identity.qualifiedAliases).toEqual(['NSL NYC', 'NSLNYC'])

    const unsorted = { ...valid, identity: { ...valid.identity, qualifiedAliases: ['NSLNYC', 'NSL NYC'] } }
    expect(() => capture(unsorted)).toThrow(/sorted subset/i)
    const notSubset = { ...valid, identity: { ...valid.identity, qualifiedAliases: ['Former Name'] } }
    expect(() => capture(notSubset)).toThrow(/sorted subset/i)
    const displayName = { ...valid, identity: { ...valid.identity, qualifiedAliases: ['Northstar'] } }
    expect(() => capture(displayName)).toThrow(/sorted subset/i)
    expect(db.select().from(simpleMeasurementDefinitions).all()).toEqual([])

    expect(capture(valid)).toEqual(valid)
    expect(storedRow().checksum).toBe(crypto.createHash('sha256')
      .update(canonicalSimpleMeasurementDefinitionJson(valid)).digest('hex'))
  })

  it('refuses a list naming a frozen competitor', () => {
    db.insert(competitors).values({ id: 'rival', projectId: 'project-a', domain: 'nslnyc.example', createdAt: capturedAt }).run()
    const built = buildSimpleMeasurementDefinition({
      capturedAt,
      identity: {
        displayName: 'Northstar', aliases: ['Northstar Living', 'NSLNYC', 'NSL NYC'],
        canonicalDomain: 'https://northstar.example/', ownedDomains: [], qualifiedAliases: ['NSLNYC'],
      },
      country: 'US', language: 'en', location: null,
      engines: [{ provider: 'gemini', requestedModel: 'fixture-model' }],
      competitors: [{ domain: 'nslnyc.example', label: 'nslnyc', aliases: ['nslnyc'] }],
      queries: [{ queryId: 'query-a', queryText: 'Northstar reviews', provenance: 'manual' }],
    })
    // The builder drops the colliding name rather than failing dispatch.
    expect(built.identity).not.toHaveProperty('qualifiedAliases')
    const forced = { ...built, identity: { ...built.identity, qualifiedAliases: ['NSLNYC'] } }
    expect(() => capture(forced)).toThrow(/sorted subset/i)
    expect(capture(built)).toEqual(built)
  })
})
