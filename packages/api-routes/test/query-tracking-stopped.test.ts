import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildMeasurementRunManifestV1,
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  queryTrackingCommitResponseSchema,
  queryTrackingPreviewResponseSchema,
  queryTrackingResultsResponseSchema,
  queryTrackingWorkspaceResponseSchema,
  RunKinds,
  RunStatuses,
  RunTriggers,
  type MeasurementPlanV2,
  type QueryTrackingWorkspaceResponse,
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  auditLog,
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
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

/**
 * Stop tracking keeps the query: its row stays on the list as not asked, with
 * the answers linked to it. These cases run the real preview and commit routes
 * on a portfolio shaped as setup stores one: catalog rows with uuid ids and a
 * setup marker for provenance, the Source frozen in the plan, every type set
 * by an operator, and sweeps whose answers link to their query row.
 */

const SETUP_AT = '2026-09-08T10:00:00.000Z'
const FIRST_SWEEP = '2026-09-23T09:30:00.000Z'
const LAST_SWEEP_STARTED = '2026-10-07T09:00:00.000Z'
const LAST_SWEEP = '2026-10-07T09:31:07.250Z'
const PROJECT = 'acme-homes'
const PROJECT_ID = 'project-acme-homes'
const ROOT_KEY = 'cnry_tracking_stopped_root'
const ENGINES = ['claude', 'gemini', 'openai'] as const
type Engine = typeof ENGINES[number]
const MODELS = { claude: 'claude-test', gemini: 'gemini-test', openai: 'gpt-test' }
const RIVERSIDE = { label: 'riverside', city: 'Riverside', region: 'EX', country: 'US' }
const MARKET = 'lakeshore-metro'
const MARKET_LOCATIONS = ['cedar-court', 'harbor-point', 'maple-row']
/** The Source setup froze in the plan for every query. */
const FROZEN = { source: 'manual' as const, sourceId: null, capturedAt: SETUP_AT }

/** Setup mints a uuid for each query. */
const QUERY = {
  /** Lakeshore metro's market query, asked once for its three locations. */
  market: { id: crypto.randomUUID(), text: 'best homes in lakeshore', marker: 'measurement-template:tpl-market-best' },
  /** A second market query, so the market keeps its locations when the first is stopped. */
  pets: { id: crypto.randomUUID(), text: 'pet friendly homes in lakeshore', marker: 'measurement-template:tpl-market-pets' },
  /** Harbor Point's own query. */
  harbor: { id: crypto.randomUUID(), text: 'Harbor Point reviews', marker: 'measurement-template:tpl-location-reviews' },
  /** On the list and asked nowhere: an earlier setup publish left it out. No sweep ever asked it. */
  marina: { id: crypto.randomUUID(), text: 'homes near the marina', marker: 'cli' },
} as const

let directory: string
let db: DatabaseClient
let app: FastifyInstance

function seededPlan(): MeasurementPlanV2 {
  const asked = [QUERY.market, QUERY.pets, QUERY.harbor]
  const edges = [
    ...MARKET_LOCATIONS.map(targetKey => ({ executionNodeKey: `n-${QUERY.market.id}`, targetKey, queryId: QUERY.market.id })),
    ...MARKET_LOCATIONS.map(targetKey => ({ executionNodeKey: `n-${QUERY.pets.id}`, targetKey, queryId: QUERY.pets.id })),
    { executionNodeKey: `n-${QUERY.harbor.id}`, targetKey: 'harbor-point', queryId: QUERY.harbor.id },
  ]
  const provisional = measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'acme.example', ownedHosts: ['acme.example'], names: ['Acme Homes'] } },
    // Pier House is in no market and is asked nothing.
    targets: [['cedar-court', 'Cedar Court'], ['harbor-point', 'Harbor Point'], ['maple-row', 'Maple Row'], ['pier-house', 'Pier House']]
      .map(([stableKey, label]) => ({
        stableKey, label, aliases: [label],
        urlMatchers: [{ kind: 'prefix', host: 'acme.example', pathPrefix: `/${stableKey}`, pathCase: 'insensitive' }],
        mentionNotApplicable: false, discoveryIdentity: null,
      })),
    groups: [],
    querySnapshots: asked.map(query => ({ queryId: query.id, queryText: query.text, provenance: FROZEN })),
    assignments: edges.map(edge => ({
      ...edge, queryClass: edge.queryId === QUERY.harbor.id ? 'branded' : 'non-brand', classificationSource: 'operator',
    })),
    executionNodes: asked.map(query => ({
      stableKey: `n-${query.id}`, queryId: query.id, queryText: query.text,
      context: { providers: [...ENGINES], models: MODELS, location: RIVERSIDE }, expectedSnapshots: ENGINES.length,
    })),
    usageEdges: edges,
    reportingScopes: [{ stableKey: MARKET, label: 'Lakeshore metro', kind: 'market', usageEdges: edges }],
    compiledChecksum: '0'.repeat(64),
  })
  const compiledChecksum = crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(provisional)).digest('hex')
  return measurementPlanV2Schema.parse({ ...provisional, compiledChecksum })
}

/** Revision 1 with its catalog rows, as setup leaves a portfolio. */
function seedPortfolio(): { versionId: string; plan: MeasurementPlanV2 } {
  const plan = seededPlan()
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.insert(measurementPlanVersions).values({
    id: 'plan-v1', projectId: PROJECT_ID, revision: 1, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, comparableToVersionId: null, createdAt: SETUP_AT,
  }).run()
  db.insert(measurementPlans).values({ projectId: PROJECT_ID, activeVersionId: 'plan-v1', createdAt: SETUP_AT, updatedAt: SETUP_AT }).run()
  db.insert(queries).values(Object.values(QUERY).map(query => ({
    id: query.id, projectId: PROJECT_ID, query: query.text, provenance: query.marker, createdAt: SETUP_AT,
  }))).run()
  return { versionId: 'plan-v1', plan }
}

type Answer = { text: string; cites: string[] }
const OTHER_SOURCE = 'https://listings.example/lakeshore'
/**
 * What each engine answers in every seeded sweep:
 * - the market query: Claude names Harbor Point and cites nobody tracked, Gemini names nobody and cites
 *   Cedar Court's page, OpenAI names and cites nobody tracked;
 * - every other query: each engine names Harbor Point and cites its page.
 */
function answerOf(queryId: string, provider: Engine): Answer {
  if (queryId !== QUERY.market.id) return { text: 'Harbor Point gets good reviews.', cites: ['https://acme.example/harbor-point/reviews'] }
  if (provider === 'claude') return { text: 'Harbor Point is a strong option in Lakeshore.', cites: [OTHER_SOURCE] }
  if (provider === 'gemini') return { text: 'A few communities are worth a look.', cites: ['https://acme.example/cedar-court/floor-plans'] }
  return { text: 'Several other communities nearby are worth a look.', cites: [OTHER_SOURCE] }
}

/** One stored whole-project sweep of `plan`, as the queue freezes it. Each answer links to its query row, as the job runner stores it. */
function seedSweep(input: { versionId: string; plan: MeasurementPlanV2; createdAt: string; finishedAt: string }): string {
  const id = crypto.randomUUID()
  const manifest = buildMeasurementRunManifestV1({
    expectedSlots: input.plan.executionNodes.flatMap(node => node.context.providers.map(provider => ({
      executionId: node.stableKey, queryText: node.queryText, provider, context: node.context.location,
      requestedModel: node.context.models[provider]!,
    }))),
  })
  db.insert(runs).values({
    id, projectId: PROJECT_ID, kind: RunKinds['answer-visibility'], status: RunStatuses.completed, trigger: RunTriggers.manual,
    measurementPlanVersionId: input.versionId, measurementManifest: manifest, finishedAt: input.finishedAt, createdAt: input.createdAt,
  }).run()
  const nodes = new Map(input.plan.executionNodes.map(node => [node.stableKey, node]))
  db.insert(querySnapshots).values(manifest.expectedSlots.map(slot => {
    const node = nodes.get(slot.executionId)!
    const answer = answerOf(node.queryId, slot.provider as Engine)
    return {
      id: crypto.randomUUID(), runId: id, queryId: node.queryId, queryText: slot.queryText, provider: slot.provider,
      model: MODELS[slot.provider as Engine], citationState: 'not-cited' as const, answerMentioned: null, answerText: answer.text,
      citedDomains: [], citedUrls: answer.cites, captureStatus: 'complete' as const, competitorOverlap: [], recommendedCompetitors: [],
      location: RIVERSIDE.label, measurementExecutionId: slot.executionId,
      requestedContext: RIVERSIDE, supportedContext: { status: 'applied' as const, resolved: RIVERSIDE },
      createdAt: input.createdAt,
    }
  })).run()
  return id
}

/** The portfolio after two sweeps: the list, the marks and the dates a team sees before it stops a query. */
function seedSweptPortfolio(): void {
  const seeded = seedPortfolio()
  seedSweep({ ...seeded, createdAt: '2026-09-23T09:00:00.000Z', finishedAt: FIRST_SWEEP })
  seedSweep({ ...seeded, createdAt: LAST_SWEEP_STARTED, finishedAt: LAST_SWEEP })
}

/** One answer stored for `queryId` by a run of its own, outside the plan's sweeps. */
function storeAnswer(queryId: string, at: string, run: Partial<typeof runs.$inferInsert> = {}): void {
  const runId = crypto.randomUUID()
  db.insert(runs).values({
    id: runId, projectId: PROJECT_ID, kind: RunKinds['answer-visibility'], status: RunStatuses.completed, trigger: RunTriggers.manual,
    finishedAt: at, createdAt: at, ...run,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(), runId, queryId, queryText: 'as asked then', provider: 'openai', citationState: 'not-cited',
    citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: at,
  }).run()
}

function request(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${ROOT_KEY}` }, ...(payload === undefined ? {} : { payload }) })
}

async function workspace(project = PROJECT) {
  const response = await request('GET', `/projects/${project}/query-tracking`)
  expect(response.statusCode, response.body).toBe(200)
  return queryTrackingWorkspaceResponseSchema.parse(response.json())
}

type Mutation = { additions?: unknown[]; removals?: unknown[]; edits?: unknown[] }

async function review(mutation: Mutation, project = PROJECT) {
  const payload = {
    expectedWorkspaceVersion: (await workspace(project)).workspaceVersion,
    additions: mutation.additions ?? [], removals: mutation.removals ?? [],
    ...(mutation.edits ? { edits: mutation.edits } : {}),
  }
  const response = await request('POST', `/projects/${project}/query-tracking/preview`, payload)
  expect(response.statusCode, response.body).toBe(200)
  const preview = queryTrackingPreviewResponseSchema.parse(response.json())
  return { preview, commit: { ...payload, previewToken: preview.previewToken, reviewedAt: preview.reviewedAt } }
}

/** Publishes one reviewed change through the real routes. No sweep follows. */
async function publish(mutation: Mutation, project = PROJECT) {
  const { preview, commit } = await review(mutation, project)
  const response = await request('POST', `/projects/${project}/query-tracking/commit`, commit)
  expect(response.statusCode, response.body).toBe(200)
  return { preview, committed: queryTrackingCommitResponseSchema.parse(response.json()) }
}

async function results() {
  const response = await request('GET', `/projects/${PROJECT}/query-tracking/results`)
  expect(response.statusCode, response.body).toBe(200)
  return queryTrackingResultsResponseSchema.parse(response.json())
}

function rowOf(tracked: QueryTrackingWorkspaceResponse['tracked'], queryId: string) {
  return tracked.find(row => row.queryId === queryId)
}

function catalogRow(queryId: string) {
  return db.select().from(queries).where(eq(queries.id, queryId)).get()
}

/** How many stored answers link to the query's row. */
function linkedAnswers(queryId: string): number {
  return db.select({ id: querySnapshots.id }).from(querySnapshots).where(eq(querySnapshots.queryId, queryId)).all().length
}

function activePlan(): { revision: number; plan: MeasurementPlanV2 } {
  const pointer = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, PROJECT_ID)).get()!
  const version = db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, pointer.activeVersionId)).get()!
  return { revision: version.revision, plan: measurementPlanV2Schema.parse(JSON.parse(version.canonicalJson)) }
}

/** Every audit entry query tracking wrote for the project, with its parsed details. */
function trackingAudit(projectId = PROJECT_ID) {
  return db.select().from(auditLog).where(eq(auditLog.projectId, projectId)).all()
    .filter(entry => entry.action.startsWith('query-tracking.'))
    .map(entry => ({ action: entry.action, entityType: entry.entityType, entityId: entry.entityId, diff: JSON.parse(entry.diff ?? 'null') as Record<string, unknown> }))
}

function placement(targetKeys: string[] = [], marketKeys: string[] = []) {
  return { targetKeys, marketKeys }
}

const toMarket = (text: string, more: Record<string, unknown> = {}) => ({ input: { source: 'manual', text }, audience: { marketKeys: [MARKET] }, ...more })

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-tracking-stopped-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: PROJECT_ID, name: PROJECT, displayName: 'Acme Homes', canonicalDomain: 'acme.example',
    ownedDomains: [], aliases: [], country: 'US', language: 'en', providers: [...ENGINES], providerModels: MODELS,
    locations: [RIVERSIDE], defaultLocation: 'riverside', createdAt: SETUP_AT, updatedAt: SETUP_AT,
  }).run()
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'root', keyHash: hashApiKey(ROOT_KEY), keyPrefix: ROOT_KEY.slice(0, 9), scopes: ['*'], projectId: null, createdAt: SETUP_AT,
  }).run()
  app = Fastify()
  app.register(apiRoutes, {
    db, getRunnableProviderNames: () => [...ENGINES],
    // Apply checks the exported model of each engine against the host's descriptors.
    providerAdapters: ENGINES.map(name => ({
      name, displayName: name, mode: 'api' as const, modelConfigurable: true, defaultModel: MODELS[name], knownModels: [],
      modelValidationPattern: /-test$/, modelValidationHint: 'a test model',
    })),
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  db.$client.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('query tracking: stopping a query the plan asks', () => {
  it('keeps its row on the list as not asked, with its answers linked and the date of its last sweep', async () => {
    seedSweptPortfolio()
    const before = await workspace()
    expect(rowOf(before.tracked, QUERY.market.id)).toMatchObject({ state: 'tracked', lastMeasuredAt: LAST_SWEEP, provenance: FROZEN, focus: { kind: 'market', key: MARKET } })
    expect(before.summary).toMatchObject({ asked: 3, notAsked: 1 })
    expect(before.limits?.queries).toMatchObject({ current: 3, max: 1_000 })
    expect(linkedAnswers(QUERY.market.id)).toBe(6)

    const { preview, committed } = await publish({ removals: [{ queryId: QUERY.market.id }] })

    // The review lists the stop with the three pairs it ends, and still lists the row.
    expect(preview.diff.removed).toEqual([{ queryId: QUERY.market.id, queryText: QUERY.market.text, assignmentCount: 3 }])
    expect(preview.changes).toMatchObject([{
      queryId: QUERY.market.id, queryText: QUERY.market.text, change: 'removed',
      before: placement(MARKET_LOCATIONS, [MARKET]), after: placement(),
    }])
    expect(rowOf(preview.tracked, QUERY.market.id)).toMatchObject({ focus: { kind: 'not-asked' }, assignments: [], state: 'awaiting-sweep', lastMeasuredAt: LAST_SWEEP })
    expect(preview.limits?.queries).toMatchObject({ current: 3, next: 2 })
    expect(committed).toMatchObject({ committed: true, active: { revision: 2 } })
    expect(committed.diff.removed).toEqual(preview.diff.removed)

    // The plan no longer asks it. The row keeps its id and text, takes the Source the plan froze, and keeps its answers.
    expect(activePlan().plan.assignments.some(assignment => assignment.queryId === QUERY.market.id)).toBe(false)
    expect(activePlan().plan.querySnapshots.some(snapshot => snapshot.queryId === QUERY.market.id)).toBe(false)
    expect(catalogRow(QUERY.market.id)).toMatchObject({ id: QUERY.market.id, query: QUERY.market.text, createdAt: SETUP_AT })
    expect(linkedAnswers(QUERY.market.id)).toBe(6)

    const after = await workspace()
    expect(rowOf(after.tracked, QUERY.market.id)).toMatchObject({
      queryId: QUERY.market.id, queryText: QUERY.market.text, normalizedText: QUERY.market.text,
      provenance: FROZEN, state: 'awaiting-sweep', lastMeasuredAt: LAST_SWEEP,
      assignments: [], focus: { kind: 'not-asked' }, queryClasses: [],
    })
    expect(after.tracked).toHaveLength(before.tracked.length)
    expect(after.summary).toMatchObject({ asked: 2, notAsked: 2 })
    expect(after.limits?.queries).toMatchObject({ current: 2, next: 2 })
    // Publishing asked no engine anything.
    expect(db.select().from(runs).all()).toHaveLength(2)
  })

  it('continues under the same id when the same text is added again: measured, with its marks and its Source', async () => {
    seedSweptPortfolio()
    const marksBefore = (await results()).rows.find(row => row.queryId === QUERY.market.id)
    expect(marksBefore?.engines.map(engine => [engine.provider, engine.mentioned, engine.cited])).toEqual([
      ['claude', true, false], ['gemini', false, true], ['openai', false, false],
    ])
    const sourceBefore = rowOf((await workspace()).tracked, QUERY.market.id)?.provenance
    await publish({ removals: [{ queryId: QUERY.market.id }] })

    // No type is sent, so the server sets it where an operator had: the same type, measured alike.
    const { preview, committed } = await publish({ additions: [toMarket(QUERY.market.text)] })

    expect(preview.diff.added).toEqual([])
    expect(preview.diff.reused).toEqual([{ queryId: QUERY.market.id, queryText: QUERY.market.text, assignmentCount: 3 }])
    expect(preview.changes).toMatchObject([{
      queryId: QUERY.market.id, queryText: QUERY.market.text, change: 'reused',
      before: placement(), after: placement(MARKET_LOCATIONS, [MARKET]),
    }])
    expect(committed).toMatchObject({ committed: true, active: { revision: 3 } })

    const row = rowOf((await workspace()).tracked, QUERY.market.id)
    expect(row).toMatchObject({ state: 'tracked', lastMeasuredAt: LAST_SWEEP, provenance: FROZEN, focus: { kind: 'market', key: MARKET } })
    expect(row?.provenance).toEqual(sourceBefore)
    expect(row?.assignments.map(assignment => [assignment.targetKey, assignment.queryClass, assignment.classificationSource])).toEqual(
      MARKET_LOCATIONS.map(targetKey => [targetKey, 'non-brand', 'server']),
    )
    expect(db.select().from(queries).where(eq(queries.projectId, PROJECT_ID)).all().filter(query => query.query === QUERY.market.text))
      .toEqual([expect.objectContaining({ id: QUERY.market.id })])
    // The results read shows the marks of the sweep that asked it, with no row waiting for a sweep.
    const marksAfter = await results()
    expect(marksAfter.rows.find(found => found.queryId === QUERY.market.id)).toEqual(marksBefore)
    expect(marksAfter.pendingRows).toBe(0)
  })

  it('keeps one row and the same id through a Subject change, which removes and adds the same text in one change', async () => {
    seedSweptPortfolio()

    const { preview } = await publish({
      removals: [{ queryId: QUERY.market.id }],
      additions: [{ input: { source: 'manual', text: QUERY.market.text }, audience: { targetKeys: ['harbor-point'], marketKeys: [MARKET] } }],
    })

    expect(preview.diff).toMatchObject({ added: [], removed: [], reused: [{ queryId: QUERY.market.id, queryText: QUERY.market.text, assignmentCount: 1 }] })
    const tracked = (await workspace()).tracked.filter(row => row.normalizedText === QUERY.market.text)
    expect(tracked.map(row => [row.queryId, row.focus])).toEqual([[QUERY.market.id, { kind: 'property', key: 'harbor-point' }]])
    // The query never left the plan, so its row is untouched.
    expect(catalogRow(QUERY.market.id)).toMatchObject({ provenance: QUERY.market.marker })
    expect(linkedAnswers(QUERY.market.id)).toBe(6)
  })

  it('keeps the Source on the row when a stop scoped to every location ends the last pair', async () => {
    seedSweptPortfolio()

    await publish({ removals: [{ queryId: QUERY.market.id, audience: { targetKeys: MARKET_LOCATIONS } }] })

    expect(rowOf((await workspace()).tracked, QUERY.market.id)).toMatchObject({
      provenance: FROZEN, focus: { kind: 'not-asked' }, lastMeasuredAt: LAST_SWEEP,
    })
  })
})

describe('query tracking: removing a query that is asked nowhere', () => {
  it('deletes its row, publishes no revision, and writes one audit entry that names it', async () => {
    seedSweptPortfolio()

    const { preview, committed } = await publish({ removals: [{ queryId: QUERY.marina.id }] })

    expect(preview.diff.removed).toEqual([{ queryId: QUERY.marina.id, queryText: QUERY.marina.text, assignmentCount: 0 }])
    expect(rowOf(preview.tracked, QUERY.marina.id)).toBeUndefined()
    expect(preview.limits?.queries).toMatchObject({ current: 3, next: 3 })
    expect(committed).toMatchObject({ committed: true, active: { revision: 1 } })
    expect(catalogRow(QUERY.marina.id)).toBeUndefined()
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(1)
    expect((await workspace()).summary).toMatchObject({ asked: 3, notAsked: 0 })
    expect(trackingAudit()).toEqual([{
      action: 'query-tracking.updated', entityType: 'query', entityId: null,
      diff: {
        added: 0, removed: 1, reused: 0,
        queries: {
          added: [], stopped: [], removed: [QUERY.marina.text], changed: [],
          counts: { added: 0, stopped: 0, removed: 1, changed: 0 }, truncated: false,
        },
      },
    }])
  })

  it('deletes a stopped query on a second removal: its answers stay in their sweeps, linked to no query', async () => {
    seedSweptPortfolio()
    await publish({ removals: [{ queryId: QUERY.market.id }] })

    const { committed } = await publish({ removals: [{ queryId: QUERY.market.id }] })

    expect(committed).toMatchObject({ committed: true, active: { revision: 2 } })
    expect(catalogRow(QUERY.market.id)).toBeUndefined()
    expect(rowOf((await workspace()).tracked, QUERY.market.id)).toBeUndefined()
    expect(linkedAnswers(QUERY.market.id)).toBe(0)
    expect(db.select().from(querySnapshots).all().filter(answer => answer.queryId === null && answer.queryText === QUERY.market.text)).toHaveLength(6)
  })
})

describe('query tracking: the last measured date of a query that is asked nowhere', () => {
  it('is none without an answer from a finished whole-project sweep, and that sweep\'s finish time with one', async () => {
    seedPortfolio()
    const unasked = (text: string) => {
      const id = crypto.randomUUID()
      db.insert(queries).values({ id, projectId: PROJECT_ID, query: text, provenance: 'cli', createdAt: SETUP_AT }).run()
      return id
    }
    const probed = unasked('homes with a dock')
    const scoped = unasked('homes with a garden')
    const failed = unasked('homes with a pool')
    const swept = unasked('homes with a view')
    storeAnswer(probed, '2026-10-01T09:00:00.000Z', { trigger: RunTriggers.probe })
    storeAnswer(scoped, '2026-10-02T09:00:00.000Z', { measurementScope: { groups: [], targets: ['harbor-point'], queries: [], resolvedTargets: ['harbor-point'] } })
    storeAnswer(failed, '2026-10-03T09:00:00.000Z', { status: RunStatuses.failed })
    // Two sweeps asked it before the plan stopped asking it: the later one finished after it was created.
    storeAnswer(swept, '2026-09-20T09:00:00.000Z')
    storeAnswer(swept, '2026-10-04T09:00:00.000Z', { finishedAt: '2026-10-04T09:41:00.000Z', status: RunStatuses.partial })

    const tracked = (await workspace()).tracked
    const lastMeasured = (queryId: string) => {
      const row = rowOf(tracked, queryId)
      expect(row).toMatchObject({ focus: { kind: 'not-asked' }, state: 'awaiting-sweep' })
      return row?.lastMeasuredAt
    }

    expect(lastMeasured(QUERY.marina.id)).toBeNull()
    expect(lastMeasured(probed)).toBeNull()
    expect(lastMeasured(scoped)).toBeNull()
    expect(lastMeasured(failed)).toBeNull()
    expect(lastMeasured(swept)).toBe('2026-10-04T09:41:00.000Z')
  })
})

describe('query tracking: an edited wording', () => {
  it('keeps the old wording on the list, not asked, when a stored answer links to it', async () => {
    seedSweptPortfolio()
    const reworded = 'top rated homes in lakeshore'

    const { preview } = await publish({ edits: [{ queryId: QUERY.market.id, text: reworded }] })

    expect(preview.diff.removed).toEqual([{ queryId: QUERY.market.id, queryText: QUERY.market.text, assignmentCount: 3 }])
    expect(preview.diff.added).toEqual([{ queryId: expect.any(String), queryText: reworded, assignmentCount: 3 }])
    const tracked = (await workspace()).tracked
    expect(rowOf(tracked, QUERY.market.id)).toMatchObject({
      queryText: QUERY.market.text, focus: { kind: 'not-asked' }, assignments: [], lastMeasuredAt: LAST_SWEEP, provenance: FROZEN,
    })
    expect(rowOf(tracked, preview.diff.added[0]!.queryId)).toMatchObject({
      queryText: reworded, focus: { kind: 'market', key: MARKET }, state: 'awaiting-sweep', lastMeasuredAt: null,
    })
    expect(linkedAnswers(QUERY.market.id)).toBe(6)
  })

  it('deletes the old wording when no stored answer links to it', async () => {
    seedSweptPortfolio()
    const first = 'homes with a rooftop terrace in lakeshore'
    const { preview: added } = await publish({ additions: [toMarket(first)] })
    const firstId = added.diff.added[0]!.queryId
    expect(catalogRow(firstId)).toMatchObject({ query: first })

    const { preview } = await publish({ edits: [{ queryId: firstId, text: 'homes with a roof deck in lakeshore' }] })

    expect(preview.diff.removed).toEqual([{ queryId: firstId, queryText: first, assignmentCount: 3 }])
    expect(rowOf(preview.tracked, firstId)).toBeUndefined()
    expect(catalogRow(firstId)).toBeUndefined()
    expect(rowOf((await workspace()).tracked, firstId)).toBeUndefined()
  })
})

describe('query tracking: adding a wording that matches a query already on the list', () => {
  it('takes the typed wording when the match is asked nowhere, under the same id', async () => {
    seedSweptPortfolio()
    const stored = db.select().from(queries).where(eq(queries.id, QUERY.marina.id)).get()!
    const typed = 'Homes Near The Marina'

    const { preview } = await publish({ additions: [toMarket(typed)] })

    expect(preview.diff.added).toEqual([])
    expect(preview.diff.reused).toEqual([{ queryId: QUERY.marina.id, queryText: typed, assignmentCount: 3 }])
    expect(rowOf(preview.tracked, QUERY.marina.id)).toMatchObject({ queryText: typed, focus: { kind: 'market', key: MARKET } })
    expect(catalogRow(QUERY.marina.id)).toEqual({ ...stored, query: typed })
    expect(rowOf((await workspace()).tracked, QUERY.marina.id)).toMatchObject({ queryText: typed, normalizedText: typed.toLowerCase() })
    expect(activePlan().plan.executionNodes.filter(node => node.queryId === QUERY.marina.id).map(node => node.queryText)).toEqual([typed])
  })

  it('keeps the stored wording when the match is asked, since that is the wording the sweeps measured', async () => {
    seedSweptPortfolio()
    const stored = catalogRow(QUERY.market.id)

    // Asked for Pier House too, which is in no market, so the change is a real one.
    const { preview } = await publish({
      additions: [{
        input: { source: 'manual', text: 'Best Homes In Lakeshore' }, audience: { targetKeys: ['pier-house'] },
        contexts: [{ providers: [...ENGINES], models: MODELS, location: 'riverside' }],
      }],
    })

    expect(preview.diff.reused).toEqual([{ queryId: QUERY.market.id, queryText: QUERY.market.text, assignmentCount: 4 }])
    expect(rowOf(preview.tracked, QUERY.market.id)).toMatchObject({ queryText: QUERY.market.text })
    expect(catalogRow(QUERY.market.id)).toEqual(stored)
    expect(activePlan().plan.executionNodes.filter(node => node.queryId === QUERY.market.id).map(node => node.queryText)).toEqual([QUERY.market.text])
  })

  it('leaves the stored wording when another row already holds the typed text', async () => {
    seedPortfolio()
    // Two rows that differ only in case, as an older import could leave them. Neither is asked.
    const lower = { id: '10000000-0000-4000-8000-000000000001', text: 'best lofts in harbor point' }
    const titled = { id: '90000000-0000-4000-8000-000000000009', text: 'Best Lofts In Harbor Point' }
    db.insert(queries).values([lower, titled].map(row => ({ id: row.id, projectId: PROJECT_ID, query: row.text, provenance: 'cli', createdAt: SETUP_AT }))).run()

    const { preview, committed } = await publish({ additions: [toMarket(titled.text)] })

    expect(committed.committed).toBe(true)
    expect(preview.diff.reused).toEqual([{ queryId: lower.id, queryText: lower.text, assignmentCount: 3 }])
    expect(catalogRow(lower.id)).toMatchObject({ query: lower.text })
    expect(catalogRow(titled.id)).toMatchObject({ query: titled.text })
  })
})

describe('query tracking: what a publish writes to the audit log', () => {
  it('names the stopped query on the published entry, beside the counts it always held', async () => {
    seedSweptPortfolio()

    await publish({ removals: [{ queryId: QUERY.market.id }] })

    expect(trackingAudit()).toEqual([{
      action: 'query-tracking.published', entityType: 'measurement-plan', entityId: '2',
      diff: {
        previousRevision: 1, compiledChecksum: activePlan().plan.compiledChecksum,
        added: 0, removed: 1, reused: 0,
        queries: {
          added: [], stopped: [QUERY.market.text], removed: [], changed: [],
          counts: { added: 0, stopped: 1, removed: 0, changed: 0 }, truncated: false,
        },
      },
    }])
  })

  it('files a query tracked again under added, a type change under changed, and a deleted wording under removed', async () => {
    seedSweptPortfolio()
    const fresh = 'homes with a rooftop terrace in lakeshore'
    const { preview: added } = await publish({ additions: [toMarket(fresh)] })
    await publish({ removals: [{ queryId: QUERY.market.id }] })

    await publish({
      // `fresh` was never answered, so its old wording is deleted with the edit.
      edits: [{ queryId: added.diff.added[0]!.queryId, text: 'homes with a roof deck in lakeshore' }, { queryId: QUERY.harbor.id, queryClass: 'non-brand' }],
      additions: [toMarket(QUERY.market.text), toMarket('homes with a gym in lakeshore')],
    })

    expect(trackingAudit().find(entry => entry.entityId === '4')).toMatchObject({
      action: 'query-tracking.published',
      diff: {
        previousRevision: 3, added: 2, removed: 1, reused: 2,
        queries: {
          added: [QUERY.market.text, 'homes with a gym in lakeshore', 'homes with a roof deck in lakeshore'],
          stopped: [], removed: [fresh], changed: [QUERY.harbor.text],
          counts: { added: 3, stopped: 0, removed: 1, changed: 1 }, truncated: false,
        },
      },
    })
  })

  it('does not audit unchanged reuse as a change beside a new query', async () => {
    seedSweptPortfolio()
    const fresh = 'homes with a rooftop terrace in lakeshore'
    const { preview } = await publish({ additions: [toMarket(fresh), toMarket(QUERY.market.text)] })
    expect(preview.changes?.find(change => change.queryId === QUERY.market.id)).toMatchObject({ altered: false })
    expect(trackingAudit()[0]!.diff.queries).toMatchObject({
      added: [fresh], changed: [],
      counts: { added: 1, stopped: 0, removed: 0, changed: 0 },
    })
  })

  it('lists at most 50 texts of a kind, keeps the exact count, and says the list was cut', async () => {
    seedSweptPortfolio()
    const texts = Array.from({ length: 51 }, (_, index) => `homes with feature ${String(index).padStart(2, '0')} in lakeshore`)

    await publish({ additions: texts.map(text => toMarket(text)) })

    const { diff } = trackingAudit()[0]!
    expect(diff).toMatchObject({ added: 51, removed: 0, reused: 0 })
    expect(diff.queries).toEqual({
      added: texts.slice(0, 50), stopped: [], removed: [], changed: [],
      counts: { added: 51, stopped: 0, removed: 0, changed: 0 }, truncated: true,
    })
  })

  it('lists the texts on a simple project\'s entry too, where a removal deletes the query', async () => {
    db.insert(projects).values({
      id: 'project-simple', name: 'simple-site', displayName: 'Northbridge', canonicalDomain: 'northbridge.example',
      ownedDomains: [], aliases: [], country: 'US', language: 'en', providers: ['openai'], providerModels: { openai: 'gpt-test' },
      locations: [], defaultLocation: null, createdAt: SETUP_AT, updatedAt: SETUP_AT,
    }).run()
    const kept = { id: crypto.randomUUID(), text: 'best home builders' }
    const dropped = { id: crypto.randomUUID(), text: 'home builders near me' }
    db.insert(queries).values([kept, dropped].map(row => ({ id: row.id, projectId: 'project-simple', query: row.text, provenance: 'cli', createdAt: SETUP_AT }))).run()

    await publish({
      removals: [{ queryId: dropped.id }],
      // The second line names a query already on the list and changes nothing about it.
      additions: [{ input: { source: 'manual', text: 'custom home builders' } }, { input: { source: 'manual', text: kept.text } }],
    }, 'simple-site')

    expect(trackingAudit('project-simple')).toEqual([{
      action: 'query-tracking.updated', entityType: 'query', entityId: null,
      diff: {
        added: 1, removed: 1, reused: 1,
        queries: {
          added: ['custom home builders'], stopped: [], removed: [dropped.text], changed: [],
          counts: { added: 1, stopped: 0, removed: 1, changed: 0 }, truncated: false,
        },
      },
    }])
  })
})

describe('query tracking: a stopped query through export and apply', () => {
  it('keeps its row, id and answers when the exported project is applied again, and loses the row when the spec leaves it out', async () => {
    seedSweptPortfolio()
    await publish({ removals: [{ queryId: QUERY.market.id }] })
    const stopped = catalogRow(QUERY.market.id)

    const exported = await request('GET', `/projects/${PROJECT}/export`)
    expect(exported.statusCode, exported.body).toBe(200)
    const document = exported.json() as { spec: { queries: string[] } }
    expect(document.spec.queries).toContain(QUERY.market.text)
    const applied = await request('POST', '/apply', document)
    expect(applied.statusCode, applied.body).toBe(200)

    expect(catalogRow(QUERY.market.id)).toEqual(stopped)
    expect(linkedAnswers(QUERY.market.id)).toBe(6)
    expect(rowOf((await workspace()).tracked, QUERY.market.id)).toMatchObject({ focus: { kind: 'not-asked' }, lastMeasuredAt: LAST_SWEEP, provenance: FROZEN })

    // A declarative spec without the query removes it, as it removes any query that is asked nowhere.
    const without = { ...document, spec: { ...document.spec, queries: document.spec.queries.filter(text => text !== QUERY.market.text) } }
    const reapplied = await request('POST', '/apply', without)
    expect(reapplied.statusCode, reapplied.body).toBe(200)
    expect(catalogRow(QUERY.market.id)).toBeUndefined()
    expect(catalogRow(QUERY.pets.id)).toBeDefined()
  })
})
