import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type NormalizedTrafficRequest,
  type TrafficVerificationManifest,
} from '@canonry/canonry-contracts'
import {
  assessAgentTrust,
  buildTrafficProbeReport,
  classifyAiUserFetch,
  extractAgentJourneyRequests,
  isScannerPath,
} from '../src/index.js'
import chatgptUserRanges from '../src/ip-ranges/chatgpt-user.json' with { type: 'json' }
import { firstPublishedIp } from './fixtures/vendored-ranges.js'

// Real user agents: OpenAI's published full string, a variant seen in logs
// that never verifies, and Claude-User (no published string).
const CHATGPT_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot'
const CHATGPT_ODD_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)'
const CLAUDE_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)'
const DAY_MS = 86_400_000

// Derived from the bundled list so a range refresh cannot break these tests.
const LIST_PUBLISHED_AT = Date.parse(chatgptUserRanges.creationTime)
const VERIFIED_IP = firstPublishedIp(chatgptUserRanges, 4)
// RFC 5737 documentation space: no publisher can list it.
const OUTSIDE_IP = '203.0.113.9'
const at = (offsetMs: number) => new Date(LIST_PUBLISHED_AT + offsetMs).toISOString()

function request(overrides: Partial<NormalizedTrafficRequest>): NormalizedTrafficRequest {
  return {
    sourceType: TrafficSourceTypes.cloudflare,
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId: overrides.eventId ?? crypto.randomUUID(),
    observedAt: overrides.observedAt ?? at(DAY_MS),
    method: 'GET',
    requestUrl: null,
    host: 'example.com',
    path: overrides.path ?? '/pricing',
    queryString: null,
    status: overrides.status ?? 200,
    userAgent: overrides.userAgent ?? CHATGPT_UA,
    remoteIp: overrides.remoteIp === undefined ? OUTSIDE_IP : overrides.remoteIp,
    referer: null,
    latencyMs: null,
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: { type: 'cloudflare_worker', labels: {} },
    providerLabels: {},
  }
}

const MANIFEST: TrafficVerificationManifest = { id: 'm', source: 'https://example.test/list.json', version: '2026-09-04T00:00:00Z' }
const documentedRule = { documentedUserAgents: [/^Exact-Agent\/1\.0$/] }
const undocumentedRule = {}
const assess = (input: Partial<Parameters<typeof assessAgentTrust>[0]>) => assessAgentTrust({
  rule: documentedRule,
  userAgent: 'Exact-Agent/1.0',
  path: '/pricing',
  verification: { verified: false, manifest: null },
  listPublished: true,
  ...input,
})

describe('isScannerPath', () => {
  it.each([
    '/.env', '/client/.env', '/.env.config', '/config/env/aws_credentials.env', '/prisma/.env',
    '/.git/config', '/.github/workflows/deploy.yml', '/.aws/credentials', '/.htpasswd',
    '/api/uploads/%2e%2e%2f%2e%2e%2f.env', '/api/orders/..%2fadmin/config.json', '/images../.env',
    '/static/%252e%252e/etc/passwd', '/../etc/passwd',
    '/wp-login.php', '/xmlrpc.php', '/wp-config.php.bak', '/phpmyadmin/index.php', '/cgi-bin/../../etc/passwd',
    '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php', '/.ENV?debug=1',
  ])('flags %s', path => {
    expect(isScannerPath(path)).toBe(true)
  })

  it.each([
    '/', '/pricing', '/products/air-tank', '/products/actuator', '/.well-known/ai-plugin.json',
    '/blog/environment-tips', '/env', '/robots.txt', '/booking/confirmation', '/assets/app.envelope.js',
    '/docs/v1.2/guide', '/search?q=..%2f', '/api/hear-about-us', '/cgi-bin/booking.cgi',
  ])('keeps %s', path => {
    expect(isScannerPath(path)).toBe(false)
  })
})

describe('assessAgentTrust', () => {
  it('trusts a published-list IP over every other signal', () => {
    expect(assess({ verification: { verified: true, manifest: MANIFEST }, path: '/.env', userAgent: 'Other/1.0' })).toEqual({
      trust: 'verified',
      trustReasons: ['scanner-path', 'unusual-user-agent', 'ip-in-published-list'],
    })
  })

  it('calls an unchecked request with the published user agent likely real', () => {
    expect(assess({})).toEqual({ trust: 'likely_real', trustReasons: ['no-ip', 'documented-user-agent'] })
    expect(assess({ listPublished: false })).toEqual({ trust: 'likely_real', trustReasons: ['no-published-list', 'documented-user-agent'] })
  })

  it('leaves an unchecked request unknown when the operator publishes no exact user agent', () => {
    expect(assess({ rule: undocumentedRule, userAgent: 'Anything/1.0' })).toEqual({ trust: 'unknown', trustReasons: ['no-ip'] })
    expect(assess({ rule: { documentedUserAgents: [] }, userAgent: 'Anything/1.0' })).toEqual({ trust: 'unknown', trustReasons: ['no-ip'] })
  })

  it('marks scanner paths and unusual user agents likely fake with every reason in display order', () => {
    expect(assess({ path: '/.git/HEAD' })).toEqual({ trust: 'likely_fake', trustReasons: ['scanner-path', 'no-ip', 'documented-user-agent'] })
    expect(assess({ userAgent: ' Exact-Agent/1.0 (copy)' })).toEqual({ trust: 'likely_fake', trustReasons: ['unusual-user-agent', 'no-ip'] })
  })

  it('never treats an IP missing from the published list as fake on its own', () => {
    // Lists lag real addresses and some operators publish rotating snapshots.
    const miss = { verification: { verified: false, manifest: MANIFEST } }
    expect(assess(miss)).toEqual({ trust: 'unknown', trustReasons: ['ip-outside-published-list', 'documented-user-agent'] })
    expect(assess({ ...miss, rule: undocumentedRule, userAgent: 'Anything/1.0' })).toEqual({ trust: 'unknown', trustReasons: ['ip-outside-published-list'] })
    // A checked miss is not "unchecked", so it never reads as likely real.
    expect(assess(miss).trust).not.toBe('likely_real')
    expect(assess({ ...miss, path: '/.env' })).toEqual({ trust: 'likely_fake', trustReasons: ['scanner-path', 'ip-outside-published-list', 'documented-user-agent'] })
  })
})

describe('classifyAiUserFetch trust', () => {
  it('verifies ChatGPT-User from a published IP and keeps the bundled list as evidence', () => {
    expect(classifyAiUserFetch(request({ remoteIp: VERIFIED_IP }))).toMatchObject({
      verificationStatus: 'verified', trust: 'verified', trustReasons: ['ip-in-published-list', 'documented-user-agent'],
    })
  })

  it('separates an IP miss, a missing IP and an unusual format', () => {
    // An IP miss reads the same whatever the list's date.
    for (const observedAt of [at(DAY_MS), at(90 * DAY_MS), at(-400 * DAY_MS)]) {
      expect(classifyAiUserFetch(request({ observedAt }))).toMatchObject({ trust: 'unknown', trustReasons: ['ip-outside-published-list', 'documented-user-agent'] })
    }
    expect(classifyAiUserFetch(request({ remoteIp: null }))).toMatchObject({ trust: 'likely_real', trustReasons: ['no-ip', 'documented-user-agent'] })
    expect(classifyAiUserFetch(request({ remoteIp: null, userAgent: CHATGPT_ODD_UA }))).toMatchObject({ trust: 'likely_fake', trustReasons: ['unusual-user-agent', 'no-ip'] })
    expect(classifyAiUserFetch(request({ remoteIp: null, userAgent: CLAUDE_UA }))).toMatchObject({ trust: 'unknown', trustReasons: ['no-ip'] })
  })
})

describe('per-request trust', () => {
  it('judges each request alone, so a probe never changes its client\'s other requests', () => {
    const probe = request({ eventId: 'probe', path: '/.env', userAgent: CLAUDE_UA })
    const sibling = request({ eventId: 'sibling', path: '/', userAgent: CLAUDE_UA })
    expect(classifyAiUserFetch(probe)).toMatchObject({ trust: 'likely_fake', trustReasons: ['scanner-path', 'ip-outside-published-list'] })
    expect(classifyAiUserFetch(sibling)).toMatchObject({ trust: 'unknown', trustReasons: ['ip-outside-published-list'] })
    // The same request reaches the same verdict alone or in any batch.
    const alone = extractAgentJourneyRequests([sibling])
    const batched = extractAgentJourneyRequests([probe, sibling])
    expect(batched).toEqual(alone)
    expect(buildTrafficProbeReport([probe, sibling]).totals).toMatchObject({ aiUserFetchHits: 1, aiUserFetchLikelyFakeHits: 1 })
  })

  it('keeps a verified client verified on any path and skips self-traffic', () => {
    expect(classifyAiUserFetch(request({ remoteIp: VERIFIED_IP, path: '/.env' }))?.trust).toBe('verified')
    expect(extractAgentJourneyRequests([request({ eventId: 'self', userAgent: `AINYC-AEO-Audit/1.0 ${CHATGPT_UA}` })])).toEqual([])
  })
})

describe('rollup and journey capture split', () => {
  const batch = [
    request({ eventId: 'verified', remoteIp: VERIFIED_IP, path: '/pricing' }),
    request({ eventId: 'real', remoteIp: null, path: '/pricing' }),
    request({ eventId: 'unknown', remoteIp: null, userAgent: CLAUDE_UA, path: '/pricing' }),
    request({ eventId: 'probe', remoteIp: null, path: '/.env', status: 404 }),
    request({ eventId: 'odd', remoteIp: null, userAgent: CHATGPT_ODD_UA, path: '/pricing' }),
    request({ eventId: 'ip-miss', path: '/pricing' }),
    request({ eventId: 'browser', userAgent: 'Mozilla/5.0 (Macintosh)', remoteIp: null }),
  ]

  it('keeps likely fake requests out of AI user fetch hits and counts them by first reason', () => {
    const report = buildTrafficProbeReport(batch)
    // Six agent requests: four counted as AI user fetches (the IP miss among
    // them), two likely fake.
    expect(report.totals.aiUserFetchHits).toBe(4)
    expect(report.totals.aiUserFetchLikelyFakeHits).toBe(2)
    expect(report.totals.unknownHits).toBe(1)
    expect(report.aiUserFetchEventsHourly.reduce((sum, bucket) => sum + bucket.hits, 0)).toBe(4)
    const hour = report.aiUserFetchEventsHourly[0]!.tsHour
    expect(report.aiUserFetchLikelyFakeHourly).toEqual([
      { tsHour: hour, botId: 'openai-chatgpt-user', operator: 'OpenAI', reason: 'scanner-path', hits: 1 },
      { tsHour: hour, botId: 'openai-chatgpt-user', operator: 'OpenAI', reason: 'unusual-user-agent', hits: 1 },
    ])
    expect(report.topAiUserFetchPaths).toEqual([{ pathNormalized: '/pricing', hits: 4 }])
    // Samples keep the classification so likely fakes stay reviewable.
    expect(report.samples.find(sample => sample.eventId === 'probe')?.aiUserFetch).toMatchObject({ trust: 'likely_fake', trustReasons: ['scanner-path', 'no-ip', 'documented-user-agent'] })
  })

  it('stores only non-fake agent requests for journeys, with their trust', () => {
    const rows = extractAgentJourneyRequests(batch)
    expect(rows.map(row => [row.sourceEventId, row.trust, row.trustReasons])).toEqual([
      ['verified', 'verified', ['ip-in-published-list', 'documented-user-agent']],
      ['real', 'likely_real', ['no-ip', 'documented-user-agent']],
      ['unknown', 'unknown', ['no-ip']],
      ['ip-miss', 'unknown', ['ip-outside-published-list', 'documented-user-agent']],
    ])
  })
})
