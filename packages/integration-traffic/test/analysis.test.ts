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
  classifyAiUserFetch,
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

  it('promotes to `verified` when the source IP is in the operator\'s published range', () => {
    // 66.249.64.1 is in Googlebot's published 66.249.64.0/19 — bundled
    // in `src/ip-ranges/googlebot.json`. UA match + IP match should
    // upgrade `claimed_unverified` → `verified`.
    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      remoteIp: '66.249.64.1',
    }))).toMatchObject({
      botId: 'googlebot',
      verificationStatus: 'verified',
    })
  })

  it('stays `claimed_unverified` when the source IP is outside the operator\'s range', () => {
    // UA claims Googlebot but the IP is private RFC1918 space — almost
    // certainly a spoofer (or a local test). The dashboard's separate
    // `verified` vs `claimed_unverified` buckets surface this.
    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      remoteIp: '10.0.0.1',
    }))).toMatchObject({
      botId: 'googlebot',
      verificationStatus: 'claimed_unverified',
    })
  })

  it('promotes ClaudeBot to `verified` when the IP is in Anthropic\'s AWS-allocated crawler prefix', () => {
    // 216.73.216.0/22 is the AWS-ANTHROPIC ARIN allocation —
    // empirical Cloud Run logs (canonry-landing 5/2026) show every
    // real ClaudeBot request comes from here.
    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
      remoteIp: '216.73.216.76',
    }))).toMatchObject({
      botId: 'anthropic-claudebot',
      verificationStatus: 'verified',
    })
  })

  it('stays `claimed_unverified` for ClaudeBot UA from an IP outside Anthropic ranges (probable spoof)', () => {
    // Same UA from an AWS IP — this is the case the verification gate
    // exists to catch. UA is matched (so we know it claims to be
    // ClaudeBot), but the source IP isn't in Anthropic's published
    // ranges, so we stay unverified rather than promote.
    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
      remoteIp: '52.5.1.1',
    }))).toMatchObject({
      botId: 'anthropic-claudebot',
      verificationStatus: 'claimed_unverified',
    })
  })

  it('stays `claimed_unverified` for operators without published IP ranges (e.g. Meta)', () => {
    // Meta doesn't publish a ranges file. Every meta-externalagent hit
    // is unverified regardless of source IP. Correct behavior: we have
    // no data to check against, so we don't claim verification.
    expect(classifyCrawler(event({
      userAgent: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
      remoteIp: '52.5.1.1',
    }))).toMatchObject({
      botId: 'meta-externalagent',
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

    // Mistral's general crawler — disjoint from MistralAI-User (per-user
    // fetch) which routes through classifyAiUserFetch.
    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; MistralBot/1.0; +https://mistral.ai)',
    }))).toMatchObject({
      botId: 'mistral-bot',
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

  it('classifies xAI Grok as a crawler (xAI-Bot / Grok-Bot UAs)', () => {
    // xAI ships at least one documented crawler UA at https://x.ai/bots/.
    // We use a permissive pattern (`xAI` family + `Grok-Bot` variant)
    // because xAI has been less consistent than OpenAI/Anthropic about
    // documenting every UA they ship — better to over-match the operator
    // family than miss real hits and leave them in the `unknown` bucket.
    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; xAI-Bot/1.0; +https://x.ai/bots/)',
    }))).toMatchObject({
      botId: 'xai-grok-bot',
      operator: 'xAI',
    })

    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; Grok-Bot/1.0; +https://x.ai)',
    }))).toMatchObject({
      botId: 'xai-grok-bot',
      operator: 'xAI',
    })
  })

  it('classifies grok.com referer as an AI referral from Grok', () => {
    expect(classifyAiReferral(event({ referer: 'https://grok.com/chat/abc' }))).toMatchObject({
      product: 'Grok',
      operator: 'xAI',
      evidenceType: 'referer',
      sourceDomain: 'grok.com',
    })

    // utm_source=grok short token must also resolve to the rule (first
    // label of grok.com).
    expect(classifyAiReferral(event({
      referer: null,
      queryString: 'utm_source=grok',
    }))).toMatchObject({
      product: 'Grok',
      operator: 'xAI',
      evidenceType: 'utm',
    })
  })

  it('classifies classic search-engine crawlers (Google/Bing/DuckDuckGo/Yandex/Baidu/Amazon)', () => {
    // Tracked alongside LLM crawlers because SERP indexing is the
    // upstream that feeds AI answer engines (Bing → ChatGPT search,
    // Google → Gemini grounding). Operator wants the full machine-
    // traffic signal, not just the AI-training subset.

    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    }))).toMatchObject({ botId: 'googlebot', operator: 'Google' })

    // Googlebot-Smartphone variant — same prefix.
    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    }))).toMatchObject({ botId: 'googlebot', operator: 'Google' })

    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    }))).toMatchObject({ botId: 'bingbot', operator: 'Microsoft' })

    expect(classifyCrawler(event({
      userAgent: 'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
    }))).toMatchObject({ botId: 'duckduckbot', operator: 'DuckDuckGo' })

    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
    }))).toMatchObject({ botId: 'yandexbot', operator: 'Yandex' })

    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
    }))).toMatchObject({ botId: 'baiduspider', operator: 'Baidu' })

    expect(classifyCrawler(event({
      userAgent: 'Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)',
    }))).toMatchObject({ botId: 'amazonbot', operator: 'Amazon' })
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

  it('routes ChatGPT-User to ai-user-fetch, not crawler', () => {
    // ChatGPT-User UA represents a per-user on-demand fetch (citation click,
    // user-asked URL read) — NOT bulk crawl. It's published by OpenAI as a
    // distinct UA from GPTBot/OAI-SearchBot precisely so operators can split
    // these two signals. classifyCrawler must return null so the same event
    // doesn't get double-counted into both buckets.
    const evt = event({ userAgent: 'Mozilla/5.0 ChatGPT-User/1.0' })
    expect(classifyCrawler(evt)).toBeNull()
    expect(classifyAiUserFetch(evt)).toMatchObject({
      botId: 'openai-chatgpt-user',
      operator: 'OpenAI',
      product: 'ChatGPT-User',
      verificationStatus: 'claimed_unverified',
    })
  })

  it('routes Perplexity-User to ai-user-fetch, not crawler', () => {
    const evt = event({ userAgent: 'Mozilla/5.0 Perplexity-User/1.0' })
    expect(classifyCrawler(evt)).toBeNull()
    expect(classifyAiUserFetch(evt)).toMatchObject({
      botId: 'perplexity-user',
      operator: 'Perplexity',
      product: 'Perplexity-User',
      verificationStatus: 'claimed_unverified',
    })
  })

  it('promotes ChatGPT-User to `verified` when the source IP is in OpenAI\'s published range', () => {
    // 104.210.139.193 is in 104.210.139.192/28 — first published prefix in
    // `src/ip-ranges/chatgpt-user.json`. UA match + IP match should upgrade
    // `claimed_unverified` → `verified`.
    expect(classifyAiUserFetch(event({
      userAgent: 'Mozilla/5.0 ChatGPT-User/1.0',
      remoteIp: '104.210.139.193',
    }))).toMatchObject({
      botId: 'openai-chatgpt-user',
      verificationStatus: 'verified',
    })
  })

  it('classifyAiUserFetch returns null for bulk crawler UAs', () => {
    // Inverse of the routing rule: classifyAiUserFetch only matches the
    // `purpose: 'user-agent'` rules; GPTBot, OAI-SearchBot, etc. stay in
    // classifyCrawler's domain.
    expect(classifyAiUserFetch(event({ userAgent: 'GPTBot/1.0' }))).toBeNull()
    expect(classifyAiUserFetch(event({
      userAgent: 'Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)',
    }))).toBeNull()
    // ClaudeBot is the training crawler — the `claude-user` rule's
    // `/Claude-User\//i` pattern must not swallow it.
    expect(classifyAiUserFetch(event({
      userAgent: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    }))).toBeNull()
  })

  it('routes MistralAI-User to ai-user-fetch and MistralBot to crawler (disjoint)', () => {
    // The legacy `mistral-ai` rule collapsed both UAs under one id with
    // purpose='crawl', miscategorizing MistralAI-User as bulk crawl. The
    // split rule pair (`mistral-ai-user` / `mistral-bot`) keeps the two
    // operational signals disjoint, mirroring OpenAI's GPTBot vs.
    // ChatGPT-User split.
    const userEvent = event({ userAgent: 'Mozilla/5.0 MistralAI-User/1.0' })
    expect(classifyCrawler(userEvent)).toBeNull()
    expect(classifyAiUserFetch(userEvent)).toMatchObject({
      botId: 'mistral-ai-user',
      operator: 'Mistral AI',
      product: 'MistralAI-User',
    })

    const botEvent = event({
      userAgent: 'Mozilla/5.0 (compatible; MistralBot/1.0; +https://mistral.ai)',
    })
    expect(classifyAiUserFetch(botEvent)).toBeNull()
    expect(classifyCrawler(botEvent)).toMatchObject({
      botId: 'mistral-bot',
      operator: 'Mistral AI',
      product: 'MistralBot',
    })
  })

  it('routes Claude-User to ai-user-fetch, not crawler', () => {
    // Anthropic's on-behalf-of-user fetcher. The `anthropic-claudebot`
    // crawler rule does not match `Claude-User/` (its `Claude-[A-Z]+Bot/`
    // pattern needs a `Bot/` suffix), so before the `claude-user` rule
    // this UA fell through to the `unknown` bucket entirely.
    const evt = event({ userAgent: 'Mozilla/5.0 (compatible; Claude-User/1.0; +Anthropic)' })
    expect(classifyCrawler(evt)).toBeNull()
    expect(classifyAiUserFetch(evt)).toMatchObject({
      botId: 'claude-user',
      operator: 'Anthropic',
      product: 'Claude-User',
      verificationStatus: 'claimed_unverified',
    })
  })

  it('promotes Claude-User to `verified` when the source IP is in Anthropic\'s range', () => {
    // 216.73.216.0/22 is the AWS-ANTHROPIC ARIN allocation; the bundled
    // anthropic.json verifies both ClaudeBot and Claude-User.
    expect(classifyAiUserFetch(event({
      userAgent: 'Mozilla/5.0 (compatible; Claude-User/1.0; +Anthropic)',
      remoteIp: '216.73.216.76',
    }))).toMatchObject({
      botId: 'claude-user',
      verificationStatus: 'verified',
    })
  })

  it('rolls ChatGPT-User hits into the ai-user-fetch bucket, not crawler', () => {
    // End-to-end: the rollup must keep user-fetch hits and bulk-crawl hits
    // in disjoint buckets. Counting ChatGPT-User into `crawlerHits` is the
    // bug this whole change is built to fix.
    const report = buildTrafficProbeReport([
      event({
        eventId: 'cu-1',
        observedAt: '2026-05-01T13:05:00.000Z',
        path: '/blog/post-1',
        userAgent: 'Mozilla/5.0 ChatGPT-User/1.0',
      }),
      event({
        eventId: 'cu-2',
        observedAt: '2026-05-01T13:10:00.000Z',
        path: '/blog/post-1',
        userAgent: 'Mozilla/5.0 ChatGPT-User/1.0',
      }),
      event({
        eventId: 'gpt-1',
        observedAt: '2026-05-01T13:15:00.000Z',
        path: '/blog/post-1',
        userAgent: 'GPTBot/1.0',
      }),
    ], { generatedAt: '2026-05-01T14:00:00.000Z' })

    expect(report.totals.crawlerHits).toBe(1)
    expect(report.totals.aiUserFetchHits).toBe(2)
    expect(report.crawlerEventsHourly).toEqual([
      expect.objectContaining({
        botId: 'openai-gptbot',
        pathNormalized: '/blog/post-1',
        hits: 1,
      }),
    ])
    expect(report.aiUserFetchEventsHourly).toEqual([
      expect.objectContaining({
        tsHour: '2026-05-01T13:00:00.000Z',
        botId: 'openai-chatgpt-user',
        operator: 'OpenAI',
        product: 'ChatGPT-User',
        pathNormalized: '/blog/post-1',
        hits: 2,
      }),
    ])
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
