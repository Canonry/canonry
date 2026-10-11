import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq, getTableName, type Table } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildSimpleMeasurementDefinition,
  canonicalMeasurementPlanJson,
  canonicalMeasurementPlanV2Json,
  canonicalSimpleMeasurementDefinitionJson,
  compileMeasurementPlan,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  parseStoredMeasurementPlanAnyVersion,
  queryTrackingResultsResponseSchema,
  queryTrackingWorkspaceResponseSchema,
  RunKinds,
  RunStatuses,
  RunTriggers,
  type MeasurementPlanV2,
  type QueryTrackingEngineResult,
  type QueryTrackingResultsResponse,
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
  simpleMeasurementDefinitions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'

// Counts every stored-plan parse the read makes. The function itself is unchanged.
vi.mock('@ainyc/canonry-contracts', async importOriginal => {
  const actual = await importOriginal<typeof import('@ainyc/canonry-contracts')>()
  return { ...actual, parseStoredMeasurementPlanAnyVersion: vi.fn(actual.parseStoredMeasurementPlanAnyVersion) }
})

const NOW = '2026-10-09T00:00:00.000Z'
const FIRST_SWEEP = '2026-10-05T12:00:00.000Z'
const LAST_SWEEP = '2026-10-07T12:00:00.000Z'
const LATER = '2026-10-08T12:00:00.000Z'
const PROJECT = 'northbridge'
const PROJECT_ID = 'project-northbridge'
const ROOT_KEY = 'cnry_tracking_results_root'
const READ_KEY = 'cnry_tracking_results_read'
const ENGINES = ['claude', 'gemini', 'openai'] as const
type Engine = typeof ENGINES[number]
const MODELS = { claude: 'claude-test', gemini: 'gemini-test', openai: 'gpt-test' }
const RIVERSIDE = { label: 'riverside', city: 'Riverside', region: 'EX', country: 'US' }
const LAKESIDE = { label: 'lakeside', city: 'Lakeside', region: 'EX', country: 'US' }
type SearchLocation = typeof RIVERSIDE

const MARKET_TEXT = 'best homes in uptown'
const HARBOR_TEXT = 'Harbor Point reviews'
const PARKING_TEXT = 'homes with covered parking'
/** What an engine cites when it cites nobody tracked. */
const OTHER_SOURCE = 'https://listings.example/uptown'

let directory: string
let db: DatabaseClient
let app: FastifyInstance

type Pairing = {
  queryId: string
  targetKey: string
  queryClass: 'branded' | 'non-brand'
  market?: string
  /** The search location of the pairing's execution. Riverside unless named. */
  at?: SearchLocation
}

const TARGETS: ReadonlyArray<readonly [stableKey: string, label: string]> = [
  ['harbor', 'Harbor Point'], ['cedar', 'Cedar Court'], ['maple', 'Maple Row'],
]
const TEXTS: Readonly<Record<string, string>> = { 'q-market': MARKET_TEXT, 'q-harbor': HARBOR_TEXT, 'q-parking': PARKING_TEXT }
/**
 * Three locations and three queries:
 * - `q-market` is Uptown's market query, asked once for Harbor and Cedar.
 * - `q-harbor` is Harbor's own Branded query.
 * - `q-parking` is hand-picked: Branded for Harbor and Non-brand for Maple, on one execution.
 */
const PAIRINGS: readonly Pairing[] = [
  { queryId: 'q-market', targetKey: 'harbor', queryClass: 'non-brand', market: 'uptown' },
  { queryId: 'q-market', targetKey: 'cedar', queryClass: 'non-brand', market: 'uptown' },
  { queryId: 'q-harbor', targetKey: 'harbor', queryClass: 'branded', market: 'uptown' },
  { queryId: 'q-parking', targetKey: 'harbor', queryClass: 'branded' },
  { queryId: 'q-parking', targetKey: 'maple', queryClass: 'non-brand' },
]

function nodeKey(pairing: Pick<Pairing, 'queryId' | 'at'>): string {
  return `n-${pairing.queryId}-${(pairing.at ?? RIVERSIDE).label}`
}

function planOf(input: {
  targets?: ReadonlyArray<readonly [stableKey: string, label: string]>
  texts?: Readonly<Record<string, string>>
  pairings?: readonly Pairing[]
  groups?: ReadonlyArray<{ stableKey: string; label: string; targetKeys: string[] }>
} = {}): MeasurementPlanV2 {
  const texts = input.texts ?? TEXTS
  const pairings = input.pairings ?? PAIRINGS
  const edge = (pairing: Pairing) => ({ executionNodeKey: nodeKey(pairing), targetKey: pairing.targetKey, queryId: pairing.queryId })
  const nodes = new Map(pairings.map(pairing => [nodeKey(pairing), pairing]))
  const markets = [...new Set(pairings.flatMap(pairing => pairing.market ? [pairing.market] : []))].sort()
  const provisional = measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'northbridge.example', ownedHosts: ['northbridge.example'], names: ['Northbridge'] } },
    targets: (input.targets ?? TARGETS).map(([stableKey, label]) => ({
      stableKey, label, aliases: [label],
      urlMatchers: [{ kind: 'prefix', host: 'northbridge.example', pathPrefix: `/${stableKey}`, pathCase: 'insensitive' }],
      mentionNotApplicable: false, discoveryIdentity: null,
    })),
    groups: (input.groups ?? [{ stableKey: 'east', label: 'East', targetKeys: ['cedar', 'maple'] }]).map(group => ({ ...group, competitors: [] })),
    querySnapshots: Object.entries(texts).map(([queryId, queryText]) => ({
      queryId, queryText, provenance: { source: 'manual', sourceId: null, capturedAt: NOW },
    })),
    assignments: pairings.map(pairing => ({ ...edge(pairing), queryClass: pairing.queryClass, classificationSource: 'server' })),
    executionNodes: [...nodes].map(([stableKey, pairing]) => ({
      stableKey, queryId: pairing.queryId, queryText: texts[pairing.queryId],
      context: { providers: [...ENGINES], models: MODELS, location: pairing.at ?? RIVERSIDE }, expectedSnapshots: ENGINES.length,
    })),
    usageEdges: pairings.map(edge),
    reportingScopes: markets.map(stableKey => ({
      stableKey, label: stableKey, kind: 'market', usageEdges: pairings.filter(pairing => pairing.market === stableKey).map(edge),
    })),
    compiledChecksum: '0'.repeat(64),
  })
  const compiledChecksum = crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(provisional)).digest('hex')
  return measurementPlanV2Schema.parse({ ...provisional, compiledChecksum })
}

function seedVersion(revision: number, plan: MeasurementPlanV2, comparableToVersionId: string | null = null): string {
  const id = `plan-v${revision}`
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.insert(measurementPlanVersions).values({
    id, projectId: PROJECT_ID, revision, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, comparableToVersionId, createdAt: NOW,
  }).run()
  return id
}

function activate(versionId: string): void {
  db.insert(measurementPlans).values({ projectId: PROJECT_ID, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW })
    .onConflictDoUpdate({ target: measurementPlans.projectId, set: { activeVersionId: versionId, updatedAt: NOW } }).run()
}

/** Publishes `plan` as revision 1 with its catalog rows, as setup leaves a portfolio. */
function seedPortfolio(plan = planOf()): { versionId: string; plan: MeasurementPlanV2 } {
  const versionId = seedVersion(1, plan)
  activate(versionId)
  db.insert(queries).values(plan.querySnapshots.map(row => ({
    id: row.queryId, projectId: PROJECT_ID, query: row.queryText, provenance: null, createdAt: NOW,
  }))).run()
  return { versionId, plan }
}

/** One engine's stored answer. Omit the slot's answer to leave it missing. */
type Answer = { text: string | null; cites?: string[]; capture?: 'complete' | 'partial' }
type Answers = (slot: { queryId: string; provider: Engine; at: string }) => Answer | undefined

const says = (text: string, cites: string[] = [OTHER_SOURCE]): Answer => ({ text, cites })
/** An answer that names and cites nobody tracked: a checked no for both signals. */
const nobody = says('Several other communities nearby are worth a look.')

function seedSweep(input: {
  versionId: string
  plan: MeasurementPlanV2
  createdAt: string
  answers: Answers
  status?: string
  trigger?: string
  measurementScope?: { groups: string[]; targets: string[]; queries: string[]; resolvedTargets: string[] }
}): string {
  const id = crypto.randomUUID()
  const manifest = buildMeasurementPlanV2Manifest(input.plan)
  db.insert(runs).values({
    id, projectId: PROJECT_ID, kind: RunKinds['answer-visibility'],
    status: input.status ?? RunStatuses.completed, trigger: input.trigger ?? RunTriggers.manual,
    measurementPlanVersionId: input.versionId, measurementManifest: manifest,
    ...(input.measurementScope === undefined ? {} : { measurementScope: input.measurementScope }),
    finishedAt: input.createdAt, createdAt: input.createdAt,
  }).run()
  const nodes = new Map(input.plan.executionNodes.map(node => [node.stableKey, node]))
  const rows: Array<typeof querySnapshots.$inferInsert> = []
  for (const slot of manifest.expectedSlots) {
    const node = nodes.get(slot.executionId)!
    const location = node.context.location!
    const answer = input.answers({ queryId: node.queryId, provider: slot.provider as Engine, at: location.label })
    if (answer === undefined) continue
    rows.push({
      id: crypto.randomUUID(), runId: id, queryId: null, queryText: slot.queryText, provider: slot.provider,
      citationState: 'not-cited', answerMentioned: null, answerText: answer.text,
      citedDomains: [], citedUrls: answer.cites ?? [], captureStatus: answer.capture ?? 'complete',
      competitorOverlap: [], recommendedCompetitors: [],
      location: location.label, measurementExecutionId: slot.executionId,
      requestedContext: location, supportedContext: { status: 'applied', resolved: location },
      createdAt: input.createdAt,
    })
  }
  for (let start = 0; start < rows.length; start += 400) db.insert(querySnapshots).values(rows.slice(start, start + 400)).run()
  return id
}

function request(method: 'GET' | 'POST', suffix: string, payload?: unknown, key = ROOT_KEY) {
  return app.inject({
    method, url: `/api/v1/projects/${PROJECT}${suffix}`,
    headers: { authorization: `Bearer ${key}` },
    ...(payload === undefined ? {} : { payload }),
  })
}

async function results(query = ''): Promise<QueryTrackingResultsResponse> {
  const response = await request('GET', `/query-tracking/results${query ? `?${query}` : ''}`)
  expect(response.statusCode, response.body).toBe(200)
  // The strict schema fails this read on any field the contract does not name.
  return queryTrackingResultsResponseSchema.parse(response.json())
}

async function refused(query: string) {
  const response = await request('GET', `/query-tracking/results?${query}`)
  expect(response.statusCode, response.body).toBe(400)
  return (response.json() as { error: { code: string; message: string; details?: unknown } }).error
}

async function workspace() {
  const response = await request('GET', '/query-tracking')
  expect(response.statusCode, response.body).toBe(200)
  return queryTrackingWorkspaceResponseSchema.parse(response.json())
}

/** Publishes one reviewed change through the real preview and commit routes. No sweep follows. */
async function publish(mutation: { additions?: unknown[]; removals?: unknown[]; edits?: unknown[] }): Promise<void> {
  const payload = {
    expectedWorkspaceVersion: (await workspace()).workspaceVersion,
    additions: mutation.additions ?? [], removals: mutation.removals ?? [],
    ...(mutation.edits ? { edits: mutation.edits } : {}),
  }
  const preview = await request('POST', '/query-tracking/preview', payload)
  expect(preview.statusCode, preview.body).toBe(200)
  const { previewToken, reviewedAt } = preview.json() as { previewToken: string; reviewedAt: string }
  const commit = await request('POST', '/query-tracking/commit', { ...payload, previewToken, reviewedAt })
  expect(commit.statusCode, commit.body).toBe(200)
  expect((commit.json() as { committed: boolean }).committed).toBe(true)
}

function rowOf(body: QueryTrackingResultsResponse, queryId: string, queryClass: string) {
  return body.rows.find(row => row.queryId === queryId && row.queryClass === queryClass)
}

function engine(body: QueryTrackingResultsResponse, queryId: string, queryClass: string, provider: Engine): QueryTrackingEngineResult {
  const found = rowOf(body, queryId, queryClass)?.engines.find(entry => entry.provider === provider)
  if (!found) throw new Error(`No ${provider} result for ${queryId} (${queryClass})`)
  return found
}

function rowKeys(body: QueryTrackingResultsResponse): string[] {
  return body.rows.map(row => `${row.queryId} ${row.queryClass}`)
}

/** Table names of every `select().from()` the routes run. */
function recordReads(): string[] {
  const reads: string[] = []
  const select = db.select.bind(db) as (...args: unknown[]) => { from: (table: Table) => unknown }
  vi.spyOn(db, 'select').mockImplementation(((...args: unknown[]) => {
    const builder = select(...args)
    const from = builder.from.bind(builder)
    builder.from = (table: Table) => {
      reads.push(getTableName(table))
      return from(table)
    }
    return builder
  }) as typeof db.select)
  return reads
}

const count = (reads: readonly string[], table: string) => reads.filter(name => name === table).length

/**
 * The seeded sweep:
 * - `q-market`: Claude names Harbor and cites nobody tracked, Gemini names nobody and cites Cedar's page, OpenAI never answered.
 * - `q-harbor`: every engine names Harbor and cites its page.
 * - `q-parking`: every engine names Maple, the Non-brand location, and never Harbor, the Branded one.
 */
const SWEEP: Answers = ({ queryId, provider }) => {
  if (queryId === 'q-market') {
    if (provider === 'claude') return says('Harbor Point is a strong option in Uptown.')
    if (provider === 'gemini') return says('A few communities are worth a look.', ['https://northbridge.example/cedar/floor-plans'])
    return undefined
  }
  if (queryId === 'q-harbor') return says('Harbor Point gets good reviews.', ['https://northbridge.example/harbor/reviews'])
  return says('Maple Row has covered parking.')
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-tracking-results-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: PROJECT_ID, name: PROJECT, displayName: 'Northbridge', canonicalDomain: 'northbridge.example',
    ownedDomains: [], aliases: [], country: 'US', language: 'en', providers: [...ENGINES], providerModels: MODELS,
    locations: [RIVERSIDE], defaultLocation: 'riverside', createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(apiKeys).values([
    { id: crypto.randomUUID(), name: 'root', keyHash: hashApiKey(ROOT_KEY), keyPrefix: ROOT_KEY.slice(0, 9), scopes: ['*'], projectId: null, createdAt: NOW },
    { id: crypto.randomUUID(), name: 'reader', keyHash: hashApiKey(READ_KEY), keyPrefix: READ_KEY.slice(0, 9), scopes: ['read'], projectId: PROJECT_ID, createdAt: NOW },
  ]).run()
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

describe('query tracking results: one sweep, every tracked query', () => {
  it('returns exact counts and both signals for a query three engines were asked', async () => {
    const { versionId, plan } = seedPortfolio()
    const runId = seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })

    const body = await results()
    expect(body).toMatchObject({
      mode: 'advanced',
      scope: { kind: 'project', key: null },
      run: { id: runId, createdAt: LAST_SWEEP, completedAt: LAST_SWEEP, status: 'completed', revision: 1, matchesCurrentTracking: true },
      engines: ['claude', 'gemini', 'openai'],
      pendingRows: 0,
    })
    expect(rowKeys(body)).toEqual(['q-harbor branded', 'q-market non-brand', 'q-parking branded', 'q-parking non-brand'])
    expect(rowOf(body, 'q-market', 'non-brand')).toStrictEqual({
      queryId: 'q-market', queryText: MARKET_TEXT, queryClass: 'non-brand',
      engines: [
        // Named in the answer and checked sources cite nobody tracked: a mention never sets cited.
        { provider: 'claude', expectedAnswers: 1, answers: 1, mentionedAnswers: 1, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: true, cited: false },
        // Cited without being named: a citation never sets mentioned.
        { provider: 'gemini', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 1, uncheckedSourceAnswers: 0, mentioned: false, cited: true },
        // No answer was saved, so neither signal was checked. Null is not a no.
        { provider: 'openai', expectedAnswers: 1, answers: 0, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: null, cited: null },
      ],
    })
    for (const provider of ENGINES) {
      expect(engine(body, 'q-harbor', 'branded', provider)).toStrictEqual({
        provider, expectedAnswers: 1, answers: 1, mentionedAnswers: 1, citedAnswers: 1, uncheckedSourceAnswers: 0, mentioned: true, cited: true,
      })
    }
  })

  it('keeps the Branded and Non-brand rows of one query apart', async () => {
    const { versionId, plan } = seedPortfolio()
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })

    const body = await results()
    // One execution answered for both locations. The answers name Maple only,
    // so the Non-brand row is mentioned and the Branded row, Harbor's, is not.
    for (const provider of ENGINES) {
      expect(engine(body, 'q-parking', 'non-brand', provider)).toMatchObject({ expectedAnswers: 1, answers: 1, mentionedAnswers: 1, mentioned: true, cited: false })
      expect(engine(body, 'q-parking', 'branded', provider)).toMatchObject({ expectedAnswers: 1, answers: 1, mentionedAnswers: 0, mentioned: false, cited: false })
    }
  })

  it('counts one answer per search location and says no only when every one was checked', async () => {
    const pairings: Pairing[] = [RIVERSIDE, LAKESIDE].map(at => ({ queryId: 'q-harbor', targetKey: 'harbor', queryClass: 'branded', at }))
    const { versionId, plan } = seedPortfolio(planOf({ texts: { 'q-harbor': HARBOR_TEXT }, pairings }))
    const harborPage = 'https://northbridge.example/harbor/reviews'
    seedSweep({
      versionId, plan, createdAt: LAST_SWEEP,
      answers: ({ provider, at }) => {
        if (provider === 'claude') return says('Harbor Point gets good reviews.', [harborPage])
        // Neither answer names Harbor. One answer's sources were only partly
        // saved, and the link that was saved cites Harbor's page.
        if (provider === 'gemini') return at === 'riverside' ? { ...nobody, cites: [harborPage], capture: 'partial' } : nobody
        // One checked no and one answer never saved.
        return at === 'riverside' ? nobody : undefined
      },
    })

    const body = await results()
    expect(rowKeys(body)).toEqual(['q-harbor branded'])
    expect(rowOf(body, 'q-harbor', 'branded')!.engines).toStrictEqual([
      { provider: 'claude', expectedAnswers: 2, answers: 2, mentionedAnswers: 2, citedAnswers: 2, uncheckedSourceAnswers: 0, mentioned: true, cited: true },
      // Both texts were read, so not mentioned is a checked no. The partly
      // saved sources leave the citation not checked, whatever they held.
      { provider: 'gemini', expectedAnswers: 2, answers: 2, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 1, mentioned: false, cited: null },
      { provider: 'openai', expectedAnswers: 2, answers: 1, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: null, cited: null },
    ])
  })

  it('reads a place against the active plan and counts only the locations a row covers there', async () => {
    const { versionId, plan } = seedPortfolio()
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })

    // Cedar's own rows: the market query alone. Claude named Harbor, which is
    // not Cedar, so here the same answer is a checked no.
    const cedar = await results('scope=property&scopeKey=cedar')
    expect(cedar.scope).toEqual({ kind: 'property', key: 'cedar' })
    expect(rowKeys(cedar)).toEqual(['q-market non-brand'])
    expect(engine(cedar, 'q-market', 'non-brand', 'claude')).toMatchObject({ mentionedAnswers: 0, mentioned: false, cited: false })
    expect(engine(cedar, 'q-market', 'non-brand', 'gemini')).toMatchObject({ mentioned: false, citedAnswers: 1, cited: true })

    const harbor = await results('scope=property&scopeKey=harbor')
    expect(rowKeys(harbor)).toEqual(['q-harbor branded', 'q-market non-brand', 'q-parking branded'])
    expect(engine(harbor, 'q-market', 'non-brand', 'claude')).toMatchObject({ mentionedAnswers: 1, mentioned: true })
    // Gemini cited Cedar's page, not Harbor's.
    expect(engine(harbor, 'q-market', 'non-brand', 'gemini')).toMatchObject({ citedAnswers: 0, cited: false })

    // A group selects its locations' pairings; a market selects its exact edges.
    expect(rowKeys(await results('scope=group&scopeKey=east'))).toEqual(['q-market non-brand', 'q-parking non-brand'])
    expect(rowKeys(await results('scope=market&scopeKey=uptown'))).toEqual(['q-harbor branded', 'q-market non-brand'])
  })

  it('reads the newest whole-project sweep and never a probe, a scoped run or an unfinished one', async () => {
    const { versionId, plan } = seedPortfolio()
    const older = seedSweep({ versionId, plan, createdAt: FIRST_SWEEP, answers: () => nobody })
    const sweep = seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })
    const everyoneNamed: Answers = () => says('Harbor Point, Cedar Court and Maple Row.')
    const probe = seedSweep({ versionId, plan, createdAt: LATER, answers: everyoneNamed, trigger: RunTriggers.probe })
    const scoped = seedSweep({
      versionId, plan, createdAt: LATER, answers: everyoneNamed,
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
    })
    for (const status of [RunStatuses.queued, RunStatuses.running, RunStatuses.failed, RunStatuses.cancelled]) {
      seedSweep({ versionId, plan, createdAt: LATER, answers: everyoneNamed, status })
    }

    const body = await results()
    expect(body.run?.id).toBe(sweep)
    expect(engine(body, 'q-market', 'non-brand', 'gemini').mentioned).toBe(false)

    // An older whole-project sweep is readable by id; a partial one is a sweep too.
    db.update(runs).set({ status: RunStatuses.partial }).where(eq(runs.id, older)).run()
    const pinned = await results(`runId=${older}`)
    expect(pinned.run).toMatchObject({ id: older, status: 'partial', createdAt: FIRST_SWEEP })
    expect(engine(pinned, 'q-harbor', 'branded', 'claude')).toMatchObject({ mentioned: false, cited: false })

    for (const runId of [probe, scoped, 'no-such-run']) {
      expect((await refused(`runId=${runId}`)).message).toBe(`Run "${runId}" is not a completed whole-project sweep of this project.`)
    }
  })

  it('never reads a sweep of a schema-v1 plan, and refuses a project whose active plan is one', async () => {
    const { versionId, plan } = seedPortfolio()
    // An older plan format the reader cannot rebuild, with a sweep newer than any other.
    const v1Plan = compileMeasurementPlan({
      schemaVersion: 1,
      targets: [{ stableKey: 'harbor', label: 'Harbor Point', urls: [{ kind: 'host', host: 'northbridge.example' }], aliases: ['Harbor Point'] }],
      groups: [{ stableKey: 'east', label: 'East', targetKeys: ['harbor'], competitors: [] }],
      targetQuerySelections: [{ targetKey: 'harbor', queryIds: ['q-harbor'] }],
    }, {
      canonicalDomain: 'northbridge.example', ownedDomains: [], brandNames: ['Northbridge'],
      trackedQueries: [{ id: 'q-harbor', query: HARBOR_TEXT }], locations: [], defaultContext: null, expectedSnapshots: 1,
    })
    db.insert(measurementPlanVersions).values({
      id: 'plan-v0', projectId: PROJECT_ID, revision: 7, canonicalJson: canonicalMeasurementPlanJson(v1Plan),
      checksum: 'b'.repeat(64), schemaVersion: 1, createdAt: NOW,
    }).run()
    const v1Run = crypto.randomUUID()
    db.insert(runs).values({
      id: v1Run, projectId: PROJECT_ID, kind: RunKinds['answer-visibility'], status: RunStatuses.completed, trigger: RunTriggers.manual,
      measurementPlanVersionId: 'plan-v0', finishedAt: LATER, createdAt: LATER,
    }).run()

    expect(await results()).toMatchObject({ run: null, rows: [], pendingRows: 4 })
    expect((await refused(`runId=${v1Run}`)).message).toBe(`Run "${v1Run}" is not a completed whole-project sweep of this project.`)
    const sweep = seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })
    expect((await results()).run?.id).toBe(sweep)

    activate('plan-v0')
    expect((await refused('scope=project')).message).toBe('Query tracking requires a schema-v2 measurement plan. Republish setup before reading query results.')
  })

  it('answers 200 with no run and no rows before the first sweep', async () => {
    seedPortfolio()
    expect(await results()).toStrictEqual({
      mode: 'advanced', scope: { kind: 'project', key: null }, run: null, engines: [], rows: [],
      // Four query and class pairs are asked and none was measured.
      pendingRows: 4,
    })
    expect(await results('scope=property&scopeKey=maple')).toMatchObject({ run: null, rows: [], pendingRows: 1 })
  })

  it('lets a read-only key read and refuses a malformed selection', async () => {
    const { versionId, plan } = seedPortfolio()
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })
    const response = await request('GET', '/query-tracking/results', undefined, READ_KEY)
    expect(response.statusCode, response.body).toBe(200)
    expect((response.json() as QueryTrackingResultsResponse).rows).toHaveLength(4)

    expect((await refused('scope=property')).code).toBe('VALIDATION_ERROR')
    expect((await refused('scope=project&scopeKey=harbor')).code).toBe('VALIDATION_ERROR')
    expect((await refused('scope=region&scopeKey=harbor')).code).toBe('VALIDATION_ERROR')
    expect((await refused('queryClass=branded')).code).toBe('VALIDATION_ERROR')
    expect((await request('GET', '/query-tracking/results', undefined, 'cnry_not_a_key')).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/no-such-project/query-tracking/results', headers: { authorization: `Bearer ${ROOT_KEY}` } })).statusCode).toBe(404)
  })
})

describe('query tracking results: tracking changed after the sweep', () => {
  it('drops a moved query until the next sweep and keeps every untouched row', async () => {
    const { versionId, plan } = seedPortfolio()
    const runId = seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })
    const before = await results()

    // Move Harbor's own query to Cedar: one removal plus one addition of the same text.
    await publish({
      removals: [{ queryId: 'q-harbor' }],
      additions: [{ input: { source: 'manual', text: HARBOR_TEXT }, audience: { targetKeys: ['cedar'], marketKeys: ['uptown'] }, queryClass: 'branded' }],
    })
    expect(db.select().from(runs).all()).toHaveLength(1)

    const after = await results()
    expect(after.run).toMatchObject({ id: runId, revision: 1, matchesCurrentTracking: false })
    expect(rowOf(after, 'q-harbor', 'branded')).toBeUndefined()
    expect(after.pendingRows).toBe(1)
    expect(after.rows).toStrictEqual(before.rows.filter(row => row.queryId !== 'q-harbor'))
    expect(after.engines).toEqual(before.engines)

    // The move is pending where the query is asked now, and gone from where it was.
    expect(await results('scope=property&scopeKey=cedar')).toMatchObject({ pendingRows: 1, rows: [{ queryId: 'q-market' }] })
    const harbor = await results('scope=property&scopeKey=harbor')
    expect(harbor.pendingRows).toBe(0)
    expect(rowKeys(harbor)).toEqual(['q-market non-brand', 'q-parking branded'])
  })

  it('drops the old class row after a type change', async () => {
    const { versionId, plan } = seedPortfolio()
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })

    await publish({ edits: [{ queryId: 'q-harbor', queryClass: 'non-brand' }] })

    const body = await results()
    expect(body.run?.matchesCurrentTracking).toBe(false)
    // The sweep asked it as Branded. Neither that row nor a Non-brand one exists yet.
    expect(body.rows.filter(row => row.queryId === 'q-harbor')).toEqual([])
    expect(body.pendingRows).toBe(1)
    expect(rowKeys(body)).toEqual(['q-market non-brand', 'q-parking branded', 'q-parking non-brand'])
  })

  it('drops a reworded query, and withholds a market row once the market grows', async () => {
    const { versionId, plan } = seedPortfolio()
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })

    await publish({ edits: [{ queryId: 'q-harbor', text: 'Harbor Point resident reviews' }] })
    expect(rowKeys(await results())).toEqual(['q-market non-brand', 'q-parking branded', 'q-parking non-brand'])

    // Revision 3 also asks the market query for Maple. The sweep measured it
    // for Harbor and Cedar: those places keep their row, the whole project waits.
    const active = parseStoredMeasurementPlanAnyVersion(db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.revision, 2)).get()!.canonicalJson) as MeasurementPlanV2
    const marketNode = active.executionNodes.find(node => node.queryId === 'q-market')!.stableKey
    const grownEdge = { executionNodeKey: marketNode, targetKey: 'maple', queryId: 'q-market' }
    const grown = measurementPlanV2Schema.parse({
      ...active,
      assignments: [...active.assignments, { ...grownEdge, queryClass: 'non-brand', classificationSource: 'server' }],
      usageEdges: [...active.usageEdges, grownEdge],
      reportingScopes: active.reportingScopes!.map(market => ({ ...market, usageEdges: [...market.usageEdges, grownEdge] })),
    })
    activate(seedVersion(3, grown))

    const project = await results()
    expect(rowKeys(project)).toEqual(['q-parking branded', 'q-parking non-brand'])
    expect(project.pendingRows).toBe(2)
    expect(await results('scope=property&scopeKey=cedar')).toMatchObject({ pendingRows: 0, rows: [{ queryId: 'q-market', queryClass: 'non-brand' }] })
    expect(await results('scope=property&scopeKey=maple')).toMatchObject({ pendingRows: 1, rows: [{ queryId: 'q-parking', queryClass: 'non-brand' }] })
  })

  it('keeps every row and matchesCurrentTracking after a label-only republish', async () => {
    const { versionId, plan } = seedPortfolio()
    const runId = seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })
    const before = await results()

    // Publish records the link when a republish changes nothing a sweep asks: here, one label.
    const relabelled = measurementPlanV2Schema.parse({
      ...plan,
      targets: plan.targets.map(target => target.stableKey === 'maple' ? { ...target, label: 'Maple Row Homes' } : target),
    })
    activate(seedVersion(2, relabelled, versionId))

    const after = await results()
    expect(after.run).toMatchObject({ id: runId, revision: 1, matchesCurrentTracking: true })
    expect(after.pendingRows).toBe(0)
    expect(after.rows).toStrictEqual(before.rows)
  })

  it('reads the newest sweep comparable to the active plan before a newer sweep of another plan', async () => {
    const { versionId, plan } = seedPortfolio()
    const comparable = seedSweep({ versionId, plan, createdAt: FIRST_SWEEP, answers: SWEEP })
    const before = await results()

    // Revision 2 rewords a query, which a sweep asks, and is swept later.
    const reworded = planOf({ texts: { ...TEXTS, 'q-harbor': 'Harbor Point resident reviews' } })
    const rewordedId = seedVersion(2, reworded)
    activate(rewordedId)
    const newer = seedSweep({ versionId: rewordedId, plan: reworded, createdAt: LAST_SWEEP, answers: () => nobody })
    expect((await results()).run).toMatchObject({ id: newer, revision: 2, matchesCurrentTracking: true })

    // Revision 3 asks what revision 1 asked, with one label changed, and is linked to it.
    const relabelled = measurementPlanV2Schema.parse({
      ...plan,
      targets: plan.targets.map(target => target.stableKey === 'maple' ? { ...target, label: 'Maple Row Homes' } : target),
    })
    activate(seedVersion(3, relabelled, versionId))

    const after = await results()
    expect(after.run).toMatchObject({ id: comparable, createdAt: FIRST_SWEEP, revision: 1, matchesCurrentTracking: true })
    expect(after.pendingRows).toBe(0)
    expect(after.rows).toStrictEqual(before.rows)
  })

  it('withholds every row once a model changed on every execution', async () => {
    const { versionId, plan } = seedPortfolio()
    const runId = seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })

    const remodelled = measurementPlanV2Schema.parse({
      ...plan,
      executionNodes: plan.executionNodes.map(node => ({ ...node, context: { ...node.context, models: { ...MODELS, openai: 'gpt-next' } } })),
    })
    activate(seedVersion(2, remodelled))

    const body = await results()
    expect(body.run).toMatchObject({ id: runId, revision: 1, matchesCurrentTracking: false })
    expect(body.rows).toEqual([])
    expect(body.pendingRows).toBe(4)
    // The engines are the sweep's own.
    expect(body.engines).toEqual(['claude', 'gemini', 'openai'])
  })

  it('returns no rows for a location added after the sweep and refuses a place in neither plan', async () => {
    const { versionId, plan } = seedPortfolio()
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })
    const withBirch = planOf({
      targets: [...TARGETS, ['birch', 'Birch Lane']],
      texts: { ...TEXTS, 'q-birch': 'Birch Lane reviews' },
      pairings: [...PAIRINGS, { queryId: 'q-birch', targetKey: 'birch', queryClass: 'branded', market: 'midtown' }],
      groups: [{ stableKey: 'east', label: 'East', targetKeys: ['cedar', 'maple'] }, { stableKey: 'north', label: 'North', targetKeys: ['birch'] }],
    })
    activate(seedVersion(2, withBirch))

    for (const place of ['scope=property&scopeKey=birch', 'scope=group&scopeKey=north', 'scope=market&scopeKey=midtown']) {
      const body = await results(place)
      expect(body.run).toMatchObject({ revision: 1, matchesCurrentTracking: false })
      expect(body.rows, place).toEqual([])
      expect(body.pendingRows, place).toBe(1)
    }
    // Every other pairing is signed as the sweep asked it, so its row is still there.
    expect(await results()).toMatchObject({ pendingRows: 1, rows: [{ queryId: 'q-harbor' }, { queryId: 'q-market' }, { queryId: 'q-parking' }, { queryId: 'q-parking' }] })

    expect(await refused('scope=property&scopeKey=elm')).toMatchObject({
      message: 'Location "elm" is not in the active plan.',
      details: { reason: 'retired-scope', kind: 'property', key: 'elm' },
    })
    expect((await refused('scope=group&scopeKey=west')).message).toBe('Group "west" is not in the active plan.')
    expect((await refused('scope=market&scopeKey=downtown')).message).toBe('Market "downtown" is not in the active plan.')
  })

  it('carries only classes the workspace row carries', async () => {
    const { versionId, plan } = seedPortfolio()
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })
    await publish({ edits: [{ queryId: 'q-harbor', queryClass: 'non-brand' }] })

    const classes = new Map((await workspace()).tracked.map(row => [row.queryId, row.queryClasses ?? []]))
    const body = await results()
    expect(body.rows.length).toBeGreaterThan(0)
    for (const row of body.rows) {
      expect(classes.get(row.queryId), `${row.queryId} ${row.queryClass}`).toContain(row.queryClass)
    }
    // Both classes of the mixed query are rows; neither is merged into the other.
    expect(classes.get('q-parking')).toEqual(['branded', 'non-brand'])
    expect(body.rows.filter(row => row.queryId === 'q-parking').map(row => row.queryClass)).toEqual(['branded', 'non-brand'])
  })
})

describe('query tracking results: a simple project', () => {
  // What the project dispatches in `beforeEach`: its three engines, their models and its search location.
  const CAPTURED = { capturedAt: LAST_SWEEP, country: 'US', language: 'en', location: RIVERSIDE }
  const AS_SWEPT = { providers: [...ENGINES], providerModels: MODELS, locations: [RIVERSIDE], defaultLocation: 'riverside', country: 'US', language: 'en', aliases: [] as string[] }
  /** One answer per engine for each query, so the workspace counts the query as swept. */
  const everyEngine = (rows: ReadonlyArray<readonly [id: string, text: string]>, engines: readonly Engine[] = ENGINES, answer = 'Northbridge.') => (
    engines.flatMap(provider => rows.map(([queryId, text]) => ({ queryId, text, provider, answer })))
  )
  const states = async () => (await workspace()).tracked.map(row => row.state)

  function seedSimpleQueries(rows: ReadonlyArray<readonly [id: string, text: string]>): void {
    db.insert(queries).values(rows.map(([id, text]) => ({ id, projectId: PROJECT_ID, query: text, createdAt: NOW }))).run()
  }

  /**
   * A planless sweep. With `frozen` it carries the definition a sweep captures today; without, it is older history.
   * `engines` and `location` are what this run was sent with when that is not what the project dispatches.
   */
  function seedSimpleSweep(input: {
    createdAt: string
    frozen?: ReadonlyArray<readonly [id: string, text: string]>
    engines?: readonly Engine[]
    location?: SearchLocation | null
    /** The query texts a run of only some queries was asked for; a sweep of the whole list stores none. */
    only?: readonly string[]
    answers: ReadonlyArray<{ queryId: string; text: string; provider: Engine; answer: string; cited?: boolean; mentioned?: boolean | null }>
  }): string {
    const id = crypto.randomUUID()
    db.insert(runs).values({
      id, projectId: PROJECT_ID, kind: RunKinds['answer-visibility'], status: RunStatuses.completed, trigger: RunTriggers.manual,
      finishedAt: input.createdAt, createdAt: input.createdAt, queries: input.only ? [...input.only] : null,
    }).run()
    if (input.frozen) {
      const definition = buildSimpleMeasurementDefinition({
        ...CAPTURED,
        ...(input.location === undefined ? {} : { location: input.location }),
        identity: { displayName: 'Northbridge', aliases: [], canonicalDomain: 'northbridge.example', ownedDomains: [] },
        engines: (input.engines ?? ENGINES).map(provider => ({ provider, requestedModel: MODELS[provider] })),
        queries: input.frozen.map(([queryId, queryText]) => ({ queryId, queryText, provenance: 'manual' })),
      })
      db.insert(simpleMeasurementDefinitions).values({
        runId: id, projectId: PROJECT_ID, definition,
        checksum: crypto.createHash('sha256').update(canonicalSimpleMeasurementDefinitionJson(definition)).digest('hex'),
        capturedAt: input.createdAt,
      }).run()
    }
    db.insert(querySnapshots).values(input.answers.map(answer => ({
      id: crypto.randomUUID(), runId: id, queryId: answer.queryId, queryText: answer.text, provider: answer.provider,
      model: input.frozen ? MODELS[answer.provider] : null,
      citationState: answer.cited ? 'cited' : 'not-cited', answerMentioned: answer.mentioned ?? null, answerText: answer.answer,
      citedDomains: answer.cited ? ['northbridge.example'] : [], citedUrls: [], captureStatus: 'complete',
      competitorOverlap: [], recommendedCompetitors: [], location: null, createdAt: input.createdAt,
    }))).run()
    return id
  }

  const BRAND_QUERY = ['q-brand', 'northbridge reviews'] as const
  const CATEGORY_QUERY = ['q-category', 'best home builders'] as const

  it('folds the frozen sweep with the same rule, one row per query under the class it carries', async () => {
    seedSimpleQueries([BRAND_QUERY, CATEGORY_QUERY])
    const runId = seedSimpleSweep({
      createdAt: LAST_SWEEP, frozen: [BRAND_QUERY, CATEGORY_QUERY],
      answers: [
        { queryId: 'q-brand', text: BRAND_QUERY[1], provider: 'claude', answer: 'Northbridge is well reviewed.', cited: true },
        { queryId: 'q-brand', text: BRAND_QUERY[1], provider: 'gemini', answer: 'Reviews are mixed for most builders.' },
        { queryId: 'q-category', text: CATEGORY_QUERY[1], provider: 'claude', answer: 'Several builders stand out.', cited: true },
        { queryId: 'q-category', text: CATEGORY_QUERY[1], provider: 'gemini', answer: 'Northbridge and others.' },
        { queryId: 'q-category', text: CATEGORY_QUERY[1], provider: 'openai', answer: 'Several builders stand out.' },
      ],
    })

    const body = await results()
    expect(body).toMatchObject({
      mode: 'simple', scope: { kind: 'project', key: null }, engines: ['claude', 'gemini', 'openai'], pendingRows: 0,
      run: { id: runId, status: 'completed', revision: null, matchesCurrentTracking: true },
    })
    expect(body.rows).toStrictEqual([
      {
        queryId: 'q-brand', queryText: BRAND_QUERY[1], queryClass: 'branded',
        engines: [
          { provider: 'claude', expectedAnswers: 1, answers: 1, mentionedAnswers: 1, citedAnswers: 1, uncheckedSourceAnswers: 0, mentioned: true, cited: true },
          { provider: 'gemini', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: false, cited: false },
          { provider: 'openai', expectedAnswers: 1, answers: 0, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: null, cited: null },
        ],
      },
      {
        queryId: 'q-category', queryText: CATEGORY_QUERY[1], queryClass: 'non-brand',
        engines: [
          // Cited and not named, then named and not cited: neither sets the other.
          { provider: 'claude', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 1, uncheckedSourceAnswers: 0, mentioned: false, cited: true },
          { provider: 'gemini', expectedAnswers: 1, answers: 1, mentionedAnswers: 1, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: true, cited: false },
          { provider: 'openai', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: false, cited: false },
        ],
      },
    ])
    const classes = new Map((await workspace()).tracked.map(row => [row.queryId, row.queryClasses ?? []]))
    for (const row of body.rows) expect(classes.get(row.queryId)).toEqual([row.queryClass])
  })

  it('drops a reworded or newly added query until the next sweep and has no place but the project', async () => {
    seedSimpleQueries([BRAND_QUERY, ['q-category', 'best custom home builders'], ['q-new', 'home builders with warranties']])
    seedSimpleSweep({
      createdAt: LAST_SWEEP, frozen: [BRAND_QUERY, CATEGORY_QUERY],
      answers: everyEngine([BRAND_QUERY, CATEGORY_QUERY]),
    })

    const body = await results()
    expect(rowKeys(body)).toEqual(['q-brand branded'])
    expect(body.pendingRows).toBe(2)
    expect(body.run?.matchesCurrentTracking).toBe(false)
    expect((await refused('scope=property&scopeKey=harbor')).message).toBe('Location "harbor" does not exist: a simple project is read as a whole.')
  })

  it('says tracking changed once a query the sweep asked is no longer tracked', async () => {
    seedSimpleQueries([BRAND_QUERY, CATEGORY_QUERY])
    seedSimpleSweep({ createdAt: LAST_SWEEP, frozen: [BRAND_QUERY, CATEGORY_QUERY], answers: everyEngine([BRAND_QUERY, CATEGORY_QUERY]) })
    expect((await results()).run?.matchesCurrentTracking).toBe(true)

    // Removing a query leaves its stored answers with no query id, as a real removal does.
    db.delete(queries).where(eq(queries.id, 'q-category')).run()
    expect(db.select().from(querySnapshots).all().filter(row => row.queryId === null)).toHaveLength(ENGINES.length)

    // Every tracked query has its row and nothing is pending, yet the sweep asked more than is tracked now.
    const body = await results()
    expect(rowKeys(body)).toEqual(['q-brand branded'])
    expect(body.pendingRows).toBe(0)
    expect(body.run?.matchesCurrentTracking).toBe(false)
  })

  it('withholds every row once the engines, a model, the search location, the country or the language changed, and keeps them after a new name', async () => {
    seedSimpleQueries([BRAND_QUERY, CATEGORY_QUERY])
    const runId = seedSimpleSweep({ createdAt: LAST_SWEEP, frozen: [BRAND_QUERY, CATEGORY_QUERY], answers: everyEngine([BRAND_QUERY, CATEGORY_QUERY]) })
    const set = (change: Partial<typeof projects.$inferInsert>) => (
      db.update(projects).set({ ...AS_SWEPT, ...change }).where(eq(projects.id, PROJECT_ID)).run()
    )

    const swept = await results()
    expect(swept.run).toMatchObject({ id: runId, matchesCurrentTracking: true })
    expect(rowKeys(swept)).toEqual(['q-brand branded', 'q-category non-brand'])
    expect(swept.pendingRows).toBe(0)
    expect(await states()).toEqual(['tracked', 'tracked'])

    const changes: ReadonlyArray<readonly [what: string, change: Partial<typeof projects.$inferInsert>]> = [
      ['an engine removed', { providers: ['claude', 'openai'] }],
      ['a model changed', { providerModels: { ...MODELS, openai: 'gpt-next' } }],
      ['the search location changed', { locations: [RIVERSIDE, LAKESIDE], defaultLocation: 'lakeside' }],
      ['the country changed', { country: 'CA' }],
      ['the language changed', { language: 'fr' }],
    ]
    for (const [what, change] of changes) {
      set(change)
      const body = await results()
      expect(body.run, what).toMatchObject({ id: runId, matchesCurrentTracking: false })
      expect(body.rows, what).toEqual([])
      expect(body.pendingRows, what).toBe(2)
      // The engines are the sweep's own, so a removed engine is still listed.
      expect(body.engines, what).toEqual(['claude', 'gemini', 'openai'])
      // The workspace marks the same queries the same way.
      expect(await states(), what).toEqual(['awaiting-sweep', 'awaiting-sweep'])
    }

    // A new name changes how an answer is read, not what the engines were sent:
    // the rows stay, and the read still says tracking changed.
    set({ aliases: ['Northbridge Homes'] })
    const renamed = await results()
    expect(renamed.run).toMatchObject({ id: runId, matchesCurrentTracking: false })
    expect(renamed.rows).toStrictEqual(swept.rows)
    expect(renamed.pendingRows).toBe(0)
    expect(await states()).toEqual(['awaiting-sweep', 'awaiting-sweep'])

    set({})
    expect(await results()).toStrictEqual(swept)
  })

  it('reads the newest sweep sent as the project sends now, never a newer run of one engine or another search location', async () => {
    db.update(projects).set({ locations: [RIVERSIDE, LAKESIDE] }).where(eq(projects.id, PROJECT_ID)).run()
    const tracked = [BRAND_QUERY, CATEGORY_QUERY]
    seedSimpleQueries(tracked)
    const full = seedSimpleSweep({ createdAt: FIRST_SWEEP, frozen: tracked, answers: everyEngine(tracked) })
    const swept = await results()
    expect(swept.run).toMatchObject({ id: full, matchesCurrentTracking: true })
    expect(rowKeys(swept)).toEqual(['q-brand branded', 'q-category non-brand'])
    expect(engine(swept, 'q-category', 'non-brand', 'gemini').mentioned).toBe(true)

    // Each newer run froze another dispatch. None changed the project, and none names it in an answer.
    const partial = (engines: readonly Engine[] = ENGINES) => everyEngine(tracked, engines, 'Several builders stand out.')
    const sends: ReadonlyArray<readonly [what: string, sent: { engines?: readonly Engine[]; location?: SearchLocation | null }]> = [
      ['one engine', { engines: ['openai'] }],
      ['another saved search location', { location: LAKESIDE }],
      ['no search location', { location: null }],
    ]
    const newer: string[] = []
    for (const [index, [what, sent]] of sends.entries()) {
      newer.push(seedSimpleSweep({ createdAt: `2026-10-07T1${index}:00:00.000Z`, frozen: tracked, ...sent, answers: partial(sent.engines) }))
      expect(await results(), what).toStrictEqual(swept)
      expect(await states(), what).toEqual(['tracked', 'tracked'])
    }

    // Named by id, such a run is read as it ran: nothing in it was asked as the project asks now.
    const oneEngine = await results(`runId=${newer[0]}`)
    expect(oneEngine.run).toMatchObject({ id: newer[0], matchesCurrentTracking: false })
    expect(oneEngine).toMatchObject({ engines: ['openai'], rows: [], pendingRows: 2 })
  })

  it('reads the sweep of the whole list, never a newer run of only some of the queries', async () => {
    const tracked = [BRAND_QUERY, CATEGORY_QUERY]
    seedSimpleQueries(tracked)
    const full = seedSimpleSweep({ createdAt: FIRST_SWEEP, frozen: tracked, answers: everyEngine(tracked) })
    const swept = await results()
    expect(swept.run).toMatchObject({ id: full, matchesCurrentTracking: true })

    // Same engines and search location, one query only: the engine's own idea of a scoped run.
    const some = seedSimpleSweep({
      createdAt: LAST_SWEEP, frozen: [BRAND_QUERY], only: [BRAND_QUERY[1]],
      answers: everyEngine([BRAND_QUERY], ENGINES, 'Several builders stand out.'),
    })
    expect(await results()).toStrictEqual(swept)
    expect(await states()).toEqual(['tracked', 'tracked'])

    // Named by id it is still read as it ran.
    expect((await results(`runId=${some}`)).run).toMatchObject({ id: some })

    // A store that stamps the list on every sweep has no whole-list sweep to prefer: the newest one sent as the project sends now is read.
    db.update(runs).set({ queries: tracked.map(([, text]) => text) }).where(eq(runs.id, full)).run()
    expect((await results()).run).toMatchObject({ id: some })
  })

  it('keeps the rows after a new name, even with a newer run of one engine', async () => {
    const tracked = [BRAND_QUERY, CATEGORY_QUERY]
    seedSimpleQueries(tracked)
    const full = seedSimpleSweep({ createdAt: FIRST_SWEEP, frozen: tracked, answers: everyEngine(tracked) })
    seedSimpleSweep({ createdAt: LAST_SWEEP, frozen: tracked, engines: ['openai'], answers: everyEngine(tracked, ['openai'], 'Several builders stand out.') })
    // The choice of sweep looks at what was sent to the engines, not at the project's names.
    db.update(projects).set({ displayName: 'Northbridge Homes' }).where(eq(projects.id, PROJECT_ID)).run()

    const renamed = await results()
    expect(renamed.run).toMatchObject({ id: full, matchesCurrentTracking: false })
    expect(rowKeys(renamed)).toEqual(['q-brand branded', 'q-category non-brand'])
    expect(renamed.pendingRows).toBe(0)
  })

  it('reads the default member of an all-locations run, and the newest sweep when none was sent as the project sends now', async () => {
    db.update(projects).set({ locations: [RIVERSIDE, LAKESIDE] }).where(eq(projects.id, PROJECT_ID)).run()
    const tracked = [BRAND_QUERY, CATEGORY_QUERY]
    seedSimpleQueries(tracked)
    seedSimpleSweep({ createdAt: FIRST_SWEEP, frozen: tracked, answers: everyEngine(tracked, ENGINES, 'Several builders stand out.') })
    // One run per saved search location. The other location's run happens to be the newest.
    const atDefault = seedSimpleSweep({ createdAt: LAST_SWEEP, frozen: tracked, location: RIVERSIDE, answers: everyEngine(tracked) })
    const atOther = seedSimpleSweep({ createdAt: LATER, frozen: tracked, location: LAKESIDE, answers: everyEngine(tracked, ENGINES, 'Several builders stand out.') })

    // The newest of the two sweeps sent as the project sends now, with its own answers.
    const body = await results()
    expect(body.run).toMatchObject({ id: atDefault, createdAt: LAST_SWEEP, matchesCurrentTracking: true })
    expect(body.pendingRows).toBe(0)
    expect(engine(body, 'q-category', 'non-brand', 'claude')).toMatchObject({ mentionedAnswers: 1, mentioned: true })

    // A new model: no stored sweep asked that. The read names the newest sweep and withholds every row.
    db.update(projects).set({ providerModels: { ...MODELS, openai: 'gpt-next' } }).where(eq(projects.id, PROJECT_ID)).run()
    const changed = await results()
    expect(changed.run).toMatchObject({ id: atOther, createdAt: LATER, matchesCurrentTracking: false })
    expect(changed).toMatchObject({ rows: [], pendingRows: 2 })
    expect(await states()).toEqual(['awaiting-sweep', 'awaiting-sweep'])
  })

  it('looks back over as many sweeps as the workspace does, in two reads of the frozen definitions at most', async () => {
    const tracked = [BRAND_QUERY, CATEGORY_QUERY]
    seedSimpleQueries(tracked)
    const full = seedSimpleSweep({ createdAt: FIRST_SWEEP, frozen: tracked, answers: everyEngine(tracked) })
    const reads = recordReads()
    const read = async () => {
      reads.length = 0
      const body = await results()
      return { body, definitions: count(reads, 'simple_measurement_definitions'), snapshots: count(reads, 'query_snapshots'), runs: count(reads, 'runs') }
    }

    // The everyday read: the newest sweep was sent as the project sends now, so only its definition is read.
    expect(await read()).toMatchObject({ body: { run: { id: full } }, definitions: 1, snapshots: 1, runs: 2 })

    // 99 newer one-engine runs: the full sweep is the last of the 100 sweeps looked at.
    const oneEngineRun = (minute: number) => seedSimpleSweep({
      createdAt: new Date(Date.parse(LAST_SWEEP) + minute * 60_000).toISOString(), frozen: tracked, engines: ['openai'],
      answers: everyEngine(tracked, ['openai'], 'Several builders stand out.'),
    })
    for (let minute = 0; minute < 99; minute++) oneEngineRun(minute)
    const inside = await read()
    expect(inside.body.run).toMatchObject({ id: full, matchesCurrentTracking: true })
    expect(inside.body.rows).toHaveLength(2)
    // The newest definition, then every older one in a single read. Never one read per sweep.
    expect(inside).toMatchObject({ definitions: 2, snapshots: 1, runs: 2 })
    expect(await states()).toEqual(['tracked', 'tracked'])

    // One more: the full sweep is past the look-back for this read and for the workspace alike.
    const newest = oneEngineRun(99)
    const outside = await read()
    expect(outside.body.run).toMatchObject({ id: newest, matchesCurrentTracking: false })
    expect(outside.body).toMatchObject({ engines: ['openai'], rows: [], pendingRows: 2 })
    expect(outside).toMatchObject({ definitions: 2, snapshots: 1, runs: 2 })
    expect(await states()).toEqual(['awaiting-sweep', 'awaiting-sweep'])
  })

  it('reads a sweep with no frozen definition only under the class it can vouch for', async () => {
    seedSimpleQueries([BRAND_QUERY])
    const legacy = { queryId: 'q-brand', text: BRAND_QUERY[1], provider: 'claude' as const, answer: 'Northbridge is well reviewed.', mentioned: true, cited: true }
    seedSimpleSweep({ createdAt: LAST_SWEEP, answers: [legacy] })

    // The project classifies the query as Branded now; the old sweep recorded no class.
    expect(await results()).toMatchObject({ rows: [], pendingRows: 1, run: { matchesCurrentTracking: false } })

    // With no usable brand name the workspace row carries no class either, and the stored row reads as unknown.
    db.update(projects).set({ displayName: '', canonicalDomain: '' }).where(eq(projects.id, PROJECT_ID)).run()
    expect((await workspace()).tracked[0]!.queryClasses).toEqual([])
    const body = await results()
    expect(body.rows).toStrictEqual([{
      queryId: 'q-brand', queryText: BRAND_QUERY[1], queryClass: 'unknown',
      engines: [{ provider: 'claude', expectedAnswers: 1, answers: 1, mentionedAnswers: 1, citedAnswers: 1, uncheckedSourceAnswers: 0, mentioned: true, cited: true }],
    }])
    expect(body.pendingRows).toBe(0)
    // It recorded no engines, models or search location to compare, so it never claims a match.
    expect(body.run?.matchesCurrentTracking).toBe(false)
  })

  it('answers 200 with no run before the first sweep', async () => {
    seedSimpleQueries([BRAND_QUERY, CATEGORY_QUERY])
    expect(await results()).toStrictEqual({
      mode: 'simple', scope: { kind: 'project', key: null }, run: null, engines: [], rows: [], pendingRows: 2,
    })
  })
})

describe('query tracking results: cost', () => {
  it('parses only the plans it needs and reads one sweep\'s snapshots once, however many revisions exist', async () => {
    const { versionId, plan } = seedPortfolio()
    // Nineteen more revisions and a sweep of each: every one is history this read must not open.
    for (let revision = 2; revision <= 20; revision++) {
      const historic = planOf({ texts: { ...TEXTS, 'q-harbor': `${HARBOR_TEXT} ${revision}` } })
      seedSweep({ versionId: seedVersion(revision, historic), plan: historic, createdAt: FIRST_SWEEP, answers: () => nobody })
    }
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })
    const parses = vi.mocked(parseStoredMeasurementPlanAnyVersion)
    const reads = recordReads()

    // The sweep ran with the active plan: one parse, the active plan's.
    parses.mockClear()
    expect((await results()).run).toMatchObject({ revision: 1, matchesCurrentTracking: true })
    expect(parses).toHaveBeenCalledTimes(1)
    expect(count(reads, 'query_snapshots')).toBe(1)
    // The sweep list without manifests, then the chosen sweep's row.
    expect(count(reads, 'runs')).toBe(2)

    // Tracking changed: the active plan and the plan the sweep ran with, never the other eighteen.
    await publish({ edits: [{ queryId: 'q-harbor', queryClass: 'non-brand' }] })
    parses.mockClear()
    reads.length = 0
    expect((await results()).run).toMatchObject({ revision: 1, matchesCurrentTracking: false })
    expect(parses).toHaveBeenCalledTimes(2)
    expect(count(reads, 'query_snapshots')).toBe(1)
    expect(count(reads, 'runs')).toBe(2)
  })

  it('reads 940 queries, 3 engines and 20 revisions inside its budget', { timeout: 120_000 }, async () => {
    // For answers of about 4,000 characters: the read's time grows with answer length.
    // A ceiling for a loaded machine, not the target: alone this read takes about a quarter of a second.
    // What keeps it fast is pinned exactly below (plans parsed, tables read). At 1 s the wall clock failed
    // whenever other test files shared the box.
    const BUDGET_MS = 5_000
    const large = largePortfolio(190, 137)
    const plan = planOf(large)
    expect(plan.querySnapshots).toHaveLength(940)
    expect(plan.assignments).toHaveLength(2_584)
    // Twenty revisions: eighteen unrelated ones, the one the sweep ran with, and later the active one.
    for (let revision = 1; revision <= 18; revision++) seedVersion(revision, planOf({ texts: { 'q-harbor': `${HARBOR_TEXT} ${revision}` }, pairings: [PAIRINGS[2]!] }))
    const swept = seedVersion(19, plan)
    activate(swept)
    const filler = 'Several communities nearby offer similar floor plans, amenities and lease terms. '.repeat(48)
    const otherSources = Array.from({ length: 7 }, (_, index) => `https://guide-${index}.example/homes/listing`)
    seedSweep({
      versionId: swept, plan, createdAt: LAST_SWEEP,
      // About 4,000 characters and 8 sources per answer. One answer in three names its location and one in five cites it.
      answers: ({ queryId, provider }) => {
        const index = large.order.get(queryId)! + ENGINES.indexOf(provider)
        const target = large.subject.get(queryId)!
        return says(
          `${index % 3 === 0 ? `${target.label} is a strong option. ` : ''}${filler}`,
          [index % 5 === 0 ? `https://northbridge.example/${target.stableKey}/floor-plans` : OTHER_SOURCE, ...otherSources],
        )
      },
    })

    /** Five reads: the last body, the median time and the best time. */
    const measure = async () => {
      const timings: number[] = []
      let body!: QueryTrackingResultsResponse
      for (let attempt = 0; attempt < 5; attempt++) {
        const started = performance.now()
        const response = await request('GET', '/query-tracking/results')
        timings.push(performance.now() - started)
        expect(response.statusCode, response.body.slice(0, 300)).toBe(200)
        body = response.json() as QueryTrackingResultsResponse
      }
      const sorted = [...timings].sort((left, right) => left - right)
      return { body, median: sorted[2]!, best: sorted[0]! }
    }
    const answersOf = (body: QueryTrackingResultsResponse, key: 'answers' | 'mentionedAnswers' | 'citedAnswers') => (
      body.rows.reduce((sum, row) => sum + row.engines.reduce((inner, entry) => inner + entry[key], 0), 0)
    )
    /** How many of a query's three answers the seed marked, summed over the queries that have a row. */
    const seeded = (every: number, without?: string) => [...large.order]
      .filter(([queryId]) => queryId !== without)
      .reduce((sum, [, index]) => sum + ENGINES.filter((_, offset) => (index + offset) % every === 0).length, 0)

    // The sweep ran with the active plan: the everyday read.
    const current = await measure()
    expect(current.body.run).toMatchObject({ revision: 19, matchesCurrentTracking: true })
    expect(current.body.rows).toHaveLength(940)
    expect(current.body.pendingRows).toBe(0)
    expect(current.body.rows.every(row => row.engines.length === 3 && row.engines.every(entry => entry.expectedAnswers === 1))).toBe(true)
    expect(answersOf(current.body, 'answers')).toBe(940 * 3)
    expect(answersOf(current.body, 'mentionedAnswers')).toBe(seeded(3))
    expect(answersOf(current.body, 'citedAnswers')).toBe(seeded(5))

    // Tracking changed: one query is reworded, so the read parses two large plans and signs every assignment.
    activate(seedVersion(20, planOf({ ...large, texts: { ...large.texts, 'q-loc-0-0': 'Harbor 000 resident reviews' } })))
    const changed = await measure()
    expect(changed.body.run).toMatchObject({ revision: 19, matchesCurrentTracking: false })
    expect(changed.body.rows).toHaveLength(939)
    expect(changed.body.pendingRows).toBe(1)
    expect(answersOf(changed.body, 'mentionedAnswers')).toBe(seeded(3, 'q-loc-0-0'))
    expect(answersOf(changed.body, 'citedAnswers')).toBe(seeded(5, 'q-loc-0-0'))

    console.info(`query-tracking results, 940 queries x 3 engines over 20 revisions: median ${current.median.toFixed(0)} ms (best ${current.best.toFixed(0)}), ${changed.median.toFixed(0)} ms (best ${changed.best.toFixed(0)}) after a tracking change`)
    // The parse and table-read counts above are the cost guard that cannot
    // flake. Time is held on the best of the five reads, because the whole
    // suite running beside this one has slowed the median almost threefold.
    expect(current.best).toBeLessThan(BUDGET_MS)
    expect(changed.best).toBeLessThan(BUDGET_MS)
  })
})

/**
 * A portfolio the size of a large customer's: 190 locations and 137 markets of
 * four locations each. Each location has two Branded queries of its own, each
 * market has four Non-brand queries asked once for all of its locations, and
 * the remaining queries are hand-picked.
 */
function largePortfolio(locations: number, markets: number) {
  const targets = Array.from({ length: locations }, (_, index) => {
    const label = `${['Harbor', 'Cedar', 'Maple', 'Willow', 'Summit'][index % 5]} ${String(index).padStart(3, '0')}`
    return [`loc-${index}`, label] as const
  })
  const texts: Record<string, string> = {}
  const pairings: Pairing[] = []
  /** The location an answer to this query names and cites when it names one. */
  const subject = new Map<string, { stableKey: string; label: string }>()
  targets.forEach(([stableKey, label], index) => {
    for (let own = 0; own < 2; own++) {
      const queryId = `q-loc-${index}-${own}`
      texts[queryId] = `${label} ${own === 0 ? 'reviews' : 'floor plans'}`
      // Market `m` opens with location `m`, so the first 137 locations each have a market to sit in.
      pairings.push({ queryId, targetKey: stableKey, queryClass: 'branded', ...(index < markets ? { market: `market-${index}` } : {}) })
      subject.set(queryId, { stableKey, label })
    }
  })
  for (let market = 0; market < markets; market++) {
    const members = Array.from({ length: 4 }, (_, offset) => targets[(market + offset) % locations]!)
    for (let asked = 0; asked < 4; asked++) {
      const queryId = `q-market-${market}-${asked}`
      texts[queryId] = `${['best homes', 'pet friendly homes', 'luxury homes', 'homes with parking'][asked]} in market ${market}`
      for (const [stableKey] of members) pairings.push({ queryId, targetKey: stableKey, queryClass: 'non-brand', market: `market-${market}` })
      subject.set(queryId, { stableKey: members[asked]![0], label: members[asked]![1] })
    }
  }
  for (let extra = 0; Object.keys(texts).length < 940; extra++) {
    const queryId = `q-pick-${extra}`
    texts[queryId] = `homes near transit option ${extra}`
    const [stableKey, label] = targets[extra % locations]!
    pairings.push({ queryId, targetKey: stableKey, queryClass: 'non-brand' })
    subject.set(queryId, { stableKey, label })
  }
  const order = new Map(Object.keys(texts).map((queryId, index) => [queryId, index]))
  return { targets, texts, pairings, groups: [], subject, order }
}
