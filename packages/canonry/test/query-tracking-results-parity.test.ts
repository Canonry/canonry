import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import {
  buildMeasurementRunManifestV1,
  buildSimpleMeasurementDefinition,
  canonicalSimpleMeasurementDefinitionJson,
  measurementPlanV2Schema,
  type QueryTrackingResultsRequest,
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
  simpleMeasurementDefinitions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'
import { invokeCli } from './cli-test-utils.js'

const NOW = '2026-10-09T12:00:00.000Z'
const SWEEP_AT = '2026-10-07T12:00:00.000Z'
const PROJECT = 'northwind'
const PROJECT_ID = 'prj_northwind'
const NYC = { label: 'nyc', city: 'New York', region: 'NY', country: 'US' }
const MODELS = { openai: 'gpt-test', gemini: 'gemini-test' }
const TARGET = {
  stableKey: 'widgets', label: 'Widgets', status: 'included' as const, aliases: ['Northwind Widgets'],
  urlMatchers: ['https://northwind.example/widgets/*'], source: 'manual' as const,
}
const LEGEND = 'M mentioned · m not mentioned · C cited · c not cited · - not checked'
const cleanups: Array<() => Promise<void>> = []
let directory: string
let db: DatabaseClient
let api: ApiClient
let origin: string
let key: string

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-query-tracking-results-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', directory)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  const database = path.join(directory, 'test.db')
  db = createClient(database)
  migrate(db)
  db.insert(projects).values({
    id: PROJECT_ID, name: PROJECT, displayName: 'Northwind', canonicalDomain: 'northwind.example',
    country: 'US', language: 'en', providers: ['openai', 'gemini'], providerModels: MODELS,
    locations: [NYC], defaultLocation: 'nyc', createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(queries).values([
    { id: 'q-supplier', projectId: PROJECT_ID, query: 'best widget supplier', createdAt: NOW },
    { id: 'q-brand', projectId: PROJECT_ID, query: 'northwind delivery times', createdAt: NOW },
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
  const server = createCanonryMcpServer({ scope: 'all', tiers: ['monitoring'],
    clientFactory: () => new ApiClient(origin, key, { skipProbe: true }) })
  const client = new Client({ name: 'query-tracking-results-test', version: '1' }, { capabilities: {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanups.push(async () => { await client.close(); await server.close() })
  return client
}

/** Publishes revision 1 through the API (one location asked one query), then stores one sweep of it. */
async function advancedProjectWithSweep(): Promise<string> {
  let etag = (await api.createMeasurementPlanDraft(PROJECT, { expectedActiveRevision: null }, 'create-1')).etag
  etag = (await api.upsertMeasurementDraftTarget(PROJECT, { target: TARGET }, 'target-1', etag)).etag
  etag = (await api.applyMeasurementDraftAssignments(PROJECT, { targetKey: 'widgets', queryIds: ['q-supplier'] }, 'assign-1', etag)).etag
  const first = await api.compileMeasurementDraftPreview(PROJECT)
  await api.publishMeasurementDraft(PROJECT, { expectedActiveRevision: null, expectedCompiledChecksum: first.compiledChecksum! }, 'publish-1', etag)

  const pointer = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, PROJECT_ID)).get()!
  const version = db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, pointer.activeVersionId)).get()!
  const plan = measurementPlanV2Schema.parse(JSON.parse(version.canonicalJson))
  const slots = plan.executionNodes.flatMap(node => [...node.context.providers].sort().map(provider => ({
    executionId: node.stableKey, queryText: node.queryText, provider, context: node.context.location,
  })))
  const runId = 'run-sweep'
  db.insert(runs).values({
    id: runId, projectId: PROJECT_ID, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
    measurementPlanVersionId: version.id, measurementManifest: buildMeasurementRunManifestV1({ expectedSlots: slots }),
    finishedAt: SWEEP_AT, createdAt: SWEEP_AT,
  }).run()
  // Gemini names the location and cites another site. OpenAI never answered.
  const gemini = slots.find(slot => slot.provider === 'gemini')!
  db.insert(querySnapshots).values({
    id: 'snapshot-gemini', runId, queryId: null, queryText: gemini.queryText, provider: 'gemini',
    citationState: 'not-cited', answerMentioned: null, answerText: 'Northwind Widgets is a reliable supplier.',
    citedDomains: [], citedUrls: ['https://directory.example/suppliers'], captureStatus: 'complete',
    competitorOverlap: [], recommendedCompetitors: [],
    location: gemini.context?.label ?? null, measurementExecutionId: gemini.executionId,
    requestedContext: gemini.context, supportedContext: { status: 'applied', resolved: gemini.context },
    createdAt: SWEEP_AT,
  }).run()
  return runId
}

/** One planless sweep with the definition a sweep freezes today. OpenAI cites and does not name; Gemini answered one query. */
function simpleSweep(): string {
  const runId = 'run-simple'
  db.insert(runs).values({
    id: runId, projectId: PROJECT_ID, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
    finishedAt: SWEEP_AT, createdAt: SWEEP_AT,
  }).run()
  const definition = buildSimpleMeasurementDefinition({
    capturedAt: SWEEP_AT,
    identity: { displayName: 'Northwind', aliases: [], canonicalDomain: 'northwind.example', ownedDomains: [] },
    country: 'US', language: 'en', location: null,
    engines: [{ provider: 'gemini', requestedModel: MODELS.gemini }, { provider: 'openai', requestedModel: MODELS.openai }],
    queries: [
      { queryId: 'q-supplier', queryText: 'best widget supplier', provenance: 'manual' },
      { queryId: 'q-brand', queryText: 'northwind delivery times', provenance: 'manual' },
    ],
  })
  db.insert(simpleMeasurementDefinitions).values({
    runId, projectId: PROJECT_ID, definition,
    checksum: crypto.createHash('sha256').update(canonicalSimpleMeasurementDefinitionJson(definition)).digest('hex'),
    capturedAt: SWEEP_AT,
  }).run()
  const answer = (queryId: string, queryText: string, provider: 'gemini' | 'openai', answerText: string, cited: boolean) => ({
    id: `${queryId}-${provider}`, runId, queryId, queryText, provider, model: MODELS[provider],
    citationState: cited ? 'cited' : 'not-cited', answerMentioned: null, answerText,
    citedDomains: cited ? ['northwind.example'] : [], citedUrls: [], captureStatus: 'complete',
    competitorOverlap: [], recommendedCompetitors: [], location: null, createdAt: SWEEP_AT,
  })
  db.insert(querySnapshots).values([
    answer('q-supplier', 'best widget supplier', 'openai', 'Several suppliers stand out.', true),
    answer('q-supplier', 'best widget supplier', 'gemini', 'Northwind is a common pick.', false),
    answer('q-brand', 'northwind delivery times', 'openai', 'Northwind ships in two days.', false),
  ]).run()
  return runId
}

/** The same read through the REST client, the CLI and the MCP tool, each over its real transport. */
async function readEverywhere(selection: QueryTrackingResultsRequest = {}) {
  const rest = await api.getQueryTrackingResults(PROJECT, selection)
  const flags = [
    ...(selection.scope ? ['--scope', selection.scope] : []),
    ...(selection.scopeKey ? ['--scope-key', selection.scopeKey] : []),
    ...(selection.runId ? ['--run', selection.runId] : []),
  ]
  const cli = await invokeCli(['query', 'results', PROJECT, ...flags, '--format', 'json'])
  expect(cli.exitCode, cli.stderr).toBeUndefined()
  const mcp = await connect()
  const tool = await mcp.callTool({ name: 'canonry_query_tracking_results', arguments: { project: PROJECT, ...selection } })
  expect(tool.isError, JSON.stringify(tool)).not.toBe(true)
  return { rest, viaCli: JSON.parse(cli.stdout) as unknown, viaMcp: tool.structuredContent }
}

describe('query tracking results CLI/REST/MCP parity', () => {
  it('returns one advanced body on every surface, for the project and for one location', async () => {
    const runId = await advancedProjectWithSweep()

    const { rest, viaCli, viaMcp } = await readEverywhere()
    expect(rest).toStrictEqual({
      mode: 'advanced',
      scope: { kind: 'project', key: null },
      run: { id: runId, createdAt: SWEEP_AT, completedAt: SWEEP_AT, status: 'completed', revision: 1, matchesCurrentTracking: true },
      engines: ['gemini', 'openai'],
      rows: [{
        queryId: 'q-supplier', queryText: 'best widget supplier', queryClass: 'non-brand',
        engines: [
          { provider: 'gemini', expectedAnswers: 1, answers: 1, mentionedAnswers: 1, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: true, cited: false },
          { provider: 'openai', expectedAnswers: 1, answers: 0, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: null, cited: null },
        ],
      }],
      pendingRows: 0,
    })
    expect(viaCli).toStrictEqual(rest)
    expect(viaMcp).toStrictEqual(rest)

    const location = await readEverywhere({ scope: 'property', scopeKey: 'widgets', runId })
    expect(location.rest).toStrictEqual({ ...rest, scope: { kind: 'property', key: 'widgets' } })
    expect(location.viaCli).toStrictEqual(location.rest)
    expect(location.viaMcp).toStrictEqual(location.rest)
  })

  it('returns one simple body on every surface', async () => {
    const runId = simpleSweep()

    const { rest, viaCli, viaMcp } = await readEverywhere()
    expect(rest).toMatchObject({
      mode: 'simple', scope: { kind: 'project', key: null }, engines: ['gemini', 'openai'], pendingRows: 0,
      run: { id: runId, status: 'completed', revision: null, matchesCurrentTracking: true },
    })
    expect(rest.rows.map(row => [row.queryId, row.queryClass, row.engines.map(entry => [entry.provider, entry.mentioned, entry.cited])])).toStrictEqual([
      ['q-brand', 'branded', [['gemini', null, null], ['openai', true, false]]],
      ['q-supplier', 'non-brand', [['gemini', true, false], ['openai', false, true]]],
    ])
    expect(viaCli).toStrictEqual(rest)
    expect(viaMcp).toStrictEqual(rest)
  })

  it('prints the legend above a two-glyph table, mention first', async () => {
    simpleSweep()
    const result = await invokeCli(['query', 'results', PROJECT])
    expect(result.exitCode, result.stderr).toBeUndefined()
    expect(result.stdout.split('\n')).toStrictEqual([
      'Sweep 2026-10-07 · run run-simple',
      LEGEND,
      'Query                     Type       gemini  openai',
      'northwind delivery times  Branded    --      Mc',
      'best widget supplier      Non-brand  Mc      mC',
    ])
  })

  it('says what the sweep did not measure, and that there is no sweep', async () => {
    expect((await invokeCli(['query', 'results', PROJECT])).stdout).toBe('No sweep yet')

    simpleSweep()
    db.insert(queries).values({ id: 'q-new', projectId: PROJECT_ID, query: 'widget supplier with warranty', createdAt: NOW }).run()
    const lines = (await invokeCli(['query', 'results', PROJECT])).stdout.split('\n')
    expect(lines.slice(0, 3)).toStrictEqual(['Sweep 2026-10-07 · run run-simple', 'Not in this sweep: 1', LEGEND])
    expect(lines).toHaveLength(6)
  })

  it('refuses a bad selection before a request is sent, and reports the server\'s refusal', async () => {
    const badScope = await invokeCli(['query', 'results', PROJECT, '--scope', 'region', '--format', 'json'])
    expect(badScope.exitCode).toBe(1)
    expect(JSON.parse(badScope.stderr)).toMatchObject({ error: { code: 'CLI_USAGE_ERROR', message: '--scope must be one of project, group, market, property' } })

    const noKey = await invokeCli(['query', 'results', PROJECT, '--scope', 'market', '--format', 'json'])
    expect(noKey.exitCode).toBe(1)
    expect(JSON.parse(noKey.stderr)).toMatchObject({ error: { code: 'CLI_USAGE_ERROR', message: '--scope-key is required for market scope' } })

    const strayKey = await invokeCli(['query', 'results', PROJECT, '--scope-key', 'widgets', '--format', 'json'])
    expect(strayKey.exitCode).toBe(1)
    expect(JSON.parse(strayKey.stderr)).toMatchObject({ error: { code: 'CLI_USAGE_ERROR', message: '--scope-key is not valid for project scope' } })

    const noRun = await invokeCli(['query', 'results', PROJECT, '--run', 'missing', '--format', 'json'])
    expect(noRun.exitCode).toBe(1)
    expect(JSON.parse(noRun.stderr)).toMatchObject({ error: { code: 'VALIDATION_ERROR', message: 'Run "missing" is not a completed whole-project sweep of this project.' } })

    const mcp = await connect()
    const tool = await mcp.callTool({ name: 'canonry_query_tracking_results', arguments: { project: PROJECT, scope: 'property', scopeKey: 'widgets' } })
    expect(tool.isError).toBe(true)
    expect(JSON.stringify(tool.content)).toContain('a simple project is read as a whole')
  })
})
