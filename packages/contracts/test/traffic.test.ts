import { describe, expect, it } from 'vitest'
import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  CloudflareTrafficDeliveryModes,
  cloudflareEdgeEventBatchSchema,
  cloudflareEdgeEventSchema,
  cloudflareTrafficDeliveryModeSchema,
  cloudflareTrafficSourceConfigSchema,
  cloudflareWorkerEventSchema,
  cloudflareWorkerIngestRequestSchema,
  cloudflareWorkerSourceConfigSchema,
  normalizedTrafficRequestSchema,
  trafficConnectCloudflareRequestSchema,
  trafficConnectCloudflareResponseSchema,
  trafficConnectVercelRequestSchema,
  trafficConnectWordpressRequestSchema,
  trafficCrawlerEventEntrySchema,
  trafficAiUserFetchEventEntrySchema,
  trafficSourceDtoSchema,
  trafficSyncResponseSchema,
  trafficVerificationManifestSchema,
  trafficVerificationManifestUsageSchema,
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

  it('validates crawler verification manifest provenance', () => {
    const manifest = {
      id: 'anthropic-claude',
      source: 'https://www.anthropic.com/ips',
      version: '2026-08-13T00:00:00Z',
    }

    expect(trafficVerificationManifestSchema.parse(manifest)).toEqual(manifest)
    expect(trafficCrawlerEventEntrySchema.parse({
      kind: 'crawler',
      sourceId: 'source_1',
      tsHour: '2026-08-13T12:00:00.000Z',
      botId: 'anthropic-claudebot',
      operator: 'Anthropic',
      verificationStatus: 'verified',
      verificationManifests: [{ manifestId: manifest.id, manifest, hits: 1 }],
      verificationUnattributedHits: 0,
      pathNormalized: '/docs',
      pathClass: 'content',
      status: 200,
      hits: 1,
    }).verificationManifests).toEqual([{ manifestId: manifest.id, manifest, hits: 1 }])
    expect(trafficVerificationManifestUsageSchema.parse({
      manifestId: manifest.id,
      manifest,
      hits: 1,
    }).manifest).toEqual(manifest)
  })

  it('accepts pre-provenance crawler and user-fetch response rows', () => {
    const crawler = trafficCrawlerEventEntrySchema.parse({
      kind: 'crawler',
      sourceId: 'source_1',
      tsHour: '2026-08-13T12:00:00.000Z',
      botId: 'claudebot',
      operator: 'Anthropic',
      verificationStatus: 'verified',
      pathNormalized: '/docs',
      pathClass: 'content',
      status: 200,
      hits: 2,
    })
    const userFetch = trafficAiUserFetchEventEntrySchema.parse({
      kind: 'ai-user-fetch',
      sourceId: 'source_1',
      tsHour: '2026-08-13T12:00:00.000Z',
      botId: 'claude-user',
      operator: 'Anthropic',
      verificationStatus: 'claimed_unverified',
      pathNormalized: '/docs',
      status: 200,
      hits: 1,
    })

    expect(crawler.verificationManifests).toBeUndefined()
    expect(crawler.verificationUnattributedHits).toBeUndefined()
    expect(userFetch.verificationManifests).toBeUndefined()
    expect(userFetch.verificationUnattributedHits).toBeUndefined()
  })
})

describe('trafficSourceDtoSchema', () => {
  it('surfaces the last observed residual Queue backlog', () => {
    const parsed = trafficSourceDtoSchema.parse({
      id: 'src_queue',
      projectId: 'project_1',
      sourceType: 'cloudflare',
      displayName: 'Cloudflare Queue',
      status: 'connected',
      lastSyncedAt: '2026-08-11T12:00:00.000Z',
      lastCursor: null,
      lastError: null,
      skippedThroughAt: null,
      queueBacklogCount: 125,
      queueBacklogObservedAt: '2026-08-11T12:00:00.000Z',
      archivedAt: null,
      config: { deliveryMode: 'queue-pull' },
      createdAt: '2026-08-11T11:00:00.000Z',
      updatedAt: '2026-08-11T12:00:00.000Z',
    })

    expect(parsed.queueBacklogCount).toBe(125)
    expect(parsed.queueBacklogObservedAt).toBe('2026-08-11T12:00:00.000Z')
  })

  it('rejects a negative Queue backlog count', () => {
    expect(() => trafficSourceDtoSchema.parse({
      id: 'src_queue',
      projectId: 'project_1',
      sourceType: 'cloudflare',
      displayName: 'Cloudflare Queue',
      status: 'connected',
      lastSyncedAt: null,
      lastCursor: null,
      lastError: null,
      skippedThroughAt: null,
      queueBacklogCount: -1,
      queueBacklogObservedAt: null,
      archivedAt: null,
      config: { deliveryMode: 'queue-pull' },
      createdAt: '2026-08-11T11:00:00.000Z',
      updatedAt: '2026-08-11T12:00:00.000Z',
    })).toThrow()
  })
})

describe('trafficSyncResponseSchema', () => {
  it('optionally reports residual Queue backlog without changing pull-adapter responses', () => {
    const response = {
      sourceId: 'src_queue',
      runId: 'run_1',
      syncedAt: '2026-08-11T12:00:00.000Z',
      pulledEvents: 1000,
      selfTrafficExcluded: 0,
      crawlerHits: 1000,
      aiUserFetchHits: 0,
      aiUserFetchLikelyFakeHits: 0,
      aiReferralHits: 0,
      unknownHits: 0,
      crawlerBucketRows: 1,
      aiUserFetchBucketRows: 0,
      aiReferralBucketRows: 0,
      sampleRows: 1,
      windowStart: '2026-08-11T11:30:00.000Z',
      windowEnd: '2026-08-11T12:00:00.000Z',
    }

    expect(trafficSyncResponseSchema.parse(response)).not.toHaveProperty('remainingBacklogCount')
    expect(trafficSyncResponseSchema.parse({ ...response, remainingBacklogCount: 250 }))
      .toMatchObject({ remainingBacklogCount: 250 })
    expect(() => trafficSyncResponseSchema.parse({ ...response, remainingBacklogCount: -1 })).toThrow()
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
    expect(parsed.deliveryMode).toBe(CloudflareTrafficDeliveryModes['direct-push'])
  })

  it('defaults legacy source rows to direct push', () => {
    const parsed = cloudflareTrafficSourceConfigSchema.parse({
      schemaVersion: 1,
      workerVersion: '1.0.0',
      expectedBotListVersion: '2026-05-27',
      zoneId: null,
      accountId: null,
    })
    expect(parsed.deliveryMode).toBe('direct-push')
  })

  it('accepts the queue-pull source-config variant without persisting its API token', () => {
    const parsed = cloudflareTrafficSourceConfigSchema.parse({
      schemaVersion: 1,
      deliveryMode: 'queue-pull',
      workerVersion: '1.0.0',
      expectedBotListVersion: '2026-05-27',
      zoneId: 'zone_abc123',
      accountId: 'acct_xyz789',
      queueId: 'queue_abc123',
      queueName: 'canonry-traffic-src-abc123',
      retentionSeconds: 345600,
      apiToken: 'must-not-persist',
    })
    expect(parsed.deliveryMode).toBe('queue-pull')
    expect(parsed.queueName).toBe('canonry-traffic-src-abc123')
    expect(parsed).not.toHaveProperty('apiToken')
  })

  it('keeps the Worker config name as an exact compatibility alias', () => {
    expect(cloudflareWorkerSourceConfigSchema).toBe(cloudflareTrafficSourceConfigSchema)
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
    expect(parsed.deliveryMode).toBe('direct-push')
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

  it('requires queue metadata and the Queue API token for queue pull', () => {
    const parsed = trafficConnectCloudflareRequestSchema.parse({
      deliveryMode: 'queue-pull',
      zoneId: 'zone_abc123',
      accountId: 'acct_xyz789',
      queueId: 'queue_abc123',
      queueName: 'canonry-traffic-src-abc123',
      retentionSeconds: 345600,
      apiToken: 'queue-secret',
    })
    expect(parsed.apiToken).toBe('queue-secret')
    expect(parsed.retentionSeconds).toBe(345600)
    expect(() => trafficConnectCloudflareRequestSchema.parse({
      deliveryMode: 'queue-pull',
      queueId: 'queue_abc123',
      queueName: 'canonry-traffic-src-abc123',
      retentionSeconds: 345600,
      apiToken: 'queue-secret',
    })).toThrow()
  })

  it.each(['-leading', 'trailing-', 'contains space', '$(unsafe)', 'a'.repeat(64)])(
    'rejects the invalid Cloudflare Queue name %s',
    (queueName) => {
      expect(() => trafficConnectCloudflareRequestSchema.parse({
        deliveryMode: 'queue-pull',
        accountId: 'acct_xyz789',
        queueId: 'queueabc123',
        queueName,
        retentionSeconds: 345600,
        apiToken: 'queue-secret',
      })).toThrow()
    },
  )
})

describe('cloudflareTrafficDeliveryModeSchema', () => {
  it('defines direct push and Queue pull delivery modes', () => {
    expect(cloudflareTrafficDeliveryModeSchema.options).toEqual(['direct-push', 'queue-pull'])
  })

  it('rejects unknown delivery modes', () => {
    expect(() => cloudflareTrafficDeliveryModeSchema.parse('logpush')).toThrow()
  })
})

describe('trafficConnectCloudflareResponseSchema', () => {
  it('accepts a populated response', () => {
    const parsed = trafficConnectCloudflareResponseSchema.parse({
      sourceId: 'src_abc123',
      deliveryMode: 'direct-push',
      workerScript: 'addEventListener("fetch", () => {})',
      wranglerToml: 'name = "canonry-worker"',
      workerVersion: '1.0.0',
      instructions: 'Deploy to your zone',
    })
    expect(parsed.sourceId).toBe('src_abc123')
    expect(parsed.workerScript).toContain('fetch')
    expect(parsed.activationRequired).toBe(false)
  })

  it('returns queue metadata but strips the Queue API token', () => {
    const parsed = trafficConnectCloudflareResponseSchema.parse({
      sourceId: 'src_abc123',
      deliveryMode: 'queue-pull',
      workerScript: 'addEventListener("fetch", () => {})',
      wranglerToml: 'name = "canonry-worker"',
      workerVersion: '1.0.0',
      instructions: 'Deploy to your zone',
      activationRequired: false,
      accountId: 'acct_xyz789',
      queueId: 'queue_abc123',
      queueName: 'canonry-traffic-src-abc123',
      retentionSeconds: 345600,
      apiToken: 'must-not-return',
    })
    expect(parsed.activationRequired).toBe(false)
    expect(parsed.queueId).toBe('queue_abc123')
    expect(parsed).not.toHaveProperty('apiToken')
  })

  it('allows a staged direct-push response to require later activation', () => {
    const parsed = trafficConnectCloudflareResponseSchema.parse({
      sourceId: 'src_abc123',
      deliveryMode: 'direct-push',
      workerScript: 'addEventListener("fetch", () => {})',
      wranglerToml: 'name = "canonry-worker"',
      workerVersion: '1.0.0',
      instructions: 'Deploy to your zone',
      activationRequired: true,
    })
    expect(parsed.activationRequired).toBe(true)
  })

  it('rejects empty string for any required field', () => {
    expect(() => trafficConnectCloudflareResponseSchema.parse({
      sourceId: '',
      deliveryMode: 'direct-push',
      workerScript: 'x',
      wranglerToml: 'x',
      workerVersion: 'x',
      instructions: 'x',
    })).toThrow()
  })
})

describe('cloudflareWorkerEventSchema', () => {
  it('keeps the Worker event name as an exact compatibility alias', () => {
    expect(cloudflareWorkerEventSchema).toBe(cloudflareEdgeEventSchema)
  })

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

  it('rejects an invalid observation timestamp', () => {
    expect(() => cloudflareWorkerEventSchema.parse({
      eventId: 'ray-id',
      observedAt: 'not-a-timestamp',
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

  it('keeps the direct-push ingest name as an exact edge-batch compatibility alias', () => {
    expect(cloudflareWorkerIngestRequestSchema).toBe(cloudflareEdgeEventBatchSchema)
  })

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
