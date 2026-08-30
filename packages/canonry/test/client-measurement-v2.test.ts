import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ApiClient } from '../src/client.js'

const PROJECT = 'northstar'
const ETAG = '"mpd_7"'
const IDEMPOTENCY_KEY = 'northstar-request'

type ReceivedRequest = {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

type MockResponse = {
  status: number
  body: unknown
}

let server: Server
let baseUrl: string
let requests: ReceivedRequest[] = []
let responses: MockResponse[] = []

function client(): ApiClient {
  return new ApiClient(baseUrl, 'cnry_northstar', { skipProbe: true })
}

function queueResponse(status = 200, body: unknown = {}): void {
  responses.push({ status, body })
}

function requestAt(index = 0): ReceivedRequest {
  const request = requests[index]
  if (!request) throw new Error(`Expected request ${index + 1}`)
  return request
}

function assertRequest(
  expected: {
    method: string
    pathname: string
    query?: Record<string, string>
    headers?: Record<string, string | undefined>
  },
): void {
  expect(requests).toHaveLength(1)
  const request = requestAt()
  const url = new URL(request.url, baseUrl)
  expect(request.method).toBe(expected.method)
  expect(url.pathname).toBe(expected.pathname)
  for (const [key, value] of Object.entries(expected.query ?? {})) {
    expect(url.searchParams.get(key)).toBe(value)
  }
  for (const [key, value] of Object.entries(expected.headers ?? {})) {
    expect(request.headers[key.toLowerCase()]).toBe(value)
  }
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body,
    })
    const next = responses.shift() ?? { status: 200, body: {} }
    response.writeHead(next.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(next.body))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

beforeEach(() => {
  requests = []
  responses = []
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

describe('ApiClient Advanced Measurement v2 reads', () => {
  const cases = [
    {
      name: 'setup',
      invoke: (api: ApiClient) => api.getMeasurementSetup(PROJECT),
      expected: { method: 'GET', pathname: `/api/v1/projects/${PROJECT}/measurement-setup` },
    },
    {
      name: 'per-query status',
      invoke: (api: ApiClient) => api.getMeasurementQueryStatuses(PROJECT),
      expected: { method: 'GET', pathname: `/api/v1/projects/${PROJECT}/measurement-query-statuses` },
    },
    {
      name: 'overview',
      invoke: (api: ApiClient) => api.getMeasurementOverview(PROJECT, { scope: 'all', sort: 'citationCoverage-asc' }),
      expected: {
        method: 'GET',
        pathname: `/api/v1/projects/${PROJECT}/measurement-overview`,
        query: { scope: 'all', sort: 'citationCoverage-asc' },
      },
    },
    {
      name: 'report pinned to a run',
      invoke: (api: ApiClient) => api.getMeasurementReport(PROJECT, 2, 'run-7'),
      expected: {
        method: 'GET',
        pathname: `/api/v1/projects/${PROJECT}/measurement-report`,
        query: { revision: '2', runId: 'run-7' },
      },
    },
    {
      name: 'draft',
      invoke: (api: ApiClient) => api.getMeasurementPlanDraft(PROJECT),
      expected: { method: 'GET', pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft` },
    },
    {
      name: 'draft targets',
      invoke: (api: ApiClient) => api.getMeasurementDraftTargets(PROJECT, { search: 'northstar', cursor: 'next', limit: 10 }),
      expected: {
        method: 'GET',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/targets`,
        query: { search: 'northstar', cursor: 'next', limit: '10' },
      },
    },
    {
      name: 'draft assignments',
      invoke: (api: ApiClient) => api.getMeasurementDraftAssignments(PROJECT, { search: 'northstar', cursor: 'next', limit: 10 }),
      expected: {
        method: 'GET',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/assignments`,
        query: { search: 'northstar', cursor: 'next', limit: '10' },
      },
    },
    {
      name: 'draft groups',
      invoke: (api: ApiClient) => api.getMeasurementDraftGroups(PROJECT, { search: 'northstar', cursor: 'next', limit: 10 }),
      expected: {
        method: 'GET',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/groups`,
        query: { search: 'northstar', cursor: 'next', limit: '10' },
      },
    },
    {
      name: 'query sets',
      invoke: (api: ApiClient) => api.listMeasurementQuerySets(PROJECT),
      expected: { method: 'GET', pathname: `/api/v1/projects/${PROJECT}/measurement-query-sets` },
    },
    {
      name: 'query set detail',
      invoke: (api: ApiClient) => api.getMeasurementQuerySet(PROJECT, 'northstar-set'),
      expected: { method: 'GET', pathname: `/api/v1/projects/${PROJECT}/measurement-query-sets/northstar-set` },
    },
    {
      name: 'query templates',
      invoke: (api: ApiClient) => api.listMeasurementQueryTemplates(PROJECT),
      expected: { method: 'GET', pathname: `/api/v1/projects/${PROJECT}/measurement-query-templates` },
    },
  ]

  it.each(cases)('calls $name through the generated SDK', async ({ invoke, expected }) => {
    queueResponse()
    await invoke(client())
    assertRequest(expected)
  })
})

describe('ApiClient measurement demo reads', () => {
  const cases = [
    {
      name: 'portfolio summary',
      invoke: (api: ApiClient) => api.getMeasurementPortfolioSummary(PROJECT, {
        groupKey: 'northstar-group',
        queryClass: 'non-brand',
        provider: 'openai',
        location: 'New York, NY',
        runId: 'run-7',
        limit: 8,
      }),
      expected: {
        method: 'GET',
        pathname: `/api/v1/projects/${PROJECT}/measurement-portfolio-summary`,
        query: {
          groupKey: 'northstar-group',
          queryClass: 'non-brand',
          provider: 'openai',
          location: 'New York, NY',
          runId: 'run-7',
          limit: '8',
        },
      },
    },
    {
      name: 'Property questions',
      invoke: (api: ApiClient) => api.getMeasurementPropertyQuestions(PROJECT, {
        targetKey: 'northstar-home',
        queryClass: 'branded',
        provider: 'openai',
        location: 'New York, NY',
        runId: 'run-7',
        limit: 10,
      }),
      expected: {
        method: 'GET',
        pathname: `/api/v1/projects/${PROJECT}/measurement-property-questions`,
        query: {
          targetKey: 'northstar-home',
          queryClass: 'branded',
          provider: 'openai',
          location: 'New York, NY',
          runId: 'run-7',
          limit: '10',
        },
      },
    },
    {
      name: 'one question result',
      invoke: (api: ApiClient) => api.getMeasurementQuestionResult(PROJECT, {
        targetKey: 'northstar-home',
        resultId: 'result-7',
      }),
      expected: {
        method: 'GET',
        pathname: `/api/v1/projects/${PROJECT}/measurement-question-result`,
        query: { targetKey: 'northstar-home', resultId: 'result-7' },
      },
    },
    {
      name: 'Property competitors',
      invoke: (api: ApiClient) => api.getMeasurementPropertyCompetitors(PROJECT, {
        targetKey: 'northstar-home',
        queryClass: 'non-brand',
        provider: 'openai',
        location: 'New York, NY',
        runId: 'run-7',
        limit: 5,
      }),
      expected: {
        method: 'GET',
        pathname: `/api/v1/projects/${PROJECT}/measurement-property-competitors`,
        query: {
          targetKey: 'northstar-home',
          queryClass: 'non-brand',
          provider: 'openai',
          location: 'New York, NY',
          runId: 'run-7',
          limit: '5',
        },
      },
    },
    {
      name: 'same-identity changes',
      invoke: (api: ApiClient) => api.getMeasurementChanges(PROJECT, {
        scope: 'group',
        groupKey: 'northstar-group',
        queryClass: 'non-brand',
        provider: 'openai',
        location: 'New York, NY',
        runId: 'run-7',
        limit: 5,
      }),
      expected: {
        method: 'GET',
        pathname: `/api/v1/projects/${PROJECT}/measurement-changes`,
        query: {
          scope: 'group',
          groupKey: 'northstar-group',
          queryClass: 'non-brand',
          provider: 'openai',
          location: 'New York, NY',
          runId: 'run-7',
          limit: '5',
        },
      },
    },
    {
      name: 'data quality',
      invoke: (api: ApiClient) => api.getMeasurementDataQuality(PROJECT, { runId: 'run-7' }),
      expected: {
        method: 'GET',
        pathname: `/api/v1/projects/${PROJECT}/measurement-data-quality`,
        query: { runId: 'run-7' },
      },
    },
  ]

  it.each(cases)('calls $name through the generated SDK', async ({ invoke, expected }) => {
    queueResponse()
    await invoke(client())
    assertRequest(expected)
  })
})

describe('ApiClient Advanced Measurement v2 draft actions', () => {
  const target = {
    stableKey: 'northstar-home',
    label: 'Northstar home',
    status: 'included',
    aliases: ['Northstar'],
    urlMatchers: ['https://example.com/northstar'],
    source: 'manual',
  }
  const ordinaryHeaders = { 'Idempotency-Key': IDEMPOTENCY_KEY, 'If-Match': ETAG }
  const cases = [
    {
      name: 'create',
      invoke: (api: ApiClient) => api.createMeasurementPlanDraft(PROJECT, { expectedActiveRevision: null }, IDEMPOTENCY_KEY),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/create`,
        headers: { 'Idempotency-Key': IDEMPOTENCY_KEY, 'If-Match': undefined },
      },
    },
    {
      name: 'import sitemap',
      invoke: (api: ApiClient) => api.importMeasurementDraftSitemap(PROJECT, {
        sitemapUrl: 'https://example.com/sitemap.xml',
        rule: { primary: { host: 'example.com', pathTemplate: '/properties/{slug}' } },
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/import-sitemap`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'apply sitemap selection',
      invoke: (api: ApiClient) => api.applyMeasurementDraftSitemapSelection(PROJECT, {
        selections: [{ discoveryIdentity: 'northstar-home', action: 'create', label: 'Northstar home' }],
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/apply-sitemap-selection`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'upsert target',
      invoke: (api: ApiClient) => api.upsertMeasurementDraftTarget(PROJECT, { target }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/upsert-target`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'rename target',
      invoke: (api: ApiClient) => api.renameMeasurementDraftTarget(PROJECT, {
        targetKey: target.stableKey,
        label: 'Northstar overview',
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/rename-target`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'merge targets',
      invoke: (api: ApiClient) => api.mergeMeasurementDraftTargets(PROJECT, {
        targetKey: target.stableKey,
        mergedKeys: ['northstar-archive'],
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/merge-targets`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'exclude target',
      invoke: (api: ApiClient) => api.excludeMeasurementDraftTarget(PROJECT, { targetKey: target.stableKey }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/exclude-target`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'rebind target',
      invoke: (api: ApiClient) => api.rebindMeasurementDraftTarget(PROJECT, {
        targetKey: target.stableKey,
        discoveryIdentity: 'northstar-home',
        discoveredUrl: 'https://example.com/northstar-home',
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/rebind-target`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'apply assignments',
      invoke: (api: ApiClient) => api.applyMeasurementDraftAssignments(PROJECT, {
        targetKey: target.stableKey,
        queryIds: ['northstar-query'],
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/apply-assignments`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'preview assignments',
      invoke: (api: ApiClient) => api.previewMeasurementDraftAssignments(PROJECT, {
        groupKeys: ['northstar-group'],
        queryIds: ['northstar-query'],
      }),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/preview-assignments`,
        headers: { 'Idempotency-Key': undefined, 'If-Match': undefined },
      },
    },
    {
      name: 'replace assignments',
      invoke: (api: ApiClient) => api.replaceMeasurementDraftAssignments(PROJECT, {
        groupKeys: ['northstar-group'],
        queryIds: ['northstar-query'],
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/replace-assignments`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'replace query text',
      invoke: (api: ApiClient) => api.replaceMeasurementDraftQuery(PROJECT, {
        queryId: 'northstar-query',
        queryText: 'Quiet apartments near transit',
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/replace-query`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'remove assignment',
      invoke: (api: ApiClient) => api.removeMeasurementDraftAssignment(PROJECT, {
        targetKey: target.stableKey,
        queryId: 'northstar-query',
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/remove-assignment`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'clear assignments',
      invoke: (api: ApiClient) => api.clearMeasurementDraftAssignments(PROJECT, {
        targetKey: target.stableKey,
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/clear-assignments`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'classify assignments',
      invoke: (api: ApiClient) => api.classifyMeasurementDraftAssignments(PROJECT, {
        queryClass: 'branded',
        assignments: [{ targetKey: target.stableKey, queryId: 'northstar-query' }],
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/classify-assignments`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'upsert group',
      invoke: (api: ApiClient) => api.upsertMeasurementDraftGroup(PROJECT, {
        group: { stableKey: 'northstar-group', label: 'Northstar group', targetKeys: [target.stableKey] },
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/upsert-group`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'remove group',
      invoke: (api: ApiClient) => api.removeMeasurementDraftGroup(PROJECT, {
        groupKey: 'northstar-group',
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/remove-group`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'preview group membership',
      invoke: (api: ApiClient) => api.previewMeasurementDraftGroupMembership(PROJECT, {
        csv: 'property,group\nNorthstar home,Northstar group',
      }),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/preview-group-membership`,
        headers: { 'Idempotency-Key': undefined, 'If-Match': undefined },
      },
    },
    {
      name: 'apply group membership',
      invoke: (api: ApiClient) => api.applyMeasurementDraftGroupMembership(PROJECT, {
        csv: 'property,group\nNorthstar home,Northstar group',
        sourceChecksum: 'a'.repeat(64),
        previewChecksum: 'b'.repeat(64),
        acceptedRows: [1],
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/apply-group-membership`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'upsert competitor',
      invoke: (api: ApiClient) => api.upsertMeasurementDraftCompetitor(PROJECT, {
        groupKey: 'northstar-group',
        competitor: { stableKey: 'northstar-peer', label: 'Northstar peer', domain: 'example.com', aliases: ['Northstar peer'] },
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/upsert-competitor`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'remove competitor',
      invoke: (api: ApiClient) => api.removeMeasurementDraftCompetitor(PROJECT, {
        groupKey: 'northstar-group',
        competitorKey: 'northstar-peer',
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/remove-competitor`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'compile preview',
      invoke: (api: ApiClient) => api.compileMeasurementDraftPreview(PROJECT),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/compile-preview`,
        headers: { 'Idempotency-Key': undefined, 'If-Match': undefined },
      },
    },
    {
      name: 'diff preview',
      invoke: (api: ApiClient) => api.diffMeasurementDraftPreview(PROJECT),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/diff-preview`,
        headers: { 'Idempotency-Key': undefined, 'If-Match': undefined },
      },
    },
    {
      name: 'publish',
      invoke: (api: ApiClient) => api.publishMeasurementDraft(PROJECT, {
        expectedActiveRevision: null,
        expectedCompiledChecksum: 'a'.repeat(64),
      }, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/publish`,
        headers: ordinaryHeaders,
      },
    },
    {
      name: 'discard',
      invoke: (api: ApiClient) => api.discardMeasurementDraft(PROJECT, IDEMPOTENCY_KEY, ETAG),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/discard`,
        headers: ordinaryHeaders,
      },
    },
  ]

  it.each(cases)('calls $name with its required draft mutation headers', async ({ invoke, expected }) => {
    queueResponse()
    await invoke(client())
    assertRequest(expected)
  })

  it('omits an absent ETag and preserves the literal 428 draft-precondition error', async () => {
    queueResponse(428, {
      error: {
        code: 'MEASUREMENT_DRAFT_ETAG_REQUIRED',
        message: 'This action requires the current draft ETag in `If-Match`. Reload the draft and retry.',
      },
    })

    await expect(client().renameMeasurementDraftTarget(PROJECT, {
      targetKey: target.stableKey,
      label: 'Northstar overview',
    }, IDEMPOTENCY_KEY)).rejects.toMatchObject({
      code: 'MEASUREMENT_DRAFT_ETAG_REQUIRED',
      details: { httpStatus: 428 },
    })

    assertRequest({
      method: 'POST',
      pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/rename-target`,
      headers: { 'Idempotency-Key': IDEMPOTENCY_KEY, 'If-Match': undefined },
    })
  })

  it('preserves the literal 412 stale-draft error distinctly from 428', async () => {
    queueResponse(412, {
      error: {
        code: 'MEASUREMENT_DRAFT_ETAG_STALE',
        message: 'The measurement draft changed since it was loaded. Reload it and retry.',
      },
    })

    await expect(client().renameMeasurementDraftTarget(PROJECT, {
      targetKey: target.stableKey,
      label: 'Northstar overview',
    }, IDEMPOTENCY_KEY, '"mpd_3"')).rejects.toMatchObject({
      code: 'MEASUREMENT_DRAFT_ETAG_STALE',
      details: { httpStatus: 412 },
    })

    assertRequest({
      method: 'POST',
      pathname: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/rename-target`,
      headers: { 'Idempotency-Key': IDEMPOTENCY_KEY, 'If-Match': '"mpd_3"' },
    })
  })
})

describe('ApiClient Advanced Measurement v2 plan and query assets', () => {
  const cases = [
    {
      name: 'deactivate',
      invoke: (api: ApiClient) => api.deactivateMeasurementPlan(PROJECT, { expectedActiveRevision: 2 }, IDEMPOTENCY_KEY),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-plan/actions/deactivate`,
        headers: { 'Idempotency-Key': IDEMPOTENCY_KEY, 'If-Match': undefined },
      },
    },
    {
      name: 'upsert query set',
      invoke: (api: ApiClient) => api.upsertMeasurementQuerySet(PROJECT, 'northstar-set', {
        name: 'Northstar queries',
        description: 'Northstar fixture queries',
        queryIds: ['northstar-query'],
      }),
      expected: {
        method: 'PUT',
        pathname: `/api/v1/projects/${PROJECT}/measurement-query-sets/northstar-set`,
        headers: { 'Idempotency-Key': undefined, 'If-Match': undefined },
      },
    },
    {
      name: 'delete query set',
      invoke: (api: ApiClient) => api.deleteMeasurementQuerySet(PROJECT, 'northstar-set'),
      expected: {
        method: 'DELETE',
        pathname: `/api/v1/projects/${PROJECT}/measurement-query-sets/northstar-set`,
        headers: { 'Idempotency-Key': undefined, 'If-Match': undefined },
      },
    },
    {
      name: 'upsert query template',
      invoke: (api: ApiClient) => api.upsertMeasurementQueryTemplate(PROJECT, 'northstar-template', {
        name: 'Northstar template',
        description: 'Northstar fixture template',
        pattern: 'best {topic}',
        variables: ['topic'],
      }),
      expected: {
        method: 'PUT',
        pathname: `/api/v1/projects/${PROJECT}/measurement-query-templates/northstar-template`,
        headers: { 'Idempotency-Key': undefined, 'If-Match': undefined },
      },
    },
    {
      name: 'delete query template',
      invoke: (api: ApiClient) => api.deleteMeasurementQueryTemplate(PROJECT, 'northstar-template'),
      expected: {
        method: 'DELETE',
        pathname: `/api/v1/projects/${PROJECT}/measurement-query-templates/northstar-template`,
        headers: { 'Idempotency-Key': undefined, 'If-Match': undefined },
      },
    },
    {
      name: 'apply query template',
      invoke: (api: ApiClient) => api.applyMeasurementQueryTemplate(PROJECT, 'northstar-template', {
        bindings: [{ topic: 'northstar' }],
        querySetId: 'northstar-set',
      }, IDEMPOTENCY_KEY),
      expected: {
        method: 'POST',
        pathname: `/api/v1/projects/${PROJECT}/measurement-query-templates/northstar-template/apply`,
        headers: { 'Idempotency-Key': IDEMPOTENCY_KEY, 'If-Match': undefined },
      },
    },
  ]

  it.each(cases)('calls $name with the route-specific mutation headers', async ({ invoke, expected }) => {
    queueResponse()
    await invoke(client())
    assertRequest(expected)
  })
})
