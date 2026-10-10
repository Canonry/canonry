import { describe, expect, it } from 'vitest'
import {
  FEATURE_OPERATIONS,
  OUTCOME_COUNT_KEYS,
  bucketDuration,
  classifyOutcomeError,
  featureCompletedPropertiesSchema,
  installStatePropertiesSchema,
  integrationConnectionPropertiesSchema,
  statusClassOf,
} from '../src/index.js'

/** The canonry.ai collector's generic limits (lib/telemetry/validation.ts). */
const MAX_BODY_BYTES = 2048
const ENVELOPE = {
  anonymousId: '11223344-5566-7788-99aa-bbccddeeff00',
  eventId: '11223344-5566-7788-99aa-bbccddeeff01',
  sessionId: '11223344-5566-7788-99aa-bbccddeeff02',
  source: 'cli-server',
  timestamp: '2026-10-10T00:00:00.000Z',
  version: '7.123.456',
  nodeVersion: 'v24.123.456',
  os: 'darwin',
  arch: 'arm64',
  errorCode: 'r'.repeat(40),
}

function assertCollectorShape(event: string, properties: Record<string, unknown>) {
  expect(Object.keys(properties).length).toBeLessThanOrEqual(20)
  for (const [key, value] of Object.entries(properties)) {
    expect(key.length).toBeLessThanOrEqual(64)
    expect(value).not.toBeNull()
    if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(200)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      expect(Object.keys(value).length).toBeLessThanOrEqual(12)
      for (const nested of Object.values(value)) expect(typeof nested === 'object' && !Array.isArray(nested)).toBe(false)
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ ...ENVELOPE, event, properties })).byteLength
  expect(bytes).toBeLessThanOrEqual(MAX_BODY_BYTES)
}

describe('integration.connection', () => {
  it('accepts a full failed attempt and fits the collector', () => {
    const props = {
      integration: 'traffic_cloud_run',
      action: 'disconnect',
      status: 'failed',
      reasonCode: 'OPERATION_IN_PROGRESS',
      errorName: 'E'.repeat(40),
      target: 'first_party',
      surface: 'mcp-stdio',
      agent: 'a'.repeat(40),
      durationBucket: '30m_or_more',
      attempt: 1_000_000,
    }
    expect(integrationConnectionPropertiesSchema.parse(props)).toEqual(props)
    assertCollectorShape('integration.connection', props)
  })

  it('requires the provider name for, and only for, a provider connection', () => {
    expect(integrationConnectionPropertiesSchema.safeParse({ integration: 'provider', action: 'connect', status: 'succeeded' }).success).toBe(false)
    expect(integrationConnectionPropertiesSchema.safeParse({ integration: 'provider', provider: 'gemini', action: 'connect', status: 'succeeded' }).success).toBe(true)
    expect(integrationConnectionPropertiesSchema.safeParse({ integration: 'gsc', provider: 'gemini', action: 'connect', status: 'succeeded' }).success).toBe(false)
  })

  it('requires a reason for a failed or cancelled attempt, not for started or succeeded', () => {
    const base = { integration: 'gsc', action: 'connect' }
    expect(integrationConnectionPropertiesSchema.safeParse({ ...base, status: 'failed' }).success).toBe(false)
    expect(integrationConnectionPropertiesSchema.safeParse({ ...base, status: 'cancelled' }).success).toBe(false)
    expect(integrationConnectionPropertiesSchema.safeParse({ ...base, status: 'started' }).success).toBe(true)
  })

  it('rejects free text, unknown keys and null', () => {
    const base = { integration: 'gsc', action: 'connect', status: 'failed', reasonCode: 'AUTH_DENIED' }
    expect(integrationConnectionPropertiesSchema.safeParse({ ...base, errorName: 'user denied access to https://x' }).success).toBe(false)
    expect(integrationConnectionPropertiesSchema.safeParse({ ...base, property: 'sc-domain:example.com' }).success).toBe(false)
    expect(integrationConnectionPropertiesSchema.safeParse({ ...base, agent: null }).success).toBe(false)
  })
})

describe('feature.completed', () => {
  it('accepts the widest outcome and fits the collector', () => {
    const counts = Object.fromEntries(OUTCOME_COUNT_KEYS.slice(0, 12).map(key => [key, 1e12]))
    const props = {
      feature: 'aero',
      operation: 'turn',
      status: 'cancelled',
      trigger: 'scheduled',
      surface: 'mcp-stdio',
      agent: 'a'.repeat(40),
      reasonCode: 'OPERATION_IN_PROGRESS',
      errorName: 'E'.repeat(40),
      durationBucket: '30m_or_more',
      counts,
      target: 'first_party',
      eventType: 'review.rating-dropped',
      statusClass: 'timeout',
      provider: 'perplexity',
      model: 'm'.repeat(100),
      modelProvider: 'p'.repeat(32),
      sampleRate: 1_000_000,
      droppedBefore: 1e12,
      domainHash: 'd'.repeat(64),
    }
    expect(featureCompletedPropertiesSchema.parse(props)).toEqual(props)
    assertCollectorShape('feature.completed', props)
  })

  it('accepts every declared feature and operation pair', () => {
    for (const [feature, operations] of Object.entries(FEATURE_OPERATIONS)) {
      for (const operation of operations) {
        expect(featureCompletedPropertiesSchema.safeParse({ feature, operation, status: 'succeeded' }).success, `${feature}.${operation}`).toBe(true)
      }
    }
  })

  it('rejects an operation its feature does not report', () => {
    expect(featureCompletedPropertiesSchema.safeParse({ feature: 'ga4', operation: 'turn', status: 'succeeded' }).success).toBe(false)
  })

  it('needs a reason for anything but success', () => {
    expect(featureCompletedPropertiesSchema.safeParse({ feature: 'ga4', operation: 'sync', status: 'failed' }).success).toBe(false)
    expect(featureCompletedPropertiesSchema.safeParse({ feature: 'ga4', operation: 'sync', status: 'skipped', reasonCode: 'NOT_DUE' }).success).toBe(true)
  })

  it('bounds counts: known keys, non-negative integers, at most 12', () => {
    const base = { feature: 'ga4', operation: 'sync', status: 'succeeded' }
    expect(featureCompletedPropertiesSchema.safeParse({ ...base, counts: { rows: 12 } }).success).toBe(true)
    expect(featureCompletedPropertiesSchema.safeParse({ ...base, counts: { propertyId: 1 } }).success).toBe(false)
    expect(featureCompletedPropertiesSchema.safeParse({ ...base, counts: { rows: -1 } }).success).toBe(false)
    expect(featureCompletedPropertiesSchema.safeParse({ ...base, counts: { rows: 1.5 } }).success).toBe(false)
    expect(featureCompletedPropertiesSchema.safeParse({ ...base, counts: {} }).success).toBe(false)
    const thirteen = Object.fromEntries(OUTCOME_COUNT_KEYS.slice(0, 13).map(key => [key, 1]))
    expect(featureCompletedPropertiesSchema.safeParse({ ...base, counts: thirteen }).success).toBe(false)
  })

  it('never carries a URL or a raw domain', () => {
    const base = { feature: 'webhooks', operation: 'deliver', status: 'succeeded' }
    expect(featureCompletedPropertiesSchema.safeParse({ ...base, model: 'https://hooks.example.com' }).success).toBe(false)
    expect(featureCompletedPropertiesSchema.safeParse({ ...base, domainHash: 'example.com' }).success).toBe(false)
  })
})

describe('install.state', () => {
  it('accepts a full install summary and fits the collector', () => {
    const props = {
      providers: ['gemini', 'openai', 'claude', 'perplexity', 'muse', 'local', 'cdp:chatgpt'],
      integrations: ['gsc', 'ga4', 'bing', 'gbp', 'google_ads', 'gtm', 'openai_ads', 'traffic_cloudflare',
        'traffic_vercel', 'traffic_cloud_run', 'wordpress', 'backlinks', 'webhook', 'agent_webhook', 'cdp'],
      counts: { projects: 1e6, queries: 1e6, competitors: 1e6, locations: 1e6, schedules: 1e6, webhooks: 1e6,
        agentWebhooks: 1e6, trafficSources: 1e6, googleConnections: 1e6, bingConnections: 1e6, backlinkSources: 1e6, adsAccounts: 1e6 },
      usage24h: { sweeps: 1e9, audits: 1e9, providerCalls: 1e9, inputTokens: 1e9, outputTokens: 1e9, costMicros: 1e9,
        aeroTurns: 1e9, aeroModelCalls: 1e9, aeroInputTokens: 1e9, aeroOutputTokens: 1e9, aeroCostMicros: 1e9, webhookDeliveries: 1e9 },
      providerCalls24h: { gemini: 1e6, openai: 1e6, claude: 1e6, perplexity: 1e6, muse: 1e6, local: 1e6, 'cdp:chatgpt': 1e6 },
      agentProvider: 'p'.repeat(32),
      agentModel: 'm'.repeat(100),
      uptimeBucket: '30m_or_more',
    }
    expect(installStatePropertiesSchema.parse(props)).toEqual(props)
    assertCollectorShape('install.state', props)
  })

  it('rejects provider as a listed integration and unknown keys', () => {
    const base = { providers: [], integrations: [], counts: {}, usage24h: {} }
    expect(installStatePropertiesSchema.safeParse(base).success).toBe(true)
    expect(installStatePropertiesSchema.safeParse({ ...base, integrations: ['provider'] }).success).toBe(false)
    expect(installStatePropertiesSchema.safeParse({ ...base, counts: { projectNames: 1 } }).success).toBe(false)
  })
})

describe('helpers', () => {
  it('buckets durations like cli.command.finished', () => {
    expect(bucketDuration(0)).toBe('under_1s')
    expect(bucketDuration(9_999)).toBe('1s_to_10s')
    expect(bucketDuration(60_000)).toBe('1m_to_5m')
    expect(bucketDuration(Number.NaN)).toBe('under_1s')
    expect(bucketDuration(10 * 3_600_000)).toBe('30m_or_more')
  })

  it('classes HTTP statuses, treating no status as a network failure', () => {
    expect(statusClassOf(204)).toBe('2xx')
    expect(statusClassOf(429)).toBe('4xx')
    expect(statusClassOf(503)).toBe('5xx')
    expect(statusClassOf(0)).toBe('network')
    expect(statusClassOf(undefined)).toBe('network')
  })

  it('classifies errors by code and status, never by message', () => {
    class GaxiosError extends Error { status = 403 }
    expect(classifyOutcomeError(new GaxiosError('The caller does not have permission for sc-domain:example.com'))).toEqual({ reasonCode: 'PERMISSION_MISSING', errorName: 'Error' })
    expect(classifyOutcomeError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).reasonCode).toBe('NETWORK')
    expect(classifyOutcomeError(Object.assign(new Error('x'), { name: 'AbortError' }))).toEqual({ reasonCode: 'TIMEOUT', errorName: 'AbortError' })
    expect(classifyOutcomeError({ code: 'RATE_LIMITED' }).reasonCode).toBe('RATE_LIMITED')
    expect(classifyOutcomeError({ code: 'PROVIDER_AUTH' }).reasonCode).toBe('INVALID_CREDENTIALS')
    expect(classifyOutcomeError({ response: { status: 502 } }).reasonCode).toBe('HTTP_5XX')
    expect(classifyOutcomeError({ details: { httpStatus: 429 } }).reasonCode).toBe('RATE_LIMITED')
    expect(classifyOutcomeError('boom')).toEqual({ reasonCode: 'UNKNOWN' })
    expect(classifyOutcomeError(null)).toEqual({ reasonCode: 'UNKNOWN' })
  })
})
