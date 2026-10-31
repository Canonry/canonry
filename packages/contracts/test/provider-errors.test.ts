import { describe, expect, it } from 'vitest'
import {
  classifyProviderErrorMessage,
  classifyProviderErrorMessages,
  extractProviderHttpStatus,
  mostActionableProviderErrorCode,
} from '../src/provider-errors.js'

describe('extractProviderHttpStatus', () => {
  it('reads the status the OpenAI and Anthropic SDKs lead their message with', () => {
    expect(extractProviderHttpStatus('[provider-openai] 429 Rate limit reached for gpt-5')).toBe(429)
    expect(extractProviderHttpStatus('[provider-claude] 529 {"type":"error"}')).toBe(529)
  })

  it('reads a status embedded in a JSON body or a status phrase', () => {
    expect(extractProviderHttpStatus('[provider-gemini] {"error":{"code":503,"message":"UNAVAILABLE"}}')).toBe(503)
    expect(extractProviderHttpStatus('[provider-gemini] got status: 500 Internal Server Error')).toBe(500)
    expect(extractProviderHttpStatus('request failed with HTTP 404')).toBe(404)
  })

  it('does not guess when no status is present', () => {
    expect(extractProviderHttpStatus('[provider-local] fetch failed')).toBeUndefined()
    expect(extractProviderHttpStatus('query 2048 tokens over limit')).toBeUndefined()
  })
})

describe('classifyProviderErrorMessage', () => {
  it('buckets a provider-side outage as PROVIDER_UNAVAILABLE, not UNKNOWN', () => {
    expect(classifyProviderErrorMessage('[provider-claude] 529 {"error":{"type":"overloaded_error"}}')).toBe('PROVIDER_UNAVAILABLE')
    expect(classifyProviderErrorMessage('[provider-gemini] {"error":{"code":503}}')).toBe('PROVIDER_UNAVAILABLE')
    expect(classifyProviderErrorMessage('[provider-openai] 502 Bad Gateway')).toBe('PROVIDER_UNAVAILABLE')
  })

  it('does not count a 503 as a local network failure', () => {
    expect(classifyProviderErrorMessage('503 Service Unavailable: network upstream')).toBe('PROVIDER_UNAVAILABLE')
  })

  it('buckets an account out of credit as PROVIDER_BILLING, not a rate limit or UNKNOWN', () => {
    expect(classifyProviderErrorMessage(
      '[provider-claude] 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
    )).toBe('PROVIDER_BILLING')
    expect(classifyProviderErrorMessage(
      '[provider-openai] 429 You exceeded your current quota, please check your plan and billing details.',
    )).toBe('PROVIDER_BILLING')
    expect(classifyProviderErrorMessage('[provider-gemini] got status: 402 Payment Required')).toBe('PROVIDER_BILLING')
    expect(classifyProviderErrorMessage('[provider-perplexity] {"error":{"type":"insufficient_quota"}}')).toBe('PROVIDER_BILLING')
  })

  it("reads Gemini's 400 for a bad or expired key as PROVIDER_AUTH", () => {
    const body = (message: string, reason: string) => `[provider-gemini] ${JSON.stringify({
      error: { code: 400, message, status: 'INVALID_ARGUMENT', details: [{ reason }] },
    })}`
    expect(classifyProviderErrorMessage(body('API key not valid. Please pass a valid API key.', 'API_KEY_INVALID'))).toBe('PROVIDER_AUTH')
    expect(classifyProviderErrorMessage(body('API key expired. Please renew the API key.', 'API_KEY_INVALID'))).toBe('PROVIDER_AUTH')
  })

  it('never reads a count in the text as an HTTP status', () => {
    // Canonry's own messages carry counts; only a written status is one.
    expect(classifyProviderErrorMessage('Daily quota exceeded for openai: 401 queries used today, limit is 500.')).toBe('RATE_LIMITED')
    expect(classifyProviderErrorMessage('No perplexity provider was available to this worker, so 403 expected measurement(s) did not run.')).toBe('UNKNOWN')
    expect(classifyProviderErrorMessage('Batch answers not recorded: 402 of 900. First: canceled')).toBe('UNKNOWN')
    expect(classifyProviderErrorMessage('Expected measurements not run yet: 503.')).toBe('UNKNOWN')
  })

  it("keeps Gemini's quota-worded rate limits as RATE_LIMITED", () => {
    const geminiRateLimit = JSON.stringify({
      error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' },
    })
    expect(classifyProviderErrorMessage(`[provider-gemini] ${geminiRateLimit}`)).toBe('RATE_LIMITED')
  })

  it("buckets the SDKs' bare connection failure as NETWORK, not UNKNOWN", () => {
    // OpenAI-compatible SDK (a `local` provider) pointed at a closed port: the
    // ECONNREFUSED is only on the error's cause, never in its message.
    expect(classifyProviderErrorMessage('[provider-local] Connection error.')).toBe('NETWORK')
    expect(classifyProviderErrorMessage('[provider-claude] APIConnectionError: Connection error.')).toBe('NETWORK')
    expect(classifyProviderErrorMessage('[provider-openai] connect EHOSTUNREACH 10.0.0.5:443')).toBe('NETWORK')
    // The SDKs' timeout subclass keeps its own bucket.
    expect(classifyProviderErrorMessage('[provider-openai] Request timed out.')).toBe('TIMEOUT')
    expect(classifyProviderErrorMessages(['[provider-local] Connection error.', 'weird'])).toBe('NETWORK')
  })

  it('still prefers auth and rate limits', () => {
    expect(classifyProviderErrorMessage('[provider-openai] 401 Incorrect API key provided')).toBe('PROVIDER_AUTH')
    expect(classifyProviderErrorMessage('[provider-openai] 429 Too Many Requests')).toBe('RATE_LIMITED')
    expect(classifyProviderErrorMessages(['503 Service Unavailable', '401 Unauthorized'])).toBe('PROVIDER_AUTH')
    expect(classifyProviderErrorMessages(['402 Payment Required', '401 Unauthorized'])).toBe('PROVIDER_AUTH')
    expect(classifyProviderErrorMessages(['429 Too Many Requests', '402 Payment Required'])).toBe('PROVIDER_BILLING')
    expect(classifyProviderErrorMessages(['503 Service Unavailable', 'weird'])).toBe('PROVIDER_UNAVAILABLE')
  })
})

describe('mostActionableProviderErrorCode', () => {
  it('ranks account failures first and falls back to UNKNOWN', () => {
    expect(mostActionableProviderErrorCode(['NETWORK', 'PROVIDER_BILLING', 'RATE_LIMITED'])).toBe('PROVIDER_BILLING')
    expect(mostActionableProviderErrorCode(['PROVIDER_BILLING', 'PROVIDER_AUTH'])).toBe('PROVIDER_AUTH')
    expect(mostActionableProviderErrorCode(['TIMEOUT', 'NETWORK'])).toBe('TIMEOUT')
    expect(mostActionableProviderErrorCode([])).toBe('UNKNOWN')
  })
})
