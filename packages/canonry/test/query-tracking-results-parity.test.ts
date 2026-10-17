import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRoutes } from '@canonry/canonry-api-routes'
import {
  buildMeasurementRunManifestV1,
  buildSimpleMeasurementDefinition,
  canonicalMeasurementPlanV2Json,
  canonicalSimpleMeasurementDefinitionJson,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  type QueryTrackingResultsRequest,
} from '@canonry/canonry-contracts'
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
} from '@canonry/canonry-db'
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

/**
 * A portfolio of three locations, stored as a published plan with one sweep:
 * - `q-east` is the East market's own query, asked once for Widgets and Gadgets.
 * - `q-tools` is Tools' own Branded query. Tools is outside the East market.
 * Gemini answers the market query by naming Tools. OpenAI names nobody and cites Gadgets' page.
 */
function marketPortfolioWithSweep(): string {
  const locations = [['widgets', 'Northwind Widgets'], ['gadgets', 'Northwind Gadgets'], ['tools', 'Northwind Tools']] as const
  const texts = MARKET_PORTFOLIO_QUERIES
  const edges = [
    { executionNodeKey: 'n-east', targetKey: 'widgets', queryId: 'q-east' },
    { executionNodeKey: 'n-east', targetKey: 'gadgets', queryId: 'q-east' },
    { executionNodeKey: 'n-tools', targetKey: 'tools', queryId: 'q-tools' },
  ]
  const provisional = measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'northwind.example', ownedHosts: ['northwind.example'], names: ['Northwind'] } },
    targets: locations.map(([stableKey, label]) => ({
      stableKey, label, aliases: [label],
      urlMatchers: [{ kind: 'prefix', host: 'northwind.example', pathPrefix: `/${stableKey}`, pathCase: 'insensitive' }],
      mentionNotApplicable: false, discoveryIdentity: null,
    })),
    groups: [],
    querySnapshots: Object.entries(texts).map(([queryId, queryText]) => ({
      queryId, queryText, provenance: { source: 'manual', sourceId: null, capturedAt: NOW },
    })),
    assignments: edges.map(edge => ({ ...edge, queryClass: edge.queryId === 'q-east' ? 'non-brand' : 'branded', classificationSource: 'server' })),
    executionNodes: Object.entries(texts).map(([queryId, queryText]) => ({
      stableKey: queryId.replace('q-', 'n-'), queryId, queryText,
      context: { providers: ['gemini', 'openai'], models: MODELS, location: NYC }, expectedSnapshots: 2,
    })),
    usageEdges: edges,
    reportingScopes: [{ stableKey: 'east', label: 'East', kind: 'market', usageEdges: edges.slice(0, 2) }],
    compiledChecksum: '0'.repeat(64),
  })
  const plan = measurementPlanV2Schema.parse({
    ...provisional,
    compiledChecksum: crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(provisional)).digest('hex'),
  })
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.insert(measurementPlanVersions).values({
    id: 'plan-v1', projectId: PROJECT_ID, revision: 1, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, comparableToVersionId: null, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId: PROJECT_ID, activeVersionId: 'plan-v1', createdAt: NOW, updatedAt: NOW }).run()
  db.insert(queries).values(Object.entries(texts).map(([id, query]) => ({ id, projectId: PROJECT_ID, query, createdAt: NOW }))).run()

  const other = ['https://directory.example/suppliers']
  return marketPortfolioSweep('run-market', SWEEP_AT, {
    'n-east-gemini': { text: 'Northwind Tools is the usual pick.', cites: other, names: ['Northwind Tools', 'Acme Supply'] },
    'n-east-openai': { text: 'Several suppliers stand out.', cites: ['https://northwind.example/gadgets/catalog'] },
    'n-tools-gemini': { text: 'Northwind Tools lists its prices online.', cites: other },
    'n-tools-openai': { text: 'Northwind Tools publishes a price list.', cites: other },
  })
}

const MARKET_PORTFOLIO_QUERIES = { 'q-east': 'best supplier in the east', 'q-tools': 'northwind tools pricing' }

/** One whole-project sweep of that plan. An answer is stored under `<execution>-<engine>`; a slot left out saved none. */
function marketPortfolioSweep(runId: string, createdAt: string, answers: Record<string, { text: string; cites: string[]; names?: string[] }>): string {
  const slots = Object.entries(MARKET_PORTFOLIO_QUERIES).flatMap(([queryId, queryText]) => ['gemini', 'openai'].map(provider => ({
    executionId: queryId.replace('q-', 'n-'), queryText, provider, context: NYC,
  })))
  db.insert(runs).values({
    id: runId, projectId: PROJECT_ID, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
    measurementPlanVersionId: 'plan-v1', measurementManifest: buildMeasurementRunManifestV1({ expectedSlots: slots }),
    finishedAt: createdAt, createdAt,
  }).run()
  db.insert(querySnapshots).values(slots.flatMap(slot => {
    const id = `${slot.executionId}-${slot.provider}`
    const answer = answers[id]
    return answer === undefined ? [] : [{
      id: runId === 'run-market' ? id : `${runId}-${id}`, runId, queryId: null, queryText: slot.queryText, provider: slot.provider,
      citationState: 'not-cited', answerMentioned: null, answerText: answer.text,
      citedDomains: [], citedUrls: answer.cites, captureStatus: 'complete',
      competitorOverlap: [], recommendedCompetitors: answer.names ?? [],
      location: NYC.label, measurementExecutionId: slot.executionId,
      requestedContext: NYC, supportedContext: { status: 'applied' as const, resolved: NYC },
      createdAt,
    }]
  })).run()
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
    // What the project dispatches now: its engines, their models and its search location.
    country: 'US', language: 'en', location: NYC,
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

/** Each field of the read by its CLI flag. */
const FLAGS: Record<keyof QueryTrackingResultsRequest, string> = {
  scope: '--scope', scopeKey: '--scope-key', runId: '--run', queryId: '--query', signal: '--signal', sort: '--sort',
  group: '--group', compare: '--compare', engine: '--engine', result: '--result', change: '--change',
}

/** The same read through the REST client, the CLI and the MCP tool, each over its real transport. */
async function readEverywhere(selection: QueryTrackingResultsRequest = {}) {
  const rest = await api.getQueryTrackingResults(PROJECT, selection)
  const flags = (Object.entries(selection) as Array<[keyof QueryTrackingResultsRequest, string | undefined]>)
    .flatMap(([field, value]) => value === undefined ? [] : [FLAGS[field], value])
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
      // One answer of the two expected was saved, so neither rate is a number.
      totals: [{
        queryClass: 'non-brand', queries: 1, answers: 1,
        mentionCoverage: { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' },
        citationCoverage: { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' },
      }],
      // The plan has no market, so none is weak.
      weakMarkets: { rule: 'no-mention-latest-sweep', queryClass: 'non-brand', count: 0, marketKeys: [], markets: [] },
    })
    expect(viaCli).toStrictEqual(rest)
    expect(viaMcp).toStrictEqual(rest)

    // Only the project read ranks markets.
    const { weakMarkets: _weakMarkets, ...rows } = rest
    const location = await readEverywhere({ scope: 'property', scopeKey: 'widgets', runId })
    expect(location.rest).toStrictEqual({ ...rows, scope: { kind: 'property', key: 'widgets' } })
    expect(location.viaCli).toStrictEqual(location.rest)
    expect(location.viaMcp).toStrictEqual(location.rest)
  })

  it('returns the totals, the other-location fields and the ranked weak markets on every surface', async () => {
    const runId = marketPortfolioWithSweep()

    const { rest, viaCli, viaMcp } = await readEverywhere()
    expect(rest).toStrictEqual({
      mode: 'advanced',
      scope: { kind: 'project', key: null },
      run: { id: runId, createdAt: SWEEP_AT, completedAt: SWEEP_AT, status: 'completed', revision: 1, matchesCurrentTracking: true },
      engines: ['gemini', 'openai'],
      rows: [
        {
          queryId: 'q-east', queryText: 'best supplier in the east', queryClass: 'non-brand',
          engines: [
            // Names Tools, which the East market does not hold: still not mentioned.
            {
              provider: 'gemini', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: false, cited: false,
              otherLocationMentionedAnswers: 1, otherLocationMentionedTargetKeys: ['tools'],
            },
            // The row covers two locations, so the entry says which one the answer cites.
            {
              provider: 'openai', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 1, uncheckedSourceAnswers: 0, mentioned: false, cited: true,
              citedTargetKeys: ['gadgets'],
            },
          ],
        },
        {
          queryId: 'q-tools', queryText: 'northwind tools pricing', queryClass: 'branded',
          engines: ['gemini', 'openai'].map(provider => (
            { provider, expectedAnswers: 1, answers: 1, mentionedAnswers: 1, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: true, cited: false }
          )),
        },
      ],
      pendingRows: 0,
      // One entry per Type. Pooled, mentioned would read 2 of 4.
      totals: [
        { queryClass: 'branded', queries: 1, answers: 2, mentionCoverage: { numerator: 2, denominator: 2, rate: 1 }, citationCoverage: { numerator: 0, denominator: 2, rate: 0 } },
        { queryClass: 'non-brand', queries: 1, answers: 2, mentionCoverage: { numerator: 0, denominator: 2, rate: 0 }, citationCoverage: { numerator: 1, denominator: 2, rate: 0.5 } },
      ],
      weakMarkets: {
        rule: 'no-mention-latest-sweep', queryClass: 'non-brand', count: 1, marketKeys: ['east'],
        markets: [{ marketKey: 'east', queries: 1, mentionCheckedAnswers: 2, mentionedAnswers: 0, otherLocationMentionedAnswers: 1, citationCheckedAnswers: 2, citedAnswers: 1 }],
      },
    })
    expect(viaCli).toStrictEqual(rest)
    expect(viaMcp).toStrictEqual(rest)

    // The table: one line per Type under the sweep, and the engines whose answers name another location.
    const table = await invokeCli(['query', 'results', PROJECT])
    expect(table.exitCode, table.stderr).toBeUndefined()
    expect(table.stdout.split('\n')).toStrictEqual([
      'Sweep 2026-10-07 · run run-market',
      'Non-brand: mentioned 0 of 2 · cited 1 of 2',
      'Branded: mentioned 2 of 2 · cited 0 of 2',
      LEGEND,
      'Query                      Type       gemini  openai  Another location',
      'best supplier in the east  Non-brand  mc      mC      gemini',
      'northwind tools pricing    Branded    Mc      Mc',
    ])
  })

  it('returns one query and its answers on every surface, and prints them', async () => {
    const runId = marketPortfolioWithSweep()

    const { rest, viaCli, viaMcp } = await readEverywhere({ queryId: 'q-east' })
    const answerRow = (resultId: string, extra: Record<string, unknown>) => ({
      resultId, searchLocation: 'nyc', targetKeys: ['gadgets', 'widgets'], mentioned: false, cited: false,
      mentionedTargetKeys: [], citedTargetKeys: [], namedInstead: [], alsoNamed: [], ...extra,
    })
    expect(rest).toStrictEqual({
      mode: 'advanced',
      scope: { kind: 'project', key: null },
      run: { id: runId, createdAt: SWEEP_AT, completedAt: SWEEP_AT, status: 'completed', revision: 1, matchesCurrentTracking: true },
      engines: ['gemini', 'openai'],
      // Only that query, with no totals and no weak markets.
      rows: [{
        queryId: 'q-east', queryText: 'best supplier in the east', queryClass: 'non-brand',
        engines: [
          {
            provider: 'gemini', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentioned: false, cited: false,
            otherLocationMentionedAnswers: 1, otherLocationMentionedTargetKeys: ['tools'],
            // Tools is one of the project's own locations, so it is not named instead.
            answerRows: [answerRow('n-east-gemini', {
              namedInstead: ['Acme Supply'],
              citedSources: [{ url: 'https://directory.example/suppliers', host: 'directory.example', ours: false, competitor: null }],
            })],
          },
          {
            provider: 'openai', expectedAnswers: 1, answers: 1, mentionedAnswers: 0, citedAnswers: 1, uncheckedSourceAnswers: 0, mentioned: false, cited: true,
            citedTargetKeys: ['gadgets'],
            answerRows: [answerRow('n-east-openai', {
              cited: true, citedTargetKeys: ['gadgets'],
              citedSources: [{ url: 'https://northwind.example/gadgets/catalog', host: 'northwind.example', ours: true, competitor: null }],
            })],
          },
        ],
      }],
      pendingRows: 0,
    })
    expect(viaCli).toStrictEqual(rest)
    expect(viaMcp).toStrictEqual(rest)

    const table = await invokeCli(['query', 'results', PROJECT, '--query', 'q-east'])
    expect(table.exitCode, table.stderr).toBeUndefined()
    expect(table.stdout.split('\n')).toStrictEqual([
      'Sweep 2026-10-07 · run run-market',
      LEGEND,
      'Query                      Type       gemini  openai  Another location',
      'best supplier in the east  Non-brand  mc      mC      gemini',
      '',
      'Answers',
      'Type       Engine  Result  Search location  Location mentioned  Named instead  Cited sources             Answer',
      'Non-brand  gemini  mc      nyc              None                Acme Supply    directory.example         n-east-gemini',
      'Non-brand  openai  mC      nyc              None                None           northwind.example (ours)  n-east-openai',
    ])

    // A later sweep in which only Gemini answered the Branded query. A row of one location has no column
    // for which location, and an answer that was never saved has nothing to open.
    marketPortfolioSweep('run-later', NOW, { 'n-tools-gemini': { text: 'Northwind Tools lists its prices online.', cites: [] } })
    const single = await invokeCli(['query', 'results', PROJECT, '--query', 'q-tools', '--run', 'run-later'])
    expect(single.exitCode, single.stderr).toBeUndefined()
    expect(single.stdout.split('\n').slice(-4)).toStrictEqual([
      'Answers',
      'Type     Engine  Result  Search location  Named instead  Answer',
      'Branded  gemini  Mc      nyc              None           run-later-n-tools-gemini',
      'Branded  openai  --      nyc              None           No answer saved',
    ])
  })

  it('returns the markets, the comparison and each engine\'s change on every surface, and prints them', async () => {
    marketPortfolioWithSweep()
    // A later sweep: Gemini now names Widgets, and OpenAI no longer cites Gadgets' page.
    marketPortfolioSweep('run-later', NOW, {
      'n-east-gemini': { text: 'Northwind Widgets is the usual pick.', cites: [] },
      'n-east-openai': { text: 'Several suppliers stand out.', cites: ['https://directory.example/suppliers'] },
      'n-tools-gemini': { text: 'Northwind Tools lists its prices online.', cites: [] },
      'n-tools-openai': { text: 'Northwind Tools publishes a price list.', cites: [] },
    })

    const grouped = await readEverywhere({ group: 'market', compare: 'previous', sort: 'losing' })
    // The list of markets carries no rows; East holds its own query only, as Tools is outside it.
    expect(grouped.rest.rows).toStrictEqual([])
    expect(grouped.rest.compareRun?.id).toBe('run-market')
    expect(grouped.rest.groups).toStrictEqual([{
      kind: 'market', key: 'east', label: 'East', parentKey: null, locations: 2,
      types: [{
        queryClass: 'non-brand', queries: 1, answers: 2,
        mentionCoverage: { numerator: 1, denominator: 2, rate: 0.5 },
        citationCoverage: { numerator: 0, denominator: 2, rate: 0 },
        otherLocationMentionedAnswers: 0,
        engines: [
          { provider: 'gemini', answers: 1, mentionedAnswers: 1, citedAnswers: 0 },
          { provider: 'openai', answers: 1, mentionedAnswers: 0, citedAnswers: 0 },
        ],
        change: { mentionsWon: 1, mentionsLost: 0, citationsWon: 0, citationsLost: 1 },
      }],
      namedInstead: [],
      citedInstead: [{ host: 'directory.example', answers: 1 }],
      competitors: [],
    }])
    // Both sweeps over the same queries, and the server's own change.
    expect(grouped.rest.totals?.map(total => [total.queryClass, total.comparison])).toStrictEqual([
      ['branded', {
        queries: 1,
        mentionCoverage: { numerator: 2, denominator: 2, rate: 1 }, citationCoverage: { numerator: 0, denominator: 2, rate: 0 },
        previousMentionCoverage: { numerator: 2, denominator: 2, rate: 1 }, previousCitationCoverage: { numerator: 0, denominator: 2, rate: 0 },
        mentionDelta: 0, citationDelta: 0,
      }],
      ['non-brand', {
        queries: 1,
        mentionCoverage: { numerator: 1, denominator: 2, rate: 0.5 }, citationCoverage: { numerator: 0, denominator: 2, rate: 0 },
        previousMentionCoverage: { numerator: 0, denominator: 2, rate: 0 }, previousCitationCoverage: { numerator: 1, denominator: 2, rate: 0.5 },
        mentionDelta: 0.5, citationDelta: -0.5,
      }],
    ])
    expect(grouped.viaCli).toStrictEqual(grouped.rest)
    expect(grouped.viaMcp).toStrictEqual(grouped.rest)

    const sweepLines = [
      'Sweep 2026-10-09 · run run-later',
      'Compared with the previous sweep · run run-market',
      'Non-brand: mentioned 1 of 2 · cited 0 of 2',
      '  Same 1 query vs previous sweep: mentioned 0 of 2 → 1 of 2 (+50.0 pts) · cited 1 of 2 → 0 of 2 (-50.0 pts)',
      'Branded: mentioned 2 of 2 · cited 0 of 2',
      '  Same 1 query vs previous sweep: mentioned 2 of 2 → 2 of 2 (0 pts) · cited 0 of 2 → 0 of 2 (0 pts)',
    ]
    const markets = await invokeCli(['query', 'results', PROJECT, '--group', 'market', '--compare', 'previous'])
    expect(markets.exitCode, markets.stderr).toBeUndefined()
    expect(markets.stdout.split('\n')).toStrictEqual([
      ...sweepLines,
      'Market  Locations  Type       Mentioned  gemini  openai  Another location  Change',
      'East    2          Non-brand  1 of 2     1 of 1  0 of 1  0                 won 1 · lost 0',
    ])
    // The cited view counts citations per engine and lists the sites cited instead.
    const cited = await invokeCli(['query', 'results', PROJECT, '--group', 'market', '--compare', 'previous', '--signal', 'cited'])
    expect(cited.stdout.split('\n').slice(-2)).toStrictEqual([
      'Market  Locations  Type       Cited   gemini  openai  Change          Cited instead',
      'East    2          Non-brand  0 of 2  0 of 1  0 of 1  won 0 · lost 1  directory.example (1)',
    ])

    const compared = await readEverywhere({ compare: 'previous' })
    expect(compared.rest.rows.map(row => [row.queryId, row.engines.map(entry => [entry.provider, entry.mentionChange ?? null, entry.citationChange ?? null])])).toStrictEqual([
      ['q-east', [['gemini', 'won', null], ['openai', null, 'lost']]],
      ['q-tools', [['gemini', null, null], ['openai', null, null]]],
    ])
    expect(compared.viaCli).toStrictEqual(compared.rest)
    expect(compared.viaMcp).toStrictEqual(compared.rest)
    const rows = await invokeCli(['query', 'results', PROJECT, '--compare', 'previous'])
    expect(rows.stdout.split('\n')).toStrictEqual([
      ...sweepLines,
      LEGEND,
      'Query                      Type       gemini  openai  Change',
      'best supplier in the east  Non-brand  Mc      mc      gemini won mention, openai lost citation',
      'northwind tools pricing    Branded    Mc      Mc',
    ])

    // Filters and sort run on the server, so every surface returns the same rows.
    const lost = await readEverywhere({ compare: 'previous', change: 'lost', signal: 'cited' })
    expect(lost.rest.rows.map(row => row.queryId)).toStrictEqual(['q-east'])
    expect(lost.viaCli).toStrictEqual(lost.rest)
    expect(lost.viaMcp).toStrictEqual(lost.rest)
    const named = await readEverywhere({ engine: 'openai', result: 'mentioned' })
    expect(named.rest.rows.map(row => row.queryId)).toStrictEqual(['q-tools'])
    expect(named.viaCli).toStrictEqual(named.rest)
    // A sorted read keeps the server's order: the Branded query wins on mentions, so it leads.
    const winning = await invokeCli(['query', 'results', PROJECT, '--sort', 'winning'])
    expect(winning.stdout.split('\n').slice(-2)).toStrictEqual([
      'northwind tools pricing    Branded    Mc      Mc',
      'best supplier in the east  Non-brand  Mc      mc',
    ])
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
    // A simple project carries the same totals. Gemini saved no answer to the Branded query, so its rates are withheld.
    const withheld = { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' }
    expect(rest.totals).toStrictEqual([
      { queryClass: 'branded', queries: 1, answers: 1, mentionCoverage: withheld, citationCoverage: withheld },
      {
        queryClass: 'non-brand', queries: 1, answers: 2,
        mentionCoverage: { numerator: 1, denominator: 2, rate: 0.5 },
        citationCoverage: { numerator: 1, denominator: 2, rate: 0.5 },
      },
    ])
    expect(viaCli).toStrictEqual(rest)
    expect(viaMcp).toStrictEqual(rest)

    // One query of it, with its answers, is the same body on every surface too.
    const one = await readEverywhere({ queryId: 'q-supplier' })
    expect(one.rest.rows.map(row => [row.queryId, row.engines.map(entry => entry.answerRows?.map(answer => [answer.resultId, answer.mentioned, answer.cited]))])).toStrictEqual([
      ['q-supplier', [[['q-supplier-gemini', true, false]], [['q-supplier-openai', false, true]]]],
    ])
    expect(one.rest).not.toHaveProperty('totals')
    expect(one.viaCli).toStrictEqual(one.rest)
    expect(one.viaMcp).toStrictEqual(one.rest)
  })

  it('prints the legend above a two-glyph table, mention first, in query order', async () => {
    simpleSweep()
    const result = await invokeCli(['query', 'results', PROJECT])
    expect(result.exitCode, result.stderr).toBeUndefined()
    // The API returns `q-brand` first (by id); the table reads by query text.
    expect(result.stdout.split('\n')).toStrictEqual([
      'Sweep 2026-10-07 · run run-simple',
      // One line per Type, the category first. Gemini saved no answer to the Branded query.
      'Non-brand: mentioned 1 of 2 · cited 1 of 2',
      'Branded: mentioned not measured (evidence incomplete) · cited not measured (evidence incomplete)',
      LEGEND,
      'Query                     Type       gemini  openai',
      'best widget supplier      Non-brand  Mc      mC',
      // Gemini was asked and saved no answer: both signals are not checked.
      'northwind delivery times  Branded    --      Mc',
    ])
  })

  it('prints Not set for a query with no Type, and a blank cell for an engine the row was not asked on', async () => {
    // An older sweep that froze no definition, on a project with no usable brand name.
    db.update(projects).set({ displayName: '', canonicalDomain: '' }).where(eq(projects.id, PROJECT_ID)).run()
    db.insert(runs).values({
      id: 'run-older', projectId: PROJECT_ID, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
      finishedAt: SWEEP_AT, createdAt: SWEEP_AT,
    }).run()
    const answer = (queryId: string, queryText: string, provider: 'gemini' | 'openai', mentioned: boolean, cited: boolean) => ({
      id: `${queryId}-${provider}`, runId: 'run-older', queryId, queryText, provider,
      citationState: cited ? 'cited' : 'not-cited', answerMentioned: mentioned, answerText: null,
      citedDomains: [], citedUrls: [], captureStatus: 'complete',
      competitorOverlap: [], recommendedCompetitors: [], location: null, createdAt: SWEEP_AT,
    })
    db.insert(querySnapshots).values([
      answer('q-supplier', 'best widget supplier', 'gemini', true, false),
      answer('q-supplier', 'best widget supplier', 'openai', false, true),
      // That sweep asked this query on OpenAI only.
      answer('q-brand', 'northwind delivery times', 'openai', true, true),
    ]).run()

    const result = await invokeCli(['query', 'results', PROJECT])
    expect(result.exitCode, result.stderr).toBeUndefined()
    expect(result.stdout.split('\n')).toStrictEqual([
      'Sweep 2026-10-07 · run run-older',
      'Not set: mentioned 2 of 3 · cited 2 of 3',
      LEGEND,
      'Query                     Type       gemini  openai',
      'best widget supplier      Not set    Mc      mC',
      'northwind delivery times  Not set            MC',
    ])
  })

  it('says what the sweep did not measure, and that there is no sweep', async () => {
    expect((await invokeCli(['query', 'results', PROJECT])).stdout).toBe('No sweep yet')

    simpleSweep()
    db.insert(queries).values({ id: 'q-new', projectId: PROJECT_ID, query: 'widget supplier with warranty', createdAt: NOW }).run()
    const lines = (await invokeCli(['query', 'results', PROJECT])).stdout.split('\n')
    expect(lines.filter(line => !/: mentioned /.test(line)).slice(0, 3)).toStrictEqual(['Sweep 2026-10-07 · run run-simple', 'Not in this sweep: 1', LEGEND])
    // The sweep line, one total per Type, the pending line, the legend, the header and two rows.
    expect(lines).toHaveLength(8)

    // The project stopped asking Gemini, so the sweep measured nothing as it is asked now: no table to print.
    db.update(projects).set({ providers: ['openai'] }).where(eq(projects.id, PROJECT_ID)).run()
    expect((await invokeCli(['query', 'results', PROJECT])).stdout.split('\n')).toStrictEqual([
      'Sweep 2026-10-07 · run run-simple', 'Not in this sweep: 3', 'No results',
    ])
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

    // A blank value, as an unset shell variable leaves, and every rule of the read are named by flag.
    for (const [flags, message] of [
      [['--scope-key', ''], '--scope-key needs a value'],
      [['--scope', 'market', '--scope-key', ' '], '--scope-key needs a value'],
      [['--run', ''], '--run needs a value'],
      [['--query', ''], '--query needs a value'],
      [['--engine', ''], '--engine needs a value'],
      [['--signal', 'shown'], '--signal must be one of mentioned, cited'],
      [['--sort', 'name'], '--sort must be one of losing, winning'],
      [['--compare', 'last'], '--compare must be previous'],
      [['--result', 'missed'], '--result must be one of mentioned, not-mentioned, cited, not-cited'],
      [['--change', 'lost'], '--change needs --compare previous'],
      [['--group', 'market', '--scope', 'market', '--scope-key', 'east'], '--group is read at project or group scope'],
      [['--group', 'market', '--query', 'q-east'], '--group is not read with --query'],
      [['--group', 'market', '--engine', 'gemini'], '--group is not read with --engine, --result or --change'],
    ] as const) {
      const blank = await invokeCli(['query', 'results', PROJECT, ...flags, '--format', 'json'])
      expect(blank.exitCode, flags.join(' ')).toBe(1)
      expect(JSON.parse(blank.stderr), flags.join(' ')).toMatchObject({ error: { code: 'CLI_USAGE_ERROR', message } })
    }

    const noRun = await invokeCli(['query', 'results', PROJECT, '--run', 'missing', '--format', 'json'])
    expect(noRun.exitCode).toBe(1)
    expect(JSON.parse(noRun.stderr)).toMatchObject({ error: { code: 'VALIDATION_ERROR', message: 'Run "missing" is not a completed whole-project sweep of this project.' } })

    const mcp = await connect()
    const tool = await mcp.callTool({ name: 'canonry_query_tracking_results', arguments: { project: PROJECT, scope: 'property', scopeKey: 'widgets' } })
    expect(tool.isError).toBe(true)
    expect(JSON.stringify(tool.content)).toContain('a simple project is read as a whole')
  })
})
