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

  it('classifies the LLM crawlers added 2026-05-18 after live-traffic miss', () => {
    // Regression coverage for the canonry.ai/canonry-landing flat-chart
    // incident. Each of these UAs hit the site between 5/16 and 5/18 but
    // landed in the `unknown` bucket because the rule list hadn't been
    // updated. The chart correctly reported 0 crawler hits — that was the
    // problem.
    //
    // For each case, the assertion is "classifier returned a result"
    // (toBeTruthy on a `ClassifiedCrawler | null`) plus the expected
    // operator. botId is asserted where the spelling is stable.

    // Anthropic Claude-SearchBot (new variant — older rule only caught
    // ClaudeBot/ and Claude-Web/).
    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +searchbot@anthropic.com)',
    }))).toMatchObject({
      botId: 'anthropic-claudebot',
      operator: 'Anthropic',
    })

    // Permissive variant — any future Claude-*Bot Anthropic introduces.
    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; Claude-IndexBot/2.0)',
    }))).toMatchObject({
      operator: 'Anthropic',
    })

    // Mistral's general crawler (rule pattern was /MistralAI/i which
    // doesn't match MistralBot).
    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; MistralBot/1.0; +https://mistral.ai)',
    }))).toMatchObject({
      botId: 'mistral-ai',
      operator: 'Mistral AI',
    })

    // DeepSeek wasn't in the list at all.
    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; DeepSeekBot/1.0; +https://www.deepseek.com/bot)',
    }))).toMatchObject({
      botId: 'deepseek',
      operator: 'DeepSeek',
    })

    // Apple's general crawler (rule was Applebot-Extended only).
    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)',
    }))).toMatchObject({
      botId: 'applebot',
      operator: 'Apple',
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

  it('classifies AI referrals from utm_source carried in the referer URL (cache-bypass asset hits)', () => {
    // Edge-cached HTML hit doesn't reach origin; the JS chunk request does,
    // and its referer is the landing page URL with utm_source preserved.
    expect(classifyAiReferral(event({
      requestUrl: 'https://example.com/_next/static/chunks/app/page-abc.js',
      path: '/_next/static/chunks/app/page-abc.js',
      queryString: null,
      referer: 'https://example.com/blog/post?utm_source=chatgpt.com',
    }))).toMatchObject({
      product: 'ChatGPT',
      operator: 'OpenAI',
      evidenceType: 'referer-utm',
      sourceDomain: 'chatgpt.com',
    })

    // claude.ai via referer UTM, with extra query params, mixed case
    expect(classifyAiReferral(event({
      queryString: null,
      referer: 'https://example.com/landing?foo=bar&utm_source=Claude.ai&utm_medium=referral',
    }))).toMatchObject({
      product: 'Claude',
      operator: 'Anthropic',
      evidenceType: 'referer-utm',
      sourceDomain: 'claude.ai',
    })
  })

  it('prefers referer-host evidence over UTM when both are present', () => {
    // Direct citation click: chatgpt.com referer + utm_source on the request URL.
    // Should classify as 'referer' (most authoritative), not 'utm'.
    const result = classifyAiReferral(event({
      requestUrl: 'https://example.com/foo?utm_source=chatgpt.com',
      queryString: 'utm_source=chatgpt.com',
      referer: 'https://chatgpt.com/c/abc',
    }))
    expect(result?.evidenceType).toBe('referer')
  })

  it('prefers request-URL UTM over referer-URL UTM when both are present', () => {
    // The two UTM signals would normally agree, but when they don't we trust
    // the request URL (closer to the landing event) over the referer URL.
    const result = classifyAiReferral(event({
      requestUrl: 'https://example.com/foo?utm_source=chatgpt.com',
      queryString: 'utm_source=chatgpt.com',
      referer: 'https://example.com/other?utm_source=perplexity.ai',
    }))
    expect(result).toMatchObject({ sourceDomain: 'chatgpt.com', evidenceType: 'utm' })
  })

  it('returns null when referer UTM points at a non-AI source', () => {
    expect(classifyAiReferral(event({
      queryString: null,
      referer: 'https://example.com/landing?utm_source=newsletter',
    }))).toBeNull()
  })

  it('rolls referer-utm referrals into hourly buckets', () => {
    const report = buildTrafficProbeReport([
      event({
        eventId: 'asset-1',
        observedAt: '2026-05-01T13:05:00.000Z',
        requestUrl: 'https://example.com/_next/static/chunks/page.js',
        path: '/_next/static/chunks/page.js',
        userAgent: 'Mozilla/5.0',
        referer: 'https://example.com/blog/post?utm_source=chatgpt.com',
      }),
    ], { generatedAt: '2026-05-01T14:00:00.000Z' })

    expect(report.totals.aiReferralHits).toBe(1)
    expect(report.totals.aiReferralSessions).toBe(1)
    expect(report.aiReferralEventsHourly).toEqual([
      expect.objectContaining({
        product: 'ChatGPT',
        sourceDomain: 'chatgpt.com',
        evidenceType: 'referer-utm',
        landingPathNormalized: '/blog/post',
        hits: 1,
      }),
    ])
  })

  it('sessionizes AI referral sub-resource bursts into landing-page sessions', () => {
    const report = buildTrafficProbeReport([
      event({
        eventId: 'page-1',
        observedAt: '2026-05-01T13:05:00.000Z',
        requestUrl: 'https://example.com/blog/post?utm_source=chatgpt.com',
        path: '/blog/post',
        queryString: 'utm_source=chatgpt.com',
        userAgent: 'Mozilla/5.0',
        remoteIp: '203.0.113.10',
      }),
      event({
        eventId: 'asset-1',
        observedAt: '2026-05-01T13:05:05.000Z',
        requestUrl: 'https://example.com/_next/static/chunks/page.js',
        path: '/_next/static/chunks/page.js',
        queryString: null,
        userAgent: 'Mozilla/5.0',
        remoteIp: '203.0.113.10',
        referer: 'https://example.com/blog/post?utm_source=chatgpt.com',
      }),
      event({
        eventId: 'asset-2',
        observedAt: '2026-05-01T13:05:10.000Z',
        requestUrl: 'https://example.com/favicon.svg',
        path: '/favicon.svg',
        queryString: null,
        userAgent: 'Mozilla/5.0',
        remoteIp: '203.0.113.10',
        referer: 'https://example.com/blog/post?utm_source=chatgpt.com',
      }),
      event({
        eventId: 'asset-only-1',
        observedAt: '2026-05-01T13:05:15.000Z',
        requestUrl: 'https://example.com/_next/static/chunks/app.js',
        path: '/_next/static/chunks/app.js',
        queryString: null,
        userAgent: 'Mozilla/5.0',
        remoteIp: '198.51.100.22',
        referer: 'https://example.com/open-source?utm_source=chatgpt.com',
      }),
      event({
        eventId: 'asset-only-2',
        observedAt: '2026-05-01T13:05:20.000Z',
        requestUrl: 'https://example.com/_next/static/css/app.css',
        path: '/_next/static/css/app.css',
        queryString: null,
        userAgent: 'Mozilla/5.0',
        remoteIp: '198.51.100.22',
        referer: 'https://example.com/open-source?utm_source=chatgpt.com',
      }),
    ], { generatedAt: '2026-05-01T14:00:00.000Z' })

    expect(report.totals.aiReferralHits).toBe(5)
    expect(report.totals.aiReferralSessions).toBe(2)
    expect(report.aiReferralEventsHourly).toEqual([
      expect.objectContaining({
        evidenceType: 'utm',
        landingPathNormalized: '/blog/post',
        hits: 1,
      }),
      expect.objectContaining({
        evidenceType: 'referer-utm',
        landingPathNormalized: '/open-source',
        hits: 1,
      }),
    ])
    expect(report.topAiReferralLandingPaths).toEqual([
      { landingPathNormalized: '/blog/post', hits: 1 },
      { landingPathNormalized: '/open-source', hits: 1 },
    ])
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

  it('matches short-form utm_source tokens against the rule domain first label', () => {
    // Real sites frequently emit `utm_source=chatgpt` instead of the
    // fully-qualified `chatgpt.com`. Both should classify identically.
    expect(classifyAiReferral(event({
      referer: null,
      queryString: 'utm_source=chatgpt',
    }))).toMatchObject({ product: 'ChatGPT', evidenceType: 'utm' })
    expect(classifyAiReferral(event({
      referer: null,
      queryString: 'utm_source=perplexity',
    }))).toMatchObject({ product: 'Perplexity', evidenceType: 'utm' })
    expect(classifyAiReferral(event({
      referer: null,
      queryString: 'utm_source=claude',
    }))).toMatchObject({ product: 'Claude', evidenceType: 'utm' })
    // Non-rule short tokens stay unmatched.
    expect(classifyAiReferral(event({
      referer: null,
      queryString: 'utm_source=newsletter',
    }))).toBeNull()
  })

  it('keeps the newest sampleLimit events instead of the oldest', () => {
    // Pulls run timestamp-asc — a FIFO cap would surface only the oldest
    // events in the window, the least useful slice for classifier debugging.
    const events = Array.from({ length: 5 }, (_, i) => event({
      eventId: `e-${i}`,
      observedAt: `2026-05-01T12:0${i}:00.000Z`,
      path: `/p${i}`,
    }))
    const report = buildTrafficProbeReport(events, { sampleLimit: 2 })
    expect(report.samples.map((s) => s.eventId)).toEqual(['e-3', 'e-4'])
  })
})
