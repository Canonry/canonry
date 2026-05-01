import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type NormalizedTrafficRequest,
} from '@ainyc/canonry-contracts'
import { describe, expect, it } from 'vitest'
import {
  buildTrafficProbeReport,
  classifyAiReferral,
  classifyCrawler,
  normalizeTrafficPathPattern,
} from '../src/index.js'

function event(overrides: Partial<NormalizedTrafficRequest>): NormalizedTrafficRequest {
  return {
    sourceType: TrafficSourceTypes['cloud-run'],
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId: overrides.eventId ?? crypto.randomUUID(),
    observedAt: overrides.observedAt ?? '2026-05-01T12:30:00.000Z',
    method: overrides.method ?? 'GET',
    requestUrl: overrides.requestUrl ?? 'https://example.com/',
    host: overrides.host ?? 'example.com',
    path: overrides.path ?? '/',
    queryString: overrides.queryString ?? null,
    status: overrides.status ?? 200,
    userAgent: overrides.userAgent ?? 'Mozilla/5.0',
    remoteIp: overrides.remoteIp ?? '203.0.113.10',
    referer: overrides.referer ?? null,
    latencyMs: overrides.latencyMs ?? null,
    requestSizeBytes: overrides.requestSizeBytes ?? null,
    responseSizeBytes: overrides.responseSizeBytes ?? null,
    providerResource: overrides.providerResource ?? { type: 'cloud_run_revision', labels: {} },
    providerLabels: overrides.providerLabels ?? {},
  }
}

describe('traffic analysis', () => {
  it('classifies known AI crawler user agents', () => {
    expect(classifyCrawler(event({ userAgent: 'Mozilla/5.0 GPTBot/1.2' }))).toMatchObject({
      botId: 'openai-gptbot',
      operator: 'OpenAI',
      verificationStatus: 'claimed_unverified',
    })
  })

  it('classifies explicit AI referrals from referer and UTM evidence', () => {
    expect(classifyAiReferral(event({ referer: 'https://chatgpt.com/c/abc' }))).toMatchObject({
      product: 'ChatGPT',
      operator: 'OpenAI',
      evidenceType: 'referer',
      sourceDomain: 'chatgpt.com',
    })

    expect(classifyAiReferral(event({
      referer: null,
      queryString: 'utm_source=perplexity.ai&utm_medium=referral',
    }))).toMatchObject({
      product: 'Perplexity',
      operator: 'Perplexity',
      evidenceType: 'utm',
      sourceDomain: 'perplexity.ai',
    })
  })

  it('normalizes high-cardinality path IDs without rewriting ordinary slugs', () => {
    expect(normalizeTrafficPathPattern('/blog/how-to-rank-in-ai')).toBe('/blog/how-to-rank-in-ai')
    expect(normalizeTrafficPathPattern('/products/12345/reviews')).toBe('/products/:id/reviews')
    expect(normalizeTrafficPathPattern('/orders/018f6ff2-34ab-7c12-a5c0-9c8a8f2d1111')).toBe('/orders/:id')
  })

  it('rolls normalized events into crawler and AI-referral buckets', () => {
    const report = buildTrafficProbeReport([
      event({
        eventId: 'crawler-1',
        observedAt: '2026-05-01T12:10:00.000Z',
        path: '/blog/post-1',
        userAgent: 'GPTBot/1.2',
      }),
      event({
        eventId: 'crawler-2',
        observedAt: '2026-05-01T12:15:00.000Z',
        path: '/blog/post-1',
        userAgent: 'GPTBot/1.2',
      }),
      event({
        eventId: 'referral-1',
        observedAt: '2026-05-01T13:05:00.000Z',
        path: '/pricing',
        userAgent: 'Mozilla/5.0',
        referer: 'https://claude.ai/chat',
      }),
    ], { generatedAt: '2026-05-01T14:00:00.000Z' })

    expect(report.totals).toMatchObject({
      normalizedEvents: 3,
      crawlerHits: 2,
      aiReferralHits: 1,
      unknownHits: 0,
    })
    expect(report.crawlerEventsHourly).toEqual([
      expect.objectContaining({
        tsHour: '2026-05-01T12:00:00.000Z',
        botId: 'openai-gptbot',
        pathNormalized: '/blog/post-1',
        hits: 2,
      }),
    ])
    expect(report.aiReferralEventsHourly).toEqual([
      expect.objectContaining({
        tsHour: '2026-05-01T13:00:00.000Z',
        product: 'Claude',
        landingPathNormalized: '/pricing',
        hits: 1,
      }),
    ])
    expect(report.topBots[0]).toEqual({ botId: 'openai-gptbot', operator: 'OpenAI', hits: 2 })
    expect(report.topAiReferrers[0]).toEqual({ sourceDomain: 'claude.ai', product: 'Claude', hits: 1 })
  })
})
