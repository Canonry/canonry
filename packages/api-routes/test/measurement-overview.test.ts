import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'

import { measurementOutcomeCounts } from '../src/measurement-overview.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalMeasurementPlanJson,
  canonicalMeasurementPlanV2Json,
  compileMeasurementPlan,
  type MeasurementMetricUnavailableReason,
  type MeasurementOverviewResponse,
  type MeasurementPlanV2,
  type MeasurementPropertyRow,
  type MetricValue,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import {
  createMeasurementOverviewCache,
  type MeasurementOverviewCache,
  type MeasurementOverviewCacheKey,
} from '../src/measurement-overview.js'
import type { MeasurementOverview } from '../src/measurement-report.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-08-01T12:00:00.000Z'

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let projectId: string
let plan: MeasurementPlanV2
let overviewBuilds: number

function emptyCachedOverview(): MeasurementOverview {
  const noPopulation = { numerator: null, denominator: null, rate: null, reason: 'no-population' as const }
  return {
    eligibleSlots: 0,
    answeredSlots: 0,
    includesHistoricalData: false,
    propertiesMentioned: noPopulation,
    mentionCoverage: noPopulation,
    citationCoverage: noPopulation,
    brandPresence: noPopulation,
    namedShareOfVoice: null,
    properties: [],
    flags: 0,
  }
}

function overviewCacheKey(runId: string): MeasurementOverviewCacheKey {
  return {
    planVersionId: 'version',
    revision: 1,
    runId,
    aggregateFingerprint: 'filter',
    evidenceFingerprint: 'evidence',
  }
}

function seedVersion(revision: number): string {
  const id = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id,
    projectId,
    revision,
    canonicalJson: canonicalMeasurementPlanV2Json(plan),
    checksum: crypto.randomUUID().replace(/-/g, '').padEnd(64, '0'),
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    createdAt: NOW,
  }).run()
  return id
}

function activate(versionId: string): void {
  db.insert(measurementPlans).values({
    projectId,
    activeVersionId: versionId,
    createdAt: NOW,
    updatedAt: NOW,
  }).onConflictDoUpdate({
    target: measurementPlans.projectId,
    set: { activeVersionId: versionId, updatedAt: NOW },
  }).run()
}

function seedRun(versionId: string, values: Partial<typeof runs.$inferInsert> = {}): string {
  const id = crypto.randomUUID()
  db.insert(runs).values({
    id,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    measurementPlanVersionId: versionId,
    measurementManifest: buildMeasurementPlanV2Manifest(plan),
    finishedAt: NOW,
    createdAt: NOW,
    ...values,
  }).run()
  return id
}

function seedSnapshot(runId: string, executionKey: string, provider: string, values: Partial<typeof querySnapshots.$inferInsert> = {}): void {
  const node = plan.executionNodes.find(candidate => candidate.stableKey === executionKey)!
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId,
    queryId: null,
    queryText: node.queryText,
    provider,
    citationState: 'cited',
    answerMentioned: true,
    // Names the project and a competitor in one answer, so a shared denominator
    // has to count credits rather than slots.
    answerText: 'Northstar Harbor Homes and Challenger both come up.',
    citedDomains: [],
    competitorOverlap: [],
    recommendedCompetitors: [],
    measurementExecutionId: executionKey,
    requestedContext: node.context.location,
    supportedContext: { status: 'applied', resolved: node.context.location },
    location: node.context.location?.label ?? null,
    citedUrls: ['https://northstar.example/locations/harbor/details'],
    captureStatus: 'complete',
    createdAt: NOW,
    ...values,
  }).run()
}

/** A completed full sweep with every expected slot answered. */
function seedMeasuredRun(versionId: string): string {
  const runId = seedRun(versionId)
  for (const provider of ['openai', 'gemini']) {
    seedSnapshot(runId, 'exec-nearby', provider)
    seedSnapshot(runId, 'exec-brand', provider, { answerText: 'Northstar is well reviewed.' })
  }
  return runId
}

async function overview(query: string): Promise<{ status: number; body: MeasurementOverviewResponse }> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/projects/northstar/measurement-overview?${query}` })
  return { status: response.statusCode, body: response.json() as MeasurementOverviewResponse }
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-overview-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'northstar',
    displayName: 'Northstar',
    canonicalDomain: 'current.example',
    ownedDomains: ['current-owned.example'],
    country: 'US',
    language: 'en',
    locations: [],
    providers: [],
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  plan = measurementPlanV2Fixture()
  overviewBuilds = 0
  const backingOverviewCache = createMeasurementOverviewCache()
  const measurementOverviewCache: MeasurementOverviewCache = {
    getOrBuild(key, build) {
      return backingOverviewCache.getOrBuild(key, () => {
        overviewBuilds++
        return build()
      })
    },
  }

  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, measurementOverviewCache })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('measurement overview', () => {
  it('answers 404 until a plan is active', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/northstar/measurement-overview?scope=all' })
    expect(response.statusCode).toBe(404)
  })

  it('marks every metric unavailable with no_completed_run before the first run', async () => {
    activate(seedVersion(1))

    const { status, body } = await overview('scope=all')

    expect(status).toBe(200)
    expect(body.mode).toBe('active-v2')
    expect(body.measurement.state).toBe('not_measured')
    expect(body.measurement).toMatchObject({ completed: 0, expected: 4, includesHistoricalData: false })
    expect(body.measurement.displayedRunId).toBeUndefined()
    expect(Object.values(body.metrics)).toEqual(Array.from(
      { length: 5 },
      () => ({ state: 'unavailable', reason: 'no_completed_run' }),
    ))
    expect(body.nextAction).toEqual({ kind: 'run_measurement' })
    expect(body.properties.items.every(row => row.mentionCoverage.state === 'unavailable')).toBe(true)
  })

  it('refuses a run pinned to another revision rather than joining across them', async () => {
    const older = seedVersion(1)
    const active = seedVersion(2)
    activate(active)
    const olderRun = seedRun(older)
    seedMeasuredRun(active)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-overview?scope=all&runId=${olderRun}`,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({
      error: { code: 'MEASUREMENT_RUN_REVISION_MISMATCH', details: { runRevision: 1, activeRevision: 2 } },
    })
  })

  it('never displays a scoped spot check by default but honours it by id', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const spotCheck = seedRun(versionId, {
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
    })

    const auto = await overview('scope=all')
    expect(auto.body.measurement.state).toBe('not_measured')
    expect(auto.body.metrics.mentionCoverage).toEqual({ state: 'unavailable', reason: 'no_completed_run' })

    const named = await overview(`scope=all&runId=${spotCheck}`)
    expect(named.status).toBe(200)
    expect(named.body.measurement.displayedRunId).toBe(spotCheck)
  })

  it('emits brandPresence and the deprecated sov alias with the identical value', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedMeasuredRun(versionId)

    const { body } = await overview('scope=all')

    expect(body.measurement).toMatchObject({
      state: 'complete',
      displayedRunId: runId,
      completed: 4,
      expected: 4,
      includesHistoricalData: false,
    })
    expect(body.metrics.brandPresence).toMatchObject({ state: 'available' })
    expect(body.metrics.sov).toEqual(body.metrics.brandPresence)
  })

  it('keeps a Property with one negative and one unattributable answer out of the measured outcome buckets', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedRun(versionId)
    seedSnapshot(runId, 'exec-nearby', 'openai')
    seedSnapshot(runId, 'exec-nearby', 'gemini')
    // Harbor's branded answers: one names only the brand (a measured negative
    // for Harbor), one asks which Harbor Homes was meant. Both cite Harbor.
    seedSnapshot(runId, 'exec-brand', 'openai', { answerText: 'Northstar is well reviewed.' })
    seedSnapshot(runId, 'exec-brand', 'gemini', { answerText: 'Which Harbor Homes do you mean?' })

    const { body } = await overview('scope=property&targetKey=harbor&queryClass=branded')

    const harbor = body.properties.items[0]!
    expect(harbor.mentionCoverage).toEqual({ state: 'available', value: 0, numerator: 0, denominator: 1, unattributed: 1 })
    expect(harbor.citationCoverage).toEqual({ state: 'available', value: 1, numerator: 2, denominator: 2 })
    // Previously this read "cited only". The mention outcome is unknown, like reach.
    expect(body.outcomes).toEqual({ bothSignals: 0, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 1, total: 1 })
    expect(body.metrics.propertiesMentioned).toEqual({ state: 'unavailable', reason: 'identity_ambiguous' })
  })

  it('reports historical source recovery without requiring evidence rows', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedRun(versionId)
    seedSnapshot(runId, 'exec-nearby', 'openai', {
      citedUrls: null,
      rawResponse: JSON.stringify({ groundingSources: [] }),
    })
    seedSnapshot(runId, 'exec-nearby', 'gemini')
    seedSnapshot(runId, 'exec-brand', 'openai', { answerText: 'Northstar is well reviewed.' })
    seedSnapshot(runId, 'exec-brand', 'gemini', { answerText: 'Northstar is well reviewed.' })

    const { body } = await overview('scope=all')

    expect(body.measurement.includesHistoricalData).toBe(true)
  })

  it('counts a question shared by two Properties once in the denominator', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const { body } = await overview('scope=group&groupKey=regional&queryClass=non-brand')

    // exec-nearby is reused by both Properties. Two providers is two slots, and
    // the second Property must not make it four.
    expect(body.metrics.mentionCoverage).toMatchObject({ denominator: 2 })
    expect(body.metrics.brandPresence).toMatchObject({ denominator: 2 })
    expect(body.properties.items.map(row => row.targetKey)).toEqual(['bayside', 'harbor'])
  })

  it('restricts the population to one question class', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const all = await overview('scope=property&targetKey=harbor')
    const branded = await overview('scope=property&targetKey=harbor&queryClass=branded')
    const nonBrand = await overview('scope=property&targetKey=harbor&queryClass=non-brand')

    expect(all.body.metrics.mentionCoverage).toMatchObject({ denominator: 4 })
    expect(branded.body.metrics.mentionCoverage).toMatchObject({ denominator: 2 })
    expect(nonBrand.body.metrics.mentionCoverage).toMatchObject({ denominator: 2 })
    expect(nonBrand.body.queryClass).toBe('non-brand')
  })

  it('splits a Property row by answer engine over that engine\'s own slots', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const { body } = await overview('scope=property&targetKey=harbor')
    const row = body.properties.items[0]!

    // Harbor is named in the Non-brand answer and not in the Branded one, so
    // each engine reads 1 of its 2 answered slots and the Property total is 2
    // of 4. The per-engine rows are a split of the same population, not an
    // average of it: they must not both read the Property's own 50%.
    expect(row.mentionCoverage).toEqual({ state: 'available', value: 0.5, numerator: 2, denominator: 4 })
    expect(row.citationCoverage).toEqual({ state: 'available', value: 1, numerator: 4, denominator: 4 })
    expect(row.providers).toEqual([
      {
        provider: 'gemini',
        mentionCoverage: { state: 'available', value: 0.5, numerator: 1, denominator: 2 },
        citationCoverage: { state: 'available', value: 1, numerator: 2, denominator: 2 },
      },
      {
        provider: 'openai',
        mentionCoverage: { state: 'available', value: 0.5, numerator: 1, denominator: 2 },
        citationCoverage: { state: 'available', value: 1, numerator: 2, denominator: 2 },
      },
    ])
  })

  it('withholds a Property with no question of the requested class instead of reading it as zero', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    // Bayside carries a Non-brand assignment and no Branded one. Its Branded
    // reading is the absence of a measurement, and a 0% would be a lie about
    // an engine that was never asked.
    const branded = await overview('scope=property&targetKey=bayside&queryClass=branded')
    const row = branded.body.properties.items[0]!
    expect(row.mentionCoverage).toEqual({ state: 'unavailable', reason: 'no_population' })
    expect(row.citationCoverage).toEqual({ state: 'unavailable', reason: 'no_population' })
    expect(row.providers).toEqual([])

    const nonBrand = await overview('scope=property&targetKey=bayside&queryClass=non-brand')
    const measured = nonBrand.body.properties.items[0]!
    expect(measured.mentionCoverage).toEqual({ state: 'available', value: 0, numerator: 0, denominator: 2 })
    expect(measured.providers.map(provider => provider.provider)).toEqual(['gemini', 'openai'])
  })

  it('narrows the per-engine split to the requested provider', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const { body } = await overview('scope=property&targetKey=harbor&provider=openai')

    expect(body.properties.items[0]!.providers).toEqual([
      {
        provider: 'openai',
        mentionCoverage: { state: 'available', value: 0.5, numerator: 1, denominator: 2 },
        citationCoverage: { state: 'available', value: 1, numerator: 2, denominator: 2 },
      },
    ])
  })

  it('publishes Named Share of Voice only for a Non-brand group basket', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const group = await overview('scope=group&groupKey=regional&queryClass=non-brand')
    expect(group.body.namedShareOfVoice).toEqual({
      groupKey: 'regional',
      queryClass: 'non-brand',
      denominator: 4,
      entries: [
        { kind: 'project', stableKey: 'project', label: 'Northstar', domain: 'northstar.example', credits: 2, share: 0.5 },
        { kind: 'competitor', stableKey: 'challenger', label: 'Challenger', domain: 'challenger.example', credits: 2, share: 0.5 },
      ],
    })

    for (const scope of ['scope=all&queryClass=non-brand', 'scope=property&targetKey=harbor&queryClass=non-brand', 'scope=group&groupKey=regional']) {
      const other = await overview(scope)
      expect(other.body.namedShareOfVoice, scope).toBeUndefined()
    }
  })

  it('places every Property row in its metro, from the groups that hold it', async () => {
    const cedar = { ...structuredClone(plan.targets[1]!), stableKey: 'cedar', label: 'Cedar Court', aliases: ['Cedar Court'], urlMatchers: [] }
    plan = {
      ...plan,
      targets: [...plan.targets, cedar],
      groups: [
        ...plan.groups,
        { stableKey: 'coastal-metro', label: 'Coastal Metro', targetKeys: ['harbor'], competitors: [] },
        { stableKey: 'waterfront', label: 'Waterfront', parentGroupKey: 'coastal-metro', targetKeys: ['harbor'], competitors: [] },
      ],
    }
    const versionId = seedVersion(1)
    activate(versionId)

    const placement = (body: MeasurementOverviewResponse) => Object.fromEntries(body.properties.items
      .map(row => [row.targetKey, { metro: row.metro, otherMetros: row.otherMetros }]))
    const expected = {
      // Harbor sits in two top-level groups: the first by label, then the rest. A submarket is never a metro.
      harbor: { metro: { groupKey: 'coastal-metro', label: 'Coastal Metro' }, otherMetros: [{ groupKey: 'regional', label: 'Regional comparison' }] },
      bayside: { metro: { groupKey: 'regional', label: 'Regional comparison' }, otherMetros: undefined },
      // In no group: null, not a metro guessed from its label.
      cedar: { metro: null, otherMetros: undefined },
    }
    // Before any run, and after one.
    expect(placement((await overview('scope=all')).body)).toEqual(expected)
    seedMeasuredRun(versionId)
    const measured = await overview('scope=all&queryClass=non-brand')
    expect(measured.status).toBe(200)
    expect(placement(measured.body)).toEqual(expected)
    expect(measured.body.properties.items.find(row => row.targetKey === 'bayside')).not.toHaveProperty('otherMetros')
  })

  it('computes every metric before search and lets search filter rows only', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const unfiltered = await overview('scope=group&groupKey=regional&queryClass=non-brand')
    const searched = await overview('scope=group&groupKey=regional&queryClass=non-brand&search=HARBOR')
    const otherSearch = await overview('scope=group&groupKey=regional&queryClass=non-brand&search=BAYSIDE')

    expect(searched.body.metrics).toEqual(unfiltered.body.metrics)
    expect(otherSearch.body.metrics).toEqual(unfiltered.body.metrics)
    expect(searched.body.flags).toEqual(unfiltered.body.flags)
    expect(searched.body.namedShareOfVoice).toEqual(unfiltered.body.namedShareOfVoice)
    expect(unfiltered.body.properties.items.map(row => row.targetKey)).toEqual(['bayside', 'harbor'])
    expect(searched.body.properties.items.map(row => row.targetKey)).toEqual(['harbor'])
    expect(otherSearch.body.properties.items.map(row => row.targetKey)).toEqual(['bayside'])
    expect(overviewBuilds).toBe(1)
  })

  it('counts outcomes over the whole scope, not the page the caller happened to ask for', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    // The bug this prevents: buckets derived from the loaded rows change as
    // someone pages, so a "total" describes a different population on page two
    // than on page one. A one-row page must report the same scope-wide split as
    // the unpaged read.
    const full = await overview('scope=all')
    const firstPage = await overview('scope=all&limit=1')

    expect(firstPage.body.properties.items).toHaveLength(1)
    expect(firstPage.body.outcomes).toEqual(full.body.outcomes)
    expect(firstPage.body.outcomes.total).toBe(full.body.properties.totalEstimate)

    const o = full.body.outcomes
    expect(o.bothSignals + o.mentionedOnly + o.citedOnly + o.neither + o.notMeasured).toBe(o.total)
  })

  it('pages Properties deterministically through an opaque cursor', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const first = await overview('scope=all&limit=1')
    expect(first.body.properties.items.map(row => row.targetKey)).toEqual(['bayside'])
    expect(first.body.properties.nextCursor).toEqual(expect.any(String))

    const second = await overview(`scope=all&limit=1&cursor=${encodeURIComponent(first.body.properties.nextCursor!)}`)
    expect(second.body.properties.items.map(row => row.targetKey)).toEqual(['harbor'])
    expect(second.body.properties.nextCursor).toBeNull()
  })

  it('reuses one stable aggregate across cursor pages but not a changed filter or run', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const first = await overview('scope=all&limit=1')
    expect(first.status).toBe(200)
    expect(first.body.properties.nextCursor).toEqual(expect.any(String))
    expect(overviewBuilds).toBe(1)

    const second = await overview(`scope=all&limit=1&cursor=${encodeURIComponent(first.body.properties.nextCursor!)}`)
    expect(second.status).toBe(200)
    expect(overviewBuilds).toBe(1)

    const providerFiltered = await overview('scope=all&provider=openai&limit=1')
    expect(providerFiltered.status).toBe(200)
    expect(overviewBuilds).toBe(2)

    const laterRun = seedMeasuredRun(versionId)
    const changedRun = await overview(`scope=all&runId=${laterRun}&limit=1`)
    expect(changedRun.status).toBe(200)
    expect(overviewBuilds).toBe(3)
  })

  it('rebuilds a named in-progress run when its evidence changes', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runningRun = seedRun(versionId, { status: 'running', finishedAt: null })
    seedSnapshot(runningRun, 'exec-nearby', 'openai')

    const initial = await overview(`scope=all&runId=${runningRun}&limit=1`)
    expect(initial.status).toBe(200)
    expect(overviewBuilds).toBe(1)

    seedSnapshot(runningRun, 'exec-nearby', 'gemini')
    const refreshed = await overview(`scope=all&runId=${runningRun}&limit=1`)
    expect(refreshed.status).toBe(200)
    expect(overviewBuilds).toBe(2)
  })

  it('bounds cached aggregates with LRU eviction', () => {
    const cache = createMeasurementOverviewCache(2)
    let builds = 0
    const read = (runId: string) => cache.getOrBuild(overviewCacheKey(runId), () => {
      builds++
      return emptyCachedOverview()
    })

    read('first')
    read('second')
    read('first') // Refresh first, so second becomes the eviction candidate.
    read('third')
    read('second')

    expect(builds).toBe(4)
  })

  it('sorts metric coverage with unavailable Properties first and deterministic label/key ties', async () => {
    plan = measurementPlanV2Fixture({
      targets: [
        ...plan.targets,
        {
          stableKey: 'unmeasured-yankee-b',
          label: 'Yankee Unmeasured',
          aliases: ['Yankee Unmeasured'],
          urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/yankee-b', pathCase: 'insensitive' }],
          mentionNotApplicable: false,
          discoveryIdentity: null,
        },
        {
          stableKey: 'unmeasured-yankee-a',
          label: 'Yankee Unmeasured',
          aliases: ['Yankee Unmeasured'],
          urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/yankee-a', pathCase: 'insensitive' }],
          mentionNotApplicable: false,
          discoveryIdentity: null,
        },
      ],
    })
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const ascending = await overview('scope=all&sort=citationCoverage-asc')
    const descending = await overview('scope=all&sort=citationCoverage-desc')
    const labelDescending = await overview('scope=all&sort=label-desc')
    const mentionsAscending = await overview('scope=all&sort=mentionCoverage-asc')
    const mentionsDescending = await overview('scope=all&sort=mentionCoverage-desc')

    expect(ascending.status).toBe(200)
    expect(ascending.body.properties.items.map(row => row.targetKey))
      .toEqual(['unmeasured-yankee-a', 'unmeasured-yankee-b', 'bayside', 'harbor'])
    expect(descending.status).toBe(200)
    expect(descending.body.properties.items.map(row => row.targetKey))
      .toEqual(['unmeasured-yankee-a', 'unmeasured-yankee-b', 'harbor', 'bayside'])
    expect(labelDescending.status).toBe(200)
    expect(labelDescending.body.properties.items.map(row => row.targetKey))
      .toEqual(['unmeasured-yankee-a', 'unmeasured-yankee-b', 'harbor', 'bayside'])
    expect(mentionsAscending.status).toBe(200)
    expect(mentionsAscending.body.properties.items.map(row => row.targetKey))
      .toEqual(['unmeasured-yankee-a', 'unmeasured-yankee-b', 'bayside', 'harbor'])
    expect(mentionsDescending.status).toBe(200)
    expect(mentionsDescending.body.properties.items.map(row => row.targetKey))
      .toEqual(['unmeasured-yankee-a', 'unmeasured-yankee-b', 'harbor', 'bayside'])
  })

  it('binds new cursors to their sort while accepting a legacy label cursor only for an omitted sort', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    // This is the pre-sort cursor format emitted by the shipped HTTP endpoint.
    const legacyLabelCursor = Buffer.from('bayside homes:bayside', 'utf8').toString('base64url')
    const legacyDefault = await overview(`scope=all&limit=1&cursor=${encodeURIComponent(legacyLabelCursor)}`)
    expect(legacyDefault.status).toBe(200)
    expect(legacyDefault.body.properties.items.map(row => row.targetKey)).toEqual(['harbor'])

    const explicitLabel = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-overview?scope=all&sort=label-asc&cursor=${encodeURIComponent(legacyLabelCursor)}`,
    })
    expect(explicitLabel.statusCode).toBe(400)
    expect(explicitLabel.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The measurement overview cursor does not belong to this result set.',
      },
    })

    const first = await overview('scope=all&sort=citationCoverage-desc&limit=1')
    expect(first.status).toBe(200)
    expect(first.body.properties.nextCursor).toEqual(expect.any(String))

    const sameSort = await overview(
      `scope=all&sort=citationCoverage-desc&limit=1&cursor=${encodeURIComponent(first.body.properties.nextCursor!)}`,
    )
    expect(sameSort.status).toBe(200)
    expect(sameSort.body.properties.items.map(row => row.targetKey)).toEqual(['bayside'])

    const mismatch = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-overview?scope=all&sort=mentionCoverage-desc&cursor=${encodeURIComponent(first.body.properties.nextCursor!)}`,
    })
    expect(mismatch.statusCode).toBe(400)
    expect(mismatch.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The measurement overview cursor sort does not match the request.',
      },
    })
  })

  it('pins sorted cursor pagination to the run that produced the first page', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const firstRun = seedRun(versionId, {
      createdAt: '2026-08-01T10:00:00.000Z',
      finishedAt: '2026-08-01T10:05:00.000Z',
    })
    for (const provider of ['openai', 'gemini']) {
      seedSnapshot(firstRun, 'exec-nearby', provider)
      seedSnapshot(firstRun, 'exec-brand', provider)
    }

    const first = await overview('scope=all&sort=citationCoverage-desc&limit=1')
    expect(first.body.measurement.displayedRunId).toBe(firstRun)
    expect(first.body.properties.items.map(row => row.targetKey)).toEqual(['harbor'])
    expect(first.body.properties.nextCursor).toEqual(expect.any(String))

    const strippedCursor = JSON.parse(
      Buffer.from(first.body.properties.nextCursor!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    delete strippedCursor.displayedRunId
    delete strippedCursor.filterFingerprint
    delete strippedCursor.planVersionId
    delete strippedCursor.evidenceFingerprint
    const tampered = Buffer.from(JSON.stringify(strippedCursor), 'utf8').toString('base64url')
    const strippedBinding = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-overview?scope=all&sort=citationCoverage-desc&cursor=${encodeURIComponent(tampered)}`,
    })
    expect(strippedBinding.statusCode).toBe(400)

    const changedFilter = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-overview?scope=all&sort=citationCoverage-desc&search=harbor&cursor=${encodeURIComponent(first.body.properties.nextCursor!)}`,
    })
    expect(changedFilter.statusCode).toBe(400)
    expect(changedFilter.json()).toMatchObject({
      error: { message: 'The measurement overview cursor filters do not match the request.' },
    })

    const newerRun = seedRun(versionId, {
      createdAt: '2026-08-02T10:00:00.000Z',
      finishedAt: '2026-08-02T10:05:00.000Z',
    })
    for (const provider of ['openai', 'gemini']) {
      seedSnapshot(newerRun, 'exec-nearby', provider, {
        citedUrls: ['https://northstar.example/locations/bayside/details'],
      })
      seedSnapshot(newerRun, 'exec-brand', provider, { citedUrls: [] })
    }

    const second = await overview(
      `scope=all&sort=citationCoverage-desc&limit=1&cursor=${encodeURIComponent(first.body.properties.nextCursor!)}`,
    )
    expect(second.status).toBe(200)
    expect(second.body.measurement.displayedRunId).toBe(firstRun)
    expect(second.body.properties.items.map(row => row.targetKey)).toEqual(['bayside'])
  })

  it('rejects a no-run cursor after the active plan changes', async () => {
    const firstVersion = seedVersion(1)
    activate(firstVersion)

    const first = await overview('scope=all&limit=1')
    expect(first.body.measurement.displayedRunId).toBeUndefined()
    expect(first.body.properties.nextCursor).toEqual(expect.any(String))

    const secondVersion = seedVersion(2)
    activate(secondVersion)
    const continued = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-overview?scope=all&cursor=${encodeURIComponent(first.body.properties.nextCursor!)}`,
    })
    expect(continued.statusCode).toBe(400)
    expect(continued.json()).toMatchObject({
      error: { message: 'The measurement overview cursor revision does not match the active plan.' },
    })
  })

  it('rejects a cursor when a named running run gains evidence between pages', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runningRun = seedRun(versionId, { status: 'running', finishedAt: null })
    seedSnapshot(runningRun, 'exec-nearby', 'openai')

    const first = await overview(`scope=all&runId=${runningRun}&sort=citationCoverage-desc&limit=1`)
    expect(first.status).toBe(200)
    expect(first.body.measurement.state).toBe('running')
    expect(first.body.properties.nextCursor).toEqual(expect.any(String))

    seedSnapshot(runningRun, 'exec-brand', 'gemini')
    const continued = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-overview?scope=all&runId=${runningRun}&sort=citationCoverage-desc&cursor=${encodeURIComponent(first.body.properties.nextCursor!)}`,
    })
    expect(continued.statusCode).toBe(400)
    expect(continued.json()).toMatchObject({
      error: { message: 'The measurement overview cursor evidence changed between pages.' },
    })
  })

  it('rejects a scope without the key it needs', async () => {
    activate(seedVersion(1))

    for (const query of ['scope=group', 'scope=property', 'scope=group&groupKey=missing', 'scope=property&targetKey=missing']) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/projects/northstar/measurement-overview?${query}` })
      expect(response.statusCode, query).toBe(400)
    }
  })

  it('withholds class-dependent metrics under an active v1 plan', async () => {
    const v1 = compileMeasurementPlan({
      schemaVersion: 1,
      targets: [{
        stableKey: 'harbor',
        label: 'Harbor Homes',
        urls: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/harbor', pathCase: 'insensitive' }],
        aliases: ['Harbor Homes'],
      }],
      groups: [],
      targetQuerySelections: [{ targetKey: 'harbor', queryIds: ['q-nearby'] }],
    }, {
      canonicalDomain: 'northstar.example',
      ownedDomains: [],
      brandNames: ['Northstar'],
      trackedQueries: [{ id: 'q-nearby', query: 'homes near harbor' }],
      locations: [],
      defaultContext: null,
      expectedSnapshots: 1,
    })
    const versionId = crypto.randomUUID()
    db.insert(measurementPlanVersions).values({
      id: versionId,
      projectId,
      revision: 1,
      canonicalJson: canonicalMeasurementPlanJson(v1),
      checksum: 'a'.repeat(64),
      createdAt: NOW,
    }).run()
    activate(versionId)

    const { body } = await overview('scope=all')

    expect(body.mode).toBe('active-v1')
    expect(body.metrics.mentionCoverage).toEqual({ state: 'unavailable', reason: 'plan_v1' })
    expect(body.metrics.sov).toEqual({ state: 'unavailable', reason: 'plan_v1' })
    expect(body.nextAction).toEqual({ kind: 'republish_setup' })
    expect(body.properties.items).toEqual([
      {
        targetKey: 'harbor',
        label: 'Harbor Homes',
        mentionCoverage: { state: 'unavailable', reason: 'plan_v1' },
        citationCoverage: { state: 'unavailable', reason: 'plan_v1' },
        // A v1 revision measured no per-engine population either, so this is
        // empty rather than a row of engines reading zero.
        providers: [],
        flags: 0,
      },
    ])
  })
})

// ── Outcome counts ───────────────────────────────────────────────────────────
describe('measurementOutcomeCounts', () => {
  const avail = (numerator: number, denominator = 4): MetricValue =>
    ({ state: 'available', value: numerator / denominator, numerator, denominator })
  const gone = (reason: MeasurementMetricUnavailableReason = 'no_completed_run'): MetricValue =>
    ({ state: 'unavailable', reason })
  const row = (targetKey: string, mention: MetricValue, citation: MetricValue) =>
    ({ targetKey, label: targetKey, mentionCoverage: mention, citationCoverage: citation, providers: [], flags: 0 }) as MeasurementPropertyRow

  it('splits a scope into disjoint outcomes that sum to its property total', () => {
    const counts = measurementOutcomeCounts([
      row('a', avail(3), avail(2)),   // both
      row('b', avail(2), avail(0)),   // mentioned, not cited
      row('c', avail(0), avail(1)),   // cited, not mentioned
      row('d', avail(0), avail(0)),   // neither
      row('e', gone(), gone()),       // not measured
    ])

    expect(counts).toEqual({
      bothSignals: 1, mentionedOnly: 1, citedOnly: 1, neither: 1, notMeasured: 1, total: 5,
    })
    const parts = counts.bothSignals + counts.mentionedOnly + counts.citedOnly + counts.neither + counts.notMeasured
    expect(parts).toBe(counts.total)
  })

  it('counts a HALF-measured property as not measured, never as an absence of the missing signal', () => {
    // Mentioned but citation unmeasured is NOT "mentioned only" — that phrasing
    // asserts the Property was not cited, which nothing measured. Classifying
    // it requires both signals.
    const counts = measurementOutcomeCounts([
      row('a', avail(3), gone()),
      row('b', gone(), avail(2)),
    ])
    expect(counts.mentionedOnly).toBe(0)
    expect(counts.citedOnly).toBe(0)
    expect(counts.notMeasured).toBe(2)
    expect(counts.total).toBe(2)
  })

  it('is exhaustive over any mix, so the parts always reconcile', () => {
    const metrics = [avail(0), avail(2), gone(), gone('no_population')]
    const rows = metrics.flatMap((mention, i) =>
      metrics.map((citation, j) => row(`r${i}-${j}`, mention, citation)))
    const counts = measurementOutcomeCounts(rows)
    const parts = counts.bothSignals + counts.mentionedOnly + counts.citedOnly + counts.neither + counts.notMeasured
    expect(parts).toBe(rows.length)
    expect(counts.total).toBe(rows.length)
  })

  it('never turns answers it could not attribute into a confirmed absence of mention', () => {
    // One negative answer and one ambiguous one: the rate is 0 of 1 with one
    // answer left out. With no verified mention the outcome is unknown, so the
    // Property is not "cited only" or "neither".
    const partialZero: MetricValue = { state: 'available', value: 0, numerator: 0, denominator: 1, unattributed: 1 }
    const counts = measurementOutcomeCounts([
      row('cited', partialZero, avail(2, 2)),
      row('uncited', partialZero, avail(0, 2)),
      // A verified mention still stands beside an excluded answer.
      row('mentioned', { state: 'available', value: 1, numerator: 1, denominator: 1, unattributed: 9 }, avail(0, 10)),
    ])
    expect(counts).toEqual({ bothSignals: 0, mentionedOnly: 1, citedOnly: 0, neither: 0, notMeasured: 2, total: 3 })
  })

  it('reports an empty scope as all zeroes rather than throwing', () => {
    expect(measurementOutcomeCounts([])).toEqual({
      bothSignals: 0, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 0,
    })
  })
})
