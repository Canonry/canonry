import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { SeoRepository, competitors, measurementPlans, measurementPlanVersions, projects, queries, seoTasks } from '@canonry/canonry-db'
import {
  SeoCapabilities, SeoProviders, canonicalMeasurementPlanV2Json, emptySeoResults,
  type MeasurementPlanV2, type SeoAdapter, type SeoContext, type SeoMarketRanking, type SeoMarketRankingList, type SeoProfileInput, type SeoQuote, type SeoRun, type SeoRunDetail,
} from '@canonry/canonry-contracts'
import { createSeoHarness, seoProfileFixture } from './seo-fixture.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

// Owning API boundary for market rankings: which searches a profile plans from the project's
// markets and tracked queries, and how their stored rows read back.
const harnesses: ReturnType<typeof createSeoHarness>[] = []
afterEach(async () => { await Promise.all(harnesses.splice(0).map(h => h.close())) })
const base = '/api/v1/projects/alpha/seo'
const policy = { maxRunCostMicros: 10_000_000, accountDailyLimitMicros: 10_000_000, accountMonthlyLimitMicros: 10_000_000, projectMonthlyLimitMicros: 10_000_000 }
// Prices a search like the live SERP catalog does: one unit per 10 results checked.
const adapter: SeoAdapter = {
  provider: SeoProviders.dataforseo, accountKey: 'account-a',
  capabilities: [SeoCapabilities['keyword-metrics'], SeoCapabilities['domain-intelligence'], SeoCapabilities['ranked-keywords'], SeoCapabilities['market-rankings']],
  estimate: request => ({ maxCostMicros: request.capability === SeoCapabilities['market-rankings'] ? 2_000 * request.search!.depth / 10 : 100, catalogRevision: 'prices-1' }),
  execute: () => Promise.reject(new Error('Unexpected live request')),
}
function harness() {
  const h = createSeoHarness({ getSeoRuntime: () => ({ connections: [{ id: 'primary', label: 'Search data', adapter }], policy }) })
  harnesses.push(h)
  return h
}

const node = (stableKey: string, queryId: string, queryText: string) => ({ stableKey, queryId, queryText, context: { providers: ['openai' as const], models: {}, location: null }, expectedSnapshots: 1 })
const snapshot = (queryId: string, queryText: string) => ({ queryId, queryText, provenance: { source: 'manual' as const, sourceId: null, capturedAt: '2026-07-01T00:00:00.000Z' } })
/** One metro with a neighborhood group and market per Property; `q-shared` is asked in both markets. */
function metroPlan(): MeasurementPlanV2 {
  const source = measurementPlanV2Fixture()
  return measurementPlanV2Fixture({
    groups: [
      { stableKey: 'metro', label: 'Coast Metro Area', targetKeys: ['harbor', 'bayside'], competitors: [] },
      { stableKey: 'metro--harbor', label: 'Harbor, Coast', parentGroupKey: 'metro', targetKeys: ['harbor'], competitors: [] },
      { stableKey: 'metro--bayside', label: 'Bayside, Coast', parentGroupKey: 'metro', targetKeys: ['bayside'], competitors: [] },
    ],
    querySnapshots: [snapshot('q-harbor', 'best homes in Harbor, Coast'), snapshot('q-bayside', 'best  homes in Bayside, coast'), snapshot('q-shared', 'homes near the water'), snapshot('q-brand', 'northstar reviews, Coast')],
    assignments: [
      { targetKey: 'harbor', queryId: 'q-harbor', queryClass: 'non-brand', executionNodeKey: 'exec-harbor' },
      { targetKey: 'bayside', queryId: 'q-bayside', queryClass: 'non-brand', executionNodeKey: 'exec-bayside' },
      { targetKey: 'harbor', queryId: 'q-shared', queryClass: 'non-brand', executionNodeKey: 'exec-shared' },
      { targetKey: 'bayside', queryId: 'q-shared', queryClass: 'non-brand', executionNodeKey: 'exec-shared' },
      { targetKey: 'harbor', queryId: 'q-brand', queryClass: 'branded', executionNodeKey: 'exec-brand' },
    ],
    executionNodes: [node('exec-harbor', 'q-harbor', 'best homes in Harbor, Coast'), node('exec-bayside', 'q-bayside', 'best  homes in Bayside, coast'), node('exec-shared', 'q-shared', 'homes near the water'), node('exec-brand', 'q-brand', 'northstar reviews, Coast')],
    usageEdges: [
      { executionNodeKey: 'exec-harbor', targetKey: 'harbor', queryId: 'q-harbor' },
      { executionNodeKey: 'exec-bayside', targetKey: 'bayside', queryId: 'q-bayside' },
      { executionNodeKey: 'exec-shared', targetKey: 'harbor', queryId: 'q-shared' },
      { executionNodeKey: 'exec-shared', targetKey: 'bayside', queryId: 'q-shared' },
      { executionNodeKey: 'exec-brand', targetKey: 'harbor', queryId: 'q-brand' },
    ],
    reportingScopes: [
      { stableKey: 'harbor-market', label: 'Harbor, Coast', kind: 'market', groupKey: 'metro--harbor', usageEdges: [
        { executionNodeKey: 'exec-harbor', targetKey: 'harbor', queryId: 'q-harbor' },
        { executionNodeKey: 'exec-shared', targetKey: 'harbor', queryId: 'q-shared' },
        { executionNodeKey: 'exec-brand', targetKey: 'harbor', queryId: 'q-brand' },
      ] },
      { stableKey: 'bayside-market', label: 'Bayside, Coast', kind: 'market', groupKey: 'metro--bayside', usageEdges: [
        { executionNodeKey: 'exec-bayside', targetKey: 'bayside', queryId: 'q-bayside' },
        { executionNodeKey: 'exec-shared', targetKey: 'bayside', queryId: 'q-shared' },
      ] },
    ],
    targets: source.targets,
  })
}
function seedPlan(h: ReturnType<typeof harness>, plan: MeasurementPlanV2) {
  const now = new Date().toISOString()
  h.db.insert(measurementPlanVersions).values({ id: 'plan-1', projectId: 'alpha', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: '1'.repeat(64), schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: now }).run()
  h.db.insert(measurementPlans).values({ projectId: 'alpha', activeVersionId: 'plan-1', createdAt: now, updatedAt: now }).run()
}

const site = { kind: 'domain' as const, value: 'alpha.com', includeSubdomains: true }
function rankingProfile(locations: Array<{ key: string; locationCode: number; label: string }>, overrides: Partial<SeoProfileInput> = {}): SeoProfileInput {
  return {
    ...seoProfileFixture, name: 'Market rankings', capabilities: [SeoCapabilities['market-rankings']], keywords: [], targets: [site],
    scope: { kind: 'project', expectedPlanRevision: 1 },
    rankings: { locations, depth: 50, device: 'mobile', searchText: 'query-without-market-region' },
    ...overrides,
  }
}
async function put(h: ReturnType<typeof harness>, input: SeoProfileInput, id = 'markets') {
  return h.app.inject({ method: 'PUT', url: `${base}/profiles/${id}`, payload: input })
}
async function refresh(h: ReturnType<typeof harness>, key: string, id = 'markets') {
  const intent = (await h.app.inject({ method: 'POST', url: `${base}/refresh-intents`, payload: { profileId: id } })).json<SeoQuote>()
  const response = await h.app.inject({ method: 'POST', url: `${base}/sync`, payload: { quoteToken: intent.token, idempotencyKey: key } })
  expect(response.statusCode, response.body).toBe(202)
  return response.json<SeoRun>()
}
const plannedSearches = (h: ReturnType<typeof harness>, runId: string) => h.db.select().from(seoTasks).where(eq(seoTasks.jobId, runId)).all()
  .map(task => ({ text: task.request.keywords[0], location: task.request.locationCode, reserved: task.reservedMicros, markets: task.request.search!.markets.map(market => `${market.marketKey}:${market.queryId}`).sort() }))
  .sort((a, b) => a.location - b.location || a.text!.localeCompare(b.text!))

describe('SEO market rankings', () => {
  it('searches each market\'s non-brand queries from its nearest mapped location, once per search text and location', async () => {
    const h = harness(); seedPlan(h, metroPlan())
    h.db.insert(competitors).values([
      { id: 'c1', projectId: 'alpha', domain: 'www.rival.com', createdAt: new Date().toISOString() },
      { id: 'c2', projectId: 'alpha', domain: 'alpha.com', createdAt: new Date().toISOString() },
    ]).run()
    const metroOnly = await put(h, rankingProfile([{ key: 'metro', locationCode: 200001, label: 'Coast Metro' }]))
    expect(metroOnly.statusCode, metroOnly.body).toBe(200)
    const first = await refresh(h, 'metro-only')
    // Both markets resolve the metro's location, so the query they share runs once and answers both.
    expect(plannedSearches(h, first.id)).toEqual([
      { text: 'best homes in Bayside', location: 200001, reserved: 10_000, markets: ['bayside-market:q-bayside'] },
      { text: 'best homes in Harbor', location: 200001, reserved: 10_000, markets: ['harbor-market:q-harbor'] },
      { text: 'homes near the water', location: 200001, reserved: 10_000, markets: ['bayside-market:q-shared', 'harbor-market:q-shared'] },
    ])
    const task = h.db.select().from(seoTasks).where(eq(seoTasks.jobId, first.id)).all().find(row => row.request.keywords[0] === 'best homes in Harbor')!
    expect(task.request).toMatchObject({
      capability: 'market-rankings', target: site, locationCode: 200001,
      search: {
        device: 'mobile', depth: 50, locationLabel: 'Coast Metro', competitors: ['rival.com'],
        markets: [{ marketKey: 'harbor-market', marketLabel: 'Harbor, Coast', regionKey: 'metro', regionLabel: 'Coast Metro Area', queryId: 'q-harbor', queryText: 'best homes in Harbor, Coast', queryClass: 'non-brand' }],
      },
    })
    // A neighborhood group's own location wins over its metro's.
    expect((await put(h, rankingProfile([{ key: 'metro', locationCode: 200001, label: 'Coast Metro' }, { key: 'metro--bayside', locationCode: 200002, label: 'Bayside' }]))).statusCode).toBe(200)
    const second = await refresh(h, 'bayside-override')
    expect(plannedSearches(h, second.id).map(search => [search.location, search.text, search.markets])).toEqual([
      [200001, 'best homes in Harbor', ['harbor-market:q-harbor']],
      [200001, 'homes near the water', ['harbor-market:q-shared']],
      [200002, 'best homes in Bayside', ['bayside-market:q-bayside']],
      [200002, 'homes near the water', ['bayside-market:q-shared']],
    ])
  })

  it('offers market rankings for project, group and market scopes but not a single Property', async () => {
    const h = harness(); seedPlan(h, metroPlan())
    const context = (await h.app.inject({ url: `${base}/context` })).json<SeoContext>()
    const supports = (kind: string, key: string | null) => context.scopes.find(scope => scope.kind === kind && scope.key === key)?.capabilities?.includes(SeoCapabilities['market-rankings'])
    expect([supports('project', null), supports('group', 'metro'), supports('market', 'harbor-market'), supports('property', 'harbor')]).toEqual([true, true, true, false])
    const property = await put(h, rankingProfile([{ key: 'metro', locationCode: 200001, label: 'Coast Metro' }], { scope: { kind: 'property', key: 'harbor', expectedPlanRevision: 1 } }))
    expect(property.statusCode).toBe(400)
    // A group scope plans only the markets under it.
    expect((await put(h, rankingProfile([{ key: 'metro', locationCode: 200001, label: 'Coast Metro' }], { scope: { kind: 'group', key: 'metro--harbor', expectedPlanRevision: 1 } }))).statusCode).toBe(200)
    const run = await refresh(h, 'harbor-group')
    expect(plannedSearches(h, run.id).flatMap(search => search.markets)).toEqual(['harbor-market:q-harbor', 'harbor-market:q-shared'])
  })

  it.each([
    ['a market without a location', rankingProfile([{ key: 'metro--bayside', locationCode: 200002, label: 'Bayside' }]), 'Set a search location for 1 market or their groups: Harbor, Coast.'],
    ['a target that is not the project\'s site', rankingProfile([{ key: 'metro', locationCode: 200001, label: 'Coast Metro' }], { targets: [{ kind: 'domain', value: 'rival.com', includeSubdomains: true }] }), 'must be one of this project\'s own domains'],
    ['other datasets in the same profile', rankingProfile([{ key: 'metro', locationCode: 200001, label: 'Coast Metro' }], { capabilities: ['market-rankings', 'ranked-keywords'] }), 'Keep market rankings in their own profile'],
    ['explicit keywords', rankingProfile([{ key: 'metro', locationCode: 200001, label: 'Coast Metro' }], { keywords: ['homes for sale'] }), 'Leave keywords empty'],
    ['missing search settings', { ...rankingProfile([]), rankings: undefined }, 'need search settings'],
    ['a location set twice', rankingProfile([{ key: 'metro', locationCode: 200001, label: 'Coast Metro' }, { key: 'metro', locationCode: 200003, label: 'Other' }]), 'Set each market location once'],
  ])('refuses a profile with %s', async (_label, input, message) => {
    const h = harness(); seedPlan(h, metroPlan())
    const response = await put(h, input)
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain(message)
  })

  it('uses each Simple location as a market and the profile location for a project without locations', async () => {
    const h = harness()
    const now = new Date().toISOString()
    h.db.insert(queries).values([
      { id: 'q1', projectId: 'alpha', query: 'best solar installer', createdAt: now },
      { id: 'q2', projectId: 'alpha', query: 'alpha reviews', createdAt: now },
    ]).run()
    const simple = (locations: Array<{ key: string; locationCode: number; label: string }>) => rankingProfile(locations, { scope: { kind: 'project' } })
    expect((await put(h, simple([]))).statusCode).toBe(200)
    const whole = await refresh(h, 'whole-project')
    // The branded query names the project, so only the non-brand one is searched, as written.
    expect(plannedSearches(h, whole.id)).toEqual([{ text: 'best solar installer', location: 2840, reserved: 10_000, markets: ['project:q1'] }])
    h.db.update(projects).set({ locations: [{ label: 'Phoenix', city: 'Phoenix', region: 'AZ', country: 'US' }, { label: 'Tucson', city: 'Tucson', region: 'AZ', country: 'US' }] }).where(eq(projects.id, 'alpha')).run()
    const partial = await put(h, simple([{ key: 'Phoenix', locationCode: 1013462, label: 'Phoenix, AZ' }]))
    expect(partial.statusCode).toBe(400)
    expect(partial.json().error.message).toContain('Tucson')
    expect((await put(h, simple([{ key: 'Phoenix', locationCode: 1013462, label: 'Phoenix, AZ' }, { key: 'Tucson', locationCode: 1013463, label: 'Tucson, AZ' }]))).statusCode).toBe(200)
    const located = await refresh(h, 'per-location')
    expect(plannedSearches(h, located.id).map(search => [search.location, search.text, search.markets])).toEqual([
      [1013462, 'best solar installer', ['Phoenix:q1']],
      [1013463, 'best solar installer', ['Tucson:q1']],
    ])
  })

  it('reads stored rankings by region and market, counts them, and reads tasks saved before market rankings as empty', async () => {
    const h = harness(); seedPlan(h, metroPlan())
    await put(h, rankingProfile([{ key: 'metro', locationCode: 200001, label: 'Coast Metro' }]))
    const run = await refresh(h, 'evidence')
    const repo = new SeoRepository(h.db)
    const rank: Record<string, number | null> = { 'best homes in Harbor': 4, 'best homes in Bayside': null, 'homes near the water': 12 }
    for (let task = repo.claim(run.id, { ...policy, accountKey: 'account-a' }); task; task = repo.claim(run.id, { ...policy, accountKey: 'account-a' })) {
      const search = task.request.search!
      const rows: SeoMarketRanking[] = search.markets.map(market => ({
        ...market, searchText: task.request.keywords[0]!, locationLabel: search.locationLabel, target: site,
        rankOrganic: rank[task.request.keywords[0]!] ?? null, rankAbsolute: null, url: null, depth: search.depth, competitors: [],
        provenance: { provider: 'dataforseo', dataset: 'dataforseo-serp/google/market-rankings', engine: 'google', locationCode: task.request.locationCode, languageCode: 'en', device: 'mobile', collectedAt: '2026-10-25T00:00:00.000Z', sourceUpdatedAt: null },
      }))
      repo.settle(task.id, { outcome: 'completed', tasks: [{ remoteTaskId: task.id, statusCode: 20000, costMicros: 10_000 }], results: { ...emptySeoResults(), marketRankings: rows }, error: null, fetchedAt: new Date().toISOString() }, task.leaseOwner!)
    }
    const read = async (query: string) => (await h.app.inject({ url: `${base}/market-rankings?profileId=markets${query}` })).json<SeoMarketRankingList>()
    const all = await read('')
    // The shared search answers both markets, so 3 searches store 4 rows, in market then search-text order.
    expect(all.items.map(row => [row.marketKey, row.searchText, row.rankOrganic])).toEqual([
      ['bayside-market', 'best homes in Bayside', null],
      ['bayside-market', 'homes near the water', 12],
      ['harbor-market', 'best homes in Harbor', 4],
      ['harbor-market', 'homes near the water', 12],
    ])
    expect(all).toMatchObject({ runId: run.id, total: 4 })
    expect((await read('&marketKey=harbor-market')).items.map(row => row.queryId)).toEqual(['q-harbor', 'q-shared'])
    expect((await read('&regionKey=metro&limit=1&offset=3')).items.map(row => [row.marketKey, row.queryId])).toEqual([['harbor-market', 'q-shared']])
    expect((await read('&regionKey=elsewhere')).total).toBe(0)
    expect((await h.app.inject({ url: `${base}/overview?profileId=markets` })).json()).toMatchObject({ evidenceRunId: run.id, marketRankingCount: 4 })
    expect((await h.app.inject({ url: `${base}/runs/${run.id}` })).json<SeoRunDetail>().resultCounts).toEqual({ keywordMetrics: 0, domainIntelligence: 0, rankedKeywords: 0, marketRankings: 4 })
    // Results stored before this field existed carry no marketRankings array at all.
    h.db.$client.prepare('UPDATE seo_tasks SET results = ? WHERE job_id = ?').run(JSON.stringify({ keywordMetrics: [], domainIntelligence: [], rankedKeywords: [] }), run.id)
    expect(await read('')).toMatchObject({ runId: run.id, total: 0, items: [] })
  })
})
