import { describe, expect, onTestFinished, test } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  buildMeasurementRunManifestV1,
  canonicalMeasurementPlanJson,
  compileMeasurementPlan,
  parseRunError,
  resolveMeasurementRunScope,
  type LocationContext,
  type MeasurementPlan,
  type MeasurementRunManifestV1,
  type MeasurementRunScopeRequest,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
} from '@ainyc/canonry-db'
import { buildMeasurementRunManifest, buildStoredMeasurementReport, measurementRunSlotState } from '@ainyc/canonry-api-routes'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { fakeAdapter, type RecordedCall } from './fake-measurement-provider.js'

const NORTH: LocationContext = { label: 'north-city', city: 'North City', region: 'NC', country: 'US' }
const SOUTH: LocationContext = { label: 'south-city', city: 'South City', region: 'SC', country: 'US' }

interface Env {
  db: ReturnType<typeof createClient>
  projectId: string
  runId: string
  queryId: string
  plan: MeasurementPlan
  manifest: MeasurementRunManifestV1
}

/**
 * One tracked question, selected by two targets that sit in different
 * locations. The compiler turns that into two execution nodes with the same
 * text and different contexts — the case a query-shaped runner cannot see.
 */
function buildEnv(options: {
  providers: string[]
  scope?: MeasurementRunScopeRequest | null
  providerModels?: Record<string, string>
} = { providers: ['openai'] }): Env {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-plan-run-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const now = '2026-08-01T00:00:00.000Z'
  const projectId = crypto.randomUUID()
  const queryId = crypto.randomUUID()
  const versionId = crypto.randomUUID()
  const runId = crypto.randomUUID()

  db.insert(projects).values({
    id: projectId,
    name: 'planned',
    displayName: 'Planned Co',
    canonicalDomain: 'example.com',
    aliases: ['Planned Co'],
    country: 'US',
    language: 'en',
    providers: options.providers,
    ...(options.providerModels ? { providerModels: options.providerModels } : {}),
    locations: [NORTH, SOUTH],
    defaultLocation: NORTH.label,
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(queries).values({ id: queryId, projectId, query: 'widget pricing', createdAt: now }).run()

  const plan = compileMeasurementPlan({
    schemaVersion: 1,
    targets: [
      { stableKey: 'north-branch', label: 'North branch', urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/north', pathCase: 'insensitive' }], aliases: ['North branch'] },
      { stableKey: 'south-branch', label: 'South branch', urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/south', pathCase: 'insensitive' }], aliases: ['South branch'] },
    ],
    groups: [{ stableKey: 'metro-group', label: 'Metro group', targetKeys: ['south-branch'] }],
    targetQuerySelections: [
      { targetKey: 'north-branch', queryIds: [queryId] },
      { targetKey: 'south-branch', queryIds: [queryId], context: SOUTH },
    ],
  }, {
    canonicalDomain: 'example.com',
    ownedDomains: [],
    brandNames: ['Planned Co'],
    defaultContext: NORTH,
    locations: [NORTH, SOUTH],
    trackedQueries: [{ id: queryId, query: 'widget pricing' }],
    expectedSnapshots: options.providers.length,
  })

  const canonicalJson = canonicalMeasurementPlanJson(plan)
  const checksum = crypto.createHash('sha256').update(canonicalJson).digest('hex')
  db.insert(measurementPlanVersions).values({
    id: versionId, projectId, revision: 1, canonicalJson, checksum, createdAt: now,
  }).run()
  db.insert(measurementPlans).values({
    projectId, activeVersionId: versionId, createdAt: now, updatedAt: now,
  }).run()

  const resolution = options.scope ? resolveMeasurementRunScope(plan, options.scope) : null
  const manifest = resolution
    ? buildMeasurementRunManifestV1({
        expectedSlots: resolution.executionNodes.flatMap(node => options.providers.map(provider => ({
          executionId: node.stableKey,
          queryText: node.queryText,
          provider,
          context: node.context,
          ...(options.providerModels?.[provider] ? { requestedModel: options.providerModels[provider]! } : {}),
        }))),
      })
    : buildMeasurementRunManifestV1({
        expectedSlots: buildMeasurementRunManifest(plan, options.providers).expectedSlots.map(slot => ({
          ...slot,
          ...(options.providerModels?.[slot.provider] ? { requestedModel: options.providerModels[slot.provider]! } : {}),
        })),
      })

  db.insert(runs).values({
    id: runId,
    projectId,
    status: 'queued',
    // A spot check is recorded as a probe, exactly as the queue records it.
    trigger: resolution ? 'probe' : 'manual',
    measurementPlanVersionId: versionId,
    measurementManifest: manifest,
    measurementScope: resolution?.scope ?? null,
    createdAt: now,
  }).run()

  return { db, projectId, runId, queryId, plan, manifest }
}

function registryFor(calls: RecordedCall[], providers: Array<{ name: string; supportsLocationContext?: boolean; failFromCall?: number; maxRequestsPerDay?: number }>) {
  const registry = new ProviderRegistry()
  for (const provider of providers) {
    registry.register(fakeAdapter({ ...provider, calls }), {
      provider: provider.name,
      apiKey: 'test-key',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 60, maxRequestsPerDay: provider.maxRequestsPerDay ?? 1000 },
    })
  }
  return registry
}

function snapshotsFor(env: Env) {
  return env.db.select().from(querySnapshots).where(eq(querySnapshots.runId, env.runId)).all()
}

function report(env: Env) {
  const stored = buildStoredMeasurementReport(env.db, env.projectId, 1)
  if (stored.kind !== 'report') throw new Error(`expected a report, got ${stored.kind}`)
  return stored.report
}

describe('plan-aware execution', () => {
  test('runs the same question once per context, with the context on the call', async () => {
    const env = buildEnv()
    const calls: RecordedCall[] = []

    await new JobRunner(env.db, registryFor(calls, [{ name: 'openai' }])).executeRun(env.runId, env.projectId)

    expect(new Set(env.manifest.expectedSlots.map(slot => slot.executionId)).size).toBe(2)
    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.query === 'widget pricing')).toBe(true)
    expect(calls.map(call => call.location?.label).sort()).toEqual(['north-city', 'south-city'])
  })

  test('writes one snapshot per execution node, carrying the node id and both contexts', async () => {
    const env = buildEnv()
    const calls: RecordedCall[] = []

    await new JobRunner(env.db, registryFor(calls, [{ name: 'openai' }])).executeRun(env.runId, env.projectId)

    const rows = snapshotsFor(env).sort((left, right) => (left.location ?? '').localeCompare(right.location ?? ''))
    expect(rows).toHaveLength(2)

    const nodeByContext = new Map(env.plan.executionNodes.map(node => [node.context?.label ?? null, node.stableKey]))
    expect(rows.map(row => row.measurementExecutionId)).toEqual([
      nodeByContext.get('north-city'),
      nodeByContext.get('south-city'),
    ])
    expect(new Set(rows.map(row => row.measurementExecutionId)).size).toBe(2)

    expect(rows.map(row => row.requestedContext)).toEqual([NORTH, SOUTH])
    expect(rows.map(row => row.location)).toEqual(['north-city', 'south-city'])
    expect(rows.map(row => row.queryText)).toEqual(['widget pricing', 'widget pricing'])
    expect(rows.map(row => row.queryId)).toEqual([env.queryId, env.queryId])

    // The provider threads structured location, so the requested context is
    // also the supported one.
    expect(rows.map(row => row.supportedContext)).toEqual([
      { status: 'applied', resolved: NORTH },
      { status: 'applied', resolved: SOUTH },
    ])

    expect(env.db.select().from(runs).where(eq(runs.id, env.runId)).get()!.status).toBe('completed')
  })

  test('the stored rows satisfy the report reader without repair', async () => {
    const env = buildEnv()
    const calls: RecordedCall[] = []

    await new JobRunner(env.db, registryFor(calls, [{ name: 'openai' }])).executeRun(env.runId, env.projectId)

    const stored = report(env)
    expect(stored.run?.id).toBe(env.runId)
    expect(stored.diagnostics.unmatchedObservationIds).toEqual([])
    expect(stored.diagnostics.ambiguousObservationIds).toEqual([])
    expect(stored.diagnostics.bridgedObservationIds).toEqual([])
    for (const target of stored.targets) {
      expect(target.completeness).toMatchObject({ executed: 1, expected: 1, complete: true })
    }
  })

  test('a scoped run measures only the nodes in scope', async () => {
    const env = buildEnv({ providers: ['openai'], scope: { groups: ['metro-group'] } })
    const calls: RecordedCall[] = []

    await new JobRunner(env.db, registryFor(calls, [{ name: 'openai' }])).executeRun(env.runId, env.projectId)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.location?.label).toBe('south-city')
    expect(snapshotsFor(env)).toHaveLength(1)
  })
})

describe('honest geo capability', () => {
  test('a provider that does not thread location claims none, but the request is still recorded', async () => {
    const env = buildEnv({ providers: ['openai', 'cdp:chatgpt'] })
    const calls: RecordedCall[] = []
    const registry = registryFor(calls, [
      { name: 'openai', supportsLocationContext: true },
      { name: 'cdp:chatgpt', supportsLocationContext: false },
    ])

    await new JobRunner(env.db, registry).executeRun(env.runId, env.projectId)

    const rows = snapshotsFor(env)
    expect(rows).toHaveLength(4)

    const blind = rows.filter(row => row.provider === 'cdp:chatgpt')
    expect(blind).toHaveLength(2)
    for (const row of blind) {
      expect(row.supportedContext).toBeNull()
      expect(row.requestedContext).not.toBeNull()
      // The row must not claim a geography the provider never honoured: only
      // `requestedContext` records what was asked for. `location` — the
      // field every other reader (analytics, exports) treats as "where this
      // was measured from" — stays null rather than echoing the request.
      expect(row.location).toBeNull()
    }

    const threaded = rows.filter(row => row.provider === 'openai')
    for (const row of threaded) {
      expect(row.supportedContext).toEqual({ status: 'applied', resolved: row.requestedContext })
      // A provider that actually honoured the request may say so on `location`.
      expect(row.location).toBe(row.requestedContext?.label)
    }
  })
})

describe('completeness surface', () => {
  test('a partial full sweep reports executed below expected and refuses a rate', async () => {
    const env = buildEnv({ providers: ['openai', 'gemini'] })
    const calls: RecordedCall[] = []
    const registry = registryFor(calls, [{ name: 'openai' }, { name: 'gemini', failFromCall: 1 }])

    await new JobRunner(env.db, registry).executeRun(env.runId, env.projectId)

    expect(env.manifest.expectedSlots).toHaveLength(4)

    const group = report(env).groups.find(row => row.id === 'metro-group')!
    expect(group.completeness).toMatchObject({ executed: 1, expected: 2, complete: false })
    expect(group.answerCoverage.rate).toBeNull()
    expect(group.answerCoverage.reason).toBe('incomplete')
  })

  test('a scoped run is complete against its own manifest and never becomes the report', async () => {
    const env = buildEnv({ providers: ['openai'], scope: { groups: ['metro-group'] } })
    const calls: RecordedCall[] = []

    await new JobRunner(env.db, registryFor(calls, [{ name: 'openai' }])).executeRun(env.runId, env.projectId)

    // Executed equals what this run was asked for: one slot, one row.
    expect(env.manifest.expectedSlots).toHaveLength(1)
    expect(snapshotsFor(env)).toHaveLength(1)

    // And it stays out of the plan's report, which describes the whole plan.
    // Being a probe is what keeps a spot check from standing in for a sweep.
    expect(env.db.select().from(runs).where(eq(runs.id, env.runId)).get()!.trigger).toBe('probe')
    expect(buildStoredMeasurementReport(env.db, env.projectId, 1).kind).toBe('no-population')
  })
})

describe('expected slots that never ran', () => {
  test('a manifest provider the registry cannot serve leaves the run partial', async () => {
    const env = buildEnv({ providers: ['openai', 'gemini'] })
    const calls: RecordedCall[] = []

    // The manifest expects gemini; only openai is registered at execution.
    await new JobRunner(env.db, registryFor(calls, [{ name: 'openai' }])).executeRun(env.runId, env.projectId)

    expect(env.manifest.expectedSlots).toHaveLength(4)
    expect(snapshotsFor(env)).toHaveLength(2)

    const run = env.db.select().from(runs).where(eq(runs.id, env.runId)).get()!
    expect(run.status).toBe('partial')
    expect(run.error).toContain('gemini')
  })

  test('a provider the run skipped leaves its slots missing and says why, not that no provider was available', async () => {
    const env = buildEnv({ providers: ['openai', 'gemini'] })
    const streak = { code: 'PROVIDER_AUTH' as const, consecutiveRuns: 10, since: '2026-07-30T00:00:00.000Z', latestRunId: 'run-9', retryAfter: '2026-08-02T00:00:00.000Z' }
    env.db.update(runs).set({ skippedProviders: { gemini: streak } }).where(eq(runs.id, env.runId)).run()
    const calls: RecordedCall[] = []

    await new JobRunner(env.db, registryFor(calls, [{ name: 'openai' }, { name: 'gemini' }])).executeRun(env.runId, env.projectId)

    expect(calls.map(call => call.provider)).toEqual(['openai', 'openai'])
    expect(snapshotsFor(env).map(row => row.provider)).toEqual(['openai', 'openai'])
    const run = env.db.select().from(runs).where(eq(runs.id, env.runId)).get()!
    expect(run.status).toBe('partial')
    expect(parseRunError(run.error)?.providers).toEqual({
      gemini: expect.objectContaining({ code: 'PROVIDER_AUTH', skipped: true, message: expect.stringMatching(/^Not called: gemini failed on its account/) }),
    })
    // The plan's report still expects gemini's answers: two slots read as missing.
    expect(measurementRunSlotState(env.db, env.runId).missing.map(slot => slot.provider)).toEqual(['gemini', 'gemini'])
  })

  test('a run where no expected slot could run at all is failed, not completed', async () => {
    const env = buildEnv({ providers: ['gemini'] })
    const calls: RecordedCall[] = []

    await new JobRunner(env.db, registryFor(calls, [{ name: 'openai' }])).executeRun(env.runId, env.projectId)

    expect(snapshotsFor(env)).toHaveLength(0)
    expect(env.db.select().from(runs).where(eq(runs.id, env.runId)).get()!.status).toBe('failed')
  })

  test('a complete plan run is still completed', async () => {
    const env = buildEnv({ providers: ['openai'] })
    const calls: RecordedCall[] = []

    await new JobRunner(env.db, registryFor(calls, [{ name: 'openai' }])).executeRun(env.runId, env.projectId)

    expect(snapshotsFor(env)).toHaveLength(env.manifest.expectedSlots.length)
    expect(env.db.select().from(runs).where(eq(runs.id, env.runId)).get()!.status).toBe('completed')
  })
})

describe('frozen model', () => {
  test('executes the model the manifest froze, not whatever the project points at now', async () => {
    const env = buildEnv({ providers: ['openai'], providerModels: { openai: 'pinned-model' } })
    const calls: RecordedCall[] = []

    // The project is re-pointed after the run was queued.
    env.db.update(projects).set({ providerModels: { openai: 'moved-model' } }).run()

    await new JobRunner(env.db, registryFor(calls, [{ name: 'openai' }])).executeRun(env.runId, env.projectId)

    expect(env.manifest.expectedSlots.every(slot => slot.requestedModel === 'pinned-model')).toBe(true)
    expect(calls.map(call => call.model)).toEqual(['pinned-model', 'pinned-model'])
    expect(snapshotsFor(env).map(row => row.model)).toEqual(['pinned-model', 'pinned-model'])

    // And the report reader accepts the provenance it finds.
    expect(report(env).diagnostics.unmatchedObservationIds).toEqual([])
  })
})

describe('frozen provider roster', () => {
  test('a provider added to the project after queueing is not admitted into the run, even if its quota is exhausted', async () => {
    // Queued against a manifest that only ever asked for openai.
    const env = buildEnv({ providers: ['openai'] })

    // The project is given a second provider after the run was queued. If the
    // roster were read live, gemini would be pulled into quota admission —
    // and here it has zero daily quota left, so admitting it at all would
    // fail the whole run even though the manifest never asked for it.
    env.db.update(projects).set({ providers: ['openai', 'gemini'] }).run()

    const calls: RecordedCall[] = []
    const registry = registryFor(calls, [
      { name: 'openai' },
      { name: 'gemini', maxRequestsPerDay: 0 },
    ])

    await new JobRunner(env.db, registry).executeRun(env.runId, env.projectId)

    // Only the manifest's own provider was ever called.
    expect(calls.every(call => call.provider === 'openai')).toBe(true)
    expect(snapshotsFor(env).every(row => row.provider === 'openai')).toBe(true)

    // The run completed — gemini's exhausted quota never entered the picture.
    const run = env.db.select().from(runs).where(eq(runs.id, env.runId)).get()!
    expect(run.status).toBe('completed')
  })

  test('a provider removed from the project after queueing still runs its frozen manifest slots', async () => {
    // Queued against a manifest that asked for both openai and gemini.
    const env = buildEnv({ providers: ['openai', 'gemini'] })
    expect(new Set(env.manifest.expectedSlots.map(slot => slot.provider))).toEqual(new Set(['openai', 'gemini']))

    // gemini is dropped from the project's live config after queueing — but
    // it is still registered and available to this worker.
    env.db.update(projects).set({ providers: ['openai'] }).run()

    const calls: RecordedCall[] = []
    const registry = registryFor(calls, [{ name: 'openai' }, { name: 'gemini' }])

    await new JobRunner(env.db, registry).executeRun(env.runId, env.projectId)

    // The manifest's gemini slots ran anyway: the roster came from the frozen
    // manifest, not from the project row that changed underneath the run.
    expect(new Set(calls.map(call => call.provider))).toEqual(new Set(['openai', 'gemini']))
    expect(snapshotsFor(env)).toHaveLength(env.manifest.expectedSlots.length)

    const run = env.db.select().from(runs).where(eq(runs.id, env.runId)).get()!
    expect(run.status).toBe('completed')
  })
})

describe('partial plan runs', () => {
  test('stores only the slots that completed and reports the run as partial', async () => {
    const env = buildEnv({ providers: ['openai', 'gemini'] })
    const calls: RecordedCall[] = []
    const registry = registryFor(calls, [
      { name: 'openai' },
      { name: 'gemini', failFromCall: 1 },
    ])

    await new JobRunner(env.db, registry).executeRun(env.runId, env.projectId)

    const expected = env.manifest.expectedSlots
    expect(expected).toHaveLength(4)

    const rows = snapshotsFor(env)
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.provider === 'openai')).toBe(true)
    expect(rows.length).toBeLessThan(expected.length)

    // Every stored row lines up with a slot that was expected — a failed call
    // leaves nothing behind rather than a row with no answer in it.
    const slotIds = new Set(expected.map(slot => `${slot.provider} ${slot.executionId}`))
    for (const row of rows) {
      expect(slotIds.has(`${row.provider} ${row.measurementExecutionId}`)).toBe(true)
    }

    const run = env.db.select().from(runs).where(eq(runs.id, env.runId)).get()!
    expect(run.status).toBe('partial')
    expect(run.error).toContain('gemini')
  })
})
