import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { apiKeys, createClient, migrate, projects, queries, type DatabaseClient } from '@ainyc/canonry-db'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'
import { invokeCli } from './cli-test-utils.js'

const NOW = '2026-10-09T12:00:00.000Z'
const PROJECT = 'northwind'
const TRACKED_SINCE = 'widget warranty terms'
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
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-draft-out-of-date-'))
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
    { id: 'q-delivery', projectId: 'prj_northwind', query: 'widget delivery times', createdAt: NOW },
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
  const client = new Client({ name: 'draft-out-of-date-test', version: '1' }, { capabilities: {} })
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

/** Revision 1, a draft started from it, then a tracking publish to revision 2 that the draft does not hold. */
async function draftLeftBehindByTracking() {
  let etag = (await api.createMeasurementPlanDraft(PROJECT, { expectedActiveRevision: null }, 'create-1')).etag
  etag = (await api.upsertMeasurementDraftTarget(PROJECT, { target: TARGET }, 'target-1', etag)).etag
  etag = (await api.applyMeasurementDraftAssignments(PROJECT, { targetKey: 'widgets', queryIds: ['q-supplier'] }, 'assign-1', etag)).etag
  const first = await api.compileMeasurementDraftPreview(PROJECT)
  await api.publishMeasurementDraft(PROJECT, { expectedActiveRevision: null, expectedCompiledChecksum: first.compiledChecksum! }, 'publish-1', etag)

  etag = (await api.createMeasurementPlanDraft(PROJECT, { expectedActiveRevision: 1 }, 'create-2')).etag
  etag = (await api.applyMeasurementDraftAssignments(PROJECT, { targetKey: 'widgets', queryIds: ['q-delivery'] }, 'assign-2', etag)).etag

  const workspace = await api.getQueryTrackingWorkspace(PROJECT)
  const mutation = {
    expectedWorkspaceVersion: workspace.workspaceVersion, removals: [],
    additions: [{
      input: { source: 'manual' as const, text: TRACKED_SINCE }, audience: { targetKeys: ['widgets'] },
      contexts: workspace.defaultContexts.map(context => ({ ...context, location: context.location?.label ?? null })),
    }],
  }
  const review = await api.previewQueryTracking(PROJECT, mutation)
  const committed = await api.commitQueryTracking(PROJECT, { ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
  expect(committed).toMatchObject({ committed: true, active: { revision: 2 } })

  // What a CLI or MCP caller sends: the revision it just read and the draft it just compiled.
  const compiled = await api.compileMeasurementDraftPreview(PROJECT)
  return { etag, request: { expectedActiveRevision: 2, expectedCompiledChecksum: compiled.compiledChecksum! } }
}

async function activeQueries() {
  const { active } = await api.getMeasurementPlan(PROJECT)
  if (active?.plan.schemaVersion !== 2) throw new Error('Expected an active v2 plan')
  return { revision: active.revision, queries: active.plan.querySnapshots.map(query => query.queryText).sort() }
}

describe('out-of-date setup draft CLI/REST/MCP parity', () => {
  it('refuses the publish with the same code and details on every surface, then publishes a draft restarted from the active plan', async () => {
    const stale = await draftLeftBehindByTracking()
    const refusal = {
      code: 'MEASUREMENT_PLAN_REVISION_CONFLICT',
      message: 'The published setup changed after this draft was started. Discard the draft, start a new one, and publish again.',
      details: { expectedActiveRevision: 2, actualActiveRevision: 2, check: 'draft-out-of-date', draftBase: 1, active: 2, httpStatus: 409 },
    }

    await expect(api.publishMeasurementDraft(PROJECT, stale.request, 'publish-api', stale.etag)).rejects.toMatchObject(refusal)
    const cliPublish = await invokeCli(['measurement-plan', 'advanced', PROJECT, 'draft-action',
      inputFile('publish', { action: 'publish', request: stale.request, etag: stale.etag, idempotencyKey: 'publish-cli' }), '--format', 'json'])
    expect(cliPublish.exitCode).toBe(1)
    expect(JSON.parse(cliPublish.stderr)).toMatchObject({ error: refusal })
    const mcp = await connect()
    const mcpPublish = await mcp.callTool({ name: 'canonry_measurement_draft_action', arguments: {
      project: PROJECT, operation: { action: 'publish', request: stale.request, etag: stale.etag, idempotencyKey: 'publish-mcp' },
    } })
    expect(mcpPublish.isError).toBe(true)
    expect(mcpPublish.structuredContent).toMatchObject({ error: refusal })
    // Three refusals later the tracking change is still what the project asks.
    expect(await activeQueries()).toEqual({ revision: 2, queries: ['best widget supplier', TRACKED_SINCE] })

    // The way out, on the same two surfaces: discard, start again from revision 2, publish.
    const discarded = await mcp.callTool({ name: 'canonry_measurement_draft_action', arguments: {
      project: PROJECT, operation: { action: 'discard', etag: stale.etag, idempotencyKey: 'discard-mcp' },
    } })
    expect(discarded.isError, JSON.stringify(discarded)).not.toBe(true)
    const created = await invokeCli(['measurement-plan', 'advanced', PROJECT, 'draft-action',
      inputFile('create', { action: 'create', request: { expectedActiveRevision: 2 }, idempotencyKey: 'create-cli' }), '--format', 'json'])
    expect(created.exitCode, created.stderr).toBeUndefined()
    const etag = (await api.applyMeasurementDraftAssignments(PROJECT, { targetKey: 'widgets', queryIds: ['q-delivery'] }, 'assign-3', JSON.parse(created.stdout).etag)).etag
    const compiled = await api.compileMeasurementDraftPreview(PROJECT)
    const published = await invokeCli(['measurement-plan', 'advanced', PROJECT, 'draft-action', inputFile('publish-fresh', {
      action: 'publish', request: { expectedActiveRevision: 2, expectedCompiledChecksum: compiled.compiledChecksum }, etag, idempotencyKey: 'publish-fresh',
    }), '--format', 'json'])
    expect(published.exitCode, published.stderr).toBeUndefined()
    expect(JSON.parse(published.stdout)).toMatchObject({ published: true, active: { revision: 3 } })
    expect(await activeQueries()).toEqual({ revision: 3, queries: ['best widget supplier', 'widget delivery times', TRACKED_SINCE] })
  })
})
