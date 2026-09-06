import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
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
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  createClient,
  measurementPlanVersions,
  measurementPlans,
  measurementQueryTemplates,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

const ROOT_KEY = 'cnry_query_tracking_edits_root'
const PROJECT = 'northwind'
const PROJECT_ID = 'project-northwind'
const NOW = '2026-09-05T00:00:00.000Z'
const OLD_TEXT = 'best apartments in northbridge'
const PROPERTY_TEXT = 'Northbridge apartments with a rooftop terrace'
const GLOBAL_TEXT = 'Northbridge apartment communities'
const MARKET_TEXT = 'Northbridge apartments near parks'
const DESTINATION_TEXT = 'Northbridge luxury apartments'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

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

async function preview(payload: Record<string, unknown>) {
  const response = await request('POST', '/query-tracking/preview', payload)
  expect(response.statusCode, response.body).toBe(200)
  return queryTrackingPreviewResponseSchema.parse(response.json())
}

async function publish(payload: Record<string, unknown>) {
  const response = await request('POST', '/query-tracking/commit', payload)
  expect(response.statusCode, response.body).toBe(200)
  return queryTrackingCommitResponseSchema.parse(response.json())
}

function withChecksum(plan: MeasurementPlanV2): MeasurementPlanV2 {
  const provisional = measurementPlanV2Schema.parse({ ...plan, compiledChecksum: '0'.repeat(64) })
  const compiledChecksum = crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(provisional)).digest('hex')
  return measurementPlanV2Schema.parse({ ...provisional, compiledChecksum })
}

function activePlan() {
  const pointer = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, PROJECT_ID)).get()!
  const version = db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, pointer.activeVersionId)).get()!
  return { pointer, version, plan: measurementPlanV2Schema.parse(JSON.parse(version.canonicalJson)) }
}

function rewriteActivePlan(mutate: (plan: MeasurementPlanV2) => void) {
  const { version, plan: draft } = activePlan()
  mutate(draft)
  const plan = withChecksum(draft)
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.update(measurementPlanVersions).set({
    canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'),
    compiledChecksum: plan.compiledChecksum,
  }).where(eq(measurementPlanVersions.id, version.id)).run()
  return plan
}

function seedTwoPropertiesTwoContextsTwoMarkets() {
  const planWithoutChecksum = {
    schemaVersion: 2 as const,
    identities: { projectBrand: { canonicalHost: 'northwind.example', ownedHosts: ['northwind.example'], names: ['Northwind'] } },
    targets: [
      {
        stableKey: 'harbor-point', label: 'Harbor Point', aliases: ['Harbor Point'],
        urlMatchers: [{ kind: 'prefix' as const, host: 'northwind.example', pathPrefix: '/harbor-point', pathCase: 'insensitive' as const }],
        mentionNotApplicable: false, discoveryIdentity: null,
      },
      {
        stableKey: 'river-point', label: 'River Point', aliases: ['River Point'],
        urlMatchers: [{ kind: 'prefix' as const, host: 'northwind.example', pathPrefix: '/river-point', pathCase: 'insensitive' as const }],
        mentionNotApplicable: false, discoveryIdentity: null,
      },
    ],
    groups: [
      { stableKey: 'northbridge', label: 'Northbridge', targetKeys: ['harbor-point'], competitors: [] },
      { stableKey: 'southbridge', label: 'Southbridge', targetKeys: ['river-point'], competitors: [] },
    ],
    querySnapshots: [{
      queryId: 'q-existing', queryText: OLD_TEXT,
      provenance: { source: 'manual' as const, sourceId: null, capturedAt: NOW },
    }],
    assignments: [
      { targetKey: 'harbor-point', queryId: 'q-existing', queryClass: 'non-brand' as const, classificationSource: 'server' as const, executionNodeKey: 'exec-alpha' },
      { targetKey: 'harbor-point', queryId: 'q-existing', queryClass: 'non-brand' as const, classificationSource: 'server' as const, executionNodeKey: 'exec-beta' },
      { targetKey: 'river-point', queryId: 'q-existing', queryClass: 'non-brand' as const, classificationSource: 'server' as const, executionNodeKey: 'exec-alpha' },
    ],
    executionNodes: [
      {
        stableKey: 'exec-alpha', queryId: 'q-existing', queryText: OLD_TEXT,
        context: { providers: ['openai'], models: { openai: 'gpt-test' }, location: { label: 'alpha', city: 'Alpha', region: 'AA', country: 'US' } },
        expectedSnapshots: 1,
      },
      {
        stableKey: 'exec-beta', queryId: 'q-existing', queryText: OLD_TEXT,
        context: { providers: ['gemini', 'openai'], models: { gemini: 'gemini-test', openai: 'gpt-test' }, location: { label: 'beta', city: 'Beta', region: 'BB', country: 'US' } },
        expectedSnapshots: 2,
      },
    ],
    usageEdges: [
      { executionNodeKey: 'exec-alpha', targetKey: 'harbor-point', queryId: 'q-existing' },
      { executionNodeKey: 'exec-beta', targetKey: 'harbor-point', queryId: 'q-existing' },
      { executionNodeKey: 'exec-alpha', targetKey: 'river-point', queryId: 'q-existing' },
    ],
    reportingScopes: [
      {
        stableKey: 'alpha-market', label: 'Alpha', kind: 'market' as const,
        usageEdges: [
          { executionNodeKey: 'exec-alpha', targetKey: 'harbor-point', queryId: 'q-existing' },
          { executionNodeKey: 'exec-alpha', targetKey: 'river-point', queryId: 'q-existing' },
        ],
      },
      {
        stableKey: 'beta-market', label: 'Beta', kind: 'market' as const,
        usageEdges: [{ executionNodeKey: 'exec-beta', targetKey: 'harbor-point', queryId: 'q-existing' }],
      },
    ],
    compiledChecksum: '0'.repeat(64),
  }
  const plan = withChecksum(measurementPlanV2Schema.parse(planWithoutChecksum))
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.insert(measurementPlanVersions).values({
    id: 'plan-v1', projectId: PROJECT_ID, revision: 1, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, comparableToVersionId: null, publishedBy: null, sourceDraftId: null, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId: PROJECT_ID, activeVersionId: 'plan-v1', createdAt: NOW, updatedAt: NOW }).run()
}

function insertHistoricalSnapshot() {
  const active = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, PROJECT_ID)).get()
  db.insert(runs).values({
    id: 'history', projectId: PROJECT_ID, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
    measurementPlanVersionId: active?.activeVersionId ?? null, finishedAt: NOW, createdAt: NOW,
  }).run()
  db.insert(querySnapshots).values({
    id: 'history-alpha', runId: 'history', queryId: 'q-existing', queryText: OLD_TEXT,
    provider: 'openai', model: 'gpt-test', citationState: 'not-cited', citedDomains: [], competitorOverlap: [], recommendedCompetitors: [],
    location: 'alpha', measurementExecutionId: 'exec-alpha',
    requestedContext: { label: 'alpha', city: 'Alpha', region: 'AA', country: 'US' },
    supportedContext: { status: 'applied', resolved: { label: 'alpha', city: 'Alpha', region: 'AA', country: 'US' } },
    createdAt: NOW,
  }).run()
}

function assignmentShapes(plan: MeasurementPlanV2, queryId: string) {
  const nodes = new Map(plan.executionNodes.map(node => [node.stableKey, node]))
  return plan.assignments
    .filter(assignment => assignment.queryId === queryId)
    .map(assignment => ({
      targetKey: assignment.targetKey,
      queryClass: assignment.queryClass,
      classificationSource: assignment.classificationSource,
      context: nodes.get(assignment.executionNodeKey)!.context,
      expectedSnapshots: nodes.get(assignment.executionNodeKey)!.expectedSnapshots,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function marketShapes(plan: MeasurementPlanV2, marketKey: string) {
  const nodes = new Map(plan.executionNodes.map(node => [node.stableKey, node]))
  return plan.reportingScopes!.find(scope => scope.stableKey === marketKey)!.usageEdges
    .map(edge => ({ targetKey: edge.targetKey, queryId: edge.queryId, context: nodes.get(edge.executionNodeKey)!.context }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function addSharedAlphaHarborEdgeToBeta() {
  rewriteActivePlan(plan => {
    plan.reportingScopes!.find(scope => scope.stableKey === 'beta-market')!.usageEdges.push({
      executionNodeKey: 'exec-alpha', targetKey: 'harbor-point', queryId: 'q-existing',
    })
  })
}

function addActiveDestinationAndStaleDuplicate() {
  rewriteActivePlan(plan => {
    const edge = { executionNodeKey: 'exec-destination-alpha', targetKey: 'harbor-point', queryId: 'q-bound-destination' }
    plan.querySnapshots.push({
      queryId: 'q-bound-destination', queryText: DESTINATION_TEXT,
      provenance: { source: 'manual', sourceId: null, capturedAt: NOW },
    })
    plan.executionNodes.push({
      stableKey: edge.executionNodeKey, queryId: edge.queryId, queryText: DESTINATION_TEXT,
      context: { providers: ['openai'], models: { openai: 'gpt-test' }, location: { label: 'alpha', city: 'Alpha', region: 'AA', country: 'US' } },
      expectedSnapshots: 1,
    })
    plan.assignments.push({ targetKey: edge.targetKey, queryId: edge.queryId, queryClass: 'non-brand', classificationSource: 'server', executionNodeKey: edge.executionNodeKey })
    plan.usageEdges.push(edge)
    plan.reportingScopes!.find(scope => scope.stableKey === 'alpha-market')!.usageEdges.push(edge)
  })
  db.insert(queries).values([
    { id: 'q-bound-destination', projectId: PROJECT_ID, query: DESTINATION_TEXT, provenance: null, createdAt: NOW },
    { id: 'q-stale-destination', projectId: PROJECT_ID, query: DESTINATION_TEXT.toUpperCase(), provenance: null, createdAt: NOW },
  ]).run()
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-query-tracking-edits-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'root', keyHash: hashApiKey(ROOT_KEY), keyPrefix: ROOT_KEY.slice(0, 9),
    scopes: ['*'], projectId: null, createdAt: NOW,
  }).run()
  db.insert(projects).values({
    id: PROJECT_ID, name: PROJECT, displayName: 'Northwind', canonicalDomain: 'northwind.example', ownedDomains: [], aliases: [],
    country: 'US', language: 'en', providers: ['gemini', 'openai'], providerModels: { gemini: 'gemini-test', openai: 'gpt-test' },
    locations: [
      { label: 'alpha', city: 'Alpha', region: 'AA', country: 'US' },
      { label: 'beta', city: 'Beta', region: 'BB', country: 'US' },
    ],
    defaultLocation: 'alpha', createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(queries).values({ id: 'q-existing', projectId: PROJECT_ID, query: OLD_TEXT, provenance: 'cli', createdAt: NOW }).run()
  app = Fastify()
  app.register(apiRoutes, {
    db,
    getRunnableProviderNames: () => ['gemini', 'openai'],
    providerSummary: [{ name: 'gemini', configured: true, model: 'gemini-test' }, { name: 'openai', configured: true, model: 'gpt-test' }],
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('query-tracking edits', () => {
  it('splits a Property text edit while retaining sibling history, contexts, and market memberships', async () => {
    seedTwoPropertiesTwoContextsTwoMarkets()
    insertHistoricalSnapshot()
    rewriteActivePlan(plan => {
      for (const assignment of plan.assignments.filter(row => row.targetKey === 'harbor-point')) {
        assignment.queryClass = 'branded'
        assignment.classificationSource = 'operator'
      }
    })
    const before = activePlan().plan
    const harborBefore = assignmentShapes(before, 'q-existing').filter(row => row.targetKey === 'harbor-point')
    const riverBefore = assignmentShapes(before, 'q-existing').filter(row => row.targetKey === 'river-point')
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'q-existing', audience: { targetKeys: ['harbor-point'] }, text: PROPERTY_TEXT }],
    }
    const review = await preview(mutation)
    const editedId = review.tracked.find(row => row.queryText === PROPERTY_TEXT)!.queryId
    expect(editedId).not.toBe('q-existing')
    const result = await publish({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(result.committed).toBe(true)
    const after = activePlan().plan
    expect(assignmentShapes(after, editedId)).toEqual(harborBefore)
    expect(assignmentShapes(after, 'q-existing')).toEqual(riverBefore)
    expect(marketShapes(after, 'alpha-market').map(edge => edge.queryId)).toEqual([editedId, 'q-existing'])
    expect(marketShapes(after, 'beta-market').map(edge => edge.queryId)).toEqual([editedId])
    expect(db.select().from(queries).where(eq(queries.id, 'q-existing')).get()).toBeDefined()
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.id, 'history-alpha')).get()).toMatchObject({ queryId: 'q-existing', queryText: OLD_TEXT })
    expect(db.select().from(runs).all()).toHaveLength(1)
  })

  it('globally renames every frozen edge without flattening heterogeneous classes or contexts', async () => {
    seedTwoPropertiesTwoContextsTwoMarkets()
    insertHistoricalSnapshot()
    rewriteActivePlan(plan => {
      const river = plan.assignments.find(row => row.targetKey === 'river-point')!
      river.queryClass = 'branded'
      river.classificationSource = 'operator'
    })
    const before = activePlan().plan
    const beforeShapes = assignmentShapes(before, 'q-existing')
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'q-existing', text: GLOBAL_TEXT }],
    }
    const review = await preview(mutation)
    const editedId = review.tracked.find(row => row.queryText === GLOBAL_TEXT)!.queryId
    await publish({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    const after = activePlan().plan
    expect(assignmentShapes(after, editedId)).toEqual(beforeShapes)
    expect(after.usageEdges.some(edge => edge.queryId === 'q-existing')).toBe(false)
    expect(after.executionNodes.every(node => node.queryId === editedId && node.queryText === GLOBAL_TEXT)).toBe(true)
    expect(marketShapes(after, 'alpha-market').every(edge => edge.queryId === editedId)).toBe(true)
    expect(marketShapes(after, 'beta-market').every(edge => edge.queryId === editedId)).toBe(true)
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.id, 'history-alpha')).get()).toMatchObject({ queryId: null, queryText: OLD_TEXT })
  })

  it('moves only a selected market text edge and retains an unselected market shared edge', async () => {
    seedTwoPropertiesTwoContextsTwoMarkets()
    addSharedAlphaHarborEdgeToBeta()
    const betaBefore = marketShapes(activePlan().plan, 'beta-market')
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'q-existing', audience: { marketKeys: ['alpha-market'] }, text: MARKET_TEXT }],
    }
    const review = await preview(mutation)
    const editedId = review.tracked.find(row => row.queryText === MARKET_TEXT)!.queryId
    await publish({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    const after = activePlan().plan
    expect(marketShapes(after, 'alpha-market').map(edge => edge.queryId)).toEqual([editedId, editedId])
    expect(marketShapes(after, 'beta-market')).toEqual(betaBefore)
    expect(after.querySnapshots.some(snapshot => snapshot.queryId === 'q-existing')).toBe(true)
    expect(after.querySnapshots.some(snapshot => snapshot.queryId === editedId)).toBe(true)
  })

  it('treats an identical text edit with an omitted class as a no-op and publishes no revision or provider work', async () => {
    seedTwoPropertiesTwoContextsTwoMarkets()
    const pointer = activePlan().pointer.activeVersionId
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'q-existing', text: OLD_TEXT }],
    }
    const review = await preview(mutation)
    expect(review.diff.noOp).toBe(true)
    expect(review.workload).toMatchObject({ addedProviderCalls: 0, removedProviderCalls: 0 })
    const result = await publish({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(result).toMatchObject({ committed: false, workload: { addedProviderCalls: 0, removedProviderCalls: 0 } })
    expect(activePlan().pointer.activeVersionId).toBe(pointer)
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(1)
    expect(db.select().from(runs).all()).toHaveLength(0)
  })

  it('binds a semantically no-op edit to the exact reviewed text in its preview token', async () => {
    seedTwoPropertiesTwoContextsTwoMarkets()
    const current = await workspace()
    const reviewed = {
      expectedWorkspaceVersion: current.workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'q-existing', text: OLD_TEXT }],
    }
    const review = await preview(reviewed)
    expect(review.diff.noOp).toBe(true)
    const changedRequest = await request('POST', '/query-tracking/commit', {
      expectedWorkspaceVersion: current.workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'q-existing', text: OLD_TEXT.toUpperCase() }],
      previewToken: review.previewToken,
      reviewedAt: review.reviewedAt,
    })
    expect(changedRequest.statusCode, changedRequest.body).toBe(409)
    expect(activePlan().version.revision).toBe(1)
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(1)
  })

  it('prefers the active-plan destination identity, deduplicates matching work, and rejects a class collision', async () => {
    seedTwoPropertiesTwoContextsTwoMarkets()
    addActiveDestinationAndStaleDuplicate()
    const current = await workspace()
    const conflict = await request('POST', '/query-tracking/preview', {
      expectedWorkspaceVersion: current.workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'q-existing', audience: { targetKeys: ['harbor-point'] }, text: DESTINATION_TEXT, queryClass: 'branded' }],
    })
    expect(conflict.statusCode, conflict.body).toBe(400)
    expect(activePlan().version.revision).toBe(1)

    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'q-existing', audience: { targetKeys: ['harbor-point'] }, text: DESTINATION_TEXT }],
    }
    const review = await preview(mutation)
    expect(review.tracked.find(row => row.queryText === DESTINATION_TEXT)!.queryId).toBe('q-bound-destination')
    await publish({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    const after = activePlan().plan
    expect(assignmentShapes(after, 'q-bound-destination').map(row => row.context.location?.label).sort()).toEqual(['alpha', 'beta'])
    expect(after.assignments.some(row => row.queryId === 'q-stale-destination')).toBe(false)
    expect(after.usageEdges.filter(edge => edge.queryId === 'q-bound-destination')).toHaveLength(2)
  })

  it('rejects a destination duplicate whose class matches but whose classification source differs', async () => {
    seedTwoPropertiesTwoContextsTwoMarkets()
    addActiveDestinationAndStaleDuplicate()
    rewriteActivePlan(plan => {
      for (const assignment of plan.assignments.filter(row => row.queryId === 'q-existing' && row.targetKey === 'harbor-point')) {
        assignment.queryClass = 'non-brand'
        assignment.classificationSource = 'operator'
      }
    })
    const before = activePlan()
    const current = await workspace()
    const response = await request('POST', '/query-tracking/preview', {
      expectedWorkspaceVersion: current.workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'q-existing', audience: { targetKeys: ['harbor-point'] }, text: DESTINATION_TEXT }],
    })
    expect(response.statusCode, response.body).toBe(400)
    expect(activePlan().pointer.activeVersionId).toBe(before.pointer.activeVersionId)
    expect(activePlan().version.canonicalJson).toBe(before.version.canonicalJson)
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(1)
    expect(db.select().from(runs).all()).toHaveLength(0)
  })

  it('preserves a legacy missing classification source when a Property text edit creates renamed edges', async () => {
    seedTwoPropertiesTwoContextsTwoMarkets()
    rewriteActivePlan(plan => {
      for (const assignment of plan.assignments.filter(row => row.targetKey === 'harbor-point')) {
        delete assignment.classificationSource
      }
    })
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'q-existing', audience: { targetKeys: ['harbor-point'] }, text: PROPERTY_TEXT }],
    }
    const review = await preview(mutation)
    const editedId = review.tracked.find(row => row.queryText === PROPERTY_TEXT)!.queryId
    await publish({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(activePlan().plan.assignments.filter(row => row.queryId === editedId)
      .every(row => row.classificationSource === undefined)).toBe(true)
  })

  it('edits template-resolved text literally instead of expanding the current template again', async () => {
    seedTwoPropertiesTwoContextsTwoMarkets()
    const templateOutput = 'Harbor Point amenities in Alpha'
    rewriteActivePlan(plan => {
      const snapshot = plan.querySnapshots.find(row => row.queryId === 'q-existing')!
      snapshot.queryText = templateOutput
      snapshot.provenance = {
        source: 'template', sourceId: 'template-1@old', capturedAt: NOW,
        template: { templateId: 'template-1', templateVersion: 'old', template: '{property} amenities in {market}', bindings: { property: 'Harbor Point', market: 'Alpha' }, output: templateOutput },
      }
      for (const node of plan.executionNodes) node.queryText = templateOutput
    })
    db.update(queries).set({ query: templateOutput }).where(eq(queries.id, 'q-existing')).run()
    db.insert(measurementQueryTemplates).values({
      id: 'template-1', projectId: PROJECT_ID, name: 'changed', description: null,
      pattern: 'REEXPANDED {property} in {market}', variables: ['property', 'market'], createdAt: NOW, updatedAt: NOW,
    }).run()
    const current = await workspace()
    const literal = 'Exact editor supplied query'
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'q-existing', text: literal }],
    }
    const review = await preview(mutation)
    const editedId = review.tracked.find(row => row.queryText === literal)!.queryId
    await publish({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    const after = activePlan().plan
    expect(after.querySnapshots.find(snapshot => snapshot.queryId === editedId)?.queryText).toBe(literal)
    expect(after.executionNodes.filter(node => node.queryId === editedId).every(node => node.queryText === literal)).toBe(true)
    expect(after.querySnapshots.some(snapshot => snapshot.queryText.includes('REEXPANDED'))).toBe(false)
  })

  it('edits a simple tracked query without starting provider work', async () => {
    insertHistoricalSnapshot()
    const current = await workspace()
    expect(current.mode).toBe('simple')
    const simpleText = 'simple edited query'
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'q-existing', text: simpleText }],
    }
    const review = await preview(mutation)
    expect(review.diff.noOp).toBe(false)
    await publish({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(db.select().from(queries).where(eq(queries.projectId, PROJECT_ID)).all().map(row => row.query)).toEqual([simpleText])
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.id, 'history-alpha')).get()?.queryText).toBe(OLD_TEXT)
    expect(db.select().from(runs).all()).toHaveLength(1)
  })

  it('preserves an omitted operator override, reclassifies null server-side, and fails closed for a shared market class edit', async () => {
    seedTwoPropertiesTwoContextsTwoMarkets()
    addSharedAlphaHarborEdgeToBeta()
    rewriteActivePlan(plan => {
      for (const assignment of plan.assignments.filter(row => row.targetKey === 'harbor-point')) {
        assignment.queryClass = 'branded'
        assignment.classificationSource = 'operator'
      }
    })
    const current = await workspace()
    const sharedClassEdit = await request('POST', '/query-tracking/preview', {
      expectedWorkspaceVersion: current.workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'q-existing', audience: { marketKeys: ['alpha-market'] }, queryClass: 'non-brand' }],
    })
    expect(sharedClassEdit.statusCode, sharedClassEdit.body).toBe(400)

    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'q-existing', queryClass: null }],
    }
    const review = await preview(mutation)
    expect(review.diff.noOp).toBe(false)
    await publish({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    const after = activePlan().plan
    expect(after.assignments.every(row => row.queryClass === 'non-brand' && row.classificationSource === 'server')).toBe(true)
  })
})
