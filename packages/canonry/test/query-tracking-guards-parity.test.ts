import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { canonicalMeasurementPlanV2Json, measurementPlanV2ChecksumJson, measurementPlanV2Schema } from '@ainyc/canonry-contracts'
import { apiKeys, createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries, runs, type DatabaseClient } from '@ainyc/canonry-db'
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
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-query-tracking-guards-'))
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
    { id: 'q-reviews', projectId: 'prj_northwind', query: 'widget delivery times', createdAt: NOW },
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
  const client = new Client({ name: 'query-tracking-guards-test', version: '1' }, { capabilities: {} })
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

/** Publishes revision 1: one Property with one assigned query. */
async function advancedProject() {
  let etag = (await api.createMeasurementPlanDraft(PROJECT, { expectedActiveRevision: null }, 'create-1')).etag
  etag = (await api.upsertMeasurementDraftTarget(PROJECT, { target: TARGET }, 'target-1', etag)).etag
  etag = (await api.applyMeasurementDraftAssignments(PROJECT, { targetKey: 'widgets', queryIds: ['q-supplier'] }, 'assign-1', etag)).etag
  const first = await api.compileMeasurementDraftPreview(PROJECT)
  await api.publishMeasurementDraft(PROJECT, { expectedActiveRevision: null, expectedCompiledChecksum: first.compiledChecksum! }, 'publish-1', etag)
}

/** Publishes revision 1 and leaves a changed draft for revision 2, returning its publish envelope. */
async function advancedProjectWithPendingDraft() {
  await advancedProject()
  let etag = (await api.createMeasurementPlanDraft(PROJECT, { expectedActiveRevision: 1 }, 'create-2')).etag
  etag = (await api.applyMeasurementDraftAssignments(PROJECT, { targetKey: 'widgets', queryIds: ['q-reviews'] }, 'assign-2', etag)).etag
  const second = await api.compileMeasurementDraftPreview(PROJECT)
  return { request: { expectedActiveRevision: 1, expectedCompiledChecksum: second.compiledChecksum! }, etag }
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex')

/** Grows the stored active plan to `count` distinct assigned queries by copying its one query's rows. */
function growActivePlanTo(count: number) {
  const version = db.select().from(measurementPlanVersions).get()!
  const stored = JSON.parse(version.canonicalJson) as Record<'querySnapshots' | 'executionNodes' | 'assignments' | 'usageEdges', Array<Record<string, unknown>>>
  const [snapshot] = stored.querySnapshots
  const [node] = stored.executionNodes
  const [assignment] = stored.assignments
  const [edge] = stored.usageEdges
  const fillers = Array.from({ length: count - 1 }, (_, index) => ({ id: `q-fill-${index}`, text: `filler query ${index}` }))
  db.insert(queries).values(fillers.map(filler => ({ id: filler.id, projectId: 'prj_northwind', query: filler.text, createdAt: NOW }))).run()
  for (const filler of fillers) {
    const executionNodeKey = `exec-${filler.id}`
    stored.querySnapshots.push({ ...snapshot, queryId: filler.id, queryText: filler.text })
    stored.executionNodes.push({ ...node, stableKey: executionNodeKey, queryId: filler.id, queryText: filler.text })
    stored.assignments.push({ ...assignment, queryId: filler.id, executionNodeKey })
    stored.usageEdges.push({ ...edge, queryId: filler.id, executionNodeKey })
  }
  const provisional = measurementPlanV2Schema.parse({ ...stored, compiledChecksum: '0'.repeat(64) })
  const compiledChecksum = sha256(measurementPlanV2ChecksumJson(provisional))
  const canonicalJson = canonicalMeasurementPlanV2Json(measurementPlanV2Schema.parse({ ...provisional, compiledChecksum }))
  db.update(measurementPlanVersions).set({ canonicalJson, checksum: sha256(canonicalJson), compiledChecksum })
    .where(eq(measurementPlanVersions.id, version.id)).run()
}

describe('query tracking guard CLI/REST/MCP parity', () => {
  it('surfaces the query-limit refusal unchanged for a tracking commit', async () => {
    await advancedProject()
    growActivePlanTo(1_000)
    const workspace = await api.getQueryTrackingWorkspace(PROJECT)
    const mutation = {
      expectedWorkspaceVersion: workspace.workspaceVersion, removals: [],
      additions: [{
        input: { source: 'manual' as const, text: 'widget warranty terms' }, audience: { targetKeys: ['widgets'] },
        contexts: workspace.defaultContexts.map(context => ({ ...context, location: context.location?.label ?? null })),
      }],
    }
    const review = await api.previewQueryTracking(PROJECT, mutation)
    expect(review.limits).toEqual({ queries: { current: 1_000, next: 1_001, max: 1_000 } })
    const commit = { ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt }
    const refusal = {
      code: 'VALIDATION_ERROR',
      message: 'This change would track 1,001 queries, over the 1,000-query limit. Remove queries or add fewer, then preview the change again.',
      details: { check: 'query-limit-exceeded', current: 1_000, next: 1_001, max: 1_000, displayToOperator: true, httpStatus: 400 },
    }

    await expect(api.commitQueryTracking(PROJECT, commit)).rejects.toMatchObject(refusal)
    const cliCommit = await invokeCli(['query', 'commit', PROJECT, inputFile('commit', commit), '--format', 'json'])
    expect(cliCommit.exitCode).toBe(1)
    expect(JSON.parse(cliCommit.stderr)).toMatchObject({ error: refusal })
    const mcp = await connect()
    const mcpCommit = await mcp.callTool({ name: 'canonry_query_tracking_commit', arguments: { project: PROJECT, request: commit } })
    expect(mcpCommit.isError).toBe(true)
    expect(mcpCommit.structuredContent).toMatchObject({ error: refusal })
    expect((await api.getMeasurementPlan(PROJECT)).active?.revision).toBe(1)
  })


  it('surfaces the sweep refusal unchanged for a tracking commit and a setup publish, and allows both once idle', async () => {
    const publish = await advancedProjectWithPendingDraft()
    const workspace = await api.getQueryTrackingWorkspace(PROJECT)
    const mutation = {
      expectedWorkspaceVersion: workspace.workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'q-supplier', audience: { targetKeys: ['widgets'] }, queryClass: 'branded' as const }],
    }
    const review = await api.previewQueryTracking(PROJECT, mutation)
    const commit = { ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt }
    const activeVersionId = db.select().from(measurementPlans).get()!.activeVersionId
    db.insert(runs).values({
      id: 'sweep-1', projectId: 'prj_northwind', kind: 'answer-visibility', status: 'running', trigger: 'scheduled',
      measurementPlanVersionId: activeVersionId, createdAt: NOW,
    }).run()
    const refusal = {
      code: 'RUN_IN_PROGRESS',
      message: "Sweep run sweep-1 is running for 'northwind'. Publish tracked query and setup changes after it finishes, or cancel it first: canonry run cancel northwind sweep-1",
      details: { projectName: PROJECT, kind: 'answer-visibility', activeRunId: 'sweep-1', reason: 'sweep-in-progress', httpStatus: 409 },
    }
    const mcp = await connect()

    // Previews stay available during the sweep, with the same limit on every surface.
    const limits = { queries: { current: 1, next: 1, max: 1_000 } }
    expect((await api.previewQueryTracking(PROJECT, mutation)).limits).toEqual(limits)
    const cliPreview = await invokeCli(['query', 'preview', PROJECT, inputFile('preview', mutation), '--format', 'json'])
    expect(cliPreview.exitCode, cliPreview.stderr).toBeUndefined()
    expect(JSON.parse(cliPreview.stdout).limits).toEqual(limits)
    const mcpPreview = await mcp.callTool({ name: 'canonry_query_tracking_preview', arguments: { project: PROJECT, request: mutation } })
    expect(mcpPreview.isError, JSON.stringify(mcpPreview)).not.toBe(true)
    expect((mcpPreview.structuredContent as { limits?: unknown }).limits).toEqual(limits)

    await expect(api.commitQueryTracking(PROJECT, commit)).rejects.toMatchObject(refusal)
    const cliCommit = await invokeCli(['query', 'commit', PROJECT, inputFile('commit', commit), '--format', 'json'])
    expect(cliCommit.exitCode).toBe(1)
    expect(JSON.parse(cliCommit.stderr)).toMatchObject({ error: refusal })
    const mcpCommit = await mcp.callTool({ name: 'canonry_query_tracking_commit', arguments: { project: PROJECT, request: commit } })
    expect(mcpCommit.isError).toBe(true)
    expect(mcpCommit.structuredContent).toMatchObject({ error: refusal })

    await expect(api.publishMeasurementDraft(PROJECT, publish.request, 'publish-api', publish.etag)).rejects.toMatchObject(refusal)
    const cliPublish = await invokeCli(['measurement-plan', 'advanced', PROJECT, 'draft-action',
      inputFile('publish', { action: 'publish', request: publish.request, etag: publish.etag, idempotencyKey: 'publish-cli' }), '--format', 'json'])
    expect(cliPublish.exitCode).toBe(1)
    expect(JSON.parse(cliPublish.stderr)).toMatchObject({ error: refusal })
    const mcpPublish = await mcp.callTool({ name: 'canonry_measurement_draft_action', arguments: {
      project: PROJECT, operation: { action: 'publish', request: publish.request, etag: publish.etag, idempotencyKey: 'publish-mcp' },
    } })
    expect(mcpPublish.isError).toBe(true)
    expect(mcpPublish.structuredContent).toMatchObject({ error: refusal })
    expect((await api.getMeasurementPlan(PROJECT)).active?.revision).toBe(1)

    db.update(runs).set({ status: 'completed', finishedAt: NOW }).where(eq(runs.id, 'sweep-1')).run()
    const published = await invokeCli(['measurement-plan', 'advanced', PROJECT, 'draft-action',
      inputFile('publish-idle', { action: 'publish', request: publish.request, etag: publish.etag, idempotencyKey: 'publish-idle' }), '--format', 'json'])
    expect(published.exitCode, published.stderr).toBeUndefined()
    expect(JSON.parse(published.stdout)).toMatchObject({ published: true, active: { revision: 2 } })
    // The publish moved the workspace, so the same edit is reviewed again before it commits.
    const fresh = { ...mutation, expectedWorkspaceVersion: (await api.getQueryTrackingWorkspace(PROJECT)).workspaceVersion }
    const freshReview = await api.previewQueryTracking(PROJECT, fresh)
    const committed = await mcp.callTool({ name: 'canonry_query_tracking_commit', arguments: {
      project: PROJECT, request: { ...fresh, previewToken: freshReview.previewToken, reviewedAt: freshReview.reviewedAt },
    } })
    expect(committed.isError, JSON.stringify(committed)).not.toBe(true)
    expect(committed.structuredContent).toMatchObject({ committed: true, active: { revision: 3 } })
  })
})
