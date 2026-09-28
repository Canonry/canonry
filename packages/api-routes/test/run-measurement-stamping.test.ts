import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseMeasurementRunManifestV1,
  type MeasurementGroup,
  type MeasurementTarget,
  type MeasurementTargetQuerySelection,
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  createClient,
  measurementPlanVersions,
  projects,
  migrate,
  queries,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes, buildOpenApiDocument } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

const ROOT_KEY = 'cnry_runner_root'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let tracked: Array<{ id: string; query: string }>

type TestPlan = {
  schemaVersion: 1
  targets: MeasurementTarget[]
  groups: MeasurementGroup[]
  targetQuerySelections: MeasurementTargetQuerySelection[]
}

function seedKey(name: string, token: string, scopes: string[]) {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name,
    keyHash: hashApiKey(token),
    keyPrefix: token.slice(0, 9),
    scopes,
    createdAt: new Date().toISOString(),
  }).run()
}

function request(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${ROOT_KEY}` },
    ...(payload === undefined ? {} : { payload }),
  })
}

function plan(overrides: Partial<TestPlan> = {}): TestPlan {
  return {
    schemaVersion: 1,
    targets: [
      {
        stableKey: 'north-branch',
        label: 'North branch',
        urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/north', pathCase: 'insensitive' }],
        aliases: ['North branch'],
      },
      {
        stableKey: 'south-branch',
        label: 'South branch',
        urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/south', pathCase: 'insensitive' }],
        aliases: ['South branch'],
      },
    ],
    groups: [{
      stableKey: 'metro-group',
      label: 'Metro group',
      targetKeys: ['north-branch'],
      competitors: ['rival.example'],
    }],
    targetQuerySelections: [
      { targetKey: 'north-branch', queryIds: [tracked[0]!.id] },
      { targetKey: 'south-branch', queryIds: [tracked[1]!.id], context: { label: 'south-city', city: 'South City', region: 'SC', country: 'US' } },
    ],
    ...overrides,
  }
}

async function seedProject(name: string) {
  const created = await request('PUT', `/api/v1/projects/${name}`, {
    displayName: name,
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: ['openai', 'gemini'],
    locations: [
      { label: 'north-city', city: 'North City', region: 'NC', country: 'US' },
      { label: 'south-city', city: 'South City', region: 'SC', country: 'US' },
    ],
    defaultLocation: 'north-city',
  })
  expect(created.statusCode).toBe(201)
  await request('POST', `/api/v1/projects/${name}/queries`, {
    queries: ['widget pricing', 'widget repair', 'best widget shops'],
  })
}

function runRow(runId: string) {
  return db.select().from(runs).where(eq(runs.id, runId)).get()!
}

/** Publishing is a compare-and-swap over the active revision. */
function publish(overrides: Partial<TestPlan> = {}, expectedActiveRevision: number | null = null) {
  return request('PUT', '/api/v1/projects/planned/measurement-plan', {
    expectedActiveRevision,
    plan: plan(overrides),
  })
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-runner-stamp-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  seedKey('root', ROOT_KEY, ['*'])
  app = Fastify()
  // A real server tells the routes which providers it can actually run; an
  // empty project provider list means "all of these".
  app.register(apiRoutes, {
    db,
    getRunnableProviderNames: () => ['openai', 'gemini', 'claude', 'perplexity'],
    getEffectiveProviderModels: () => ({
      openai: 'openai-default',
      gemini: 'gemini-default',
      claude: 'claude-default',
      perplexity: 'perplexity-default',
    }),
  })
  await app.ready()

  await seedProject('planned')
  tracked = db.select({ id: queries.id, query: queries.query }).from(queries).all()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('measurement plan stamping at queue time', () => {
  it('stamps the active plan revision and its compiled manifest on a queued run', async () => {
    const published = await publish()
    expect(published.statusCode).toBe(201)
    const version = db.select().from(measurementPlanVersions).get()!

    const triggered = await request('POST', '/api/v1/projects/planned/runs')
    expect(triggered.statusCode).toBe(201)
    const runId = (triggered.json() as { id: string }).id

    const row = runRow(runId)
    expect(row.measurementPlanVersionId).toBe(version.id)
    expect(row.measurementScope).toBeNull()

    // A full sweep expects every frozen execution node, once per provider.
    const manifest = parseMeasurementRunManifestV1(row.measurementManifest)
    const plannedPlan = JSON.parse(version.canonicalJson) as {
      executionNodes: Array<{ stableKey: string; expectedSnapshots: number }>
    }
    expect(manifest.expectedSlots).toHaveLength(plannedPlan.executionNodes.length * 2)
    expect([...new Set(manifest.expectedSlots.map(slot => slot.provider))].sort()).toEqual(['gemini', 'openai'])
    expect([...new Set(manifest.expectedSlots.map(slot => slot.executionId))].sort())
      .toEqual(plannedPlan.executionNodes.map(node => node.stableKey).sort())
  })

  it('stamps the query basket on a full plan sweep', async () => {
    await publish()
    const triggered = await request('POST', '/api/v1/projects/planned/runs')
    expect(triggered.statusCode).toBe(201)

    expect(runRow((triggered.json() as { id: string }).id).queryBasketRevision).toBe(1)
  })

  it('leaves a planless project untouched', async () => {
    await seedProject('plainco')

    const triggered = await request('POST', '/api/v1/projects/plainco/runs')
    expect(triggered.statusCode).toBe(201)

    const row = runRow((triggered.json() as { id: string }).id)
    expect(row.measurementPlanVersionId).toBeNull()
    expect(row.measurementManifest).toBeNull()
    // The basket rule for planless projects is unchanged by plan stamping.
    expect(row.queryBasketRevision).toBe(1)
  })

  it('pins the revision that was active at queue time, not the newest one', async () => {
    await publish()
    const firstVersion = db.select().from(measurementPlanVersions).get()!

    const triggered = await request('POST', '/api/v1/projects/planned/runs')
    const runId = (triggered.json() as { id: string }).id

    const republished = await publish({
      groups: [{ stableKey: 'metro-group', label: 'Metro group', targetKeys: ['north-branch', 'south-branch'] }],
    }, 1)
    expect(republished.statusCode).toBe(201)
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(2)

    expect(runRow(runId).measurementPlanVersionId).toBe(firstVersion.id)
  })

  it('refuses a full sweep that would produce a different number of answers per question', async () => {
    await publish()

    // The count is the denominator of every rate in the revision, so it cannot
    // change inside one.
    const triggered = await request('POST', '/api/v1/projects/planned/runs', { providers: ['openai'] })

    expect(triggered.statusCode).toBe(400)
    const message = (triggered.json() as { error: { message: string } }).error.message
    expect(message).toMatch(/expects 2 answer/i)
    expect(message).toContain('openai')
    expect(db.select().from(runs).all()).toHaveLength(0)
  })

  it('lets the operator comply: republishing at the new count makes the run valid', async () => {
    await publish()
    const firstChecksum = db.select().from(measurementPlanVersions).get()!.checksum

    expect((await request('POST', '/api/v1/projects/planned/runs', { providers: ['openai'] })).statusCode).toBe(400)

    // The instruction the error gives has to be one the operator can carry out.
    // Dropping to one provider changes the expected answers per question, which
    // is part of what the revision's checksum covers, so the republish is real.
    await request('PUT', '/api/v1/projects/planned', {
      displayName: 'planned',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      providers: ['openai'],
      locations: [
        { label: 'north-city', city: 'North City', region: 'NC', country: 'US' },
        { label: 'south-city', city: 'South City', region: 'SC', country: 'US' },
      ],
      defaultLocation: 'north-city',
    })
    const republished = await publish({}, 1)
    expect(republished.statusCode).toBe(201)

    const versions = db.select().from(measurementPlanVersions).all()
    expect(versions).toHaveLength(2)
    expect(versions.map(version => version.checksum)).not.toEqual([firstChecksum, firstChecksum])

    const triggered = await request('POST', '/api/v1/projects/planned/runs', { providers: ['openai'] })
    expect(triggered.statusCode).toBe(201)
  })
})

describe('inputs a plan run cannot honour', () => {
  beforeEach(async () => {
    expect((await publish()).statusCode).toBe(201)
  })

  it.each(['allLocations', 'noLocation'] as const)('refuses %s on a plan project', async (flag) => {
    const triggered = await request('POST', '/api/v1/projects/planned/runs', { [flag]: true })

    expect(triggered.statusCode).toBe(400)
    expect((triggered.json() as { error: { message: string } }).error.message).toMatch(/measurement plan/i)
    expect(db.select().from(runs).all()).toHaveLength(0)
  })

  it('refuses a per-run location on a plan project', async () => {
    const triggered = await request('POST', '/api/v1/projects/planned/runs', { location: 'south-city' })

    expect(triggered.statusCode).toBe(400)
    expect(db.select().from(runs).all()).toHaveLength(0)
  })

  it('still applies the project default location on a planless project', async () => {
    await seedProject('plainco')

    const triggered = await request('POST', '/api/v1/projects/plainco/runs')
    expect(triggered.statusCode).toBe(201)
    expect(runRow((triggered.json() as { id: string }).id).location).toBe('north-city')
  })

  it('leaves the same flags working on a planless project', async () => {
    await seedProject('plainco')

    const triggered = await request('POST', '/api/v1/projects/plainco/runs', { allLocations: true })
    expect(triggered.statusCode).toBe(207)
    expect(db.select().from(runs).all()).toHaveLength(2)
  })
})

describe('scoped runs', () => {
  beforeEach(async () => {
    expect((await publish()).statusCode).toBe(201)
  })

  it('records the scope descriptor and narrows the manifest to the group members', async () => {
    const triggered = await request('POST', '/api/v1/projects/planned/runs', {
      measurementScope: { groups: ['metro-group'] },
    })
    expect(triggered.statusCode).toBe(201)

    const row = runRow((triggered.json() as { id: string }).id)
    expect(row.measurementScope).toEqual({ groups: ['metro-group'], targets: [], queries: [], resolvedTargets: ['north-branch'] })

    const manifest = parseMeasurementRunManifestV1(row.measurementManifest)
    const version = db.select().from(measurementPlanVersions).get()!
    const plannedPlan = JSON.parse(version.canonicalJson) as { executionNodes: Array<{ stableKey: string }> }
    expect(new Set(manifest.expectedSlots.map(slot => slot.executionId)).size).toBe(1)
    expect(manifest.expectedSlots).toHaveLength(2)
    expect(manifest.expectedSlots.length).toBeLessThan(plannedPlan.executionNodes.length * 2)
  })

  it('records a spot check as a probe so it can never stand in for a sweep', async () => {
    const triggered = await request('POST', '/api/v1/projects/planned/runs', {
      measurementScope: { groups: ['metro-group'] },
    })
    expect(triggered.statusCode).toBe(201)

    const row = runRow((triggered.json() as { id: string }).id)
    expect(row.trigger).toBe('probe')
    expect((triggered.json() as { trigger: string }).trigger).toBe('probe')

    // A full sweep on the same project keeps the trigger it was asked for.
    db.delete(runs).run()
    const sweep = await request('POST', '/api/v1/projects/planned/runs')
    expect(runRow((sweep.json() as { id: string }).id).trigger).toBe('manual')
  })

  it('does not stamp the query basket on a scoped run', async () => {
    const triggered = await request('POST', '/api/v1/projects/planned/runs', {
      measurementScope: { targets: ['south-branch'] },
    })
    expect(triggered.statusCode).toBe(201)

    expect(runRow((triggered.json() as { id: string }).id).queryBasketRevision).toBeNull()
  })

  it('rejects an empty scope rather than quietly sweeping everything', async () => {
    // An agent whose filter returned nothing must not accidentally buy a full
    // sweep. Omitting the field is how you ask for one.
    for (const scope of [{}, { groups: [] }, { groups: [], targets: [] }]) {
      const triggered = await request('POST', '/api/v1/projects/planned/runs', { measurementScope: scope })
      expect(triggered.statusCode).toBe(400)
      expect((triggered.json() as { error: { message: string } }).error.message).toMatch(/names nothing|full sweep/i)
    }
    expect(db.select().from(runs).all()).toHaveLength(0)

    const full = await request('POST', '/api/v1/projects/planned/runs')
    expect(full.statusCode).toBe(201)
  })

  it('rejects an unknown group key with a message naming it', async () => {
    const triggered = await request('POST', '/api/v1/projects/planned/runs', {
      measurementScope: { groups: ['west-region'] },
    })

    expect(triggered.statusCode).toBe(400)
    expect((triggered.json() as { error: { message: string } }).error.message).toContain('"west-region"')
    expect(db.select().from(runs).all()).toHaveLength(0)
  })

  it('rejects an unknown target key with a message naming it', async () => {
    const triggered = await request('POST', '/api/v1/projects/planned/runs', {
      measurementScope: { targets: ['east-branch'] },
    })

    expect(triggered.statusCode).toBe(400)
    expect((triggered.json() as { error: { message: string } }).error.message).toContain('"east-branch"')
    expect(db.select().from(runs).all()).toHaveLength(0)
  })

  it('rejects a query list combined with a plan scope', async () => {
    const triggered = await request('POST', '/api/v1/projects/planned/runs', {
      queries: ['widget pricing'],
      measurementScope: { targets: ['north-branch'] },
    })

    expect(triggered.statusCode).toBe(400)
    const message = (triggered.json() as { error: { message: string } }).error.message
    expect(message).toMatch(/queries/i)
    expect(db.select().from(runs).all()).toHaveLength(0)
  })

  it('rejects a scope on a project with no published plan, in plain language', async () => {
    await seedProject('plainco')

    const triggered = await request('POST', '/api/v1/projects/plainco/runs', {
      measurementScope: { targets: ['north-branch'] },
    })

    expect(triggered.statusCode).toBe(400)
    const message = (triggered.json() as { error: { message: string } }).error.message
    expect(message).toMatch(/no published measurement plan/i)
    expect(db.select().from(runs).all()).toHaveLength(0)
  })
})

describe('a query list on a plan project', () => {
  beforeEach(async () => {
    expect((await publish()).statusCode).toBe(201)
  })

  it('measures only the questions asked for, as a spot check', async () => {
    const triggered = await request('POST', '/api/v1/projects/planned/runs', {
      queries: ['widget pricing'],
    })
    expect(triggered.statusCode).toBe(201)

    const row = runRow((triggered.json() as { id: string }).id)
    // The plan is still pinned, but the manifest is the slice, not the sweep.
    expect(row.measurementPlanVersionId).not.toBeNull()
    const manifest = parseMeasurementRunManifestV1(row.measurementManifest)
    expect(new Set(manifest.expectedSlots.map(slot => slot.queryText))).toEqual(new Set(['widget pricing']))

    const version = db.select().from(measurementPlanVersions).get()!
    const plannedPlan = JSON.parse(version.canonicalJson) as { executionNodes: Array<{ stableKey: string }> }
    expect(manifest.expectedSlots.length).toBeLessThan(plannedPlan.executionNodes.length * 2)

    // Same rules as a group/target slice: a probe, a recorded scope, no basket.
    expect(row.trigger).toBe('probe')
    expect(row.measurementScope).toMatchObject({ queries: ['widget pricing'] })
    expect(row.queryBasketRevision).toBeNull()
  })

  it('rejects a question the pinned revision does not measure', async () => {
    await request('POST', '/api/v1/projects/planned/queries', { queries: ['widget delivery'] })

    const triggered = await request('POST', '/api/v1/projects/planned/runs', {
      queries: ['widget delivery'],
    })

    expect(triggered.statusCode).toBe(400)
    expect((triggered.json() as { error: { message: string } }).error.message).toContain('"widget delivery"')
    expect(db.select().from(runs).all()).toHaveLength(0)
  })
})

describe('provider roster', () => {
  it('reads an empty project provider list as "every configured provider"', async () => {
    // `providers: []` means "all configured" everywhere else in canonry.
    await request('PUT', '/api/v1/projects/planned', {
      displayName: 'planned',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      providers: [],
      locations: [
        { label: 'north-city', city: 'North City', region: 'NC', country: 'US' },
        { label: 'south-city', city: 'South City', region: 'SC', country: 'US' },
      ],
      defaultLocation: 'north-city',
    })
    expect((await publish()).statusCode).toBe(201)

    const triggered = await request('POST', '/api/v1/projects/planned/runs')
    expect(triggered.statusCode).toBe(201)

    const manifest = parseMeasurementRunManifestV1(
      runRow((triggered.json() as { id: string }).id).measurementManifest,
    )
    expect(manifest.expectedSlots.length).toBeGreaterThan(0)
    expect([...new Set(manifest.expectedSlots.map(slot => slot.provider))].sort())
      .toEqual(['claude', 'gemini', 'openai', 'perplexity'])
  })

  it('never stamps a slice with no provider to answer it', async () => {
    await request('PUT', '/api/v1/projects/planned', {
      displayName: 'planned',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      providers: [],
      locations: [
        { label: 'north-city', city: 'North City', region: 'NC', country: 'US' },
        { label: 'south-city', city: 'South City', region: 'SC', country: 'US' },
      ],
      defaultLocation: 'north-city',
    })
    expect((await publish()).statusCode).toBe(201)

    const triggered = await request('POST', '/api/v1/projects/planned/runs', {
      measurementScope: { groups: ['metro-group'] },
    })
    expect(triggered.statusCode).toBe(201)

    const manifest = parseMeasurementRunManifestV1(
      runRow((triggered.json() as { id: string }).id).measurementManifest,
    )
    expect(manifest.expectedSlots.length).toBeGreaterThan(0)
  })

  it('gives a spot check its own execution identity without gating anything', async () => {
    expect((await publish()).statusCode).toBe(201)

    // A one-engine slice is a legitimate spot check and decides nothing.
    const probe = await request('POST', '/api/v1/projects/planned/runs', {
      providers: ['openai'],
      measurementScope: { groups: ['metro-group'] },
    })
    expect(probe.statusCode).toBe(201)
    db.update(runs).set({ status: 'completed' }).run()

    const sweep = await request('POST', '/api/v1/projects/planned/runs')
    expect(sweep.statusCode).toBe(201)

    const probeIdentity = runRow((probe.json() as { id: string }).id).measurementExecutionIdentity!
    const sweepIdentity = runRow((sweep.json() as { id: string }).id).measurementExecutionIdentity!
    expect(probeIdentity.providers).toEqual(['openai'])
    expect(sweepIdentity.providers).toEqual(['gemini', 'openai'])
    expect(probeIdentity.checksum).not.toBe(sweepIdentity.checksum)
  })

  it('starts a new series when the engines change, instead of refusing the run', async () => {
    expect((await publish()).statusCode).toBe(201)

    const first = await request('POST', '/api/v1/projects/planned/runs')
    expect(first.statusCode).toBe(201)
    db.update(runs).set({ status: 'completed' }).run()

    // Same count, different engines. Nothing about the plan changed, so a
    // republish would be a no-op and refusing would leave nobody able to comply.
    const swapped = await request('POST', '/api/v1/projects/planned/runs', { providers: ['claude', 'perplexity'] })
    expect(swapped.statusCode).toBe(201)

    const before = runRow((first.json() as { id: string }).id)
    const after = runRow((swapped.json() as { id: string }).id)
    expect(after.measurementPlanVersionId).toBe(before.measurementPlanVersionId)
    expect(after.measurementExecutionIdentity!.providers).toEqual(['claude', 'perplexity'])
    expect(after.measurementExecutionIdentity!.checksum)
      .not.toBe(before.measurementExecutionIdentity!.checksum)
  })

  it('starts a new series when a model changes, including an inherited default', async () => {
    expect((await publish()).statusCode).toBe(201)

    const inherited = await request('POST', '/api/v1/projects/planned/runs')
    expect(inherited.statusCode).toBe(201)
    const inheritedIdentity = runRow((inherited.json() as { id: string }).id).measurementExecutionIdentity!
    // The instance default is resolved and frozen, not left implicit.
    expect(inheritedIdentity.models).toEqual({ gemini: 'gemini-default', openai: 'openai-default' })
    db.update(runs).set({ status: 'completed' }).run()

    // An explicit project override moves the series.
    db.update(projects).set({ providerModels: { openai: 'model-b' } }).run()
    const overridden = await request('POST', '/api/v1/projects/planned/runs')
    expect(overridden.statusCode).toBe(201)
    const overriddenIdentity = runRow((overridden.json() as { id: string }).id).measurementExecutionIdentity!
    expect(overriddenIdentity.models).toEqual({ gemini: 'gemini-default', openai: 'model-b' })
    expect(overriddenIdentity.checksum).not.toBe(inheritedIdentity.checksum)
  })

  it('starts a new series for a retired perplexity model, and records the preset that answers', async () => {
    expect((await publish()).statusCode).toBe(201)
    // Written before `sonar-*` ids were resolved on write, as an old install has it.
    db.update(projects).set({ providerModels: { perplexity: 'sonar' } }).run()

    const triggered = await request('POST', '/api/v1/projects/planned/runs', { providers: ['claude', 'perplexity'] })
    expect(triggered.statusCode).toBe(201)
    const run = runRow((triggered.json() as { id: string }).id)
    const identity = run.measurementExecutionIdentity!
    expect(identity.models).toEqual({ claude: 'claude-default', perplexity: 'fast' })

    // What a Sonar-era run with the same config was stamped with, by the same formula.
    const checksumFor = (perplexity: string) => crypto.createHash('sha256').update(JSON.stringify({
      models: { claude: 'claude-default', perplexity },
      providers: ['claude', 'perplexity'],
      schemaVersion: 1,
    })).digest('hex')
    expect(identity.checksum).toBe(checksumFor('fast'))
    expect(identity.checksum).not.toBe(checksumFor('sonar'))

    // The frozen slots ask for the preset the adapter actually runs.
    const manifest = parseMeasurementRunManifestV1(run.measurementManifest)
    const perplexityModels = new Set(manifest.expectedSlots
      .filter(slot => slot.provider === 'perplexity').map(slot => slot.requestedModel))
    expect([...perplexityModels]).toEqual(['fast'])
    db.update(runs).set({ status: 'completed' }).run()

    // `sonar` and `fast` are one engine now, so they are one series.
    db.update(projects).set({ providerModels: { perplexity: 'fast' } }).run()
    const explicit = await request('POST', '/api/v1/projects/planned/runs', { providers: ['claude', 'perplexity'] })
    expect(runRow((explicit.json() as { id: string }).id).measurementExecutionIdentity!.checksum).toBe(identity.checksum)
  })

  it('keeps one series while nothing about the engines or models moves', async () => {
    expect((await publish()).statusCode).toBe(201)

    const first = await request('POST', '/api/v1/projects/planned/runs')
    db.update(runs).set({ status: 'completed' }).run()
    const second = await request('POST', '/api/v1/projects/planned/runs')

    expect(runRow((second.json() as { id: string }).id).measurementExecutionIdentity!.checksum)
      .toBe(runRow((first.json() as { id: string }).id).measurementExecutionIdentity!.checksum)
  })
})

describe('the all-projects trigger', () => {
  it('stamps the providers it is about to dispatch, not the project default', async () => {
    expect((await publish()).statusCode).toBe(201)

    const triggered = await request('POST', '/api/v1/runs', { providers: ['claude', 'perplexity'] })
    expect(triggered.statusCode).toBe(207)

    const row = db.select().from(runs).get()!
    const manifest = parseMeasurementRunManifestV1(row.measurementManifest)
    expect([...new Set(manifest.expectedSlots.map(slot => slot.provider))].sort())
      .toEqual(['claude', 'perplexity'])
  })
})

describe('the all-projects trigger, when one project cannot be measured', () => {
  it('reports each project on its own terms instead of collapsing the batch', async () => {
    // `aardvark` sorts before `planned` and is dispatched first.
    await seedProject('aardvark')
    expect((await publish()).statusCode).toBe(201)

    const settled = await request('POST', '/api/v1/projects/planned/runs')
    expect(settled.statusCode).toBe(201)
    db.update(runs).set({ status: 'completed' }).run()
    const settledRunId = (settled.json() as { id: string }).id

    // `planned` cannot answer a different NUMBER of times per question;
    // `aardvark` has no plan and accepts the same request.
    const batch = await request('POST', '/api/v1/runs', { providers: ['claude'] })

    expect(batch.statusCode).toBe(207)
    const rows = batch.json() as Array<{ projectName: string; id?: string; status?: string; error?: string }>

    // The valid project is queued, and the response says so with its run id —
    // work that was dispatched is never hidden behind another project's error.
    const queued = rows.find(row => row.projectName === 'aardvark')!
    expect(queued.id).toBeTruthy()
    expect(queued.status).toBe('queued')
    expect(db.select().from(runs).where(eq(runs.id, queued.id!)).get()).toBeDefined()

    // The invalid project is reported next to it, with the reason.
    const refused = rows.find(row => row.projectName === 'planned')!
    expect(refused.status).toBe('error')
    expect(refused.error).toMatch(/answer\(s\) per question/)
    expect(refused.id).toBeUndefined()

    // And nothing was queued for the refused project.
    const plannedRuns = db.select().from(runs).all().filter(row => row.id !== settledRunId && row.id !== queued.id)
    expect(plannedRuns).toHaveLength(0)
  })

  it('still answers 207 when every project is refused', async () => {
    expect((await publish()).statusCode).toBe(201)
    const settled = await request('POST', '/api/v1/projects/planned/runs')
    db.update(runs).set({ status: 'completed' }).run()
    const settledRunId = (settled.json() as { id: string }).id

    const batch = await request('POST', '/api/v1/runs', { providers: ['claude'] })

    expect(batch.statusCode).toBe(207)
    const rows = batch.json() as Array<{ projectName: string; status?: string; error?: string }>
    expect(rows.every(row => row.status === 'error')).toBe(true)
    expect(db.select().from(runs).all().map(row => row.id)).toEqual([settledRunId])
  })
})

describe('a frozen plan whose live queries were deleted', () => {
  it('still runs by hand, the way the scheduler already runs it', async () => {
    expect((await publish()).statusCode).toBe(201)

    // The plan revision froze the questions. Deleting them from the live
    // library cannot retroactively make a published revision unrunnable —
    // and the scheduler never checked the live library in the first place,
    // so the two paths disagreed about the same project.
    db.delete(queries).run()

    const triggered = await request('POST', '/api/v1/projects/planned/runs')
    expect(triggered.statusCode).toBe(201)

    const manifest = parseMeasurementRunManifestV1(
      runRow((triggered.json() as { id: string }).id).measurementManifest,
    )
    expect(manifest.expectedSlots.length).toBeGreaterThan(0)
  })

  it('still refuses a planless project with no questions', async () => {
    await seedProject('plainco')
    db.delete(queries).run()

    const triggered = await request('POST', '/api/v1/projects/plainco/runs')
    expect(triggered.statusCode).toBe(422)
  })
})

describe('multi-context plan runs', () => {
  it('records no single run location, because the plan sets one per question', async () => {
    expect((await publish()).statusCode).toBe(201)

    const triggered = await request('POST', '/api/v1/projects/planned/runs')
    expect(triggered.statusCode).toBe(201)

    expect(runRow((triggered.json() as { id: string }).id).location).toBeNull()
  })
})

describe('documented failure modes', () => {
  it('the all-projects trigger is documented as returning a list', () => {
    const spec = buildOpenApiDocument({ title: 'test', description: 'test' }) as {
      paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: { type?: string } }> }> }>>
    }
    // The route answers one row per project; documenting an object made every
    // generated client type the batch result as a single run.
    const schema = spec.paths['/api/v1/runs']!.post!.responses['207']!.content!['application/json']!.schema!
    expect(schema.type).toBe('array')
  })

  it('the spec says the run trigger can answer 400', () => {
    const spec = buildOpenApiDocument({ title: 'test', description: 'test' }) as {
      paths: Record<string, Record<string, { responses: Record<string, { description?: string }> }>>
    }
    const responses = spec.paths['/api/v1/projects/{name}/runs']!.post!.responses
    expect(Object.keys(responses)).toContain('400')
    expect(responses['400']!.description).toMatch(/measurement (scope|plan)|plan/i)
    expect(Object.keys(spec.paths['/api/v1/runs']!.post!.responses)).toContain('400')
  })
})

describe('project fixture', () => {
  it('seeds a project row the run routes can resolve', () => {
    expect(db.select().from(projects).all().map(row => row.name)).toContain('planned')
  })
})
