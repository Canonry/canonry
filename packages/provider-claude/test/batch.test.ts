import { test, expect, vi, beforeEach, afterEach, describe } from 'vitest'

import { ProviderBatchSubmitError } from '@ainyc/canonry-contracts'
import type { ProviderBatchRequestInput, ProviderBatchResultLine, ProviderConfig } from '@ainyc/canonry-contracts'

import { claudeAdapter } from '../src/adapter.js'
import { createClaudeBatchCapability, claudeBatch } from '../src/batch.js'

// The Message Batches half of the Claude adapter, driven through the real SDK
// against a stubbed transport, so the error classes, URLs, and JSONL decoding
// under test are the SDK's own. Retry backoff is set to 0ms.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }
const CONFIG: ProviderConfig = { provider: 'claude', apiKey: 'k', model: 'claude-sonnet-5', quotaPolicy }
const BATCH_ID = 'msgbatch_013Zva2CMHLNnXjNJJKqJ2EF'
const API = 'https://api.anthropic.com'

const batch = createClaudeBatchCapability({ retryBaseDelayMs: 0 })

interface Call {
  method: string
  url: string
  body: unknown
}

type Handler = (call: Call) => Response | Promise<Response>

/** Route every SDK request to `handler`, recording what was sent. */
function stubTransport(handler: Handler): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: unknown, init?: { method?: string; body?: string }) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: input instanceof Request ? input.url : String(input),
      body: init?.body ? JSON.parse(init.body) as unknown : undefined,
    }
    calls.push(call)
    return handler(call)
  })
  return calls
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function apiError(status: number, type: string, message: string): Response {
  return json({ type: 'error', error: { type, message }, request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy' }, status)
}

function messageBatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BATCH_ID,
    type: 'message_batch',
    processing_status: 'in_progress',
    request_counts: { processing: 3, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    ended_at: null,
    created_at: '2026-09-24T10:00:00.000000+00:00',
    expires_at: '2026-09-25T10:00:00.000000+00:00',
    archived_at: null,
    cancel_initiated_at: null,
    results_url: null,
    ...overrides,
  }
}

function tracked(customId: string, query: string, model = 'claude-sonnet-5'): ProviderBatchRequestInput {
  return {
    customId,
    request: claudeAdapter.buildTrackedQueryRequest!(
      { query, canonicalDomains: ['example.com'], competitorDomains: [] },
      { ...CONFIG, model },
    ),
  }
}

const REQUESTS = [tracked('a1', 'best crm'), tracked('b2', 'crm for agencies'), tracked('c3', 'crm pricing')]

/** A search-grounded answer as Claude returns it inside a batch result line. */
function answer(text: string, url: string): Record<string, unknown> {
  return {
    id: `msg_${text.length}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-20260801',
    content: [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: text } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url, title: 'Source' }] },
      { type: 'text', text, citations: [{ type: 'web_search_result_location', url, title: 'Source', cited_text: text }] },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1800,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 420,
      server_tool_use: { web_search_requests: 1 },
      service_tier: 'batch',
    },
  }
}

async function collect(lines: AsyncIterable<ProviderBatchResultLine>): Promise<ProviderBatchResultLine[]> {
  const out: ProviderBatchResultLine[] = []
  for await (const line of lines) out.push(line)
  return out
}

async function submitError(requests: readonly ProviderBatchRequestInput[], config = CONFIG): Promise<ProviderBatchSubmitError> {
  try {
    await batch.submit(requests, config)
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderBatchSubmitError)
    return err as ProviderBatchSubmitError
  }
  throw new Error('submit resolved; expected a ProviderBatchSubmitError')
}

beforeEach(() => {
  // withRetry logs each retry; keep the output quiet.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('declares the Message Batches hard limits and a 24h default deadline', () => {
  expect(claudeAdapter.batch).toBe(claudeBatch)
  expect(claudeBatch.maxRequestsPerBatch).toBe(100_000)
  expect(claudeBatch.maxBytesPerBatch).toBe(256 * 1024 * 1024)
  expect(claudeBatch.defaultDeadlineHours).toBe(24)
})

describe('submit', () => {
  test('sends each request as {custom_id, params} with the sync body unchanged', async () => {
    const calls = stubTransport(() => json(messageBatch()))
    const result = await batch.submit(REQUESTS, CONFIG)

    expect(result).toEqual({ providerBatchId: BATCH_ID, expiresAt: '2026-09-25T10:00:00.000000+00:00' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(`${API}/v1/messages/batches`)
    expect(calls[0]!.body).toEqual({
      requests: REQUESTS.map((r) => ({ custom_id: r.customId, params: r.request.body })),
    })
  })

  test.each([
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [413, 'request_too_large'],
    [422, 'invalid_request_error'],
  ])('a %i rejection is definite and never retried', async (status, type) => {
    const calls = stubTransport(() => apiError(status, type, 'rejected'))
    const err = await submitError(REQUESTS)
    expect(err.definite).toBe(true)
    expect(err.message).toMatch(/^\[provider-claude\] batch submit failed: /)
    expect(err.message).toContain('rejected')
    expect(calls).toHaveLength(1)
  })

  test.each([
    [500, 'api_error'],
    [529, 'overloaded_error'],
    [408, 'timeout_error'],
    [409, 'invalid_request_error'],
  ])('a %i is ambiguous and never retried: the batch may exist', async (status, type) => {
    const calls = stubTransport(() => apiError(status, type, 'maybe'))
    const err = await submitError(REQUESTS)
    expect(err.definite).toBe(false)
    expect(calls).toHaveLength(1)
  })

  test('a dropped connection after sending is ambiguous and never retried', async () => {
    const calls = stubTransport(() => {
      throw new TypeError('fetch failed')
    })
    const err = await submitError(REQUESTS)
    expect(err.definite).toBe(false)
    expect(calls).toHaveLength(1)
  })

  test('a timeout after sending is ambiguous and never retried', async () => {
    const calls = stubTransport(() => {
      throw new Error('Request timed out')
    })
    const err = await submitError(REQUESTS)
    expect(err.definite).toBe(false)
    expect(err.message).toMatch(/timed out/i)
    expect(calls).toHaveLength(1)
  })

  test('a rate limit is retried, since the provider rejected it before accepting anything', async () => {
    let attempt = 0
    const calls = stubTransport(() => (++attempt === 1 ? apiError(429, 'rate_limit_error', 'slow down') : json(messageBatch())))
    await expect(batch.submit(REQUESTS, CONFIG)).resolves.toEqual({
      providerBatchId: BATCH_ID,
      expiresAt: '2026-09-25T10:00:00.000000+00:00',
    })
    expect(calls).toHaveLength(2)
  })

  test('a rate limit that outlasts the retries is still a definite rejection', async () => {
    const calls = stubTransport(() => apiError(429, 'rate_limit_error', 'slow down'))
    const err = await submitError(REQUESTS)
    expect(err.definite).toBe(true)
    expect(calls).toHaveLength(4)
  })

  test('a rate limit followed by a dropped connection is ambiguous', async () => {
    let attempt = 0
    const calls = stubTransport(() => {
      if (++attempt === 1) return apiError(429, 'rate_limit_error', 'slow down')
      throw new TypeError('fetch failed')
    })
    const err = await submitError(REQUESTS)
    expect(err.definite).toBe(false)
    expect(calls).toHaveLength(2)
  })

  test('a failure before anything is sent is definite', async () => {
    const calls = stubTransport(() => json(messageBatch()))
    const unserializable = { customId: 'z9', request: { endpoint: '/v1/messages', body: { model: 'claude-sonnet-5', n: 1n } } }
    const err = await submitError([unserializable])
    expect(err.definite).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test('an empty batch is refused locally', async () => {
    const calls = stubTransport(() => json(messageBatch()))
    const err = await submitError([])
    expect(err.definite).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test('a request built for another endpoint is refused locally', async () => {
    const calls = stubTransport(() => json(messageBatch()))
    const foreign = { customId: 'x1', request: { endpoint: '/v1/responses', body: { model: 'gpt-5.4' } } }
    const err = await submitError([...REQUESTS, foreign])
    expect(err.definite).toBe(true)
    expect(err.message).toContain('x1')
    expect(calls).toHaveLength(0)
  })
})

describe('poll', () => {
  test('maps an in-progress batch without inventing end or expiry times', async () => {
    const calls = stubTransport(() => json(messageBatch()))
    await expect(batch.poll(BATCH_ID, CONFIG)).resolves.toEqual({
      status: 'in_progress',
      requestCounts: { processing: 3, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    })
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${API}/v1/messages/batches/${BATCH_ID}` })
  })

  test('maps an ended batch with its counts and end time', async () => {
    stubTransport(() => json(messageBatch({
      processing_status: 'ended',
      request_counts: { processing: 0, succeeded: 97, errored: 1, canceled: 0, expired: 2 },
      ended_at: '2026-09-24T11:12:13.000000+00:00',
      results_url: `${API}/v1/messages/batches/${BATCH_ID}/results`,
    })))
    await expect(batch.poll(BATCH_ID, CONFIG)).resolves.toEqual({
      status: 'ended',
      requestCounts: { processing: 0, succeeded: 97, errored: 1, canceled: 0, expired: 2 },
      endedAt: '2026-09-24T11:12:13.000000+00:00',
    })
  })

  test('maps a canceling batch', async () => {
    stubTransport(() => json(messageBatch({ processing_status: 'canceling', cancel_initiated_at: '2026-09-24T10:30:00Z' })))
    expect((await batch.poll(BATCH_ID, CONFIG)).status).toBe('canceling')
  })

  test('reports when an archived batch lost its results', async () => {
    stubTransport(() => json(messageBatch({
      processing_status: 'ended',
      request_counts: { processing: 0, succeeded: 3, errored: 0, canceled: 0, expired: 0 },
      ended_at: '2026-09-24T11:00:00Z',
      archived_at: '2026-10-23T10:00:00Z',
    })))
    expect((await batch.poll(BATCH_ID, CONFIG)).resultsExpireAt).toBe('2026-10-23T10:00:00Z')
  })

  test('retries a transient server error: polling is read-only', async () => {
    let attempt = 0
    const calls = stubTransport(() => (++attempt === 1 ? apiError(500, 'api_error', 'boom') : json(messageBatch())))
    expect((await batch.poll(BATCH_ID, CONFIG)).status).toBe('in_progress')
    expect(calls).toHaveLength(2)
  })

  test('does not retry a missing batch', async () => {
    const calls = stubTransport(() => apiError(404, 'not_found_error', 'no such batch'))
    await expect(batch.poll(BATCH_ID, CONFIG)).rejects.toThrow(/^\[provider-claude\] batch poll failed: .*no such batch/)
    expect(calls).toHaveLength(1)
  })
})

describe('results', () => {
  const RESULTS_URL = `${API}/v1/messages/batches/${BATCH_ID}/results`

  function stubResults(lines: unknown[]): Call[] {
    return stubTransport((call) => {
      if (call.url === RESULTS_URL) {
        return new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', {
          status: 200,
          headers: { 'content-type': 'application/binary' },
        })
      }
      return json(messageBatch({
        processing_status: 'ended',
        request_counts: { processing: 0, succeeded: 2, errored: 1, canceled: 1, expired: 1 },
        ended_at: '2026-09-24T11:00:00Z',
        results_url: RESULTS_URL,
      }))
    })
  }

  test('yields every line by custom_id, in the order the provider returns them', async () => {
    const answerB = answer('Agency CRMs compared.', 'https://crm.example/agency')
    const answerA = answer('The best CRM is Example.', 'https://example.com/crm')
    const calls = stubResults([
      { custom_id: 'b2', result: { type: 'succeeded', message: answerB } },
      { custom_id: 'e5', result: { type: 'expired' } },
      { custom_id: 'c3', result: { type: 'errored', error: { type: 'error', error: { type: 'invalid_request_error', message: 'tool_choice is not supported' }, request_id: null } } },
      { custom_id: 'd4', result: { type: 'canceled' } },
      { custom_id: 'a1', result: { type: 'succeeded', message: answerA } },
    ])

    const lines = await collect(batch.results(BATCH_ID, CONFIG))

    expect(lines).toEqual([
      { customId: 'b2', type: 'succeeded', body: answerB },
      { customId: 'e5', type: 'expired', error: '[provider-claude] the batch expired before this request was processed' },
      { customId: 'c3', type: 'errored', error: '[provider-claude] invalid_request_error: tool_choice is not supported' },
      { customId: 'd4', type: 'canceled', error: '[provider-claude] the batch was canceled before this request was processed' },
      { customId: 'a1', type: 'succeeded', body: answerA },
    ])
    expect(calls.map((c) => c.url)).toEqual([`${API}/v1/messages/batches/${BATCH_ID}`, RESULTS_URL])
  })

  test('a succeeded body parses exactly as the same answer on the sync path', async () => {
    const message = answer('The best CRM is Example.', 'https://example.com/crm')
    stubResults([{ custom_id: 'a1', result: { type: 'succeeded', message } }])
    const [line] = await collect(batch.results(BATCH_ID, CONFIG))
    if (line?.type !== 'succeeded') throw new Error('expected a succeeded line')
    const viaBatch = claudeAdapter.parseTrackedQueryResponse!(line.body, 'claude-sonnet-5')

    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', async () => json(message))
    const viaSync = await claudeAdapter.executeTrackedQuery(
      { query: 'best crm', canonicalDomains: ['example.com'], competitorDomains: [] },
      CONFIG,
    )

    expect(viaBatch).toEqual(viaSync)
    expect(viaBatch.usage).toEqual({ inputTokens: 1800, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 420, searchCount: 1 })
    expect(viaBatch.stopReason).toBe('end_turn')
  })

  test('a succeeded line whose web search errored fails parse exactly like the sync path', async () => {
    const failed = {
      ...answer('partial', 'https://example.com'),
      content: [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' } },
        { type: 'text', text: 'partial' },
      ],
    }
    stubResults([{ custom_id: 'a1', result: { type: 'succeeded', message: failed } }])
    const [line] = await collect(batch.results(BATCH_ID, CONFIG))
    if (line?.type !== 'succeeded') throw new Error('expected a succeeded line')

    const expected = '[provider-claude] web_search tool error: too_many_requests'
    expect(() => claudeAdapter.parseTrackedQueryResponse!(line.body, 'claude-sonnet-5')).toThrow(expected)

    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', async () => json(failed))
    await expect(claudeAdapter.executeTrackedQuery(
      { query: 'best crm', canonicalDomains: ['example.com'], competitorDomains: [] },
      CONFIG,
    )).rejects.toThrow(expected)
  })

  test('a batch that has not ended has no results to read', async () => {
    stubTransport(() => json(messageBatch()))
    await expect(collect(batch.results(BATCH_ID, CONFIG))).rejects.toThrow(/^\[provider-claude\] batch results failed: /)
  })
})

describe('cancel', () => {
  test('cancels an in-progress batch', async () => {
    const calls = stubTransport(() => json(messageBatch({ processing_status: 'canceling', cancel_initiated_at: '2026-09-24T10:30:00Z' })))
    await expect(batch.cancel(BATCH_ID, CONFIG)).resolves.toBeUndefined()
    expect(calls).toEqual([{ method: 'POST', url: `${API}/v1/messages/batches/${BATCH_ID}/cancel`, body: undefined }])
  })

  test.each(['ended', 'canceling'])('is idempotent: a batch already %s is not an error', async (status) => {
    const calls = stubTransport((call) =>
      call.url.endsWith('/cancel')
        ? apiError(400, 'invalid_request_error', `Batch ${BATCH_ID} cannot be canceled`)
        : json(messageBatch({ processing_status: status, ended_at: status === 'ended' ? '2026-09-24T11:00:00Z' : null })),
    )
    await expect(batch.cancel(BATCH_ID, CONFIG)).resolves.toBeUndefined()
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET'])
  })

  test('a refused cancel of a batch still in progress is an error', async () => {
    stubTransport((call) =>
      call.url.endsWith('/cancel') ? apiError(403, 'permission_error', 'not allowed') : json(messageBatch()),
    )
    await expect(batch.cancel(BATCH_ID, CONFIG)).rejects.toThrow(/^\[provider-claude\] batch cancel failed: .*not allowed/)
  })

  test('the original error surfaces when the batch cannot be read back either', async () => {
    stubTransport((call) =>
      call.url.endsWith('/cancel')
        ? apiError(400, 'invalid_request_error', 'cannot cancel')
        : apiError(404, 'not_found_error', 'no such batch'),
    )
    await expect(batch.cancel(BATCH_ID, CONFIG)).rejects.toThrow(/cannot cancel/)
  })
})
