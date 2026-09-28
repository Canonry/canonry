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
import { plansAreLabelOnlyVariants } from '../src/measurement-draft-compile.js'
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
type Slot = ReturnType<typeof buildMeasurementPlanV2Manifest>['expectedSlots'][number]
function seedRun(plan: MeasurementPlanV2, versionId: string, createdAt: string, unknown = false, options: { answer?: (slot: Slot) => string; citedUrls?: (slot: Slot) => string[]; trigger?: 'manual' | 'probe' } = {}): void {
  const id = crypto.randomUUID()
  const manifest = buildMeasurementPlanV2Manifest(plan)
  db.insert(runs).values({ id, projectId, kind: 'answer-visibility', status: 'completed', trigger: options.trigger ?? 'manual', measurementPlanVersionId: versionId, measurementManifest: manifest, createdAt, finishedAt: createdAt }).run()
  for (const slot of manifest.expectedSlots) {
    const citedUrls = options.citedUrls?.(slot) ?? ['https://northstar.example/locations/harbor/details']
    db.insert(querySnapshots).values({ id: crypto.randomUUID(), runId: id, queryId: null, queryText: slot.queryText, provider: slot.provider, model: 'stable-requested-model', servedModel: 'served-model', citationState: 'cited', answerMentioned: true, answerText: unknown ? null : options.answer?.(slot) ?? 'Harbor Homes, Rival, and Unrelated live brand are recommended.', citedDomains: [...new Set(citedUrls.map(url => new URL(url).hostname))], citedUrls, captureStatus: unknown ? 'partial' : 'complete', measurementExecutionId: slot.executionId, location: slot.context?.label ?? null, requestedContext: slot.context, supportedContext: { status: 'applied', resolved: slot.context }, createdAt }).run()
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
  it('leaves answers with incomplete source capture out of every pooled citation figure', async () => {
    const plan = frozenPlan(); const id = seedVersion(plan)
    for (let day = 10; day < 15; day++) seedRun(plan, id, `2026-08-${day}T12:00:00.000Z`)
    for (let day = 10; day < 15; day++) seedRun(plan, id, `2026-09-${day}T12:00:00.000Z`, true)
    const dto = await compare('&scope=property&scopeKey=harbor')
    // September captured no complete source list, so it has no citation
    // evidence at all: never a measured 0% and never a "moved down" verdict.
    const cited = dto.metrics.find(metric => metric.key === 'cited-rate')!
    expect(cited.from).toMatchObject({ numerator: 20, denominator: 20, point: 1, excludedUnknown: 0 })
    expect(cited.to).toMatchObject({ numerator: 0, denominator: 0, point: null, availability: 'no-observations', excludedUnknown: 20 })
    expect(cited.verdict).toBe('insufficient-data')
    const share = dto.metrics.find(metric => metric.key === 'cited-share-of-voice')!
    expect(share.to).toMatchObject({ numerator: 0, denominator: 0, excludedUnknown: 20 })
    expect(share.verdict).toBe('insufficient-data')
  })
  it('narrows the project frame by provider and location over schema-v1 history instead of reporting no sweeps', async () => {
    const plan = frozenPlan(); const id = seedVersion(plan)
    seedRun(plan, id, before); seedRun(plan, id, after)
    const legacy = compileMeasurementPlan({ schemaVersion: 1, targets: [{ stableKey: 'harbor', label: 'Harbor Homes', urls: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/harbor', pathCase: 'insensitive' }], aliases: ['Harbor Homes'] }], groups: [], targetQuerySelections: [{ targetKey: 'harbor', queryIds: ['q-nearby'] }] }, { canonicalDomain: 'northstar.example', ownedDomains: [], brandNames: ['Northstar'], trackedQueries: [{ id: 'q-nearby', query: 'homes near harbor' }], locations: [], defaultContext: null, expectedSnapshots: 2 })
    db.update(measurementPlanVersions).set({ schemaVersion: 1, canonicalJson: canonicalMeasurementPlanJson(legacy) }).where(eq(measurementPlanVersions.id, id)).run()
    // Provider and location match case-insensitively, as the frozen reader does.
    const dto = await compare('&provider=OpenAI&location=HARBOR')
    expect([dto.from.runCount, dto.to.runCount]).toEqual([1, 1])
    expect(dto.basket.providers).toEqual(['openai'])
    expect(dto.metrics.find(metric => metric.key === 'mention-rate')?.from).toMatchObject({ numerator: 2, denominator: 2 })
    expect(dto.metrics.find(metric => metric.key === 'mention-rate-non-brand')?.from).toMatchObject({ availability: 'classification-unavailable' })
    expect(dto.selection).toEqual({ provider: 'OpenAI', location: 'HARBOR' })
    // A Property scope has only the frozen frame, which cannot read these runs.
    const scoped = await app.inject({ method: 'GET', url: '/api/v1/projects/monthly/visibility-compare?from=2026-08&to=2026-09&scope=property&scopeKey=harbor' })
    expect(scoped.statusCode).toBe(400)
    expect(scoped.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', details: { months: ['2026-08', '2026-09'] } } })
  })
  it('leaves mention-ineligible Targets out of class mention rates instead of counting them unknown', async () => {
    const base = frozenPlan()
    const plan = measurementPlanV2Fixture({ ...base, targets: base.targets.map(target => target.stableKey === 'bayside' ? { ...target, mentionNotApplicable: true } : target) })
    const id = seedVersion(plan)
    seedRun(plan, id, before); seedRun(plan, id, after)
    const dto = await compare('&scope=property&scopeKey=bayside')
    expect(dto.metrics.find(metric => metric.key === 'mention-rate-branded')?.from).toMatchObject({ numerator: 0, denominator: 0, excludedUnknown: 0 })
    // The citation signal is still measured for the same answers.
    expect(dto.metrics.find(metric => metric.key === 'cited-rate-branded')?.from).toMatchObject({ denominator: 2, excludedUnknown: 0 })
  })

  it('keeps a revision that only adds a market comparable with the months before it', async () => {
    const base = measurementPlanV2Fixture()
    const withoutMarket = measurementPlanV2Fixture({ assignments: base.assignments.map(assignment => assignment.targetKey === 'bayside' ? { ...assignment, queryClass: 'branded' } : assignment) })
    const withMarket = frozenPlan()
    // Publishing accepts an added market as a display-only revision.
    expect(plansAreLabelOnlyVariants(withoutMarket, withMarket)).toBe(true)
    const first = seedVersion(withoutMarket)
    seedRun(withoutMarket, first, before)
    seedRun(withMarket, seedVersion(withMarket, 2, first), after)
    const dto = await compare()
    expect(dto.classComparison).toMatchObject({ basket: { queryCount: 2, providers: ['gemini', 'openai'] }, continuity: { status: 'comparable' } })
    expect(dto.metrics.find(metric => metric.key === 'mention-rate-non-brand')).toMatchObject({ from: { numerator: 2, denominator: 2 }, to: { numerator: 2, denominator: 2 } })
    // August's answers read through the newest definition, which has the market.
    const market = await compare('&scope=market&scopeKey=harbor-market')
    expect([market.from.runCount, market.to.runCount]).toEqual([1, 1])
    for (const key of ['mention-rate-branded', 'mention-rate-non-brand', 'cited-rate-branded', 'cited-rate-non-brand']) {
      expect(market.metrics.find(metric => metric.key === key), key).toMatchObject({ from: { numerator: 2, denominator: 2 }, to: { numerator: 2, denominator: 2 } })
    }
  })
  it('compares a scope over the runs that measured it when a material revision adds it mid-month', async () => {
    const base = measurementPlanV2Fixture()
    const withoutMarket = measurementPlanV2Fixture({ assignments: base.assignments.map(assignment => assignment.targetKey === 'bayside' ? { ...assignment, queryClass: 'branded' } : assignment) })
    const moved = frozenPlan()
    const withMarket = measurementPlanV2Fixture({ ...moved, executionNodes: moved.executionNodes.map(node => ({ ...node, context: { ...node.context, location: { label: 'Harbor North', city: 'Harbor', region: 'EX', country: 'US' } } })) })
    expect(plansAreLabelOnlyVariants(withoutMarket, withMarket)).toBe(false)
    seedRun(withoutMarket, seedVersion(withoutMarket), '2026-08-05T12:00:00.000Z')
    const second = seedVersion(withMarket, 2)
    seedRun(withMarket, second, '2026-08-20T12:00:00.000Z')
    seedRun(withMarket, second, after)
    // The 08-05 sweep never measured the market; it leaves August instead of failing the request.
    const market = await compare('&scope=market&scopeKey=harbor-market')
    expect([market.from.runCount, market.to.runCount]).toEqual([1, 1])
    expect(market.metrics.find(metric => metric.key === 'mention-rate-non-brand')).toMatchObject({ from: { numerator: 2, denominator: 2 }, to: { numerator: 2, denominator: 2 } })
    // A scope that no sweep in either month measured is still refused.
    const absent = await app.inject({ method: 'GET', url: '/api/v1/projects/monthly/visibility-compare?from=2026-08&to=2026-09&scope=market&scopeKey=nowhere' })
    expect(absent.statusCode).toBe(400)
    expect(absent.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', details: { reason: 'retired-scope', kind: 'market', key: 'nowhere' } } })
  })
  it('counts frozen share of voice from named competitors only, most-named first', async () => {
    const base = frozenPlan()
    const plan = measurementPlanV2Fixture({ ...base, groups: base.groups.map(group => ({ ...group, competitors: [
      ...group.competitors,
      { stableKey: 'other', label: 'Other Co', domain: 'other.example', aliases: ['Other Co'] },
      { stableKey: 'absent', label: 'Absent Brand', domain: 'absent.example', aliases: ['Absent Brand'] },
    ] })) })
    const id = seedVersion(plan)
    const harborPage = 'https://northstar.example/locations/harbor/details'
    const challengerPage = 'https://challenger.example/homes'
    // August: every answer names Harbor Homes and Challenger; OpenAI also names
    // Other Co and cites Challenger beside Harbor.
    seedRun(plan, id, before, false, {
      answer: slot => slot.provider === 'openai' ? 'Harbor Homes, Challenger and Other Co are recommended.' : 'Harbor Homes and Challenger are recommended.',
      citedUrls: slot => slot.provider === 'openai' ? [harborPage, challengerPage] : [harborPage],
    })
    // September: only Challenger is named and cited.
    seedRun(plan, id, after, false, { answer: () => 'Challenger is recommended.', citedUrls: () => [challengerPage] })
    const dto = await compare('&scope=group&scopeKey=regional')
    // Non-brand rows are Harbor's two exec-nearby answers. August: 2 project
    // mentions against Challenger 2 + Other Co 1; September: 0 against 2.
    expect(dto.metrics.find(metric => metric.key === 'mention-share-of-voice')).toMatchObject({
      queryClass: 'non-brand',
      from: { numerator: 2, denominator: 5, point: 0.4 },
      to: { numerator: 0, denominator: 2, point: 0 },
    })
    expect(dto.competitors).toEqual({
      from: [{ domain: 'challenger.example', mentions: 2 }, { domain: 'other.example', mentions: 1 }],
      to: [{ domain: 'challenger.example', mentions: 2 }],
    })
    // Cited share of voice pools the group's four answers. August: Harbor is
    // cited in all 4, Challenger in the 2 OpenAI answers; September: 0 against 4.
    expect(dto.metrics.find(metric => metric.key === 'cited-share-of-voice')).toMatchObject({
      from: { numerator: 4, denominator: 6, excludedUnknown: 0 },
      to: { numerator: 0, denominator: 4, excludedUnknown: 0 },
    })
  })
  it('leaves probe sweeps out of the frozen class frame', async () => {
    const plan = frozenPlan(); const id = seedVersion(plan)
    seedRun(plan, id, before); seedRun(plan, id, after)
    // A September probe names nobody; it must not dilute September.
    seedRun(plan, id, '2026-09-12T12:00:00.000Z', false, { trigger: 'probe', answer: () => 'Nobody relevant is recommended.' })
    const dto = await compare()
    expect([dto.to.runCount, dto.classComparison?.to.runCount]).toEqual([1, 1])
    expect(dto.metrics.find(metric => metric.key === 'mention-rate-non-brand')?.to).toMatchObject({ numerator: 2, denominator: 2 })
    const scoped = await compare('&scope=property&scopeKey=harbor')
    expect(scoped.to.runCount).toBe(1)
    expect(scoped.metrics.find(metric => metric.key === 'mention-rate-non-brand')?.to).toMatchObject({ numerator: 2, denominator: 2 })
  })
})
