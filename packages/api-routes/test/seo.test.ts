import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { SeoRepository, emptySeoResults, measurementPlans, measurementPlanVersions, projects, runs, seoBudgets, seoJobs, seoTasks } from '@canonry/canonry-db'
import { canonicalMeasurementPlanV2Json, SeoCapabilities, SeoRunStatuses, type SeoDomainIntelligence, type SeoQuote, type SeoRun } from '@canonry/canonry-contracts'
import { createSeoHarness, seedSeoKey, seoProfileFixture } from './seo-fixture.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const harnesses: ReturnType<typeof createSeoHarness>[] = []
afterEach(async () => { await Promise.all(harnesses.splice(0).map(h => h.close())) })
const harness = (options: Parameters<typeof createSeoHarness>[0] = {}) => { const h = createSeoHarness(options); harnesses.push(h); return h }
const base = '/api/v1/projects/alpha/seo'
async function save(h: ReturnType<typeof harness>, input = seoProfileFixture, headers = {}) {
  const response = await h.app.inject({ method: 'PUT', url: `${base}/profiles/main`, payload: input, headers })
  expect(response.statusCode, response.body).toBe(200)
}
async function quote(h: ReturnType<typeof harness>, headers = {}) {
  const response = await h.app.inject({ method: 'POST', url: `${base}/refresh-intents`, payload: { profileId: 'main' }, headers })
  expect(response.statusCode, response.body).toBe(200)
  return response.json<SeoQuote>()
}
async function sync(h: ReturnType<typeof harness>, key: string, headers = {}) {
  const intent = await quote(h, headers)
  return h.app.inject({ method: 'POST', url: `${base}/sync`, payload: { quoteToken: intent.token, idempotencyKey: key }, headers })
}

// Owning API boundary: mutations must reserve real durable capacity before any callback,
// retries must not reserve twice, and stored reads must never dispatch or expose that ledger.
describe('SEO durable API', () => {
  it('reserves all ceilings atomically, replays accepted receipts, and keeps financial details out of customer reads', async () => {
    const h = harness(); h.state.policy.accountDailyLimitMicros = 150
    await save(h)
    const intent = await quote(h)
    const claims = Buffer.from(intent.token.split('.')[0]!, 'base64url').toString()
    expect(claims).not.toMatch(/cost|budget|price|Micros/i)
    const request = { quoteToken: intent.token, idempotencyKey: 'one' }
    const accepted = await h.app.inject({ method: 'POST', url: `${base}/sync`, payload: request })
    expect(accepted.statusCode, accepted.body).toBe(202)
    const run = accepted.json<SeoRun>()
    expect(h.db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[100, 0], [100, 0], [100, 0]])
    h.state.policy.maxRunCostMicros = 1
    const replay = await h.app.inject({ method: 'POST', url: `${base}/sync`, payload: request })
    expect(replay.statusCode).toBe(200); expect(replay.json().id).toBe(run.id)
    expect(h.requested).toEqual([run.id])
    h.state.policy.maxRunCostMicros = 1000
    const refused = await sync(h, 'two')
    expect(refused.statusCode).toBe(400)
    expect(h.db.select().from(seoJobs).all()).toHaveLength(1)
    expect(h.db.select().from(seoBudgets).all().map(row => row.reservedMicros)).toEqual([100, 100, 100])
    for (const suffix of ['context', 'status', 'profiles', 'overview?profileId=main', `runs/${run.id}`, 'keyword-metrics?profileId=main']) {
      const response = await h.app.inject({ url: `${base}/${suffix}` })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.body).not.toMatch(/reservedMicros|actualMicros|accountKey|password|login|catalogRevision/)
    }
    expect(h.state.executions).toBe(0)
  })

  it('keeps an unchanged profile PUT idempotent and hides deleted run sidecars without releasing liabilities', async () => {
    const h = harness(); await save(h); const intent = await quote(h); await save(h)
    const response = await h.app.inject({ method: 'POST', url: `${base}/sync`, payload: { quoteToken: intent.token, idempotencyKey: 'stable-profile' } })
    expect(response.statusCode, response.body).toBe(202)
    const id = response.json<SeoRun>().id
    expect((await h.app.inject({ url: `${base}/profiles/main` })).json().revision).toBe(1)
    h.db.delete(runs).where(eq(runs.id, id)).run()
    expect((await h.app.inject({ url: `${base}/runs/${id}` })).statusCode).toBe(404)
    expect((await h.app.inject({ url: `${base}/runs?profileId=main` })).json().runs).toEqual([])
    expect((await h.app.inject({ url: `${base}/overview?profileId=main` })).json()).toMatchObject({ latestRun: null, evidenceRunId: null })
    expect(h.db.select().from(seoJobs).where(eq(seoJobs.id, id)).get()?.runId).toBeNull()
    expect(h.db.select().from(seoBudgets).all().map(row => row.reservedMicros)).toEqual([100, 100, 100])
  })

  it.each(['unknown', 'completed'] as const)('keeps financial reconciliation separate from %s collection evidence', async outcome => {
    const h = harness(); await save(h)
    const first = (await sync(h, 'baseline')).json<SeoRun>()
    const repo = new SeoRepository(h.db); const firstTask = repo.claim(first.id, { ...h.state.policy, accountKey: h.state.accountKey })!
    repo.settle(firstTask.id, { outcome: 'completed', tasks: [{ remoteTaskId: 'baseline', statusCode: 20000, costMicros: 10 }], results: emptySeoResults(), error: null, fetchedAt: new Date().toISOString() }, firstTask.leaseOwner!)
    const next = (await sync(h, 'reconciled')).json<SeoRun>(); const nextTask = repo.claim(next.id, { ...h.state.policy, accountKey: h.state.accountKey })!
    repo.settle(nextTask.id, { outcome, tasks: [{ remoteTaskId: 'next', statusCode: outcome === 'completed' ? 20000 : null, costMicros: null }], results: emptySeoResults(), error: null, fetchedAt: new Date().toISOString() }, nextTask.leaseOwner!)
    repo.reconcile(nextTask.id, { actualCostMicros: 10, remoteTaskId: 'next', outcome: 'completed', note: 'Verified completion and cost in the upstream ledger.' })
    const overview = (await h.app.inject({ url: `${base}/overview?profileId=main` })).json()
    expect(overview.evidenceRunId).toBe(outcome === 'completed' ? next.id : first.id)
    expect(h.db.select().from(seoTasks).where(eq(seoTasks.id, nextTask.id)).get()?.status).toBe(outcome === 'completed' ? 'completed' : 'failed')
    expect(h.db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[0, 20], [0, 20], [0, 20]])
  })

  it.each(['account', 'policy', 'catalog', 'profile'] as const)('invalidates an unaccepted intent after %s changes', async change => {
    const h = harness(); await save(h); const intent = await quote(h)
    if (change === 'account') h.state.accountKey = 'another-account'
    if (change === 'policy') h.state.policy.accountMonthlyLimitMicros++
    if (change === 'catalog') h.state.catalogRevision = 'prices-2'
    if (change === 'profile') await save(h, { ...seoProfileFixture, keywords: ['another keyword'] })
    const response = await h.app.inject({ method: 'POST', url: `${base}/sync`, payload: { quoteToken: intent.token, idempotencyKey: 'changed' } })
    expect(response.statusCode).toBe(400); expect(h.requested).toEqual([]); expect(h.db.select().from(seoBudgets).all()).toEqual([])
  })

  it('retains prior complete evidence during refresh and derives the first target top-ten figure without pooling targets', async () => {
    const h = harness()
    const target = { kind: 'domain' as const, value: 'alpha.com', includeSubdomains: true }
    await save(h, { ...seoProfileFixture, capabilities: [SeoCapabilities['domain-intelligence']], targets: [target, { ...target, value: 'beta.com' }] })
    const accepted = await sync(h, 'evidence'); const id = accepted.json<SeoRun>().id
    const repo = new SeoRepository(h.db)
    for (let task = repo.claim(id, { ...h.state.policy, accountKey: h.state.accountKey }); task; task = repo.claim(id, { ...h.state.policy, accountKey: h.state.accountKey })) {
      const domain: SeoDomainIntelligence = { target: task.request.target!, organicKeywords: task.request.target!.value === 'alpha.com' ? 43 : 900, estimatedOrganicTraffic: 1200, estimatedOrganicTrafficValueUsd: 77, top1: 2, top2To3: 5, top4To10: 10, top11To20: 4, provenance: { provider: 'dataforseo', dataset: 'google-labs', engine: 'google', locationCode: 2840, languageCode: 'en', device: 'unspecified', collectedAt: new Date().toISOString(), sourceUpdatedAt: null } }
      repo.settle(task.id, { outcome: 'completed', tasks: [{ remoteTaskId: task.id, statusCode: 20000, costMicros: 35 }], results: { ...emptySeoResults(), domainIntelligence: [domain] }, error: null, fetchedAt: new Date().toISOString() }, task.leaseOwner!)
    }
    const next = await sync(h, 'next')
    const overview = (await h.app.inject({ url: `${base}/overview?profileId=main` })).json()
    expect(overview).toMatchObject({ evidenceRunId: id, latestRun: { id: next.json().id, status: 'queued' }, summary: { target, organicKeywords: 43, inTop10: 17, estimatedOrganicTraffic: 1200 } })
    const page = (await h.app.inject({ url: `${base}/domain-intelligence?profileId=main&limit=1&offset=1` })).json()
    expect(page).toMatchObject({ runId: id, total: 2, limit: 1, offset: 1 }); expect(page.items).toHaveLength(1)
    expect(h.db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[200, 70], [200, 70], [200, 70]])
  })

  it('keeps live leases, holds expired submissions across deletion, and reconciles exactly once through host operator authority', async () => {
    const h = harness({ skipAuth: false, operatorApiKeyIds: ['operator'] })
    const admin = { authorization: `Bearer ${seedSeoKey(h.db, 'admin', ['*'])}` }
    const operator = { authorization: `Bearer ${seedSeoKey(h.db, 'operator', ['*'])}` }
    await save(h, seoProfileFixture, admin)
    const accepted = await sync(h, 'restart', admin); const id = accepted.json<SeoRun>().id
    const repo = new SeoRepository(h.db); const task = repo.claim(id, { ...h.state.policy, accountKey: h.state.accountKey })!
    repo.recover()
    expect(h.db.select().from(seoTasks).where(eq(seoTasks.id, task.id)).get()?.status).toBe(SeoRunStatuses.running)
    h.db.update(seoTasks).set({ leaseUntil: '2000-01-01T00:00:00.000Z' }).where(eq(seoTasks.id, task.id)).run()
    repo.recover()
    expect(h.db.select().from(seoTasks).where(eq(seoTasks.id, task.id)).get()?.status).toBe(SeoRunStatuses['reconciliation-required'])
    expect(h.db.select().from(seoBudgets).all().map(row => row.reservedMicros)).toEqual([100, 100, 100])
    expect((await h.app.inject({ url: `/api/v1/seo/operator/tasks/${task.id}`, headers: admin })).statusCode).toBe(403)
    expect((await h.app.inject({ url: `/api/v1/seo/operator/tasks/${task.id}`, headers: operator })).json()).toMatchObject({ reservedCostMicros: 100, actualCostMicros: null })
    h.db.delete(projects).where(eq(projects.id, 'alpha')).run()
    expect(h.db.select().from(seoJobs).where(eq(seoJobs.id, id)).get()?.projectId).toBeNull()
    const payload = { actualCostMicros: 40, remoteTaskId: 'verified-upstream-task', outcome: 'failed', note: 'Verified exact task and cost in upstream account ledger.' }
    for (let n = 0; n < 2; n++) expect((await h.app.inject({ method: 'POST', url: `/api/v1/seo/operator/tasks/${task.id}/reconcile`, headers: operator, payload })).statusCode).toBe(200)
    expect(h.db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[0, 40], [0, 40], [0, 40]])
    expect((await h.app.inject({ method: 'POST', url: `/api/v1/seo/operator/tasks/${task.id}/reconcile`, headers: operator, payload: { ...payload, actualCostMicros: 0 } })).statusCode).toBe(400)
  })

  it('freezes Advanced market edges and rejects path-to-domain substitution and stale revisions', async () => {
    const h = harness()
    const plan = measurementPlanV2Fixture({ reportingScopes: [{ stableKey: 'north', label: 'North', kind: 'market', usageEdges: [{ executionNodeKey: 'exec-nearby', targetKey: 'harbor', queryId: 'q-nearby' }] }] })
    h.db.insert(measurementPlanVersions).values({ id: 'plan-1', projectId: 'alpha', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: '1'.repeat(64), schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: new Date().toISOString() }).run()
    h.db.insert(measurementPlans).values({ projectId: 'alpha', activeVersionId: 'plan-1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run()
    const scoped = { ...seoProfileFixture, scope: { kind: 'market' as const, key: 'north', expectedPlanRevision: 1 } }
    await save(h, scoped)
    const accepted = await sync(h, 'advanced'); expect(accepted.statusCode, accepted.body).toBe(202)
    const stored = h.db.select().from(seoJobs).get()!
    expect(stored.scopeSnapshot.assignments).toEqual([{ targetKey: 'harbor', queryId: 'q-nearby', queryClass: 'non-brand', executionNodeKey: 'exec-nearby' }])
    const broad = await h.app.inject({ method: 'PUT', url: `${base}/profiles/broad`, payload: { ...scoped, capabilities: ['domain-intelligence'], targets: [{ kind: 'domain', value: 'northstar.example', includeSubdomains: true }] } })
    expect(broad.statusCode).toBe(400)
    const stale = await h.app.inject({ method: 'PUT', url: `${base}/profiles/stale`, payload: { ...scoped, scope: { ...scoped.scope, expectedPlanRevision: 0 } } })
    expect(stale.statusCode).toBe(400)
  })

  it('permits safe intents for read keys while enforcing action grants and project boundaries', async () => {
    const h = harness({ skipAuth: false })
    const admin = { authorization: `Bearer ${seedSeoKey(h.db, 'admin', ['*'])}` }
    const reader = { authorization: `Bearer ${seedSeoKey(h.db, 'reader', ['read'], 'alpha')}` }
    const runner = { authorization: `Bearer ${seedSeoKey(h.db, 'runner', ['read', 'seo.run'], 'alpha')}` }
    await save(h, seoProfileFixture, admin)
    const intent = await quote(h, reader)
    expect((await h.app.inject({ method: 'POST', url: `${base}/sync`, headers: reader, payload: { quoteToken: intent.token, idempotencyKey: 'denied' } })).statusCode).toBe(403)
    expect((await h.app.inject({ method: 'PUT', url: `${base}/profiles/main`, headers: runner, payload: seoProfileFixture })).statusCode).toBe(403)
    expect((await h.app.inject({ url: '/api/v1/projects/beta/seo/context', headers: runner })).statusCode).toBe(403)
    expect((await sync(h, 'allowed', runner)).statusCode).toBe(202)
  })
})
