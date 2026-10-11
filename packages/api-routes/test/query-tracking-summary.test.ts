import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq, getTableName, type Table } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QUERY_TRACKING_THIN_MARKET_FLOOR,
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  queryTrackingPreviewResponseSchema,
  queryTrackingWorkspaceResponseSchema,
  type MeasurementPlanV2,
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
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-09-04T00:00:00.000Z'
const PROJECT_ID = 'project-northstar'
const ROOT_KEY = 'cnry_tracking_summary_root'
const ALPHA = { label: 'alpha', city: 'Alpha', region: 'AA', country: 'US' }
const BETA = { label: 'beta', city: 'Beta', region: 'BB', country: 'US' }
/** One engine, so an execution here is one answer. */
const ONE_ENGINE = { providers: ['openai'], models: { openai: 'gpt-test' }, location: ALPHA }
/** Two engines, so an execution here is two answers. */
const TWO_ENGINES = { providers: ['gemini', 'openai'], models: { gemini: 'gemini-test', openai: 'gpt-test' }, location: BETA }

let directory: string
let db: DatabaseClient
let app: FastifyInstance

type Edge = { executionNodeKey: string; targetKey: string; queryId: string }

function target(stableKey: string, label: string) {
  return {
    stableKey, label, aliases: [label],
    urlMatchers: [{ kind: 'prefix' as const, host: 'northstar.example', pathPrefix: `/${stableKey}`, pathCase: 'insensitive' as const }],
    mentionNotApplicable: false, discoveryIdentity: null,
  }
}

function sealed(draft: MeasurementPlanV2): MeasurementPlanV2 {
  const compiledChecksum = crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(draft)).digest('hex')
  return measurementPlanV2Schema.parse({ ...draft, compiledChecksum })
}

/**
 * Four locations, three groups and three markets:
 * - Uptown holds Harbor and River. `n-market` and `n-mixed` are each one execution both share.
 * - Downtown holds Summit alone, so Type decides its two queries' Subject.
 * - Vacant holds nothing. Lone Pine is in no market.
 * `q-lone` is asked at two search locations with a different class at each, and
 * `q-mixed` is Branded for Harbor and Non-brand for River.
 */
function portfolioPlan(): MeasurementPlanV2 {
  const pairings: Array<Edge & { queryClass: 'branded' | 'non-brand'; market?: string }> = [
    { queryId: 'q-market', targetKey: 'harbor', executionNodeKey: 'n-market', queryClass: 'non-brand', market: 'uptown' },
    { queryId: 'q-market', targetKey: 'river', executionNodeKey: 'n-market', queryClass: 'non-brand', market: 'uptown' },
    { queryId: 'q-harbor', targetKey: 'harbor', executionNodeKey: 'n-harbor', queryClass: 'branded', market: 'uptown' },
    { queryId: 'q-mixed', targetKey: 'harbor', executionNodeKey: 'n-mixed', queryClass: 'branded', market: 'uptown' },
    { queryId: 'q-mixed', targetKey: 'river', executionNodeKey: 'n-mixed', queryClass: 'non-brand', market: 'uptown' },
    { queryId: 'q-summit-brand', targetKey: 'summit', executionNodeKey: 'n-summit-brand', queryClass: 'branded', market: 'downtown' },
    { queryId: 'q-summit-market', targetKey: 'summit', executionNodeKey: 'n-summit-market', queryClass: 'non-brand', market: 'downtown' },
    { queryId: 'q-custom', targetKey: 'harbor', executionNodeKey: 'n-custom', queryClass: 'non-brand' },
    { queryId: 'q-custom', targetKey: 'summit', executionNodeKey: 'n-custom', queryClass: 'non-brand' },
    { queryId: 'q-lone', targetKey: 'lone', executionNodeKey: 'n-lone-a', queryClass: 'non-brand' },
    { queryId: 'q-lone', targetKey: 'lone', executionNodeKey: 'n-lone-b', queryClass: 'branded' },
  ]
  const edge = ({ executionNodeKey, targetKey, queryId }: Edge): Edge => ({ executionNodeKey, targetKey, queryId })
  const texts: Record<string, string> = {
    'q-market': 'best apartments uptown',
    'q-harbor': 'harbor point reviews',
    'q-mixed': 'harbor point or river point',
    'q-summit-brand': 'summit lofts pricing',
    'q-summit-market': 'lofts downtown',
    'q-custom': 'apartments with parking',
    'q-lone': 'lone pine availability',
  }
  const nodes: Array<[string, string, typeof ONE_ENGINE | typeof TWO_ENGINES]> = [
    ['n-market', 'q-market', TWO_ENGINES],
    ['n-harbor', 'q-harbor', ONE_ENGINE],
    ['n-mixed', 'q-mixed', TWO_ENGINES],
    ['n-summit-brand', 'q-summit-brand', ONE_ENGINE],
    ['n-summit-market', 'q-summit-market', TWO_ENGINES],
    ['n-custom', 'q-custom', ONE_ENGINE],
    ['n-lone-a', 'q-lone', ONE_ENGINE],
    ['n-lone-b', 'q-lone', TWO_ENGINES],
  ]
  return sealed(measurementPlanV2Fixture({
    targets: [target('harbor', 'Harbor Point'), target('river', 'River Point'), target('summit', 'Summit Lofts'), target('lone', 'Lone Pine')],
    groups: [
      {
        stableKey: 'metro', label: 'Metro', targetKeys: ['harbor', 'river', 'summit'],
        competitors: [
          { stableKey: 'rival', label: 'Rival', domain: 'rival.example', aliases: [] },
          { stableKey: 'other', label: 'Other', domain: 'other.example', aliases: [] },
        ],
      },
      {
        // The same competitor as Metro's, stored under another host.
        stableKey: 'north', label: 'North', parentGroupKey: 'metro', targetKeys: ['harbor', 'river'],
        competitors: [{ stableKey: 'rival-shop', label: 'Rival', domain: 'www.rival.example', aliases: [] }],
      },
      {
        stableKey: 'solo', label: 'Solo', targetKeys: ['lone'],
        competitors: [{ stableKey: 'third', label: 'Third', domain: 'third.example', aliases: [] }],
      },
    ],
    querySnapshots: Object.entries(texts).map(([queryId, queryText]) => ({
      queryId, queryText,
      // A pattern row published before query control froze the pattern record.
      provenance: queryId === 'q-market'
        ? { source: 'template' as const, sourceId: 'tpl-market@1', capturedAt: NOW }
        : { source: 'manual' as const, sourceId: null, capturedAt: NOW },
    })),
    assignments: pairings.map(pairing => ({ ...edge(pairing), queryClass: pairing.queryClass, classificationSource: 'server' as const })),
    executionNodes: nodes.map(([stableKey, queryId, context]) => ({
      stableKey, queryId, queryText: texts[queryId]!, context, expectedSnapshots: context.providers.length,
    })),
    usageEdges: pairings.map(edge),
    reportingScopes: [
      { stableKey: 'downtown', label: 'Downtown', kind: 'market', groupKey: 'metro', usageEdges: pairings.filter(pairing => pairing.market === 'downtown').map(edge) },
      { stableKey: 'uptown', label: 'Uptown', kind: 'market', groupKey: 'north', usageEdges: pairings.filter(pairing => pairing.market === 'uptown').map(edge) },
      { stableKey: 'vacant', label: 'Vacant', kind: 'market', usageEdges: [] },
    ],
  }))
}

/** `count` location queries on Harbor Point, each its own one-answer execution. */
function crowdedPlan(count: number): MeasurementPlanV2 {
  const ids = Array.from({ length: count }, (_, index) => `q-fill-${index}`)
  const edges = ids.map(queryId => ({ executionNodeKey: `n-${queryId}`, targetKey: 'harbor', queryId }))
  return sealed(measurementPlanV2Fixture({
    targets: [target('harbor', 'Harbor Point')],
    groups: [],
    querySnapshots: ids.map(queryId => ({ queryId, queryText: `filler ${queryId}`, provenance: { source: 'manual' as const, sourceId: null, capturedAt: NOW } })),
    assignments: edges.map(row => ({ ...row, queryClass: 'non-brand' as const, classificationSource: 'server' as const })),
    executionNodes: edges.map(row => ({ stableKey: row.executionNodeKey, queryId: row.queryId, queryText: `filler ${row.queryId}`, context: ONE_ENGINE, expectedSnapshots: 1 })),
    usageEdges: edges,
  }))
}

/**
 * Harbor and River sit in two markets, Summit in one:
 * - Citywide holds all three and has two market queries.
 * - Uptown holds Harbor and River and has one.
 * `q-harbor` is Harbor's own query, so it sits in both of Harbor's markets.
 */
function overlapPlan(): MeasurementPlanV2 {
  const pairings: Array<Edge & { queryClass: 'branded' | 'non-brand'; markets: string[] }> = [
    ...['harbor', 'river', 'summit'].flatMap(targetKey => [
      { queryId: 'q-city', targetKey, executionNodeKey: 'n-city', queryClass: 'non-brand' as const, markets: ['citywide'] },
      { queryId: 'q-city-b', targetKey, executionNodeKey: 'n-city-b', queryClass: 'non-brand' as const, markets: ['citywide'] },
    ]),
    { queryId: 'q-up', targetKey: 'harbor', executionNodeKey: 'n-up', queryClass: 'non-brand', markets: ['uptown'] },
    { queryId: 'q-up', targetKey: 'river', executionNodeKey: 'n-up', queryClass: 'non-brand', markets: ['uptown'] },
    { queryId: 'q-harbor', targetKey: 'harbor', executionNodeKey: 'n-harbor', queryClass: 'branded', markets: ['citywide', 'uptown'] },
  ]
  const edge = ({ executionNodeKey, targetKey, queryId }: Edge): Edge => ({ executionNodeKey, targetKey, queryId })
  const nodes: Array<[string, string, string, typeof ONE_ENGINE | typeof TWO_ENGINES]> = [
    ['n-city', 'q-city', 'best apartments in the city', TWO_ENGINES],
    ['n-city-b', 'q-city-b', 'city apartments with parking', ONE_ENGINE],
    ['n-up', 'q-up', 'best apartments uptown', ONE_ENGINE],
    ['n-harbor', 'q-harbor', 'harbor point reviews', TWO_ENGINES],
  ]
  return sealed(measurementPlanV2Fixture({
    targets: [target('harbor', 'Harbor Point'), target('river', 'River Point'), target('summit', 'Summit Lofts')],
    groups: [],
    querySnapshots: nodes.map(([, queryId, queryText]) => ({ queryId, queryText, provenance: { source: 'manual' as const, sourceId: null, capturedAt: NOW } })),
    assignments: pairings.map(pairing => ({ ...edge(pairing), queryClass: pairing.queryClass, classificationSource: 'server' as const })),
    executionNodes: nodes.map(([stableKey, queryId, queryText, context]) => ({
      stableKey, queryId, queryText, context, expectedSnapshots: context.providers.length,
    })),
    usageEdges: pairings.map(edge),
    reportingScopes: [['citywide', 'Citywide'], ['uptown', 'Uptown']].map(([stableKey, label]) => ({
      stableKey: stableKey!, label: label!, kind: 'market' as const,
      usageEdges: pairings.filter(pairing => pairing.markets.includes(stableKey!)).map(edge),
    })),
  }))
}

/** A plan the compiler never publishes: `q-ghost` is assigned, but nothing stores its text. */
function ghostPlan(): MeasurementPlanV2 {
  const edges = [
    { executionNodeKey: 'n-real', targetKey: 'harbor', queryId: 'q-real' },
    { executionNodeKey: 'n-ghost', targetKey: 'harbor', queryId: 'q-ghost' },
  ]
  return sealed(measurementPlanV2Fixture({
    targets: [target('harbor', 'Harbor Point')],
    groups: [],
    querySnapshots: [{ queryId: 'q-real', queryText: 'apartments with parking', provenance: { source: 'manual' as const, sourceId: null, capturedAt: NOW } }],
    assignments: edges.map(row => ({ ...row, queryClass: 'non-brand' as const, classificationSource: 'server' as const })),
    executionNodes: edges.map(row => ({ stableKey: row.executionNodeKey, queryId: row.queryId, queryText: 'apartments with parking', context: ONE_ENGINE, expectedSnapshots: 1 })),
    usageEdges: edges,
  }))
}

const SAVED_FIRST = '2026-08-01T00:00:00.000Z'
const SAVED_AGAIN = '2026-09-01T00:00:00.000Z'

/** The record query control freezes on a row it expands from a saved pattern. */
function frozenPattern(templateId: string, templateVersion: string, template: string, bindings: Record<string, string>) {
  const output = Object.entries(bindings).reduce((text, [variable, value]) => text.replace(`{${variable}}`, value), template)
  return {
    source: 'template' as const, sourceId: `${templateId}@${templateVersion}`, capturedAt: NOW,
    template: { templateId, templateVersion, template, bindings, output },
  }
}

/**
 * Five locations and four markets, each query its own one-answer execution:
 * - Uptown (Harbor, River) has four market queries, exactly the floor.
 * - Downtown (Summit, Cedar) has three, and Lakeside (Lone Pine alone) has two.
 * - Vacant holds no location.
 * The Best pattern is asked in all three markets with a location. The Pets
 * pattern is asked in Uptown only, and the deleted Lofts pattern in Downtown
 * and, under a later wording, Lakeside. Harbor and Cedar each have a query of
 * their own.
 */
function viewsPlan(): MeasurementPlanV2 {
  const best = (market: string) => frozenPattern('tpl-best', SAVED_FIRST, 'best apartments in {market}', { market })
  const pets = (market: string) => frozenPattern('tpl-pets', SAVED_FIRST, 'pet friendly apartments in {market}', { market })
  const rows: Array<{
    queryId: string; text: string; targets: string[]; market?: string
    queryClass?: 'branded'; pattern?: ReturnType<typeof frozenPattern>
  }> = [
    { queryId: 'q-up-best', text: 'best apartments in Uptown', targets: ['harbor', 'river'], market: 'uptown', pattern: best('Uptown') },
    { queryId: 'q-up-pets', text: 'pet friendly apartments in Uptown', targets: ['harbor', 'river'], market: 'uptown', pattern: pets('Uptown') },
    { queryId: 'q-up-parking', text: 'apartments with parking uptown', targets: ['harbor', 'river'], market: 'uptown' },
    { queryId: 'q-up-pool', text: 'apartments with a pool uptown', targets: ['harbor', 'river'], market: 'uptown' },
    { queryId: 'q-down-best', text: 'best apartments in Downtown', targets: ['summit', 'cedar'], market: 'downtown', pattern: best('Downtown') },
    {
      queryId: 'q-down-lofts', text: 'luxury lofts in Downtown', targets: ['summit', 'cedar'], market: 'downtown',
      pattern: frozenPattern('tpl-lofts', SAVED_FIRST, 'luxury lofts in {market}', { market: 'Downtown' }),
    },
    { queryId: 'q-down-parking', text: 'apartments with parking downtown', targets: ['summit', 'cedar'], market: 'downtown' },
    // A market of one location: Non-brand keeps both queries the market's.
    { queryId: 'q-lake-best', text: 'best apartments in Lakeside', targets: ['lone'], market: 'lakeside', pattern: best('Lakeside') },
    {
      queryId: 'q-lake-lofts', text: 'luxury loft rentals in Lakeside', targets: ['lone'], market: 'lakeside',
      pattern: frozenPattern('tpl-lofts', SAVED_AGAIN, 'luxury loft rentals in {market}', { market: 'Lakeside' }),
    },
    // Harbor's own query, from a location pattern: a pattern row that is no market's.
    {
      queryId: 'q-harbor', text: 'Harbor Point reviews', targets: ['harbor'], market: 'uptown', queryClass: 'branded',
      pattern: frozenPattern('tpl-reviews', SAVED_FIRST, '{property} reviews', { property: 'Harbor Point' }),
    },
    // Cedar's own query inside Downtown, and one hand-picked at Summit outside it: neither is Downtown's use of the Pets pattern.
    { queryId: 'q-cedar-pets', text: 'pet friendly apartments in Cedar', targets: ['cedar'], market: 'downtown', pattern: pets('Cedar') },
    { queryId: 'q-pick-pets', text: 'pet friendly apartments in Midtown', targets: ['summit'], pattern: pets('Midtown') },
  ]
  const edges = rows.flatMap(row => row.targets.map(targetKey => ({ executionNodeKey: `n-${row.queryId}`, targetKey, queryId: row.queryId, market: row.market })))
  const edge = ({ executionNodeKey, targetKey, queryId }: Edge): Edge => ({ executionNodeKey, targetKey, queryId })
  const classes = new Map(rows.map(row => [row.queryId, row.queryClass ?? 'non-brand' as const]))
  return sealed(measurementPlanV2Fixture({
    targets: [target('harbor', 'Harbor Point'), target('river', 'River Point'), target('summit', 'Summit Lofts'), target('cedar', 'Cedar Court'), target('lone', 'Lone Pine')],
    groups: [],
    querySnapshots: rows.map(row => ({
      queryId: row.queryId, queryText: row.text,
      provenance: row.pattern ?? { source: 'manual' as const, sourceId: null, capturedAt: NOW },
    })),
    assignments: edges.map(row => ({ ...edge(row), queryClass: classes.get(row.queryId)!, classificationSource: 'server' as const })),
    executionNodes: rows.map(row => ({ stableKey: `n-${row.queryId}`, queryId: row.queryId, queryText: row.text, context: ONE_ENGINE, expectedSnapshots: 1 })),
    usageEdges: edges.map(edge),
    reportingScopes: [['downtown', 'Downtown'], ['lakeside', 'Lakeside'], ['uptown', 'Uptown'], ['vacant', 'Vacant']].map(([stableKey, label]) => ({
      stableKey: stableKey!, label: label!, kind: 'market' as const, usageEdges: edges.filter(row => row.market === stableKey).map(edge),
    })),
  }))
}

/** A saved pattern as the pattern routes store it. */
function savePattern(id: string, name: string, pattern: string): void {
  db.insert(measurementQueryTemplates).values({
    id, projectId: PROJECT_ID, name, description: null, pattern, variables: ['market'], createdAt: SAVED_FIRST, updatedAt: SAVED_AGAIN,
  }).run()
}

/** How many times a read selects from `table`. */
function countReadsOf(table: string): () => number {
  let reads = 0
  const select = db.select.bind(db) as (...args: unknown[]) => { from: (source: Table) => unknown }
  vi.spyOn(db, 'select').mockImplementation(((...args: unknown[]) => {
    const builder = select(...args)
    const from = builder.from.bind(builder)
    builder.from = (source: Table) => {
      if (getTableName(source) === table) reads += 1
      return from(source)
    }
    return builder
  }) as typeof db.select)
  return () => reads
}

function activate(plan: MeasurementPlanV2): void {
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.insert(measurementPlanVersions).values({
    id: 'plan-v1', projectId: PROJECT_ID, revision: 1, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, comparableToVersionId: null, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId: PROJECT_ID, activeVersionId: 'plan-v1', createdAt: NOW, updatedAt: NOW }).run()
}

function insertQueries(rows: Record<string, string>): void {
  db.insert(queries).values(Object.entries(rows).map(([id, query]) => ({ id, projectId: PROJECT_ID, query, provenance: null, createdAt: NOW }))).run()
}

/** The portfolio plus one catalog query that no location is paired with. */
function seedPortfolio(): void {
  activate(portfolioPlan())
  insertQueries({ 'q-idle': 'apartments near transit' })
}

function seedSimple(): void {
  insertQueries({ 'q-brand': 'northstar reviews', 'q-downtown': 'best apartments downtown', 'q-transit': 'apartments near transit' })
}

/** A project with no name and no domain has nothing to classify a query against. */
function seedSimpleWithoutBrand(): void {
  seedSimple()
  db.update(projects).set({ displayName: '', canonicalDomain: '', ownedDomains: [], aliases: [] }).where(eq(projects.id, PROJECT_ID)).run()
}

/** The served JSON, checked against the contract and returned exactly as sent. */
async function workspace(): Promise<QueryTrackingWorkspaceResponse> {
  const response = await app.inject({
    method: 'GET', url: '/api/v1/projects/northstar/query-tracking', headers: { authorization: `Bearer ${ROOT_KEY}` },
  })
  expect(response.statusCode, response.body).toBe(200)
  const body = response.json() as QueryTrackingWorkspaceResponse
  expect(queryTrackingWorkspaceResponseSchema.parse(body)).toStrictEqual(body)
  return body
}

async function preview(mutation: { additions?: unknown[]; removals?: unknown[] }) {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/projects/northstar/query-tracking/preview', headers: { authorization: `Bearer ${ROOT_KEY}` },
    payload: { expectedWorkspaceVersion: (await workspace()).workspaceVersion, additions: [], removals: [], ...mutation },
  })
  expect(response.statusCode, response.body).toBe(200)
  return queryTrackingPreviewResponseSchema.parse(response.json())
}

/** Reviews a change, then publishes exactly what was reviewed. */
async function publish(mutation: { additions?: unknown[]; removals?: unknown[] }) {
  const review = await preview(mutation)
  const response = await app.inject({
    method: 'POST', url: '/api/v1/projects/northstar/query-tracking/commit', headers: { authorization: `Bearer ${ROOT_KEY}` },
    payload: {
      expectedWorkspaceVersion: review.workspaceVersion, additions: [], removals: [], ...mutation,
      previewToken: review.previewToken, reviewedAt: review.reviewedAt,
    },
  })
  expect(response.statusCode, response.body).toBe(200)
  return review
}

const total = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0)

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-tracking-summary-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: PROJECT_ID, name: 'northstar', displayName: 'Northstar', canonicalDomain: 'northstar.example',
    ownedDomains: [], aliases: [], country: 'US', language: 'en', providers: ['gemini', 'openai'],
    providerModels: { gemini: 'gemini-test', openai: 'gpt-test' }, locations: [ALPHA, BETA], defaultLocation: 'alpha',
    createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'root', keyHash: hashApiKey(ROOT_KEY), keyPrefix: ROOT_KEY.slice(0, 9),
    scopes: ['*'], projectId: null, createdAt: NOW,
  }).run()
  app = Fastify()
  app.register(apiRoutes, { db, getRunnableProviderNames: () => ['gemini', 'openai'] })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('query tracking workspace summary: advanced portfolio', () => {
  it('counts asked rows by Type and Subject, plan assignments, answers and structure', async () => {
    seedPortfolio()
    const current = await workspace()

    expect(current.tracked).toHaveLength(8)
    expect(current.summary).toStrictEqual({
      asked: 7,
      notAsked: 1,
      // q-mixed and q-lone hold both classes, so neither class counts them.
      byClass: { branded: 2, nonBrand: 3, mixed: 2, unknown: 0 },
      byFocus: { market: 3, property: 3, company: 0, custom: 1 },
      // Eleven pairings: one more than the ten (query, location) pairs the rows list.
      assignments: { total: 11, branded: 4, nonBrand: 7, unknown: 0 },
      // Eight executions: five of one answer and three of two. Shared ones count once.
      answersPerSweep: 12,
      // Rival is pinned by two groups under two hosts and counts once.
      structure: { targets: 4, markets: 3, groups: 3, topLevelGroups: 2, competitors: 3 },
    })
    expect(total(current.tracked.map(row => row.assignments.length))).toBe(10)
  })

  it('gives each row its Type from every assignment, beside its Subject', async () => {
    seedPortfolio()
    const rows = (await workspace()).tracked

    expect(Object.fromEntries(rows.map(row => [row.queryId, [row.focus, row.queryClasses]]))).toStrictEqual({
      'q-market': [{ kind: 'market', key: 'uptown' }, ['non-brand']],
      'q-harbor': [{ kind: 'property', key: 'harbor' }, ['branded']],
      'q-mixed': [{ kind: 'market', key: 'uptown' }, ['branded', 'non-brand']],
      'q-summit-brand': [{ kind: 'property', key: 'summit' }, ['branded']],
      'q-summit-market': [{ kind: 'market', key: 'downtown' }, ['non-brand']],
      'q-custom': [{ kind: 'custom' }, ['non-brand']],
      'q-lone': [{ kind: 'property', key: 'lone' }, ['branded', 'non-brand']],
      'q-idle': [{ kind: 'not-asked' }, []],
    })
    // The one location row shows a single class; the Type still reports both.
    expect(rows.find(row => row.queryId === 'q-lone')?.assignments.map(assignment => [assignment.targetKey, assignment.queryClass]))
      .toStrictEqual([['lone', 'non-brand']])
  })

  it('counts each location, market and group, with a shared execution once per place', async () => {
    seedPortfolio()
    const current = await workspace()

    expect(current.targets.map(({ stableKey, marketKeys, counts }) => ({ stableKey, marketKeys, counts }))).toStrictEqual([
      { stableKey: 'harbor', marketKeys: ['uptown'], counts: { propertyQueries: 1, marketQueries: 2, customQueries: 1, answersPerSweep: 6 } },
      { stableKey: 'lone', marketKeys: [], counts: { propertyQueries: 1, marketQueries: 0, customQueries: 0, answersPerSweep: 3 } },
      { stableKey: 'river', marketKeys: ['uptown'], counts: { propertyQueries: 0, marketQueries: 2, customQueries: 0, answersPerSweep: 4 } },
      { stableKey: 'summit', marketKeys: ['downtown'], counts: { propertyQueries: 1, marketQueries: 1, customQueries: 1, answersPerSweep: 4 } },
    ])
    expect(current.markets.map(({ stableKey, targetKeys, counts }) => ({ stableKey, targetKeys, counts }))).toStrictEqual([
      { stableKey: 'downtown', targetKeys: ['summit'], counts: { marketQueries: 1, propertyQueries: 1, answersPerSweep: 3 } },
      { stableKey: 'uptown', targetKeys: ['harbor', 'river'], counts: { marketQueries: 2, propertyQueries: 1, answersPerSweep: 5 } },
      { stableKey: 'vacant', targetKeys: [], counts: { marketQueries: 0, propertyQueries: 0, answersPerSweep: 0 } },
    ])
    expect(current.groups.map(({ stableKey, counts }) => ({ stableKey, counts }))).toStrictEqual([
      { stableKey: 'metro', counts: { queries: 6, markets: 1, answersPerSweep: 9 } },
      { stableKey: 'north', counts: { queries: 4, markets: 1, answersPerSweep: 6 } },
      { stableKey: 'solo', counts: { queries: 1, markets: 0, answersPerSweep: 3 } },
    ])

    // n-market (two answers) serves Harbor and River: each location counts it, the project counts it once.
    const locationAnswers = total(current.targets.map(place => place.counts!.answersPerSweep))
    expect(locationAnswers).toBe(17)
    expect(current.summary!.answersPerSweep).toBe(12)
  })

  it('adds a market query to each location once per market that holds it', async () => {
    activate(overlapPlan())
    const current = await workspace()

    // Harbor and River take Citywide's two market queries and Uptown's one.
    expect(current.targets.map(({ stableKey, marketKeys, counts }) => ({ stableKey, marketKeys, counts }))).toStrictEqual([
      { stableKey: 'harbor', marketKeys: ['citywide', 'uptown'], counts: { propertyQueries: 1, marketQueries: 3, customQueries: 0, answersPerSweep: 6 } },
      { stableKey: 'river', marketKeys: ['citywide', 'uptown'], counts: { propertyQueries: 0, marketQueries: 3, customQueries: 0, answersPerSweep: 4 } },
      { stableKey: 'summit', marketKeys: ['citywide'], counts: { propertyQueries: 0, marketQueries: 2, customQueries: 0, answersPerSweep: 3 } },
    ])
    // Harbor's own query counts in both of its markets.
    expect(current.markets.map(({ stableKey, targetKeys, counts }) => ({ stableKey, targetKeys, counts }))).toStrictEqual([
      { stableKey: 'citywide', targetKeys: ['harbor', 'river', 'summit'], counts: { marketQueries: 2, propertyQueries: 1, answersPerSweep: 5 } },
      { stableKey: 'uptown', targetKeys: ['harbor', 'river'], counts: { marketQueries: 1, propertyQueries: 1, answersPerSweep: 3 } },
    ])
    // A market query stays one row, however many of its locations another market shares.
    expect(current.summary?.byFocus).toStrictEqual({ market: 3, property: 1, company: 0, custom: 0 })
    expect(total(current.markets.map(market => market.counts!.marketQueries))).toBe(3)
    expect(current.summary?.answersPerSweep).toBe(6)
  })

  it('reads a pattern row whose plan froze no pattern record as a pattern', async () => {
    seedPortfolio()
    const row = (await workspace()).tracked.find(candidate => candidate.queryId === 'q-market')

    expect(row?.provenance).toStrictEqual({ source: 'template', sourceId: 'tpl-market@1', capturedAt: NOW })
  })

  it('keeps that pattern source when the query is added to another market', async () => {
    seedPortfolio()
    const review = await publish({
      additions: [{ input: { source: 'manual', text: 'best apartments uptown' }, audience: { marketKeys: ['downtown'] } }],
    })

    expect([review.diff.added, review.diff.reused.map(row => row.queryId)]).toStrictEqual([[], ['q-market']])
    // The catalog row keeps the frozen source and its first capture time, not this manual add.
    expect(db.select().from(queries).where(eq(queries.id, 'q-market')).get()?.provenance)
      .toBe(`query-tracking/v1:{"capturedAt":"${NOW}","source":"template","sourceId":"tpl-market@1"}`)
    const row = (await workspace()).tracked.find(candidate => candidate.queryId === 'q-market')
    expect(row?.provenance).toStrictEqual({ source: 'template', sourceId: 'tpl-market@1', capturedAt: NOW })
    expect(row?.assignments.map(assignment => assignment.targetKey)).toStrictEqual(['harbor', 'river', 'summit'])
  })

  it('reports the room under the limit on the read and on a preview', async () => {
    seedPortfolio()
    const current = await workspace()
    expect(current.limits).toStrictEqual({ queries: { current: 7, next: 7, max: 1_000, left: { current: 993, next: 993 } } })

    const added = await preview({
      additions: [{ input: { source: 'manual', text: 'apartments with a pool' }, audience: { marketKeys: ['uptown'] } }],
    })
    expect(added.limits).toStrictEqual({ queries: { current: 7, next: 8, max: 1_000, left: { current: 993, next: 992 } } })
    expect(added.tracked.find(row => row.queryText === 'apartments with a pool'))
      .toMatchObject({ focus: { kind: 'market', key: 'uptown' }, queryClasses: ['non-brand'] })
  })

  it('reports no room, never a negative one, for a plan over the limit', async () => {
    activate(crowdedPlan(1_002))
    const current = await workspace()
    expect(current.summary).toMatchObject({ asked: 1_002, notAsked: 0, answersPerSweep: 1_002 })
    expect(current.limits).toStrictEqual({ queries: { current: 1_002, next: 1_002, max: 1_000, left: { current: 0, next: 0 } } })

    const shrunk = await preview({ removals: [{ queryId: 'q-fill-0' }, { queryId: 'q-fill-1' }, { queryId: 'q-fill-2' }] })
    expect(shrunk.limits).toStrictEqual({ queries: { current: 1_002, next: 999, max: 1_000, left: { current: 0, next: 1 } } })
  })

  it('counts the rows it lists when a plan assigns a query whose text nothing stores', async () => {
    activate(ghostPlan())
    const current = await workspace()

    // The summary describes the listed rows, so its breakdowns never disagree with them.
    expect(current.tracked.map(row => row.queryId)).toStrictEqual(['q-real'])
    expect(current.summary).toMatchObject({
      asked: 1, notAsked: 0,
      byClass: { branded: 0, nonBrand: 1, mixed: 0, unknown: 0 },
      byFocus: { market: 0, property: 1, company: 0, custom: 0 },
      assignments: { total: 2, branded: 0, nonBrand: 2, unknown: 0 },
      answersPerSweep: 2,
    })
    // The limit stays the compiler's count, the one a publish is checked against.
    expect(current.limits).toStrictEqual({ queries: { current: 2, next: 2, max: 1_000, left: { current: 998, next: 998 } } })
  })

  it('returns zero counts for a plan with locations and no queries', async () => {
    activate(sealed(measurementPlanV2Fixture({
      targets: [target('harbor', 'Harbor Point')],
      groups: [{ stableKey: 'metro', label: 'Metro', targetKeys: ['harbor'], competitors: [] }],
      querySnapshots: [], assignments: [], executionNodes: [], usageEdges: [],
      reportingScopes: [{ stableKey: 'vacant', label: 'Vacant', kind: 'market', usageEdges: [] }],
    })))
    const current = await workspace()

    expect(current.tracked).toStrictEqual([])
    expect(current.summary).toStrictEqual({
      asked: 0, notAsked: 0,
      byClass: { branded: 0, nonBrand: 0, mixed: 0, unknown: 0 },
      byFocus: { market: 0, property: 0, company: 0, custom: 0 },
      assignments: { total: 0, branded: 0, nonBrand: 0, unknown: 0 },
      answersPerSweep: 0,
      structure: { targets: 1, markets: 1, groups: 1, topLevelGroups: 1, competitors: 0 },
    })
    expect(current.limits).toStrictEqual({ queries: { current: 0, next: 0, max: 1_000, left: { current: 1_000, next: 1_000 } } })
    expect(current.targets[0]).toMatchObject({ marketKeys: [], counts: { propertyQueries: 0, marketQueries: 0, customQueries: 0, answersPerSweep: 0 } })
    expect(current.groups[0]?.counts).toStrictEqual({ queries: 0, markets: 0, answersPerSweep: 0 })
  })
})

describe('query tracking workspace views', () => {
  it('lists locations with no query of their own, thin markets and pattern gaps, each with its count', async () => {
    activate(viewsPlan())
    savePattern('tpl-best', 'Best', 'best apartments in {market}')
    // Reworded since the rows were added: the view shows the pattern as it is saved now.
    savePattern('tpl-pets', 'Pet friendly', 'pet friendly apartments in {market} with a yard')
    const patternReads = countReadsOf('measurement_query_templates')
    const current = await workspace()

    expect(Object.fromEntries(current.tracked.map(row => [row.queryId, row.focus]))).toMatchObject({
      'q-lake-best': { kind: 'market', key: 'lakeside' },
      'q-harbor': { kind: 'property', key: 'harbor' },
      'q-cedar-pets': { kind: 'property', key: 'cedar' },
      'q-pick-pets': { kind: 'custom' },
    })
    expect(current.views).toStrictEqual({
      // Summit's one query is hand-picked and Lone Pine's two are its market's: neither is the location's own.
      noPropertyQueries: { count: 3, targetKeys: ['lone', 'river', 'summit'] },
      // Uptown has exactly four market queries, so it is not thin. Downtown is one short.
      thinMarkets: { count: 3, floor: 4, marketKeys: ['downtown', 'lakeside', 'vacant'] },
      patternGaps: {
        count: 2,
        patterns: [
          // Deleted since: no name, and the wording of the newest row that froze it.
          { templateId: 'tpl-lofts', name: null, pattern: 'luxury loft rentals in {market}', usedMarketKeys: ['downtown', 'lakeside'], missingMarketKeys: ['uptown'] },
          // Cedar's own row and the hand-picked one are not Downtown's. Vacant has no location, so it is never missing.
          { templateId: 'tpl-pets', name: 'Pet friendly', pattern: 'pet friendly apartments in {market} with a yard', usedMarketKeys: ['uptown'], missingMarketKeys: ['downtown', 'lakeside'] },
        ],
      },
    })
    expect(QUERY_TRACKING_THIN_MARKET_FLOOR).toBe(4)
    expect(current.markets.map(market => [market.stableKey, market.counts?.marketQueries])).toStrictEqual([
      ['downtown', 3], ['lakeside', 2], ['uptown', 4], ['vacant', 0],
    ])
    // Two patterns have a gap, and the saved patterns are read once for both.
    expect(patternReads()).toBe(1)
  })

  it('calls a market with no queries thin and reads no saved pattern when none has a gap', async () => {
    seedPortfolio()
    const patternReads = countReadsOf('measurement_query_templates')
    const current = await workspace()

    expect(current.views).toStrictEqual({
      noPropertyQueries: { count: 1, targetKeys: ['river'] },
      // Vacant has no location and no query. Downtown has one query and Uptown two.
      thinMarkets: { count: 3, floor: 4, marketKeys: ['downtown', 'uptown', 'vacant'] },
      // q-market is a pattern row whose plan froze no pattern record, so it belongs to no pattern.
      patternGaps: { count: 0, patterns: [] },
    })
    expect(patternReads()).toBe(0)
  })

  it('finds and closes a gap for a saved pattern added through the pattern and tracking routes', async () => {
    seedPortfolio()
    const headers = { authorization: `Bearer ${ROOT_KEY}` }
    const saved = await app.inject({
      method: 'PUT', url: '/api/v1/projects/northstar/measurement-query-templates/tpl-transit', headers,
      payload: { name: 'Near transit', pattern: 'apartments near transit in {market}', variables: ['market'] },
    })
    expect(saved.statusCode, saved.body).toBe(201)
    const { updatedAt } = saved.json() as { updatedAt: string }
    const addTo = (marketKey: string) => publish({
      additions: [{
        input: { source: 'template', templateId: 'tpl-transit', templateVersion: updatedAt, template: 'apartments near transit in {market}' },
        audience: { marketKeys: [marketKey] },
      }],
    })

    await addTo('uptown')
    const gap = { templateId: 'tpl-transit', usedMarketKeys: ['uptown'], missingMarketKeys: ['downtown'] }
    expect((await workspace()).views?.patternGaps).toStrictEqual({
      count: 1, patterns: [{ ...gap, name: 'Near transit', pattern: 'apartments near transit in {market}' }],
    })

    // The row keeps the pattern it froze after the saved pattern is deleted.
    const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/projects/northstar/measurement-query-templates/tpl-transit', headers })
    expect(deleted.statusCode, deleted.body).toBe(204)
    expect((await workspace()).views?.patternGaps).toStrictEqual({
      count: 1, patterns: [{ ...gap, name: null, pattern: 'apartments near transit in {market}' }],
    })

    const again = await app.inject({
      method: 'PUT', url: '/api/v1/projects/northstar/measurement-query-templates/tpl-transit', headers,
      payload: { name: 'Near transit', pattern: 'apartments near transit in {market}', variables: ['market'] },
    })
    expect(again.statusCode, again.body).toBe(201)
    const version = (again.json() as { updatedAt: string }).updatedAt
    await publish({
      additions: [{
        input: { source: 'template', templateId: 'tpl-transit', templateVersion: version, template: 'apartments near transit in {market}' },
        audience: { marketKeys: ['downtown'] },
      }],
    })
    // Asked in both markets that hold a location: no gap, though Vacant has no such query.
    const closed = await workspace()
    expect(closed.views?.patternGaps).toStrictEqual({ count: 0, patterns: [] })
    expect(closed.markets.map(market => [market.stableKey, market.counts?.marketQueries])).toStrictEqual([['downtown', 2], ['uptown', 3], ['vacant', 0]])
  })

  it('still parses a response from a server that sends no views', async () => {
    seedPortfolio()
    const { views, ...older } = await workspace()

    expect(views).toBeDefined()
    expect(queryTrackingWorkspaceResponseSchema.parse(older)).toStrictEqual(older)
  })
})

describe('query tracking workspace summary: simple site', () => {
  it('classifies every query with the project classifier and counts them all as asked', async () => {
    seedSimple()
    const current = await workspace()

    expect(current.tracked.map(row => [row.queryId, row.focus, row.queryClasses])).toStrictEqual([
      ['q-transit', { kind: 'company' }, ['non-brand']],
      ['q-downtown', { kind: 'company' }, ['non-brand']],
      ['q-brand', { kind: 'company' }, ['branded']],
    ])
    expect(current.summary).toStrictEqual({
      asked: 3, notAsked: 0,
      byClass: { branded: 1, nonBrand: 2, mixed: 0, unknown: 0 },
      byFocus: { market: 0, property: 0, company: 3, custom: 0 },
      assignments: { total: 0, branded: 0, nonBrand: 0, unknown: 0 },
      // Three queries, each asked of two engines at the default search location.
      answersPerSweep: 6,
      structure: { targets: 0, markets: 0, groups: 0, topLevelGroups: 0, competitors: 0 },
    })
    expect(current).not.toHaveProperty('limits')
    // A simple site has no location or market to list.
    expect(current).not.toHaveProperty('views')
    expect([current.targets, current.markets, current.groups]).toStrictEqual([[], [], []])
  })

  it('leaves the class unset, not non-brand, when the project has no usable brand name', async () => {
    seedSimpleWithoutBrand()
    const current = await workspace()

    expect(current.tracked.map(row => row.queryClasses)).toStrictEqual([[], [], []])
    expect(current.summary?.byClass).toStrictEqual({ branded: 0, nonBrand: 0, mixed: 0, unknown: 3 })
    expect(current.summary?.asked).toBe(3)
  })

  it('returns zero counts for a site with no queries', async () => {
    const current = await workspace()

    expect(current.tracked).toStrictEqual([])
    expect(current.summary).toStrictEqual({
      asked: 0, notAsked: 0,
      byClass: { branded: 0, nonBrand: 0, mixed: 0, unknown: 0 },
      byFocus: { market: 0, property: 0, company: 0, custom: 0 },
      assignments: { total: 0, branded: 0, nonBrand: 0, unknown: 0 },
      answersPerSweep: 0,
      structure: { targets: 0, markets: 0, groups: 0, topLevelGroups: 0, competitors: 0 },
    })
  })
})

describe('query tracking workspace summary: totals agree', () => {
  it.each([
    { name: 'an advanced portfolio', seed: seedPortfolio, limited: true },
    { name: 'locations in two markets', seed: () => activate(overlapPlan()), limited: true },
    { name: 'a simple site', seed: seedSimple, limited: false },
    { name: 'a simple site with no brand name', seed: seedSimpleWithoutBrand, limited: false },
    { name: 'a site with no queries', seed: () => undefined, limited: false },
  ])('keeps every breakdown equal to its total for $name', async ({ seed, limited }) => {
    seed()
    const current = await workspace()
    const summary = current.summary!

    expect(total(Object.values(summary.byClass))).toBe(summary.asked)
    expect(total(Object.values(summary.byFocus))).toBe(summary.asked)
    expect(summary.asked + summary.notAsked).toBe(current.tracked.length)
    expect(summary.assignments.branded + summary.assignments.nonBrand + summary.assignments.unknown).toBe(summary.assignments.total)
    expect(total(current.markets.map(market => market.counts!.marketQueries))).toBe(summary.byFocus.market)
    expect(total(current.targets.map(place => place.counts!.propertyQueries))).toBe(summary.byFocus.property)
    // The limit counts the same queries the summary calls asked.
    expect(current.limits?.queries.current).toBe(limited ? summary.asked : undefined)
    // Only a portfolio has views. Each view's count is the length of the list beside it.
    const views = current.views
    expect(views !== undefined).toBe(limited)
    expect([views?.noPropertyQueries.count, views?.thinMarkets.count, views?.patternGaps.count])
      .toStrictEqual([views?.noPropertyQueries.targetKeys.length, views?.thinMarkets.marketKeys.length, views?.patternGaps.patterns.length])

    // The answers a sweep asks for now are what a preview that changes nothing reports.
    const unchanged = await preview({})
    expect(unchanged.diff.noOp).toBe(true)
    expect(unchanged.workload.existingProviderCalls).toBe(summary.answersPerSweep)
  })
})
