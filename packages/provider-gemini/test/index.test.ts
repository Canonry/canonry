import assert from 'node:assert/strict'
import test from 'node:test'

import { executeTrackedQuery, healthcheck, normalizeResult, validateConfig } from '../src/index.js'

const validConfig = {
  apiKey: 'gemini-key',
  quotaPolicy: {
    maxConcurrency: 2,
    maxRequestsPerMinute: 10,
    maxRequestsPerDay: 1000,
  },
}

test('validateConfig accepts a non-empty API key', () => {
  assert.deepEqual(validateConfig(validConfig), {
    ok: true,
    provider: 'gemini',
    message: 'phase-1 placeholder config accepted',
  })
})

test('healthcheck mirrors validateConfig', async () => {
  assert.deepEqual(await healthcheck(validConfig), {
    ok: true,
    provider: 'gemini',
    message: 'phase-1 placeholder config accepted',
  })
})

test('executeTrackedQuery and normalizeResult preserve placeholder shape', async () => {
  const raw = await executeTrackedQuery({
    keyword: 'answer engine optimization',
    canonicalDomains: ['ainyc.ai'],
    competitorDomains: ['example.com'],
  })

  assert.deepEqual(raw, {
    provider: 'gemini',
    rawResponse: {
      status: 'not-implemented',
      phase: '1',
    },
  })

  assert.deepEqual(normalizeResult(raw), {
    provider: 'gemini',
    answerText: 'Phase 1 placeholder',
    citedDomains: [],
  })
})
