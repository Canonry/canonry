import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  queryTrackingCommitResponseSchema,
  queryTrackingPreviewResponseSchema,
  queryTrackingWorkspaceResponseSchema,
  type MeasurementPlanV2,
  type QueryTrackingPreviewResponse,
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

/**
 * The web changes a query's Subject, or moves it to another location, with one
 * mutation: a full removal and a manual addition of the same text. These cases
 * prove what that mutation keeps and what it reports.
 */

const NOW = '2026-10-09T00:00:00.000Z'
const PROJECT = 'northwind'
const PROJECT_ID = 'project-northwind'
const ROOT_KEY = 'cnry_tracking_subject_change_root'
const ALPHA = { label: 'alpha', city: 'Alpha', region: 'AA', country: 'US' }
const CONTEXT = { providers: ['openai'], models: { openai: 'gpt-test' }, location: ALPHA }
/** The one search location and engine, as an addition names it for a location in no market. */
const CONTEXT_INPUT = { providers: ['openai'], models: { openai: 'gpt-test' }, location: 'alpha' }
const RESEARCH = { source: 'research' as const, sourceId: 'research-query-7', capturedAt: '2026-08-01T00:00:00.000Z' }
const PATTERN = {
  source: 'template' as const, sourceId: 'tpl-reviews@2026-08-02T00:00:00.000Z', capturedAt: '2026-08-02T00:00:00.000Z',
  template: {
    templateId: 'tpl-reviews', templateVersion: '2026-08-02T00:00:00.000Z', template: '{property} reviews',
    bindings: { property: 'Harbor Point' }, output: 'Harbor Point reviews',
  },
}
const MANUAL = { source: 'manual' as const, sourceId: null, capturedAt: NOW }
const UPTOWN_TEXT = 'best apartments uptown'
const HARBOR_TEXT = 'Harbor Point reviews'
const PIER_TEXT = 'apartments near the pier'

let directory: string
let db: DatabaseClient
let app: FastifyInstance

type Pairing = {
  queryId: string
  targetKey: string
  queryClass: 'branded' | 'non-brand'
  classificationSource: 'server' | 'operator'
  market: string
}

/**
 * Five locations:
 * - Uptown holds Harbor, River and Summit. Two market queries cover all three; `q-harbor` is Harbor's own,
 *   set to Non-brand by an operator although its text names Harbor.
 * - Solo holds Pier alone through its one query, `q-pier`.
 * - Lone Pine is in no market and is asked nothing.
 */
function seedPortfolio(): void {
  const queryRows = [
    { queryId: 'q-uptown', queryText: UPTOWN_TEXT, provenance: RESEARCH },
    { queryId: 'q-uptown-b', queryText: 'uptown apartments with parking', provenance: MANUAL },
    { queryId: 'q-harbor', queryText: HARBOR_TEXT, provenance: PATTERN },
    { queryId: 'q-pier', queryText: PIER_TEXT, provenance: MANUAL },
  ]
  const market = (queryId: string): Pairing[] => ['harbor', 'river', 'summit'].map(targetKey => ({
    queryId, targetKey, queryClass: 'non-brand', classificationSource: 'server', market: 'uptown',
  }))
  const pairings: Pairing[] = [
    ...market('q-uptown'),
    ...market('q-uptown-b'),
    { queryId: 'q-harbor', targetKey: 'harbor', queryClass: 'non-brand', classificationSource: 'operator', market: 'uptown' },
    { queryId: 'q-pier', targetKey: 'pier', queryClass: 'non-brand', classificationSource: 'server', market: 'solo' },
  ]
  const edge = (pairing: Pairing) => ({ executionNodeKey: `n-${pairing.queryId}`, targetKey: pairing.targetKey, queryId: pairing.queryId })
  const provisional = measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'northwind.example', ownedHosts: ['northwind.example'], names: ['Northwind'] } },
    targets: [['harbor', 'Harbor Point'], ['river', 'River Point'], ['summit', 'Summit Lofts'], ['pier', 'Pier House'], ['lone', 'Lone Pine']]
      .map(([stableKey, label]) => ({
        stableKey, label, aliases: [label],
        urlMatchers: [{ kind: 'prefix', host: 'northwind.example', pathPrefix: `/${stableKey}`, pathCase: 'insensitive' }],
        mentionNotApplicable: false, discoveryIdentity: null,
      })),
    groups: [],
    querySnapshots: queryRows,
    assignments: pairings.map(pairing => ({ ...edge(pairing), queryClass: pairing.queryClass, classificationSource: pairing.classificationSource })),
    executionNodes: queryRows.map(row => ({
      stableKey: `n-${row.queryId}`, queryId: row.queryId, queryText: row.queryText, context: CONTEXT, expectedSnapshots: 1,
    })),
    usageEdges: pairings.map(edge),
    reportingScopes: [['solo', 'Solo'], ['uptown', 'Uptown']].map(([stableKey, label]) => ({
      stableKey, label, kind: 'market', usageEdges: pairings.filter(pairing => pairing.market === stableKey).map(edge),
    })),
    compiledChecksum: '0'.repeat(64),
  })
  const compiledChecksum = crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(provisional)).digest('hex')
  const plan = measurementPlanV2Schema.parse({ ...provisional, compiledChecksum })
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.insert(measurementPlanVersions).values({
    id: 'plan-v1', projectId: PROJECT_ID, revision: 1, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, comparableToVersionId: null, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId: PROJECT_ID, activeVersionId: 'plan-v1', createdAt: NOW, updatedAt: NOW }).run()
  db.insert(queries).values(queryRows.map(row => ({
    id: row.queryId, projectId: PROJECT_ID, query: row.queryText, provenance: null, createdAt: NOW,
  }))).run()
}

function activePlan(): { revision: number; plan: MeasurementPlanV2 } {
  const pointer = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, PROJECT_ID)).get()!
  const version = db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, pointer.activeVersionId)).get()!
  return { revision: version.revision, plan: measurementPlanV2Schema.parse(JSON.parse(version.canonicalJson)) }
}

function request(method: 'GET' | 'POST', suffix: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/api/v1/projects/${PROJECT}${suffix}`,
    headers: { authorization: `Bearer ${ROOT_KEY}` },
    ...(payload === undefined ? {} : { payload }),
  })
}

async function workspace() {
  const response = await request('GET', '/query-tracking')
  expect(response.statusCode, response.body).toBe(200)
  return queryTrackingWorkspaceResponseSchema.parse(response.json())
}

async function review(mutation: { additions?: unknown[]; removals?: unknown[]; edits?: unknown[] }) {
  const payload = {
    expectedWorkspaceVersion: (await workspace()).workspaceVersion,
    additions: mutation.additions ?? [], removals: mutation.removals ?? [],
    ...(mutation.edits ? { edits: mutation.edits } : {}),
  }
  const response = await request('POST', '/query-tracking/preview', payload)
  expect(response.statusCode, response.body).toBe(200)
  const preview = queryTrackingPreviewResponseSchema.parse(response.json())
  return { preview, commit: { ...payload, previewToken: preview.previewToken, reviewedAt: preview.reviewedAt } }
}

async function publish(commit: Record<string, unknown>) {
  const response = await request('POST', '/query-tracking/commit', commit)
  expect(response.statusCode, response.body).toBe(200)
  return queryTrackingCommitResponseSchema.parse(response.json())
}

/** One removal of the whole query plus one manual addition of its own text for the new Subject. */
function subjectChange(queryId: string, text: string, addition: Record<string, unknown>) {
  return review({ removals: [{ queryId }], additions: [{ input: { source: 'manual', text }, ...addition }] })
}

function row(preview: QueryTrackingPreviewResponse, queryId: string) {
  return preview.tracked.find(tracked => tracked.queryId === queryId)!
}

function classes(preview: QueryTrackingPreviewResponse, queryId: string) {
  return row(preview, queryId).assignments.map(assignment => [assignment.targetKey, assignment.queryClass, assignment.classificationSource])
}

function placement(targetKeys: string[], marketKeys: string[]) {
  return { targetKeys, marketKeys }
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-tracking-subject-change-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'root', keyHash: hashApiKey(ROOT_KEY), keyPrefix: ROOT_KEY.slice(0, 9),
    scopes: ['*'], projectId: null, createdAt: NOW,
  }).run()
  db.insert(projects).values({
    id: PROJECT_ID, name: PROJECT, displayName: 'Northwind', canonicalDomain: 'northwind.example',
    ownedDomains: [], aliases: [], country: 'US', language: 'en', providers: ['openai'], providerModels: { openai: 'gpt-test' },
    locations: [ALPHA], defaultLocation: 'alpha', createdAt: NOW, updatedAt: NOW,
  }).run()
  app = Fastify()
  app.register(apiRoutes, { db, getRunnableProviderNames: () => ['openai'] })
  await app.ready()
  seedPortfolio()
})

afterEach(async () => {
  await app.close()
  db.$client.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('query tracking: a Subject change is one removal plus one addition of the same text', () => {
  it('keeps the query id and Source, lists the query once as reused, and reports the old and new placement', async () => {
    const catalogRow = db.select().from(queries).where(eq(queries.id, 'q-uptown')).get()
    const { preview, commit } = await subjectChange('q-uptown', UPTOWN_TEXT, { audience: { targetKeys: ['harbor'], marketKeys: ['uptown'] } })

    expect(preview.diff.added).toEqual([])
    expect(preview.diff.removed).toEqual([])
    expect(preview.diff.reused).toEqual([{ queryId: 'q-uptown', queryText: UPTOWN_TEXT, assignmentCount: 1 }])
    expect(preview.changes).toEqual([{
      queryId: 'q-uptown', queryText: UPTOWN_TEXT, change: 'reused',
      before: placement(['harbor', 'river', 'summit'], ['uptown']),
      after: placement(['harbor'], ['uptown']),
    }])
    expect(row(preview, 'q-uptown')).toMatchObject({ provenance: RESEARCH, focus: { kind: 'property', key: 'harbor' } })
    // The other market query still asks River and Summit, so Uptown keeps its three locations.
    expect(preview.marketChanges).toEqual([])
    expect(preview.limits?.queries).toMatchObject({ current: 4, next: 4 })
    expect(preview.workload).toMatchObject({ existingProviderCalls: 4, nextSweepProviderCalls: 4 })

    expect(await publish(commit)).toMatchObject({ committed: true, active: { revision: 2 } })
    expect(db.select().from(queries).where(eq(queries.id, 'q-uptown')).get()).toEqual(catalogRow)
    expect(activePlan().plan.querySnapshots.find(snapshot => snapshot.queryId === 'q-uptown'))
      .toEqual({ queryId: 'q-uptown', queryText: UPTOWN_TEXT, provenance: RESEARCH })
    expect((await workspace()).tracked.find(tracked => tracked.queryId === 'q-uptown'))
      .toMatchObject({ provenance: RESEARCH, focus: { kind: 'property', key: 'harbor' }, state: 'awaiting-sweep' })
    expect(db.select().from(runs).all()).toEqual([])
  })

  it('classifies on the server when no type is sent, and keeps a sent type as the operator\'s', async () => {
    const toHarbor = (queryClass?: string) => subjectChange('q-uptown', UPTOWN_TEXT, {
      audience: { targetKeys: ['harbor'], marketKeys: ['uptown'] }, ...(queryClass ? { queryClass } : {}),
    })
    expect(classes((await toHarbor()).preview, 'q-uptown')).toEqual([['harbor', 'non-brand', 'server']])
    expect(classes((await toHarbor('branded')).preview, 'q-uptown')).toEqual([['harbor', 'branded', 'operator']])
    expect(classes((await toHarbor('non-brand')).preview, 'q-uptown')).toEqual([['harbor', 'non-brand', 'operator']])

    // `q-harbor` was set to Non-brand by an operator. Without a sent type that choice is not carried
    // over: the server classifies each location again, and the text names only Harbor.
    const toUptown = (queryClass?: string) => subjectChange('q-harbor', HARBOR_TEXT, {
      audience: { marketKeys: ['uptown'] }, ...(queryClass ? { queryClass } : {}),
    })
    const automatic = (await toUptown()).preview
    expect(classes(automatic, 'q-harbor')).toEqual([
      ['harbor', 'branded', 'server'], ['river', 'non-brand', 'server'], ['summit', 'non-brand', 'server'],
    ])
    expect(row(automatic, 'q-harbor')).toMatchObject({ queryClasses: ['branded', 'non-brand'], focus: { kind: 'market', key: 'uptown' }, provenance: PATTERN })
    const sent = (await toUptown('non-brand')).preview
    expect(classes(sent, 'q-harbor')).toEqual([
      ['harbor', 'non-brand', 'operator'], ['river', 'non-brand', 'operator'], ['summit', 'non-brand', 'operator'],
    ])
    expect(row(sent, 'q-harbor')).toMatchObject({ queryClasses: ['non-brand'], focus: { kind: 'market', key: 'uptown' } })
  })

  it('moves a location query to another location, to one in no market, and reports a market the move empties', async () => {
    const toRiver = (await subjectChange('q-harbor', HARBOR_TEXT, { audience: { targetKeys: ['river'], marketKeys: ['uptown'] } })).preview
    expect(toRiver.changes).toEqual([{
      queryId: 'q-harbor', queryText: HARBOR_TEXT, change: 'reused',
      before: placement(['harbor'], ['uptown']), after: placement(['river'], ['uptown']),
    }])
    expect(row(toRiver, 'q-harbor')).toMatchObject({ provenance: PATTERN, focus: { kind: 'property', key: 'river' } })
    expect(toRiver.marketChanges).toEqual([])

    // A location in no market has no market to take a search location from, so the addition names one.
    const toLone = (await subjectChange('q-harbor', HARBOR_TEXT, { audience: { targetKeys: ['lone'] }, contexts: [CONTEXT_INPUT] })).preview
    expect(toLone.changes).toEqual([{
      queryId: 'q-harbor', queryText: HARBOR_TEXT, change: 'reused',
      before: placement(['harbor'], ['uptown']), after: placement(['lone'], []),
    }])
    expect(row(toLone, 'q-harbor')).toMatchObject({ provenance: PATTERN, focus: { kind: 'property', key: 'lone' } })
    expect(toLone.marketChanges).toEqual([])

    // `q-pier` is the only query asked in Solo, so moving it away leaves that market with no location.
    const fromSolo = (await subjectChange('q-pier', PIER_TEXT, { audience: { targetKeys: ['harbor'], marketKeys: ['uptown'] } })).preview
    expect(row(fromSolo, 'q-pier').focus).toEqual({ kind: 'property', key: 'harbor' })
    expect(fromSolo.marketChanges).toEqual([{
      marketKey: 'solo', before: { targetKeys: ['pier'] }, after: { targetKeys: [] }, removedTargetKeys: ['pier'], emptied: true,
    }])
  })
})

describe('query tracking: a market of one location', () => {
  it('moves the Subject between the market and the location on a type change alone', async () => {
    expect((await workspace()).tracked.find(tracked => tracked.queryId === 'q-pier')?.focus).toEqual({ kind: 'market', key: 'solo' })

    const branded = await review({ edits: [{ queryId: 'q-pier', queryClass: 'branded' }] })
    expect(row(branded.preview, 'q-pier')).toMatchObject({ queryClasses: ['branded'], focus: { kind: 'property', key: 'pier' } })
    expect(branded.preview.marketChanges).toEqual([])
    expect((await publish(branded.commit)).committed).toBe(true)
    expect((await workspace()).tracked.find(tracked => tracked.queryId === 'q-pier')?.focus).toEqual({ kind: 'property', key: 'pier' })

    for (const queryClass of ['non-brand', null]) {
      const back = (await review({ edits: [{ queryId: 'q-pier', queryClass }] })).preview
      expect(row(back, 'q-pier'), String(queryClass)).toMatchObject({ queryClasses: ['non-brand'], focus: { kind: 'market', key: 'solo' } })
      expect(back.marketChanges).toEqual([])
    }
  })

  it('treats a removal and re-add of the same edges as a no-op, so a Subject change there publishes nothing', async () => {
    // Added through the API so its execution carries the key the server compiles, as a published plan's does.
    const text = 'apartments with a rooftop terrace'
    const added = await review({ additions: [{ input: { source: 'manual', text }, audience: { marketKeys: ['solo'] } }] })
    const queryId = added.preview.diff.added[0]!.queryId
    expect(await publish(added.commit)).toMatchObject({ committed: true, active: { revision: 2 } })
    const published = activePlan()

    for (const audience of [{ targetKeys: ['pier'], marketKeys: ['solo'] }, { marketKeys: ['solo'] }]) {
      const { preview, commit } = await subjectChange(queryId, text, { audience })
      expect(preview.diff.noOp, JSON.stringify(audience)).toBe(true)
      expect(preview.changes).toEqual([])
      expect(preview.marketChanges).toEqual([])
      expect(preview.workload).toMatchObject({ addedNodes: 0, removedNodes: 0, nextSweepProviderCalls: 5 })
      expect(row(preview, queryId).focus).toEqual({ kind: 'market', key: 'solo' })
      expect(await publish(commit)).toMatchObject({ committed: false, active: { revision: 2 } })
    }
    expect(activePlan()).toEqual(published)
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(2)
  })
})
