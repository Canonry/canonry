import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { getTableName, sql, type Table } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildMeasurementRunManifestV1,
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  parseStoredMeasurementPlanAnyVersion,
  queryTrackingPreviewResponseSchema,
  queryTrackingWorkspaceResponseSchema,
  RunKinds,
  RunStatuses,
  RunTriggers,
  type MeasurementPlanV2,
  type QueryTrackingWorkspaceResponse,
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

// Counts every stored-plan parse a read makes. The function itself is unchanged.
vi.mock('@ainyc/canonry-contracts', async importOriginal => {
  const actual = await importOriginal<typeof import('@ainyc/canonry-contracts')>()
  return { ...actual, parseStoredMeasurementPlanAnyVersion: vi.fn(actual.parseStoredMeasurementPlanAnyVersion) }
})

const NOW = '2026-10-09T00:00:00.000Z'
const PROJECT = 'northbridge'
const PROJECT_ID = 'project-northbridge'
const ROOT_KEY = 'cnry_measured_cost_root'
const ENGINES = ['claude', 'gemini', 'openai'] as const
const MODELS = { claude: 'claude-test', gemini: 'gemini-test', openai: 'gpt-test' }
const RIVERSIDE = { label: 'riverside', city: 'Riverside', region: 'EX', country: 'US' }

/** An October 2026 instant: noon on `day` unless an hour is named. */
const at = (day: number, hour = 12) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`

let directory: string
let db: DatabaseClient
let app: FastifyInstance

type Pairing = { queryId: string; targetKey: string; queryClass: 'branded' | 'non-brand'; classificationSource?: 'server' | 'operator' }

const TARGETS: ReadonlyArray<readonly [stableKey: string, label: string]> = [['harbor', 'Harbor Point'], ['cedar', 'Cedar Court']]
const TEXTS: Readonly<Record<string, string>> = {
  'q-market': 'best homes in uptown',
  'q-harbor': 'Harbor Point reviews',
  'q-parking': 'homes with covered parking',
}
const PAIRINGS: readonly Pairing[] = [
  { queryId: 'q-market', targetKey: 'harbor', queryClass: 'non-brand' },
  { queryId: 'q-harbor', targetKey: 'harbor', queryClass: 'branded' },
  { queryId: 'q-parking', targetKey: 'cedar', queryClass: 'non-brand' },
]

/** One execution per query, asked of all three engines in Riverside. `aliases` renames a location, by its key. */
function planOf(input: {
  targets?: ReadonlyArray<readonly [stableKey: string, label: string]>
  aliases?: Readonly<Record<string, readonly string[]>>
  texts?: Readonly<Record<string, string>>
  pairings?: readonly Pairing[]
} = {}): MeasurementPlanV2 {
  const texts = input.texts ?? TEXTS
  const pairings = input.pairings ?? PAIRINGS
  const edge = (pairing: Pairing) => ({ executionNodeKey: `n-${pairing.queryId}`, targetKey: pairing.targetKey, queryId: pairing.queryId })
  const provisional = measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'northbridge.example', ownedHosts: ['northbridge.example'], names: ['Northbridge'] } },
    targets: (input.targets ?? TARGETS).map(([stableKey, label]) => ({
      stableKey, label, aliases: input.aliases?.[stableKey] ?? [label],
      urlMatchers: [{ kind: 'prefix', host: 'northbridge.example', pathPrefix: `/${stableKey}`, pathCase: 'insensitive' }],
      mentionNotApplicable: false, discoveryIdentity: null,
    })),
    groups: [],
    querySnapshots: Object.entries(texts).map(([queryId, queryText]) => ({
      queryId, queryText, provenance: { source: 'manual', sourceId: null, capturedAt: NOW },
    })),
    assignments: pairings.map(pairing => ({
      ...edge(pairing), queryClass: pairing.queryClass, classificationSource: pairing.classificationSource ?? 'server',
    })),
    executionNodes: [...new Set(pairings.map(pairing => pairing.queryId))].map(queryId => ({
      stableKey: `n-${queryId}`, queryId, queryText: texts[queryId],
      context: { providers: [...ENGINES], models: MODELS, location: RIVERSIDE }, expectedSnapshots: ENGINES.length,
    })),
    usageEdges: pairings.map(edge),
    compiledChecksum: '0'.repeat(64),
  })
  const compiledChecksum = crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(provisional)).digest('hex')
  return measurementPlanV2Schema.parse({ ...provisional, compiledChecksum })
}

function seedVersion(revision: number, plan: MeasurementPlanV2): string {
  const id = `plan-v${revision}`
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.insert(measurementPlanVersions).values({
    id, projectId: PROJECT_ID, revision, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, comparableToVersionId: null, createdAt: NOW,
  }).run()
  return id
}

/** Makes `versionId` the active plan, with a catalog row for each of its queries. */
function activate(versionId: string, plan: MeasurementPlanV2): void {
  db.insert(measurementPlans).values({ projectId: PROJECT_ID, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW })
    .onConflictDoUpdate({ target: measurementPlans.projectId, set: { activeVersionId: versionId, updatedAt: NOW } }).run()
  const rows = plan.querySnapshots.map(row => ({ id: row.queryId, projectId: PROJECT_ID, query: row.queryText, provenance: null, createdAt: NOW }))
  for (let start = 0; start < rows.length; start += 400) {
    db.insert(queries).values(rows.slice(start, start + 400))
      .onConflictDoUpdate({ target: queries.id, set: { query: sql`excluded.query` } }).run()
  }
}

/** One stored sweep of `plan`, as the queue freezes it. `skip` leaves an engine's answer out. */
function seedSweep(input: {
  id: string
  versionId: string
  plan: MeasurementPlanV2
  createdAt: string
  finishedAt?: string
  trigger?: string
  skip?: (slot: { queryId: string; provider: string }) => boolean
}): void {
  const manifest = buildMeasurementRunManifestV1({
    expectedSlots: input.plan.executionNodes.flatMap(node => node.context.providers.map(provider => ({
      executionId: node.stableKey, queryText: node.queryText, provider, context: node.context.location,
      requestedModel: node.context.models[provider]!,
    }))),
  })
  db.insert(runs).values({
    id: input.id, projectId: PROJECT_ID, kind: RunKinds['answer-visibility'], status: RunStatuses.completed,
    trigger: input.trigger ?? RunTriggers.manual, measurementPlanVersionId: input.versionId, measurementManifest: manifest,
    finishedAt: input.finishedAt ?? input.createdAt, createdAt: input.createdAt,
  }).run()
  const rows: Array<typeof querySnapshots.$inferInsert> = []
  for (const node of input.plan.executionNodes) {
    for (const provider of node.context.providers) {
      if (input.skip?.({ queryId: node.queryId, provider })) continue
      rows.push({
        id: `${input.id}-${node.stableKey}-${provider}`, runId: input.id, queryId: node.queryId, queryText: node.queryText,
        provider, model: node.context.models[provider]!, citationState: 'not-cited', answerMentioned: false,
        answerText: 'Several other communities nearby are worth a look.', citedDomains: [], citedUrls: ['https://listings.example/uptown'],
        captureStatus: 'complete', competitorOverlap: [], recommendedCompetitors: [],
        location: RIVERSIDE.label, measurementExecutionId: node.stableKey,
        requestedContext: RIVERSIDE, supportedContext: { status: 'applied', resolved: RIVERSIDE },
        createdAt: input.createdAt,
      })
    }
  }
  for (let start = 0; start < rows.length; start += 400) db.insert(querySnapshots).values(rows.slice(start, start + 400)).run()
}

function request(method: 'GET' | 'POST', suffix: string, payload?: unknown) {
  return app.inject({
    method, url: `/api/v1/projects/${PROJECT}${suffix}`,
    headers: { authorization: `Bearer ${ROOT_KEY}` },
    ...(payload === undefined ? {} : { payload }),
  })
}

async function workspace(): Promise<QueryTrackingWorkspaceResponse> {
  const response = await request('GET', '/query-tracking')
  expect(response.statusCode, response.body.slice(0, 300)).toBe(200)
  return queryTrackingWorkspaceResponseSchema.parse(response.json())
}

/** A review that changes nothing: the preview still reads every row's measured state. */
async function emptyPreview(workspaceVersion: string) {
  const response = await request('POST', '/query-tracking/preview', { expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [] })
  expect(response.statusCode, response.body.slice(0, 300)).toBe(200)
  return queryTrackingPreviewResponseSchema.parse(response.json())
}

/** Each tracked query's measured state, by query id. */
function measured(rows: QueryTrackingWorkspaceResponse['tracked']) {
  return Object.fromEntries(rows.map(row => [row.queryId, row.state === 'tracked' ? row.lastMeasuredAt : row.state]))
}

interface Reads {
  /** One entry per `query_snapshots` read: the sweep it named and the rows that came back. */
  snapshots: Array<{ runId: string; rows: number }>
  /** How many sweep rows came back carrying their manifest. */
  manifests: number
  /** Whether any `query_snapshots` read selected answer text or source links. */
  answerBodies: boolean
}

/** Records what the routes load from `query_snapshots` and `runs`. The reads themselves are unchanged. */
function recordReads(): Reads {
  const reads: Reads = { snapshots: [], manifests: 0, answerBodies: false }
  type Row = Record<string, unknown>
  type Builder = { from: (table: Table) => { all: () => Row[]; get: () => Row | undefined } }
  const select = db.select.bind(db) as (...args: unknown[]) => Builder
  const record = (name: string, rows: Row[]) => {
    if (name === 'runs') {
      reads.manifests += rows.filter(row => row.measurementManifest !== undefined).length
      return
    }
    const byRun = new Map<string, number>()
    for (const row of rows) byRun.set(String(row.runId), (byRun.get(String(row.runId)) ?? 0) + 1)
    for (const [runId, count] of byRun) reads.snapshots.push({ runId, rows: count })
    if (rows.some(row => 'answerText' in row || 'citedUrls' in row)) reads.answerBodies = true
  }
  vi.spyOn(db, 'select').mockImplementation(((...args: unknown[]) => {
    const builder = select(...args)
    const from = builder.from.bind(builder)
    builder.from = (table: Table) => {
      const query = from(table)
      const name = getTableName(table)
      if (name !== 'query_snapshots' && name !== 'runs') return query
      const all = query.all.bind(query)
      const get = query.get.bind(query)
      query.all = () => {
        const rows = all()
        record(name, rows)
        return rows
      }
      query.get = () => {
        const row = get()
        record(name, row ? [row] : [])
        return row
      }
      return query
    }
    return builder
  }) as typeof db.select)
  return reads
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measured-cost-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: PROJECT_ID, name: PROJECT, displayName: 'Northbridge', canonicalDomain: 'northbridge.example',
    ownedDomains: [], aliases: [], country: 'US', language: 'en', providers: [...ENGINES], providerModels: MODELS,
    locations: [RIVERSIDE], defaultLocation: 'riverside', createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'root', keyHash: hashApiKey(ROOT_KEY), keyPrefix: ROOT_KEY.slice(0, 9), scopes: ['*'], projectId: null, createdAt: NOW,
  }).run()
  app = Fastify()
  app.register(apiRoutes, { db, getRunnableProviderNames: () => [...ENGINES] })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  db.$client.close()
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('query tracking measured state: which sweeps are read', () => {
  it('reads the one sweep of the active plan, without answer text, and parses no plan twice', async () => {
    const plan = planOf()
    const versionId = seedVersion(1, plan)
    activate(versionId, plan)
    seedSweep({ id: 'sweep-1', versionId, plan, createdAt: at(1), finishedAt: at(1, 13) })
    const parses = vi.mocked(parseStoredMeasurementPlanAnyVersion)
    const reads = recordReads()
    parses.mockClear()

    expect(measured((await workspace()).tracked)).toEqual({ 'q-market': at(1, 13), 'q-harbor': at(1, 13), 'q-parking': at(1, 13) })
    expect(reads.snapshots).toEqual([{ runId: 'sweep-1', rows: 9 }])
    expect(reads.manifests).toBe(1)
    expect(reads.answerBodies).toBe(false)
    // The workspace already parsed the active plan; the sweep ran with it.
    expect(parses).toHaveBeenCalledTimes(1)
  })

  it('walks three sweeps by finish time until a query measured only in the oldest one is found', async () => {
    const plan = planOf()
    const versionId = seedVersion(1, plan)
    activate(versionId, plan)
    seedSweep({ id: 'sweep-oldest', versionId, plan, createdAt: at(1), finishedAt: at(1, 13) })
    // Started second and finished last, missing one answer for two of the three queries.
    seedSweep({
      id: 'sweep-slow', versionId, plan, createdAt: at(2), finishedAt: at(4, 9),
      skip: slot => (slot.queryId === 'q-harbor' && slot.provider === 'gemini') || (slot.queryId === 'q-parking' && slot.provider === 'openai'),
    })
    seedSweep({
      id: 'sweep-started-last', versionId, plan, createdAt: at(3), finishedAt: at(3, 13),
      skip: slot => slot.queryId === 'q-parking' && slot.provider === 'openai',
    })
    const reads = recordReads()

    expect(measured((await workspace()).tracked)).toEqual({ 'q-market': at(4, 9), 'q-harbor': at(3, 13), 'q-parking': at(1, 13) })
    expect(reads.snapshots).toEqual([
      { runId: 'sweep-slow', rows: 7 },
      { runId: 'sweep-started-last', rows: 8 },
      { runId: 'sweep-oldest', rows: 9 },
    ])
  })

  it('reads only the sweep that finished last when it measured every query, though another started later', async () => {
    const plan = planOf()
    const versionId = seedVersion(1, plan)
    activate(versionId, plan)
    seedSweep({ id: 'sweep-oldest', versionId, plan, createdAt: at(1), finishedAt: at(1, 13) })
    seedSweep({ id: 'sweep-slow', versionId, plan, createdAt: at(2), finishedAt: at(4, 9) })
    seedSweep({ id: 'sweep-started-last', versionId, plan, createdAt: at(3), finishedAt: at(3, 13) })
    const reads = recordReads()

    expect(measured((await workspace()).tracked)).toEqual({ 'q-market': at(4, 9), 'q-harbor': at(4, 9), 'q-parking': at(4, 9) })
    expect(reads.snapshots).toEqual([{ runId: 'sweep-slow', rows: 9 }])
    expect(reads.manifests).toBe(1)
  })

  it('gives a query asked for two locations the newer time when a different sweep measured each', async () => {
    // `q-market` is asked for Harbor Point and for Cedar Court. Plan 2 filed its Cedar Court pairing under
    // Non-brand, so only plan 1's sweep asked that pairing as the active plan, plan 3, does.
    const forCedar = (queryClass: 'branded' | 'non-brand'): Pairing => ({ queryId: 'q-market', targetKey: 'cedar', queryClass })
    const branded = planOf({ pairings: [...PAIRINGS, forCedar('branded')] })
    const refiled = planOf({ pairings: [...PAIRINGS, forCedar('non-brand')] })
    const [firstId, secondId, thirdId] = [seedVersion(1, branded), seedVersion(2, refiled), seedVersion(3, branded)]
    activate(thirdId, branded)
    seedSweep({ id: 'sweep-1', versionId: firstId, plan: branded, createdAt: at(1) })
    seedSweep({ id: 'sweep-2', versionId: secondId, plan: refiled, createdAt: at(2) })
    const reads = recordReads()

    // Harbor Point was last measured on day 2 and Cedar Court on day 1: the query's time is the newer one.
    expect(measured((await workspace()).tracked)).toEqual({ 'q-market': at(2), 'q-harbor': at(2), 'q-parking': at(2) })
    expect(reads.snapshots).toEqual([{ runId: 'sweep-2', rows: 9 }, { runId: 'sweep-1', rows: 9 }])
  })

  /**
   * Five sweeps over three plans:
   * - plan 1 asks four queries, with `q-cedar` Branded;
   * - plan 2 files `q-cedar` under Non-brand;
   * - plan 3, the active one, files it under Branded again and adds `q-transit`, which only a probe has asked.
   */
  function fiveSweeps() {
    const texts = { ...TEXTS, 'q-cedar': 'Cedar Court floor plans' }
    const cedar = (queryClass: 'branded' | 'non-brand'): Pairing => ({ queryId: 'q-cedar', targetKey: 'cedar', queryClass })
    const first = planOf({ texts, pairings: [...PAIRINGS, cedar('branded')] })
    const second = planOf({ texts, pairings: [...PAIRINGS, cedar('non-brand')] })
    const third = planOf({
      texts: { ...texts, 'q-transit': 'homes near transit' },
      pairings: [...PAIRINGS, cedar('branded'), { queryId: 'q-transit', targetKey: 'harbor', queryClass: 'non-brand' }],
    })
    const [firstId, secondId, thirdId] = [seedVersion(1, first), seedVersion(2, second), seedVersion(3, third)]
    activate(thirdId, third)
    seedSweep({ id: 'sweep-1', versionId: firstId, plan: first, createdAt: at(1) })
    seedSweep({ id: 'sweep-2', versionId: firstId, plan: first, createdAt: at(2) })
    seedSweep({ id: 'sweep-3', versionId: secondId, plan: second, createdAt: at(3) })
    seedSweep({ id: 'sweep-4', versionId: secondId, plan: second, createdAt: at(4) })
    seedSweep({ id: 'probe-5', versionId: thirdId, plan: third, createdAt: at(5), trigger: RunTriggers.probe })
  }
  const FIVE_SWEEPS_MEASURED = {
    'q-market': at(4), 'q-harbor': at(4), 'q-parking': at(4),
    // Only plan 1's sweeps asked it as the active plan does.
    'q-cedar': at(2),
    // Asked by the probe alone, which never counts.
    'q-transit': 'awaiting-sweep',
  }

  it('loads no snapshot of a sweep that cannot measure an awaiting query, and never a probe', async () => {
    fiveSweeps()
    const reads = recordReads()

    expect(measured((await workspace()).tracked)).toEqual(FIVE_SWEEPS_MEASURED)
    // sweep-3 could add nothing after sweep-4, and sweep-1 nothing after sweep-2.
    expect(reads.snapshots).toEqual([{ runId: 'sweep-4', rows: 12 }, { runId: 'sweep-2', rows: 12 }])
    expect(reads.manifests).toBe(2)
  })

  it('gives a preview the same measured state from the same two sweeps', async () => {
    fiveSweeps()
    const { workspaceVersion } = await workspace()
    const reads = recordReads()

    expect(measured((await emptyPreview(workspaceVersion)).tracked)).toEqual(FIVE_SWEEPS_MEASURED)
    expect(reads.snapshots).toEqual([{ runId: 'sweep-4', rows: 12 }, { runId: 'sweep-2', rows: 12 }])
  })

  it('stops at the newest of five sweeps of the active plan', async () => {
    const plan = planOf()
    const versionId = seedVersion(1, plan)
    activate(versionId, plan)
    for (let day = 1; day <= 5; day++) seedSweep({ id: `sweep-${day}`, versionId, plan, createdAt: at(day) })
    const reads = recordReads()

    expect(measured((await workspace()).tracked)).toEqual({ 'q-market': at(5), 'q-harbor': at(5), 'q-parking': at(5) })
    expect(reads.snapshots).toEqual([{ runId: 'sweep-5', rows: 9 }])
    expect(reads.manifests).toBe(1)
  })
})

describe('query tracking measured state: what a sweep must have asked', () => {
  it.each([
    {
      change: 'a location gained a name',
      active: () => planOf({ aliases: { harbor: ['Harbor Point', 'Harbor Point Homes'] } }),
      awaiting: ['q-market', 'q-harbor'],
    },
    {
      change: 'an operator set the type the server had set',
      active: () => planOf({ pairings: PAIRINGS.map(pairing => (pairing.queryId === 'q-parking' ? { ...pairing, classificationSource: 'operator' as const } : pairing)) }),
      awaiting: ['q-parking'],
    },
  ])('awaits a new sweep for the pairings it touches, and no other, once $change', async ({ active, awaiting }) => {
    const swept = planOf()
    const sweptId = seedVersion(1, swept)
    activate(sweptId, swept)
    seedSweep({ id: 'sweep-1', versionId: sweptId, plan: swept, createdAt: at(1) })
    const next = active()
    activate(seedVersion(2, next), next)

    expect(measured((await workspace()).tracked)).toEqual({
      'q-market': at(1), 'q-harbor': at(1), 'q-parking': at(1),
      ...Object.fromEntries(awaiting.map(queryId => [queryId, 'awaiting-sweep'])),
    })
  })
})

describe('query tracking measured state: cost at portfolio size', () => {
  it('reads 940 queries over 20 plans and 19 sweeps inside its budget, for the workspace and a preview', { timeout: 300_000 }, async () => {
    // Generous on purpose, for a loaded machine: the read counts below are the guard that cannot flake.
    const WORKSPACE_BUDGET_MS = 10_000
    const PREVIEW_BUDGET_MS = 15_000
    const large = largePortfolio(190, 137)
    const REWORDED = 'q-loc-0-0'
    /** Plan `revision` differs from every other plan in one query's wording, as a tracking publish leaves it. */
    const planAt = (revision: number) => planOf({ ...large, texts: { ...large.texts, [REWORDED]: `Harbor 000 reviews, wording ${revision}` } })
    let swept!: { versionId: string; plan: MeasurementPlanV2 }
    for (let revision = 1; revision <= 19; revision++) {
      const plan = planAt(revision)
      expect(plan.querySnapshots).toHaveLength(940)
      expect(plan.assignments).toHaveLength(2_584)
      swept = { versionId: seedVersion(revision, plan), plan }
      // The catalog rows exist before the first sweep stores answers for them.
      if (revision === 1) activate(swept.versionId, plan)
      // One sweep an hour, oldest first.
      seedSweep({ id: `sweep-${String(revision).padStart(2, '0')}`, versionId: swept.versionId, plan, createdAt: at(1, revision) })
    }
    activate(swept.versionId, swept.plan)
    const parses = vi.mocked(parseStoredMeasurementPlanAnyVersion)
    const reads = recordReads()

    /** Five reads: the last body, the best time, and what one read loaded. */
    const measure = async <Body>(read: () => Promise<Body>) => {
      const timings: number[] = []
      let body!: Body
      for (let attempt = 0; attempt < 5; attempt++) {
        reads.snapshots.length = 0
        reads.manifests = 0
        parses.mockClear()
        const started = performance.now()
        body = await read()
        timings.push(performance.now() - started)
      }
      return { body, best: Math.min(...timings), snapshots: [...reads.snapshots], manifests: reads.manifests, parses: parses.mock.calls.length }
    }
    const tally = (rows: QueryTrackingWorkspaceResponse['tracked']) => ({
      tracked: rows.filter(row => row.state === 'tracked').length,
      awaiting: rows.filter(row => row.state === 'awaiting-sweep').length,
    })

    // The newest sweep ran with the active plan: the everyday read opens that sweep and no other plan.
    const current = await measure(workspace)
    expect(tally(current.body.tracked)).toEqual({ tracked: 940, awaiting: 0 })
    expect(current.snapshots).toEqual([{ runId: 'sweep-19', rows: 940 * 3 }])
    expect(current.manifests).toBe(1)
    expect(current.parses).toBe(1)

    // Tracking changed and no sweep has run since: one query awaits, and the read still opens one sweep.
    // It parses each plan at most once: the active plan, the plan of that sweep, and the eighteen older
    // plans, each to learn that its sweep never asked the reworded query.
    const active = planAt(20)
    activate(seedVersion(20, active), active)
    const changed = await measure(workspace)
    expect(tally(changed.body.tracked)).toEqual({ tracked: 939, awaiting: 1 })
    expect(changed.body.tracked.find(row => row.queryId === REWORDED)).toMatchObject({ state: 'awaiting-sweep', lastMeasuredAt: null })
    expect(changed.snapshots).toEqual([{ runId: 'sweep-19', rows: 940 * 3 }])
    expect(changed.manifests).toBe(1)
    expect(changed.parses).toBeLessThanOrEqual(20)

    const preview = await measure(() => emptyPreview(changed.body.workspaceVersion))
    expect(tally(preview.body.tracked)).toEqual({ tracked: 939, awaiting: 1 })
    expect(preview.snapshots).toEqual([{ runId: 'sweep-19', rows: 940 * 3 }])
    expect(preview.manifests).toBe(1)
    expect(preview.parses).toBeLessThanOrEqual(20)

    console.info(`query-tracking measured check, 940 queries x 3 engines, 20 plans, 19 sweeps: workspace best ${current.best.toFixed(0)} ms, ${changed.best.toFixed(0)} ms after a tracking change, preview best ${preview.best.toFixed(0)} ms`)
    expect(current.best).toBeLessThan(WORKSPACE_BUDGET_MS)
    expect(changed.best).toBeLessThan(WORKSPACE_BUDGET_MS)
    expect(preview.best).toBeLessThan(PREVIEW_BUDGET_MS)
  })
})

/**
 * A portfolio the size of a large customer's: 190 locations, each with two
 * Branded queries of its own, 137 markets with four Non-brand queries asked
 * once for the market's four locations, and hand-picked queries up to 940.
 */
function largePortfolio(locations: number, markets: number) {
  const targets = Array.from({ length: locations }, (_, index) => {
    const label = `${['Harbor', 'Cedar', 'Maple', 'Willow', 'Summit'][index % 5]} ${String(index).padStart(3, '0')}`
    return [`loc-${index}`, label] as const
  })
  const texts: Record<string, string> = {}
  const pairings: Pairing[] = []
  targets.forEach(([stableKey, label], index) => {
    for (let own = 0; own < 2; own++) {
      const queryId = `q-loc-${index}-${own}`
      texts[queryId] = `${label} ${own === 0 ? 'reviews' : 'floor plans'}`
      pairings.push({ queryId, targetKey: stableKey, queryClass: 'branded' })
    }
  })
  for (let market = 0; market < markets; market++) {
    for (let asked = 0; asked < 4; asked++) {
      const queryId = `q-market-${market}-${asked}`
      texts[queryId] = `${['best homes', 'pet friendly homes', 'luxury homes', 'homes with parking'][asked]} in market ${market}`
      for (let offset = 0; offset < 4; offset++) pairings.push({ queryId, targetKey: targets[(market + offset) % locations]![0], queryClass: 'non-brand' })
    }
  }
  for (let extra = 0; Object.keys(texts).length < 940; extra++) {
    const queryId = `q-pick-${extra}`
    texts[queryId] = `homes near transit option ${extra}`
    pairings.push({ queryId, targetKey: targets[extra % locations]![0], queryClass: 'non-brand' })
  }
  return { targets, texts, pairings }
}
