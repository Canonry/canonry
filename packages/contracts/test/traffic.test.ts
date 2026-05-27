import { describe, expect, it } from 'vitest'
import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  cloudflareWorkerEventSchema,
  cloudflareWorkerIngestRequestSchema,
  cloudflareWorkerSourceConfigSchema,
  normalizedTrafficRequestSchema,
  trafficConnectCloudflareRequestSchema,
  trafficConnectCloudflareResponseSchema,
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

describe('cloudflareWorkerSourceConfigSchema', () => {
  it('accepts a valid Cloudflare Worker source config', () => {
    const parsed = cloudflareWorkerSourceConfigSchema.parse({
      schemaVersion: 1,
      workerVersion: '1.0.0',
      expectedBotListVersion: '2026-05-27',
      zoneId: 'zone_abc123',
      accountId: 'acct_xyz789',
    })
    expect(parsed.workerVersion).toBe('1.0.0')
    expect(parsed.zoneId).toBe('zone_abc123')
  })

  it('allows zoneId and accountId to be null', () => {
    const parsed = cloudflareWorkerSourceConfigSchema.parse({
      schemaVersion: 1,
      workerVersion: '1.0.0',
      expectedBotListVersion: '2026-05-27',
      zoneId: null,
      accountId: null,
    })
    expect(parsed.zoneId).toBeNull()
    expect(parsed.accountId).toBeNull()
  })

  it('rejects a schemaVersion other than 1', () => {
    expect(() => cloudflareWorkerSourceConfigSchema.parse({
      schemaVersion: 2,
      workerVersion: '1.0.0',
      expectedBotListVersion: '2026-05-27',
      zoneId: null,
      accountId: null,
    })).toThrow()
  })

  it('rejects an empty workerVersion or expectedBotListVersion', () => {
    expect(() => cloudflareWorkerSourceConfigSchema.parse({
      schemaVersion: 1,
      workerVersion: '',
      expectedBotListVersion: '2026-05-27',
      zoneId: null,
      accountId: null,
    })).toThrow()
    expect(() => cloudflareWorkerSourceConfigSchema.parse({
      schemaVersion: 1,
      workerVersion: '1.0.0',
      expectedBotListVersion: '',
      zoneId: null,
      accountId: null,
    })).toThrow()
  })
})

describe('trafficConnectCloudflareRequestSchema', () => {
  it('accepts an empty body (all fields optional)', () => {
    const parsed = trafficConnectCloudflareRequestSchema.parse({})
    expect(parsed.displayName).toBeUndefined()
    expect(parsed.zoneId).toBeUndefined()
    expect(parsed.accountId).toBeUndefined()
  })

  it('accepts a connect request with every optional field', () => {
    const parsed = trafficConnectCloudflareRequestSchema.parse({
      displayName: 'Example zone',
      zoneId: 'zone_abc123',
      accountId: 'acct_xyz789',
    })
    expect(parsed.displayName).toBe('Example zone')
    expect(parsed.zoneId).toBe('zone_abc123')
    expect(parsed.accountId).toBe('acct_xyz789')
  })

  it('rejects an empty string for any provided field', () => {
    expect(() => trafficConnectCloudflareRequestSchema.parse({ displayName: '' })).toThrow()
    expect(() => trafficConnectCloudflareRequestSchema.parse({ zoneId: '' })).toThrow()
    expect(() => trafficConnectCloudflareRequestSchema.parse({ accountId: '' })).toThrow()
  })
})

describe('trafficConnectCloudflareResponseSchema', () => {
  it('accepts a populated response', () => {
    const parsed = trafficConnectCloudflareResponseSchema.parse({
      sourceId: 'src_abc123',
      workerScript: 'addEventListener("fetch", () => {})',
      wranglerToml: 'name = "canonry-worker"',
      workerVersion: '1.0.0',
      instructions: 'Deploy to your zone',
    })
    expect(parsed.sourceId).toBe('src_abc123')
    expect(parsed.workerScript).toContain('fetch')
  })

  it('rejects empty string for any required field', () => {
    expect(() => trafficConnectCloudflareResponseSchema.parse({
      sourceId: '',
      workerScript: 'x',
      wranglerToml: 'x',
      workerVersion: 'x',
      instructions: 'x',
    })).toThrow()
  })
})

describe('cloudflareWorkerEventSchema', () => {
  it('accepts a full event with cf properties populated', () => {
    const parsed = cloudflareWorkerEventSchema.parse({
      eventId: '8a3d2b0c-cf-ray',
      observedAt: '2026-05-27T15:30:00.123Z',
      method: 'GET',
      host: 'example.com',
      path: '/blog/post',
      queryString: 'utm_source=chatgpt',
      status: 200,
      userAgent: 'GPTBot/1.2',
      remoteIp: '20.171.207.34',
      referer: 'https://chat.openai.com/',
      cf: {
        verifiedBot: true,
        botScore: 30,
        country: 'US',
        asn: 8075,
        asOrganization: 'Microsoft Corporation',
      },
    })
    expect(parsed.eventId).toBe('8a3d2b0c-cf-ray')
    expect(parsed.cf?.verifiedBot).toBe(true)
  })

  it('accepts a minimal event with cf=null and most fields null', () => {
    const parsed = cloudflareWorkerEventSchema.parse({
      eventId: 'ray-id',
      observedAt: '2026-05-27T15:30:00.123Z',
      method: null,
      host: null,
      path: '/',
      queryString: null,
      status: null,
      userAgent: null,
      remoteIp: null,
      referer: null,
      cf: null,
    })
    expect(parsed.cf).toBeNull()
    expect(parsed.path).toBe('/')
  })

  it('rejects an empty path', () => {
    expect(() => cloudflareWorkerEventSchema.parse({
      eventId: 'ray-id',
      observedAt: '2026-05-27T15:30:00.123Z',
      method: null,
      host: null,
      path: '',
      queryString: null,
      status: null,
      userAgent: null,
      remoteIp: null,
      referer: null,
      cf: null,
    })).toThrow()
  })

  it('rejects an empty eventId', () => {
    expect(() => cloudflareWorkerEventSchema.parse({
      eventId: '',
      observedAt: '2026-05-27T15:30:00.123Z',
      method: null,
      host: null,
      path: '/',
      queryString: null,
      status: null,
      userAgent: null,
      remoteIp: null,
      referer: null,
      cf: null,
    })).toThrow()
  })
})

describe('cloudflareWorkerIngestRequestSchema', () => {
  const validEvent = {
    eventId: 'ray-id',
    observedAt: '2026-05-27T15:30:00.123Z',
    method: 'GET',
    host: 'example.com',
    path: '/',
    queryString: null,
    status: 200,
    userAgent: 'GPTBot/1.2',
    remoteIp: '20.171.207.34',
    referer: null,
    cf: null,
  }

  it('accepts a single-event ingest request', () => {
    const parsed = cloudflareWorkerIngestRequestSchema.parse({
      schemaVersion: 1,
      workerVersion: '1.0.0',
      events: [validEvent],
    })
    expect(parsed.events).toHaveLength(1)
  })

  it('accepts an array of up to 100 events', () => {
    const events = Array.from({ length: 100 }, (_, i) => ({ ...validEvent, eventId: `ray-${i}` }))
    const parsed = cloudflareWorkerIngestRequestSchema.parse({
      schemaVersion: 1,
      workerVersion: '1.0.0',
      events,
    })
    expect(parsed.events).toHaveLength(100)
  })

  it('rejects an empty events array', () => {
    expect(() => cloudflareWorkerIngestRequestSchema.parse({
      schemaVersion: 1,
      workerVersion: '1.0.0',
      events: [],
    })).toThrow()
  })

  it('rejects more than 100 events', () => {
    const events = Array.from({ length: 101 }, (_, i) => ({ ...validEvent, eventId: `ray-${i}` }))
    expect(() => cloudflareWorkerIngestRequestSchema.parse({
      schemaVersion: 1,
      workerVersion: '1.0.0',
      events,
    })).toThrow()
  })

  it('rejects a non-1 schemaVersion', () => {
    expect(() => cloudflareWorkerIngestRequestSchema.parse({
      schemaVersion: 2,
      workerVersion: '1.0.0',
      events: [validEvent],
    })).toThrow()
  })

  it('rejects an empty workerVersion', () => {
    expect(() => cloudflareWorkerIngestRequestSchema.parse({
      schemaVersion: 1,
      workerVersion: '',
      events: [validEvent],
    })).toThrow()
  })
})
