import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { emptySentimentCounts, sentimentOutcomeSchema, type SentimentBackfillPreview, type SentimentEvidencePage, type SentimentJob } from '@ainyc/canonry-contracts'
import { sentimentFixtureSummary } from '../../contracts/test/fixtures/sentiment.js'
import * as clientModule from '../src/client.js'
import { ApiClient } from '../src/client.js'
import { SENTIMENT_CLI_COMMANDS } from '../src/cli-commands/sentiment.js'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { CliError } from '../src/cli-error.js'
import { createCanonryMcpServerWithCatalog } from '../src/mcp/server.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Whole response bodies as the server sends them: the client reads each one
// with its tolerant reader, which still requires every field it knows.
const evidencePage: SentimentEvidencePage = { state: 'complete', selection: { ...sentimentFixtureSummary.selection, runId: null, runIds: ['run-bayside', 'run-harbor'] }, items: [], nextCursor: null }
const preview: SentimentBackfillPreview = { previewToken: null, expiresAt: null, selection: { mode: 'auto', queryClass: 'non-brand', scope: 'project', runIds: ['run-bayside', 'run-harbor'] }, evaluationDefinitionId: 'frozen-definition', eligibleAssessments: 0, alreadyClassified: 0, skipped: [], estimatedInputTokens: 0, estimatedCostUsd: null, estimateMethod: 'Token and cost estimates unavailable on this host.' }
const receipt: SentimentJob = { id: 'same-job', projectId: 'project', origin: 'backfill', state: 'pending', enablementEpoch: 1, evaluationDefinitionId: 'frozen-definition', selection: preview.selection, createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z', counts: { ...emptySentimentCounts(), pending: 1 }, selected: 1, cancellationReason: null, attempts: [] }

describe('sentiment generated SDK client', () => {
  it('preserves the base path, all identity filters and the canonical HTTP DTO', async () => {
    let received: Request | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      received = input instanceof Request ? input : new Request(input, init)
      return new Response(JSON.stringify(sentimentFixtureSummary), { headers: { 'content-type': 'application/json' } })
    }))
    const client = new ApiClient('https://canonry.test/prefix', 'cnry_test', { skipProbe: true })
    const selection = { runId: 'run', queryId: 'frozen-query', revision: 4, mode: 'advanced' as const, queryClass: 'non-brand' as const, scope: 'property' as const, scopeKey: 'property', marketKey: 'market', provider: 'openai', model: 'vendor/model:v1', location: 'New York', evaluationDefinitionId: 'definition' }
    expect(await client.getSentiment('demo', selection)).toEqual(sentimentFixtureSummary)
    const url = new URL(received!.url)
    expect(url.pathname).toBe('/prefix/api/v1/projects/demo/sentiment')
    expect(Object.fromEntries(url.searchParams)).toEqual({ ...selection, revision: '4' })
    expect(received!.headers.get('authorization')).toBe('Bearer cnry_test')
  })
  it.each(['summary', 'evidence', 'preview'] as const)('sends exact runIds as repeated HTTP query parameters for %s', async operation => {
    let received: Request | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      received = input instanceof Request ? input : new Request(input, init)
      return Response.json(operation === 'summary' ? sentimentFixtureSummary : operation === 'evidence' ? evidencePage : preview)
    }))
    const client = new ApiClient('https://canonry.test/prefix', 'cnry_test', { skipProbe: true })
    const runIds = ['run-bayside', 'run-harbor']
    const selection = { runIds, queryClass: 'non-brand' as const, queryId: 'frozen-query', evaluationDefinitionId: 'frozen-definition' }
    if (operation === 'summary') await client.getSentiment('demo', selection)
    else if (operation === 'evidence') await client.getSentimentEvidence('demo', { ...selection, assessmentId: 'exact-assessment', cursor: 'cursor', limit: 7 })
    else await client.previewSentimentBackfill('demo', { mode: 'auto', scope: 'project', ...selection })
    const url = new URL(received!.url)
    expect(url.searchParams.getAll('runIds')).toEqual(runIds)
    expect(url.searchParams.has('runId')).toBe(false)
    expect(url.searchParams.get('queryClass')).toBe('non-brand')
    expect(url.searchParams.get('queryId')).toBe('frozen-query')
    expect(url.searchParams.get('evaluationDefinitionId')).toBe('frozen-definition')
    if (operation === 'evidence') { expect(url.searchParams.get('cursor')).toBe('cursor'); expect(url.searchParams.get('assessmentId')).toBe('exact-assessment') }
  })
  it('sends an evidence outcome filter as repeated HTTP query parameters and reads its echo, through the client, CLI and MCP', async () => {
    // The server's page for a branded Property narrowed to its criticism, with the filter echoed sorted.
    const page: SentimentEvidencePage = { state: 'complete', selection: { ...sentimentFixtureSummary.selection, scope: 'property', scopeKey: 'property-a', outcome: ['mixed', 'unfavorable'] }, items: [], nextCursor: null }
    const requests: Request[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init))
      return Response.json(page)
    }))
    const api = new ApiClient('https://canonry.test/prefix', 'cnry_test', { skipProbe: true })
    const outcome = ['mixed', 'unfavorable'] as const
    expect(await api.getSentimentEvidence('demo', { queryClass: 'branded', scope: 'property', scopeKey: 'property-a', outcome: [...outcome] })).toEqual(page)

    vi.spyOn(clientModule, 'createApiClient').mockReturnValue(api)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await dispatchRegisteredCommand(['sentiment', 'evidence', 'demo', '--query-class', 'branded', '--scope', 'property', '--scope-key', 'property-a', '--outcome', 'mixed,unfavorable'], 'json', SENTIMENT_CLI_COMMANDS)
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(page)

    const { server } = createCanonryMcpServerWithCatalog({ clientFactory: () => api, scope: 'read-only', eager: true })
    const mcp = new Client({ name: 'sentiment-outcome-test', version: '1' }, { capabilities: {} })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await mcp.connect(clientTransport)
      const listed = (await mcp.listTools()).tools.find(entry => entry.name === 'canonry_sentiment_evidence')
      expect((listed?.inputSchema.properties as Record<string, { items?: { enum?: string[] } }>).outcome?.items?.enum).toEqual([...sentimentOutcomeSchema.options])
      const response = await mcp.callTool({ name: 'canonry_sentiment_evidence', arguments: { project: 'demo', queryClass: 'branded', scope: 'property', scopeKey: 'property-a', outcome: [...outcome] } })
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
      expect(response.structuredContent).toEqual(page)
    } finally {
      await mcp.close()
      await server.close()
    }

    // Client, CLI and MCP each sent one identical read.
    expect(requests).toHaveLength(3)
    for (const request of requests) {
      const url = new URL(request.url)
      expect(url.pathname).toBe('/prefix/api/v1/projects/demo/sentiment/evidence')
      expect(url.searchParams.getAll('outcome')).toEqual([...outcome])
      expect(url.searchParams.get('scope')).toBe('property')
      expect(url.searchParams.get('scopeKey')).toBe('property-a')
      expect(url.searchParams.get('queryClass')).toBe('branded')
    }
  })
  it('sends no outcome parameter when the evidence read has no filter', async () => {
    let received: Request | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      received = input instanceof Request ? input : new Request(input, init)
      return Response.json(evidencePage)
    }))
    vi.spyOn(clientModule, 'createApiClient').mockReturnValue(new ApiClient('https://canonry.test/prefix', 'cnry_test', { skipProbe: true }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await dispatchRegisteredCommand(['sentiment', 'evidence', 'demo', '--query-class', 'non-brand'], 'json', SENTIMENT_CLI_COMMANDS)
    expect(new URL(received!.url).searchParams.has('outcome')).toBe(false)
  })
  it('preserves frozen backfill token/key bytes across retries', async () => {
    const requests: Request[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init))
      return new Response(JSON.stringify(receipt), { headers: { 'content-type': 'application/json' } })
    }))
    const client = new ApiClient('https://canonry.test/prefix', 'cnry_test', { skipProbe: true })
    const request = { previewToken: 'frozen+/=token', idempotencyKey: 'retry-key' }
    expect(await client.submitSentimentBackfill('demo', request)).toEqual(receipt)
    expect(await client.submitSentimentBackfill('demo', request)).toEqual(receipt)
    for (const received of requests) {
      expect(received.method).toBe('POST')
      expect(new URL(received.url).pathname).toBe('/prefix/api/v1/projects/demo/sentiment/backfills')
      expect(await received.json()).toEqual(request)
    }
  })
  it.each([403, 500])('retains HTTP %s error status and CLI exit classification', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: status === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR', message: 'Safe failure' } }), { status, headers: { 'content-type': 'application/json' } })))
    const client = new ApiClient('https://canonry.test/prefix', 'cnry_test', { skipProbe: true })
    try { await client.getSentiment('demo'); throw new Error('Expected failure') } catch (error) {
      expect(error).toBeInstanceOf(CliError)
      expect(error).toMatchObject({ code: status === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR', exitCode: status === 403 ? 1 : 2 })
    }
  })
})
