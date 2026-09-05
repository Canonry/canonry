import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeEach, expect, test } from 'vitest'
import {
  buildMeasurementRunManifestV1,
  buildSimpleMeasurementDefinition,
  RunKinds,
  RunStatuses,
  RunTriggers,
  type LocationContext,
  type ProviderAdapter,
  type ProviderConfig,
  type RawQueryResult,
  type TrackedQueryInput,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  competitors,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
  simpleMeasurementDefinitions,
  usageCounters,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { captureSimpleMeasurementDefinition } from '@ainyc/canonry-api-routes'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'
import { fakeAdapter, type RecordedCall } from './fake-measurement-provider.js'

const CAPTURED_LOCATION: LocationContext = {
  label: 'North Harbor',
  city: 'North Harbor',
  region: 'MA',
  country: 'US',
  timezone: 'America/New_York',
}

const EDITED_LOCATION: LocationContext = {
  label: 'South Harbor',
  city: 'South Harbor',
  region: 'RI',
  country: 'US',
}

interface Fixture {
  db: DatabaseClient
  projectId: string
  runId: string
  queryIds: {
    branded: string
    nonBrand: string
  }
}

function buildDb(): DatabaseClient {
  const db = createClient(':memory:')
  migrate(db)
  return db
}

function seedFixture(db: DatabaseClient, runFields: Partial<typeof runs.$inferInsert> = {}): Fixture {
  const now = '2026-09-04T16:00:00.000Z'
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const branded = crypto.randomUUID()
  const nonBrand = crypto.randomUUID()

  db.insert(projects).values({
    id: projectId,
    name: 'northstar',
    displayName: 'Northstar Living',
    aliases: ['Northstar', 'NS Living'],
    canonicalDomain: 'northstar.example',
    ownedDomains: ['northstar.co', 'homes.northstar.example'],
    country: 'US',
    language: 'en',
    providers: ['openai', 'gemini'],
    providerModels: { openai: 'gpt-project-actual' },
    locations: [CAPTURED_LOCATION],
    defaultLocation: CAPTURED_LOCATION.label,
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(queries).values([
    {
      id: branded,
      projectId,
      query: 'Northstar Living reviews',
      provenance: 'manual',
      createdAt: now,
    },
    {
      id: nonBrand,
      projectId,
      query: 'apartments near public transit',
      provenance: null,
      createdAt: now,
    },
  ]).run()
  db.insert(runs).values({
    id: runId,
    projectId,
    kind: RunKinds['answer-visibility'],
    trigger: RunTriggers.manual,
    status: RunStatuses.queued,
    createdAt: now,
    ...runFields,
  }).run()

  return { db, projectId, runId, queryIds: { branded, nonBrand } }
}

function registryFor(
  calls: RecordedCall[],
  beforeFakeAdapterCall?: () => void,
  modelOverrides: Partial<Record<string, string>> = {},
): ProviderRegistry {
  const registry = new ProviderRegistry()
  for (const [name, model] of [
    ['openai', 'gpt-registry-ignored'],
    ['gemini', 'gemini-registry-actual'],
  ] as const) {
    const adapter = fakeAdapter({ name, calls })
    const executeTrackedQuery = adapter.executeTrackedQuery.bind(adapter)
    adapter.executeTrackedQuery = async (
      input: TrackedQueryInput,
      config: ProviderConfig,
    ): Promise<RawQueryResult> => {
      beforeFakeAdapterCall?.()
      return executeTrackedQuery(input, config)
    }
    registry.register(adapter as ProviderAdapter, {
      provider: name,
      apiKey: 'test-key-must-not-be-captured',
      model: modelOverrides[name] ?? model,
      quotaPolicy: {
        maxConcurrency: 4,
        maxRequestsPerMinute: 600,
        maxRequestsPerDay: 100,
      },
    })
  }
  return registry
}

beforeEach(() => {
  resetSharedProviderExecutionGates()
})

test('freezes the resolved simple definition before any fake provider call and keeps it after live edits', async () => {
  const db = buildDb()
  try {
    const fixture = seedFixture(db)
    const calls: RecordedCall[] = []
    const definitionsAtProviderCall: unknown[] = []
    let changedLiveInputs = false

    await new JobRunner(db, registryFor(calls, () => {
      const definition = db.select()
        .from(simpleMeasurementDefinitions)
        .where(eq(simpleMeasurementDefinitions.runId, fixture.runId))
        .get()?.definition
      definitionsAtProviderCall.push(definition)

      if (changedLiveInputs) return
      changedLiveInputs = true
      db.update(projects).set({
        displayName: 'Southstar Living',
        aliases: ['Southstar'],
        canonicalDomain: 'southstar.example',
        ownedDomains: ['southstar.example'],
        country: 'CA',
        language: 'fr',
        providerModels: { openai: 'gpt-live-edit' },
        locations: [EDITED_LOCATION],
        defaultLocation: EDITED_LOCATION.label,
      }).where(eq(projects.id, fixture.projectId)).run()
      db.update(queries).set({
        query: 'live replacement query',
        provenance: 'import',
      }).where(eq(queries.id, fixture.queryIds.branded)).run()
    })).executeRun(fixture.runId, fixture.projectId)

    const row = db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, fixture.runId)).get()!
    const expected = {
      schemaVersion: 1,
      capturedAt: row.capturedAt,
      identity: {
        displayName: 'Northstar Living',
        aliases: ['Northstar', 'NS Living'],
        canonicalDomain: 'northstar.example',
        ownedDomains: ['northstar.co', 'homes.northstar.example'],
      },
      country: 'US',
      language: 'en',
      location: CAPTURED_LOCATION,
      engines: [
        { provider: 'openai', requestedModel: 'gpt-project-actual' },
        { provider: 'gemini', requestedModel: 'gemini-registry-actual' },
      ],
      competitors: [],
      queries: [
        {
          queryId: fixture.queryIds.branded,
          queryText: 'Northstar Living reviews',
          provenance: 'manual',
          queryClass: 'branded',
        },
        {
          queryId: fixture.queryIds.nonBrand,
          queryText: 'apartments near public transit',
          provenance: null,
          queryClass: 'non-brand',
        },
      ],
    }

    expect(row.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(row.definition).toEqual(expected)
    expect(definitionsAtProviderCall).toHaveLength(4)
    expect(definitionsAtProviderCall).toEqual([expected, expected, expected, expected])
    expect(JSON.stringify(row.definition)).not.toContain('test-key-must-not-be-captured')
    expect(calls.map(call => ({ provider: call.provider, query: call.query, location: call.location, model: call.model })).sort((left, right) => left.provider.localeCompare(right.provider))).toEqual([
      {
        provider: 'gemini',
        query: 'Northstar Living reviews',
        location: CAPTURED_LOCATION,
        model: 'gemini-registry-actual',
      },
      {
        provider: 'gemini',
        query: 'apartments near public transit',
        location: CAPTURED_LOCATION,
        model: 'gemini-registry-actual',
      },
      {
        provider: 'openai',
        query: 'Northstar Living reviews',
        location: CAPTURED_LOCATION,
        model: 'gpt-project-actual',
      },
      {
        provider: 'openai',
        query: 'apartments near public transit',
        location: CAPTURED_LOCATION,
        model: 'gpt-project-actual',
      },
    ])
  } finally {
    db.$client.close()
  }
})

test('freezes the direct competitor identities dispatched with a new simple run', async () => {
  const db = buildDb()
  try {
    const fixture = seedFixture(db)
    db.insert(competitors).values({
      id: crypto.randomUUID(),
      projectId: fixture.projectId,
      domain: 'challenger.example',
      createdAt: '2026-09-04T16:00:00.000Z',
    }).run()

    await new JobRunner(db, registryFor([])).executeRun(fixture.runId, fixture.projectId)

    expect(db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, fixture.runId)).get()!.definition.competitors).toEqual([
      { domain: 'challenger.example', label: 'challenger', aliases: ['challenger'] },
    ])
  } finally {
    db.$client.close()
  }
})

test('freezes the provider override and explicit no-location context actually dispatched', async () => {
  const db = buildDb()
  try {
    const fixture = seedFixture(db)
    db.update(projects).set({
      providerModels: {
        openai: 'gpt-project-actual',
        gemini: 'gemini-project-override',
      },
    }).where(eq(projects.id, fixture.projectId)).run()
    const calls: RecordedCall[] = []

    await new JobRunner(db, registryFor(calls)).executeRun(
      fixture.runId,
      fixture.projectId,
      ['gemini'],
      null,
    )

    const definition = db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, fixture.runId)).get()!.definition
    expect(definition).toMatchObject({
      location: null,
      engines: [{ provider: 'gemini', requestedModel: 'gemini-project-override' }],
    })
    expect(calls).toHaveLength(2)
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'gemini',
        location: null,
        model: 'gemini-project-override',
      }),
    ]))
    expect(calls.every(call => call.provider === 'gemini' && call.location === null)).toBe(true)
  } finally {
    db.$client.close()
  }
})

test('captures and dispatches only the stored run query basket', async () => {
  const db = buildDb()
  try {
    const fixture = seedFixture(db, { queries: ['apartments near public transit'] })
    const calls: RecordedCall[] = []

    await new JobRunner(db, registryFor(calls)).executeRun(fixture.runId, fixture.projectId)

    const definition = db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, fixture.runId)).get()!.definition
    expect(definition.queries).toEqual([{
      queryId: fixture.queryIds.nonBrand,
      queryText: 'apartments near public transit',
      provenance: null,
      queryClass: 'non-brand',
    }])
    expect(calls.map(call => ({ provider: call.provider, query: call.query }))
      .sort((left, right) => left.provider.localeCompare(right.provider))).toEqual([
      { provider: 'gemini', query: 'apartments near public transit' },
      { provider: 'openai', query: 'apartments near public transit' },
    ])
  } finally {
    db.$client.close()
  }
})

test('captures an existing empty query without blocking its fake provider calls', async () => {
  const db = buildDb()
  try {
    const fixture = seedFixture(db)
    db.update(queries).set({ query: '' })
      .where(eq(queries.id, fixture.queryIds.branded)).run()
    const calls: RecordedCall[] = []

    await new JobRunner(db, registryFor(calls)).executeRun(fixture.runId, fixture.projectId)

    const definition = db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, fixture.runId)).get()!.definition
    expect(definition.queries.find(query => query.queryId === fixture.queryIds.branded)).toMatchObject({
      queryText: '',
    })
    expect(calls.map(call => ({ provider: call.provider, query: call.query }))
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.query.localeCompare(right.query))).toEqual([
      { provider: 'gemini', query: '' },
      { provider: 'gemini', query: 'apartments near public transit' },
      { provider: 'openai', query: '' },
      { provider: 'openai', query: 'apartments near public transit' },
    ])
  } finally {
    db.$client.close()
  }
})

test('captures and dispatches a blank configured provider model exactly', async () => {
  const db = buildDb()
  try {
    const fixture = seedFixture(db)
    const calls: RecordedCall[] = []

    await new JobRunner(db, registryFor(calls, undefined, { gemini: '' })).executeRun(
      fixture.runId,
      fixture.projectId,
      ['gemini'],
    )

    const definition = db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, fixture.runId)).get()!.definition
    expect(definition.engines).toEqual([{ provider: 'gemini', requestedModel: '' }])
    expect(calls.map(call => ({ provider: call.provider, model: call.model }))).toEqual([
      { provider: 'gemini', model: '' },
      { provider: 'gemini', model: '' },
    ])
  } finally {
    db.$client.close()
  }
})

test('refuses a simple capture for a run from another project before fake provider dispatch', async () => {
  const db = buildDb()
  try {
    const fixture = seedFixture(db)
    const wrongProjectId = crypto.randomUUID()
    const now = '2026-09-04T16:00:00.000Z'
    db.insert(projects).values({
      id: wrongProjectId,
      name: 'other-project',
      displayName: 'Other Project',
      canonicalDomain: 'other.example',
      country: 'US',
      language: 'en',
      providers: ['openai'],
      createdAt: now,
      updatedAt: now,
    }).run()
    db.insert(queries).values({
      id: crypto.randomUUID(),
      projectId: wrongProjectId,
      query: 'the query that must not dispatch',
      createdAt: now,
    }).run()
    const calls: RecordedCall[] = []

    await new JobRunner(db, registryFor(calls)).executeRun(fixture.runId, wrongProjectId)

    expect(calls).toEqual([])
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.runId, fixture.runId)).all()).toEqual([])
    expect(db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, fixture.runId)).all()).toEqual([])
    expect(db.select().from(runs).where(eq(runs.id, fixture.runId)).get()).toMatchObject({
      status: RunStatuses.failed,
      error: expect.stringMatching(/not found/i),
    })
  } finally {
    db.$client.close()
  }
})

test('does not capture a simple definition for probe, advanced, or non-visibility runs', async () => {
  for (const variant of ['probe', 'advanced', 'non-visibility'] as const) {
    const db = buildDb()
    try {
      const fixture = seedFixture(db)
      if (variant === 'probe') {
        db.update(runs).set({ trigger: RunTriggers.probe }).where(eq(runs.id, fixture.runId)).run()
      } else if (variant === 'advanced') {
        const versionId = crypto.randomUUID()
        db.insert(measurementPlanVersions).values({
          id: versionId,
          projectId: fixture.projectId,
          revision: 1,
          canonicalJson: '{}',
          checksum: 'test-checksum',
          createdAt: '2026-09-04T16:00:00.000Z',
        }).run()
        db.update(runs).set({
          measurementPlanVersionId: versionId,
          measurementManifest: buildMeasurementRunManifestV1({
            expectedSlots: [{
              executionId: 'advanced-node',
              queryText: 'Northstar Living reviews',
              provider: 'openai',
              context: CAPTURED_LOCATION,
            }],
          }),
        }).where(eq(runs.id, fixture.runId)).run()
      } else {
        db.update(runs).set({ kind: RunKinds['gsc-sync'] }).where(eq(runs.id, fixture.runId)).run()
      }

      const calls: RecordedCall[] = []
      await new JobRunner(db, registryFor(calls)).executeRun(fixture.runId, fixture.projectId)

      expect(calls.length).toBeGreaterThan(0)
      expect(db.select().from(simpleMeasurementDefinitions)
        .where(eq(simpleMeasurementDefinitions.runId, fixture.runId)).all()).toEqual([])
    } finally {
      db.$client.close()
    }
  }
})

test('a repeated dispatch preserves an existing definition despite a later capture time', async () => {
  const db = buildDb()
  try {
    const fixture = seedFixture(db)
    const capturedAt = '2026-01-01T00:00:00.000Z'
    db.update(runs).set({ status: RunStatuses.running }).where(eq(runs.id, fixture.runId)).run()
    captureSimpleMeasurementDefinition(db, {
      projectId: fixture.projectId,
      runId: fixture.runId,
      definition: buildSimpleMeasurementDefinition({
        capturedAt,
        identity: {
          displayName: 'Northstar Living',
          aliases: ['Northstar', 'NS Living'],
          canonicalDomain: 'northstar.example',
          ownedDomains: ['northstar.co', 'homes.northstar.example'],
        },
        country: 'US',
        language: 'en',
        location: CAPTURED_LOCATION,
        engines: [
          { provider: 'openai', requestedModel: 'gpt-project-actual' },
          { provider: 'gemini', requestedModel: 'gemini-registry-actual' },
        ],
        competitors: [],
        queries: [
          {
            queryId: fixture.queryIds.branded,
            queryText: 'Northstar Living reviews',
            provenance: 'manual',
          },
          {
            queryId: fixture.queryIds.nonBrand,
            queryText: 'apartments near public transit',
            provenance: null,
          },
        ],
      }),
    })

    const calls: RecordedCall[] = []
    await new JobRunner(db, registryFor(calls)).executeRun(fixture.runId, fixture.projectId)

    expect(calls).toHaveLength(4)
    expect(db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, fixture.runId)).get()).toMatchObject({ capturedAt })
  } finally {
    db.$client.close()
  }
})

test('a retry preserves an old sidecar with omitted competitors instead of claiming an empty frozen set', async () => {
  const db = buildDb()
  try {
    const fixture = seedFixture(db)
    const capturedAt = '2026-01-01T00:00:00.000Z'
    db.update(runs).set({ status: RunStatuses.running }).where(eq(runs.id, fixture.runId)).run()
    const historical = buildSimpleMeasurementDefinition({
      capturedAt,
      identity: {
        displayName: 'Northstar Living',
        aliases: ['Northstar', 'NS Living'],
        canonicalDomain: 'northstar.example',
        ownedDomains: ['northstar.co', 'homes.northstar.example'],
      },
      country: 'US',
      language: 'en',
      location: CAPTURED_LOCATION,
      engines: [
        { provider: 'openai', requestedModel: 'gpt-project-actual' },
        { provider: 'gemini', requestedModel: 'gemini-registry-actual' },
      ],
      // This is a pre-competitor-capture sidecar, not an intentionally empty
      // frozen competitor list.
      queries: [
        { queryId: fixture.queryIds.branded, queryText: 'Northstar Living reviews', provenance: 'manual' },
        { queryId: fixture.queryIds.nonBrand, queryText: 'apartments near public transit', provenance: null },
      ],
    })
    captureSimpleMeasurementDefinition(db, { projectId: fixture.projectId, runId: fixture.runId, definition: historical })
    const before = db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, fixture.runId)).get()!

    const calls: RecordedCall[] = []
    await new JobRunner(db, registryFor(calls)).executeRun(fixture.runId, fixture.projectId)

    const after = db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, fixture.runId)).get()!
    expect(calls).toHaveLength(4)
    expect(after.checksum).toBe(before.checksum)
    expect(after.definition.competitors).toBeUndefined()
  } finally {
    db.$client.close()
  }
})

test('a simple-definition persistence error stops all fake provider calls', async () => {
  const db = buildDb()
  try {
    const fixture = seedFixture(db)
    db.$client.exec(`
      CREATE TRIGGER reject_test_simple_measurement_definition
      BEFORE INSERT ON simple_measurement_definitions
      BEGIN
        SELECT RAISE(ABORT, 'test simple measurement definition persistence failure');
      END
    `)
    const calls: RecordedCall[] = []

    await new JobRunner(db, registryFor(calls)).executeRun(fixture.runId, fixture.projectId)

    expect(calls).toEqual([])
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.runId, fixture.runId)).all()).toEqual([])
    expect(db.select().from(simpleMeasurementDefinitions)
      .where(eq(simpleMeasurementDefinitions.runId, fixture.runId)).all()).toEqual([])
    expect(db.select({ scope: usageCounters.scope, count: usageCounters.count })
      .from(usageCounters)
      .where(eq(usageCounters.metric, 'queries'))
      .all()
      .sort((left, right) => left.scope.localeCompare(right.scope))).toEqual([
      { scope: `${fixture.projectId}:gemini`, count: 0 },
      { scope: `${fixture.projectId}:openai`, count: 0 },
    ])
    expect(db.select().from(runs).where(eq(runs.id, fixture.runId)).get()).toMatchObject({
      status: RunStatuses.failed,
      error: expect.stringMatching(/persistence failure/i),
    })
  } finally {
    db.$client.close()
  }
})
