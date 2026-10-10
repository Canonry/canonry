import { describe, expect, it } from 'vitest'
import {
  classifyProviderOutcomeError,
  providerErrorCodeSchema,
  providerErrorOutcomeReason,
} from '../src/index.js'

describe('provider failures as outcome reasons', () => {
  it('maps every provider failure bucket to an outcome reason', () => {
    expect(Object.fromEntries(providerErrorCodeSchema.options.map(code => [code, providerErrorOutcomeReason(code)]))).toEqual({
      PROVIDER_AUTH: 'INVALID_CREDENTIALS',
      PROVIDER_BILLING: 'BILLING',
      RATE_LIMITED: 'RATE_LIMITED',
      PROVIDER_UNAVAILABLE: 'HTTP_5XX',
      NETWORK: 'NETWORK',
      TIMEOUT: 'TIMEOUT',
      PARSE_ERROR: 'UNKNOWN',
      UNKNOWN: 'UNKNOWN',
    })
  })

  it('prefers a code or status, then reads the adapter text the way run.completed does, and keeps only the class name', () => {
    expect(classifyProviderOutcomeError(Object.assign(new Error('provider said 401'), { status: 429 }))).toEqual({ reasonCode: 'RATE_LIMITED', errorName: 'Error' })
    expect(classifyProviderOutcomeError(new Error('[provider-openai] 401 Incorrect API key provided: sk-abc'))).toEqual({ reasonCode: 'INVALID_CREDENTIALS', errorName: 'Error' })
    expect(classifyProviderOutcomeError(new Error('[provider-openai] 429 You exceeded your current quota'))).toEqual({ reasonCode: 'BILLING', errorName: 'Error' })
    expect(classifyProviderOutcomeError(new Error('[provider-claude] 529 overloaded'))).toEqual({ reasonCode: 'HTTP_5XX', errorName: 'Error' })
    expect(classifyProviderOutcomeError(new TypeError('Connection error.'))).toEqual({ reasonCode: 'NETWORK', errorName: 'TypeError' })
    expect(classifyProviderOutcomeError(new Error('Configured API provider is unavailable.'))).toEqual({ reasonCode: 'UNKNOWN', errorName: 'Error' })
    expect(classifyProviderOutcomeError(undefined)).toEqual({ reasonCode: 'UNKNOWN' })
  })
})
