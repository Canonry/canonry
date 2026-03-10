import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../src/normalize.js'

describe('provider-local validateConfig', () => {
  it('rejects missing base URL', () => {
    const result = validateConfig({
      baseUrl: '',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /missing base URL/)
  })

  it('accepts valid config without apiKey', () => {
    const result = validateConfig({
      baseUrl: 'http://localhost:11434/v1',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
    })
    assert.equal(result.ok, true)
  })
})
