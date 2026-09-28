import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptySentimentCounts, sentimentJobSchema, sentimentSummarySchema, type SentimentJob } from '@ainyc/canonry-contracts'
import { sentimentFixtureSummary } from '../../contracts/test/fixtures/sentiment.js'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'

const TOKEN = 'cnry_sentiment_compat'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const close of cleanup.splice(0).reverse()) await close()
})

const assessment = { assessmentId: 'assessment', sourceSnapshotId: 'snapshot', runId: 'run-fixture', subjectId: 'subject', subjectLabel: 'Synthetic subject', executionNodeKey: null, provider: 'openai', requestedModel: 'requested', servedModel: 'served', location: null, evaluationDefinitionId: 'definition-fixture', state: 'complete', outcome: 'favorable', reason: null } as const
const { state, reason, provisional, coverage, score } = sentimentFixtureSummary
const current = sentimentSummarySchema.parse({ ...sentimentFixtureSummary, queries: [{ state, reason, provisional, coverage, score, queryId: 'query', queryText: 'Synthetic query', queryClass: 'branded', sourceSnapshotIds: ['snapshot'], assessments: [assessment], locations: [] }] })
const job: SentimentJob = sentimentJobSchema.parse({
  id: 'job', projectId: 'project', origin: 'backfill', state: 'pending', enablementEpoch: 1, evaluationDefinitionId: 'definition-fixture',
  selection: { mode: 'auto', queryClass: 'non-brand', scope: 'project', runId: 'run-fixture' }, createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
  counts: { ...emptySentimentCounts(), pending: 2 }, selected: 2, cancellationReason: null, attempts: [],
})

/**
 * A response from a server newer than this adapter: a new field at the top,
 * in a nested object and in a per-engine row, a new state and outcome, and a
 * count keyed by that outcome.
 */
const newerSummary = {
  ...current, pageInfo: { nextCursor: null }, state: 'queued',
  coverage: { ...current.coverage, counts: { ...current.coverage.counts, 'legacy-missing-language': 2 }, languageSkipped: 2 },
  queries: current.queries.map(row => ({ ...row, nodeLabel: 'node', assessments: row.assessments.map(item => ({ ...item, outcome: 'subject-renamed', attempts: 1 })) })),
}
const expectedSummary = {
  ...current, state: 'queued',
  coverage: { ...current.coverage, counts: { ...current.coverage.counts, 'legacy-missing-language': 2 } },
  queries: current.queries.map(row => ({ ...row, assessments: row.assessments.map(item => ({ ...item, outcome: 'subject-renamed' })) })),
}
// The list carries job summaries: an attempt total, never attempt receipts.
const { attempts: _attempts, ...listedJob } = { ...job, attemptCount: 2 }
const newerJobs = { jobs: [{ ...listedJob, state: 'paused', counts: { ...job.counts, 'legacy-missing-language': 1 }, costUsd: 0 }], nextCursor: null }
const expectedJobs = { jobs: [{ ...listedJob, state: 'paused', counts: { ...job.counts, 'legacy-missing-language': 1 } }] }

function serve(bodies: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const body = bodies[new URL(request.url).pathname]
    if (body === undefined) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'unexpected path' } }), { status: 404, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }))
}

async function connect(api: ApiClient): Promise<Client> {
  const server = createCanonryMcpServer({ eager: true, clientFactory: () => api })
  const client = new Client({ name: 'sentiment-compat-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanup.push(async () => { await client.close(); await server.close() })
  // Listing caches the client's own validator for each advertised output schema.
  await client.listTools()
  return client
}

describe('sentiment reads across adapter and server versions', () => {
  it('the strict DTOs reject the newer responses, which is what an older reader saw', () => {
    expect(sentimentSummarySchema.safeParse(newerSummary).success).toBe(false)
    expect(sentimentJobSchema.safeParse(newerJobs.jobs[0]).success).toBe(false)
  })

  it('reads a newer server through the CLI client, dropping unknown fields and keeping new values', async () => {
    serve({ '/api/v1/projects/demo/sentiment': newerSummary, '/api/v1/projects/demo/sentiment/jobs': newerJobs })
    const api = new ApiClient('https://sentiment-fixture.invalid', TOKEN, { skipProbe: true })
    expect(await api.getSentiment('demo', { queryClass: 'branded' })).toEqual(expectedSummary)
    expect(await api.listSentimentJobs('demo')).toEqual(expectedJobs)
  })

  it.each([
    ['canonry_sentiment', { project: 'demo' }, expectedSummary],
    ['canonry_sentiment_jobs', { project: 'demo' }, expectedJobs],
  ] as const)('%s returns a newer server response through MCP output validation', async (name, args, expected) => {
    serve({ '/api/v1/projects/demo/sentiment': newerSummary, '/api/v1/projects/demo/sentiment/jobs': newerJobs })
    const mcp = await connect(new ApiClient('https://sentiment-fixture.invalid', TOKEN, { skipProbe: true }))
    const result = await mcp.callTool({ name, arguments: args })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    expect(result.structuredContent).toEqual(expected)
    const text = (result.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text')!.text!
    expect(JSON.parse(text)).toEqual(expected)
  })

  it('returns a current server response unchanged through MCP', async () => {
    serve({ '/api/v1/projects/demo/sentiment': current })
    const mcp = await connect(new ApiClient('https://sentiment-fixture.invalid', TOKEN, { skipProbe: true }))
    const result = await mcp.callTool({ name: 'canonry_sentiment', arguments: { project: 'demo' } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual(current)
  })
})
