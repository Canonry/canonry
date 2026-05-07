import { describe, expect, it } from 'vitest'
import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  normalizedTrafficRequestSchema,
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
