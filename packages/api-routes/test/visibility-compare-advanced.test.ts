import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalMeasurementPlanJson, compileMeasurementPlan, canonicalMeasurementPlanV2Json, effectiveBrandNames, visibilityCompareDtoSchema, type MeasurementPlanV2 } from '@ainyc/canonry-contracts'
import { competitors, createClient, queries, measurementPlans, measurementPlanVersions, migrate, projects, querySnapshots, runs } from '@ainyc/canonry-db'
import { computeVisibilityCompare } from '../src/visibility-compare.js'
import { apiRoutes } from '../src/index.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

let directory: string
let db: ReturnType<typeof createClient>
let app: ReturnType<typeof Fastify>
const projectId = 'advanced-monthly'
const before = '2026-08-10T12:00:00.000Z'
const after = '2026-09-10T12:00:00.000Z'

function frozenPlan(): MeasurementPlanV2 {
  const base = measurementPlanV2Fixture()
  return measurementPlanV2Fixture({
    assignments: base.assignments.map(assignment => assignment.targetKey === 'bayside' ? { ...assignment, queryClass: 'branded' } : assignment),
    reportingScopes: [{ kind: 'market', stableKey: 'harbor-market', label: 'Harbor market', usageEdges: base.usageEdges.filter(edge => edge.targetKey === 'harbor') }],
  })
}
function seedVersion(plan: MeasurementPlanV2, revision = 1, comparableToVersionId: string | null = null): string {
  const id = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({ id, projectId, revision, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'a'.repeat(64), schemaVersion: 2, compiledChecksum: plan.compiledChecksum, comparableToVersionId, createdAt: before }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: id, createdAt: before, updatedAt: before }).onConflictDoUpdate({ target: measurementPlans.projectId, set: { activeVersionId: id } }).run()
  return id
}
function seedRun(plan: MeasurementPlanV2, versionId: string, createdAt: string, unknown = false): void {
  const id = crypto.randomUUID()
  const manifest = buildMeasurementPlanV2Manifest(plan)
  db.insert(runs).values({ id, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', measurementPlanVersionId: versionId, measurementManifest: manifest, createdAt, finishedAt: createdAt }).run()
  for (const slot of manifest.expectedSlots) {
    db.insert(querySnapshots).values({ id: crypto.randomUUID(), runId: id, queryId: null, queryText: slot.queryText, provider: slot.provider, model: 'stable-requested-model', servedModel: 'served-model', citationState: 'cited', answerMentioned: true, answerText: unknown ? null : 'Harbor Homes, Rival, and Unrelated live brand are recommended.', citedDomains: ['northstar.example'], citedUrls: ['https://northstar.example/locations/harbor/details'], captureStatus: unknown ? 'partial' : 'complete', measurementExecutionId: slot.executionId, location: slot.context?.label ?? null, requestedContext: slot.context, supportedContext: { status: 'applied', resolved: slot.context }, createdAt }).run()
  }
}
async function compare(selection = '') {
  const response = await app.inject({ method: 'GET', url: `/api/v1/projects/monthly/visibility-compare?from=2026-08&to=2026-09${selection}` })
  expect(response.statusCode, response.body).toBe(200)
  return visibilityCompareDtoSchema.parse(response.json())
}
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-advanced-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  db.insert(projects).values({ id: projectId, name: 'monthly', displayName: 'Unrelated live brand', canonicalDomain: 'northstar.example', country: 'US', language: 'en', providers: ['openai', 'gemini'], locations: [], createdAt: before, updatedAt: before }).run()
  for (const query of measurementPlanV2Fixture().querySnapshots) db.insert(queries).values({ id: query.queryId, projectId, query: query.queryText, createdAt: before }).run()
  app = Fastify()
  await app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})
afterEach(async () => { await app.close(); db.$client.close(); fs.rmSync(directory, { recursive: true, force: true }) })

describe('Advanced monthly comparison', () => {
  it('keeps schema-v1 history readable and makes the new class metrics explicitly unavailable', async () => {
    const plan = frozenPlan(); const id = seedVersion(plan)
    seedRun(plan, id, before); seedRun(plan, id, after)
    const legacy = compileMeasurementPlan({ schemaVersion: 1, targets: [{ stableKey: 'harbor', label: 'Harbor Homes', urls: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/harbor', pathCase: 'insensitive' }], aliases: ['Harbor Homes'] }], groups: [], targetQuerySelections: [{ targetKey: 'harbor', queryIds: ['q-nearby'] }] }, { canonicalDomain: 'northstar.example', ownedDomains: [], brandNames: ['Northstar'], trackedQueries: [{ id: 'q-nearby', query: 'homes near harbor' }], locations: [], defaultContext: null, expectedSnapshots: 2 })
    db.update(measurementPlanVersions).set({ schemaVersion: 1, canonicalJson: canonicalMeasurementPlanJson(legacy) }).where(eq(measurementPlanVersions.id, id)).run()
    const dto = await compare()
    expect(dto.metrics.find(metric => metric.key === 'mention-rate')?.from).toMatchObject({ numerator: 4, denominator: 4 })
    expect(dto.metrics.find(metric => metric.key === 'mention-rate-non-brand')?.from).toMatchObject({ availability: 'classification-unavailable', point: null })
  })
  it('preserves all four legacy project metrics and their common basket when adding frozen class metrics', async () => {
    const plan = frozenPlan(); const id = seedVersion(plan)
    seedRun(plan, id, before); seedRun(plan, id, after)
    db.insert(competitors).values({ id: 'rival', projectId, domain: 'rival.example', createdAt: before }).run()
    const project = db.select().from(projects).get()!
    const snapshots = db.select().from(querySnapshots).all().slice(0, 4)
    const expected = computeVisibilityCompare({ project: 'monthly', queries: plan.querySnapshots.map(query => ({ id: query.queryId, query: query.queryText })), brandNames: effectiveBrandNames(project), competitors: [{ domain: 'rival.example', brandTokens: ['rival'] }], from: { month: '2026-08', since: '2026-08-01T00:00:00.000Z', until: '2026-08-31T23:59:59.999Z', runCount: 1, snapshots }, to: { month: '2026-09', since: '2026-09-01T00:00:00.000Z', until: '2026-09-30T23:59:59.999Z', runCount: 1, snapshots } })
    const result = await compare()
    expect(result.metrics.slice(0, 4)).toEqual(expected.metrics.slice(0, 4))
    expect(result.basket).toEqual(expected.basket)
    expect(result.continuity).toEqual(expected.continuity)
  })
  it('uses frozen assignment classes and scoped Target evidence, deduplicating shared executions', async () => {
    const plan = frozenPlan(); const id = seedVersion(plan)
    seedRun(plan, id, before); seedRun(plan, id, after)
    const dto = await compare()
    expect(dto.metrics.find(metric => metric.key === 'mention-rate-non-brand')?.from).toMatchObject({ numerator: 2, denominator: 2 })
    expect(dto.metrics.find(metric => metric.key === 'mention-rate-branded')?.from).toMatchObject({ numerator: 2, denominator: 4 })
    expect(dto.metrics.find(metric => metric.key === 'mention-rate')?.from).toMatchObject({ numerator: 4, denominator: 4 })
    const property = await compare('&scope=property&scopeKey=bayside')
    expect(property.metrics.find(metric => metric.key === 'mention-rate-branded')?.from).toMatchObject({ numerator: 0, denominator: 2 })
    expect(property.metrics.find(metric => metric.key === 'mention-rate-non-brand')?.from).toMatchObject({ denominator: 0, point: null })
  })
  it('intersects exact market edges, Property and provider before counting either signal', async () => {
    const plan = frozenPlan(); const id = seedVersion(plan)
    seedRun(plan, id, before); seedRun(plan, id, after)
    const dto = await compare('&scope=group&scopeKey=regional&marketKey=harbor-market&provider=openai')
    for (const key of ['mention-rate-branded', 'mention-rate-non-brand', 'cited-rate-branded', 'cited-rate-non-brand']) expect(dto.metrics.find(metric => metric.key === key)?.from).toMatchObject({ numerator: 1, denominator: 1 })
  })
  it('excludes unknown mention and incomplete citation independently without erasing the measured population', async () => {
    const plan = frozenPlan(); const id = seedVersion(plan)
    seedRun(plan, id, before); seedRun(plan, id, after, true)
    const dto = await compare('&scope=property&scopeKey=harbor')
    for (const key of ['mention-rate-non-brand', 'cited-rate-non-brand']) expect(dto.metrics.find(metric => metric.key === key)?.to).toMatchObject({ numerator: 0, denominator: 0, point: null, excludedUnknown: 2 })
  })
  it('keeps label-only revisions comparable but rejects cross-revision measurement semantics', async () => {
    const plan = frozenPlan(); const first = seedVersion(plan)
    seedRun(plan, first, before)
    const second = seedVersion(plan, 2, first)
    seedRun(plan, second, after)
    expect((await compare()).metrics.find(metric => metric.key === 'mention-rate-non-brand')?.to.denominator).toBe(2)
  })
  it('does not compare identical query/provider pairs across material plan changes', async () => {
    const plan = frozenPlan(); const first = seedVersion(plan)
    seedRun(plan, first, before)
    const changed = measurementPlanV2Fixture({ ...plan, executionNodes: plan.executionNodes.map(node => ({ ...node, context: { ...node.context, location: { label: 'Different market', country: 'GB', city: 'London', region: 'England' } } })) })
    const second = seedVersion(changed, 2)
    seedRun(changed, second, after)
    const dto = await compare()
    expect(dto.classComparison?.continuity.status).toBe('insufficient-data')
    expect(dto.metrics.find(metric => metric.key === 'mention-rate-non-brand')?.to.denominator).toBe(0)
  })
})
