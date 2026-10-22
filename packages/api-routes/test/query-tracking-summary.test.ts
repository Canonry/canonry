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
} from '@canonry/canonry-contracts'
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
} from '@canonry/canonry-db'
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

/**
 * A metro whose markets sit on its child groups only:
 * - Lakeshore metro holds Harbor Point and River Point; Harbor side and River side each hold one of them.
 * - Harbor market (on Harbor side) and River market (on River side) each hold their one location.
 * - Crosstown, on no group, holds Harbor too, so Harbor sits in two markets.
 * - Closed is on River side and holds no location.
 * `q-pick` is hand-picked: asked for Harbor inside Harbor market and for River outside any market.
 */
function metroPlan(): MeasurementPlanV2 {
  const pairings: Array<Edge & { queryClass: 'branded' | 'non-brand'; markets: string[] }> = [
    { queryId: 'q-harbor-market', targetKey: 'harbor', executionNodeKey: 'n-harbor-market', queryClass: 'non-brand', markets: ['harbor-market'] },
    { queryId: 'q-river-market', targetKey: 'river', executionNodeKey: 'n-river-market', queryClass: 'non-brand', markets: ['river-market'] },
    { queryId: 'q-crosstown', targetKey: 'harbor', executionNodeKey: 'n-crosstown', queryClass: 'non-brand', markets: ['crosstown'] },
    { queryId: 'q-pick', targetKey: 'harbor', executionNodeKey: 'n-pick', queryClass: 'non-brand', markets: ['harbor-market'] },
    { queryId: 'q-pick', targetKey: 'river', executionNodeKey: 'n-pick', queryClass: 'non-brand', markets: [] },
  ]
  const edge = ({ executionNodeKey, targetKey, queryId }: Edge): Edge => ({ executionNodeKey, targetKey, queryId })
  const texts: Record<string, string> = {
    'q-harbor-market': 'best homes harbor side',
    'q-river-market': 'best homes river side',
    'q-crosstown': 'best homes crosstown',
    'q-pick': 'homes with a garden',
  }
  return sealed(measurementPlanV2Fixture({
    targets: [target('harbor', 'Harbor Point'), target('river', 'River Point')],
    groups: [
      { stableKey: 'lakeshore', label: 'Lakeshore metro', targetKeys: ['harbor', 'river'], competitors: [] },
      { stableKey: 'harbor-side', label: 'Harbor side', parentGroupKey: 'lakeshore', targetKeys: ['harbor'], competitors: [] },
      { stableKey: 'river-side', label: 'River side', parentGroupKey: 'lakeshore', targetKeys: ['river'], competitors: [] },
    ],
    querySnapshots: Object.entries(texts).map(([queryId, queryText]) => ({
      queryId, queryText, provenance: { source: 'manual' as const, sourceId: null, capturedAt: NOW },
    })),
    assignments: pairings.map(pairing => ({ ...edge(pairing), queryClass: pairing.queryClass, classificationSource: 'server' as const })),
    executionNodes: Object.entries(texts).map(([queryId, queryText]) => ({
      stableKey: queryId.replace('q-', 'n-'), queryId, queryText, context: ONE_ENGINE, expectedSnapshots: 1,
    })),
    usageEdges: pairings.map(edge),
    reportingScopes: [
      { stableKey: 'closed', label: 'Closed', groupKey: 'river-side' },
      { stableKey: 'crosstown', label: 'Crosstown' },
      { stableKey: 'harbor-market', label: 'Harbor market', groupKey: 'harbor-side' },
      { stableKey: 'river-market', label: 'River market', groupKey: 'river-side' },
    ].map(market => ({
      ...market, kind: 'market' as const, usageEdges: pairings.filter(pairing => pairing.markets.includes(market.stableKey)).map(edge),
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
 * - Downtown (Summit, Cedar) and Lakeside (Lone Pine alone) have three each.
 * - Vacant holds no location.
 * The Best pattern is asked in all three markets with a location. The Pets
 * pattern is asked in Uptown and, by a row that froze no record, in Lakeside.
 * Two patterns were deleted since: Lofts is asked in Downtown and, under a
 * later wording, Lakeside, and Studios in Uptown and, under a later wording,
 * Downtown. Harbor and Cedar each have a query of their own.
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
    {
      queryId: 'q-up-studio', text: 'studio apartments in Uptown', targets: ['harbor', 'river'], market: 'uptown',
      pattern: frozenPattern('tpl-studio', SAVED_FIRST, 'studio apartments in {market}', { market: 'Uptown' }),
    },
    { queryId: 'q-down-best', text: 'best apartments in Downtown', targets: ['summit', 'cedar'], market: 'downtown', pattern: best('Downtown') },
    {
      queryId: 'q-down-lofts', text: 'luxury lofts in Downtown', targets: ['summit', 'cedar'], market: 'downtown',
      pattern: frozenPattern('tpl-lofts', SAVED_FIRST, 'luxury lofts in {market}', { market: 'Downtown' }),
    },
    // Rows are read by text: this later wording of Studios comes after Uptown's, and Lakeside's later Lofts before Downtown's.
    {
      queryId: 'q-down-studio', text: 'studios in Downtown', targets: ['summit', 'cedar'], market: 'downtown',
      pattern: frozenPattern('tpl-studio', SAVED_AGAIN, 'studios in {market}', { market: 'Downtown' }),
    },
    // A market of one location: Non-brand keeps both queries the market's.
    { queryId: 'q-lake-best', text: 'best apartments in Lakeside', targets: ['lone'], market: 'lakeside', pattern: best('Lakeside') },
    {
      queryId: 'q-lake-lofts', text: 'luxury loft rentals in Lakeside', targets: ['lone'], market: 'lakeside',
      pattern: frozenPattern('tpl-lofts', SAVED_AGAIN, 'luxury loft rentals in {market}', { market: 'Lakeside' }),
    },
    // Typed by hand: the text the Pets pattern made for Lakeside when Uptown's row froze it.
    { queryId: 'q-lake-pets', text: 'pet friendly apartments in Lakeside', targets: ['lone'], market: 'lakeside' },
    // Harbor's own query, from a location pattern: a pattern row that is no market's.
    {
      queryId: 'q-harbor', text: 'Harbor Point reviews', targets: ['harbor'], market: 'uptown', queryClass: 'branded',
      pattern: frozenPattern('tpl-reviews', SAVED_FIRST, '{property} reviews', { property: 'Harbor Point' }),
    },
    // The Pets pattern asked for Cedar alone inside Downtown: the text it makes for Downtown, and Cedar's own query.
    { queryId: 'q-cedar-pets', text: 'pet friendly apartments in Downtown', targets: ['cedar'], market: 'downtown', pattern: pets('Downtown') },
    // Hand-picked at Summit outside any market. Neither row is Downtown's use of the pattern.
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
    // Listed out of key order, as the locations are: a published plan sorts both.
    reportingScopes: [['uptown', 'Uptown'], ['vacant', 'Vacant'], ['lakeside', 'Lakeside'], ['downtown', 'Downtown']].map(([stableKey, label]) => ({
      stableKey: stableKey!, label: label!, kind: 'market' as const, usageEdges: edges.filter(row => row.market === stableKey).map(edge),
    })),
  }))
}

/** A saved pattern as the pattern routes store it. */
function savePattern(id: string, name: string, pattern: string, variables: string[] = ['market']): void {
  db.insert(measurementQueryTemplates).values({
    id, projectId: PROJECT_ID, name, description: null, pattern, variables, createdAt: SAVED_FIRST, updatedAt: SAVED_AGAIN,
  }).run()
}

/** Saves a pattern through the pattern route and returns the addition that asks it for `audience`. */
async function patternAddition(id: string, name: string, pattern: string, variables: string[]) {
  const saved = await app.inject({
    method: 'PUT', url: `/api/v1/projects/northstar/measurement-query-templates/${id}`, headers: { authorization: `Bearer ${ROOT_KEY}` },
    payload: { name, pattern, variables },
  })
  expect([200, 201], saved.body).toContain(saved.statusCode)
  const { updatedAt } = saved.json() as { updatedAt: string }
  return (audience: { marketKeys?: string[]; targetKeys?: string[] }, queryClass?: 'branded' | 'non-brand') => ({
    input: { source: 'template', templateId: id, templateVersion: updatedAt, template: pattern },
    audience,
    ...(queryClass ? { queryClass } : {}),
  })
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

/** A place's Type counts, with every class not named at zero. */
function byClass(counts: Partial<Record<'branded' | 'nonBrand' | 'mixed' | 'unknown', number>>) {
  return { branded: 0, nonBrand: 0, mixed: 0, unknown: 0, ...counts }
}

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
    expect(rows.find(row => row.queryId === 'q-lone')?.assignments[0]?.classifiedContexts)
      .toEqual(expect.arrayContaining([
        { ...ONE_ENGINE, queryClass: 'non-brand', marketKeys: [] },
        { ...TWO_ENGINES, queryClass: 'branded', marketKeys: [] },
      ]))
    expect(rows.find(row => row.queryId === 'q-mixed')?.assignments.map(assignment => assignment.classifiedContexts))
      .toStrictEqual([
        [{ ...TWO_ENGINES, queryClass: 'branded', marketKeys: ['uptown'] }],
        [{ ...TWO_ENGINES, queryClass: 'non-brand', marketKeys: ['uptown'] }],
      ])
  })

  it('keeps both classes and their exact markets when one location reuses the same context', async () => {
    const plan = portfolioPlan()
    const branded = plan.executionNodes.find(node => node.stableKey === 'n-lone-b')!
    branded.context = ONE_ENGINE
    branded.expectedSnapshots = 1
    for (const [stableKey, executionNodeKey] of [['lone-nonbrand', 'n-lone-a'], ['lone-brand', 'n-lone-b']]) {
      plan.reportingScopes.push({
        stableKey: stableKey!, label: stableKey!, kind: 'market',
        usageEdges: [{ executionNodeKey: executionNodeKey!, targetKey: 'lone', queryId: 'q-lone' }],
      })
    }
    activate(sealed(plan))
    const assignment = (await workspace()).tracked.find(row => row.queryId === 'q-lone')?.assignments[0]

    // The additive projection retains both classes without changing legacy context cardinality.
    expect(assignment?.contexts).toStrictEqual([ONE_ENGINE])
    expect(assignment?.queryClass).toBe('non-brand')
    expect(assignment?.classifiedContexts).toStrictEqual([
      { ...ONE_ENGINE, queryClass: 'branded', marketKeys: ['lone-brand'] },
      { ...ONE_ENGINE, queryClass: 'non-brand', marketKeys: ['lone-nonbrand'] },
    ])
  })

  it('counts each location, market and group, with a shared execution once per place', async () => {
    seedPortfolio()
    const current = await workspace()

    expect(current.targets.map(({ stableKey, marketKeys, counts }) => ({ stableKey, marketKeys, counts }))).toStrictEqual([
      // q-mixed is Branded for Harbor and Non-brand for River, so each location counts it under one class.
      { stableKey: 'harbor', marketKeys: ['uptown'], counts: { queries: 4, byClass: byClass({ branded: 2, nonBrand: 2 }), propertyQueries: 1, marketQueries: 2, customQueries: 1, answersPerSweep: 6 } },
      // q-lone is asked under both types at Lone Pine's two search locations.
      { stableKey: 'lone', marketKeys: [], counts: { queries: 1, byClass: byClass({ mixed: 1 }), propertyQueries: 1, marketQueries: 0, customQueries: 0, answersPerSweep: 3 } },
      { stableKey: 'river', marketKeys: ['uptown'], counts: { queries: 2, byClass: byClass({ nonBrand: 2 }), propertyQueries: 0, marketQueries: 2, customQueries: 0, answersPerSweep: 4 } },
      { stableKey: 'summit', marketKeys: ['downtown'], counts: { queries: 3, byClass: byClass({ branded: 1, nonBrand: 2 }), propertyQueries: 1, marketQueries: 1, customQueries: 1, answersPerSweep: 4 } },
    ])
    expect(current.markets.map(({ stableKey, targetKeys, counts }) => ({ stableKey, targetKeys, counts }))).toStrictEqual([
      { stableKey: 'downtown', targetKeys: ['summit'], counts: { queries: 2, byClass: byClass({ branded: 1, nonBrand: 1 }), marketQueries: 1, propertyQueries: 1, answersPerSweep: 3 } },
      // Holding Harbor and River, Uptown reads q-mixed as both classes. q-custom's Harbor pairing is outside it.
      { stableKey: 'uptown', targetKeys: ['harbor', 'river'], counts: { queries: 3, byClass: byClass({ branded: 1, nonBrand: 1, mixed: 1 }), marketQueries: 2, propertyQueries: 1, answersPerSweep: 5 } },
      { stableKey: 'vacant', targetKeys: [], counts: { queries: 0, byClass: byClass({}), marketQueries: 0, propertyQueries: 0, answersPerSweep: 0 } },
    ])
    expect(current.groups.map(({ stableKey, counts }) => ({ stableKey, counts }))).toStrictEqual([
      // Metro's locations sit in Downtown (on Metro) and Uptown (on its child North): two markets.
      { stableKey: 'metro', counts: { queries: 6, byClass: byClass({ branded: 2, nonBrand: 3, mixed: 1 }), marketQueries: 3, propertyQueries: 2, customQueries: 1, markets: 2, answersPerSweep: 9 } },
      { stableKey: 'north', counts: { queries: 4, byClass: byClass({ branded: 1, nonBrand: 2, mixed: 1 }), marketQueries: 2, propertyQueries: 1, customQueries: 1, markets: 1, answersPerSweep: 6 } },
      // One class per location would call q-lone Non-brand; every assignment makes it Mixed.
      { stableKey: 'solo', counts: { queries: 1, byClass: byClass({ mixed: 1 }), marketQueries: 0, propertyQueries: 1, customQueries: 0, markets: 0, answersPerSweep: 3 } },
    ])
    expect(current.tracked.find(row => row.queryId === 'q-lone')?.assignments.map(assignment => assignment.queryClass)).toStrictEqual(['non-brand'])

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
      { stableKey: 'harbor', marketKeys: ['citywide', 'uptown'], counts: { queries: 4, byClass: byClass({ branded: 1, nonBrand: 3 }), propertyQueries: 1, marketQueries: 3, customQueries: 0, answersPerSweep: 6 } },
      { stableKey: 'river', marketKeys: ['citywide', 'uptown'], counts: { queries: 3, byClass: byClass({ nonBrand: 3 }), propertyQueries: 0, marketQueries: 3, customQueries: 0, answersPerSweep: 4 } },
      { stableKey: 'summit', marketKeys: ['citywide'], counts: { queries: 2, byClass: byClass({ nonBrand: 2 }), propertyQueries: 0, marketQueries: 2, customQueries: 0, answersPerSweep: 3 } },
    ])
    // Harbor's own query counts in both of its markets, as one query in each.
    expect(current.markets.map(({ stableKey, targetKeys, counts }) => ({ stableKey, targetKeys, counts }))).toStrictEqual([
      { stableKey: 'citywide', targetKeys: ['harbor', 'river', 'summit'], counts: { queries: 3, byClass: byClass({ branded: 1, nonBrand: 2 }), marketQueries: 2, propertyQueries: 1, answersPerSweep: 5 } },
      { stableKey: 'uptown', targetKeys: ['harbor', 'river'], counts: { queries: 2, byClass: byClass({ branded: 1, nonBrand: 1 }), marketQueries: 1, propertyQueries: 1, answersPerSweep: 3 } },
    ])
    // A market query stays one row, however many of its locations another market shares.
    expect(current.summary?.byFocus).toStrictEqual({ market: 3, property: 1, company: 0, custom: 0 })
    expect(total(current.markets.map(market => market.counts!.marketQueries))).toBe(3)
    expect(current.summary?.answersPerSweep).toBe(6)
  })

  it('counts a group\'s markets as the markets its locations are in, wherever each market is attached', async () => {
    activate(metroPlan())
    const current = await workspace()

    expect(current.markets.map(market => [market.stableKey, market.groupKey ?? null, market.targetKeys])).toStrictEqual([
      ['closed', 'river-side', []],
      ['crosstown', null, ['harbor']],
      ['harbor-market', 'harbor-side', ['harbor']],
      ['river-market', 'river-side', ['river']],
    ])
    expect(Object.fromEntries(current.groups.map(group => [group.stableKey, group.counts?.markets]))).toStrictEqual({
      // No market is attached to the metro, and its two locations sit in three.
      lakeshore: 3,
      // One market is attached to Harbor side, and Harbor also sits in Crosstown.
      'harbor-side': 2,
      // Two are attached to River side, and Closed holds no location.
      'river-side': 1,
    })
    // The same union as each location's own markets.
    expect(current.targets.map(place => [place.stableKey, place.marketKeys])).toStrictEqual([
      ['harbor', ['crosstown', 'harbor-market']], ['river', ['river-market']],
    ])
  })

  it('counts a hand-picked query paired inside a market in that market\'s queries, outside its two Subject counts', async () => {
    activate(metroPlan())
    const current = await workspace()

    expect(current.tracked.find(row => row.queryId === 'q-pick')?.focus).toStrictEqual({ kind: 'custom' })
    expect(current.markets.find(market => market.stableKey === 'harbor-market')?.counts).toStrictEqual({
      queries: 2, byClass: byClass({ nonBrand: 2 }), marketQueries: 1, propertyQueries: 0, answersPerSweep: 2,
    })
    // River's pairing of the same query is in no market, so River market does not count it.
    expect(current.markets.find(market => market.stableKey === 'river-market')?.counts).toStrictEqual({
      queries: 1, byClass: byClass({ nonBrand: 1 }), marketQueries: 1, propertyQueries: 0, answersPerSweep: 1,
    })
    expect(current.groups.find(group => group.stableKey === 'lakeshore')?.counts).toStrictEqual({
      queries: 4, byClass: byClass({ nonBrand: 4 }), marketQueries: 3, propertyQueries: 0, customQueries: 1, markets: 3, answersPerSweep: 4,
    })
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
    expect(current.limits).toStrictEqual({
      queries: { current: 7, next: 7, max: 1_000, left: { current: 993, next: 993 }, over: { current: 0, next: 0 }, exceeded: false },
    })

    const added = await preview({
      additions: [{ input: { source: 'manual', text: 'apartments with a pool' }, audience: { marketKeys: ['uptown'] } }],
    })
    expect(added.limits).toStrictEqual({
      queries: { current: 7, next: 8, max: 1_000, left: { current: 993, next: 992 }, over: { current: 0, next: 0 }, exceeded: false },
    })
    expect(added.tracked.find(row => row.queryText === 'apartments with a pool'))
      .toMatchObject({ focus: { kind: 'market', key: 'uptown' }, queryClasses: ['non-brand'] })
  })

  it('reports no room, never a negative one, for a plan over the limit', async () => {
    activate(crowdedPlan(1_002))
    const current = await workspace()
    expect(current.summary).toMatchObject({ asked: 1_002, notAsked: 0, answersPerSweep: 1_002 })
    // A read changes nothing, so a plan over the limit is not a refused change.
    expect(current.limits).toStrictEqual({
      queries: { current: 1_002, next: 1_002, max: 1_000, left: { current: 0, next: 0 }, over: { current: 2, next: 2 }, exceeded: false },
    })

    const shrunk = await preview({ removals: [{ queryId: 'q-fill-0' }, { queryId: 'q-fill-1' }, { queryId: 'q-fill-2' }] })
    expect(shrunk.limits).toStrictEqual({
      queries: { current: 1_002, next: 999, max: 1_000, left: { current: 0, next: 1 }, over: { current: 2, next: 0 }, exceeded: false },
    })
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
    expect(current.limits).toStrictEqual({
      queries: { current: 2, next: 2, max: 1_000, left: { current: 998, next: 998 }, over: { current: 0, next: 0 }, exceeded: false },
    })
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
    expect(current.limits).toStrictEqual({
      queries: { current: 0, next: 0, max: 1_000, left: { current: 1_000, next: 1_000 }, over: { current: 0, next: 0 }, exceeded: false },
    })
    expect(current.targets[0]).toMatchObject({
      marketKeys: [], counts: { queries: 0, byClass: byClass({}), propertyQueries: 0, marketQueries: 0, customQueries: 0, answersPerSweep: 0 },
    })
    expect(current.groups[0]?.counts).toStrictEqual({
      queries: 0, byClass: byClass({}), marketQueries: 0, propertyQueries: 0, customQueries: 0, markets: 0, answersPerSweep: 0,
    })
  })
})

describe('query tracking workspace views', () => {
  it('lists locations with no query of their own, thin markets and pattern gaps, each with its count', async () => {
    activate(viewsPlan())
    savePattern('tpl-best', 'Best', 'best apartments in {market}')
    // Reworded since the rows were added: the view shows the pattern as it is saved now.
    savePattern('tpl-pets', 'Pet friendly', 'pet friendly apartments in {market} with a yard')
    // Asked in no market, so it is no gap.
    savePattern('tpl-transit', 'Near transit', 'apartments near transit in {market}')
    const patternReads = countReadsOf('measurement_query_templates')
    const current = await workspace()

    expect(Object.fromEntries(current.tracked.map(row => [row.queryId, row.focus]))).toMatchObject({
      'q-lake-best': { kind: 'market', key: 'lakeside' },
      'q-harbor': { kind: 'property', key: 'harbor' },
      'q-cedar-pets': { kind: 'property', key: 'cedar' },
      'q-pick-pets': { kind: 'custom' },
    })
    expect(current.views).toStrictEqual({
      // Summit's one query is hand-picked and Lone Pine's three are its market's: neither is the location's own.
      noPropertyQueries: { count: 3, targetKeys: ['lone', 'river', 'summit'] },
      // Uptown has exactly four market queries, so it is not thin. Downtown is one short.
      thinMarkets: { count: 3, floor: 4, marketKeys: ['downtown', 'lakeside', 'vacant'] },
      patternGaps: {
        count: 3,
        // The three saved patterns and the two deleted ones market rows froze. Harbor's `{property}` pattern is not read.
        compared: 5,
        patterns: [
          // Deleted since: no name, and the wording of the newest row that froze it.
          { templateId: 'tpl-lofts', name: null, pattern: 'luxury loft rentals in {market}', usedMarketKeys: ['downtown', 'lakeside'], missingMarketKeys: ['uptown'] },
          // Lakeside asks the text of the wording Uptown's row froze. Cedar's own row and the hand-picked one
          // are not Downtown's. Vacant has no location, so it is never missing.
          { templateId: 'tpl-pets', name: 'Pet friendly', pattern: 'pet friendly apartments in {market} with a yard', usedMarketKeys: ['lakeside', 'uptown'], missingMarketKeys: ['downtown'] },
          { templateId: 'tpl-studio', name: null, pattern: 'studios in {market}', usedMarketKeys: ['downtown', 'uptown'], missingMarketKeys: ['lakeside'] },
        ],
      },
    })
    expect(QUERY_TRACKING_THIN_MARKET_FLOOR).toBe(4)
    expect(current.markets.map(market => [market.stableKey, market.counts?.marketQueries])).toStrictEqual([
      ['downtown', 3], ['lakeside', 3], ['uptown', 4], ['vacant', 0],
    ])
    // The saved patterns are read once, whatever the number of patterns and markets.
    expect(patternReads()).toBe(1)
  })

  it('calls a market with no queries thin and finds no gap with no saved pattern', async () => {
    seedPortfolio()
    const patternReads = countReadsOf('measurement_query_templates')
    const current = await workspace()

    expect(current.views).toStrictEqual({
      noPropertyQueries: { count: 1, targetKeys: ['river'] },
      // Vacant has no location and no query. Downtown has one query and Uptown two.
      thinMarkets: { count: 3, floor: 4, marketKeys: ['downtown', 'uptown', 'vacant'] },
      // q-market is a pattern row that froze no pattern record, and no saved pattern makes its text.
      // Nothing was compared, which is not the same as no gap found.
      patternGaps: { count: 0, compared: 0, patterns: [] },
    })
    expect(patternReads()).toBe(1)
  })

  it('counts a market that already asks the text a pattern makes, though its row froze no record', async () => {
    seedPortfolio()
    // A query typed by hand, in another case and spacing than the pattern makes.
    await publish({ additions: [{ input: { source: 'manual', text: 'Pet friendly apartments  in UPTOWN' }, audience: { marketKeys: ['uptown'] }, queryClass: 'non-brand' }] })
    const best = await patternAddition('tpl-best', 'Best', 'best apartments {market}', ['market'])
    const pets = await patternAddition('tpl-pets', 'Pet friendly', 'pet friendly apartments in {market}', ['market'])

    const before = await workspace()
    const uptown = before.tracked.filter(row => row.focus?.kind === 'market' && row.focus.key === 'uptown')
    expect(uptown.map(row => [row.queryText, row.provenance?.source, row.provenance?.template])).toStrictEqual([
      // Published by setup: a pattern row with no frozen record.
      ['best apartments uptown', 'template', undefined],
      ['harbor point or river point', 'manual', undefined],
      ['Pet friendly apartments  in UPTOWN', 'manual', undefined],
    ])
    // No row froze either pattern, and both gaps are found: Uptown asks each text and Downtown does not.
    expect(before.views?.patternGaps).toStrictEqual({
      count: 2,
      compared: 2,
      patterns: [
        { templateId: 'tpl-best', name: 'Best', pattern: 'best apartments {market}', usedMarketKeys: ['uptown'], missingMarketKeys: ['downtown'] },
        { templateId: 'tpl-pets', name: 'Pet friendly', pattern: 'pet friendly apartments in {market}', usedMarketKeys: ['uptown'], missingMarketKeys: ['downtown'] },
      ],
    })

    // Adding both where they are missing closes both: Uptown is not reported as missing them.
    await publish({ additions: [best({ marketKeys: ['downtown'] }), pets({ marketKeys: ['downtown'] })] })
    const after = await workspace()
    // Both patterns were compared and neither has a gap.
    expect(after.views?.patternGaps).toStrictEqual({ count: 0, compared: 2, patterns: [] })
    expect(after.markets.map(market => [market.stableKey, market.counts?.marketQueries])).toStrictEqual([['downtown', 3], ['uptown', 3], ['vacant', 0]])
  })

  it('lists no gap for a pattern that cannot make a market\'s own query', async () => {
    seedPortfolio()
    const gym = await patternAddition('tpl-gym', 'Gym', 'apartments with a gym', [])
    const near = await patternAddition('tpl-near', 'Near', 'apartments near {property}', ['property'])
    const both = await patternAddition('tpl-both', 'Both', '{property} homes in {market}', ['market', 'property'])
    // Summit is Downtown's one location, so its Non-brand queries are the market's.
    await publish({
      additions: [
        gym({ marketKeys: ['uptown'] }, 'non-brand'),
        near({ targetKeys: ['summit'], marketKeys: ['downtown'] }, 'non-brand'),
        both({ targetKeys: ['summit'], marketKeys: ['downtown'] }, 'non-brand'),
      ],
    })

    const current = await workspace()
    const made = current.tracked.filter(row => row.provenance?.template !== undefined)
    expect(made.map(row => [row.queryText, row.focus, row.provenance?.template?.bindings])).toStrictEqual([
      ['apartments near Summit Lofts', { kind: 'market', key: 'downtown' }, { property: 'Summit Lofts' }],
      ['apartments with a gym', { kind: 'market', key: 'uptown' }, {}],
      ['Summit Lofts homes in Downtown', { kind: 'market', key: 'downtown' }, { market: 'Downtown', property: 'Summit Lofts' }],
    ])
    // Each is one market's own query, and none can become another market's:
    // a pattern with no variable makes one query for every place, and a
    // location's makes a query per location.
    expect(current.views?.patternGaps).toStrictEqual({ count: 0, compared: 0, patterns: [] })

    // The rows keep their records once the saved patterns are deleted, and are still no gap.
    for (const id of ['tpl-gym', 'tpl-near', 'tpl-both']) {
      const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/projects/northstar/measurement-query-templates/${id}`, headers: { authorization: `Bearer ${ROOT_KEY}` } })
      expect(deleted.statusCode, deleted.body).toBe(204)
    }
    expect((await workspace()).views?.patternGaps).toStrictEqual({ count: 0, compared: 0, patterns: [] })
  })

  it('drops a gap once the saved pattern takes a location variable', async () => {
    seedPortfolio()
    const transit = await patternAddition('tpl-transit', 'Near transit', 'apartments near transit in {market}', ['market'])
    await publish({ additions: [transit({ marketKeys: ['uptown'] })] })
    expect((await workspace()).views?.patternGaps.patterns.map(gap => [gap.templateId, gap.missingMarketKeys])).toStrictEqual([['tpl-transit', ['downtown']]])

    // Saved again with a location in it: adding it now makes each location a query, never Downtown's own.
    await patternAddition('tpl-transit', 'Near transit', '{property} near transit in {market}', ['market', 'property'])
    expect((await workspace()).views?.patternGaps).toStrictEqual({ count: 0, compared: 0, patterns: [] })
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
      count: 1, compared: 1, patterns: [{ ...gap, name: 'Near transit', pattern: 'apartments near transit in {market}' }],
    })

    // The row keeps the pattern it froze after the saved pattern is deleted.
    const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/projects/northstar/measurement-query-templates/tpl-transit', headers })
    expect(deleted.statusCode, deleted.body).toBe(204)
    expect((await workspace()).views?.patternGaps).toStrictEqual({
      count: 1, compared: 1, patterns: [{ ...gap, name: null, pattern: 'apartments near transit in {market}' }],
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
    expect(closed.views?.patternGaps).toStrictEqual({ count: 0, compared: 1, patterns: [] })
    expect(closed.markets.map(market => [market.stableKey, market.counts?.marketQueries])).toStrictEqual([['downtown', 2], ['uptown', 3], ['vacant', 0]])
  })

  it('reads a pattern written with {submarket} as a market pattern, by its text and by the record a row froze', async () => {
    seedPortfolio()
    // Uptown already asks "best apartments uptown", the text this pattern makes for it.
    savePattern('tpl-best', 'Best', 'best apartments {submarket}', ['submarket'])
    // A location name makes a query per location, never a market's own.
    savePattern('tpl-reviews', 'Reviews', '{propertyBrand} reviews', ['propertyBrand'])
    expect((await workspace()).views?.patternGaps).toStrictEqual({
      count: 1,
      compared: 1,
      patterns: [{ templateId: 'tpl-best', name: 'Best', pattern: 'best apartments {submarket}', usedMarketKeys: ['uptown'], missingMarketKeys: ['downtown'] }],
    })

    // Added through tracking, the row freezes the pattern under the name it was written with.
    const pool = await patternAddition('tpl-pool', 'Pool', 'homes with a pool in {submarket}', ['submarket'])
    await publish({ additions: [pool({ marketKeys: ['downtown'] })] })
    const added = (await workspace()).tracked.find(row => row.queryText === 'homes with a pool in Downtown')
    expect([added?.focus, added?.provenance?.template?.bindings]).toStrictEqual([{ kind: 'market', key: 'downtown' }, { submarket: 'Downtown' }])
    // Deleted since, the pattern is still read from that record.
    const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/projects/northstar/measurement-query-templates/tpl-pool', headers: { authorization: `Bearer ${ROOT_KEY}` } })
    expect(deleted.statusCode, deleted.body).toBe(204)
    expect((await workspace()).views?.patternGaps).toMatchObject({
      count: 2,
      compared: 2,
      patterns: [
        { templateId: 'tpl-best', usedMarketKeys: ['uptown'], missingMarketKeys: ['downtown'] },
        { templateId: 'tpl-pool', name: null, pattern: 'homes with a pool in {submarket}', usedMarketKeys: ['downtown'], missingMarketKeys: ['uptown'] },
      ],
    })
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
    { name: 'a metro with markets on its child groups', seed: () => activate(metroPlan()), limited: true },
    { name: 'markets asked by pattern', seed: () => activate(viewsPlan()), limited: true },
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
    // Every place: its Type counts add up to its queries, which are the listed rows with a pairing there.
    const pairedAt = (keysOf: (assignment: QueryTrackingWorkspaceResponse['tracked'][number]['assignments'][number]) => readonly string[], key: string) =>
      current.tracked.filter(row => row.assignments.some(assignment => keysOf(assignment).includes(key))).length
    for (const place of current.targets) {
      expect([place.stableKey, place.counts?.queries]).toStrictEqual([place.stableKey, pairedAt(assignment => [assignment.targetKey], place.stableKey)])
      expect(total(Object.values(place.counts!.byClass!))).toBe(place.counts!.queries)
      // A location's rows are its own, its markets' and the hand-picked ones.
      expect(place.counts!.propertyQueries + place.counts!.marketQueries + place.counts!.customQueries).toBe(place.counts!.queries)
    }
    for (const market of current.markets) {
      expect([market.stableKey, market.counts?.queries]).toStrictEqual([market.stableKey, pairedAt(assignment => assignment.marketKeys, market.stableKey)])
      expect(total(Object.values(market.counts!.byClass!))).toBe(market.counts!.queries)
    }
    for (const group of current.groups) {
      expect([group.stableKey, group.counts?.queries]).toStrictEqual([group.stableKey, pairedAt(assignment => assignment.groupKeys, group.stableKey)])
      expect(total(Object.values(group.counts!.byClass!))).toBe(group.counts!.queries)
      expect(group.counts!.marketQueries! + group.counts!.propertyQueries! + group.counts!.customQueries!).toBe(group.counts!.queries)
    }
    // The limit counts the same queries the summary calls asked.
    expect(current.limits?.queries.current).toBe(limited ? summary.asked : undefined)
    expect(current.limits?.queries.exceeded).toBe(limited ? false : undefined)
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
