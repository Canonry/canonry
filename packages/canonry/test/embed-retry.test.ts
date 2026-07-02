import { describe, expect, it } from 'vitest'
import { embedWithRetry, EMBED_ATTEMPT_TIMEOUT_MS, EMBED_RETRY_MAX_RETRIES } from '../src/discovery-run.js'

const VECTORS: number[][] = [[0.1, 0.2], [0.3, 0.4]]

function httpError(status: number, message = `http ${status}`): Error {
  return Object.assign(new Error(message), { status })
}

/** Instant sleep so retry tests don't wait out real backoff delays. */
const noSleep = async () => {}

describe('embedWithRetry', () => {
  it('exports sane policy constants', () => {
    expect(EMBED_RETRY_MAX_RETRIES).toBe(3)
    expect(EMBED_ATTEMPT_TIMEOUT_MS).toBe(60_000)
  })

  it('returns the embeddings on first success without retrying', async () => {
    let calls = 0
    const result = await embedWithRetry(async () => { calls++; return VECTORS }, { sleep: noSleep })
    expect(result).toEqual(VECTORS)
    expect(calls).toBe(1)
  })

  it('retries a transient 5xx and succeeds', async () => {
    let calls = 0
    const retries: number[] = []
    const result = await embedWithRetry(
      async () => {
        calls++
        if (calls === 1) throw httpError(503)
        return VECTORS
      },
      { sleep: noSleep, onRetry: ({ attempt }) => retries.push(attempt) },
    )
    expect(result).toEqual(VECTORS)
    expect(calls).toBe(2)
    expect(retries).toEqual([0])
  })

  it('retries a 429 rate limit and a network-shaped error', async () => {
    let calls = 0
    const result = await embedWithRetry(
      async () => {
        calls++
        if (calls === 1) throw httpError(429)
        if (calls === 2) throw new Error('fetch failed')
        return VECTORS
      },
      { sleep: noSleep, onRetry: () => {} },
    )
    expect(result).toEqual(VECTORS)
    expect(calls).toBe(3)
  })

  it('does NOT retry a permanent 4xx — the session must still fail fast', async () => {
    let calls = 0
    await expect(embedWithRetry(
      async () => { calls++; throw httpError(400, 'invalid api key') },
      { sleep: noSleep, onRetry: () => {} },
    )).rejects.toThrow('invalid api key')
    expect(calls).toBe(1)
  })

  it('gives up after maxRetries and rethrows the last transient error', async () => {
    let calls = 0
    await expect(embedWithRetry(
      async () => { calls++; throw httpError(503, 'still down') },
      { maxRetries: 2, sleep: noSleep, onRetry: () => {} },
    )).rejects.toThrow('still down')
    expect(calls).toBe(3) // initial attempt + 2 retries
  })

  it('bounds each attempt with a wall-clock timeout and retries the timed-out attempt', async () => {
    let calls = 0
    const result = await embedWithRetry(
      async () => {
        calls++
        if (calls === 1) return new Promise<number[][]>(() => {}) // hangs forever
        return VECTORS
      },
      { attemptTimeoutMs: 20, sleep: noSleep, onRetry: () => {} },
    )
    expect(result).toEqual(VECTORS)
    expect(calls).toBe(2)
  })

  it('a permanently hanging call eventually fails the session with a timeout error', async () => {
    await expect(embedWithRetry(
      () => new Promise<number[][]>(() => {}),
      { attemptTimeoutMs: 10, maxRetries: 1, sleep: noSleep, onRetry: () => {} },
    )).rejects.toThrow(/timed out after 10ms/)
  })
})
