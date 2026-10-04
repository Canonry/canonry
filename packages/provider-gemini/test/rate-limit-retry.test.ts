import { describe, expect, it, vi } from 'vitest'
import {
  GEMINI_MAX_RATE_LIMIT_WAIT_MS,
  geminiRetryDelayMs,
  isGeminiDailyQuotaError,
  isGeminiRetryable,
  withRetry,
} from '../src/utils.js'

/** A 429 shaped like the Google Gen AI SDK's ApiError: the JSON body is the message. */
function rateLimited(quotaId: string, retryDelay?: string): Error & { status: number } {
  const details: unknown[] = [{
    '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
    violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId }],
  }]
  if (retryDelay) details.push({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay })
  const err = new Error(JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED', details } }))
  return Object.assign(err, { name: 'ApiError', status: 429 })
}

const PER_MINUTE = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier'
const PER_DAY = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'

describe('Gemini rate-limit parsing', () => {
  it('reads the RetryInfo delay, including fractional seconds', () => {
    expect(geminiRetryDelayMs(rateLimited(PER_MINUTE, '37s'))).toBe(37_000)
    expect(geminiRetryDelayMs(rateLimited(PER_MINUTE, '1.5s'))).toBe(1_500)
    expect(geminiRetryDelayMs(rateLimited(PER_MINUTE))).toBeNull()
    expect(geminiRetryDelayMs(new Error('fetch failed'))).toBeNull()
  })

  it('tells a daily quota from a per-minute limit', () => {
    expect(isGeminiDailyQuotaError(rateLimited(PER_DAY, '20s'))).toBe(true)
    expect(isGeminiDailyQuotaError(rateLimited(PER_MINUTE, '20s'))).toBe(false)
  })

  it('retries a per-minute limit, never a daily quota or a wait past the cap', () => {
    expect(isGeminiRetryable(rateLimited(PER_MINUTE, '37s'))).toBe(true)
    expect(isGeminiRetryable(rateLimited(PER_DAY, '20s'))).toBe(false)
    expect(isGeminiRetryable(rateLimited(PER_MINUTE, `${GEMINI_MAX_RATE_LIMIT_WAIT_MS / 1000 + 60}s`))).toBe(false)
    expect(isGeminiRetryable(Object.assign(new Error('bad request'), { status: 400 }))).toBe(false)
  })
})

describe('withRetry', () => {
  it('waits the delay Gemini asked for, then succeeds', async () => {
    const sleep = vi.fn(async () => {})
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimited(PER_MINUTE, '37s'))
      .mockResolvedValueOnce('ok')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(withRetry(fn, { sleep })).resolves.toBe('ok')
    expect(sleep).toHaveBeenCalledWith(37_500)
  })

  it('keeps the exponential backoff when no delay was given', async () => {
    const sleep = vi.fn(async () => {})
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimited(PER_MINUTE))
      .mockResolvedValueOnce('ok')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(withRetry(fn, { sleep })).resolves.toBe('ok')
    expect(sleep).toHaveBeenCalledWith(1000)
  })

  it('fails a daily quota at once', async () => {
    const sleep = vi.fn(async () => {})
    const fn = vi.fn().mockRejectedValue(rateLimited(PER_DAY, '20s'))
    await expect(withRetry(fn, { sleep })).rejects.toThrow('RESOURCE_EXHAUSTED')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})
