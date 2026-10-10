import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  queryTrackingCommitResponseSchema,
  queryTrackingPreviewResponseSchema,
  queryTrackingWorkspaceResponseSchema,
  type MeasurementPlanV2,
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

// Counts every whole-plan serialization the routes make. The function itself is unchanged.
vi.mock('@ainyc/canonry-contracts', async importOriginal => {
  const actual = await importOriginal<typeof import('@ainyc/canonry-contracts')>()
  return { ...actual, canonicalMeasurementPlanV2Json: vi.fn(actual.canonicalMeasurementPlanV2Json) }
})

const NOW = '2026-10-09T00:00:00.000Z'
const PROJECT = 'northwind'
const PROJECT_ID = 'project-northwind'
const ROOT_KEY = 'cnry_tracking_market_changes_root'
const ALPHA = { label: 'alpha', city: 'Alpha', region: 'AA', country: 'US' }
/** One engine at one search location, so every execution is one answer. */
const CONTEXT = { providers: ['openai'], models: { openai: 'gpt-test' }, location: ALPHA }

let directory: string
let db: DatabaseClient
let app: FastifyInstance

type Pairing = {
  queryId: string
  targetKey: string
  executionNodeKey: string
  queryClass: 'branded' | 'non-brand'
  markets: string[]
}

function planOf(input: {
  targets: ReadonlyArray<readonly [stableKey: string, label: string]>
  markets: ReadonlyArray<readonly [stableKey: string, label: string]>
  texts: Readonly<Record<string, string>>
  pairings: readonly Pairing[]
}): MeasurementPlanV2 {
  const edge = ({ executionNodeKey, targetKey, queryId }: Pairing) => ({ executionNodeKey, targetKey, queryId })
  const nodeQueries = new Map(input.pairings.map(pairing => [pairing.executionNodeKey, pairing.queryId]))
  const provisional = measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'northwind.example', ownedHosts: ['northwind.example'], names: ['Northwind'] } },
    targets: input.targets.map(([stableKey, label]) => ({
      stableKey, label, aliases: [label],
      urlMatchers: [{ kind: 'prefix', host: 'northwind.example', pathPrefix: `/${stableKey}`, pathCase: 'insensitive' }],
      mentionNotApplicable: false, discoveryIdentity: null,
    })),
    groups: [],
    querySnapshots: Object.entries(input.texts).map(([queryId, queryText]) => ({
      queryId, queryText, provenance: { source: 'manual', sourceId: null, capturedAt: NOW },
    })),
    assignments: input.pairings.map(pairing => ({ ...edge(pairing), queryClass: pairing.queryClass, classificationSource: 'server' })),
    executionNodes: [...nodeQueries].map(([stableKey, queryId]) => ({
      stableKey, queryId, queryText: input.texts[queryId], context: CONTEXT, expectedSnapshots: 1,
    })),
    usageEdges: input.pairings.map(edge),
    reportingScopes: input.markets.map(([stableKey, label]) => ({
      stableKey, label, kind: 'market',
      usageEdges: input.pairings.filter(pairing => pairing.markets.includes(stableKey)).map(edge),
    })),
    compiledChecksum: '0'.repeat(64),
  })
  const compiledChecksum = crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(provisional)).digest('hex')
  return measurementPlanV2Schema.parse({ ...provisional, compiledChecksum })
}

/** Publishes the plan as revision 1 with one catalog row per query. */
function activate(plan: MeasurementPlanV2): void {
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.insert(measurementPlanVersions).values({
    id: 'plan-v1', projectId: PROJECT_ID, revision: 1, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, comparableToVersionId: null, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId: PROJECT_ID, activeVersionId: 'plan-v1', createdAt: NOW, updatedAt: NOW }).run()
  db.insert(queries).values(plan.querySnapshots.map(snapshot => ({
    id: snapshot.queryId, projectId: PROJECT_ID, query: snapshot.queryText, provenance: null, createdAt: NOW,
  }))).run()
}

/**
 * Seven locations in three markets:
 * - Uptown holds Harbor, River and Summit through its one query, `q-uptown`.
 * - Downtown holds Dock and Pier through two market queries; `q-dock` is Dock's own.
 * - Waterfront holds Dock through the same `q-dock` execution Downtown reports, and Pier through `q-pier`.
 */
function seedPortfolio(): void {
  const market = (queryId: string, targetKeys: string[], marketKey: string): Pairing[] => targetKeys.map(targetKey => ({
    queryId, targetKey, executionNodeKey: `n-${queryId}`, queryClass: 'non-brand', markets: [marketKey],
  }))
  activate(planOf({
    targets: [['harbor', 'Harbor Point'], ['river', 'River Point'], ['summit', 'Summit Lofts'], ['dock', 'Dock House'], ['pier', 'Pier House']],
    markets: [['downtown', 'Downtown'], ['uptown', 'Uptown'], ['waterfront', 'Waterfront']],
    texts: {
      'q-uptown': 'best apartments uptown',
      'q-down-a': 'best apartments downtown',
      'q-down-b': 'downtown apartments with parking',
      'q-dock': 'dock house reviews',
      'q-pier': 'pier house reviews',
    },
    pairings: [
      ...market('q-uptown', ['harbor', 'river', 'summit'], 'uptown'),
      ...market('q-down-a', ['dock', 'pier'], 'downtown'),
      ...market('q-down-b', ['dock', 'pier'], 'downtown'),
      { queryId: 'q-dock', targetKey: 'dock', executionNodeKey: 'n-q-dock', queryClass: 'branded', markets: ['downtown', 'waterfront'] },
      { queryId: 'q-pier', targetKey: 'pier', executionNodeKey: 'n-q-pier', queryClass: 'branded', markets: ['waterfront'] },
    ],
  }))
}

function request(method: 'GET' | 'POST', suffix: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/api/v1/projects/${PROJECT}${suffix}`,
    headers: { authorization: `Bearer ${ROOT_KEY}` },
    ...(payload === undefined ? {} : { payload }),
  })
}

async function workspace() {
  const response = await request('GET', '/query-tracking')
  expect(response.statusCode, response.body).toBe(200)
  return queryTrackingWorkspaceResponseSchema.parse(response.json())
}

type Mutation = { additions?: unknown[]; removals?: unknown[]; edits?: unknown[] }

async function review(mutation: Mutation) {
  const payload = {
    expectedWorkspaceVersion: (await workspace()).workspaceVersion,
    additions: mutation.additions ?? [], removals: mutation.removals ?? [],
    ...(mutation.edits ? { edits: mutation.edits } : {}),
  }
  const response = await request('POST', '/query-tracking/preview', payload)
  expect(response.statusCode, response.body).toBe(200)
  const preview = queryTrackingPreviewResponseSchema.parse(response.json())
  return { preview, commit: { ...payload, previewToken: preview.previewToken, reviewedAt: preview.reviewedAt } }
}

async function publish(commit: Record<string, unknown>) {
  const response = await request('POST', '/query-tracking/commit', commit)
  expect(response.statusCode, response.body).toBe(200)
  return queryTrackingCommitResponseSchema.parse(response.json())
}

async function refusal(addition: Record<string, unknown>) {
  const response = await request('POST', '/query-tracking/preview', {
    expectedWorkspaceVersion: (await workspace()).workspaceVersion, additions: [addition], removals: [],
  })
  return { status: response.statusCode, body: response.json() as unknown }
}

function manual(text: string, audience: Record<string, string[]>) {
  return { input: { source: 'manual', text }, audience }
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-tracking-market-changes-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'root', keyHash: hashApiKey(ROOT_KEY), keyPrefix: ROOT_KEY.slice(0, 9),
    scopes: ['*'], projectId: null, createdAt: NOW,
  }).run()
  db.insert(projects).values({
    id: PROJECT_ID, name: PROJECT, displayName: 'Northwind', canonicalDomain: 'northwind.example',
    ownedDomains: [], aliases: [], country: 'US', language: 'en', providers: ['openai'], providerModels: { openai: 'gpt-test' },
    locations: [ALPHA], defaultLocation: 'alpha', createdAt: NOW, updatedAt: NOW,
  }).run()
  app = Fastify()
  app.register(apiRoutes, { db, getRunnableProviderNames: () => ['openai'] })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  db.$client.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('query tracking preview: market membership changes', () => {
  it('reports a three-location market emptied when its only query is stopped, and then refuses every add to it', async () => {
    seedPortfolio()
    const uptown = async () => (await workspace()).markets.find(market => market.stableKey === 'uptown')?.targetKeys
    // `before` and `after` are the market's locations as the workspace read lists them before and after the publish.
    expect(await uptown()).toEqual(['harbor', 'river', 'summit'])
    const { preview, commit } = await review({ removals: [{ queryId: 'q-uptown' }] })

    expect(preview.marketChanges).toEqual([{
      marketKey: 'uptown',
      before: { targetKeys: ['harbor', 'river', 'summit'] },
      after: { targetKeys: [] },
      removedTargetKeys: ['harbor', 'river', 'summit'],
      emptied: true,
    }])

    // The server reports the change and still publishes it. Asking for a confirmation is the client's job.
    expect((await publish(commit)).committed).toBe(true)
    expect(await uptown()).toEqual([])
    expect(await refusal(manual('apartments with a rooftop terrace', { marketKeys: ['uptown'] }))).toEqual({
      status: 400,
      body: { error: { code: 'VALIDATION_ERROR', message: 'Select at least one location, group or market.' } },
    })
    expect(await refusal(manual('apartments with a rooftop terrace', { targetKeys: ['harbor'], marketKeys: ['uptown'] }))).toEqual({
      status: 400,
      body: { error: { code: 'VALIDATION_ERROR', message: 'Market "uptown" has no selected location.' } },
    })
  })

  it('reports the two locations a market loses when its only query changes Subject to one location', async () => {
    seedPortfolio()
    const toHarbor = (queryClass?: string) => review({
      removals: [{ queryId: 'q-uptown' }],
      additions: [{ ...manual('best apartments uptown', { targetKeys: ['harbor'], marketKeys: ['uptown'] }), ...(queryClass ? { queryClass } : {}) }],
    })
    const { preview } = await toHarbor()

    expect(preview.marketChanges).toEqual([{
      marketKey: 'uptown',
      before: { targetKeys: ['harbor', 'river', 'summit'] },
      after: { targetKeys: ['harbor'] },
      removedTargetKeys: ['river', 'summit'],
      emptied: false,
    }])
    // Uptown is left with one location, where Type alone decides the Subject: Non-brand still reads as the market.
    const subject = (reviewed: typeof preview) => reviewed.tracked.find(row => row.queryId === 'q-uptown')?.focus
    expect(subject(preview)).toEqual({ kind: 'market', key: 'uptown' })
    expect(subject((await toHarbor('branded')).preview)).toEqual({ kind: 'property', key: 'harbor' })
  })

  it('reports a market emptied by a bulk stop of every query in it, and each other market those queries leave', async () => {
    seedPortfolio()

    // One of two market queries: both locations keep an edge, so nothing is reported.
    expect((await review({ removals: [{ queryId: 'q-down-a' }] })).preview.marketChanges).toEqual([])
    // Both market queries: Pier has no edge left in Downtown, Dock keeps its own query.
    expect((await review({ removals: [{ queryId: 'q-down-a' }, { queryId: 'q-down-b' }] })).preview.marketChanges).toEqual([{
      marketKey: 'downtown',
      before: { targetKeys: ['dock', 'pier'] },
      after: { targetKeys: ['dock'] },
      removedTargetKeys: ['pier'],
      emptied: false,
    }])
    // Every query in Downtown. A full stop of `q-dock` also takes Dock out of Waterfront.
    expect((await review({
      removals: [{ queryId: 'q-down-a' }, { queryId: 'q-down-b' }, { queryId: 'q-dock' }],
    })).preview.marketChanges).toEqual([
      {
        marketKey: 'downtown',
        before: { targetKeys: ['dock', 'pier'] },
        after: { targetKeys: [] },
        removedTargetKeys: ['dock', 'pier'],
        emptied: true,
      },
      {
        marketKey: 'waterfront',
        before: { targetKeys: ['dock', 'pier'] },
        after: { targetKeys: ['pier'] },
        removedTargetKeys: ['dock'],
        emptied: false,
      },
    ])
  })

  it('lists the location a scoped stop drops when that was its last edge in the market', async () => {
    seedPortfolio()

    // Stopped for one location only.
    expect((await review({
      removals: [{ queryId: 'q-uptown', audience: { targetKeys: ['summit'] } }],
    })).preview.marketChanges).toEqual([{
      marketKey: 'uptown',
      before: { targetKeys: ['harbor', 'river', 'summit'] },
      after: { targetKeys: ['harbor', 'river'] },
      removedTargetKeys: ['summit'],
      emptied: false,
    }])
    // Stopped in one market only: Downtown still reports the same execution, so it is not listed.
    expect((await review({
      removals: [{ queryId: 'q-dock', audience: { marketKeys: ['waterfront'] } }],
    })).preview.marketChanges).toEqual([{
      marketKey: 'waterfront',
      before: { targetKeys: ['dock', 'pier'] },
      after: { targetKeys: ['pier'] },
      removedTargetKeys: ['dock'],
      emptied: false,
    }])
    // Pier keeps its edge from the other market query, so its market does not change.
    expect((await review({
      removals: [{ queryId: 'q-down-a', audience: { targetKeys: ['pier'] } }],
    })).preview.marketChanges).toEqual([])
  })

  it('lists no change for an addition, a wording or type edit, or an empty review', async () => {
    seedPortfolio()

    // What the Add queries sheet sends for a location: the location and every market it is in.
    expect((await review({
      additions: [manual('dock house floor plans', { targetKeys: ['dock'], marketKeys: ['downtown', 'waterfront'] })],
    })).preview.marketChanges).toEqual([])
    expect((await review({
      additions: [manual('apartments with a rooftop terrace', { marketKeys: ['uptown'] })],
    })).preview.marketChanges).toEqual([])
    expect((await review({ edits: [{ queryId: 'q-uptown', text: 'top rated apartments uptown' }] })).preview.marketChanges).toEqual([])
    expect((await review({ edits: [{ queryId: 'q-pier', queryClass: 'non-brand' }] })).preview.marketChanges).toEqual([])
    const empty = (await review({})).preview
    expect(empty.diff.noOp).toBe(true)
    expect(empty.marketChanges).toEqual([])
  })

  it('leaves the field off a simple basket, which has no market', async () => {
    db.insert(queries).values({ id: 'q-simple', projectId: PROJECT_ID, query: 'what is northwind', provenance: null, createdAt: NOW }).run()
    const response = await request('POST', '/query-tracking/preview', {
      expectedWorkspaceVersion: (await workspace()).workspaceVersion, additions: [], removals: [{ queryId: 'q-simple' }],
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ mode: 'simple', diff: { removed: [{ queryId: 'q-simple' }] } })
    expect(response.json()).not.toHaveProperty('marketChanges')
  })
})

const LOCATIONS = 192
const MARKETS = 64
const BULK = 50
const pad = (index: number) => String(index).padStart(3, '0')
/** The first 44 markets have six market queries and the rest five, so the plan asks 940 queries. */
const marketQueryIds = (market: number) => Array.from({ length: market < 44 ? 6 : 5 }, (_, index) => `q-m${pad(market)}-${index}`)
const locationQueryIds = (location: number) => [0, 1, 2].map(index => `q-l${pad(location)}-${index}`)
/** Every query asked in one market: its market queries and its three locations' own. */
const queriesOfMarket = (market: number) => [
  ...marketQueryIds(market),
  ...[0, 1, 2].flatMap(offset => locationQueryIds(market * 3 + offset)),
]

/** 192 locations, three to a market, with three queries of their own each; 940 queries in all. */
function seedLargePortfolio(): void {
  const texts: Record<string, string> = {}
  const pairings: Pairing[] = []
  for (let market = 0; market < MARKETS; market += 1) {
    const marketKey = `market-${pad(market)}`
    const targetKeys = [0, 1, 2].map(offset => `loc-${pad(market * 3 + offset)}`)
    for (const queryId of marketQueryIds(market)) {
      texts[queryId] = `best apartments in market ${pad(market)}, list ${queryId}`
      for (const targetKey of targetKeys) {
        pairings.push({ queryId, targetKey, executionNodeKey: `n-${queryId}`, queryClass: 'non-brand', markets: [marketKey] })
      }
    }
    for (const [offset, targetKey] of targetKeys.entries()) {
      for (const queryId of locationQueryIds(market * 3 + offset)) {
        texts[queryId] = `Location ${pad(market * 3 + offset)} reviews, list ${queryId}`
        pairings.push({ queryId, targetKey, executionNodeKey: `n-${queryId}`, queryClass: 'branded', markets: [marketKey] })
      }
    }
  }
  activate(planOf({
    targets: Array.from({ length: LOCATIONS }, (_, index) => [`loc-${pad(index)}`, `Location ${pad(index)}`] as const),
    markets: Array.from({ length: MARKETS }, (_, index) => [`market-${pad(index)}`, `Market ${pad(index)}`] as const),
    texts,
    pairings,
  }))
}

/**
 * Stated budget: one preview or one commit of 50 changes against the
 * 192-location, 940-query plan answers within 20 seconds. It takes well under a
 * second on an idle machine; the margin is for a host busy with parallel
 * builds. The serialization count in the last test is the exact check that the
 * cost does not grow with the number of removals.
 */
const BULK_BUDGET_MS = 20_000
const BULK_TEST_TIMEOUT_MS = 180_000

async function timed<T>(run: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const startedAt = performance.now()
  const result = await run()
  return { result, elapsedMs: performance.now() - startedAt }
}

/** Preview then commit one mutation, each timed on its own. */
async function timedPublish(mutation: Mutation) {
  const payload = {
    expectedWorkspaceVersion: (await workspace()).workspaceVersion,
    additions: mutation.additions ?? [], removals: mutation.removals ?? [],
  }
  const previewed = await timed(() => request('POST', '/query-tracking/preview', payload))
  expect(previewed.result.statusCode, previewed.result.body).toBe(200)
  const preview = queryTrackingPreviewResponseSchema.parse(previewed.result.json())
  const committed = await timed(() => request('POST', '/query-tracking/commit', {
    ...payload, previewToken: preview.previewToken, reviewedAt: preview.reviewedAt,
  }))
  expect(committed.result.statusCode, committed.result.body).toBe(200)
  return { preview, committed: queryTrackingCommitResponseSchema.parse(committed.result.json()), previewMs: previewed.elapsedMs, commitMs: committed.elapsedMs }
}

describe('query tracking preview and commit: bulk cost on a 192-location, 940-query plan', () => {
  it('previews and commits fifty removals inside the budget, emptying the three markets stopped whole', { timeout: BULK_TEST_TIMEOUT_MS }, async () => {
    seedLargePortfolio()
    const before = await workspace()
    expect([before.targets.length, before.markets.length, before.summary?.asked]).toEqual([LOCATIONS, MARKETS, 940])

    // Every query of markets 61 to 63 (14 each), then 8 location queries from market 60, whose market queries stay.
    const stopped = [...[61, 62, 63].flatMap(queriesOfMarket), ...queriesOfMarket(60).slice(5, 13)]
    expect(stopped).toHaveLength(BULK)
    const { preview, committed, previewMs, commitMs } = await timedPublish({ removals: stopped.map(queryId => ({ queryId })) })

    expect(preview.diff.removed).toHaveLength(BULK)
    expect(preview.limits?.queries).toMatchObject({ current: 940, next: 890 })
    expect(preview.marketChanges).toEqual([61, 62, 63].map(market => {
      const targetKeys = [0, 1, 2].map(offset => `loc-${pad(market * 3 + offset)}`)
      return { marketKey: `market-${pad(market)}`, before: { targetKeys }, after: { targetKeys: [] }, removedTargetKeys: targetKeys, emptied: true }
    }))
    expect(committed).toMatchObject({ committed: true, active: { revision: 2 } })
    expect((await workspace()).summary?.asked).toBe(890)
    expect(db.select().from(runs).all()).toEqual([])
    expect(previewMs).toBeLessThan(BULK_BUDGET_MS)
    expect(commitMs).toBeLessThan(BULK_BUDGET_MS)
  })

  it('previews and commits fifty additions inside the budget with no market change', { timeout: BULK_TEST_TIMEOUT_MS }, async () => {
    seedLargePortfolio()
    const additions = Array.from({ length: BULK }, (_, index) => manual(`apartments with a rooftop terrace, list ${index}`, { marketKeys: [`market-${pad(index)}`] }))
    const { preview, committed, previewMs, commitMs } = await timedPublish({ additions })

    expect(preview.diff.added).toHaveLength(BULK)
    expect(preview.limits?.queries).toMatchObject({ current: 940, next: 990 })
    // One new execution per query, shared by its market's three locations.
    expect(preview.workload).toMatchObject({ addedNodes: BULK, addedProviderCalls: BULK, removedNodes: 0 })
    expect(preview.marketChanges).toEqual([])
    expect(committed).toMatchObject({ committed: true, active: { revision: 2 } })
    expect((await workspace()).summary?.asked).toBe(990)
    expect(db.select().from(runs).all()).toEqual([])
    expect(previewMs).toBeLessThan(BULK_BUDGET_MS)
    expect(commitMs).toBeLessThan(BULK_BUDGET_MS)
  })

  it('serializes the plan no more often for fifty removals than for one', { timeout: BULK_TEST_TIMEOUT_MS }, async () => {
    seedLargePortfolio()
    const serializations = vi.mocked(canonicalMeasurementPlanV2Json)
    const counted = async (removals: string[]) => {
      const payload = {
        expectedWorkspaceVersion: (await workspace()).workspaceVersion, additions: [],
        removals: removals.map(queryId => ({ queryId })),
      }
      serializations.mockClear()
      const preview = queryTrackingPreviewResponseSchema.parse((await request('POST', '/query-tracking/preview', payload)).json())
      const previewCalls = serializations.mock.calls.length
      serializations.mockClear()
      const committed = await request('POST', '/query-tracking/commit', { ...payload, previewToken: preview.previewToken, reviewedAt: preview.reviewedAt })
      expect(committed.statusCode, committed.body).toBe(200)
      return { removed: preview.diff.removed.length, previewCalls, commitCalls: serializations.mock.calls.length }
    }

    const one = await counted(queriesOfMarket(0).slice(0, 1))
    const fifty = await counted([...[61, 62, 63].flatMap(queriesOfMarket), ...queriesOfMarket(60).slice(5, 13)])

    expect([one.removed, fifty.removed]).toEqual([1, BULK])
    // The spy sees the routes' own calls, so equal counts are not two zeroes.
    expect(one.previewCalls).toBeGreaterThan(0)
    expect(one.commitCalls).toBeGreaterThan(0)
    expect(fifty.previewCalls).toBe(one.previewCalls)
    expect(fifty.commitCalls).toBe(one.commitCalls)
  })
})
