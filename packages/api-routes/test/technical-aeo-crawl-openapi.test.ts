import { expect, test } from 'vitest'
import { buildOpenApiDocument } from '../src/openapi.js'

test('crawl read routes are public, bounded, and backed by typed OpenAPI schemas', () => {
  const document = buildOpenApiDocument()
  const paths = document.paths ?? {}
  const cases: Array<[string, string]> = [
    ['/api/v1/projects/{name}/technical-aeo/crawl', 'SiteCrawlSummaryDto'],
    ['/api/v1/projects/{name}/technical-aeo/graph', 'SiteCrawlGraphResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/subgraph', 'SiteHealthSubgraphResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/path', 'SiteHealthPathResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/changes', 'SiteHealthChangesResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/crawl/pages/audit', 'SiteCrawlPageAuditDto'],
    ['/api/v1/projects/{name}/technical-aeo/crawl/pages', 'SiteCrawlPagesResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/structure', 'SiteCrawlStructureResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/internal-links', 'SiteCrawlInternalLinksResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/internal-links/neighbors', 'SiteCrawlNeighborsResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/dead-links', 'SiteCrawlDeadLinksResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/runs/{runId}/progress', 'SiteAuditRunProgressDto'],
    ['/api/v1/projects/{name}/technical-aeo/runs/{runId}/page-health-preview', 'SiteAuditLivePageHealthDto'],
  ]

  for (const [path, schema] of cases) {
    const operation = paths[path]?.get
    expect(operation, `${path} must be documented`).toBeDefined()
    expect(operation?.responses?.['200']?.content?.['application/json']?.schema?.$ref)
      .toBe(`#/components/schemas/${schema}`)
  }

  const livePreview = paths['/api/v1/projects/{name}/technical-aeo/runs/{runId}/page-health-preview']!.get!
  expect(livePreview.parameters?.some((parameter) => parameter.name === 'runId')).toBe(true)
  expect(livePreview.description).toMatch(/provisional/i)

  const pages = paths['/api/v1/projects/{name}/technical-aeo/crawl/pages']!.get!
  expect(pages.parameters?.some((parameter) => parameter.name === 'cursor')).toBe(true)
  expect(pages.parameters?.some((parameter) => parameter.name === 'limit')).toBe(true)
  const pageAudit = paths['/api/v1/projects/{name}/technical-aeo/crawl/pages/audit']!.get!
  expect(pageAudit.parameters?.some((parameter) => parameter.name === 'nodeKey')).toBe(true)
  expect(pageAudit.parameters?.some((parameter) => parameter.name === 'url')).toBe(true)
  expect(pageAudit.description).toMatch(/legacy score-only/i)
  expect(paths['/api/v1/projects/{name}/technical-aeo/dead-links']!.get?.description).toMatch(/discriminated/i)

  const graph = paths['/api/v1/projects/{name}/technical-aeo/graph']!.get!
  expect(graph.parameters?.find((parameter) => parameter.name === 'maxNodes')?.schema).toMatchObject({ minimum: 1, maximum: 20_000 })
  expect(graph.parameters?.find((parameter) => parameter.name === 'maxEdges')?.schema).toMatchObject({ minimum: 1, maximum: 50_000 })

  const subgraph = paths['/api/v1/projects/{name}/technical-aeo/subgraph']!.get!
  expect(subgraph.parameters?.find((parameter) => parameter.name === 'hops')?.schema).toMatchObject({ minimum: 0, maximum: 3 })
  expect(subgraph.parameters?.find((parameter) => parameter.name === 'maxNodes')?.schema).toMatchObject({ minimum: 1, maximum: 200 })
  expect(subgraph.parameters?.find((parameter) => parameter.name === 'maxEdges')?.schema).toMatchObject({ minimum: 1, maximum: 500 })

  const path = paths['/api/v1/projects/{name}/technical-aeo/path']!.get!
  expect(path.parameters?.find((parameter) => parameter.name === 'maxDepth')?.schema).toMatchObject({ minimum: 1, maximum: 24 })

  const changes = paths['/api/v1/projects/{name}/technical-aeo/changes']!.get!
  expect(changes.parameters?.find((parameter) => parameter.name === 'limit')?.schema).toMatchObject({ minimum: 1, maximum: 100 })
  expect(changes.parameters?.some((parameter) => parameter.name === 'cursor')).toBe(true)
})

test('scan history is a typed, bounded read that shares its path with the trigger', () => {
  const document = buildOpenApiDocument()
  const scans = document.paths?.['/api/v1/projects/{name}/technical-aeo/runs']?.get
  expect(scans).toBeDefined()
  expect(scans?.responses?.['200']?.content?.['application/json']?.schema?.$ref)
    .toBe('#/components/schemas/SiteHealthScansResponseDto')
  expect(scans?.parameters?.find((parameter) => parameter.name === 'limit')?.schema)
    .toMatchObject({ minimum: 1, maximum: 100 })
  // The legacy-scan contract is the point of the field; say so in the spec.
  expect(scans?.description).toMatch(/hasCrawlData/)
  expect(scans?.description).toMatch(/404/)
  // The POST trigger still lives on the same path and is unaffected.
  expect(document.paths?.['/api/v1/projects/{name}/technical-aeo/runs']?.post).toBeDefined()

  const graph = document.components?.schemas?.SiteCrawlGraphResponseDto as {
    properties?: Record<string, unknown>
  }
  expect(graph.properties?.rootNodeKey).toBeDefined()
})

test('crawl summary nullability and run budgets are machine-readable in OpenAPI', () => {
  const document = buildOpenApiDocument()
  const paths = document.paths ?? {}
  const summary = document.components?.schemas?.SiteCrawlSummaryDto as {
    properties?: Record<string, unknown>
  }
  const runStatus = summary.properties?.runStatus as { anyOf?: Array<{ enum?: unknown[] }> }

  // `runStatus` is null when there is no persisted crawl. Use an explicit
  // union because client generators do not consistently honor OAS 3.0
  // `nullable` alongside an enum.
  expect(runStatus.anyOf).toEqual(expect.arrayContaining([
    expect.objectContaining({ enum: expect.arrayContaining([null]) }),
  ]))

  const run = paths['/api/v1/projects/{name}/technical-aeo/runs']!.post!
  const properties = run.requestBody?.content?.['application/json']?.schema?.properties as Record<string, {
    minimum?: number
    maximum?: number
  }>
  expect(properties.limit).toMatchObject({ minimum: 1, maximum: 2_000 })
  expect(properties.maxPages).toMatchObject({ minimum: 1, maximum: 50_000 })
  expect(properties.maxEdges).toMatchObject({ minimum: 1, maximum: 1_000_000 })
  expect(properties.maxDepth).toMatchObject({ minimum: 0, maximum: 100 })
  expect(run.responses?.['409']).toBeDefined()
  expect(run.description).toMatch(/reused only when.*match exactly/i)
  // Selection stays date-scoped, excludes probes, and qualifies incomplete evidence.
  const crawlDescription = paths['/api/v1/projects/{name}/technical-aeo/crawl']!.get?.description
  expect(crawlDescription).toMatch(/non-probe.*requested UTC date.*latest scan date/i)
  expect(crawlDescription).toMatch(/complete scans, then the largest page sample, then the latest scan on that date/i)
  expect(crawlDescription).toMatch(/`complete` and `termination` qualify budget-limited evidence/i)
  expect(crawlDescription).toMatch(/dated no-data.*bounded `availableScanDates`.*full distinct-date totals/i)
})
