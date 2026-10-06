import { describe, expect, it, vi } from 'vitest'
import {
  createClient,
  getApiV1Projects,
  getApiV1ProjectsByNameTechnicalAeoGraph,
  getApiV1ProjectsByNameTechnicalAeoChanges,
  getApiV1ProjectsByNameTechnicalAeoPath,
  getApiV1ProjectsByNameTechnicalAeoRunsByRunIdPageHealthPreview,
  getApiV1ProjectsByNameTechnicalAeoSubgraph,
  getApiV1ProjectsByNameMeasurementReport,
  postApiV1ProjectsByNameMeasurementDiscovery,
  postApiV1ProjectsByNameResearchBatches,
} from '../src/index.js'

/**
 * Smoke tests for the generated SDK + the `createClient` factory.
 *
 * The drift test (CI: `codegen-drift` job) catches stale generated output.
 * These tests catch wiring regressions in the thin `createClient` helper —
 * if hey-api ever changes its config shape, the test fails locally.
 */
describe('canonry-api-client', () => {
  it('sends reviewed research destinations and their retry identity without rewriting final query text', async () => {
    const fakeFetch = vi.fn(async (_request: Request) => new Response(JSON.stringify({ runs: [] }), {
      status: 202, headers: { 'content-type': 'application/json' },
    }))
    const client = createClient({ baseUrl: 'https://example.test', fetch: fakeFetch as typeof fetch })
    const body = {
      idempotencyKey: 'reviewed-atlanta',
      runs: [{ queries: ['  Best apartments in Atlanta  '], provider: 'openai', model: 'gpt-test', location: null, scope: { kind: 'market' as const, key: 'atlanta', expectedPlanRevision: 4 } }],
    }
    const result = await postApiV1ProjectsByNameResearchBatches({ client, path: { name: 'portfolio' }, body })
    expect(result.data).toEqual({ runs: [] })
    expect(fakeFetch).toHaveBeenCalledTimes(1)
    const request = fakeFetch.mock.calls[0]![0]
    expect(request.url).toBe('https://example.test/api/v1/projects/portfolio/research/batches')
    expect(request.method).toBe('POST')
    expect(await request.json()).toEqual(body)
  })

  it('generates the bounded Site Health graph adapter surface', async () => {
    const fakeFetch = vi.fn(async (_request: Request) =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const client = createClient({
      baseUrl: 'https://example.test',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    await getApiV1ProjectsByNameTechnicalAeoGraph({
      client,
      path: { name: 'example' },
      query: { maxNodes: 20_000, maxEdges: 50_000 },
    })

    const request = fakeFetch.mock.calls[0]![0] as Request
    expect(request.url).toBe('https://example.test/api/v1/projects/example/technical-aeo/graph?maxNodes=20000&maxEdges=50000')
  })

  it('generates task-shaped Site Health agent reads', async () => {
    const fakeFetch = vi.fn(async (_request: Request) => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const client = createClient({ baseUrl: 'https://example.test', fetch: fakeFetch as unknown as typeof fetch })
    await getApiV1ProjectsByNameTechnicalAeoSubgraph({
      client, path: { name: 'example' }, query: { nodeKey: 'home', hops: 2, maxNodes: 25, maxEdges: 50 },
    })
    await getApiV1ProjectsByNameTechnicalAeoPath({
      client, path: { name: 'example' }, query: { toUrl: 'https://example.test/deep', maxDepth: 12 },
    })
    await getApiV1ProjectsByNameTechnicalAeoChanges({
      client, path: { name: 'example' }, query: { scope: 'pages', change: 'changed', limit: 25 },
    })

    const requests = fakeFetch.mock.calls.map((call) => (call[0] as Request).url)
    expect(requests).toEqual([
      'https://example.test/api/v1/projects/example/technical-aeo/subgraph?nodeKey=home&hops=2&maxNodes=25&maxEdges=50',
      'https://example.test/api/v1/projects/example/technical-aeo/path?toUrl=https%3A%2F%2Fexample.test%2Fdeep&maxDepth=12',
      'https://example.test/api/v1/projects/example/technical-aeo/changes?scope=pages&change=changed&limit=25',
    ])
  })

  it('generates the bounded, exact-run live Page Health preview reader', async () => {
    const fakeFetch = vi.fn(async (_request: Request) => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const client = createClient({ baseUrl: 'https://example.test', fetch: fakeFetch as unknown as typeof fetch })
    await getApiV1ProjectsByNameTechnicalAeoRunsByRunIdPageHealthPreview({
      client,
      path: { name: 'example', runId: 'run-1' },
    })

    const request = fakeFetch.mock.calls[0]![0] as Request
    expect(request.url).toBe('https://example.test/api/v1/projects/example/technical-aeo/runs/run-1/page-health-preview')
  })

  it('serializes measurement discovery bodies and report revisions', async () => {
    const fakeFetch = vi.fn(async (_request: Request) =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const client = createClient({
      baseUrl: 'https://example.test',
      fetch: fakeFetch as unknown as typeof fetch,
    })

    await postApiV1ProjectsByNameMeasurementDiscovery({
      client,
      path: { name: 'example' },
      body: {
        sitemapUrl: 'https://example.test/sitemap.xml',
        rule: {
          primary: { host: 'example.test', pathTemplate: '/locations/{slug}' },
        },
      },
    })
    await getApiV1ProjectsByNameMeasurementReport({
      client,
      path: { name: 'example' },
      query: { revision: 3 },
    })

    const discoveryRequest = fakeFetch.mock.calls[0]![0] as Request
    expect(discoveryRequest.url).toBe('https://example.test/api/v1/projects/example/measurement-discovery')
    expect(await discoveryRequest.json()).toMatchObject({
      sitemapUrl: 'https://example.test/sitemap.xml',
    })
    const reportRequest = fakeFetch.mock.calls[1]![0] as Request
    expect(reportRequest.url).toBe('https://example.test/api/v1/projects/example/measurement-report?revision=3')
  })

  it('createClient applies bearer auth + base URL to generated operations', async () => {
    const fakeFetch = vi.fn(async (_request: Request) =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const client = createClient({
      baseUrl: 'https://example.test/canonry',
      apiKey: 'cnry_test',
      fetch: fakeFetch as unknown as typeof fetch,
    })

    await getApiV1Projects({ client })

    expect(fakeFetch).toHaveBeenCalledOnce()
    const req = fakeFetch.mock.calls[0]![0] as Request
    expect(req.url).toBe('https://example.test/canonry/api/v1/projects')
    expect(req.headers.get('authorization')).toBe('Bearer cnry_test')
  })

  it('createClient omits authorization when no apiKey is given', async () => {
    const fakeFetch = vi.fn(async (_request: Request) =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const client = createClient({
      baseUrl: 'https://example.test',
      fetch: fakeFetch as unknown as typeof fetch,
    })

    await getApiV1Projects({ client })

    const req = fakeFetch.mock.calls[0]![0] as Request
    expect(req.headers.get('authorization')).toBeNull()
  })
})
