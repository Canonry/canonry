import { afterEach, describe, expect, it, vi } from 'vitest'
import { sentimentFixtureSummary } from '../../contracts/test/fixtures/sentiment.js'
import { ApiClient } from '../src/client.js'
import { CliError } from '../src/cli-error.js'

afterEach(() => vi.unstubAllGlobals())

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
      return Response.json(sentimentFixtureSummary)
    }))
    const client = new ApiClient('https://canonry.test/prefix', 'cnry_test', { skipProbe: true })
    const runIds = ['run-bayside', 'run-harbor']
    const selection = { runIds, queryClass: 'non-brand' as const, queryId: 'frozen-query', evaluationDefinitionId: 'frozen-definition' }
    if (operation === 'summary') await client.getSentiment('demo', selection)
    else if (operation === 'evidence') await client.getSentimentEvidence('demo', { ...selection, cursor: 'cursor', limit: 7 })
    else await client.previewSentimentBackfill('demo', { mode: 'auto', scope: 'project', ...selection })
    const url = new URL(received!.url)
    expect(url.searchParams.getAll('runIds')).toEqual(runIds)
    expect(url.searchParams.has('runId')).toBe(false)
    expect(url.searchParams.get('queryClass')).toBe('non-brand')
    expect(url.searchParams.get('queryId')).toBe('frozen-query')
    expect(url.searchParams.get('evaluationDefinitionId')).toBe('frozen-definition')
    if (operation === 'evidence') expect(url.searchParams.get('cursor')).toBe('cursor')
  })
  it('preserves frozen backfill token/key bytes across retries', async () => {
    const requests: Request[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init))
      return new Response(JSON.stringify({ id: 'same-job', state: 'pending' }), { headers: { 'content-type': 'application/json' } })
    }))
    const client = new ApiClient('https://canonry.test/prefix', 'cnry_test', { skipProbe: true })
    const request = { previewToken: 'frozen+/=token', idempotencyKey: 'retry-key' }
    expect(await client.submitSentimentBackfill('demo', request)).toEqual(await client.submitSentimentBackfill('demo', request))
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
