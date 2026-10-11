import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { buildMeasurementRunManifestV1, measurementPlanV2Schema } from '@ainyc/canonry-contracts'
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
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { ApiClient } from '../src/client.js'
import { createDemoServer } from '../src/demo-server.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'
import { invokeCli } from './cli-test-utils.js'

const NOW = '2026-10-01T09:00:00.000Z'
const SWEEP_AT = '2026-10-07T12:00:00.000Z'
const PUBLISH_AT = '2026-10-09T15:00:00.000Z'
const PROJECT = 'northwind'
const PROJECT_ID = 'prj_northwind'
const FALLBACK = 'last-sweep' as const
const TARGET = {
  stableKey: 'widgets', label: 'Widgets', status: 'included' as const, aliases: ['Northwind Widgets'],
  urlMatchers: ['https://northwind.example/widgets/*'], source: 'manual' as const,
}
const LAST_SWEEP_LINE = 'Tracking changed 2026-10-09. Showing the 2026-10-07 sweep. New numbers after the next sweep.'
const AWAITING = { activeRevision: 2, measuredRevision: 1, awaitingSweep: true, trackingChangedAt: PUBLISH_AT }
const cleanups: Array<() => Promise<void>> = []
let directory: string
let db: DatabaseClient
let api: ApiClient
let origin: string
let key: string

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-last-sweep-parity-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', directory)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  const database = path.join(directory, 'test.db')
  db = createClient(database)
  migrate(db)
  db.insert(projects).values({
    id: PROJECT_ID, name: PROJECT, displayName: 'Northwind', canonicalDomain: 'northwind.example',
    country: 'US', language: 'en', providers: ['openai', 'gemini'], providerModels: { openai: 'gpt-test', gemini: 'gemini-test' },
    locations: [{ label: 'nyc', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: 'nyc',
    createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(queries).values({ id: 'q-supplier', projectId: PROJECT_ID, query: 'best widget supplier', createdAt: NOW }).run()
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
  const server = createCanonryMcpServer({ scope: 'all', tiers: ['setup', 'monitoring'],
    clientFactory: () => new ApiClient(origin, key, { skipProbe: true }) })
  const client = new Client({ name: 'last-sweep-parity-test', version: '1' }, { capabilities: {} })
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

/**
 * Publishes revision 1 through the API (one location asked one query), stores
 * one completed sweep of it, then publishes a tracking change the way the
 * dashboard does: one query added for that location. No sweep follows.
 */
async function sweptThenTrackingChanged(): Promise<void> {
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
  db.insert(runs).values({
    id: 'run-sweep', projectId: PROJECT_ID, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
    measurementPlanVersionId: version.id, measurementManifest: buildMeasurementRunManifestV1({ expectedSlots: slots }),
    finishedAt: SWEEP_AT, createdAt: SWEEP_AT,
  }).run()
  // Gemini names the location. OpenAI names another supplier. Neither cites its page.
  const answers: Record<string, { text: string; recommended: string[] }> = {
    gemini: { text: 'Northwind Widgets is a reliable supplier.', recommended: [] },
    openai: { text: 'Fabrikam Parts ships quickly.', recommended: ['Fabrikam Parts'] },
  }
  db.insert(querySnapshots).values(slots.map(slot => ({
    id: `answer-${slot.provider}`, runId: 'run-sweep', queryId: null, queryText: slot.queryText, provider: slot.provider,
    citationState: 'not-cited' as const, answerMentioned: null, answerText: answers[slot.provider]!.text,
    citedDomains: [], citedUrls: ['https://directory.example/suppliers'], captureStatus: 'complete' as const,
    competitorOverlap: [], recommendedCompetitors: answers[slot.provider]!.recommended,
    location: slot.context?.label ?? null, measurementExecutionId: slot.executionId,
    requestedContext: slot.context, supportedContext: { status: 'applied' as const, resolved: slot.context },
    createdAt: SWEEP_AT,
  }))).run()

  const workspace = await api.getQueryTrackingWorkspace(PROJECT)
  const mutation = {
    expectedWorkspaceVersion: workspace.workspaceVersion, removals: [],
    additions: [{
      input: { source: 'manual' as const, text: 'widget warranty terms' }, audience: { targetKeys: ['widgets'] },
      contexts: workspace.defaultContexts.map(context => ({ ...context, location: context.location?.label ?? null })),
    }],
  }
  const review = await api.previewQueryTracking(PROJECT, mutation)
  const committed = await api.commitQueryTracking(PROJECT, { ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
  expect(committed.active?.revision).toBe(2)
  // The publish is stamped with the wall clock. Pin it so the printed dates are exact.
  db.update(measurementPlanVersions).set({ createdAt: PUBLISH_AT }).where(eq(measurementPlanVersions.revision, 2)).run()
}

type Surfaces = { rest: unknown; cli: unknown; advanced?: unknown; mcp: unknown }

async function mcpRead(name: string, input: Record<string, unknown>): Promise<unknown> {
  const mcp = await connect()
  const tool = await mcp.callTool({ name, arguments: { project: PROJECT, ...input } })
  expect(tool.isError, JSON.stringify(tool)).not.toBe(true)
  return tool.structuredContent
}

async function cliJson(args: string[]): Promise<unknown> {
  const result = await invokeCli([...args, '--format', 'json'])
  expect(result.exitCode, result.stderr).toBeUndefined()
  return JSON.parse(result.stdout) as unknown
}

const advanced = (operation: string, input: unknown) =>
  cliJson(['measurement-plan', 'advanced', PROJECT, operation, inputFile(operation, input)])

/** One read of each of the five, through the REST client, the CLI and the MCP tool, each over its real transport. */
async function readEverywhere(fallback: typeof FALLBACK | undefined): Promise<Record<string, Surfaces>> {
  const asked = fallback === undefined ? {} : { fallback }
  const flag = fallback === undefined ? [] : ['--fallback', fallback]
  const location = { scope: 'property' as const, targetKey: 'widgets', ...asked }
  const answers = { targetKey: 'widgets', shape: 'answers' as const, queryClass: 'non-brand' as const, ...asked }
  const named = { targetKey: 'widgets', queryClass: 'non-brand' as const, ...asked }
  const listed = { targetKey: 'widgets', ...asked }
  const opened = { targetKey: 'widgets', resultId: 'answer-gemini', ...asked }
  const rejected = (error: unknown) => ({ refused: (error as { code?: string }).code })
  const refusedTool = async (name: string, input: Record<string, unknown>) => {
    const mcp = await connect()
    const tool = await mcp.callTool({ name, arguments: { project: PROJECT, ...input } })
    return tool.isError === true ? { refused: (tool.structuredContent as { error: { code: string } }).error.code } : tool.structuredContent
  }
  const refusedCli = async (operation: string, input: unknown) => {
    const result = await invokeCli(['measurement-plan', 'advanced', PROJECT, operation, inputFile(operation, input), '--format', 'json'])
    return result.exitCode === undefined
      ? JSON.parse(result.stdout) as unknown
      : { refused: (JSON.parse(result.stderr) as { error: { code: string } }).error.code }
  }
  return {
    overview: {
      rest: await api.getMeasurementOverview(PROJECT, location),
      cli: await cliJson(['measurement-plan', 'property', PROJECT, '--target-key', 'widgets', ...flag]),
      advanced: await advanced('overview', { ...location, compact: false }),
      mcp: await mcpRead('canonry_measurement_overview', { ...location, compact: false }),
    },
    evidence: {
      rest: await api.getMeasurementPropertyEvidence(PROJECT, answers),
      cli: await cliJson(['measurement-plan', 'property-evidence', PROJECT, '--target-key', 'widgets', '--shape', 'answers', '--query-class', 'non-brand', ...flag]),
      mcp: await mcpRead('canonry_measurement_property_evidence', answers),
    },
    competitors: {
      rest: await api.getMeasurementPropertyCompetitors(PROJECT, named),
      cli: await advanced('property-competitors', named),
      mcp: await mcpRead('canonry_measurement_property_competitors', named),
    },
    questions: {
      rest: await api.getMeasurementPropertyQuestions(PROJECT, listed),
      cli: await advanced('property-questions', listed),
      mcp: await mcpRead('canonry_measurement_property_questions', listed),
    },
    // Without the param a result of the old sweep is refused on every surface.
    result: {
      rest: await api.getMeasurementQuestionResult(PROJECT, opened).catch(rejected),
      cli: await refusedCli('question-result', opened),
      mcp: await refusedTool('canonry_measurement_question_result', opened),
    },
  }
}

describe('last-sweep fallback CLI/REST/MCP parity', () => {
  it('returns the last sweep, with the same body, on every surface', async () => {
    await sweptThenTrackingChanged()
    const reads = await readEverywhere(FALLBACK)

    const named = { state: 'available', value: 0.5, numerator: 1, denominator: 2 }
    const uncited = { state: 'available', value: 0, numerator: 0, denominator: 2 }
    expect(reads.overview!.rest).toStrictEqual({
      mode: 'active-v2',
      scope: { kind: 'property', key: 'widgets', label: 'Widgets' },
      queryClass: 'non-brand',
      measurement: {
        state: 'complete', displayedRunId: 'run-sweep', completed: 2, expected: 2, completedAt: SWEEP_AT,
        includesHistoricalData: false, ...AWAITING,
      },
      nextAction: { kind: 'run_measurement' },
      metrics: {
        propertiesMentioned: { state: 'available', value: 1, numerator: 1, denominator: 1 },
        // Named in one of the two answers the sweep saved, and cited in neither.
        // The same answer names the brand, which is its own independent reading.
        mentionCoverage: named, citationCoverage: uncited, brandPresence: named, sov: named,
      },
      properties: {
        items: [{
          targetKey: 'widgets', label: 'Widgets', metro: null, mentionCoverage: named, citationCoverage: uncited,
          providers: [
            { provider: 'gemini', mentionCoverage: { state: 'available', value: 1, numerator: 1, denominator: 1 }, citationCoverage: { state: 'available', value: 0, numerator: 0, denominator: 1 } },
            { provider: 'openai', mentionCoverage: { state: 'available', value: 0, numerator: 0, denominator: 1 }, citationCoverage: { state: 'available', value: 0, numerator: 0, denominator: 1 } },
          ],
          flags: 0,
        }],
        nextCursor: null,
        totalEstimate: 1,
      },
      outcomes: { bothSignals: 0, mentionedOnly: 1, citedOnly: 0, neither: 0, notMeasured: 0, total: 1 },
      flags: { total: 0 },
    })

    const sweep = { ...AWAITING, state: 'complete', displayedRunId: 'run-sweep', completedAt: SWEEP_AT }
    expect(reads.evidence!.rest).toMatchObject({ measurement: sweep, answers: { totalEstimate: 2 } })
    expect((reads.evidence!.rest as { answers: { items: Array<{ provider: string; mentioned: boolean | null; cited: boolean | null }> } }).answers.items
      .map(answer => [answer.provider, answer.mentioned, answer.cited])).toStrictEqual([['gemini', true, false], ['openai', false, false]])
    expect(reads.competitors!.rest).toMatchObject({
      measurement: { ...sweep, planRevision: 2 },
      basis: { state: 'available', answeredResults: 2, targetMissResults: 1, recommendationOccurrences: 1 },
      competitors: [{ name: 'Fabrikam Parts', occurrences: 1 }],
    })
    expect(reads.questions!.rest).toMatchObject({ measurement: { ...sweep, planRevision: 2 }, total: 2 })
    expect(reads.result!.rest).toMatchObject({
      measurement: { ...sweep, planRevision: 2 }, mentioned: true, cited: false, answer: 'Northwind Widgets is a reliable supplier.',
    })

    for (const [name, read] of Object.entries(reads)) {
      expect(read.cli, `${name} via the CLI`).toStrictEqual(read.rest)
      expect(read.mcp, `${name} via MCP`).toStrictEqual(read.rest)
      if (read.advanced !== undefined) expect(read.advanced, `${name} via the advanced operation`).toStrictEqual(read.rest)
    }
  })

  it('still says not measured on every surface when the param is not sent', async () => {
    await sweptThenTrackingChanged()
    const reads = await readEverywhere(undefined)

    expect(reads.overview!.rest).toMatchObject({
      measurement: { state: 'not_measured', completed: 0, expected: 4 },
      metrics: { mentionCoverage: { state: 'unavailable', reason: 'no_completed_run' } },
    })
    expect(reads.evidence!.rest).toStrictEqual({
      property: { targetKey: 'widgets', label: 'Widgets' }, queryClass: 'non-brand', measurement: { state: 'not_measured' },
      answers: { items: [], nextCursor: null, totalEstimate: 0 },
    })
    expect(reads.competitors!.rest).toMatchObject({ basis: { state: 'unavailable', reason: 'no_completed_run' }, competitors: [] })
    expect(reads.questions!.rest).toMatchObject({ measurement: { state: 'not_measured', displayedRunId: null, planRevision: 2 }, questions: [] })
    expect(reads.result!.rest).toStrictEqual({ refused: 'MEASUREMENT_RUN_REVISION_MISMATCH' })

    for (const [name, read] of Object.entries(reads)) {
      expect(JSON.stringify(read.rest), name).not.toContain('awaitingSweep')
      expect(read.cli, `${name} via the CLI`).toStrictEqual(read.rest)
      expect(read.mcp, `${name} via MCP`).toStrictEqual(read.rest)
      if (read.advanced !== undefined) expect(read.advanced, `${name} via the advanced operation`).toStrictEqual(read.rest)
    }
  })

  it('prints when tracking changed and which sweep the numbers are from', async () => {
    await sweptThenTrackingChanged()

    const property = await invokeCli(['measurement-plan', 'property', PROJECT, '--target-key', 'widgets', '--fallback', FALLBACK])
    expect(property.exitCode, property.stderr).toBeUndefined()
    expect(property.stdout.split('\n').slice(0, 6)).toStrictEqual([
      'Widgets · non-brand queries',
      'Measurement: complete · run run-sweep',
      LAST_SWEEP_LINE,
      '',
      'Mentioned  1 of 2 (50.0%)',
      'Cited      0 of 2 (0%)',
    ])
    const evidence = await invokeCli(['measurement-plan', 'property-evidence', PROJECT, '--target-key', 'widgets', '--shape', 'answers', '--fallback', FALLBACK])
    expect(evidence.exitCode, evidence.stderr).toBeUndefined()
    expect(evidence.stdout.split('\n').slice(1, 4)).toStrictEqual(['Measurement: complete · run run-sweep', LAST_SWEEP_LINE, '2 of 2 answers'])

    // Without the flag the output is today's, with no such line.
    const plain = await invokeCli(['measurement-plan', 'property', PROJECT, '--target-key', 'widgets'])
    expect(plain.stdout.split('\n').slice(0, 2)).toStrictEqual(['Widgets · non-brand queries', 'Measurement: not_measured'])
    expect(plain.stdout).not.toContain('Tracking changed')

    const wrong = await invokeCli(['measurement-plan', 'property', PROJECT, '--target-key', 'widgets', '--fallback', 'newest', '--format', 'json'])
    expect(wrong.exitCode).toBe(1)
    expect(JSON.parse(wrong.stderr)).toMatchObject({ error: { code: 'CLI_USAGE_ERROR', message: '--fallback must be last-sweep' } })
  })
})

describe('last-sweep fallback on the public demo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-last-sweep-demo-'))
  let demo: Awaited<ReturnType<typeof createDemoServer>>
  let visitor = 0
  // A distinct forwarded address per request keeps these reads clear of the per-visitor API budget.
  const read = (suffix: string) => {
    visitor += 1
    return demo.inject({ url: `/api/v1/projects/harbor-resorts/${suffix}`, headers: { 'x-forwarded-for': `10.9.0.${visitor}` } })
  }

  beforeAll(async () => {
    fs.mkdirSync(path.join(dir, 'assets'))
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>')
    demo = await createDemoServer({ assetsDir: dir })
  }, 60_000)
  afterAll(async () => { await demo?.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  it('answers the five reads with the param on the sample portfolio, from a database that refuses writes', async () => {
    const target = 'targetKey=harbor-key-west-1'
    const resultId = (await read(`measurement-property-questions?${target}`)).json().questions
      .find((row: { resultId: string | null }) => row.resultId !== null).resultId as string
    for (const suffix of [
      `measurement-overview?scope=property&${target}`,
      `measurement-property-evidence?${target}&shape=answers`,
      `measurement-property-competitors?${target}`,
      `measurement-property-questions?${target}`,
      `measurement-question-result?${target}&resultId=${encodeURIComponent(resultId)}`,
    ]) {
      const plain = await read(suffix)
      const asked = await read(`${suffix}&fallback=${FALLBACK}`)
      expect(plain.statusCode, suffix).toBe(200)
      expect(asked.statusCode, `${suffix}: ${asked.body.slice(0, 200)}`).toBe(200)
      // The sample's sweeps are of its active plan, so the param adds the fields and moves nothing.
      const { activeRevision, measuredRevision, awaitingSweep, trackingChangedAt, ...measurement } = asked.json().measurement
      expect({ ...asked.json(), measurement }, suffix).toStrictEqual(plain.json())
      expect(measuredRevision, suffix).toBe(activeRevision)
      expect(awaitingSweep, suffix).toBe(false)
      expect(typeof trackingChangedAt, suffix).toBe('string')
    }
  })
})
