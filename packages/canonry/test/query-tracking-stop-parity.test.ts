import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRoutes } from '@canonry/canonry-api-routes'
import {
  buildMeasurementRunManifestV1, canonicalMeasurementPlanV2Json, measurementPlanV2ChecksumJson, measurementPlanV2Schema,
  RunKinds, RunStatuses, RunTriggers,
} from '@canonry/canonry-contracts'
import {
  apiKeys, createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries, querySnapshots, runs, type DatabaseClient,
} from '@canonry/canonry-db'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'
import { invokeCli } from './cli-test-utils.js'

const NOW = '2026-10-09T12:00:00.000Z'
const SWEPT_AT = '2026-10-07T09:30:00.000Z'
const PROJECT = 'northwind'
const NYC = { label: 'nyc', city: 'New York', region: 'NY', country: 'US' }
/** Setup mints a uuid for each query. */
const SUPPLIER = { id: crypto.randomUUID(), text: 'best widget supplier' }
const WIDGETS = { id: crypto.randomUUID(), text: 'northwind widgets reviews' }
const FROZEN = { source: 'manual', sourceId: null, capturedAt: NOW }
const cleanups: Array<() => Promise<void>> = []
let directory: string
let db: DatabaseClient
let api: ApiClient
let origin: string
let key: string

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex')

/**
 * Revision 1: the Metro market holds Gadgets and Widgets through one market query, and Widgets has its own.
 * One whole-project sweep finished partial: it stored the market query's answer and none for Widgets' own query.
 */
function seedSweptPortfolio() {
  const edges = [
    { executionNodeKey: 'n-supplier', targetKey: 'gadgets', queryId: SUPPLIER.id },
    { executionNodeKey: 'n-supplier', targetKey: 'widgets', queryId: SUPPLIER.id },
    { executionNodeKey: 'n-widgets', targetKey: 'widgets', queryId: WIDGETS.id },
  ]
  const provisional = measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'northwind.example', ownedHosts: ['northwind.example'], names: ['Northwind'] } },
    targets: [['gadgets', 'Gadgets'], ['widgets', 'Widgets']].map(([stableKey, label]) => ({
      stableKey, label, aliases: [`Northwind ${label}`],
      urlMatchers: [{ kind: 'prefix', host: 'northwind.example', pathPrefix: `/${stableKey}`, pathCase: 'insensitive' }],
      mentionNotApplicable: false, discoveryIdentity: null,
    })),
    groups: [],
    querySnapshots: [SUPPLIER, WIDGETS].map(query => ({ queryId: query.id, queryText: query.text, provenance: FROZEN })),
    assignments: edges.map(edge => ({ ...edge, queryClass: edge.queryId === WIDGETS.id ? 'branded' : 'non-brand', classificationSource: 'operator' })),
    executionNodes: [[SUPPLIER, 'n-supplier'] as const, [WIDGETS, 'n-widgets'] as const].map(([query, stableKey]) => ({
      stableKey, queryId: query.id, queryText: query.text, expectedSnapshots: 1,
      context: { providers: ['openai'], models: { openai: 'gpt-test' }, location: NYC },
    })),
    usageEdges: edges,
    reportingScopes: [{ stableKey: 'metro', label: 'Metro', kind: 'market', usageEdges: edges }],
    compiledChecksum: '0'.repeat(64),
  })
  const plan = measurementPlanV2Schema.parse({ ...provisional, compiledChecksum: sha256(measurementPlanV2ChecksumJson(provisional)) })
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.insert(measurementPlanVersions).values({
    id: 'plan-v1', projectId: 'prj_northwind', revision: 1, canonicalJson, checksum: sha256(canonicalJson), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, comparableToVersionId: null, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId: 'prj_northwind', activeVersionId: 'plan-v1', createdAt: NOW, updatedAt: NOW }).run()
  db.insert(runs).values({
    id: 'sweep-1', projectId: 'prj_northwind', kind: RunKinds['answer-visibility'], status: RunStatuses.partial, trigger: RunTriggers.manual,
    measurementPlanVersionId: 'plan-v1', finishedAt: SWEPT_AT, createdAt: SWEPT_AT,
    measurementManifest: buildMeasurementRunManifestV1({
      expectedSlots: plan.executionNodes.map(node => ({
        executionId: node.stableKey, queryText: node.queryText, provider: 'openai', context: NYC, requestedModel: 'gpt-test',
      })),
    }),
  }).run()
  db.insert(querySnapshots).values({
    id: 'answer-1', runId: 'sweep-1', queryId: SUPPLIER.id, queryText: SUPPLIER.text, provider: 'openai', model: 'gpt-test',
    citationState: 'not-cited', citedDomains: [], competitorOverlap: [], recommendedCompetitors: [],
    location: NYC.label, measurementExecutionId: 'n-supplier', requestedContext: NYC, supportedContext: { status: 'applied', resolved: NYC },
    createdAt: SWEPT_AT,
  }).run()
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-query-tracking-stop-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', directory)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  const database = path.join(directory, 'test.db')
  db = createClient(database)
  migrate(db)
  db.insert(projects).values({
    id: 'prj_northwind', name: PROJECT, displayName: 'Northwind', canonicalDomain: 'northwind.example',
    country: 'US', language: 'en', providers: ['openai'], providerModels: { openai: 'gpt-test' },
    locations: [NYC], defaultLocation: 'nyc', createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(queries).values([SUPPLIER, WIDGETS].map(query => ({
    id: query.id, projectId: 'prj_northwind', query: query.text, provenance: 'measurement-template:setup', createdAt: NOW,
  }))).run()
  key = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({ id: 'root', name: 'root', keyHash: sha256(key), keyPrefix: key.slice(0, 9), scopes: ['*'], projectId: null, createdAt: NOW }).run()
  const app = Fastify()
  app.register(apiRoutes, { db, getRunnableProviderNames: () => ['openai'] })
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
  const client = new Client({ name: 'query-tracking-stop-test', version: '1' }, { capabilities: {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanups.push(async () => { await client.close(); await server.close() })
  return client
}

/** A reviewed removal of the whole query, with no location named: the request both write surfaces pass through. */
async function reviewedRemoval(queryId: string) {
  const request = { expectedWorkspaceVersion: (await api.getQueryTrackingWorkspace(PROJECT)).workspaceVersion, additions: [], removals: [{ queryId }] }
  const review = await api.previewQueryTracking(PROJECT, request)
  return { ...request, previewToken: review.previewToken, reviewedAt: review.reviewedAt }
}

async function commitViaCli(name: string, request: unknown) {
  const file = path.join(directory, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(request))
  const result = await invokeCli(['query', 'commit', PROJECT, file, '--format', 'json'])
  expect(result.exitCode, result.stderr).toBeUndefined()
  return JSON.parse(result.stdout) as unknown
}

async function commitViaMcp(mcp: Client, request: unknown) {
  const tool = await mcp.callTool({ name: 'canonry_query_tracking_commit', arguments: { project: PROJECT, request } })
  expect(tool.isError, JSON.stringify(tool)).not.toBe(true)
  return tool.structuredContent
}

/** The workspace through the REST client, the CLI and the MCP tool, each over its real transport. */
async function workspaceEverywhere(mcp: Client) {
  const rest = await api.getQueryTrackingWorkspace(PROJECT)
  const cli = await invokeCli(['query', 'workspace', PROJECT, '--format', 'json'])
  expect(cli.exitCode, cli.stderr).toBeUndefined()
  const tool = await mcp.callTool({ name: 'canonry_query_tracking_workspace', arguments: { project: PROJECT } })
  expect(tool.isError, JSON.stringify(tool)).not.toBe(true)
  return { rest, viaCli: JSON.parse(cli.stdout) as unknown, viaMcp: tool.structuredContent }
}

describe('query tracking stop CLI/REST/MCP parity', () => {
  it('stops an asked query with one bare removal on the CLI and on MCP, keeps both rows, and deletes one on a second removal', async () => {
    seedSweptPortfolio()
    const mcp = await connect()

    // The same request shape through each write surface, on one query each.
    const viaCli = await commitViaCli('stop', await reviewedRemoval(SUPPLIER.id))
    expect(viaCli).toMatchObject({
      committed: true, active: { revision: 2 },
      diff: { removed: [{ queryId: SUPPLIER.id, queryText: SUPPLIER.text, assignmentCount: 2 }] },
    })
    const viaMcp = await commitViaMcp(mcp, await reviewedRemoval(WIDGETS.id))
    expect(viaMcp).toMatchObject({
      committed: true, active: { revision: 3 },
      diff: { removed: [{ queryId: WIDGETS.id, queryText: WIDGETS.text, assignmentCount: 1 }] },
    })

    // Both queries are still on the list, not asked. The one a sweep answered shows when.
    const stopped = await workspaceEverywhere(mcp)
    const notAsked = (query: typeof SUPPLIER, lastMeasuredAt: string | null) => ({
      queryId: query.id, queryText: query.text, provenance: FROZEN, state: 'awaiting-sweep', lastMeasuredAt,
      assignments: [], focus: { kind: 'not-asked' }, queryClasses: [],
    })
    expect(stopped.rest.tracked).toMatchObject([notAsked(SUPPLIER, SWEPT_AT), notAsked(WIDGETS, null)])
    expect(stopped.rest.summary).toMatchObject({ asked: 0, notAsked: 2 })
    expect(stopped.viaCli).toStrictEqual(stopped.rest)
    expect(stopped.viaMcp).toStrictEqual(stopped.rest)
    expect(db.select().from(querySnapshots).all().map(answer => answer.queryId)).toEqual([SUPPLIER.id])

    // The same removal of a query that is asked nowhere deletes its row and publishes nothing.
    const deleted = await commitViaMcp(mcp, await reviewedRemoval(SUPPLIER.id))
    expect(deleted).toMatchObject({
      committed: true, active: { revision: 3 },
      diff: { removed: [{ queryId: SUPPLIER.id, queryText: SUPPLIER.text, assignmentCount: 0 }] },
    })
    const after = await workspaceEverywhere(mcp)
    expect(after.rest.tracked.map(row => row.queryId)).toEqual([WIDGETS.id])
    expect(after.viaCli).toStrictEqual(after.rest)
    expect(after.viaMcp).toStrictEqual(after.rest)
  })
})
