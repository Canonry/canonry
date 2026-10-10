import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
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

  it('reads a pattern row whose plan froze no pattern record as a pattern', async () => {
    seedPortfolio()
    const row = (await workspace()).tracked.find(candidate => candidate.queryId === 'q-market')

    expect(row?.provenance).toStrictEqual({ source: 'template', sourceId: 'tpl-market@1', capturedAt: NOW })
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

    // The answers a sweep asks for now are what a preview that changes nothing reports.
    const unchanged = await preview({})
    expect(unchanged.diff.noOp).toBe(true)
    expect(unchanged.workload.existingProviderCalls).toBe(summary.answersPerSweep)
  })
})
