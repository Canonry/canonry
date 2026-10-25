import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDemoServer } from '../src/demo-server.js'
import { seoContextSchema, seoProfileListSchema, seoOverviewSchema, seoRunDetailSchema, seoKeywordMetricsListSchema, seoMarketRankingListSchema, seoRankedKeywordListSchema } from '@canonry/canonry-contracts'

const dir = mkdtempSync(join(tmpdir(), 'canonry-demo-integration-'))
let app: Awaited<ReturnType<typeof createDemoServer>>
const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Demo must not use the network'))
beforeAll(async () => {
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>')
  app = await createDemoServer({ assetsDir: dir })
}, 20000)
afterAll(async () => { await app?.close(); network.mockRestore(); rmSync(dir, { recursive: true, force: true }) })

describe('populated demo integration', () => {
  it.each(['summit-roofing', 'harbor-resorts'])('serves saved SEO evidence for %s while keeping refreshes closed', async name => {
    const read = async (path: string) => {
      const response = await app.inject(`/api/v1/projects/${name}/seo/${path}`)
      expect(response.statusCode, response.body).toBe(200)
      return response.json()
    }
    const context = seoContextSchema.parse(await read('context'))
    expect(context.access).toEqual({ canRun: false, canWrite: false })
    expect(context.available).toBe(false)
    const { profiles } = seoProfileListSchema.parse(await read('profiles'))
    const advanced = name === 'harbor-resorts'
    expect(profiles).toHaveLength(advanced ? 20 : 1)
    expect(profiles[0]!.scope.kind).toBe('project')
    const overview = seoOverviewSchema.parse(await read('overview?profileId=all-site'))
    expect(overview).toMatchObject({ keywordMetricsCount: advanced ? 12 : 8, rankedKeywordCount: advanced ? 12 : 8, domainIntelligenceCount: 1, summary: { organicKeywords: advanced ? 3240 : 486, inTop10: advanced ? 1222 : 176, estimatedOrganicTraffic: advanced ? 18400 : 2750 } })
    const run = seoRunDetailSchema.parse(await read(`runs/${overview.evidenceRunId}`))
    expect(run).toMatchObject({ status: 'completed', taskCount: 3, completedTasks: 3, failedTasks: 0, profileId: 'all-site' })
    const ranked = seoRankedKeywordListSchema.parse(await read(`ranked-keywords?profileId=all-site&runId=${run.id}&limit=2&offset=1`))
    expect(ranked).toMatchObject({ total: advanced ? 12 : 8, offset: 1, limit: 2 })
    expect(ranked.items.map(item => item.rankOrganic)).toEqual([3, 4])
    expect(ranked.items.every(item => new URL(item.url!).hostname === `${name}.example`)).toBe(true)
    if (advanced) {
      // 3 markets x 4 non-brand queries; each market's last query is outside the checked results.
      expect(seoOverviewSchema.parse(await read('overview?profileId=market-rankings')).marketRankingCount).toBe(12)
      const markets = seoMarketRankingListSchema.parse(await read('market-rankings?profileId=market-rankings&limit=100'))
      expect(markets.total).toBe(12)
      expect([...new Set(markets.items.map(item => item.marketLabel))]).toEqual(['Coastal Maine market', 'Key West market', 'Pacific Northwest market'])
      expect(markets.items.filter(item => item.rankOrganic === null)).toHaveLength(3)
      expect(markets.items.every(item => item.queryClass === 'non-brand' && item.provenance.device === 'mobile')).toBe(true)
      const keyWest = seoMarketRankingListSchema.parse(await read('market-rankings?profileId=market-rankings&marketKey=market-key-west'))
      // Rows read in search-text order within a market.
      expect(keyWest.items.map(item => [item.searchText.split(' for ')[1], item.rankOrganic, item.locationLabel])).toEqual([['family suites', 7, 'Key West, FL'], ['oceanfront pools', 3, 'Key West, FL'], ['spa weekends', 14, 'Key West, FL'], ['sunset dining', null, 'Key West, FL']])
    }
    for (const profile of profiles.filter(item => item.scope.kind !== 'project')) {
      expect(profile.scope.expectedPlanRevision).toBe(2)
      expect(context.scopes.some(scope => scope.kind === profile.scope.kind && scope.key === profile.scope.key)).toBe(true)
      const scoped = seoOverviewSchema.parse(await read(`overview?profileId=${profile.id}`))
      expect(scoped.summary).toBeNull()
      expect(scoped.rankedKeywordCount).toBe(0)
      expect(scoped.keywordMetricsCount).toBe(profile.scope.kind === 'property' ? 1 : 4)
      const demand = seoKeywordMetricsListSchema.parse(await read(`keyword-metrics?profileId=${profile.id}`))
      expect(demand.items.map(item => item.keyword)).toEqual(profile.keywords)
    }
    for (const [method, path, payload] of [
      ['PUT', 'profiles/all-site', {}], ['POST', 'refresh-intents', { profileId: 'all-site' }],
      ['POST', 'sync', {}], ['POST', `runs/${run.id}/cancel`, {}],
    ] as const) {
      const response = await app.inject({ method, url: `/api/v1/projects/${name}/seo/${path}`, payload })
      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe('DEMO_READ_ONLY')
    }
    expect((await app.inject(`/api/v1/seo/operator/tasks/${run.tasks[0]!.id}`)).statusCode).toBe(403)
    expect(network).not.toHaveBeenCalled()
  })
  it.each(['summit-roofing', 'harbor-resorts'])('serves populated feature reads for %s without any provider call', async name => {
    const paths = [
      'overview', 'visibility-report', 'traffic/analytics', 'queries', 'runs', 'google/connections',
      'google/gsc/performance/daily?window=7d', 'bing/status', 'bing/performance', 'bing/coverage',
      'ga/status', 'ga/traffic', 'ga/ai-referral-history',
      'technical-aeo/crawl', 'technical-aeo/graph', 'gbp/summary',
      'backlinks/summary', 'ads/summary', 'conversion-tracking/contracts', 'content/targets', 'history',
    ]
    for (const path of paths) {
      const response = await app.inject(`/api/v1/projects/${name}/${path}`)
      expect(response.statusCode, `${name}/${path}: ${response.body.slice(0, 200)}`).toBe(200)
    }
    expect((await app.inject(`/api/v1/projects/${name}/bing/performance`)).json().length).toBeGreaterThan(0)
    expect((await app.inject(`/api/v1/projects/${name}/ga/status`)).json().connected).toBe(true)
    expect(network).not.toHaveBeenCalled()
  })
  it.each(['summit-roofing', 'harbor-resorts'])('populates traffic, page health and stored research for %s', async name => {
    const read = async (path: string) => {
      const response = await app.inject(`/api/v1/projects/${name}/${path}`)
      expect(response.statusCode, response.body).toBe(200)
      return response.json()
    }
    expect((await read('traffic/sources')).sources.length).toBeGreaterThan(0)
    expect(JSON.stringify(await read('traffic/events'))).toContain('gptbot')
    expect(JSON.stringify(await read('technical-aeo/pages'))).toContain('overallScore')
    expect(JSON.stringify(await read('research/runs'))).toContain('completed')
    const discoveries = await read('discover/sessions')
    expect(discoveries).toHaveLength(1)
    expect((await read(`discover/sessions/${discoveries[0].id}`)).probes).toHaveLength(2)
    expect(network).not.toHaveBeenCalled()
  })
  it('keeps stored Bing reads and conversion assessment view-only', async () => {
    const history = '/api/v1/projects/summit-roofing/bing/coverage/history'
    const before = (await app.inject(history)).json()
    await app.inject('/api/v1/projects/summit-roofing/bing/coverage')
    expect((await app.inject(history)).json()).toEqual(before)
    const contracts = (await app.inject('/api/v1/projects/summit-roofing/conversion-tracking/contracts')).json()
    const integrity = await app.inject(`/api/v1/projects/summit-roofing/conversion-tracking/contracts/${contracts[0].id}/integrity`)
    expect(integrity.statusCode, integrity.body).toBe(200)
    expect(integrity.json().assessment.contract.id).toBe(contracts[0].id)
    expect(network).not.toHaveBeenCalled()
  })
  it('denies webhook secret exports to the public demo viewer', async () => {
    const normal = await app.inject('/api/v1/projects/summit-roofing/export')
    expect(normal.statusCode).toBe(200)
    const secret = await app.inject('/api/v1/projects/summit-roofing/export?includeSecrets=true')
    expect(secret.statusCode).toBe(403)
    expect(secret.json().error.code).toBe('FORBIDDEN')
    expect(network).not.toHaveBeenCalled()
  })
  it.each(['report', 'report.html'])('retires the dedicated %s endpoint', async endpoint => {
    const response = await app.inject(`/api/v1/projects/harbor-resorts/${endpoint}`)
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('DEMO_READ_ONLY')
    expect(response.headers['content-disposition']).toBeUndefined()
    expect(network).not.toHaveBeenCalled()
  })
  it('serves a legacy Report document URL so the SPA can redirect to AI Visibility', async () => {
    const response = await app.inject('/projects/harbor-resorts/report')
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('id="root"')
    expect(response.headers['content-disposition']).toBeUndefined()
    expect(network).not.toHaveBeenCalled()
  })
})
