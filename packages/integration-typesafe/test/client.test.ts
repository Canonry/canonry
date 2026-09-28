import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { requestJev, TYPESAFE_URL } from '../src/client.js'

const input = { model: 'jev-1.13.0', state: 'Synthetic answer.', questions: { identity: { type: 'choice' as const, instructions: 'Subject?', criteria: { correct: 'The subject', wrong: 'Another subject' } } } }
const complete = { model: input.model, answers: { identity: { type: 'choice', choice: 'correct', probabilities: { correct: 1, wrong: 0 }, confidence: 1 } }, usage: { input_tokens: 70, output_tokens: 5 } }
const closers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())) })

async function stub(replies: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const requests: Array<{ method: string | undefined; authorization: string | undefined; body: unknown }> = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, authorization: req.headers.authorization, body: JSON.parse(body) })
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)]
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers })
    res.end(JSON.stringify(reply.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const transport: typeof fetch = (target, init) => { expect(target).toBe(TYPESAFE_URL); return fetch(url, init) }
  return { requests, transport }
}

describe('Jev real HTTP boundary', () => {
  it('serializes the official request and returns reported usage', async () => {
    const server = await stub([{ status: 200, body: complete }])
    const result = await requestJev(input, { apiKey: 'synthetic-secret', fetch: server.transport })
    expect(result.ok).toBe(true)
    expect(result.usage).toEqual({ kind: 'reported', inputTokens: 70, outputTokens: 5 })
    expect(server.requests).toEqual([{ method: 'POST', authorization: 'Bearer synthetic-secret', body: input }])
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })
  it('makes one attempt and returns Retry-After for the durable scheduler', async () => {
    const server = await stub([{ status: 429, body: { error: 'synthetic-secret' }, headers: { 'retry-after': '2' } }])
    const result = await requestJev(input, { apiKey: 'synthetic-secret', fetch: server.transport })
    expect(result).toMatchObject({ ok: false, error: { retryable: true, retryAfterMs: 2000 }, usage: { kind: 'unknown' } })
    expect(server.requests).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })
  it.each([401, 403, 422])('never retries permanent HTTP %s rejection', async (status) => {
    const server = await stub([{ status, body: { secret: 'synthetic-secret' } }])
    const result = await requestJev(input, { apiKey: 'synthetic-secret', fetch: server.transport })
    expect(result).toMatchObject({ ok: false, error: { retryable: false } })
    expect(server.requests).toHaveLength(1)
  })
  it('returns transient overload and malformed successes as distinct failures', async () => {
    const server = await stub([{ status: 529, body: {} }, { status: 200, body: { usage: complete.usage } }])
    expect(await requestJev(input, { apiKey: 'x', fetch: server.transport })).toMatchObject({ ok: false, error: { code: 'provider-unavailable', retryable: true } })
    expect(await requestJev(input, { apiKey: 'x', fetch: server.transport })).toMatchObject({ ok: false, error: { code: 'response-contract', retryable: false }, usage: { kind: 'reported', inputTokens: 70 } })
  })
  it('refuses a changed model and preserves reported usage', async () => {
    const server = await stub([{ status: 200, body: { ...complete, model: 'jev-2.0.0' } }])
    expect(await requestJev(input, { apiKey: 'x', fetch: server.transport })).toMatchObject({ ok: false, returnedModel: 'jev-2.0.0', error: { code: 'model-mismatch', retryable: false }, usage: { kind: 'reported' } })
  })
  it('does not dispatch when already canceled', async () => {
    const controller = new AbortController(); controller.abort()
    let calls = 0
    const result = await requestJev(input, { apiKey: 'x', signal: controller.signal, fetch: async () => { calls++; throw new Error('must not dispatch') } })
    expect(calls).toBe(0)
    expect(result).toMatchObject({ ok: false, error: { code: 'canceled', retryable: false } })
  })
  it('cancels a request on timeout without leaking transport details', async () => {
    const transport: typeof fetch = async (_target, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('synthetic-secret')), { once: true })
    })
    const result = await requestJev(input, { apiKey: 'synthetic-secret', fetch: transport, timeoutMs: 5 })
    expect(result).toMatchObject({ ok: false, error: { code: 'provider-timeout', retryable: true }, usage: { kind: 'unknown' } })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })
})

describe('durable retry coordination', () => {
  it('preserves separate unknown and reported usage across a deferred retry', async () => {
    const server = await stub([{ status: 429, body: {}, headers: { 'retry-after': '0' } }, { status: 200, body: complete }])
    const first = await requestJev(input, { apiKey: 'x', fetch: server.transport })
    expect(first).toMatchObject({ ok: false, error: { retryable: true, retryAfterMs: 0 }, usage: { kind: 'unknown' } })
    expect(server.requests).toHaveLength(1)
    const retried = await requestJev(input, { apiKey: 'x', fetch: server.transport })
    expect(retried).toMatchObject({ ok: true, usage: { kind: 'reported', inputTokens: 70 } })
    expect(server.requests).toHaveLength(2)
  })
  it('does not dispatch a deferred retry once disabled through cancellation', async () => {
    const server = await stub([{ status: 429, body: {}, headers: { 'retry-after': '60' } }])
    await requestJev(input, { apiKey: 'x', fetch: server.transport })
    const controller = new AbortController(); controller.abort()
    expect(await requestJev(input, { apiKey: 'x', fetch: server.transport, signal: controller.signal })).toMatchObject({ ok: false, error: { code: 'canceled' } })
    expect(server.requests).toHaveLength(1)
  })
})
