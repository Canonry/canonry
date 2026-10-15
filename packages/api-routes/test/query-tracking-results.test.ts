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
  type QueryTrackingWorkspaceResponse,
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  createClient,
  measurementPlans,
  measurementPlanVersions,
  measurementQueryTemplates,
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
type Answer = { text: string | null; cites?: string[]; capture?: 'complete' | 'partial'; names?: string[] }
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
      competitorOverlap: [], recommendedCompetitors: answer.names ?? [],
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

/** Every `query_snapshots` select the routes run: its SQL, its parameters and how many rows it read. */
function recordSnapshotSelects(): Array<{ sql: string; params: unknown[]; rows: number }> {
  const selects: Array<{ sql: string; params: unknown[]; rows: number }> = []
  type Query = { all: () => unknown[]; toSQL: () => { sql: string; params: unknown[] } }
  const select = db.select.bind(db) as (...args: unknown[]) => { from: (table: Table) => Query }
  vi.spyOn(db, 'select').mockImplementation(((...args: unknown[]) => {
    const builder = select(...args)
    const from = builder.from.bind(builder)
    builder.from = (table: Table) => {
      const query = from(table)
      if (getTableName(table) !== 'query_snapshots') return query
      const all = query.all.bind(query)
      query.all = () => {
        const rows = all()
        selects.push({ ...query.toSQL(), rows: rows.length })
        return rows
      }
      return query
    }
    return builder
  }) as typeof db.select)
  return selects
}

/** The eight fields an engine entry always carries. Every other field is optional. */
const ALWAYS = ['provider', 'expectedAnswers', 'answers', 'mentionedAnswers', 'citedAnswers', 'uncheckedSourceAnswers', 'mentioned', 'cited'] as const

/** The optional fields of an engine entry that the read sent. */
function extras(entry: QueryTrackingEngineResult): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !(ALWAYS as readonly string[]).includes(key)))
}

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
        // The row covers Harbor and Cedar, so the entry says which of the two the answer names.
        { provider: 'claude', expectedAnswers: 1, answers: 1, mentionedAnswers: 1, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: true, cited: false, mentionedTargetKeys: ['harbor'] },
        // Cited without being named: a citation never sets mentioned.
        { provider: 'gemini', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 1, uncheckedSourceAnswers: 0, mentioned: false, cited: true, citedTargetKeys: ['cedar'] },
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

describe('query tracking results: weakest markets', () => {
  const PLACES: ReadonlyArray<readonly [stableKey: string, label: string]> = [
    ['harbor', 'Harbor Point'], ['cedar', 'Cedar Court'], ['maple', 'Maple Row'],
    ['willow', 'Willow Park'], ['summit', 'Summit Place'], ['birch', 'Birch Lane'],
  ]
  /** A market's own query: asked once for both of its locations. */
  const marketQuery = (queryId: string, market: string, targets: [string, string], queryClass: Pairing['queryClass'] = 'non-brand'): Pairing[] => (
    targets.map(targetKey => ({ queryId, targetKey, queryClass, market }))
  )
  /** One listed market: its key, its own non-brand rows, the answers read for the mention and for the citation. */
  type Listed = readonly [marketKey: string, queries: number, mentionChecked: number, citationChecked: number, more?: { other?: number; cited?: number }]
  /** The listed markets, given weakest first. `marketKeys` stays in key order. */
  const weak = (...ranked: Listed[]) => ({
    rule: 'no-mention-latest-sweep', queryClass: 'non-brand', count: ranked.length,
    marketKeys: ranked.map(([marketKey]) => marketKey).sort(),
    markets: ranked.map(([marketKey, queries, mentionCheckedAnswers, citationCheckedAnswers, more]) => ({
      marketKey, queries, mentionCheckedAnswers, mentionedAnswers: 0,
      otherLocationMentionedAnswers: more?.other ?? 0, citationCheckedAnswers, citedAnswers: more?.cited ?? 0,
    })),
  })

  it('lists only the market whose non-brand answers were read and named no location', async () => {
    const { versionId, plan } = seedPortfolio(planOf({
      targets: PLACES, groups: [],
      texts: { 'q-north': 'best homes up north', 'q-south': 'best homes down south', 'q-west': 'best homes out west' },
      pairings: [
        ...marketQuery('q-north', 'north', ['harbor', 'cedar']),
        ...marketQuery('q-south', 'south', ['maple', 'willow']),
        ...marketQuery('q-west', 'west', ['summit', 'birch']),
      ],
    }))
    seedSweep({
      versionId, plan, createdAt: LAST_SWEEP,
      answers: ({ queryId, provider }) => {
        // One engine of three names a location of North.
        if (queryId === 'q-north') return provider === 'gemini' ? says('Cedar Court is worth a visit.') : nobody
        // Every answer for South was read. One cites Maple's page and names nobody: a citation is not a mention.
        if (queryId === 'q-south') return provider === 'claude' ? says('A few communities stand out.', ['https://northbridge.example/maple/floor-plans']) : nobody
        // No answer for West was saved.
        return undefined
      },
    })

    const body = await results()
    expect(engine(body, 'q-south', 'non-brand', 'claude')).toMatchObject({ mentioned: false, cited: true })
    expect(rowOf(body, 'q-west', 'non-brand')!.engines.map(entry => entry.mentioned)).toEqual([null, null, null])
    // One query, three answers read, and the one citation is counted beside the missing mention.
    expect(body.weakMarkets).toStrictEqual(weak(['south', 1, 3, 3, { cited: 1 }]))
  })

  it('never lets a branded mention stand in for the non-brand queries of a market', async () => {
    const { versionId, plan } = seedPortfolio(planOf({
      texts: { 'q-market': MARKET_TEXT, 'q-brand-market': 'Northbridge homes in uptown', 'q-mixed': 'Harbor Point or Cedar Court', 'q-harbor': HARBOR_TEXT },
      pairings: [
        ...marketQuery('q-market', 'uptown', ['harbor', 'cedar']),
        // Uptown's Branded market query.
        ...marketQuery('q-brand-market', 'uptown', ['harbor', 'cedar'], 'branded'),
        // One market query, Branded for Harbor and Non-brand for Cedar.
        { queryId: 'q-mixed', targetKey: 'harbor', queryClass: 'branded', market: 'uptown' },
        { queryId: 'q-mixed', targetKey: 'cedar', queryClass: 'non-brand', market: 'uptown' },
        { queryId: 'q-harbor', targetKey: 'harbor', queryClass: 'branded', market: 'uptown' },
      ],
    }))
    // Every Branded answer names Harbor. The one Non-brand answer set names nobody.
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: ({ queryId }) => (queryId === 'q-market' ? nobody : says('Harbor Point is the one to see.')) })

    const body = await results()
    const mentions = (queryId: string, queryClass: string) => rowOf(body, queryId, queryClass)!.engines.map(entry => entry.mentionedAnswers)
    expect(mentions('q-brand-market', 'branded')).toEqual([1, 1, 1])
    expect(mentions('q-mixed', 'branded')).toEqual([1, 1, 1])
    expect(mentions('q-harbor', 'branded')).toEqual([1, 1, 1])
    // Cedar's Non-brand half of the mixed query reads the same answers and finds Cedar in none.
    expect(mentions('q-mixed', 'non-brand')).toEqual([0, 0, 0])
    expect(mentions('q-market', 'non-brand')).toEqual([0, 0, 0])
    // Pooled, Uptown would count nine mentions. Its Non-brand rows have none, so it is weak.
    // The mixed query's Non-brand half covers Cedar alone, so its three answers name another location: Harbor.
    expect(body.weakMarkets).toStrictEqual(weak(['uptown', 2, 6, 6, { other: 3 }]))
  })

  it('needs one read answer, and counts neither an answer with no saved text nor a query that is not the market\'s own', async () => {
    const { versionId, plan } = seedPortfolio(planOf({
      targets: [...PLACES, ['aspen', 'Aspen Walk'], ['laurel', 'Laurel Green']],
      groups: [],
      texts: {
        'q-partial': 'best homes up north', 'q-unread': 'best homes down south', 'q-brand-west': 'Northbridge homes out west',
        'q-aspen': 'homes near the aspen trail', 'q-brand-east': 'Northbridge homes out east', 'q-pick': 'homes with covered parking',
      },
      pairings: [
        ...marketQuery('q-partial', 'north', ['harbor', 'cedar']),
        ...marketQuery('q-unread', 'south', ['maple', 'willow']),
        // West has a Branded market query only.
        ...marketQuery('q-brand-west', 'west', ['summit', 'birch'], 'branded'),
        // East has one too, and its only Non-brand query is Aspen's own.
        ...marketQuery('q-brand-east', 'east', ['aspen', 'laurel'], 'branded'),
        { queryId: 'q-aspen', targetKey: 'aspen', queryClass: 'non-brand', market: 'east' },
        // Hand-picked across two markets.
        { queryId: 'q-pick', targetKey: 'maple', queryClass: 'non-brand' },
        { queryId: 'q-pick', targetKey: 'summit', queryClass: 'non-brand' },
      ],
    }))
    seedSweep({
      versionId, plan, createdAt: LAST_SWEEP,
      answers: ({ queryId, provider }) => {
        // One checked no, one answer never saved and one saved without its text.
        if (queryId === 'q-partial') return provider === 'claude' ? nobody : provider === 'gemini' ? undefined : { text: null }
        if (queryId === 'q-unread') return { text: null }
        return nobody
      },
    })

    const body = await results()
    expect(rowOf(body, 'q-partial', 'non-brand')!.engines.map(entry => [entry.answers, entry.mentioned])).toEqual([[1, false], [0, null], [1, null]])
    expect(rowOf(body, 'q-unread', 'non-brand')!.engines.map(entry => [entry.answers, entry.mentioned])).toEqual([[1, null], [1, null], [1, null]])
    // Read and named nobody, and still not a market's Non-brand query.
    for (const [queryId, queryClass] of [['q-brand-west', 'branded'], ['q-brand-east', 'branded'], ['q-aspen', 'non-brand'], ['q-pick', 'non-brand']] as const) {
      expect(rowOf(body, queryId, queryClass)!.engines.map(entry => entry.mentioned), queryId).toEqual([false, false, false])
    }
    // One answer had its text read. Two had fully saved sources: that one and the one saved without text.
    expect(body.weakMarkets).toStrictEqual(weak(['north', 1, 1, 2]))
  })

  it('adds up every non-brand query of a market, in any row order, and lists the markets in key order', async () => {
    const { versionId, plan } = seedPortfolio(planOf({
      targets: [...PLACES, ['aspen', 'Aspen Walk'], ['laurel', 'Laurel Green']],
      groups: [],
      // Rows come back by query id, so West's are read before East's and each market's first row before its second.
      texts: {
        'q-a-west-unsaved': 'best homes out west', 'q-b-west-read': 'pet friendly homes out west',
        'q-c-east-read': 'best homes out east', 'q-d-east-unsaved': 'pet friendly homes out east',
        'q-e-north-named': 'best homes up north', 'q-f-north-read': 'pet friendly homes up north',
        'q-g-south-read': 'best homes down south', 'q-h-south-named': 'pet friendly homes down south',
      },
      pairings: [
        ...marketQuery('q-a-west-unsaved', 'west', ['summit', 'birch']),
        ...marketQuery('q-b-west-read', 'west', ['summit', 'birch']),
        ...marketQuery('q-c-east-read', 'east', ['aspen', 'laurel']),
        ...marketQuery('q-d-east-unsaved', 'east', ['aspen', 'laurel']),
        ...marketQuery('q-e-north-named', 'north', ['harbor', 'cedar']),
        ...marketQuery('q-f-north-read', 'north', ['harbor', 'cedar']),
        ...marketQuery('q-g-south-read', 'south', ['maple', 'willow']),
        ...marketQuery('q-h-south-named', 'south', ['maple', 'willow']),
      ],
    }))
    seedSweep({
      versionId, plan, createdAt: LAST_SWEEP,
      answers: ({ queryId, provider }) => {
        if (queryId.endsWith('-unsaved')) return undefined
        if (queryId === 'q-e-north-named') return provider === 'gemini' ? says('Cedar Court is worth a visit.') : nobody
        if (queryId === 'q-h-south-named') return provider === 'openai' ? says('Maple Row stands out.') : nobody
        return nobody
      },
    })

    const body = await results()
    expect(body.rows.map(row => [row.queryId, row.engines.reduce((sum, entry) => sum + entry.mentionedAnswers, 0), row.engines.reduce((sum, entry) => sum + entry.answers, 0)])).toEqual([
      ['q-a-west-unsaved', 0, 0], ['q-b-west-read', 0, 3],
      ['q-c-east-read', 0, 3], ['q-d-east-unsaved', 0, 0],
      ['q-e-north-named', 1, 3], ['q-f-north-read', 0, 3],
      ['q-g-south-read', 0, 3], ['q-h-south-named', 1, 3],
    ])
    // North and South each have one named query beside a quiet one, first in one and last in the other: neither is weak.
    // East and West each have one read query beside one with no saved answer, in either order: both are weak.
    expect(body.weakMarkets).toStrictEqual(weak(['east', 2, 3, 3], ['west', 2, 3, 3]))
  })

  it('reads a query\'s Subject from the active plan, not from the plan the sweep ran with', async () => {
    const { versionId, plan } = seedPortfolio()
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: () => nobody })
    expect((await results()).weakMarkets).toStrictEqual(weak(['uptown', 1, 3, 3]))

    // Revision 2 asks a new Branded query for Maple inside Uptown. Uptown now holds three locations and
    // q-market still covers two of them, so it is hand-picked now and no longer Uptown's own.
    activate(seedVersion(2, planOf({
      texts: { ...TEXTS, 'q-maple': 'Maple Row reviews' },
      pairings: [...PAIRINGS, { queryId: 'q-maple', targetKey: 'maple', queryClass: 'branded', market: 'uptown' }],
    })))

    const body = await results()
    expect(body.run).toMatchObject({ revision: 1, matchesCurrentTracking: false })
    // The sweep asked q-market exactly as it is asked now, so its row is still returned.
    expect(rowOf(body, 'q-market', 'non-brand')!.engines.map(entry => entry.mentioned)).toEqual([false, false, false])
    expect((await workspace()).tracked.find(row => row.queryId === 'q-market')?.focus).toEqual({ kind: 'custom' })
    expect(body.weakMarkets).toStrictEqual(weak())
  })

  it('is returned for the project read of a portfolio with a sweep and for nothing else', async () => {
    const { versionId, plan } = seedPortfolio()
    expect(await results()).not.toHaveProperty('weakMarkets')

    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: () => nobody })
    const body = await results()
    expect(body.weakMarkets).toStrictEqual(weak(['uptown', 1, 3, 3]))
    for (const place of ['scope=market&scopeKey=uptown', 'scope=group&scopeKey=east', 'scope=property&scopeKey=harbor']) {
      const scoped = await results(place)
      expect(scoped.rows.length, place).toBeGreaterThan(0)
      expect(scoped, place).not.toHaveProperty('weakMarkets')
    }
    // A response from a server that sends no weakMarkets still parses, and so does one that lists keys only.
    const { weakMarkets, ...older } = body
    expect(queryTrackingResultsResponseSchema.parse(older)).toStrictEqual(older)
    const { markets: _markets, ...keysOnly } = weakMarkets!
    expect(queryTrackingResultsResponseSchema.parse({ ...older, weakMarkets: keysOnly })).toStrictEqual({ ...older, weakMarkets: keysOnly })
  })

  it('leaves a market out while one of its non-brand queries is withheld after a tracking change', async () => {
    const { versionId, plan } = seedPortfolio(planOf({
      targets: [...PLACES, ['aspen', 'Aspen Walk'], ['laurel', 'Laurel Green']],
      groups: [],
      texts: {
        'q-north-named': 'best homes up north', 'q-north-quiet': 'pet friendly homes up north',
        'q-south-a': 'best homes down south', 'q-south-b': 'pet friendly homes down south',
        'q-west': 'best homes out west',
        'q-east': 'best homes out east', 'q-east-brand': 'Northbridge homes out east',
      },
      pairings: [
        ...marketQuery('q-north-named', 'north', ['harbor', 'cedar']),
        ...marketQuery('q-north-quiet', 'north', ['harbor', 'cedar']),
        ...marketQuery('q-south-a', 'south', ['maple', 'willow']),
        ...marketQuery('q-south-b', 'south', ['maple', 'willow']),
        ...marketQuery('q-west', 'west', ['summit', 'birch']),
        ...marketQuery('q-east', 'east', ['aspen', 'laurel']),
        ...marketQuery('q-east-brand', 'east', ['aspen', 'laurel'], 'branded'),
      ],
    }))
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: ({ queryId }) => (queryId === 'q-north-named' ? says('Harbor Point is a strong option.') : nobody) })
    // South has two quiet queries, so more of its answers were read: it is listed before East and West.
    expect((await results()).weakMarkets).toStrictEqual(weak(['south', 2, 6, 6], ['east', 1, 3, 3], ['west', 1, 3, 3]))

    // Reword the one query of North that was named, one of South's two, West's only one and East's Branded one.
    // No sweep follows.
    await publish({
      edits: [
        { queryId: 'q-north-named', text: 'top homes up north' },
        { queryId: 'q-south-a', text: 'top homes down south' },
        { queryId: 'q-west', text: 'top homes out west' },
        { queryId: 'q-east-brand', text: 'Northbridge houses out east' },
      ],
    })
    const body = await results()
    expect(body.run?.matchesCurrentTracking).toBe(false)
    expect(body.pendingRows).toBe(4)
    expect(rowKeys(body)).toEqual(['q-east non-brand', 'q-north-quiet non-brand', 'q-south-b non-brand'])
    expect(body.rows.map(row => row.engines.map(entry => entry.mentioned))).toEqual(Array(3).fill([false, false, false]))
    // North's remaining row names nobody, yet the sweep holds a mention for the query reworded since: it is
    // not called weak on half its queries. South and West wait for the next sweep the same way.
    // East's Non-brand query is untouched, and a withheld Branded row never counts: East is still weak.
    expect(body.weakMarkets).toStrictEqual(weak(['east', 1, 3, 3]))
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
    answers: ReadonlyArray<{ queryId: string; text: string; provider: Engine; answer: string; cited?: boolean; mentioned?: boolean | null; names?: string[] }>
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
      competitorOverlap: [], recommendedCompetitors: answer.names ?? [], location: null, createdAt: input.createdAt,
    }))).run()
    return id
  }

  /** The id of the stored answer one engine gave one query. */
  function simpleAnswerId(queryId: string, provider: Engine): string {
    const found = db.select().from(querySnapshots).all().find(row => row.queryId === queryId && row.provider === provider)
    if (!found) throw new Error(`No stored ${provider} answer for ${queryId}`)
    return found.id
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
    // A simple project has no market to rank.
    expect(body).not.toHaveProperty('weakMarkets')
    // Each type is totalled apart. Branded is missing an answer, so neither of its rates is a number.
    const withheld = { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' }
    expect(body.totals).toStrictEqual([
      { queryClass: 'branded', queries: 1, answers: 2, mentionCoverage: withheld, citationCoverage: withheld },
      {
        queryClass: 'non-brand', queries: 1, answers: 3,
        mentionCoverage: { numerator: 1, denominator: 3, rate: 1 / 3 },
        citationCoverage: { numerator: 1, denominator: 3, rate: 1 / 3 },
      },
    ])
  })

  it('reads one query with its answers, loading that query\'s answers alone', async () => {
    seedSimpleQueries([BRAND_QUERY, CATEGORY_QUERY])
    seedSimpleSweep({
      createdAt: LAST_SWEEP, frozen: [BRAND_QUERY, CATEGORY_QUERY],
      answers: [
        ...everyEngine([BRAND_QUERY]),
        // One stored name is the project's own.
        { queryId: 'q-category', text: CATEGORY_QUERY[1], provider: 'claude', answer: 'Oakline Builders and Northbridge.', names: ['Oakline Builders', 'Northbridge'] },
        { queryId: 'q-category', text: CATEGORY_QUERY[1], provider: 'gemini', answer: 'Several builders stand out.', cited: true },
      ],
    })
    const whole = await results()
    const selects = recordSnapshotSelects()

    const body = await results('queryId=q-category')
    // Two of the sweep's five answers.
    expect(selects.map(select => select.rows)).toEqual([2])
    vi.mocked(db.select).mockRestore()
    // The run is the same one, and still measures every tracked query.
    expect(body.run).toStrictEqual(whole.run)
    expect(body.run?.matchesCurrentTracking).toBe(true)
    expect(body.engines).toEqual(['claude', 'gemini', 'openai'])
    expect(body).not.toHaveProperty('totals')
    const answerRow = (resultId: string | null, mentioned: boolean | null, cited: boolean | null, namedInstead: string[] = []) => ({
      resultId, searchLocation: 'riverside', targetKeys: ['project'], mentioned, cited,
      mentionedTargetKeys: mentioned ? ['project'] : [], citedTargetKeys: cited ? ['project'] : [], namedInstead,
    })
    expect(body.rows).toStrictEqual([{
      queryId: 'q-category', queryText: CATEGORY_QUERY[1], queryClass: 'non-brand',
      engines: [
        {
          provider: 'claude', expectedAnswers: 1, answers: 1, mentionedAnswers: 1, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: true, cited: false,
          answerRows: [answerRow(simpleAnswerId('q-category', 'claude'), true, false, ['Oakline Builders'])],
        },
        {
          provider: 'gemini', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 1, uncheckedSourceAnswers: 0, mentioned: false, cited: true,
          answerRows: [answerRow(simpleAnswerId('q-category', 'gemini'), false, true)],
        },
        {
          provider: 'openai', expectedAnswers: 1, answers: 0, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: null, cited: null,
          answerRows: [answerRow(null, null, null)],
        },
      ],
    }])
    expect(await results('queryId=no-such-query')).toMatchObject({ rows: [], pendingRows: 0, run: whole.run })
  })

  it('reads older history whole, so one query of it still lists the engines of the sweep', async () => {
    // No usable brand name, so the stored rows read under the class an older sweep recorded: none.
    db.update(projects).set({ displayName: '', canonicalDomain: '' }).where(eq(projects.id, PROJECT_ID)).run()
    seedSimpleQueries([BRAND_QUERY, CATEGORY_QUERY])
    seedSimpleSweep({
      createdAt: LAST_SWEEP,
      answers: [
        { queryId: 'q-brand', text: BRAND_QUERY[1], provider: 'claude', answer: 'Northbridge is well reviewed.', mentioned: true, cited: true },
        // The sweep asked the other query on Gemini only.
        { queryId: 'q-category', text: CATEGORY_QUERY[1], provider: 'gemini', answer: 'Several builders stand out.', mentioned: false },
      ],
    })

    const body = await results('queryId=q-brand')
    expect(body.engines).toEqual(['claude', 'gemini'])
    expect(body.rows).toStrictEqual([{
      queryId: 'q-brand', queryText: BRAND_QUERY[1], queryClass: 'unknown',
      engines: [{
        provider: 'claude', expectedAnswers: 1, answers: 1, mentionedAnswers: 1, citedAnswers: 1, uncheckedSourceAnswers: 0, mentioned: true, cited: true,
        answerRows: [{
          resultId: simpleAnswerId('q-brand', 'claude'), searchLocation: null, targetKeys: ['project'],
          mentioned: true, cited: true, mentionedTargetKeys: ['project'], citedTargetKeys: ['project'], namedInstead: [],
        }],
      }],
    }])
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

describe('query tracking results: totals per type', () => {
  const harborPage = 'https://northbridge.example/harbor/reviews'
  const cedarPage = 'https://northbridge.example/cedar/floor-plans'
  /**
   * Every answer saved:
   * - `q-market`: Claude names Harbor, Gemini cites Cedar's page, OpenAI names nobody and its sources were partly saved.
   * - `q-harbor`: every engine names Harbor and cites its page.
   * - `q-parking`: every engine names Maple, the Non-brand location, and cites nobody tracked.
   */
  const ANSWERED: Answers = ({ queryId, provider }) => {
    if (queryId === 'q-market') {
      if (provider === 'claude') return says('Harbor Point is a strong option in Uptown.')
      if (provider === 'gemini') return says('A few communities are worth a look.', [cedarPage])
      return { ...nobody, capture: 'partial' }
    }
    if (queryId === 'q-harbor') return says('Harbor Point gets good reviews.', [harborPage])
    return says('Maple Row has covered parking.')
  }

  /** The report's summary for the same place, one entry per type it holds a query for, as the totals put it. */
  async function reportTotals(place = '') {
    const response = await request('GET', `/visibility-report?queryClass=all${place ? `&${place}` : ''}`)
    expect(response.statusCode, response.body).toBe(200)
    const report = response.json() as { populations: Array<{ queryClass: string; summary: { queryCount: number; answerCount: number; mentionCoverage: unknown; citationCoverage: unknown } }> }
    return report.populations
      .filter(population => population.summary.queryCount > 0)
      .map(({ queryClass, summary }) => ({
        queryClass, queries: summary.queryCount, answers: summary.answerCount,
        mentionCoverage: summary.mentionCoverage, citationCoverage: summary.citationCoverage,
      }))
  }

  it('totals each type apart, in answers, with the numbers AI Visibility shows for the same place', async () => {
    const { versionId, plan } = seedPortfolio()
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: ANSWERED })

    const project = await results()
    // Branded and Non-brand are two entries. Pooled, mentioned would read 7 of 12.
    expect(project.totals).toStrictEqual([
      {
        // Harbor's own query is named and cited three times. The hand-picked query's three answers name Maple, never Harbor.
        queryClass: 'branded', queries: 2, answers: 6,
        mentionCoverage: { numerator: 3, denominator: 6, rate: 0.5 },
        citationCoverage: { numerator: 3, denominator: 6, rate: 0.5 },
      },
      {
        queryClass: 'non-brand', queries: 2, answers: 6,
        mentionCoverage: { numerator: 4, denominator: 6, rate: 4 / 6 },
        // The answer with partly saved sources is in neither side: 1 of 5, not 1 of 6.
        citationCoverage: { numerator: 1, denominator: 5, rate: 0.2, unchecked: 1 },
      },
    ])

    // The same figures as the report, place by place: the project, a group, a market and a location.
    expect(project.totals).toStrictEqual(await reportTotals())
    for (const place of ['scope=group&scopeKey=east', 'scope=market&scopeKey=uptown', 'scope=property&scopeKey=harbor']) {
      const read = await results(place)
      expect(read.totals!.length, place).toBeGreaterThan(0)
      expect(read.totals, place).toStrictEqual(await reportTotals(place))
    }
    // A place changes the figure: under the East group the market query covers Cedar alone, and no answer names Cedar.
    expect((await results('scope=group&scopeKey=east')).totals).toStrictEqual([{
      queryClass: 'non-brand', queries: 2, answers: 6,
      mentionCoverage: { numerator: 3, denominator: 6, rate: 0.5 },
      citationCoverage: { numerator: 1, denominator: 5, rate: 0.2, unchecked: 1 },
    }])
  })

  it('leaves an answer that could not be tied to one location, and one with partly saved sources, out of both sides', async () => {
    const { versionId, plan } = seedPortfolio(planOf({
      texts: { 'q-pick': PARKING_TEXT },
      pairings: [{ queryId: 'q-pick', targetKey: 'harbor', queryClass: 'non-brand' }],
    }))
    seedSweep({
      versionId, plan, createdAt: LAST_SWEEP,
      answers: ({ provider }) => {
        if (provider === 'claude') return says('Harbor Point has covered parking.', [harborPage])
        // Names nobody. Its sources were partly saved, and the saved link cites Harbor's page.
        if (provider === 'gemini') return { ...nobody, cites: [harborPage], capture: 'partial' }
        // Repeats the name without saying which one it means.
        return says('Which Harbor Point do you mean?')
      },
    })

    const body = await results()
    expect(body.totals).toStrictEqual([{
      queryClass: 'non-brand', queries: 1, answers: 3,
      // Three answers: one mentioned, one not, one not tied to one location. 1 of 2, never 1 of 3.
      mentionCoverage: { numerator: 1, denominator: 2, rate: 0.5, unattributed: 1 },
      citationCoverage: { numerator: 1, denominator: 2, rate: 0.5, unchecked: 1 },
    }])
    expect(body.totals).toStrictEqual(await reportTotals())
    // The engine entry says why its mention was left unchecked. No other entry carries the count.
    expect(rowOf(body, 'q-pick', 'non-brand')!.engines).toStrictEqual([
      { provider: 'claude', expectedAnswers: 1, answers: 1, mentionedAnswers: 1, citedAnswers: 1, uncheckedSourceAnswers: 0, mentioned: true, cited: true },
      { provider: 'gemini', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 1, mentioned: false, cited: null },
      { provider: 'openai', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: null, cited: false, unattributedMentionAnswers: 1 },
    ])
  })

  it('withholds a type\'s rate while one of its answers is missing, as the report does', async () => {
    const { versionId, plan } = seedPortfolio()
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })

    const body = await results()
    const withheld = { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' }
    expect(body.totals).toStrictEqual([
      {
        queryClass: 'branded', queries: 2, answers: 6,
        mentionCoverage: { numerator: 3, denominator: 6, rate: 0.5 },
        citationCoverage: { numerator: 3, denominator: 6, rate: 0.5 },
      },
      // OpenAI saved no answer to the market query: five answers, and neither rate is a number.
      { queryClass: 'non-brand', queries: 2, answers: 5, mentionCoverage: withheld, citationCoverage: withheld },
    ])
    expect(body.totals).toStrictEqual(await reportTotals())
  })

  it('counts a query once however many search locations it is asked at', async () => {
    const pairings: Pairing[] = [RIVERSIDE, LAKESIDE].map(at => ({ queryId: 'q-harbor', targetKey: 'harbor', queryClass: 'branded', at }))
    const { versionId, plan } = seedPortfolio(planOf({ texts: { 'q-harbor': HARBOR_TEXT }, pairings }))
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: ({ at }) => (at === 'riverside' ? says('Harbor Point gets good reviews.', [harborPage]) : nobody) })

    const body = await results()
    expect(body.rows).toHaveLength(1)
    expect(body.totals).toStrictEqual([{
      // One row, so one query. Its six answers are three per search location.
      queryClass: 'branded', queries: 1, answers: 6,
      mentionCoverage: { numerator: 3, denominator: 6, rate: 0.5 },
      citationCoverage: { numerator: 3, denominator: 6, rate: 0.5 },
    }])
  })

  it('covers only the rows returned after a tracking change, and is absent with no sweep', async () => {
    const { versionId, plan } = seedPortfolio()
    expect(await results()).not.toHaveProperty('totals')

    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: ANSWERED })
    const before = await results()
    // Reword Harbor's own query and stop tracking the hand-picked one. No sweep follows.
    await publish({ edits: [{ queryId: 'q-harbor', text: 'Harbor Point resident reviews' }], removals: [{ queryId: 'q-parking' }] })

    const body = await results()
    expect(rowKeys(body)).toEqual(['q-market non-brand'])
    // The reworded query waits for the next sweep. The stopped one is asked nowhere, so it is not pending.
    expect(body.pendingRows).toBe(1)
    expect(body.totals).toStrictEqual([{
      queryClass: 'non-brand', queries: 1, answers: 3,
      mentionCoverage: { numerator: 1, denominator: 3, rate: 1 / 3 },
      citationCoverage: { numerator: 1, denominator: 2, rate: 0.5, unchecked: 1 },
    }])
    // The sweep itself is unchanged, so the report still counts every query it asked.
    expect(await reportTotals()).toStrictEqual(before.totals)
  })
})

describe('query tracking results: which location an answer names or cites', () => {
  const cedarPage = 'https://northbridge.example/cedar/floor-plans'
  const maplePage = 'https://northbridge.example/maple/floor-plans'
  /** `q-market` alone: Uptown's market query over Harbor and Cedar. Maple is tracked and outside it. */
  const marketOnly = () => planOf({
    texts: { 'q-market': MARKET_TEXT, 'q-maple': 'Maple Row reviews' },
    pairings: [...PAIRINGS.slice(0, 2), { queryId: 'q-maple', targetKey: 'maple', queryClass: 'branded' }],
  })
  /** One sweep of that plan, with one answer per engine to the market query. */
  async function marketRead(answers: Record<Engine, Answer>, place = '') {
    const { versionId, plan } = seedPortfolio(marketOnly())
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: ({ queryId, provider }) => (queryId === 'q-market' ? answers[provider] : nobody) })
    const body = await results(place)
    return Object.fromEntries(ENGINES.map(provider => [provider, engine(body, 'q-market', 'non-brand', provider)])) as Record<Engine, QueryTrackingEngineResult>
  }

  it('says another location was named only for an answer that names no location the row covers', async () => {
    const read = await marketRead({
      // Names Maple alone, which Uptown does not hold.
      claude: says('Maple Row is the one to see.'),
      // Names Harbor, which the row covers, and Maple.
      gemini: says('Harbor Point and Maple Row both stand out.'),
      // Repeats Maple's name without saying which one it means.
      openai: says('Which Maple Row do you mean?'),
    })
    // A miss that names another location stays a miss: the signal and the counts do not move.
    expect(read.claude).toStrictEqual({
      provider: 'claude', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: false, cited: false,
      otherLocationMentionedAnswers: 1, otherLocationMentionedTargetKeys: ['maple'],
    })
    // Mentioned, so nothing is said about the other location.
    expect(read.gemini).toStrictEqual({
      provider: 'gemini', expectedAnswers: 1, answers: 1, mentionedAnswers: 1, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: true, cited: false,
      mentionedTargetKeys: ['harbor'],
    })
    // A name that could not be tied to one location is never reported as a mention of it.
    expect(extras(read.openai)).toStrictEqual({})
    expect(read.openai).toMatchObject({ mentionedAnswers: 0, mentioned: false })
  })

  it('counts a market\'s other member as another location when the place is one location', async () => {
    const answers = { claude: says('Cedar Court is a strong option.'), gemini: says('Cedar Court and Harbor Point.'), openai: nobody }
    const { versionId, plan } = seedPortfolio(marketOnly())
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: ({ queryId, provider }) => (queryId === 'q-market' ? answers[provider] : nobody) })

    // The whole project: the row covers both members, and the entry says which one each answer names.
    const project = await results()
    expect(engine(project, 'q-market', 'non-brand', 'claude')).toMatchObject({ mentioned: true, mentionedTargetKeys: ['cedar'] })
    expect(extras(engine(project, 'q-market', 'non-brand', 'gemini'))).toStrictEqual({ mentionedTargetKeys: ['cedar', 'harbor'] })

    // Harbor alone: Claude's answer is a miss here, and it names the market's other member.
    const harbor = await results('scope=property&scopeKey=harbor')
    expect(engine(harbor, 'q-market', 'non-brand', 'claude')).toStrictEqual({
      provider: 'claude', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: false, cited: false,
      otherLocationMentionedAnswers: 1, otherLocationMentionedTargetKeys: ['cedar'],
    })
    // A row of one location carries no list of covered locations: its own signal says it.
    expect(extras(engine(harbor, 'q-market', 'non-brand', 'gemini'))).toStrictEqual({})
    expect(engine(harbor, 'q-market', 'non-brand', 'gemini').mentioned).toBe(true)
  })

  it('reads another location\'s page only from fully saved sources', async () => {
    const read = await marketRead({
      // Cites Maple's page and nobody the row covers.
      claude: says('A few communities stand out.', [maplePage]),
      // The same link in a source list that was only partly saved: not checked, so nothing is said.
      gemini: { ...nobody, cites: [maplePage, cedarPage], capture: 'partial' },
      // Cites Cedar, which the row covers, and Maple.
      openai: says('A few communities stand out.', [cedarPage, maplePage]),
    })
    expect(read.claude).toStrictEqual({
      provider: 'claude', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: false, cited: false,
      otherLocationCitedAnswers: 1, otherLocationCitedTargetKeys: ['maple'],
    })
    expect(read.gemini).toStrictEqual({
      provider: 'gemini', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 1, mentioned: false, cited: null,
    })
    expect(read.openai).toStrictEqual({
      provider: 'openai', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 1, uncheckedSourceAnswers: 0, mentioned: false, cited: true,
      citedTargetKeys: ['cedar'],
    })
  })

  it('sends the fields a caller read before unchanged, beside the new ones', async () => {
    const { versionId, plan } = seedPortfolio()
    const runId = seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })

    const body = await results()
    const { totals, weakMarkets, rows, ...rest } = body
    expect(totals).toBeDefined()
    const always = (entry: QueryTrackingEngineResult) => Object.fromEntries(ALWAYS.map(key => [key, entry[key]]))
    const entry = (provider: Engine, answers: number, mentionedAnswers: number, citedAnswers: number, mentioned: boolean | null, cited: boolean | null) => (
      { provider, expectedAnswers: 1, answers, mentionedAnswers, citedAnswers, uncheckedSourceAnswers: 0, mentioned, cited }
    )
    // The whole body as it was returned before the optional fields existed.
    expect({ ...rest, rows: rows.map(row => ({ ...row, engines: row.engines.map(always) })), weakMarkets: { ...weakMarkets, markets: undefined } }).toEqual({
      mode: 'advanced',
      scope: { kind: 'project', key: null },
      run: { id: runId, createdAt: LAST_SWEEP, completedAt: LAST_SWEEP, status: 'completed', revision: 1, matchesCurrentTracking: true },
      engines: ['claude', 'gemini', 'openai'],
      rows: [
        { queryId: 'q-harbor', queryText: HARBOR_TEXT, queryClass: 'branded', engines: ENGINES.map(provider => entry(provider, 1, 1, 1, true, true)) },
        {
          queryId: 'q-market', queryText: MARKET_TEXT, queryClass: 'non-brand',
          engines: [entry('claude', 1, 1, 0, true, false), entry('gemini', 1, 0, 1, false, true), entry('openai', 0, 0, 0, null, null)],
        },
        { queryId: 'q-parking', queryText: PARKING_TEXT, queryClass: 'branded', engines: ENGINES.map(provider => entry(provider, 1, 0, 0, false, false)) },
        { queryId: 'q-parking', queryText: PARKING_TEXT, queryClass: 'non-brand', engines: ENGINES.map(provider => entry(provider, 1, 1, 0, true, false)) },
      ],
      pendingRows: 0,
      weakMarkets: { rule: 'no-mention-latest-sweep', queryClass: 'non-brand', count: 0, marketKeys: [] },
    })
    // And every optional field the read added, entry by entry. A row with nothing to report carries none.
    expect(rows.map(row => [`${row.queryId} ${row.queryClass}`, row.engines.map(extras)])).toStrictEqual([
      ['q-harbor branded', [{}, {}, {}]],
      ['q-market non-brand', [{ mentionedTargetKeys: ['harbor'] }, { citedTargetKeys: ['cedar'] }, {}]],
      // The hand-picked query's Branded row covers Harbor alone, and every answer names Maple.
      ['q-parking branded', ENGINES.map(() => ({ otherLocationMentionedAnswers: 1, otherLocationMentionedTargetKeys: ['maple'] }))],
      ['q-parking non-brand', [{}, {}, {}]],
    ])
  })
})

describe('query tracking results: weakest markets, ranked', () => {
  const PLACES: ReadonlyArray<readonly [stableKey: string, label: string]> = [
    ['harbor', 'Harbor Point'], ['cedar', 'Cedar Court'], ['maple', 'Maple Row'], ['willow', 'Willow Park'],
    ['summit', 'Summit Place'], ['birch', 'Birch Lane'], ['aspen', 'Aspen Walk'], ['laurel', 'Laurel Green'],
  ]
  const marketQuery = (queryId: string, market: string, targets: [string, string], queryClass: Pairing['queryClass'] = 'non-brand'): Pairing[] => (
    targets.map(targetKey => ({ queryId, targetKey, queryClass, market }))
  )

  it('lists each weak market with its counts, the one with the least signal first', async () => {
    const { versionId, plan } = seedPortfolio(planOf({
      targets: PLACES, groups: [],
      texts: {
        'q-alder': 'best homes in alder', 'q-birchwood': 'best homes in birchwood', 'q-cove': 'best homes in cove',
        'q-cove-brand': 'Northbridge homes in cove', 'q-dune': 'best homes in dune',
      },
      pairings: [
        ...marketQuery('q-alder', 'alder', ['harbor', 'cedar']),
        ...marketQuery('q-birchwood', 'birchwood', ['maple', 'willow']),
        ...marketQuery('q-cove', 'cove', ['summit', 'birch']),
        ...marketQuery('q-cove-brand', 'cove', ['summit', 'birch'], 'branded'),
        ...marketQuery('q-dune', 'dune', ['aspen', 'laurel']),
      ],
    }))
    seedSweep({
      versionId, plan, createdAt: LAST_SWEEP,
      answers: ({ queryId, provider }) => {
        // Alder: one answer cites a member's page and names nobody.
        if (queryId === 'q-alder') return provider === 'claude' ? says('A few communities stand out.', ['https://northbridge.example/harbor/floor-plans']) : nobody
        // Birchwood: one answer names a location of Alder.
        if (queryId === 'q-birchwood') return provider === 'gemini' ? says('Harbor Point is worth the drive.') : nobody
        // Cove: nothing, and one answer's sources were only partly saved. Its Branded query is named every time.
        if (queryId === 'q-cove') return provider === 'openai' ? { ...nobody, capture: 'partial' } : nobody
        if (queryId === 'q-cove-brand') return says('Summit Place is the one to see.')
        // Dune: nothing, and one answer was never saved.
        return provider === 'claude' ? undefined : nobody
      },
    })

    const body = await results()
    const listed = (marketKey: string, mentionCheckedAnswers: number, citationCheckedAnswers: number, more: { other?: number; cited?: number } = {}) => ({
      marketKey, queries: 1, mentionCheckedAnswers, mentionedAnswers: 0, otherLocationMentionedAnswers: more.other ?? 0, citationCheckedAnswers, citedAnswers: more.cited ?? 0,
    })
    expect(body.weakMarkets).toStrictEqual({
      rule: 'no-mention-latest-sweep', queryClass: 'non-brand', count: 4,
      // Unchanged: in key order.
      marketKeys: ['alder', 'birchwood', 'cove', 'dune'],
      markets: [
        // No signal at all, and all three answers read. The partly saved sources are not among the checked ones.
        // Its Branded mentions change nothing.
        listed('cove', 3, 2),
        // No signal either, with one answer fewer read.
        listed('dune', 2, 2),
        // An answer names another of the project's locations.
        listed('birchwood', 3, 3, { other: 1 }),
        // A cited answer is the strongest signal a listed market can have.
        listed('alder', 3, 3, { cited: 1 }),
      ],
    })
    // The count is the engine entries' own, summed.
    expect(extras(engine(body, 'q-birchwood', 'non-brand', 'gemini'))).toStrictEqual({ otherLocationMentionedAnswers: 1, otherLocationMentionedTargetKeys: ['harbor'] })
  })
})

describe('query tracking results: one query and its answers', () => {
  const cedarPage = 'https://northbridge.example/cedar/floor-plans'
  /** The id of the stored answer one engine gave one query. */
  function answerId(queryText: string, provider: Engine, at = 'riverside'): string {
    const found = db.select().from(querySnapshots).all().find(row => row.queryText === queryText && row.provider === provider && row.location === at)
    if (!found) throw new Error(`No stored ${provider} answer for "${queryText}" at ${at}`)
    return found.id
  }
  /**
   * - `q-market`: Claude names Cedar and writes three other names, Gemini cites Cedar's page, OpenAI never answered.
   * - every other query: names and cites nobody tracked.
   */
  const NAMED: Answers = ({ queryId, provider }) => {
    if (queryId !== 'q-market') return nobody
    // One name is the covered location's own, one is another tracked location's in another case, one is nobody's.
    if (provider === 'claude') return { ...says('Cedar Court is a strong option in Uptown.'), names: ['Cedar Court', 'Oakline Residences', 'maple row'] }
    if (provider === 'gemini') return says('A few communities are worth a look.', [cedarPage])
    return undefined
  }

  it('returns only that query\'s rows, one answer per engine, read from that query\'s answers alone', async () => {
    const { versionId, plan } = seedPortfolio()
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: NAMED })
    const whole = await results()
    const selects = recordSnapshotSelects()

    const body = await results('queryId=q-market')
    // The sweep holds eight answers. The read loaded the two that answer this query.
    expect(selects.map(select => select.rows)).toEqual([2])
    expect(selects[0]!.sql).toContain('"query_snapshots"."measurement_execution_id" in (?)')
    vi.mocked(db.select).mockRestore()

    expect(body.run).toStrictEqual(whole.run)
    expect(body.engines).toEqual(whole.engines)
    expect(body.pendingRows).toBe(0)
    // No totals and no weakest markets: they belong to the read of every query.
    expect(body).not.toHaveProperty('totals')
    expect(body).not.toHaveProperty('weakMarkets')
    expect(body.rows).toStrictEqual([{
      queryId: 'q-market', queryText: MARKET_TEXT, queryClass: 'non-brand',
      engines: [
        {
          provider: 'claude', expectedAnswers: 1, answers: 1, mentionedAnswers: 1, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: true, cited: false,
          mentionedTargetKeys: ['cedar'],
          answerRows: [{
            resultId: answerId(MARKET_TEXT, 'claude'), searchLocation: 'riverside', targetKeys: ['cedar', 'harbor'],
            mentioned: true, cited: false, mentionedTargetKeys: ['cedar'], citedTargetKeys: [],
            // Neither Cedar's own name nor Maple's: a location of the plan is never a rival.
            namedInstead: ['Oakline Residences'],
          }],
        },
        {
          provider: 'gemini', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 1, uncheckedSourceAnswers: 0, mentioned: false, cited: true,
          citedTargetKeys: ['cedar'],
          answerRows: [{
            resultId: answerId(MARKET_TEXT, 'gemini'), searchLocation: 'riverside', targetKeys: ['cedar', 'harbor'],
            mentioned: false, cited: true, mentionedTargetKeys: [], citedTargetKeys: ['cedar'], namedInstead: [],
          }],
        },
        {
          provider: 'openai', expectedAnswers: 1, answers: 0, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: null, cited: null,
          // No answer was saved, so there is none to open.
          answerRows: [{
            resultId: null, searchLocation: 'riverside', targetKeys: ['cedar', 'harbor'],
            mentioned: null, cited: null, mentionedTargetKeys: [], citedTargetKeys: [], namedInstead: [],
          }],
        },
      ],
    }])
    // Apart from its answers, each entry is the one the read of every query returns, which lists no answers.
    expect(body.rows[0]!.engines.map(({ answerRows: _answerRows, ...entry }) => entry)).toStrictEqual(rowOf(whole, 'q-market', 'non-brand')!.engines)
    expect(whole.rows.flatMap(row => row.engines).every(entry => entry.answerRows === undefined)).toBe(true)

    // An answer row opens the answer read with its own id and one of its locations.
    const [answer] = body.rows[0]!.engines[0]!.answerRows!
    const opened = await request('GET', `/measurement-question-result?targetKey=${answer!.targetKeys[0]}&resultId=${answer!.resultId}&fallback=last-sweep`)
    expect(opened.statusCode, opened.body).toBe(200)
    expect(opened.json()).toMatchObject({ question: { queryId: 'q-market', provider: 'claude' }, answer: 'Cedar Court is a strong option in Uptown.' })
  })

  it('reads every snapshot of the sweep when no query is named, for this read and for the report', async () => {
    const { versionId, plan } = seedPortfolio()
    const runId = seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: NAMED })
    const selects = recordSnapshotSelects()

    await results()
    const report = await request('GET', '/visibility-report?queryClass=all')
    expect(report.statusCode, report.body).toBe(200)
    // One run, selected by its id and by nothing else.
    expect(selects.map(select => [select.rows, select.params])).toEqual([[8, [runId]], [8, [runId]]])
    for (const select of selects) expect(select.sql).toMatch(/ where "query_snapshots"\."run_id" in \(\?\)$/)
  })

  it('lists one answer per search location, each adding up to the engine counts', async () => {
    const pairings: Pairing[] = [RIVERSIDE, LAKESIDE].map(at => ({ queryId: 'q-harbor', targetKey: 'harbor', queryClass: 'branded', at }))
    const { versionId, plan } = seedPortfolio(planOf({ texts: { 'q-harbor': HARBOR_TEXT }, pairings }))
    const harborPage = 'https://northbridge.example/harbor/reviews'
    seedSweep({
      versionId, plan, createdAt: LAST_SWEEP,
      answers: ({ provider, at }) => {
        if (provider === 'claude') return at === 'riverside' ? says('Harbor Point gets good reviews.', [harborPage]) : nobody
        // One answer's sources were only partly saved, and the saved link cites Harbor's page.
        if (provider === 'gemini') return at === 'riverside' ? { ...nobody, cites: [harborPage], capture: 'partial' } : says('Harbor Point is well liked.')
        // One answer saved without its text, and one never saved.
        return at === 'riverside' ? { text: null } : undefined
      },
    })

    const body = await results('queryId=q-harbor')
    const answers = (provider: Engine) => engine(body, 'q-harbor', 'branded', provider).answerRows!.map(answer => (
      [answer.searchLocation, answer.mentioned, answer.cited, answer.resultId === null ? null : 'saved']
    ))
    // In search location order.
    expect(answers('claude')).toEqual([['lakeside', false, false, 'saved'], ['riverside', true, true, 'saved']])
    // Partly saved sources: that answer's citation is not checked, whatever the saved link cites.
    expect(answers('gemini')).toEqual([['lakeside', true, false, 'saved'], ['riverside', false, null, 'saved']])
    // An answer saved without text cannot be opened, and neither can one that was never saved.
    expect(answers('openai')).toEqual([['lakeside', null, null, null], ['riverside', null, false, null]])
    for (const provider of ENGINES) {
      const entry = engine(body, 'q-harbor', 'branded', provider)
      expect(entry.answerRows, provider).toHaveLength(entry.expectedAnswers)
      expect(entry.answerRows!.filter(answer => answer.mentioned === true), provider).toHaveLength(entry.mentionedAnswers)
      expect(entry.answerRows!.filter(answer => answer.cited === true), provider).toHaveLength(entry.citedAnswers)
      // A row of one location lists it on every answer.
      expect(entry.answerRows!.map(answer => answer.targetKeys), provider).toEqual([['harbor'], ['harbor']])
    }
    expect(engine(body, 'q-harbor', 'branded', 'gemini')).toMatchObject({ mentionedAnswers: 1, citedAnswers: 0, uncheckedSourceAnswers: 1 })
  })

  it('keeps the two types of one query apart, and narrows to the place', async () => {
    const { versionId, plan } = seedPortfolio()
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: SWEEP })

    // One execution answered for both locations: Branded for Harbor, Non-brand for Maple.
    const body = await results('queryId=q-parking')
    expect(rowKeys(body)).toEqual(['q-parking branded', 'q-parking non-brand'])
    const lines = (queryClass: string) => rowOf(body, 'q-parking', queryClass)!.engines.map(entry => entry.answerRows!.map(answer => [answer.targetKeys, answer.mentioned]))
    expect(lines('branded')).toEqual(Array(3).fill([[['harbor'], false]]))
    expect(lines('non-brand')).toEqual(Array(3).fill([[['maple'], true]]))

    // Under Maple only the Non-brand row is asked. A place the query is not asked in has no row and nothing pending.
    expect(rowKeys(await results('scope=property&scopeKey=maple&queryId=q-parking'))).toEqual(['q-parking non-brand'])
    expect(await results('scope=property&scopeKey=cedar&queryId=q-parking')).toMatchObject({ rows: [], pendingRows: 0 })
    expect(await results('queryId=no-such-query')).toMatchObject({ rows: [], pendingRows: 0 })
    expect((await refused('queryId=')).code).toBe('VALIDATION_ERROR')
  })

  it('still pairs the query with a sweep of an older plan, and returns no row for a query changed since', async () => {
    const { versionId, plan } = seedPortfolio()
    const runId = seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: NAMED })
    const before = await results('queryId=q-market')

    // Reword another query. The published plan is a new revision with its own executions; no sweep follows.
    await publish({ edits: [{ queryId: 'q-harbor', text: 'Harbor Point resident reviews' }] })
    const selects = recordSnapshotSelects()

    const untouched = await results('queryId=q-market')
    expect(untouched.run).toMatchObject({ id: runId, revision: 1, matchesCurrentTracking: false })
    expect(untouched.rows).toStrictEqual(before.rows)
    expect(untouched.pendingRows).toBe(0)
    // The executions are the older plan's own, and still only this query's two answers were loaded.
    expect(selects.map(select => select.rows)).toEqual([2])
    vi.mocked(db.select).mockRestore()

    // The reworded query, under the id the workspace lists it by now.
    const reworded = (await workspace()).tracked.find(row => row.queryText === 'Harbor Point resident reviews')!
    const changed = await results(`queryId=${reworded.queryId}`)
    expect(changed.run).toMatchObject({ id: runId, revision: 1, matchesCurrentTracking: false })
    expect(changed).toMatchObject({ rows: [], pendingRows: 1 })
  })

  it.each(['completed', 'partial'])('keeps a %s historical answer open after tracking and newer sweeps change', async status => {
    const { versionId, plan } = seedPortfolio()
    seedSweep({ versionId, plan, createdAt: FIRST_SWEEP, answers: NAMED })
    const runId = seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: NAMED, status })
    await publish({ edits: [{ queryId: 'q-harbor', text: 'Harbor Point resident reviews' }] })

    const body = await results('queryId=q-market')
    expect(body.run).toMatchObject({ id: runId, status, revision: 1, matchesCurrentTracking: false })
    const answer = body.rows[0]!.engines.find(entry => entry.provider === 'claude')!.answerRows![0]!
    const selection = `/measurement-question-result?targetKey=cedar&resultId=${answer.resultId}`
    // An explicit historical result still needs the opt-in.
    expect((await request('GET', selection)).statusCode).toBe(422)
    const opened = await request('GET', `${selection}&fallback=last-sweep`)
    expect(opened.statusCode, opened.body).toBe(200)
    expect(opened.json()).toMatchObject({
      measurement: { displayedRunId: runId, planRevision: 2, activeRevision: 2, measuredRevision: 1, awaitingSweep: true },
      question: { resultId: answer.resultId, queryId: 'q-market', provider: 'claude' },
      answer: 'Cedar Court is a strong option in Uptown.',
    })

    // A result id keeps selecting the same frozen answer after the new plan
    // gets its own sweep; aggregate fallback selection must not break its link.
    const active = db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.revision, 2)).get()!
    const currentPlan = parseStoredMeasurementPlanAnyVersion(active.canonicalJson) as MeasurementPlanV2
    seedSweep({ versionId: active.id, plan: currentPlan, createdAt: LATER, answers: () => nobody })
    const listedAgain = await results(`queryId=q-market&runId=${runId}`)
    expect(listedAgain.rows).toEqual(body.rows)
    const reopened = await request('GET', `${selection}&fallback=last-sweep`)
    expect(reopened.statusCode, reopened.body).toBe(200)
    expect(reopened.json()).toEqual(opened.json())
    // The historical run grants neither another location's execution nor a
    // result from another project.
    expect((await request('GET', `/measurement-question-result?targetKey=maple&resultId=${answer.resultId}&fallback=last-sweep`)).statusCode).toBe(404)
    db.insert(projects).values({
      id: 'elsewhere', name: 'elsewhere', displayName: 'Elsewhere', canonicalDomain: 'elsewhere.example',
      country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
    }).run()
    const historical = db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, versionId)).get()!
    db.insert(measurementPlanVersions).values({ ...historical, id: 'elsewhere-v1', projectId: 'elsewhere' }).run()
    db.update(runs).set({ projectId: 'elsewhere', measurementPlanVersionId: 'elsewhere-v1' }).where(eq(runs.id, runId)).run()
    expect((await request('GET', `${selection}&fallback=last-sweep`)).statusCode).toBe(404)
  })

  it('does not grant historical result access to probes, scoped runs, nonterminal runs or other run kinds', async () => {
    const { versionId, plan } = seedPortfolio()
    await publish({ edits: [{ queryId: 'q-harbor', text: 'Harbor Point resident reviews' }] })
    const excluded: Array<Partial<typeof runs.$inferInsert>> = [
      { trigger: RunTriggers.probe },
      { measurementScope: { groups: [], targets: ['cedar'], queries: [], resolvedTargets: ['cedar'] } },
      { status: RunStatuses.running },
      { status: RunStatuses.failed },
      { kind: RunKinds['gsc-sync'] },
      { measurementPlanVersionId: null },
    ]
    for (const change of excluded) {
      const runId = seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: NAMED })
      db.update(runs).set(change).where(eq(runs.id, runId)).run()
      const answer = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
        .find(snapshot => snapshot.queryText === MARKET_TEXT && snapshot.provider === 'claude')!
      const response = await request('GET', `/measurement-question-result?targetKey=cedar&resultId=${answer.id}&fallback=last-sweep`)
      expect(response.statusCode, JSON.stringify(change)).toBe(422)
      expect(response.json()).toMatchObject({ error: { code: 'MEASUREMENT_RUN_REVISION_MISMATCH' } })
    }
  })

  it('excludes approved qualified location names from named-instead rows and their opened answers', async () => {
    const plan = planOf()
    plan.targets.find(target => target.stableKey === 'harbor')!.identityAliases = ['Harbor Point in Riverside']
    const { versionId } = seedPortfolio(plan)
    seedSweep({ versionId, plan, createdAt: LAST_SWEEP, answers: ({ queryId }) => queryId === 'q-market'
      ? { ...says('Harbor Point in Riverside is a strong option beside Oakline Residences.'), names: ['Harbor Point in Riverside', 'Oakline Residences'] }
      : nobody })

    const body = await results('queryId=q-market')
    const answer = body.rows[0]!.engines[0]!.answerRows![0]!
    expect(answer).toMatchObject({ mentioned: true, mentionedTargetKeys: ['harbor'], namedInstead: ['Oakline Residences'] })
    const opened = await request('GET', `/measurement-question-result?targetKey=harbor&resultId=${answer.resultId}&fallback=last-sweep`)
    expect(opened.statusCode, opened.body).toBe(200)
    expect(opened.json()).toMatchObject({ mentioned: true, recommendedInstead: ['Oakline Residences'] })
  })

  it('has no run and counts the query as pending before the first sweep', async () => {
    seedPortfolio()
    expect(await results('queryId=q-parking')).toStrictEqual({
      mode: 'advanced', scope: { kind: 'project', key: null }, run: null, engines: [], rows: [], pendingRows: 2,
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
    const everyday = await results()
    expect(everyday.run).toMatchObject({ revision: 1, matchesCurrentTracking: true })
    // The weakest markets come from the same rows: no parse and no table read is added for them.
    expect(everyday.weakMarkets).toStrictEqual({ rule: 'no-mention-latest-sweep', queryClass: 'non-brand', count: 0, marketKeys: [], markets: [] })
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
    // One query of that portfolio. As generous: alone it takes well under a tenth of a second, and what keeps it
    // there is pinned exactly below (the snapshot rows read).
    const BY_QUERY_BUDGET_MS = 1_500
    // The workspace read of the same portfolio, with its views. As generous: its parses and table reads are pinned below.
    const WORKSPACE_BUDGET_MS = 10_000
    const large = largePortfolio(190, 137)
    /** Markets 7, 17 and on to 127: no answer to one of their market queries names a location. */
    const quietMarket = (queryId: string) => /^q-market-\d*7-/.test(queryId)
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
          `${index % 3 === 0 && !quietMarket(queryId) ? `${target.label} is a strong option. ` : ''}${filler}`,
          [index % 5 === 0 ? `https://northbridge.example/${target.stableKey}/floor-plans` : OTHER_SOURCE, ...otherSources],
        )
      },
    })

    /** Five reads: the last body, the median time and the best time. */
    const measure = async <Body = QueryTrackingResultsResponse>(suffix = '/query-tracking/results') => {
      const timings: number[] = []
      let body!: Body
      for (let attempt = 0; attempt < 5; attempt++) {
        const started = performance.now()
        const response = await request('GET', suffix)
        timings.push(performance.now() - started)
        expect(response.statusCode, response.body.slice(0, 300)).toBe(200)
        body = response.json() as Body
      }
      const sorted = [...timings].sort((left, right) => left - right)
      return { body, median: sorted[2]!, best: sorted[0]! }
    }
    const answersOf = (body: QueryTrackingResultsResponse, key: 'answers' | 'mentionedAnswers' | 'citedAnswers') => (
      body.rows.reduce((sum, row) => sum + row.engines.reduce((inner, entry) => inner + entry[key], 0), 0)
    )
    /** How many of a query's three answers the seed marked, summed over the queries that have a row and are not `silent`. */
    const seeded = (every: number, without?: string, silent: (queryId: string) => boolean = () => false) => [...large.order]
      .filter(([queryId]) => queryId !== without && !silent(queryId))
      .reduce((sum, [, index]) => sum + ENGINES.filter((_, offset) => (index + offset) % every === 0).length, 0)
    // Each quiet market's four Non-brand queries were answered and named nobody. Some of those answers cite a
    // location, and its locations' own Branded queries are named: neither takes a market off the list.
    const quiet = [107, 117, 127, 17, 27, 37, 47, 57, 67, 7, 77, 87, 97]
    /** How many of a market's twelve answers the seed made cite a member location. */
    const citedIn = (market: number) => [0, 1, 2, 3].reduce((sum, asked) => (
      sum + ENGINES.filter((_, offset) => (large.order.get(`q-market-${market}-${asked}`)! + offset) % 5 === 0).length
    ), 0)
    const quietMarkets = {
      rule: 'no-mention-latest-sweep', queryClass: 'non-brand', count: 13,
      marketKeys: quiet.map(market => `market-${market}`),
      // Four queries on three engines: twelve answers read. The seed cites the same share of each quiet
      // market's answers, so they tie on every count and stay in key order.
      markets: quiet.map(market => ({
        marketKey: `market-${market}`, queries: 4, mentionCheckedAnswers: 12, mentionedAnswers: 0,
        otherLocationMentionedAnswers: 0, citationCheckedAnswers: 12, citedAnswers: citedIn(market),
      })),
    }

    // The sweep ran with the active plan: the everyday read.
    const current = await measure()
    expect(current.body.run).toMatchObject({ revision: 19, matchesCurrentTracking: true })
    expect(current.body.rows).toHaveLength(940)
    expect(current.body.pendingRows).toBe(0)
    expect(current.body.rows.every(row => row.engines.length === 3 && row.engines.every(entry => entry.expectedAnswers === 1))).toBe(true)
    expect(answersOf(current.body, 'answers')).toBe(940 * 3)
    expect(answersOf(current.body, 'mentionedAnswers')).toBe(seeded(3, undefined, quietMarket))
    expect(answersOf(current.body, 'citedAnswers')).toBe(seeded(5))
    expect(current.body.weakMarkets).toStrictEqual(quietMarkets)
    // The totals are built in the same read: every answer was saved in full, so both types count all of theirs.
    const totals = current.body.totals!
    expect(totals.map(total => [total.queryClass, total.queries, total.answers, total.mentionCoverage.denominator, total.citationCoverage.denominator])).toEqual([
      ['branded', 380, 1_140, 1_140, 1_140],
      ['non-brand', 560, 1_680, 1_680, 1_680],
    ])
    expect(totals.reduce((sum, total) => sum + total.mentionCoverage.numerator!, 0)).toBe(seeded(3, undefined, quietMarket))
    expect(totals.reduce((sum, total) => sum + total.citationCoverage.numerator!, 0)).toBe(seeded(5))

    // Twenty saved patterns. Four make the market queries, which froze no pattern record, so each is matched
    // to its markets by text. Sixteen make a text no market asks.
    db.insert(measurementQueryTemplates).values([
      ...large.marketPhrases.map((phrase, index) => ({ id: `tpl-${index}`, name: phrase, pattern: `${phrase} in {market}` })),
      ...Array.from({ length: 16 }, (_, index) => ({ id: `tpl-unused-${index}`, name: `unused ${index}`, pattern: `homes near stop ${index} in {market}` })),
    ].map(pattern => ({ ...pattern, projectId: PROJECT_ID, description: null, variables: ['market'], createdAt: NOW, updatedAt: NOW }))).run()

    // The workspace read with its views: one plan parse and one read of the saved patterns each time.
    const parses = vi.mocked(parseStoredMeasurementPlanAnyVersion)
    const reads = recordReads()
    parses.mockClear()
    const board = await measure<QueryTrackingWorkspaceResponse>('/query-tracking')
    expect(parses).toHaveBeenCalledTimes(5)
    expect(count(reads, 'measurement_query_templates')).toBe(5)
    vi.mocked(db.select).mockRestore()
    // Location 0 sits in its own market alone and locations 140 to 189 sit in none, so their two queries are
    // their own. Every other location's queries leave out a market it belongs to, which makes them hand-picked.
    expect(board.body.views?.noPropertyQueries.count).toBe(190 - 51)
    expect(board.body.views?.noPropertyQueries.targetKeys).toHaveLength(190 - 51)
    // Every market has exactly four market queries: at the floor, so none is thin.
    expect(board.body.views?.thinMarkets).toStrictEqual({ count: 0, floor: 4, marketKeys: [] })
    // Three patterns are asked in all 137 markets. Market 5 words its parking query another way.
    const marketKeys = Array.from({ length: 137 }, (_, market) => `market-${market}`).sort()
    expect(board.body.views?.patternGaps).toStrictEqual({
      count: 1,
      // All 20 saved patterns fill in a market, the 16 unused ones included.
      compared: 20,
      patterns: [{
        templateId: 'tpl-3', name: 'homes with parking', pattern: 'homes with parking in {market}',
        usedMarketKeys: marketKeys.filter(marketKey => marketKey !== 'market-5'), missingMarketKeys: ['market-5'],
      }],
    })

    // Tracking changed: one query is reworded, so the read parses two large plans and signs every assignment.
    activate(seedVersion(20, planOf({ ...large, texts: { ...large.texts, 'q-loc-0-0': 'Harbor 000 resident reviews' } })))
    const changed = await measure()
    expect(changed.body.run).toMatchObject({ revision: 19, matchesCurrentTracking: false })
    expect(changed.body.rows).toHaveLength(939)
    expect(changed.body.pendingRows).toBe(1)
    expect(answersOf(changed.body, 'mentionedAnswers')).toBe(seeded(3, 'q-loc-0-0', quietMarket))
    expect(answersOf(changed.body, 'citedAnswers')).toBe(seeded(5, 'q-loc-0-0'))
    // The reworded query is a location's own, so the same markets are weak.
    expect(changed.body.weakMarkets).toStrictEqual(quietMarkets)
    // Its three answers are in no total.
    expect(changed.body.totals!.map(total => [total.queryClass, total.queries, total.answers])).toEqual([['branded', 379, 1_137], ['non-brand', 560, 1_680]])

    // One query of that portfolio, read under the older plan: two large plans parsed, and only its three answers loaded.
    const selects = recordSnapshotSelects()
    parses.mockClear()
    const one = await measure('/query-tracking/results?queryId=q-market-3-0')
    expect(parses).toHaveBeenCalledTimes(10)
    expect(selects.map(select => select.rows)).toEqual([3, 3, 3, 3, 3])
    vi.mocked(db.select).mockRestore()
    expect(rowKeys(one.body)).toEqual(['q-market-3-0 non-brand'])
    // Apart from its answers, each engine entry is the one the whole read returns.
    expect(one.body.rows[0]!.engines.map(({ answerRows: _answerRows, ...entry }) => entry)).toStrictEqual(rowOf(changed.body, 'q-market-3-0', 'non-brand')!.engines)
    expect(one.body.rows[0]!.engines.map(entry => entry.answerRows!.length)).toEqual([1, 1, 1])
    expect(one.best).toBeLessThan(BY_QUERY_BUDGET_MS)

    console.info(`query-tracking results, one query of 940 after a tracking change: median ${one.median.toFixed(0)} ms (best ${one.best.toFixed(0)})`)
    console.info(`query-tracking results, 940 queries x 3 engines over 20 revisions: median ${current.median.toFixed(0)} ms (best ${current.best.toFixed(0)}), ${changed.median.toFixed(0)} ms (best ${changed.best.toFixed(0)}) after a tracking change`)
    console.info(`query-tracking workspace with views, 940 queries, 190 locations, 137 markets: median ${board.median.toFixed(0)} ms (best ${board.best.toFixed(0)})`)
    expect(board.best).toBeLessThan(WORKSPACE_BUDGET_MS)
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
  const marketPhrases = ['best homes', 'pet friendly homes', 'luxury homes', 'homes with parking']
  for (let market = 0; market < markets; market++) {
    const members = Array.from({ length: 4 }, (_, offset) => targets[(market + offset) % locations]!)
    for (let asked = 0; asked < 4; asked++) {
      const queryId = `q-market-${market}-${asked}`
      // The market's label is its key. Market 5 words its last query its own way.
      texts[queryId] = market === 5 && asked === 3 ? 'homes with a garage in market-5' : `${marketPhrases[asked]} in market-${market}`
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
  return { targets, texts, pairings, groups: [], subject, order, marketPhrases }
}
