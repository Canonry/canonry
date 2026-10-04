import { describe, expect, it } from 'vitest'
import {
  classifyProviderErrorMessage,
  classifyProviderErrorMessages,
  extractProviderHttpStatus,
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

  it('still prefers auth and rate limits', () => {
    expect(classifyProviderErrorMessage('[provider-openai] 401 Incorrect API key provided')).toBe('PROVIDER_AUTH')
    expect(classifyProviderErrorMessage('[provider-openai] 429 Too Many Requests')).toBe('RATE_LIMITED')
    expect(classifyProviderErrorMessages(['503 Service Unavailable', '401 Unauthorized'])).toBe('PROVIDER_AUTH')
    expect(classifyProviderErrorMessages(['503 Service Unavailable', 'weird'])).toBe('PROVIDER_UNAVAILABLE')
  })
})
