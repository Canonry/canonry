import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { SeoRepository, auditLog, emptySeoResults, measurementPlans, measurementPlanVersions, projects, runs, seoBudgets, seoJobs, seoTasks } from '@canonry/canonry-db'
import { canonicalMeasurementPlanV2Json, compareText, seoCompetitorListSchema, seoKeywordGapListSchema, SeoCapabilities, SeoRunStatuses, validationError, type MeasurementPlanV2, type SeoContext, type SeoDomainIntelligence, type SeoProfileInput, type SeoQuote, type SeoRun, type SeoRunDetail } from '@canonry/canonry-contracts'
import { createSeoHarness, seedSeoKey, seoProfileFixture } from './seo-fixture.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const harnesses: ReturnType<typeof createSeoHarness>[] = []
afterEach(async () => { await Promise.all(harnesses.splice(0).map(h => h.close())); vi.useRealTimers() })
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
function seedPlan(h: ReturnType<typeof harness>, plan: MeasurementPlanV2) {
  h.db.insert(measurementPlanVersions).values({ id: 'plan-1', projectId: 'alpha', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: '1'.repeat(64), schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: new Date().toISOString() }).run()
  h.db.insert(measurementPlans).values({ projectId: 'alpha', activeVersionId: 'plan-1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run()
}

// Owning API boundary: mutations must reserve real durable capacity before any callback,
// retries must not reserve twice, and stored reads must never dispatch or expose that ledger.
describe('SEO durable API', () => {
  it('reserves all ceilings atomically, replays accepted receipts, and keeps financial details out of customer reads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-22T12:00:00.000Z'))
    const h = harness(); h.state.policy.accountDailyLimitMicros = 150
    await save(h)
    const intent = await quote(h)
    const fresh = await quote(h)
    expect(fresh.expiresAt).toBe(intent.expiresAt)
    expect(fresh.token).not.toBe(intent.token)
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
    const changedKeyReplay = await h.app.inject({ method: 'POST', url: `${base}/sync`, payload: { ...request, idempotencyKey: 'different-key-same-intent' } })
    expect(changedKeyReplay.statusCode).toBe(200); expect(changedKeyReplay.json().id).toBe(run.id)
    expect(h.requested).toEqual([run.id])
    expect(h.db.select({ entityId: auditLog.entityId }).from(auditLog).where(eq(auditLog.action, 'seo.sync.requested')).all()).toEqual([{ entityId: run.id }])
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
    const deletedReplay = await h.app.inject({ method: 'POST', url: `${base}/sync`, payload: { quoteToken: intent.token, idempotencyKey: 'different-key-after-delete' } })
    expect(deletedReplay.statusCode).toBe(404)
    expect(h.requested).toEqual([id])
    expect(h.db.select().from(seoJobs).all()).toHaveLength(1)
    expect(h.db.select().from(seoBudgets).all().map(row => row.reservedMicros)).toEqual([100, 100, 100])
  })

  it('rejects alternate signature encodings instead of admitting the same intent twice', async () => {
    const h = harness(); await save(h); const intent = await quote(h)
    const accepted = await h.app.inject({ method: 'POST', url: `${base}/sync`, payload: { quoteToken: intent.token, idempotencyKey: 'canonical' } })
    expect(accepted.statusCode).toBe(202)
    const replay = await h.app.inject({ method: 'POST', url: `${base}/sync`, payload: { quoteToken: `${intent.token}=`, idempotencyKey: 'padded-signature' } })
    expect(replay.statusCode).toBe(400)
    expect(h.requested).toEqual([accepted.json<SeoRun>().id])
    expect(h.db.select().from(seoJobs).all()).toHaveLength(1)
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

  it('excludes operator-rejected task facts from partial evidence while preserving their private receipt', async () => {
    const h = harness({ skipAuth: false, operatorApiKeyIds: ['operator'] })
    const operator = { authorization: `Bearer ${seedSeoKey(h.db, 'operator', ['*'])}` }
    const target = { kind: 'domain' as const, value: 'alpha.com', includeSubdomains: true }
    await save(h, { ...seoProfileFixture, capabilities: ['domain-intelligence'], targets: [target, { ...target, value: 'beta.com' }] }, operator)
    const id = (await sync(h, 'rejected-evidence', operator)).json<SeoRun>().id
    const repo = new SeoRepository(h.db)
    for (let task = repo.claim(id, { ...h.state.policy, accountKey: h.state.accountKey }); task; task = repo.claim(id, { ...h.state.policy, accountKey: h.state.accountKey })) {
      const rejected = task.request.target!.value === 'alpha.com'
      const domain: SeoDomainIntelligence = { target: task.request.target!, organicKeywords: rejected ? 43 : 900, estimatedOrganicTraffic: 1200, estimatedOrganicTrafficValueUsd: 77, top1: 2, top2To3: 5, top4To10: 10, top11To20: 4, provenance: { provider: 'dataforseo', dataset: 'google-labs', engine: 'google', locationCode: 2840, languageCode: 'en', device: 'unspecified', collectedAt: new Date().toISOString(), sourceUpdatedAt: null } }
      repo.settle(task.id, { outcome: 'completed', tasks: [{ remoteTaskId: task.id, statusCode: 20000, costMicros: rejected ? null : 10 }], results: { ...emptySeoResults(), domainIntelligence: [domain] }, error: null, fetchedAt: new Date().toISOString() }, task.leaseOwner!)
      if (rejected) {
        const response = await h.app.inject({ method: 'POST', url: `/api/v1/seo/operator/tasks/${task.id}/reconcile`, headers: operator, payload: { actualCostMicros: 10, remoteTaskId: task.id, outcome: 'failed', note: 'Verified upstream task failed; reject its collected evidence.' } })
        expect(response.statusCode, response.body).toBe(200)
        expect(h.db.select().from(seoTasks).where(eq(seoTasks.id, task.id)).get()).toMatchObject({ status: 'failed', results: { domainIntelligence: [domain] } })
      }
    }
    const overview = await h.app.inject({ url: `${base}/overview?profileId=main`, headers: operator })
    expect(overview.json()).toMatchObject({ evidenceRunId: id, evidenceRun: { status: 'partial' }, domainIntelligenceCount: 1, summary: null })
    const detail = (await h.app.inject({ url: `${base}/runs/${id}`, headers: operator })).json()
    expect(detail.resultCounts.domainIntelligence).toBe(1)
    expect(detail.results.domainIntelligence.map((row: SeoDomainIntelligence) => row.target.value)).toEqual(['beta.com'])
    const evidence = (await h.app.inject({ url: `${base}/domain-intelligence?runId=${id}`, headers: operator })).json()
    expect(evidence.total).toBe(1)
    expect(evidence.items.map((row: SeoDomainIntelligence) => row.target.value)).toEqual(['beta.com'])
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
      // A historical task has no result arrays for capabilities added after it was collected.
      h.db.update(seoTasks).set({ results: { keywordMetrics: [], rankedKeywords: [], domainIntelligence: [domain] } }).where(eq(seoTasks.id, task.id)).run()
    }
    const next = await sync(h, 'next')
    const overview = (await h.app.inject({ url: `${base}/overview?profileId=main` })).json()
    expect(overview).toMatchObject({ evidenceRunId: id, latestRun: { id: next.json().id, status: 'queued' }, summary: { target, organicKeywords: 43, inTop10: 17, estimatedOrganicTraffic: 1200 } })
    const page = (await h.app.inject({ url: `${base}/domain-intelligence?profileId=main&limit=1&offset=1` })).json()
    expect(page).toMatchObject({ runId: id, total: 2, limit: 1, offset: 1 }); expect(page.items).toHaveLength(1)
    for (const endpoint of ['competitors', 'keyword-gaps']) {
      expect((await h.app.inject({ url: `${base}/${endpoint}?profileId=main` })).json()).toMatchObject({ runId: id, total: 0, items: [] })
    }
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
    seedPlan(h, plan)
    const context = (await h.app.inject({ url: `${base}/context` })).json<SeoContext>()
    expect(context.scopes.find(scope => scope.kind === 'market' && scope.key === 'north')).toMatchObject({ supported: true, capabilities: ['keyword-metrics'] })
    expect(context.scopes.find(scope => scope.kind === 'group')).toMatchObject({ supported: true, capabilities: ['keyword-metrics'] })
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

  it.each(['property', 'group', 'market'] as const)('matches canonical Advanced %s host identity while preserving the exact provider hostname', async kind => {
    const h = harness()
    const source = measurementPlanV2Fixture()
    seedPlan(h, measurementPlanV2Fixture({
      targets: source.targets.map(target => ({ ...target, urlMatchers: [{ kind: 'host', host: target.stableKey === 'harbor' ? 'northstar.com' : 'bay.northstar.com' }] })),
      reportingScopes: [{ stableKey: 'north', label: 'North', kind: 'market', usageEdges: [{ executionNodeKey: 'exec-nearby', targetKey: 'harbor', queryId: 'q-nearby' }] }],
    }))
    const scope = { kind, key: kind === 'property' ? 'harbor' : kind === 'group' ? 'regional' : 'north', expectedPlanRevision: 1 }
    const context = (await h.app.inject({ url: `${base}/context` })).json<SeoContext>()
    const target = { kind: 'host' as const, value: 'www.northstar.com', includeSubdomains: false }
    const input = { ...seoProfileFixture, scope, capabilities: [SeoCapabilities['ranked-keywords']], targets: [target] }
    await save(h, input)
    const accepted = await sync(h, `exact-${kind}`)
    expect(accepted.statusCode, accepted.body).toBe(202)
    expect(h.db.select().from(seoTasks).get()?.request.target).toEqual(target)
    expect(context.scopes.find(option => option.kind === kind && option.key === scope.key)).toMatchObject({ supported: true, capabilities: ['keyword-metrics', 'ranked-keywords'] })
    const foreign = await h.app.inject({ method: 'PUT', url: `${base}/profiles/foreign`, payload: { ...input, targets: [{ ...target, value: 'shop.northstar.com' }] } })
    expect(foreign.statusCode).toBe(400)
    expect(foreign.json().error.message).toContain('belonging to a selected Property')
    const wholeDomain = await h.app.inject({ method: 'PUT', url: `${base}/profiles/whole-domain`, payload: { ...input, capabilities: ['domain-intelligence'], targets: [{ kind: 'domain', value: 'northstar.com', includeSubdomains: true }] } })
    expect(wholeDomain.statusCode).toBe(400)
    expect(wholeDomain.json().error.message).toContain('Domain intelligence requires project scope')
  })

  it('preserves actionable adapter validation while sanitizing unexpected preparation failures', async () => {
    const h = harness()
    h.adapter.estimate = () => { throw validationError('Keyword metrics require keywords that are distinct ignoring letter case.') }
    const invalid = await h.app.inject({ method: 'PUT', url: `${base}/profiles/main`, payload: { ...seoProfileFixture, keywords: ['coffee', 'Coffee'] } })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error.message).toBe('Keyword metrics require keywords that are distinct ignoring letter case.')
    h.adapter.estimate = () => { throw new Error('private-cost-cap=123456 password=example-secret') }
    const unexpected = await h.app.inject({ method: 'PUT', url: `${base}/profiles/main`, payload: seoProfileFixture })
    expect(unexpected.statusCode).toBe(400)
    expect(unexpected.json().error.message).toContain('could not prepare this request')
    expect(unexpected.body).not.toMatch(/123456|example-secret|unsupported scope/)
  })

  it('reports task status counts without decoding stored evidence in run summaries', async () => {
    const h = harness()
    await save(h, { ...seoProfileFixture, capabilities: ['domain-intelligence', 'ranked-keywords'], targets: [{ kind: 'domain', value: 'alpha.com', includeSubdomains: true }, { kind: 'domain', value: 'beta.com', includeSubdomains: true }] })
    const accepted = await sync(h, 'summary'); const id = accepted.json<SeoRun>().id
    const repo = new SeoRepository(h.db)
    for (const outcome of ['completed', 'completed', 'partial', 'failed'] as const) {
      const task = repo.claim(id, { ...h.state.policy, accountKey: h.state.accountKey })!
      repo.settle(task.id, { outcome, tasks: [{ remoteTaskId: task.id, statusCode: 20000, costMicros: 10 }], results: emptySeoResults(), error: null, fetchedAt: new Date().toISOString() }, task.leaseOwner!)
    }
    // Status remains inspectable even if a historical evidence blob cannot be decoded.
    h.db.$client.prepare('UPDATE seo_tasks SET results = ? WHERE job_id = ?').run('unreadable historical evidence', id)
    const listed = await h.app.inject({ url: `${base}/runs?profileId=main` })
    expect(listed.statusCode, listed.body).toBe(200)
    expect(listed.json().runs).toMatchObject([{ id, status: 'partial', taskCount: 4, completedTasks: 3, failedTasks: 1 }])
  })

  it.each(['seo', 'activity'] as const)('audits %s cancellation only when the run changes and rejects terminal runs', async surface => {
    const cancelUrl = (id: string) => surface === 'seo' ? `${base}/runs/${id}/cancel` : `/api/v1/runs/${id}/cancel`
    const h = harness(); await save(h)
    const cancelled = (await sync(h, 'cancel')).json<SeoRun>()
    const response = await h.app.inject({ method: 'POST', url: cancelUrl(cancelled.id) })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: cancelled.id, status: 'cancelled' })
    const repeated = await h.app.inject({ method: 'POST', url: cancelUrl(cancelled.id) })
    expect(repeated.statusCode).toBe(400)
    expect(repeated.json().error.message).toBe('This SEO refresh has already finished.')
    const completed = (await sync(h, 'completed')).json<SeoRun>()
    const repo = new SeoRepository(h.db); const task = repo.claim(completed.id, { ...h.state.policy, accountKey: h.state.accountKey })!
    repo.settle(task.id, { outcome: 'completed', tasks: [{ remoteTaskId: task.id, statusCode: 20000, costMicros: 10 }], results: emptySeoResults(), error: null, fetchedAt: new Date().toISOString() }, task.leaseOwner!)
    const terminal = await h.app.inject({ method: 'POST', url: cancelUrl(completed.id) })
    expect(terminal.statusCode).toBe(400)
    expect(terminal.json().error.message).toBe('This SEO refresh has already finished.')
    expect((await h.app.inject({ url: `${base}/runs/${completed.id}` })).json()).toMatchObject({ status: 'completed', cancelRequested: false })
    const active = (await sync(h, 'active')).json<SeoRun>()
    repo.claim(active.id, { ...h.state.policy, accountKey: h.state.accountKey })
    for (let attempt = 0; attempt < 2; attempt++) {
      const inFlight = await h.app.inject({ method: 'POST', url: cancelUrl(active.id) })
      expect(inFlight.statusCode).toBe(200)
      expect(inFlight.json()).toMatchObject({ status: 'running' })
      expect((await h.app.inject({ url: `${base}/runs/${active.id}` })).json()).toMatchObject({ cancelRequested: true })
    }
    expect(h.db.select({ entityId: auditLog.entityId }).from(auditLog).where(eq(auditLog.action, 'seo.sync.cancelled')).all()).toEqual([{ entityId: cancelled.id }, { entityId: active.id }])
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
    for (const endpoint of ['competitors', 'keyword-gaps']) {
      expect((await h.app.inject({ url: `${base}/${endpoint}?profileId=main`, headers: reader })).statusCode).toBe(200)
      expect((await h.app.inject({ url: `/api/v1/projects/beta/seo/${endpoint}`, headers: reader })).statusCode).toBe(403)
    }
    const runIntent = await quote(h, runner)
    expect((await h.app.inject({ method: 'POST', url: `${base}/sync`, headers: runner, payload: { quoteToken: runIntent.token, idempotencyKey: 'allowed' } })).statusCode).toBe(202)
    expect((await h.app.inject({ method: 'POST', url: `${base}/sync`, headers: admin, payload: { quoteToken: runIntent.token, idempotencyKey: 'other-principal' } })).statusCode).toBe(400)
  })

  it('freezes each explicit competitor pair and both gap populations under one bounded intent', async () => {
    const h = harness()
    const target = { kind: 'domain' as const, value: 'ALPHA.com', includeSubdomains: true }
    const competitors = ['BETA.com', 'gamma.com'].map(value => ({ ...target, value }))
    const input: SeoProfileInput = { ...seoProfileFixture, capabilities: [SeoCapabilities['competitor-discovery'], SeoCapabilities['keyword-gaps']], targets: [target], competitors, keywords: [] }
    await save(h, input)
    const intent = await quote(h)
    expect(intent.taskCount).toBe(5)
    expect(h.requested).toEqual([])
    const response = await h.app.inject({ method: 'POST', url: `${base}/sync`, payload: { quoteToken: intent.token, idempotencyKey: 'competitive' } })
    expect(response.statusCode, response.body).toBe(202)
    const stored = h.db.select().from(seoTasks).all()
    expect(stored.map(task => [task.request.capability, task.request.target?.value, task.request.comparison?.competitor.value, task.request.comparison?.mode].join('|')).sort()).toEqual([
      'competitor-discovery|alpha.com||',
      'keyword-gaps|alpha.com|beta.com|missing',
      'keyword-gaps|alpha.com|beta.com|shared',
      'keyword-gaps|alpha.com|gamma.com|missing',
      'keyword-gaps|alpha.com|gamma.com|shared',
    ])
    const detail = (await h.app.inject({ url: `${base}/runs/${response.json<SeoRun>().id}` })).json<SeoRunDetail>()
    expect(detail.tasks.map(task => task.comparison).sort((a, b) => compareText(a?.competitor.value ?? '', b?.competitor.value ?? '') || compareText(a?.mode ?? '', b?.mode ?? ''))).toEqual([
      null,
      { competitor: { kind: 'domain', value: 'beta.com', includeSubdomains: true }, mode: 'missing' },
      { competitor: { kind: 'domain', value: 'beta.com', includeSubdomains: true }, mode: 'shared' },
      { competitor: { kind: 'domain', value: 'gamma.com', includeSubdomains: true }, mode: 'missing' },
      { competitor: { kind: 'domain', value: 'gamma.com', includeSubdomains: true }, mode: 'shared' },
    ])
    expect(h.db.select().from(seoBudgets).all().map(row => row.reservedMicros)).toEqual([500, 500, 500])
    expect(h.db.select().from(seoJobs).get()?.profile.competitors?.map(competitor => competitor.value)).toEqual(['beta.com', 'gamma.com'])
    const staleIntent = await quote(h)
    await save(h, { ...input, competitors: [competitors[0]!] })
    const stale = await h.app.inject({ method: 'POST', url: `${base}/sync`, payload: { quoteToken: staleIntent.token, idempotencyKey: 'stale-comparison' } })
    expect(stale.statusCode).toBe(400)
    expect(h.requested).toEqual([response.json<SeoRun>().id])
    expect(h.state.executions).toBe(0)
  })

  it('filters and sorts all saved comparison rows before pagination while retaining the last evidence during refresh', async () => {
    const h = harness()
    const target = { kind: 'domain' as const, value: 'alpha.com', includeSubdomains: true }
    const competitor = { ...target, value: 'beta.com' }
    await save(h, { ...seoProfileFixture, capabilities: [SeoCapabilities['competitor-discovery'], SeoCapabilities['keyword-gaps']], targets: [target], competitors: [competitor], keywords: [] })
    const accepted = await sync(h, 'facts'); const id = accepted.json<SeoRun>().id
    const repo = new SeoRepository(h.db)
    const provenance = { provider: 'dataforseo' as const, dataset: 'google-labs', engine: 'google' as const, locationCode: 2840, languageCode: 'en', device: 'unspecified' as const, collectedAt: '2026-10-27T12:00:00.000Z', sourceUpdatedAt: null }
    const gap = { target, competitor, keyword: 'shared search', targetRankOrganic: 2, competitorRankOrganic: 5, targetUrl: 'https://alpha.com/page', competitorUrl: 'https://beta.com/page', searchVolume: 100, keywordDifficulty: 25, cpcUsd: 1.25, kind: 'shared' as const, rankGap: -3, provenance }
    for (let task = repo.claim(id, { ...h.state.policy, accountKey: h.state.accountKey }); task; task = repo.claim(id, { ...h.state.policy, accountKey: h.state.accountKey })) {
      const results = emptySeoResults()
      if (task.request.capability === SeoCapabilities['competitor-discovery']) results.competitors = [
        { target, domain: 'gamma.com', sharedKeywords: 12, averagePosition: 2, organicKeywords: 200, estimatedOrganicTraffic: 500, provenance },
        { target, domain: 'delta.com', sharedKeywords: null, averagePosition: null, organicKeywords: null, estimatedOrganicTraffic: null, provenance },
        { target, domain: 'beta.com', sharedKeywords: 88, averagePosition: 4.5, organicKeywords: 500, estimatedOrganicTraffic: 1200, provenance },
      ]
      else if (task.request.comparison?.mode === 'shared') results.keywordGaps = [gap, { ...gap, keyword: 'outranked search', targetRankOrganic: 9, kind: 'outranked', rankGap: 4 }]
      else results.keywordGaps = [{ ...gap, keyword: 'missing search', targetRankOrganic: null, targetUrl: null, kind: 'missing', rankGap: null }]
      repo.settle(task.id, { outcome: 'completed', tasks: [{ remoteTaskId: task.id, statusCode: 20000, costMicros: 10 }], results, error: null, fetchedAt: provenance.collectedAt }, task.leaseOwner!)
    }
    const next = await sync(h, 'next-facts')
    const shared = seoKeywordGapListSchema.parse((await h.app.inject({ url: `${base}/keyword-gaps?profileId=main&kind=shared&offset=1&limit=1` })).json())
    expect(shared).toMatchObject({ runId: id, total: 2, limit: 1, offset: 1, items: [{ keyword: 'outranked search', targetRankOrganic: 9, competitorRankOrganic: 5, rankGap: 4 }] })
    for (const kind of ['missing', 'outranked']) {
      const page = seoKeywordGapListSchema.parse((await h.app.inject({ url: `${base}/keyword-gaps?runId=${id}&kind=${kind}` })).json())
      expect(page.total).toBe(1)
      expect(page.items.map(row => row.kind)).toEqual([kind])
    }
    const discovered = seoCompetitorListSchema.parse((await h.app.inject({ url: `${base}/competitors?profileId=main` })).json())
    expect(discovered).toMatchObject({ runId: id, total: 3 })
    expect(discovered.items.map(row => [row.domain, row.estimatedOrganicTraffic])).toEqual([['gamma.com', 500], ['delta.com', null], ['beta.com', 1200]])
    for (const [sort, expected] of [['traffic', ['gamma.com', 'beta.com', 'delta.com']], ['-traffic', ['beta.com', 'gamma.com', 'delta.com']]] as const) {
      const pages = await Promise.all([0, 1, 2].map(offset => h.app.inject({ url: `${base}/competitors?runId=${id}&sort=${sort}&limit=1&offset=${offset}` })))
      const parsed = pages.map(page => seoCompetitorListSchema.parse(page.json()))
      expect(parsed.map(page => page.total)).toEqual([3, 3, 3])
      expect(parsed.flatMap(page => page.items.map(row => row.domain))).toEqual(expected)
    }
    for (const [sort, expected] of [['target-rank', ['shared search', 'outranked search']], ['-target-rank', ['outranked search', 'shared search']]] as const) {
      const pages = await Promise.all([0, 1].map(offset => h.app.inject({ url: `${base}/keyword-gaps?runId=${id}&kind=shared&sort=${sort}&limit=1&offset=${offset}` })))
      const parsed = pages.map(page => seoKeywordGapListSchema.parse(page.json()))
      expect(parsed.map(page => page.total)).toEqual([2, 2])
      expect(parsed.flatMap(page => page.items.map(row => row.keyword))).toEqual(expected)
      const nullPage = seoKeywordGapListSchema.parse((await h.app.inject({ url: `${base}/keyword-gaps?runId=${id}&sort=${sort}&limit=1&offset=2` })).json())
      expect(nullPage).toMatchObject({ total: 3, items: [{ keyword: 'missing search', targetRankOrganic: null }] })
    }
    const overview = (await h.app.inject({ url: `${base}/overview?profileId=main` })).json()
    expect(overview).toMatchObject({ latestRun: { id: next.json().id }, evidenceRunId: id, competitorCount: 3, keywordGapCount: 3 })
    const detail = (await h.app.inject({ url: `${base}/runs/${id}` })).json()
    expect(detail.resultCounts).toMatchObject({ competitors: 3, keywordGaps: 3 })
    expect((await h.app.inject({ url: `${base}/keyword-gaps?kind=invalid` })).statusCode).toBe(400)
    expect((await h.app.inject({ url: `${base}/keyword-gaps?limit=101` })).statusCode).toBe(400)
    for (const endpoint of ['competitors', 'keyword-gaps']) expect((await h.app.inject({ url: `${base}/${endpoint}?sort=invalid` })).statusCode).toBe(400)
    expect(h.state.executions).toBe(0)
  })

  it('keeps whole-domain research available in Advanced project scope without substituting it for Properties or markets', async () => {
    const h = harness()
    seedPlan(h, measurementPlanV2Fixture({ reportingScopes: [{ stableKey: 'north', label: 'North', kind: 'market', usageEdges: [{ executionNodeKey: 'exec-nearby', targetKey: 'harbor', queryId: 'q-nearby' }] }] }))
    const input: SeoProfileInput = { ...seoProfileFixture, capabilities: [SeoCapabilities['competitor-discovery'], SeoCapabilities['keyword-gaps']], targets: [{ kind: 'domain', value: 'alpha.com', includeSubdomains: true }], competitors: [{ kind: 'domain', value: 'beta.com', includeSubdomains: true }], keywords: [], scope: { kind: 'project', expectedPlanRevision: 1 } }
    await save(h, input)
    expect((await sync(h, 'advanced-domain')).statusCode).toBe(202)
    expect(h.db.select().from(seoJobs).get()?.scopeSnapshot).toMatchObject({ mode: 'advanced', planRevision: 1, scope: input.scope })
    const context = (await h.app.inject({ url: `${base}/context` })).json<SeoContext>()
    expect(context.scopes.find(scope => scope.kind === 'project')?.capabilities).toEqual(expect.arrayContaining(input.capabilities))
    for (const scope of [{ kind: 'property' as const, key: 'harbor' }, { kind: 'group' as const, key: 'regional' }, { kind: 'market' as const, key: 'north' }]) {
      const scoped = { ...scope, expectedPlanRevision: 1 }
      const response = await h.app.inject({ method: 'PUT', url: `${base}/profiles/${scope.kind}`, payload: { ...input, scope: scoped } })
      expect(response.statusCode, response.body).toBe(400)
      expect(response.json().error.message).toContain('Select project scope')
      expect(context.scopes.find(option => option.kind === scope.kind && option.key === scope.key)?.capabilities).not.toContain(SeoCapabilities['competitor-discovery'])
    }
  })

  it.each([
    { label: 'no competitors', patch: { competitors: [] }, message: 'at least one explicit competitor' },
    { label: 'duplicate competitors', patch: { competitors: [{ kind: 'domain', value: 'beta.com', includeSubdomains: true }, { kind: 'domain', value: 'BETA.com', includeSubdomains: true }] }, message: 'must be distinct' },
    { label: 'self comparison', patch: { competitors: [{ kind: 'domain', value: 'alpha.com', includeSubdomains: true }] }, message: 'must differ' },
    { label: 'exact host target', patch: { targets: [{ kind: 'host', value: 'alpha.com', includeSubdomains: false }] }, message: 'root domain Targets' },
    { label: 'competitors without gaps', patch: { capabilities: [SeoCapabilities['competitor-discovery']] }, message: 'apply only to keyword gaps' },
  ])('rejects $label before saving or admitting comparison work', async ({ patch, message }) => {
    const h = harness()
    const response = await h.app.inject({ method: 'PUT', url: `${base}/profiles/invalid`, payload: { ...seoProfileFixture, capabilities: [SeoCapabilities['keyword-gaps']], targets: [{ kind: 'domain', value: 'alpha.com', includeSubdomains: true }], competitors: [{ kind: 'domain', value: 'beta.com', includeSubdomains: true }], ...patch } })
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().error.message).toContain(message)
    expect(h.db.select().from(seoJobs).all()).toEqual([])
    expect(h.requested).toEqual([])
  })
})
