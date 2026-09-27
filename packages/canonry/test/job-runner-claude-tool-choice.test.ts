import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  type LocationContext,
  type MeasurementPlanV2,
  type ProviderModels,
} from '@ainyc/canonry-contracts'
import { queueRunIfProjectIdle } from '@ainyc/canonry-api-routes'
import {
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
import { claudeAdapter } from '@ainyc/canonry-provider-claude'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'

// Claude Opus 5.5, Claude Fable 5.1 and Claude Mythos 5.1 return HTTP 400 for a
// forced tool_choice, so the Claude adapter sends them `tool_choice: auto` under
// the native-auto-v1 contract. The adapter tests pin that decision; these pin
// that the model a project or a portfolio revision pins actually reaches it, on
// both portfolio paths, and that the stored snapshot names the contract of the
// request that was really sent. The real Claude adapter runs against a stubbed
// Messages API.

const NOW = '2026-09-01T00:00:00.000Z'
const NORTH: LocationContext = { label: 'north-city', city: 'North City', region: 'NC', country: 'US' }
const PLACEHOLDER_CHECKSUM = '0'.repeat(64)
const QUERY_TEXT = 'widget pricing'

/** Stub the Anthropic Messages API; every request body it receives is recorded. */
function stubMessagesApi(content: unknown[]): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    bodies.push(body)
    return new Response(JSON.stringify({
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content,
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  onTestFinished(() => { vi.unstubAllGlobals() })
  return bodies
}

/** Claude answered from memory: no search call, nothing cited. */
const UNSEARCHED = [{ type: 'text', text: 'Widgets cost about ten dollars.' }]

const SEARCHED = [
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: QUERY_TEXT } },
  {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: [{ type: 'web_search_result', url: 'https://example.com/pricing', title: 'Pricing' }],
  },
  { type: 'text', text: 'Widgets cost about ten dollars.' },
]

/** The server-wide Claude registration: the default model accepts forcing. */
function claudeRegistry() {
  const registry = new ProviderRegistry()
  registry.register(claudeAdapter, {
    provider: 'claude',
    apiKey: 'test-key',
    model: 'claude-sonnet-5',
    quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 600, maxRequestsPerDay: 1000 },
  })
  return registry
}

function seedDb(prefix: string): DatabaseClient {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  return db
}

function insertProject(db: DatabaseClient, providerModels: ProviderModels) {
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'tool-choice',
    displayName: 'Tool Choice Co',
    canonicalDomain: 'example.com',
    aliases: ['Tool Choice Co'],
    country: 'US',
    language: 'en',
    providers: ['claude'],
    providerModels,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  db.insert(queries).values({ id: 'q-1', projectId, query: QUERY_TEXT, createdAt: NOW }).run()
  return projectId
}

/** Simple portfolio: the project's own basket, with an optional per-project model pin. */
async function runSimplePortfolio(providerModels: ProviderModels) {
  const db = seedDb('canonry-claude-tool-choice-simple-')
  const projectId = insertProject(db, providerModels)
  const runId = crypto.randomUUID()
  db.insert(runs).values({ id: runId, projectId, status: 'queued', createdAt: NOW }).run()
  await new JobRunner(db, claudeRegistry()).executeRun(runId, projectId)
  return db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
}

/** A published v2 revision whose one execution node pins the Claude model. */
function plannedRevision(model: string): MeasurementPlanV2 {
  const draft: MeasurementPlanV2 = {
    schemaVersion: 2,
    identities: {
      projectBrand: { canonicalHost: 'example.com', ownedHosts: ['example.com'], names: ['Tool Choice Co'] },
    },
    targets: [{
      stableKey: 'property-001',
      label: 'property-001',
      aliases: ['property-001'],
      urlMatchers: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/property-001', pathCase: 'insensitive' }],
      mentionNotApplicable: false,
      discoveryIdentity: null,
    }],
    groups: [],
    querySnapshots: [{
      queryId: 'q-1',
      queryText: QUERY_TEXT,
      provenance: { source: 'manual', sourceId: null, capturedAt: NOW },
    }],
    assignments: [{ targetKey: 'property-001', queryId: 'q-1', queryClass: 'non-brand', executionNodeKey: 'exec-claude' }],
    executionNodes: [{
      stableKey: 'exec-claude',
      queryId: 'q-1',
      queryText: QUERY_TEXT,
      context: { providers: ['claude'], models: { claude: model }, location: NORTH },
      expectedSnapshots: 1,
    }],
    usageEdges: [{ executionNodeKey: 'exec-claude', targetKey: 'property-001', queryId: 'q-1' }],
    compiledChecksum: PLACEHOLDER_CHECKSUM,
  }
  return {
    ...draft,
    compiledChecksum: crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(draft)).digest('hex'),
  }
}

/** Custom portfolio: an Advanced Measurement revision freezes the model per execution node. */
async function runCustomPortfolio(model: string) {
  const db = seedDb('canonry-claude-tool-choice-custom-')
  const projectId = insertProject(db, {})
  const plan = plannedRevision(model)
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId,
    projectId,
    revision: 1,
    canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'),
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()

  const queued = queueRunIfProjectIdle(db, { projectId })
  if (queued.conflict) throw new Error('unexpected conflict')
  await new JobRunner(db, claudeRegistry()).executeRun(queued.runId, projectId)
  expect(db.select().from(runs).where(eq(runs.id, queued.runId)).get()!.status).toBe('completed')
  return db.select().from(querySnapshots).where(eq(querySnapshots.runId, queued.runId)).all()
}

describe('simple portfolio', () => {
  it('a project pinned to a model that rejects forcing is sent auto and stores native-auto-v1', async () => {
    const bodies = stubMessagesApi(UNSEARCHED)
    const rows = await runSimplePortfolio({ claude: 'claude-opus-5-5' })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.model).toBe('claude-opus-5-5')
    expect(bodies[0]!.tool_choice).toEqual({ type: 'auto' })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.model).toBe('claude-opus-5-5')
    expect(rows[0]!.retrievalContract).toBe('native-auto-v1')
    // Unforced, Claude answered from memory; the row says so rather than
    // passing as a searched answer that cited nothing.
    expect(rows[0]!.retrievalStatus).toBe('not-used')
  })

  it('a project on the default model is still forced and stores search-required-v1', async () => {
    const bodies = stubMessagesApi(SEARCHED)
    const rows = await runSimplePortfolio({})

    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.model).toBe('claude-sonnet-5')
    expect(bodies[0]!.tool_choice).toEqual({ type: 'tool', name: 'web_search' })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.retrievalContract).toBe('search-required-v1')
    expect(rows[0]!.retrievalStatus).toBe('used')
  })
})

describe('custom portfolio', () => {
  it('a revision that pins a model rejecting forcing is sent auto and stores native-auto-v1', async () => {
    const bodies = stubMessagesApi(UNSEARCHED)
    const rows = await runCustomPortfolio('claude-fable-5-1')

    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.model).toBe('claude-fable-5-1')
    expect(bodies[0]!.tool_choice).toEqual({ type: 'auto' })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.model).toBe('claude-fable-5-1')
    expect(rows[0]!.measurementExecutionId).toBe('exec-claude')
    expect(rows[0]!.retrievalContract).toBe('native-auto-v1')
    expect(rows[0]!.retrievalStatus).toBe('not-used')
  })

  it('a revision that pins a model accepting forcing is forced and stores search-required-v1', async () => {
    const bodies = stubMessagesApi(SEARCHED)
    const rows = await runCustomPortfolio('claude-opus-5')

    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.model).toBe('claude-opus-5')
    expect(bodies[0]!.tool_choice).toEqual({ type: 'tool', name: 'web_search' })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.retrievalContract).toBe('search-required-v1')
    expect(rows[0]!.retrievalStatus).toBe('used')
  })
})
