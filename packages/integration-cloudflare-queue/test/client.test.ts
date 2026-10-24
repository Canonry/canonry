import { describe, expect, it, vi } from 'vitest'
import {
  ackCloudflareQueueMessages,
  getCloudflareQueueRetentionSeconds,
  pullCloudflareQueueMessages,
} from '../src/index.js'

const client = {
  accountId: 'account-1',
  queueId: 'queue-1',
  apiToken: 'queue-secret-token',
  apiBaseUrl: 'https://queue.example.test/client/v4',
}

function pullResponse(messages: unknown[] = [], backlog = 0): Response {
  return new Response(JSON.stringify({
    success: true,
    errors: [],
    result: { message_backlog_count: backlog, messages },
  }), { headers: { 'content-type': 'application/json' } })
}

function ackResponse(ackCount: number, retryCount: number, warnings: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({
    success: true,
    errors: [],
    result: { ackCount, retryCount, warnings },
  }), { headers: { 'content-type': 'application/json' } })
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'message-1',
    timestamp_ms: 1_700_000_000_000,
    attempts: 2,
    lease_id: 'lease-1',
    metadata: { 'CF-Content-Type': 'json', 'CF-sourceMessageSource': 'worker' },
    body: Buffer.from(JSON.stringify({ hello: 'queue' })).toString('base64'),
    ...overrides,
  }
}

describe('pullCloudflareQueueMessages', () => {
  it('pulls the documented endpoint and preserves queue lease metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse([message()], 9))

    const result = await pullCloudflareQueueMessages({ ...client, fetchImpl }, {
      batchSize: 50,
      visibilityTimeoutMs: 6_000,
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://queue.example.test/client/v4/accounts/account-1/queues/queue-1/messages/pull',
    )
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer queue-secret-token',
        'Content-Type': 'application/json',
      },
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      batch_size: 50,
      visibility_timeout_ms: 6_000,
    })
    expect(result).toEqual({
      messageBacklogCount: 9,
      skippedUnleasedMessageCount: 0,
      messages: [{
        id: 'message-1',
        timestampMs: 1_700_000_000_000,
        attempts: 2,
        leaseId: 'lease-1',
        metadata: { 'CF-Content-Type': 'json', 'CF-sourceMessageSource': 'worker' },
        contentType: 'json',
        body: { hello: 'queue' },
      }],
    })
  })

  it('decodes base64 json and bytes, and preserves text as plain UTF-8', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse([
      message(),
      message({ id: 'bytes', lease_id: 'lease-bytes', metadata: { 'CF-Content-Type': 'bytes' }, body: 'AAEC' }),
      message({ id: 'text', lease_id: 'lease-text', metadata: { 'CF-Content-Type': 'text' }, body: '{"plain":true}' }),
      message({ id: 'plain-text', lease_id: 'lease-plain-text', metadata: { 'CF-Content-Type': 'text' }, body: 'not JSON' }),
    ]))

    const result = await pullCloudflareQueueMessages({ ...client, fetchImpl })

    expect(result.messages[1]).toMatchObject({ id: 'bytes', contentType: 'bytes', body: new Uint8Array([0, 1, 2]) })
    expect(result.messages[2]).toMatchObject({ id: 'text', contentType: 'text', body: '{"plain":true}' })
    expect(result.messages[3]).toMatchObject({ id: 'plain-text', contentType: 'text', body: 'not JSON' })
  })

  it('accepts direct JSON text returned by the Cloudflare pull API', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse([
      message({
        id: 'direct-json',
        lease_id: 'lease-direct-json',
        body: JSON.stringify({ direct: true }),
      }),
    ]))

    const result = await pullCloudflareQueueMessages({ ...client, fetchImpl })

    expect(result.messages[0]).toMatchObject({
      id: 'direct-json',
      leaseId: 'lease-direct-json',
      contentType: 'json',
      body: { direct: true },
    })
  })

  it('defaults a missing content type to JSON, as Cloudflare documents', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse([
      message({ metadata: {} }),
    ]))

    const result = await pullCloudflareQueueMessages({ ...client, fetchImpl })

    expect(result.messages[0]).toMatchObject({ contentType: 'json', body: { hello: 'queue' } })
  })

  it.each([
    ['v8', message({ metadata: { 'CF-Content-Type': 'v8' } }), 'unsupported-content-type'],
    ['unknown content type', message({ metadata: { 'CF-Content-Type': 'yaml' } }), 'unsupported-content-type'],
    ['bad base64', message({ body: 'not base64!' }), 'malformed-body'],
    ['malformed direct json', message({ body: '{"secret":"raw-body-must-not-escape"' }), 'malformed-body'],
    ['malformed base64 json', message({
      body: Buffer.from('{"secret":"raw-body-must-not-escape"').toString('base64'),
    }), 'malformed-body'],
    ['invalid UTF-8 base64 json', message({ body: Buffer.from([0xff]).toString('base64') }), 'malformed-body'],
  ])('returns %s as safe poison while preserving its lease', async (_label, invalid, reason) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse([invalid]))

    const result = await pullCloudflareQueueMessages({ ...client, fetchImpl })

    expect(result.messages[0]).toEqual(expect.objectContaining({
      id: 'message-1',
      leaseId: 'lease-1',
      contentType: 'poison',
      reason,
    }))
    expect(result.messages[0]).not.toHaveProperty('body')
    expect(JSON.stringify(result.messages[0])).not.toContain('raw-body-must-not-escape')
  })

  it.each([
    ['non-object', 'raw-body-must-not-escape'],
    ['missing lease', message({ lease_id: undefined, body: 'raw-body-must-not-escape' })],
    ['empty lease', message({ lease_id: '', body: 'raw-body-must-not-escape' })],
    ['whitespace lease', message({ lease_id: '   ', body: 'raw-body-must-not-escape' })],
    ['non-string lease', message({ lease_id: 123, body: 'raw-body-must-not-escape' })],
  ])('skips a %s entry and continues decoding valid siblings', async (_label, invalid) => {
    const valid = message({ id: 'valid', lease_id: 'lease-valid' })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse([invalid, valid]))

    const result = await pullCloudflareQueueMessages({ ...client, fetchImpl })

    expect(result.skippedUnleasedMessageCount).toBe(1)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({ id: 'valid', leaseId: 'lease-valid' })
    expect(result.messages.length + result.skippedUnleasedMessageCount).toBe(2)
    expect(JSON.stringify(result)).not.toContain('raw-body-must-not-escape')
  })

  it.each([
    ['missing id', { id: undefined }],
    ['invalid timestamp', { timestamp_ms: 'not-a-number' }],
    ['invalid attempts', { attempts: -1 }],
    ['invalid metadata', { metadata: { nested: { value: true } } }],
    ['invalid body', { body: { secret: 'raw-body-must-not-escape' } }],
  ])('returns a malformed %s as safe poison when its lease can be acknowledged', async (_label, overrides) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse([message(overrides)]))

    const result = await pullCloudflareQueueMessages({ ...client, fetchImpl })

    expect(result.messages[0]).toEqual(expect.objectContaining({
      leaseId: 'lease-1',
      contentType: 'poison',
      reason: 'malformed-envelope',
    }))
    expect(result.messages[0]).not.toHaveProperty('body')
    expect(JSON.stringify(result.messages[0])).not.toContain('raw-body-must-not-escape')
  })

  it('rejects malformed non-success envelopes deterministically', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success: false, result: null })))

    await expect(pullCloudflareQueueMessages({ ...client, fetchImpl })).rejects.toMatchObject({
      name: 'CloudflareQueueApiError',
      status: 502,
    })
  })

  it('rejects a raw response above the documented 100-message maximum before skipping unleased entries', async () => {
    const messages = Array.from({ length: 101 }, () => null)
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse(messages, 1))

    await expect(pullCloudflareQueueMessages({ ...client, fetchImpl })).rejects.toMatchObject({
      name: 'CloudflareQueueApiError',
      status: 502,
    })
  })

  it('retries 429 using Retry-After without leaking response text', async () => {
    const sleep = vi.fn(async () => {})
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('token=queue-secret-token', {
        status: 429,
        headers: { 'retry-after': '3' },
      }))
      .mockResolvedValueOnce(pullResponse())

    await pullCloudflareQueueMessages({ ...client, fetchImpl, sleep })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(3_000)
  })

  it('caps an excessive Retry-After so bounded retries cannot outlive a source lease', async () => {
    const sleep = vi.fn(async () => {})
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', {
        status: 429,
        headers: { 'retry-after': '3600' },
      }))
      .mockResolvedValueOnce(pullResponse())

    await pullCloudflareQueueMessages({ ...client, fetchImpl, sleep })

    expect(sleep).toHaveBeenCalledWith(30_000)
  })

  it('retries 5xx responses with the bounded exponential delay', async () => {
    const sleep = vi.fn(async () => {})
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('upstream detail', { status: 503 }))
      .mockResolvedValueOnce(pullResponse())

    await pullCloudflareQueueMessages({ ...client, fetchImpl, sleep, retryBaseDelayMs: 7 })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(7)
  })

  it('caps an oversized configured exponential backoff', async () => {
    const sleep = vi.fn(async () => {})
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(pullResponse())

    await pullCloudflareQueueMessages({ ...client, fetchImpl, sleep, retryBaseDelayMs: 60_000 })

    expect(sleep).toHaveBeenCalledWith(30_000)
  })

  it('does not retry permanent 4xx responses and reports no upstream body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('queue-secret-token', { status: 403 }))

    const error = await pullCloudflareQueueMessages({ ...client, fetchImpl }).catch((err: unknown) => err)

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(error).toMatchObject({ status: 403 })
    expect((error as Error).message).not.toContain('queue-secret-token')
  })

  it('passes a timeout signal to injected fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse())

    await pullCloudflareQueueMessages({ ...client, fetchImpl, timeoutMs: 123 })

    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('rejects a visibility timeout beyond Cloudflare\'s documented 12-hour maximum', async () => {
    const fetchImpl = vi.fn<typeof fetch>()

    await expect(pullCloudflareQueueMessages({ ...client, fetchImpl }, {
      visibilityTimeoutMs: 43_200_001,
    })).rejects.toMatchObject({ status: 400 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not retry an aborted request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('aborted', 'AbortError'))

    await expect(pullCloudflareQueueMessages({ ...client, fetchImpl })).rejects.toMatchObject({ status: 408 })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('reports a timeout while reading the body as a timeout, without retrying it as bad JSON', async () => {
    const response = new Response('{}', { headers: { 'content-type': 'application/json' } })
    Object.defineProperty(response, 'json', { value: async () => { throw new DOMException('The operation was aborted.', 'AbortError') } })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
    const sleep = vi.fn(async () => {})
    await expect(pullCloudflareQueueMessages({ ...client, fetchImpl, sleep })).rejects.toMatchObject({
      status: 408, message: 'Cloudflare Queue request timed out or was aborted',
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('redacts non-abort transport errors before they leave the client', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      new Error('Authorization: Bearer queue-secret-token; upstream body'),
    )

    const error = await pullCloudflareQueueMessages({
      ...client,
      fetchImpl,
      maxRetries: 0,
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ name: 'CloudflareQueueApiError', status: 503 })
    expect((error as Error).message).toBe('Cloudflare Queue request failed')
    expect((error as Error).message).not.toContain('queue-secret-token')
  })
})

describe('ackCloudflareQueueMessages', () => {
  it('groups acknowledgements and retries with delay_seconds', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ackResponse(2, 1))

    const result = await ackCloudflareQueueMessages({ ...client, fetchImpl }, {
      acks: ['lease-1', 'lease-2'],
      retries: [{ leaseId: 'lease-3', delaySeconds: 600 }],
    })

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://queue.example.test/client/v4/accounts/account-1/queues/queue-1/messages/ack',
    )
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      acks: [{ lease_id: 'lease-1' }, { lease_id: 'lease-2' }],
      retries: [{ lease_id: 'lease-3', delay_seconds: 600 }],
    })
    expect(result).toEqual({
      acknowledgedLeaseIds: ['lease-1', 'lease-2'],
      retriedLeaseIds: [{ leaseId: 'lease-3', delaySeconds: 600 }],
      warningCount: 0,
    })
  })

  it.each([
    ['result', { success: true }],
    ['counts', { success: true, result: {} }],
    ['acknowledgement count', { success: true, result: { retryCount: 1 } }],
    ['retry count', { success: true, result: { ackCount: 1 } }],
  ])('accepts an ACK response that omits optional %s', async (_label, responseBody) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(responseBody)))

    await expect(ackCloudflareQueueMessages({ ...client, fetchImpl }, {
      acks: ['lease-1'],
      retries: [{ leaseId: 'lease-2' }],
    })).resolves.toEqual({
      acknowledgedLeaseIds: ['lease-1'],
      retriedLeaseIds: [{ leaseId: 'lease-2' }],
      warningCount: 0,
    })
  })

  it.each([
    ['acknowledgements', 1, 1],
    ['retries', 2, 0],
  ])('rejects partial %s reported by Cloudflare', async (_label, ackCount, retryCount) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ackResponse(ackCount, retryCount, {
      'lease-secret': 'upstream warning with queue-secret-token',
    }))

    const error = await ackCloudflareQueueMessages({ ...client, fetchImpl }, {
      acks: ['lease-1', 'lease-2'],
      retries: [{ leaseId: 'lease-3' }],
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ name: 'CloudflareQueueApiError', status: 502 })
    expect((error as Error).message).toBe('Cloudflare Queue acknowledgement was incomplete')
    expect((error as Error).message).not.toContain('queue-secret-token')
    expect((error as Error).message).not.toContain('lease-secret')
  })

  it('returns only the warning count without failing or exposing warning details', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ackResponse(2, 1, {
      'lease-secret': 'upstream warning with queue-secret-token',
      'another-lease-secret': 'another upstream warning',
    }))

    const result = await ackCloudflareQueueMessages({ ...client, fetchImpl }, {
      acks: ['lease-1', 'lease-2'],
      retries: [{ leaseId: 'lease-3' }],
    })

    expect(result).toEqual({
      acknowledgedLeaseIds: ['lease-1', 'lease-2'],
      retriedLeaseIds: [{ leaseId: 'lease-3' }],
      warningCount: 2,
    })
    expect(JSON.stringify(result)).not.toContain('queue-secret-token')
    expect(JSON.stringify(result)).not.toContain('lease-secret')
  })

  it.each([
    ['array', ['raw-secret-warning']],
    ['non-string map value', { 'raw-secret-key': { nested: 'raw-secret-warning' } }],
  ])('rejects a malformed warning %s without exposing its content', async (_label, warnings) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      result: { ackCount: 1, retryCount: 0, warnings },
    })))

    const error = await ackCloudflareQueueMessages({ ...client, fetchImpl }, {
      acks: ['lease-1'],
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      name: 'CloudflareQueueApiError',
      status: 502,
      message: 'Cloudflare Queue acknowledgement warnings are malformed',
    })
    expect((error as Error).message).not.toContain('raw-secret')
  })

  it.each([
    ['malformed result', { success: true, result: 'not-an-object' }],
    ['fractional acknowledgement count', { success: true, result: { ackCount: 0.5, retryCount: 0 } }],
    ['negative retry count', { success: true, result: { ackCount: 1, retryCount: -1 } }],
  ])('rejects an ACK response with a %s', async (_label, responseBody) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(responseBody)))

    await expect(ackCloudflareQueueMessages({ ...client, fetchImpl }, {
      acks: ['lease-1'],
    })).rejects.toMatchObject({ name: 'CloudflareQueueApiError', status: 502 })
  })

  it('requires at least one acknowledgement or retry', async () => {
    const fetchImpl = vi.fn<typeof fetch>()

    await expect(ackCloudflareQueueMessages({ ...client, fetchImpl }, {})).rejects.toMatchObject({ status: 400 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// Shape of Cloudflare's documented Get Queue response
// (GET /accounts/{account_id}/queues/{queue_id}), unmodeled fields included.
function queueResponse(settings: Record<string, unknown> | undefined): Response {
  return new Response(JSON.stringify({
    errors: [],
    messages: [],
    success: true,
    result: {
      consumers: [],
      consumers_total_count: 0,
      created_on: '2026-08-16T18:00:00.000000Z',
      modified_on: '2026-08-16T18:00:00.000000Z',
      producers: [{ script: 'canonry-traffic-source', type: 'worker' }],
      producers_total_count: 1,
      queue_id: 'queue-1',
      queue_name: 'canonry-events',
      ...(settings ? { settings } : {}),
    },
  }), { headers: { 'content-type': 'application/json' } })
}

describe('getCloudflareQueueRetentionSeconds', () => {
  it('reads the live message retention from the documented Get Queue endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(queueResponse({ delivery_delay: 0, delivery_paused: false, message_retention_period: 345_600 }))
    await expect(getCloudflareQueueRetentionSeconds({ ...client, fetchImpl })).resolves.toBe(345_600)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://queue.example.test/client/v4/accounts/account-1/queues/queue-1')
    const init = fetchImpl.mock.calls[0]?.[1]
    expect(init).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer queue-secret-token' } })
    expect(init?.body).toBeUndefined()
  })

  it('uses a retention above today\'s 14-day maximum as reported', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(queueResponse({ message_retention_period: 1_209_601 }))
    await expect(getCloudflareQueueRetentionSeconds({ ...client, fetchImpl })).resolves.toBe(1_209_601)
  })

  it.each([
    ['missing settings', undefined],
    ['missing retention', { delivery_delay: 0 }],
    ['below the minimum', { message_retention_period: 30 }],
    ['beyond the sanity cap', { message_retention_period: 8_640_000_000_000 }],
    ['not a number', { message_retention_period: '345600' }],
    ['not an integer', { message_retention_period: 345_600.5 }],
  ])('returns null for %s', async (_label, settings) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(queueResponse(settings))
    await expect(getCloudflareQueueRetentionSeconds({ ...client, fetchImpl })).resolves.toBeNull()
  })

  it('returns null for a non-success envelope', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: false, errors: [{ code: 10000, message: 'Authentication error' }], messages: [], result: { settings: { message_retention_period: 345_600 } },
    }), { headers: { 'content-type': 'application/json' } }))
    await expect(getCloudflareQueueRetentionSeconds({ ...client, fetchImpl })).resolves.toBeNull()
  })

  it('makes exactly one attempt when retries are off', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('unavailable', { status: 503 }))
    const sleep = vi.fn(async () => {})
    await expect(getCloudflareQueueRetentionSeconds({ ...client, fetchImpl, maxRetries: 0, sleep })).rejects.toMatchObject({ status: 503 })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('throws a secret-free error on HTTP failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('denied for queue-secret-token', { status: 403 }))
    const error = await getCloudflareQueueRetentionSeconds({ ...client, fetchImpl, maxRetries: 0 }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ name: 'CloudflareQueueApiError', status: 403, message: 'Cloudflare Queue read failed with HTTP 403' })
    expect(String((error as Error).message)).not.toContain('queue-secret-token')
  })
})
