import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { SeoRepository, competitors, measurementPlans, measurementPlanVersions, projects, queries, seoTasks, type SeoTaskRow } from '@canonry/canonry-db'
import {
  SeoCapabilities, SeoProviders, canonicalMeasurementPlanV2Json, compareText, emptySeoResults,
  type MeasurementPlanV2, type SeoAdapter, type SeoAdapterResult, type SeoContext, type SeoMarketRanking, type SeoMarketRankingList, type SeoMarketRankingSearchStatus, type SeoMarketRankingSummary,
  type SeoProfileInput, type SeoQuote, type SeoRun, type SeoRunDetail, type SeoRunList,
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
/** One metro with a neighborhood group and market per Property; `q-shared` is asked in both markets. `pins` adds competitors to groups by key. */
function metroPlan(pins: Record<string, string[]> = {}): MeasurementPlanV2 {
  const source = measurementPlanV2Fixture()
  const pinned = (groupKey: string) => (pins[groupKey] ?? []).map(domain => ({ stableKey: domain.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: domain, domain, aliases: [] }))
  return measurementPlanV2Fixture({
    groups: [
      { stableKey: 'metro', label: 'Coast Metro Area', targetKeys: ['harbor', 'bayside'], competitors: pinned('metro') },
      { stableKey: 'metro--harbor', label: 'Harbor, Coast', parentGroupKey: 'metro', targetKeys: ['harbor'], competitors: pinned('metro--harbor') },
      { stableKey: 'metro--bayside', label: 'Bayside, Coast', parentGroupKey: 'metro', targetKeys: ['bayside'], competitors: pinned('metro--bayside') },
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
/** The rows the adapter stores for a search that returned results: one per market it answers. */
function collectedRows(task: SeoTaskRow, searchStatus: SeoMarketRankingSearchStatus, rankOrganic: number | null, depth: number): SeoMarketRanking[] {
  const search = task.request.search!
  return search.markets.map(market => ({
    ...market.context, searchText: task.request.keywords[0]!, locationLabel: search.locationLabel, target: site, searchStatus,
    rankOrganic, rankAbsolute: null, url: null, depth, competitors: [],
    provenance: { provider: 'dataforseo', dataset: 'dataforseo-serp/google/market-rankings', engine: 'google', locationCode: task.request.locationCode, languageCode: 'en', device: 'mobile', collectedAt: '2026-10-25T00:00:00.000Z', sourceUpdatedAt: null },
  }))
}
const plannedSearches = (h: ReturnType<typeof harness>, runId: string) => h.db.select().from(seoTasks).where(eq(seoTasks.jobId, runId)).all()
  .map(task => ({ text: task.request.keywords[0], location: task.request.locationCode, reserved: task.reservedMicros, markets: task.request.search!.markets.map(market => `${market.context.marketKey}:${market.context.queryId}`).sort() }))
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
        device: 'mobile', depth: 50, locationLabel: 'Coast Metro',
        markets: [{
          context: { marketKey: 'harbor-market', marketLabel: 'Harbor, Coast', regionKey: 'metro', regionLabel: 'Coast Metro Area', queryId: 'q-harbor', queryText: 'best homes in Harbor, Coast', queryClass: 'non-brand' },
          competitors: ['rival.com'],
        }],
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

  it('tracks each market\'s query against the project\'s competitors and those pinned to the groups whose Properties ask it', async () => {
    const h = harness()
    seedPlan(h, metroPlan({ 'metro': ['metro-rival.com', 'shop.alpha.com'], 'metro--harbor': ['www.Harbor-Rival.com'], 'metro--bayside': ['bayside-rival.com'] }))
    // More project competitors than any fixed cap would keep: every one is tracked.
    const projectRivals = Array.from({ length: 21 }, (_, index) => `rival-${String(index).padStart(2, '0')}.com`)
    h.db.insert(competitors).values(projectRivals.map((domain, index) => ({ id: `c${index}`, projectId: 'alpha', domain, createdAt: new Date().toISOString() }))).run()
    expect((await put(h, rankingProfile([{ key: 'metro', locationCode: 200001, label: 'Coast Metro' }]))).statusCode).toBe(200)
    const run = await refresh(h, 'pinned')
    const tracked = h.db.select().from(seoTasks).where(eq(seoTasks.jobId, run.id)).all()
      .flatMap(task => task.request.search!.markets.map(market => [`${market.context.marketKey}:${market.context.queryId}`, market.competitors]))
      .sort(([left], [right]) => compareText(String(left), String(right)))
    const withProject = (...pinned: string[]) => [...pinned, ...projectRivals].sort(compareText)
    // The metro pin covers every query its Properties ask; a neighborhood pin covers only queries its own Property asks,
    // so Harbor's query never carries Bayside's rival. Both Properties ask the shared query, so it carries both. The
    // project's own domain is never a rival, even when a group pins it.
    expect(tracked).toEqual([
      ['bayside-market:q-bayside', withProject('bayside-rival.com', 'metro-rival.com')],
      ['bayside-market:q-shared', withProject('bayside-rival.com', 'harbor-rival.com', 'metro-rival.com')],
      ['harbor-market:q-harbor', withProject('harbor-rival.com', 'metro-rival.com')],
      ['harbor-market:q-shared', withProject('bayside-rival.com', 'harbor-rival.com', 'metro-rival.com')],
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
      const rows = collectedRows(task, 'completed', rank[task.request.keywords[0]!] ?? null, task.request.search!.depth)
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
    expect((await h.app.inject({ url: `${base}/runs/${run.id}` })).json<SeoRunDetail>().resultCounts).toEqual({ keywordMetrics: 0, domainIntelligence: 0, rankedKeywords: 0, marketRankings: 4, competitors: 0, keywordGaps: 0 })
    // Results stored before this field existed carry no marketRankings array at all.
    h.db.$client.prepare('UPDATE seo_tasks SET results = ? WHERE job_id = ?').run(JSON.stringify({ keywordMetrics: [], domainIntelligence: [], rankedKeywords: [] }), run.id)
    expect(await read('')).toMatchObject({ runId: run.id, total: 0, items: [] })
  })

  it('keeps a row for every planned search, saying which failed, came back partial or never ran, and names each search in its refresh', async () => {
    const h = harness(); seedPlan(h, metroPlan())
    await put(h, rankingProfile([{ key: 'metro', locationCode: 200001, label: 'Coast Metro' }]))
    const run = await refresh(h, 'mixed')
    const repo = new SeoRepository(h.db)
    for (let task = repo.claim(run.id, { ...policy, accountKey: 'account-a' }); task; task = repo.claim(run.id, { ...policy, accountKey: 'account-a' })) {
      const text = task.request.keywords[0]!
      // Harbor's search completes, Google errors on Bayside's, and the shared search gets back only its first pages.
      const settled = text === 'best homes in Bayside'
        ? { outcome: 'failed' as const, statusCode: 40101, results: emptySeoResults() }
        : text === 'homes near the water'
          ? { outcome: 'partial' as const, statusCode: 40106, results: { ...emptySeoResults(), marketRankings: collectedRows(task, 'partial', null, 27) } }
          : { outcome: 'completed' as const, statusCode: 20000, results: { ...emptySeoResults(), marketRankings: collectedRows(task, 'completed', 4, 50) } }
      repo.settle(task.id, { outcome: settled.outcome, results: settled.results, tasks: [{ remoteTaskId: task.id, statusCode: settled.statusCode, costMicros: 6_000 }], error: null, fetchedAt: new Date().toISOString() }, task.leaseOwner!)
    }
    const read = async (query = '') => (await h.app.inject({ url: `${base}/market-rankings?profileId=markets${query}` })).json<SeoMarketRankingList>()
    const rows = await read()
    // A failed search keeps its row in its market: no rank, nothing checked, no source to cite.
    expect(rows.items.map(row => [row.marketKey, row.searchText, row.searchStatus, row.rankOrganic, row.depth])).toEqual([
      ['bayside-market', 'best homes in Bayside', 'failed', null, 0],
      ['bayside-market', 'homes near the water', 'partial', null, 27],
      ['harbor-market', 'best homes in Harbor', 'completed', 4, 50],
      ['harbor-market', 'homes near the water', 'partial', null, 27],
    ])
    expect(rows.items[0]).toEqual({
      marketKey: 'bayside-market', marketLabel: 'Bayside, Coast', regionKey: 'metro', regionLabel: 'Coast Metro Area', queryId: 'q-bayside', queryText: 'best  homes in Bayside, coast', queryClass: 'non-brand',
      searchText: 'best homes in Bayside', locationLabel: 'Coast Metro', target: site, searchStatus: 'failed',
      rankOrganic: null, rankAbsolute: null, url: null, depth: 0, competitors: [], provenance: null, outcome: 'failed', rivalAhead: false, topCompetitor: null, rankGap: null,
    })
    expect(rows.total).toBe(4)
    expect((await h.app.inject({ url: `${base}/overview?profileId=markets` })).json()).toMatchObject({ evidenceRunId: run.id, marketRankingCount: 4 })

    // The refresh names each search, so a failed one can be found in Activity.
    const detail = (await h.app.inject({ url: `${base}/runs/${run.id}` })).json<SeoRunDetail>()
    expect(detail.status).toBe('partial')
    expect(detail.tasks.map(task => [task.searchText, task.locationLabel, task.status, task.error]).sort((a, b) => compareText(String(a[0]), String(b[0])))).toEqual([
      ['best homes in Bayside', 'Coast Metro', 'failed', 'The SEO provider could not complete this task.'],
      ['best homes in Harbor', 'Coast Metro', 'completed', null],
      ['homes near the water', 'Coast Metro', 'partial', null],
    ])
    expect(detail.resultCounts.marketRankings).toBe(4)

    // Rows saved before searchStatus existed were complete searches.
    const harbor = h.db.select().from(seoTasks).where(eq(seoTasks.jobId, run.id)).all().find(task => task.request.keywords[0] === 'best homes in Harbor')!
    const legacy = (harbor.results.marketRankings ?? []).map(({ searchStatus: _searchStatus, ...row }) => row)
    h.db.$client.prepare('UPDATE seo_tasks SET results = ? WHERE id = ?').run(JSON.stringify({ ...emptySeoResults(), marketRankings: legacy }), harbor.id)
    expect((await read('&marketKey=harbor-market')).items[0]).toMatchObject({ searchText: 'best homes in Harbor', searchStatus: 'completed', rankOrganic: 4 })

    // A refresh cancelled before it searched lists every search as never run, and the earlier refresh stays the evidence.
    const stopped = await refresh(h, 'stopped')
    repo.cancel(stopped.id)
    const cancelled = (await h.app.inject({ url: `${base}/runs/${stopped.id}` })).json<SeoRunDetail>()
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.results.marketRankings.map(row => [row.marketKey, row.searchText, row.searchStatus, row.depth])).toEqual([
      ['bayside-market', 'best homes in Bayside', 'cancelled', 0],
      ['bayside-market', 'homes near the water', 'cancelled', 0],
      ['harbor-market', 'best homes in Harbor', 'cancelled', 0],
      ['harbor-market', 'homes near the water', 'cancelled', 0],
    ])
    expect((await read()).runId).toBe(run.id)
  })

  it('reads where each query landed: outcome filters, text, order and counts by region and market, the retry replacing its failure', async () => {
    const h = harness(); seedPlan(h, metroPlan())
    await put(h, rankingProfile([{ key: 'metro', locationCode: 200001, label: 'Coast Metro' }]))
    const run = await refresh(h, 'outcomes')
    const repo = new SeoRepository(h.db)
    const rival = (rows: SeoMarketRanking[], rankOrganic: number) => rows.map(row => ({ ...row, competitors: [{ domain: 'rival.com', rankOrganic }] }))
    const settled = (task: SeoTaskRow, outcome: SeoAdapterResult['outcome'], statusCode: number, marketRankings: SeoMarketRanking[], retryable = false): SeoAdapterResult => ({
      outcome, tasks: [{ remoteTaskId: task.id, statusCode, costMicros: 2_000 }], results: { ...emptySeoResults(), marketRankings }, error: null, fetchedAt: new Date().toISOString(), ...(retryable ? { retryable } : {}),
    })
    // Harbor ranks 12 behind a rival at 3; Google errors on Bayside, whose retry ranks 4; the shared search comes back partial without the site.
    for (let task = repo.claim(run.id, { ...policy, accountKey: 'account-a' }); task; task = repo.claim(run.id, { ...policy, accountKey: 'account-a' })) {
      const text = task.request.keywords[0]!
      const result = text === 'best homes in Harbor' ? settled(task, 'completed', 20000, rival(collectedRows(task, 'completed', 12, 50), 3))
        : text === 'best homes in Bayside' ? task.retryOf ? settled(task, 'completed', 20000, collectedRows(task, 'completed', 4, 50)) : settled(task, 'failed', 40101, [], true)
          : settled(task, 'partial', 40106, collectedRows(task, 'partial', null, 27))
      repo.settle(task.id, result, task.leaseOwner!, policy)
    }
    const read = async (query: string) => (await h.app.inject({ url: `${base}/market-rankings?profileId=markets${query}` })).json<SeoMarketRankingList>()
    expect((await read('&sort=rank')).items.map(row => [row.marketKey, row.queryId, row.searchStatus, row.outcome, row.rankOrganic, row.rivalAhead])).toEqual([
      ['bayside-market', 'q-bayside', 'completed', 'page-1', 4, false],
      ['harbor-market', 'q-harbor', 'completed', 'ranks-11-20', 12, true],
      // Ranks 28-50 were never checked, so the shared search is partly checked, not "not in the top 50".
      ['bayside-market', 'q-shared', 'partial', 'partly-checked', null, false],
      ['harbor-market', 'q-shared', 'partial', 'partly-checked', null, false],
    ])
    expect((await read('&outcome=partly-checked')).total).toBe(2)
    expect((await read('&outcome=needs-work')).items.map(row => `${row.marketKey}:${row.queryId}`)).toEqual(['bayside-market:q-shared', 'harbor-market:q-harbor', 'harbor-market:q-shared'])
    expect((await read('&outcome=rival-ahead')).items.map(row => row.queryId)).toEqual(['q-harbor'])
    expect((await read('&outcome=not-ranked')).total).toBe(0)
    expect((await read('&q=BAYSIDE')).items.map(row => `${row.marketKey}:${row.queryId}`)).toEqual(['bayside-market:q-bayside', 'bayside-market:q-shared'])
    expect((await read('&sort=-query&limit=1')).items.map(row => row.queryId)).toEqual(['q-shared'])
    for (const query of ['&q=%20%20', '&outcome=winning', '&sort=best']) {
      expect((await h.app.inject({ url: `${base}/market-rankings?profileId=markets${query}` })).statusCode, query).toBe(400)
    }

    const summary = async (query: string) => (await h.app.inject({ url: `${base}/market-rankings/summary?profileId=markets${query}` })).json<SeoMarketRankingSummary>()
    const totals = { queries: 4, page1: 1, ranks11To20: 1, ranks21Plus: 0, notRanked: 0, partlyChecked: 2, failed: 0, cancelled: 0, needsWork: 3, rivalAhead: 1 }
    // The depth each search asked for, even though the partial one reached 27.
    expect(await summary('')).toEqual({ runId: run.id, depth: 50, regionKey: null, marketKey: null, regionLabel: null, marketLabel: null, totals, groups: [{ key: 'metro', label: 'Coast Metro Area', kind: 'region', counts: totals }] })
    // Within the region, its markets, closest to page 1 first.
    expect(await summary('&regionKey=metro')).toMatchObject({
      regionKey: 'metro', regionLabel: 'Coast Metro Area', marketLabel: null, totals,
      groups: [
        { key: 'harbor-market', label: 'Harbor, Coast', kind: 'market', counts: { queries: 2, page1: 0, ranks11To20: 1, partlyChecked: 1, needsWork: 2, rivalAhead: 1 } },
        { key: 'bayside-market', label: 'Bayside, Coast', kind: 'market', counts: { queries: 2, page1: 1, ranks11To20: 0, partlyChecked: 1, needsWork: 1, rivalAhead: 0 } },
      ],
    })
    expect(await summary('&regionKey=metro&marketKey=harbor-market')).toMatchObject({ regionLabel: 'Coast Metro Area', marketLabel: 'Harbor, Coast', totals: { queries: 2, ranks11To20: 1, partlyChecked: 1 }, groups: [] })
    expect(await summary('&regionKey=elsewhere')).toMatchObject({ regionKey: 'elsewhere', regionLabel: null, totals: { queries: 0 }, groups: [] })

    // The run counts each search once, by its latest attempt: the retry replaced Bayside's failure.
    const detail = (await h.app.inject({ url: `${base}/runs/${run.id}` })).json<SeoRunDetail>()
    expect(detail).toMatchObject({ status: 'partial', taskCount: 3, completedTasks: 3, failedTasks: 0 })
    expect(detail.tasks.filter(task => task.retried).map(task => [task.searchText, task.status])).toEqual([['best homes in Bayside', 'completed']])
    expect((await h.app.inject({ url: `${base}/runs?profileId=markets` })).json<SeoRunList>().runs[0]).toMatchObject({ id: run.id, taskCount: 3, completedTasks: 3, failedTasks: 0 })

    // A refresh cancelled before its searches ran counts them as cancelled; the evidence stays on the earlier refresh.
    const cancelled = await refresh(h, 'cancelled')
    repo.cancel(cancelled.id)
    expect((await summary(`&runId=${cancelled.id}`)).totals).toMatchObject({ queries: 4, cancelled: 4, needsWork: 0 })
    expect((await read(`&runId=${cancelled.id}&outcome=cancelled`)).total).toBe(4)
    expect((await summary('')).runId).toBe(run.id)
  })
})
