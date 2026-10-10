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
import { apiKeys, createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries, type DatabaseClient } from '@ainyc/canonry-db'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'
import { invokeCli } from './cli-test-utils.js'

const NOW = '2026-10-09T12:00:00.000Z'
const PROJECT = 'northwind'
const NYC = { label: 'nyc', city: 'New York', region: 'NY', country: 'US' }
const cleanups: Array<() => Promise<void>> = []
let directory: string
let db: DatabaseClient
let api: ApiClient
let origin: string
let key: string

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-query-tracking-preview-'))
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
  db.insert(queries).values([
    { id: 'q-supplier', projectId: 'prj_northwind', query: 'best widget supplier', createdAt: NOW },
    { id: 'q-widgets', projectId: 'prj_northwind', query: 'northwind widgets reviews', createdAt: NOW },
  ]).run()
  key = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({ id: 'root', name: 'root', keyHash: crypto.createHash('sha256').update(key).digest('hex'),
    keyPrefix: key.slice(0, 9), scopes: ['*'], projectId: null, createdAt: NOW }).run()
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
  vi.useRealTimers()
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
})

async function connect() {
  const server = createCanonryMcpServer({ scope: 'all', tiers: ['setup'],
    clientFactory: () => new ApiClient(origin, key, { skipProbe: true }) })
  const client = new Client({ name: 'query-tracking-preview-test', version: '1' }, { capabilities: {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanups.push(async () => { await client.close(); await server.close() })
  return client
}

function inputFile(name: string, input: unknown): string {
  const file = path.join(directory, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(input))
  return file
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex')

/** Revision 1: the Metro market holds Gadgets and Widgets through one market query; Widgets also has its own. */
function seedAdvancedPlan() {
  const edges = [
    { executionNodeKey: 'n-supplier', targetKey: 'gadgets', queryId: 'q-supplier' },
    { executionNodeKey: 'n-supplier', targetKey: 'widgets', queryId: 'q-supplier' },
    { executionNodeKey: 'n-widgets', targetKey: 'widgets', queryId: 'q-widgets' },
  ]
  const texts: Record<string, string> = { 'q-supplier': 'best widget supplier', 'q-widgets': 'northwind widgets reviews' }
  const provisional = measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'northwind.example', ownedHosts: ['northwind.example'], names: ['Northwind'] } },
    targets: [['gadgets', 'Gadgets'], ['widgets', 'Widgets']].map(([stableKey, label]) => ({
      stableKey, label, aliases: [`Northwind ${label}`],
      urlMatchers: [{ kind: 'prefix', host: 'northwind.example', pathPrefix: `/${stableKey}`, pathCase: 'insensitive' }],
      mentionNotApplicable: false, discoveryIdentity: null,
    })),
    groups: [],
    querySnapshots: Object.entries(texts).map(([queryId, queryText]) => ({
      queryId, queryText, provenance: { source: 'manual', sourceId: null, capturedAt: NOW },
    })),
    assignments: edges.map(edge => ({ ...edge, queryClass: edge.queryId === 'q-widgets' ? 'branded' : 'non-brand', classificationSource: 'server' })),
    executionNodes: Object.entries(texts).map(([queryId, queryText]) => ({
      stableKey: queryId.replace('q-', 'n-'), queryId, queryText, expectedSnapshots: 1,
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
}

/**
 * The same preview through the REST client, both CLI commands and the MCP tool, each over its real transport.
 * The clock is held at the current time for the four calls, so the server-minted review time and token match too.
 */
async function previewEverywhere(name: string, request: Parameters<ApiClient['previewQueryTracking']>[1]) {
  const mcp = await connect()
  const file = inputFile(name, request)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
  try {
    const rest = await api.previewQueryTracking(PROJECT, request)
    const viaCli: unknown[] = []
    for (const args of [['query', 'preview', PROJECT, file], ['measurement-plan', 'advanced', PROJECT, 'query-preview', file]]) {
      const result = await invokeCli([...args, '--format', 'json'])
      expect(result.exitCode, result.stderr).toBeUndefined()
      viaCli.push(JSON.parse(result.stdout))
    }
    const tool = await mcp.callTool({ name: 'canonry_query_tracking_preview', arguments: { project: PROJECT, request } })
    expect(tool.isError, JSON.stringify(tool)).not.toBe(true)
    return { rest, viaCli, viaMcp: tool.structuredContent, mcp }
  } finally {
    vi.useRealTimers()
  }
}

describe('query tracking preview CLI/REST/MCP parity', () => {
  it('returns the same market changes on every surface, publishes the change, then refuses an add to the emptied market in the same words', async () => {
    seedAdvancedPlan()
    const workspace = await api.getQueryTrackingWorkspace(PROJECT)
    expect(workspace.markets.map(market => [market.stableKey, market.targetKeys])).toEqual([['metro', ['gadgets', 'widgets']]])
    const base = { expectedWorkspaceVersion: workspace.workspaceVersion, additions: [] }

    // The market query stopped for Gadgets only: Metro keeps Widgets.
    const shrink = await previewEverywhere('shrink', { ...base, removals: [{ queryId: 'q-supplier', audience: { targetKeys: ['gadgets'] } }] })
    expect(shrink.rest.marketChanges).toStrictEqual([{
      marketKey: 'metro', before: { targetKeys: ['gadgets', 'widgets'] }, after: { targetKeys: ['widgets'] },
      removedTargetKeys: ['gadgets'], emptied: false,
    }])
    expect(shrink.viaCli).toStrictEqual([shrink.rest, shrink.rest])
    expect(shrink.viaMcp).toStrictEqual(shrink.rest)

    // Every query in Metro stopped.
    const emptying = { ...base, removals: [{ queryId: 'q-supplier' }, { queryId: 'q-widgets' }] }
    const emptied = await previewEverywhere('empty', emptying)
    expect(emptied.rest.marketChanges).toStrictEqual([{
      marketKey: 'metro', before: { targetKeys: ['gadgets', 'widgets'] }, after: { targetKeys: [] },
      removedTargetKeys: ['gadgets', 'widgets'], emptied: true,
    }])
    expect(emptied.viaCli).toStrictEqual([emptied.rest, emptied.rest])
    expect(emptied.viaMcp).toStrictEqual(emptied.rest)

    // The server reports the emptied market and still publishes. Asking for a confirmation is the client's job.
    const commit = { ...emptying, previewToken: emptied.rest.previewToken, reviewedAt: emptied.rest.reviewedAt }
    const published = await invokeCli(['query', 'commit', PROJECT, inputFile('commit', commit), '--format', 'json'])
    expect(published.exitCode, published.stderr).toBeUndefined()
    expect(JSON.parse(published.stdout)).toMatchObject({ committed: true, active: { revision: 2 } })

    const after = await api.getQueryTrackingWorkspace(PROJECT)
    expect(after.markets.map(market => [market.stableKey, market.targetKeys])).toEqual([['metro', []]])
    const add = {
      expectedWorkspaceVersion: after.workspaceVersion, removals: [],
      additions: [{ input: { source: 'manual' as const, text: 'widget warranty terms' }, audience: { marketKeys: ['metro'] } }],
    }
    const refusal = { code: 'VALIDATION_ERROR', message: 'Select at least one location, group or market.', details: { httpStatus: 400 } }
    await expect(api.previewQueryTracking(PROJECT, add)).rejects.toMatchObject(refusal)
    const cliAdd = await invokeCli(['query', 'preview', PROJECT, inputFile('add', add), '--format', 'json'])
    expect(cliAdd.exitCode).toBe(1)
    expect(JSON.parse(cliAdd.stderr)).toMatchObject({ error: refusal })
    const mcpAdd = await emptied.mcp.callTool({ name: 'canonry_query_tracking_preview', arguments: { project: PROJECT, request: add } })
    expect(mcpAdd.isError).toBe(true)
    expect(mcpAdd.structuredContent).toMatchObject({ error: refusal })
  })

  it('returns no market changes field for a simple project on any surface', async () => {
    const workspace = await api.getQueryTrackingWorkspace(PROJECT)
    const { rest, viaCli, viaMcp } = await previewEverywhere('simple', {
      expectedWorkspaceVersion: workspace.workspaceVersion, additions: [], removals: [{ queryId: 'q-supplier' }],
    })

    expect(rest.mode).toBe('simple')
    expect(rest.diff.removed.map(row => row.queryId)).toEqual(['q-supplier'])
    expect(rest).not.toHaveProperty('marketChanges')
    expect(viaCli).toStrictEqual([rest, rest])
    expect(viaMcp).toStrictEqual(rest)
  })
})
