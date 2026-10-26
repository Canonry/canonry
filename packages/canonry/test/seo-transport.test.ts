import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SeoRepository, projects, queries } from '@canonry/canonry-db'
import { SeoAdapterOutcomes, SeoCapabilities, SeoProviders, emptySeoResults, seoKeywordMetricsListSchema, seoQuoteSchema, seoRunSchema, type SeoAdapter, type SeoMarketRanking } from '@canonry/canonry-contracts'
import { eq } from 'drizzle-orm'
import type { ApiRoutesOptions } from '@canonry/canonry-api-routes'
import { createSeoHarness, seedSeoKey, seoProfileFixture } from '../../api-routes/test/seo-fixture.js'
import { ApiClient } from '../src/client.js'
import { SEO_CLI_COMMANDS } from '../src/cli-commands/seo.js'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'
import { readAeroViewEvidence } from '../src/agent/view-context.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function fixture(options: Partial<ApiRoutesOptions> = {}) {
  const h = createSeoHarness({ skipAuth: false, routePrefix: '/canonry/api/v1', ...options })
  cleanup.push(h.close)
  const root = seedSeoKey(h.db, 'root', ['*'])
  const runner = seedSeoKey(h.db, 'runner', ['read', 'seo.run'], 'alpha')
  const reader = seedSeoKey(h.db, 'reader', ['read'], 'alpha')
  await h.app.listen({ host: '127.0.0.1', port: 0 })
  const address = h.app.server.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener')
  const url = `http://127.0.0.1:${address.port}/canonry`
  const api = (token: string) => new ApiClient(url, token, { skipProbe: true })
  await api(root).putSeoProfile('alpha', 'us', seoProfileFixture)
  async function mcp(token: string, credentialScopes: string[]) {
    const server = createCanonryMcpServer({ tiers: ['core', 'seo'], credentialScopes, clientFactory: () => api(token) })
    const client = new Client({ name: 'seo-transport', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    cleanup.push(async () => { await client.close(); await server.close() })
    return client
  }
  return { ...h, root, runner, reader, url, api, mcp }
}

describe('SEO public transport parity', () => {
  it('runs an exact narrow-grant refresh through MCP without widening authority', async () => {
    const h = await fixture()
    const client = await h.mcp(h.runner, ['read', 'seo.run'])
    const tools = (await client.listTools()).tools.map(tool => tool.name)
    expect(tools).toContain('canonry_seo_sync')
    expect(tools).not.toContain('canonry_seo_profile_set')
    expect(tools).not.toContain('canonry_seo_operator_task')
    const intent = await client.callTool({ name: 'canonry_seo_refresh_intent', arguments: { project: 'alpha', profileId: 'us' } })
    expect(intent.isError).not.toBe(true)
    const quote = seoQuoteSchema.parse(intent.structuredContent)
    const request = { project: 'alpha', quoteToken: quote.token, idempotencyKey: 'mcp-exact-retry' }
    const first = await client.callTool({ name: 'canonry_seo_sync', arguments: request })
    const run = seoRunSchema.parse(first.structuredContent)
    expect((await client.callTool({ name: 'canonry_seo_sync', arguments: request })).structuredContent).toEqual(first.structuredContent)
    expect(h.requested).toEqual([run.id])
    const denied = await client.callTool({ name: 'canonry_seo_context', arguments: { project: 'beta' } })
    expect(denied.isError).toBe(true)
    expect(denied.structuredContent).toMatchObject({ error: { code: 'FORBIDDEN' } })
    await expect(h.api(h.runner).putSeoProfile('alpha', 'forbidden', seoProfileFixture)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.state.executions).toBe(0)
    expect(JSON.stringify(first.structuredContent)).not.toMatch(/reserved|actualCost|Micros|accountKey|budget/i)
  })

  it('returns the same saved null/zero values and scope through API, CLI, MCP and Aero', async () => {
    const h = await fixture()
    const api = h.api(h.root)
    const intent = await api.createSeoRefreshIntent('alpha', { profileId: 'us' })
    const run = await api.syncSeo('alpha', { quoteToken: intent.token, idempotencyKey: 'saved-evidence' })
    const repository = new SeoRepository(h.db)
    const task = repository.claim(run.id, { ...h.state.policy, accountKey: h.state.accountKey })!
    repository.settle(task.id, {
      outcome: SeoAdapterOutcomes.completed, error: null, fetchedAt: '2026-10-22T12:00:00.000Z',
      tasks: [{ remoteTaskId: 'upstream-receipt', statusCode: 20000, costMicros: 50 }],
      results: { ...emptySeoResults(), keywordMetrics: [{
        keyword: 'solar installer', searchVolume: 0, cpcUsd: null, adCompetition: null, keywordDifficulty: 37,
        searchIntent: null, monthlySearches: [], coreKeyword: null,
        provenance: { provider: 'dataforseo', dataset: 'keyword-overview', engine: 'google', locationCode: 2840, languageCode: 'en', device: 'unspecified', collectedAt: '2026-10-22T12:00:00.000Z', sourceUpdatedAt: null },
      }] },
    }, task.leaseOwner!)
    const query = { profileId: 'us', runId: run.id, limit: 1, offset: 0 }
    const expected = await h.api(h.reader).getSeoKeywordMetrics('alpha', query)
    expect(seoKeywordMetricsListSchema.parse(expected).items[0]).toMatchObject({ searchVolume: 0, cpcUsd: null, keywordDifficulty: 37 })
    const client = await h.mcp(h.reader, ['read'])
    expect((await client.callTool({ name: 'canonry_seo_keyword_metrics', arguments: { project: 'alpha', ...query } })).structuredContent).toEqual(expected)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-cli-'))
    cleanup.push(async () => { fs.rmSync(dir, { recursive: true, force: true }) })
    fs.writeFileSync(path.join(dir, 'config.yaml'), JSON.stringify({ apiUrl: h.url, apiKey: h.reader, basePath: '/canonry/', database: path.join(dir, 'unused.db'), providers: {} }))
    vi.stubEnv('CANONRY_CONFIG_DIR', dir)
    vi.stubEnv('CANONRY_BASE_PATH', '/canonry/')
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await dispatchRegisteredCommand(['seo', 'keyword-metrics', 'alpha', '--profile-id', 'us', '--run-id', run.id, '--limit', '1', '--offset', '0', '--format', 'json'], 'json', SEO_CLI_COMMANDS)
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual(expected)
    const overview = await api.getSeoOverview('alpha', { profileId: 'us' })
    expect(await readAeroViewEvidence({ client: h.api(h.reader), projectName: 'alpha', basePath: '/canonry/', context: { view: 'seo', seoProfileId: 'us' } })).toMatchObject({ overview, source: { href: '/canonry/projects/alpha/seo-data?seoProfileId=us' } })
    const readIntent = await h.api(h.reader).createSeoRefreshIntent('alpha', { profileId: 'us' })
    await expect(h.api(h.reader).syncSeo('alpha', { quoteToken: readIntent.token, idempotencyKey: 'denied' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.requested).toEqual([run.id])
    expect(h.state.executions).toBe(0)
  })

  it('filters saved market rankings identically through API, CLI and MCP', async () => {
    const policy = { maxRunCostMicros: 1_000_000, accountDailyLimitMicros: 1_000_000, accountMonthlyLimitMicros: 1_000_000, projectMonthlyLimitMicros: 1_000_000 }
    const adapter: SeoAdapter = {
      provider: SeoProviders.dataforseo, accountKey: 'account-a', capabilities: [SeoCapabilities['keyword-metrics'], SeoCapabilities['market-rankings']],
      estimate: () => ({ maxCostMicros: 10_000, catalogRevision: 'prices-1' }), execute: () => Promise.reject(new Error('Unexpected live request')),
    }
    const h = await fixture({ getSeoRuntime: () => ({ connections: [{ id: 'primary', label: 'Search data', adapter }], policy }) })
    h.db.insert(queries).values({ id: 'q1', projectId: 'alpha', query: 'best solar installer', createdAt: new Date().toISOString() }).run()
    h.db.update(projects).set({ locations: [{ label: 'Phoenix', city: 'Phoenix', region: 'AZ', country: 'US' }, { label: 'Tucson', city: 'Tucson', region: 'AZ', country: 'US' }] }).where(eq(projects.id, 'alpha')).run()
    const api = h.api(h.root)
    await api.putSeoProfile('alpha', 'markets', {
      ...seoProfileFixture, name: 'Market rankings', capabilities: [SeoCapabilities['market-rankings']], keywords: [], targets: [{ kind: 'domain', value: 'alpha.com', includeSubdomains: true }],
      rankings: { locations: [{ key: 'Phoenix', locationCode: 1013462, label: 'Phoenix, AZ' }, { key: 'Tucson', locationCode: 1013463, label: 'Tucson, AZ' }], depth: 50, device: 'mobile', searchText: 'query' },
    })
    const intent = await api.createSeoRefreshIntent('alpha', { profileId: 'markets' })
    const run = await api.syncSeo('alpha', { quoteToken: intent.token, idempotencyKey: 'market-rankings' })
    const repository = new SeoRepository(h.db)
    for (let task = repository.claim(run.id, { ...policy, accountKey: 'account-a' }); task; task = repository.claim(run.id, { ...policy, accountKey: 'account-a' })) {
      const search = task.request.search!
      // Phoenix's search ranks the site; Tucson's fails and stores nothing.
      const failed = search.markets.some(({ context }) => context.marketKey === 'Tucson')
      const rows: SeoMarketRanking[] = failed ? [] : search.markets.map(({ context }) => ({
        ...context, searchText: task.request.keywords[0]!, locationLabel: search.locationLabel, target: { kind: 'domain', value: 'alpha.com', includeSubdomains: true },
        searchStatus: 'completed', rankOrganic: 3, rankAbsolute: null, url: 'https://alpha.com/solar', depth: 50, competitors: [],
        provenance: { provider: 'dataforseo', dataset: 'dataforseo-serp/google/market-rankings', engine: 'google', locationCode: task.request.locationCode, languageCode: 'en', device: 'mobile', collectedAt: '2026-10-25T12:00:00.000Z', sourceUpdatedAt: null },
      }))
      repository.settle(task.id, { outcome: failed ? SeoAdapterOutcomes.failed : SeoAdapterOutcomes.completed, error: null, fetchedAt: '2026-10-25T12:00:00.000Z', tasks: [{ remoteTaskId: task.id, statusCode: failed ? 40101 : 20000, costMicros: 10_000 }], results: { ...emptySeoResults(), marketRankings: rows } }, task.leaseOwner!)
    }
    const query = { profileId: 'markets', marketKey: 'Tucson' }
    const expected = await h.api(h.reader).getSeoMarketRankings('alpha', query)
    // The failed search still answers its market, with nothing checked and no source.
    expect(expected).toMatchObject({ runId: run.id, total: 1, items: [{ marketKey: 'Tucson', queryText: 'best solar installer', searchText: 'best solar installer', searchStatus: 'failed', rankOrganic: null, depth: 0, provenance: null, locationLabel: 'Tucson, AZ' }] })
    const client = await h.mcp(h.reader, ['read'])
    expect((await client.callTool({ name: 'canonry_seo_market_rankings', arguments: { project: 'alpha', ...query } })).structuredContent).toEqual(expected)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-cli-'))
    cleanup.push(async () => { fs.rmSync(dir, { recursive: true, force: true }) })
    fs.writeFileSync(path.join(dir, 'config.yaml'), JSON.stringify({ apiUrl: h.url, apiKey: h.reader, basePath: '/canonry/', database: path.join(dir, 'unused.db'), providers: {} }))
    vi.stubEnv('CANONRY_CONFIG_DIR', dir)
    vi.stubEnv('CANONRY_BASE_PATH', '/canonry/')
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await dispatchRegisteredCommand(['seo', 'market-rankings', 'alpha', '--profile-id', 'markets', '--market', 'Tucson', '--format', 'json'], 'json', SEO_CLI_COMMANDS)
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual(expected)
    await dispatchRegisteredCommand(['seo', 'market-rankings', 'alpha', '--profile-id', 'markets', '--market', 'Tucson'], 'text', SEO_CLI_COMMANDS)
    expect(String(output.mock.calls.at(-1)?.[0])).toBe('Tucson\tbest solar installer\tSearch failed\tNo ranking page\tSearched as "best solar installer" from Tucson, AZ')
    await dispatchRegisteredCommand(['seo', 'market-rankings', 'alpha', '--profile-id', 'markets', '--market', 'Phoenix'], 'text', SEO_CLI_COMMANDS)
    expect(String(output.mock.calls.at(-1)?.[0])).toBe('Phoenix\tbest solar installer\tGoogle rank 3\thttps://alpha.com/solar\tSearched as "best solar installer" from Phoenix, AZ · mobile · 2026-10-25T12:00:00.000Z')
  })
})
