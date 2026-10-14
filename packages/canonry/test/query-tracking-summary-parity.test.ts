import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { canonicalMeasurementPlanV2Json, measurementPlanV2ChecksumJson, measurementPlanV2Schema } from '@ainyc/canonry-contracts'
import { apiKeys, createClient, measurementPlans, measurementPlanVersions, measurementQueryTemplates, migrate, projects, queries, type DatabaseClient } from '@ainyc/canonry-db'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'
import { invokeCli } from './cli-test-utils.js'

const NOW = '2026-10-09T12:00:00.000Z'
const PROJECT = 'northwind'
const TARGET = {
  stableKey: 'widgets', label: 'Widgets', status: 'included' as const, aliases: ['Northwind Widgets'],
  urlMatchers: ['https://northwind.example/widgets/*'], source: 'manual' as const,
}
const cleanups: Array<() => Promise<void>> = []
let directory: string
let db: DatabaseClient
let api: ApiClient
let origin: string
let key: string

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-query-tracking-summary-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', directory)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  const database = path.join(directory, 'test.db')
  db = createClient(database)
  migrate(db)
  db.insert(projects).values({
    id: 'prj_northwind', name: PROJECT, displayName: 'Northwind', canonicalDomain: 'northwind.example',
    country: 'US', language: 'en', providers: ['openai', 'gemini'], providerModels: { openai: 'gpt-test', gemini: 'gemini-test' },
    locations: [{ label: 'nyc', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: 'nyc',
    createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(queries).values([
    { id: 'q-supplier', projectId: 'prj_northwind', query: 'best widget supplier', createdAt: NOW },
    { id: 'q-brand', projectId: 'prj_northwind', query: 'northwind delivery times', createdAt: NOW },
  ]).run()
  key = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({ id: 'root', name: 'root', keyHash: crypto.createHash('sha256').update(key).digest('hex'),
    keyPrefix: key.slice(0, 9), scopes: ['*'], projectId: null, createdAt: NOW }).run()
  const app = Fastify()
  app.register(apiRoutes, { db, getRunnableProviderNames: () => ['gemini', 'openai'] })
  cleanups.push(async () => { await app.close(); db.$client.close() })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback listener')
  origin = `http://127.0.0.1:${address.port}`
  fs.writeFileSync(path.join(directory, 'config.yaml'), JSON.stringify({ apiUrl: origin, database, apiKey: key, providers: {} }))
  api = new ApiClient(origin, key, { skipProbe: true })
})

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
})

async function connect() {
  const server = createCanonryMcpServer({ scope: 'all', tiers: ['setup'],
    clientFactory: () => new ApiClient(origin, key, { skipProbe: true }) })
  const client = new Client({ name: 'query-tracking-summary-test', version: '1' }, { capabilities: {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanups.push(async () => { await client.close(); await server.close() })
  return client
}

/** Publishes revision 1: one location asked one of the two catalog queries. */
async function advancedProject() {
  let etag = (await api.createMeasurementPlanDraft(PROJECT, { expectedActiveRevision: null }, 'create-1')).etag
  etag = (await api.upsertMeasurementDraftTarget(PROJECT, { target: TARGET }, 'target-1', etag)).etag
  etag = (await api.applyMeasurementDraftAssignments(PROJECT, { targetKey: 'widgets', queryIds: ['q-supplier'] }, 'assign-1', etag)).etag
  const first = await api.compileMeasurementDraftPreview(PROJECT)
  await api.publishMeasurementDraft(PROJECT, { expectedActiveRevision: null, expectedCompiledChecksum: first.compiledChecksum! }, 'publish-1', etag)
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex')

/**
 * Revision 1, stored as a publish leaves it: Lakeshore metro holds Gadgets and Widgets, and its child North holds Gadgets.
 * - The Supplier market (`metro`), on North, holds Gadgets through `q-supplier`.
 * - The Outlet market, on no group, holds Gadgets and Widgets through `q-brand`, asked as Branded for Widgets only.
 * A saved pattern written with `{submarket}` makes the Supplier market's query text.
 */
function seedGroupedPlan() {
  const pairings = [
    { executionNodeKey: 'n-supplier', targetKey: 'gadgets', queryId: 'q-supplier', queryClass: 'non-brand', market: 'metro' },
    { executionNodeKey: 'n-brand', targetKey: 'gadgets', queryId: 'q-brand', queryClass: 'non-brand', market: 'outlet' },
    { executionNodeKey: 'n-brand', targetKey: 'widgets', queryId: 'q-brand', queryClass: 'branded', market: 'outlet' },
  ]
  const edge = ({ executionNodeKey, targetKey, queryId }: (typeof pairings)[number]) => ({ executionNodeKey, targetKey, queryId })
  const texts: Record<string, string> = { 'q-supplier': 'best widget supplier', 'q-brand': 'northwind delivery times' }
  const provisional = measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'northwind.example', ownedHosts: ['northwind.example'], names: ['Northwind'] } },
    targets: [['gadgets', 'Gadgets'], ['widgets', 'Widgets']].map(([stableKey, label]) => ({
      stableKey, label, aliases: [`Northwind ${label}`],
      urlMatchers: [{ kind: 'prefix', host: 'northwind.example', pathPrefix: `/${stableKey}`, pathCase: 'insensitive' }],
      mentionNotApplicable: false, discoveryIdentity: null,
    })),
    groups: [
      { stableKey: 'lakeshore', label: 'Lakeshore metro', targetKeys: ['gadgets', 'widgets'], competitors: [] },
      { stableKey: 'north', label: 'North', parentGroupKey: 'lakeshore', targetKeys: ['gadgets'], competitors: [] },
    ],
    querySnapshots: Object.entries(texts).map(([queryId, queryText]) => ({
      queryId, queryText, provenance: { source: 'manual', sourceId: null, capturedAt: NOW },
    })),
    assignments: pairings.map(pairing => ({ ...edge(pairing), queryClass: pairing.queryClass, classificationSource: 'server' })),
    executionNodes: Object.entries(texts).map(([queryId, queryText]) => ({
      stableKey: queryId.replace('q-', 'n-'), queryId, queryText, expectedSnapshots: 2,
      context: { providers: ['gemini', 'openai'], models: { gemini: 'gemini-test', openai: 'gpt-test' }, location: { label: 'nyc', city: 'New York', region: 'NY', country: 'US' } },
    })),
    usageEdges: pairings.map(edge),
    reportingScopes: [
      { stableKey: 'metro', label: 'Supplier', kind: 'market', groupKey: 'north', usageEdges: pairings.filter(pairing => pairing.market === 'metro').map(edge) },
      { stableKey: 'outlet', label: 'Outlet', kind: 'market', usageEdges: pairings.filter(pairing => pairing.market === 'outlet').map(edge) },
    ],
    compiledChecksum: '0'.repeat(64),
  })
  const plan = measurementPlanV2Schema.parse({ ...provisional, compiledChecksum: sha256(measurementPlanV2ChecksumJson(provisional)) })
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.insert(measurementPlanVersions).values({
    id: 'plan-v1', projectId: 'prj_northwind', revision: 1, canonicalJson, checksum: sha256(canonicalJson), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, comparableToVersionId: null, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId: 'prj_northwind', activeVersionId: 'plan-v1', createdAt: NOW, updatedAt: NOW }).run()
  db.insert(measurementQueryTemplates).values({
    id: 'tpl-best', projectId: 'prj_northwind', name: 'Best', description: null, pattern: 'best widget {submarket}', variables: ['submarket'], createdAt: NOW, updatedAt: NOW,
  }).run()
}

/** The same read through the REST client, both CLI commands and the MCP tool, each over its real transport. */
async function readEverywhere() {
  const rest = await api.getQueryTrackingWorkspace(PROJECT)
  const viaCli: unknown[] = []
  for (const args of [['query', 'workspace', PROJECT], ['measurement-plan', 'advanced', PROJECT, 'query-workspace']]) {
    const result = await invokeCli([...args, '--format', 'json'])
    expect(result.exitCode, result.stderr).toBeUndefined()
    viaCli.push(JSON.parse(result.stdout))
  }
  const mcp = await connect()
  const tool = await mcp.callTool({ name: 'canonry_query_tracking_workspace', arguments: { project: PROJECT } })
  expect(tool.isError, JSON.stringify(tool)).not.toBe(true)
  return { rest, viaCli, viaMcp: tool.structuredContent }
}

describe('query tracking workspace numbers CLI/REST/MCP parity', () => {
  it('returns one advanced summary, limit and set of place counts on every surface', async () => {
    await advancedProject()
    const { rest, viaCli, viaMcp } = await readEverywhere()

    expect(rest.summary).toStrictEqual({
      asked: 1, notAsked: 1,
      byClass: { branded: 0, nonBrand: 1, mixed: 0, unknown: 0 },
      byFocus: { market: 0, property: 1, company: 0, custom: 0 },
      assignments: { total: 1, branded: 0, nonBrand: 1, unknown: 0 },
      // One query asked of two engines at the one search location.
      answersPerSweep: 2,
      structure: { targets: 1, markets: 0, groups: 0, topLevelGroups: 0, competitors: 0 },
    })
    expect(rest.limits).toStrictEqual({
      queries: { current: 1, next: 1, max: 1_000, left: { current: 999, next: 999 }, over: { current: 0, next: 0 }, exceeded: false },
    })
    expect(rest.targets).toStrictEqual([{
      stableKey: 'widgets', label: 'Widgets', marketKeys: [],
      counts: {
        queries: 1, byClass: { branded: 0, nonBrand: 1, mixed: 0, unknown: 0 },
        propertyQueries: 1, marketQueries: 0, customQueries: 0, answersPerSweep: 2,
      },
    }])
    expect(rest.tracked.map(row => [row.queryId, row.queryClasses])).toStrictEqual([['q-supplier', ['non-brand']], ['q-brand', []]])
    // The one location has a query of its own, and the plan has no market.
    expect(rest.views).toStrictEqual({
      noPropertyQueries: { count: 0, targetKeys: [] },
      thinMarkets: { count: 0, floor: 4, marketKeys: [] },
      patternGaps: { count: 0, compared: 0, patterns: [] },
    })
    expect(viaCli).toStrictEqual([rest, rest])
    expect(viaMcp).toStrictEqual(rest)
  })

  it('returns one set of group, market and location counts, and one pattern comparison, on every surface', async () => {
    seedGroupedPlan()
    const { rest, viaCli, viaMcp } = await readEverywhere()

    expect(rest.groups.map(({ stableKey, counts }) => ({ stableKey, counts }))).toStrictEqual([
      // No market is attached to the metro: its two locations sit in two. `q-brand` holds both types across them.
      {
        stableKey: 'lakeshore',
        counts: { queries: 2, byClass: { branded: 0, nonBrand: 1, mixed: 1, unknown: 0 }, marketQueries: 2, propertyQueries: 0, customQueries: 0, markets: 2, answersPerSweep: 4 },
      },
      // One market is attached to North, and Gadgets also sits in Outlet. Gadgets is asked `q-brand` as Non-brand only.
      {
        stableKey: 'north',
        counts: { queries: 2, byClass: { branded: 0, nonBrand: 2, mixed: 0, unknown: 0 }, marketQueries: 2, propertyQueries: 0, customQueries: 0, markets: 2, answersPerSweep: 4 },
      },
    ])
    expect(rest.markets.map(({ stableKey, counts }) => ({ stableKey, counts }))).toStrictEqual([
      { stableKey: 'metro', counts: { queries: 1, byClass: { branded: 0, nonBrand: 1, mixed: 0, unknown: 0 }, marketQueries: 1, propertyQueries: 0, answersPerSweep: 2 } },
      { stableKey: 'outlet', counts: { queries: 1, byClass: { branded: 0, nonBrand: 0, mixed: 1, unknown: 0 }, marketQueries: 1, propertyQueries: 0, answersPerSweep: 2 } },
    ])
    expect(rest.targets.map(({ stableKey, marketKeys, counts }) => ({ stableKey, marketKeys, counts }))).toStrictEqual([
      {
        stableKey: 'gadgets', marketKeys: ['metro', 'outlet'],
        counts: { queries: 2, byClass: { branded: 0, nonBrand: 2, mixed: 0, unknown: 0 }, propertyQueries: 0, marketQueries: 2, customQueries: 0, answersPerSweep: 4 },
      },
      {
        stableKey: 'widgets', marketKeys: ['outlet'],
        counts: { queries: 1, byClass: { branded: 1, nonBrand: 0, mixed: 0, unknown: 0 }, propertyQueries: 0, marketQueries: 1, customQueries: 0, answersPerSweep: 2 },
      },
    ])
    // The `{submarket}` pattern is read as a market pattern: Supplier asks its text and Outlet does not.
    expect(rest.views?.patternGaps).toStrictEqual({
      count: 1, compared: 1,
      patterns: [{ templateId: 'tpl-best', name: 'Best', pattern: 'best widget {submarket}', usedMarketKeys: ['metro'], missingMarketKeys: ['outlet'] }],
    })
    expect(viaCli).toStrictEqual([rest, rest])
    expect(viaMcp).toStrictEqual(rest)
  })

  it('returns one simple summary and each row\'s class on every surface, with no limit', async () => {
    const { rest, viaCli, viaMcp } = await readEverywhere()

    expect(rest.summary).toStrictEqual({
      asked: 2, notAsked: 0,
      byClass: { branded: 1, nonBrand: 1, mixed: 0, unknown: 0 },
      byFocus: { market: 0, property: 0, company: 2, custom: 0 },
      assignments: { total: 0, branded: 0, nonBrand: 0, unknown: 0 },
      answersPerSweep: 4,
      structure: { targets: 0, markets: 0, groups: 0, topLevelGroups: 0, competitors: 0 },
    })
    expect(rest).not.toHaveProperty('limits')
    expect(rest).not.toHaveProperty('views')
    expect(rest.tracked.map(row => [row.queryId, row.queryClasses])).toStrictEqual([['q-supplier', ['non-brand']], ['q-brand', ['branded']]])
    expect(viaCli).toStrictEqual([rest, rest])
    expect(viaMcp).toStrictEqual(rest)
  })
})
