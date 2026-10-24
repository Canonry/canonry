import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SeoRepository } from '@canonry/canonry-db'
import { SeoAdapterOutcomes, emptySeoResults, seoKeywordMetricsListSchema, seoQuoteSchema, seoRunSchema } from '@canonry/canonry-contracts'
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

async function fixture() {
  const h = createSeoHarness({ skipAuth: false, routePrefix: '/canonry/api/v1' })
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
})
