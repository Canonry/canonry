import { describe, expect, it } from 'vitest'
import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  normalizedTrafficRequestSchema,
  trafficConnectVercelRequestSchema,
  trafficConnectWordpressRequestSchema,
  vercelTrafficSourceConfigSchema,
  wordpressTrafficSourceConfigSchema,
} from '../src/traffic.js'

describe('traffic contracts', () => {
  it('accepts a raw request event from any server-side adapter', () => {
    const parsed = normalizedTrafficRequestSchema.parse({
      sourceType: TrafficSourceTypes['cloud-run'],
      evidenceKind: TrafficEvidenceKinds['raw-request'],
      confidence: TrafficEventConfidences.observed,
      eventId: 'cloud-run:2026-04-30T12:00:00.000Z:abc123',
      observedAt: '2026-04-30T12:00:00.000Z',
      method: 'GET',
      requestUrl: 'https://example.com/blog/post?utm_source=chatgpt.com',
      host: 'example.com',
      path: '/blog/post',
      queryString: 'utm_source=chatgpt.com',
      status: 200,
      userAgent: 'GPTBot/1.2',
      remoteIp: '203.0.113.10',
      referer: 'https://chatgpt.com/',
      latencyMs: 123.4,
      requestSizeBytes: 456,
      responseSizeBytes: 789,
      providerResource: {
        type: 'cloud_run_revision',
        labels: {
          project_id: 'sample-project',
          service_name: 'web',
          location: 'us-central1',
        },
      },
      providerLabels: {},
    })

    expect(parsed.sourceType).toBe(TrafficSourceTypes['cloud-run'])
    expect(parsed.evidenceKind).toBe(TrafficEvidenceKinds['raw-request'])
    expect(parsed.confidence).toBe(TrafficEventConfidences.observed)
    expect(parsed.path).toBe('/blog/post')
  })
})

describe('wordpressTrafficSourceConfigSchema', () => {
  it('accepts a valid WordPress traffic source config', () => {
    const parsed = wordpressTrafficSourceConfigSchema.parse({
      baseUrl: 'https://example.com',
      username: 'canonry-bot',
    })
    expect(parsed.baseUrl).toBe('https://example.com')
    expect(parsed.username).toBe('canonry-bot')
  })

  it('rejects an invalid baseUrl', () => {
    expect(() => wordpressTrafficSourceConfigSchema.parse({
      baseUrl: 'not-a-url',
      username: 'canonry-bot',
    })).toThrow()
  })

  it('rejects an empty username', () => {
    expect(() => wordpressTrafficSourceConfigSchema.parse({
      baseUrl: 'https://example.com',
      username: '',
    })).toThrow()
  })
})

describe('trafficConnectWordpressRequestSchema', () => {
  it('accepts a connect request with all required fields', () => {
    const parsed = trafficConnectWordpressRequestSchema.parse({
      baseUrl: 'https://example.com',
      username: 'canonry-bot',
      applicationPassword: 'xxxx xxxx xxxx xxxx xxxx xxxx',
      displayName: 'Example WordPress',
    })
    expect(parsed.applicationPassword).toBe('xxxx xxxx xxxx xxxx xxxx xxxx')
    expect(parsed.displayName).toBe('Example WordPress')
  })

  it('allows omitting displayName', () => {
    const parsed = trafficConnectWordpressRequestSchema.parse({
      baseUrl: 'https://example.com',
      username: 'canonry-bot',
      applicationPassword: 'pw',
    })
    expect(parsed.displayName).toBeUndefined()
  })

  it('rejects an empty applicationPassword', () => {
    expect(() => trafficConnectWordpressRequestSchema.parse({
      baseUrl: 'https://example.com',
      username: 'canonry-bot',
      applicationPassword: '',
    })).toThrow()
  })
})

describe('vercelTrafficSourceConfigSchema', () => {
  it('accepts a valid Vercel traffic source config', () => {
    const parsed = vercelTrafficSourceConfigSchema.parse({
      projectId: 'prj_abc123',
      teamId: 'team_xyz789',
      environment: 'production',
    })
    expect(parsed.projectId).toBe('prj_abc123')
    expect(parsed.teamId).toBe('team_xyz789')
    expect(parsed.environment).toBe('production')
  })

  it('rejects an unknown environment', () => {
    expect(() => vercelTrafficSourceConfigSchema.parse({
      projectId: 'prj_abc123',
      teamId: 'team_xyz789',
      environment: 'staging',
    })).toThrow()
  })

  it('rejects an empty projectId or teamId', () => {
    expect(() => vercelTrafficSourceConfigSchema.parse({
      projectId: '',
      teamId: 'team_xyz789',
      environment: 'production',
    })).toThrow()
    expect(() => vercelTrafficSourceConfigSchema.parse({
      projectId: 'prj_abc123',
      teamId: '',
      environment: 'production',
    })).toThrow()
  })
})

describe('trafficConnectVercelRequestSchema', () => {
  it('accepts a connect request with all fields', () => {
    const parsed = trafficConnectVercelRequestSchema.parse({
      projectId: 'prj_abc123',
      teamId: 'team_xyz789',
      token: 'vcp_secret',
      environment: 'preview',
      displayName: 'Example Vercel',
    })
    expect(parsed.token).toBe('vcp_secret')
    expect(parsed.environment).toBe('preview')
    expect(parsed.displayName).toBe('Example Vercel')
  })

  it('allows omitting environment and displayName', () => {
    const parsed = trafficConnectVercelRequestSchema.parse({
      projectId: 'prj_abc123',
      teamId: 'team_xyz789',
      token: 'vcp_secret',
    })
    expect(parsed.environment).toBeUndefined()
    expect(parsed.displayName).toBeUndefined()
  })

  it('rejects an empty token', () => {
    expect(() => trafficConnectVercelRequestSchema.parse({
      projectId: 'prj_abc123',
      teamId: 'team_xyz789',
      token: '',
    })).toThrow()
  })
})
