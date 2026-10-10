import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildMeasurementRunManifestV1,
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  visibilityCompareDtoSchema,
  type MeasurementPlanV2,
  type VisibilityCompareDto,
} from '@ainyc/canonry-contracts'
import {
  competitors,
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

/**
 * Month-over-month after a tracking publish, pinned as the code behaves today.
 *
 * The frozen frame pairs an answer by a key that holds the plan it ran with.
 * A tracking publish that changes what is asked starts a new plan, so every
 * pairing of the month before and the month after has a different key, the
 * untouched queries included. The project frame pairs by query and engine
 * alone and keeps them.
 *
 * If a later change pairs on the pairing itself, the second test below is the
 * one that must change with it.
 */

const NOW = '2026-08-01T00:00:00.000Z'
const AUGUST = '2026-08-10T12:00:00.000Z'
const SEPTEMBER = '2026-09-10T12:00:00.000Z'
const PROJECT = 'northbridge'
const PROJECT_ID = 'project-northbridge'
const ENGINES = ['gemini', 'openai'] as const
const MODELS = { gemini: 'gemini-test', openai: 'gpt-test' }
const RIVERSIDE = { label: 'riverside', city: 'Riverside', region: 'EX', country: 'US' }
/** Every answer names the project, both locations and the tracked competitor, and cites the project and that competitor. */
const ANSWER = 'Northbridge runs Harbor Point and Cedar Court. Rival is nearby.'
const SOURCES = ['https://northbridge.example/harbor/floor-plans', 'https://rival.example/homes']

let directory: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

type Pairing = { queryId: string; targetKey: string; queryClass: 'branded' | 'non-brand'; market?: string }
const TEXTS: Readonly<Record<string, string>> = {
  'q-market': 'best homes in uptown',
  'q-harbor': 'Harbor Point reviews',
  'q-parking': 'homes with covered parking',
}
/**
 * - `q-market`: Uptown's Non-brand query, asked once for Harbor Point and Cedar Court. Never touched.
 * - `q-harbor`: Harbor Point's Branded query. Never touched.
 * - `q-parking`: a hand-picked Non-brand query for Cedar Court. The one that is stopped.
 */
const PAIRINGS: readonly Pairing[] = [
  { queryId: 'q-market', targetKey: 'harbor', queryClass: 'non-brand', market: 'uptown' },
  { queryId: 'q-market', targetKey: 'cedar', queryClass: 'non-brand', market: 'uptown' },
  { queryId: 'q-harbor', targetKey: 'harbor', queryClass: 'branded' },
  { queryId: 'q-parking', targetKey: 'cedar', queryClass: 'non-brand' },
]

function firstPlan(): MeasurementPlanV2 {
  const edge = (pairing: Pairing) => ({ executionNodeKey: `n-${pairing.queryId}`, targetKey: pairing.targetKey, queryId: pairing.queryId })
  const provisional = measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'northbridge.example', ownedHosts: ['northbridge.example'], names: ['Northbridge'] } },
    targets: [['harbor', 'Harbor Point'], ['cedar', 'Cedar Court']].map(([stableKey, label]) => ({
      stableKey, label, aliases: [label],
      urlMatchers: [{ kind: 'prefix', host: 'northbridge.example', pathPrefix: `/${stableKey}`, pathCase: 'insensitive' }],
      mentionNotApplicable: false, discoveryIdentity: null,
    })),
    groups: [{ stableKey: 'east', label: 'East', targetKeys: ['harbor', 'cedar'], competitors: [] }],
    querySnapshots: Object.entries(TEXTS).map(([queryId, queryText]) => ({
      queryId, queryText, provenance: { source: 'manual', sourceId: null, capturedAt: NOW },
    })),
    assignments: PAIRINGS.map(pairing => ({ ...edge(pairing), queryClass: pairing.queryClass, classificationSource: 'server' })),
    executionNodes: Object.entries(TEXTS).map(([queryId, queryText]) => ({
      stableKey: `n-${queryId}`, queryId, queryText,
      context: { providers: [...ENGINES], models: MODELS, location: RIVERSIDE }, expectedSnapshots: ENGINES.length,
    })),
    usageEdges: PAIRINGS.map(edge),
    reportingScopes: [{ stableKey: 'uptown', label: 'Uptown', kind: 'market', usageEdges: PAIRINGS.filter(pairing => pairing.market === 'uptown').map(edge) }],
    compiledChecksum: '0'.repeat(64),
  })
  const compiledChecksum = crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(provisional)).digest('hex')
  return measurementPlanV2Schema.parse({ ...provisional, compiledChecksum })
}

function activePlan(): { versionId: string; revision: number; plan: MeasurementPlanV2; comparableToVersionId: string | null } {
  const pointer = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, PROJECT_ID)).get()!
  const version = db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, pointer.activeVersionId)).get()!
  return {
    versionId: version.id, revision: version.revision, comparableToVersionId: version.comparableToVersionId,
    plan: measurementPlanV2Schema.parse(JSON.parse(version.canonicalJson)),
  }
}

/** One full sweep of the active plan, as the queue freezes it: every engine answers every query. */
function seedSweep(createdAt: string): void {
  const { versionId, plan } = activePlan()
  const id = crypto.randomUUID()
  db.insert(runs).values({
    id, projectId: PROJECT_ID, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
    measurementPlanVersionId: versionId, finishedAt: createdAt, createdAt,
    measurementManifest: buildMeasurementRunManifestV1({
      expectedSlots: plan.executionNodes.flatMap(node => node.context.providers.map(provider => ({
        executionId: node.stableKey, queryText: node.queryText, provider, context: node.context.location,
        requestedModel: node.context.models[provider]!,
      }))),
    }),
  }).run()
  for (const node of plan.executionNodes) {
    for (const provider of node.context.providers) {
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(), runId: id, queryId: node.queryId, queryText: node.queryText, provider,
        model: node.context.models[provider]!, citationState: 'cited', answerMentioned: true, answerText: ANSWER,
        citedDomains: ['northbridge.example', 'rival.example'], citedUrls: SOURCES, captureStatus: 'complete',
        competitorOverlap: [], recommendedCompetitors: [],
        location: RIVERSIDE.label, measurementExecutionId: node.stableKey,
        requestedContext: RIVERSIDE, supportedContext: { status: 'applied', resolved: RIVERSIDE },
        createdAt,
      }).run()
    }
  }
}

function request(method: 'GET' | 'POST', suffix: string, payload?: unknown) {
  return app.inject({ method, url: `/api/v1/projects/${PROJECT}${suffix}`, ...(payload === undefined ? {} : { payload }) })
}

/** Stops `q-parking` everywhere through the reviewed preview and commit. No sweep follows. */
async function stopOneQuery(): Promise<void> {
  const workspace = (await request('GET', '/query-tracking')).json()
  const mutation = { expectedWorkspaceVersion: workspace.workspaceVersion, additions: [], removals: [{ queryId: 'q-parking' }] }
  const preview = await request('POST', '/query-tracking/preview', mutation)
  expect(preview.statusCode, preview.body).toBe(200)
  // The stop touches one query and no market.
  expect(preview.json().changes.map((change: { queryId: string; change: string }) => [change.queryId, change.change])).toEqual([['q-parking', 'removed']])
  expect(preview.json().marketChanges).toEqual([])
  const commit = await request('POST', '/query-tracking/commit', { ...mutation, previewToken: preview.json().previewToken, reviewedAt: preview.json().reviewedAt })
  expect(commit.json(), commit.body).toMatchObject({ committed: true, active: { revision: 2 } })
}

async function compare(selection = ''): Promise<VisibilityCompareDto> {
  const response = await request('GET', `/visibility-compare?from=2026-08&to=2026-09${selection}`)
  expect(response.statusCode, response.body).toBe(200)
  return visibilityCompareDtoSchema.parse(response.json())
}

/** `numerator/denominator` for both months of one metric. */
function counts(dto: VisibilityCompareDto, key: string): { from: string; to: string; verdict: string } {
  const metric = dto.metrics.find(candidate => candidate.key === key)
  if (!metric) throw new Error(`No ${key} metric`)
  return {
    from: `${metric.from.numerator}/${metric.from.denominator}`,
    to: `${metric.to.numerator}/${metric.to.denominator}`,
    verdict: metric.verdict,
  }
}

const PROJECT_METRICS = ['mention-share-of-voice', 'cited-share-of-voice', 'mention-rate', 'cited-rate'] as const
const TYPE_METRICS = ['mention-rate-branded', 'cited-rate-branded', 'mention-rate-non-brand', 'cited-rate-non-brand'] as const
const RATE_METRICS = ['mention-rate', 'cited-rate', ...TYPE_METRICS] as const
/** The places the two untouched queries are read in. Uptown holds the untouched market query and nothing else. */
const PLACES = {
  'Harbor Point': '&scope=property&scopeKey=harbor',
  'East group': '&scope=group&scopeKey=east',
  'Uptown market': '&scope=market&scopeKey=uptown',
} as const
const PAIRED = { status: 'comparable', comparedProviders: ['gemini', 'openai'] }
const same = (count: string) => ({ from: count, to: count, verdict: 'within-noise' })
const EMPTY = { from: '0/0', to: '0/0', verdict: 'insufficient-data' }

function metricsOf(dto: VisibilityCompareDto, keys: readonly string[]) {
  return Object.fromEntries(keys.map(key => [key, counts(dto, key)]))
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-compare-tracking-publish-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: PROJECT_ID, name: PROJECT, displayName: 'Northbridge', canonicalDomain: 'northbridge.example',
    ownedDomains: [], aliases: [], country: 'US', language: 'en', providers: [...ENGINES], providerModels: MODELS,
    locations: [RIVERSIDE], defaultLocation: 'riverside', createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(competitors).values({ id: 'rival', projectId: PROJECT_ID, domain: 'rival.example', createdAt: NOW }).run()
  const plan = firstPlan()
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.insert(measurementPlanVersions).values({
    id: 'plan-v1', projectId: PROJECT_ID, revision: 1, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, comparableToVersionId: null, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId: PROJECT_ID, activeVersionId: 'plan-v1', createdAt: NOW, updatedAt: NOW }).run()
  db.insert(queries).values(plan.querySnapshots.map(row => ({ id: row.queryId, projectId: PROJECT_ID, query: row.queryText, createdAt: NOW }))).run()
  app = Fastify()
  await app.register(apiRoutes, { db, skipAuth: true, getRunnableProviderNames: () => [...ENGINES] })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  db.$client.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('monthly comparison across a tracking publish', () => {
  it('pairs every query by type and by place when no tracking publish separates the two sweeps', async () => {
    seedSweep(AUGUST)
    seedSweep(SEPTEMBER)

    // Three queries, two engines: six answers a month, each naming and citing the project and the competitor once.
    const project = await compare()
    expect(project.basket).toMatchObject({ queryCount: 3, excludedFromOnly: 0, excludedToOnly: 0 })
    expect(metricsOf(project, PROJECT_METRICS)).toEqual({
      'mention-share-of-voice': same('6/12'), 'cited-share-of-voice': same('6/12'), 'mention-rate': same('6/6'), 'cited-rate': same('6/6'),
    })
    // Type: the Branded query has two answers and the two Non-brand queries four. Nothing cites Cedar Court's own page.
    expect(project.classComparison).toMatchObject({ basket: { queryCount: 3, excludedFromOnly: 0, excludedToOnly: 0 }, continuity: PAIRED })
    expect(metricsOf(project, TYPE_METRICS)).toEqual({
      'mention-rate-branded': same('2/2'), 'cited-rate-branded': same('2/2'), 'mention-rate-non-brand': same('4/4'), 'cited-rate-non-brand': same('2/4'),
    })

    // Place: each one compares the queries asked there.
    const harbor = await compare(PLACES['Harbor Point'])
    expect(harbor).toMatchObject({ basket: { queryCount: 2 }, continuity: PAIRED })
    expect(metricsOf(harbor, RATE_METRICS)).toEqual({
      'mention-rate': same('4/4'), 'cited-rate': same('4/4'),
      'mention-rate-branded': same('2/2'), 'cited-rate-branded': same('2/2'), 'mention-rate-non-brand': same('2/2'), 'cited-rate-non-brand': same('2/2'),
    })
    const east = await compare(PLACES['East group'])
    expect(east).toMatchObject({ basket: { queryCount: 3 }, continuity: PAIRED })
    expect(metricsOf(east, RATE_METRICS)).toEqual({
      'mention-rate': same('6/6'), 'cited-rate': same('4/6'),
      'mention-rate-branded': same('2/2'), 'cited-rate-branded': same('2/2'), 'mention-rate-non-brand': same('4/4'), 'cited-rate-non-brand': same('2/4'),
    })
    const uptown = await compare(PLACES['Uptown market'])
    expect(uptown).toMatchObject({ basket: { queryCount: 1 }, continuity: PAIRED })
    expect(metricsOf(uptown, RATE_METRICS)).toEqual({
      'mention-rate': same('2/2'), 'cited-rate': same('2/2'),
      'mention-rate-branded': EMPTY, 'cited-rate-branded': EMPTY, 'mention-rate-non-brand': same('2/2'), 'cited-rate-non-brand': same('2/2'),
    })
  })

  it('unpairs the untouched queries by type and by place after a one-query stop, and keeps them in the four project metrics', async () => {
    seedSweep(AUGUST)
    await stopOneQuery()
    // The stop changed what is asked, so the new plan is not a display-only successor of the first.
    expect(activePlan()).toMatchObject({ revision: 2, comparableToVersionId: null })
    expect(activePlan().plan.assignments.map(assignment => assignment.queryId).sort()).toEqual(['q-harbor', 'q-market', 'q-market'])
    seedSweep(SEPTEMBER)

    const project = await compare()
    expect([project.from.runCount, project.to.runCount]).toEqual([1, 1])

    // The four project metrics pair by query and engine: both untouched queries, two engines, four answers a month.
    expect(project.basket).toEqual({ queryCount: 2, excludedFromOnly: 0, excludedToOnly: 0, providers: ['gemini', 'openai'], excludedProviders: [] })
    expect(project.continuity).toMatchObject(PAIRED)
    expect(project.queriesMentioned).toEqual({ from: { count: 2, of: 2 }, to: { count: 2, of: 2 } })
    expect(metricsOf(project, PROJECT_METRICS)).toEqual({
      'mention-share-of-voice': same('4/8'), 'cited-share-of-voice': same('4/8'), 'mention-rate': same('4/4'), 'cited-rate': same('4/4'),
    })

    // Type: both months were measured, yet no query is paired, the untouched ones included.
    expect(project.classComparison).toMatchObject({
      from: { runCount: 1 }, to: { runCount: 1 },
      basket: { queryCount: 0, excludedFromOnly: 3, excludedToOnly: 2, providers: [] },
      continuity: { status: 'insufficient-data', comparedProviders: [] },
    })
    expect(metricsOf(project, TYPE_METRICS)).toEqual(Object.fromEntries(TYPE_METRICS.map(key => [key, EMPTY])))

    // Place: a location, a group or a market reads the frozen frame alone, so every figure there is empty,
    // in the market that holds only the untouched query as well.
    for (const [place, selection] of Object.entries(PLACES)) {
      const scoped = await compare(selection)
      expect([scoped.from.runCount, scoped.to.runCount], place).toEqual([1, 1])
      expect(scoped.basket, place).toMatchObject({ queryCount: 0, providers: [] })
      expect(scoped.continuity, place).toMatchObject({ status: 'insufficient-data', comparedProviders: [] })
      expect(metricsOf(scoped, [...PROJECT_METRICS, ...TYPE_METRICS]), place).toEqual(
        Object.fromEntries([...PROJECT_METRICS, ...TYPE_METRICS].map(key => [key, EMPTY])),
      )
    }
  })
})
