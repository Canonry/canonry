import { afterEach, expect, it } from 'vitest'
import { seoProfiles } from '@canonry/canonry-db'
import {
  SeoCapabilities, SeoMarketRankingSearchStatuses, SeoProviders, SeoRunStatuses, emptySeoResults, queryClassSchema, seoTrendsSchema,
  type SeoAdapterRequest, type SeoDomainIntelligence, type SeoMarketRanking, type SeoProfileInput, type SeoRankedKeyword,
} from '@canonry/canonry-contracts'
import { createSeoHarness, seedSeoEvidence, seedSeoKey, seoProfileFixture } from './seo-fixture.js'

const base = '/api/v1/projects/alpha/seo/trends'
const target = { kind: 'domain', value: 'alpha.com', includeSubdomains: true } as const
const domainProfile: SeoProfileInput = { ...seoProfileFixture, capabilities: [SeoCapabilities['domain-intelligence']], targets: [target] }
const harnesses: ReturnType<typeof createSeoHarness>[] = []
afterEach(async () => { await Promise.all(harnesses.splice(0).map(harness => harness.close())) })
function harness(...options: Parameters<typeof createSeoHarness>) {
  const instance = createSeoHarness(...options)
  harnesses.push(instance)
  return instance
}
const instant = (date: string) => `${date}T12:00:00.000Z`
function domainRow(collectedAt: string, metrics: Partial<SeoDomainIntelligence> = {}): SeoDomainIntelligence {
  return {
    target, organicKeywords: 0, estimatedOrganicTraffic: 100, estimatedOrganicTrafficValueUsd: null,
    top1: 1, top2To3: 2, top4To10: 3, top11To20: 0,
    provenance: { provider: SeoProviders.dataforseo, dataset: 'google-labs', engine: 'google', locationCode: 2840, languageCode: 'en', device: 'unspecified', collectedAt, sourceUpdatedAt: null },
    ...metrics,
  }
}

it('compares stored primary-domain estimates through gaps and renames, stopping at a change in measured location', async () => {
  const h = harness({ skipAuth: false })
  const saved = { ...domainProfile, targets: [target, { ...target, value: 'secondary.com' }] }
  h.db.insert(seoProfiles).values({ id: 'main', projectId: 'alpha', revision: 3, input: { ...saved, locationCode: 1000 }, createdAt: instant('2026-01-01'), updatedAt: instant('2026-09-19') }).run()
  const task = (row: SeoDomainIntelligence) => ({
    request: { capability: SeoCapabilities['domain-intelligence'], target: row.target, keywords: [], locationCode: 2840, languageCode: 'en', limit: 100, tag: row.target.value },
    results: { ...emptySeoResults(), domainIntelligence: [row] },
  })
  const seed = (id: string, date: string, rows: SeoDomainIntelligence[], overrides: Partial<Parameters<typeof seedSeoEvidence>[1]> = {}) =>
    seedSeoEvidence(h.db, { id, projectId: 'alpha', profileId: 'main', profile: saved, profileRevision: 2,
      createdAt: instant(date), finishedAt: `${date}T15:00:00.000Z`, status: 'completed', tasks: rows.map(task), ...overrides })
  const oldLocation = { ...saved, name: 'Another market', locationCode: 1000 }
  const oldRow = domainRow(instant('2026-07-01'), { organicKeywords: 500 })
  oldRow.provenance.locationCode = oldLocation.locationCode
  seed('earlier-location', '2026-07-01', [oldRow], { profileRevision: 1, profile: oldLocation, tasks: [{ ...task(oldRow), request: { ...task(oldRow).request, locationCode: oldLocation.locationCode } }] })
  seed('before-profile-rename', '2026-07-12', [domainRow(instant('2026-07-12'), { organicKeywords: 1, estimatedOrganicTraffic: 90 })], { profileRevision: 2, profile: { ...saved, name: 'Before rename' } })
  const currentCohort = { profileRevision: 3, profile: saved }
  seed('window-baseline', '2026-08-01', [domainRow(instant('2026-08-01')), domainRow(instant('2026-08-01'), { target: saved.targets[1]!, organicKeywords: 900 })], currentCohort)
  seed('no-reading', '2026-08-25', [], { ...currentCohort, status: 'failed' })
  seed('partial-metrics', '2026-09-05', [domainRow(instant('2026-09-04'), { organicKeywords: 19, top2To3: null, estimatedOrganicTraffic: null })], { ...currentCohort, status: 'partial' })
  seed('latest-reading', '2026-09-14', [domainRow(instant('2026-09-13'), { organicKeywords: 25, top1: 3, top2To3: 4, top4To10: 5, estimatedOrganicTraffic: 125 })], currentCohort)
  seed('latest-failure', '2026-09-16', [], { ...currentCohort, status: 'failed' })
  seed('current-profile-failure', '2026-09-19', [], { status: 'failed', profileRevision: 4, profile: { ...saved, locationCode: 1000 } })
  const headers = { authorization: `Bearer ${seedSeoKey(h.db, 'trend-reader', ['read'], 'alpha')}` }
  const response = await h.app.inject({ url: `${base}?profileId=main`, headers })
  expect(response.statusCode, response.body).toBe(200)
  const trends = seoTrendsSchema.parse(response.json())
  expect(trends).toMatchObject({ kind: 'domain', days: 180, profileId: 'main', profileRevision: 3, target, locationCode: 2840, languageCode: 'en', scope: { kind: 'project' }, marketQueryCount: null, hasRankingReadings: true })
  expect(trends.points.map(point => [point.runId, point.observedAt, point.organicKeywords, point.inTop10, point.estimatedOrganicTraffic])).toEqual([
    ['before-profile-rename', instant('2026-07-12'), 1, 6, 90],
    ['window-baseline', instant('2026-08-01'), 0, 6, 100],
    ['no-reading', '2026-08-25T15:00:00.000Z', null, null, null],
    ['partial-metrics', instant('2026-09-04'), 19, null, null],
    ['latest-reading', instant('2026-09-13'), 25, 12, 125],
    ['latest-failure', '2026-09-16T15:00:00.000Z', null, null, null],
  ])
  const basis = { type: 'first-in-window', date: '2026-07-12', observedAt: instant('2026-07-12'), label: null }
  expect(trends.changes).toEqual({
    organicKeywords: { difference: 24, ratio: 24, tone: 'better', basis },
    inTop10: { difference: 6, ratio: 1, tone: 'better', basis },
    estimatedOrganicTraffic: { difference: 35, ratio: .38888889, tone: 'better', basis },
    page1: null,
  })
  const narrow = seoTrendsSchema.parse((await h.app.inject({ url: `${base}?profileId=main&days=30&keyword=clean%20energy`, headers })).json())
  expect(narrow.kind).toBe('domain')
  expect(narrow.keyword).toBeUndefined()
  expect(narrow.points.map(point => point.runId)).toEqual(['no-reading', 'partial-metrics', 'latest-reading', 'latest-failure'])
  expect(narrow.changes).toMatchObject({ organicKeywords: { difference: 6, basis: { observedAt: instant('2026-09-04') } }, inTop10: null, estimatedOrganicTraffic: null })
  expect(response.body).not.toContain('fixture-account-key')
  expect((await h.app.inject({ url: `${base}?profileId=main&days=7`, headers })).statusCode).toBe(400)
  expect((await h.app.inject({ url: `${base}?profileId=missing`, headers })).statusCode).toBe(404)
  expect((await h.app.inject({ url: '/api/v1/projects/beta/seo/trends?profileId=main', headers })).statusCode).toBe(403)
  expect(h.requested).toEqual([])
  expect(h.state.executions).toBe(0)
})

it.each([false, true])('compares an individual ranked search from bounded saved results (Advanced exact host: %s)', async advanced => {
  const h = harness()
  const host = { kind: 'host', value: 'shop.alpha.com', includeSubdomains: false } as const
  const primary = advanced ? host : target
  const secondary = { ...primary, value: 'other.alpha.com' }
  const profile: SeoProfileInput = {
    ...seoProfileFixture, name: 'Ranked searches', limit: 100, keywords: [],
    capabilities: [SeoCapabilities['ranked-keywords']], targets: [primary, secondary],
    scope: advanced ? { kind: 'property', key: 'shop', expectedPlanRevision: 2 } : { kind: 'project' },
  }
  const frozen = advanced ? { mode: 'advanced', planVersionId: 'v2', planRevision: 2, scope: profile.scope } : undefined
  if (advanced) {
    h.db.insert(seoProfiles).values({ id: 'ranked', projectId: 'alpha', revision: 1, input: profile, createdAt: instant('2026-01-01'), updatedAt: instant('2026-01-01') }).run()
  } else {
    const response = await h.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/seo/profiles/ranked', payload: profile })
    expect(response.statusCode, response.body).toBe(200)
  }
  const rank = (keyword: string, rankOrganic: number | null, date: string, selected = primary): SeoRankedKeyword => ({
    target: selected, keyword, rankOrganic, rankAbsolute: rankOrganic, url: null, searchVolume: null, estimatedTraffic: null,
    cpcUsd: null, keywordDifficulty: null, serpFeatures: [],
    provenance: { ...domainRow(instant(date)).provenance, dataset: 'google-labs-ranked-keywords' },
  })
  const seed = (id: string, date: string, primaryRows: SeoRankedKeyword[], frozenProfile = profile) => {
    const task = (selected: typeof primary, rows: SeoRankedKeyword[]) => ({
      request: { capability: SeoCapabilities['ranked-keywords'], target: selected, keywords: [], locationCode: 2840, languageCode: 'en', limit: frozenProfile.limit, tag: id },
      results: { ...emptySeoResults(), rankedKeywords: rows },
    })
    seedSeoEvidence(h.db, { id, projectId: 'alpha', profileId: 'ranked', profile: frozenProfile, scopeSnapshot: frozen,
      createdAt: instant(date), finishedAt: `${date}T15:00:00.000Z`, status: 'completed', tasks: [task(primary, primaryRows), task(secondary, [rank('solar installer', 1, date, secondary)])] })
  }
  seed('different-sample-limit', '2026-06-10', [rank('solar installer', 40, '2026-06-10')], { ...profile, limit: 50 })
  seed('rank-before', '2026-07-01', [rank('solar installer', 8, '2026-07-01'), rank('Solar Installer', 10, '2026-07-01'), rank('clean energy', 4, '2026-07-01')])
  seed('rank-gap', '2026-09-01', [rank('clean energy', 3, '2026-09-01'), rank('missing rank', null, '2026-09-01')])
  seed('rank-after', '2026-10-01', [rank('clean energy', null, '2026-10-01'), rank('Solar Installer', 3, '2026-10-01')])
  const load = async (search = '') => {
    const response = await h.app.inject({ url: `${base}?profileId=ranked${search}` })
    expect(response.statusCode, response.body).toBe(200)
    return seoTrendsSchema.parse(response.json())
  }
  const trends = await load()
  expect(trends).toMatchObject({ kind: 'ranked', target: primary, scope: profile.scope, hasRankingReadings: true, keyword: 'Solar Installer', rankedKeywords: ['Solar Installer', 'clean energy'] })
  expect(trends.points.map(point => [point.runId, point.observedAt, point.rankOrganic])).toEqual([
    ['rank-before', instant('2026-07-01'), 8], ['rank-gap', instant('2026-09-01'), null], ['rank-after', instant('2026-10-01'), 3],
  ])
  expect(trends.changes.rankOrganic).toEqual({ difference: -5, ratio: -.625, tone: 'better', basis: { type: 'first-in-window', date: '2026-07-01', label: null, observedAt: instant('2026-07-01') } })
  const narrow = await load('&days=30&keyword=clean%20energy')
  expect(narrow).toMatchObject({ hasRankingReadings: true, keyword: 'clean energy', rankedKeywords: trends.rankedKeywords })
  expect(narrow.points.map(point => [point.runId, point.rankOrganic])).toEqual([['rank-after', null]])
  expect(narrow.changes.rankOrganic).toBeNull()
  const explicit = await load('&keyword=CLEAN%20ENERGY')
  expect(explicit.keyword).toBe('clean energy')
  expect(explicit.points.map(point => point.rankOrganic)).toEqual([4, 3, null])
  const missing = await load('&keyword=stale%20bookmark')
  expect(missing.keyword).toBe('stale bookmark')
  expect(missing.points.map(point => point.rankOrganic)).toEqual([null, null, null])
})

it('uses saved keyword rankings when a mixed profile has no usable domain readings', async () => {
  const h = harness()
  const profile = { ...domainProfile, capabilities: [SeoCapabilities['domain-intelligence'], SeoCapabilities['ranked-keywords']] }
  h.db.insert(seoProfiles).values({ id: 'mixed', projectId: 'alpha', revision: 1, input: profile, createdAt: instant('2026-08-01'), updatedAt: instant('2026-08-01') }).run()
  const seed = (date: string, rankOrganic: number, organicKeywords: number | null) => {
    const createdAt = instant(date)
    const domain = domainRow(createdAt, { organicKeywords, estimatedOrganicTraffic: null, top1: null, top2To3: null, top4To10: null, top11To20: null })
    const row: SeoRankedKeyword = {
      target, keyword: 'solar installer', rankOrganic, rankAbsolute: rankOrganic, url: null, searchVolume: null, estimatedTraffic: null,
      cpcUsd: null, keywordDifficulty: null, serpFeatures: [], provenance: { ...domain.provenance, dataset: 'google-labs-ranked-keywords' },
    }
    const request = { target, keywords: [], locationCode: 2840, languageCode: 'en', limit: profile.limit, tag: date }
    seedSeoEvidence(h.db, { id: `mixed-${date}`, projectId: 'alpha', profileId: 'mixed', profile, createdAt, finishedAt: createdAt, status: 'completed', tasks: [
      { request: { ...request, capability: SeoCapabilities['domain-intelligence'] }, results: { ...emptySeoResults(), domainIntelligence: [domain] } },
      { request: { ...request, capability: SeoCapabilities['ranked-keywords'] }, results: { ...emptySeoResults(), rankedKeywords: [row] } },
    ] })
  }
  seed('2026-08-01', 6, null)
  seed('2026-10-01', 4, null)
  const load = async (search = '') => {
    const response = await h.app.inject({ url: `${base}?profileId=mixed&days=90${search}` })
    expect(response.statusCode, response.body).toBe(200)
    return seoTrendsSchema.parse(response.json())
  }
  const trends = await load()
  expect(trends).toMatchObject({ kind: 'ranked', keyword: 'solar installer', hasRankingReadings: true, changes: { rankOrganic: { difference: -2, tone: 'better' } } })
  expect(trends.points.map(point => point.rankOrganic)).toEqual([6, 4])
  seed('2026-10-08', 2, 12)
  expect(await load()).toMatchObject({ kind: 'domain', hasRankingReadings: true })
  const selected = await load('&keyword=solar%20installer')
  expect(selected).toMatchObject({ kind: 'ranked', keyword: 'solar installer' })
  expect(selected.points.map(point => point.rankOrganic)).toEqual([6, 4, 2])
})

it('counts known page-one memberships in a fixed market basket and keeps unverified searches as gaps', async () => {
  const h = harness()
  const profile: SeoProfileInput = {
    ...domainProfile, capabilities: [SeoCapabilities['market-rankings']], keywords: [],
    scope: { kind: 'group', key: 'coast', expectedPlanRevision: 2 },
    rankings: { locations: [], depth: 50, device: 'mobile', searchText: 'query' },
  }
  h.db.insert(seoProfiles).values({ id: 'markets', projectId: 'alpha', revision: 1, input: profile, createdAt: instant('2026-01-01'), updatedAt: instant('2026-01-01') }).run()
  const seed = (id: string, date: string, options: { secondMarket?: string; partialDepth?: number; rank: number | null; needsReview?: boolean }) => {
    const dateTime = instant(date)
    const queryText = 'apartments near the coast'
    const searchStatus = options.partialDepth === undefined ? SeoMarketRankingSearchStatuses.completed : SeoMarketRankingSearchStatuses.partial
    const markets = ['harbor', options.secondMarket ?? 'bayside'].map(marketKey => ({
      context: { marketKey, marketLabel: marketKey, regionKey: 'coast', regionLabel: 'Coast', queryId: 'query', queryText, queryClass: queryClassSchema.enum['non-brand'] }, competitors: [],
    }))
    const request: SeoAdapterRequest = {
      capability: SeoCapabilities['market-rankings'], target, keywords: [queryText], languageCode: 'en', locationCode: 2840, limit: 100, tag: id,
      search: { depth: 50, device: 'mobile', locationLabel: 'Coast', markets },
    }
    const rows: SeoMarketRanking[] = markets.map(({ context }) => ({
      ...context, searchText: queryText, locationLabel: 'Coast', target, searchStatus, depth: options.partialDepth ?? 50,
      rankOrganic: options.rank, rankAbsolute: options.rank, url: null, competitors: [],
      provenance: { provider: SeoProviders.dataforseo, dataset: 'google-serp', engine: 'google', locationCode: 2840, languageCode: 'en', device: 'mobile', collectedAt: dateTime, sourceUpdatedAt: null },
    }))
    seedSeoEvidence(h.db, { id, projectId: 'alpha', profileId: 'markets', profile, createdAt: dateTime, finishedAt: dateTime,
      status: options.needsReview ? SeoRunStatuses['reconciliation-required'] : searchStatus,
      scopeSnapshot: { mode: 'advanced', planVersionId: 'v2', planRevision: 2, scope: profile.scope },
      tasks: [{ request, results: { ...emptySeoResults(), marketRankings: rows } }] })
  }
  seed('previous-basket', '2026-07-01', { secondMarket: 'island', rank: 1 })
  seed('baseline', '2026-08-01', { rank: null })
  seed('page-unchecked', '2026-08-11', { partialDepth: 8, rank: null })
  seed('member-found-in-partial-page', '2026-08-21', { partialDepth: 7, rank: 3 })
  seed('page-checked', '2026-09-01', { partialDepth: 10, rank: 10 })
  seed('decoded-before-reconciliation', '2026-09-11', { needsReview: true, rank: null })
  const response = await h.app.inject({ url: `${base}?profileId=markets` })
  expect(response.statusCode, response.body).toBe(200)
  const result = seoTrendsSchema.parse(response.json())
  expect(result).toMatchObject({ kind: 'market', marketQueryCount: 2, locationCode: null, scope: profile.scope, changes: { page1: { difference: 2, ratio: null }, inTop10: null } })
  expect(result.points.map(point => [point.runId, point.page1])).toEqual([
    ['baseline', 0], ['page-unchecked', null], ['member-found-in-partial-page', 2], ['page-checked', 2], ['decoded-before-reconciliation', null],
  ])
})
