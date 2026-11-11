import { describe, expect, it } from 'vitest'
import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type NormalizedTrafficRequest,
} from '@canonry/canonry-contracts'
import { buildTrafficProbeReport, classifyAiUserFetch, extractAgentJourneyRequests } from '../src/index.js'

// The operators' published user agents for their hosted browsers, and
// Claude-User, a link fetcher, as the control.
// https://support.claude.com/en/articles/18234133-how-do-anthropic-hosted-browsers-identify-themselves-when-they-browse-the-web-on-a-user-s-behalf
const CLAUDE_AGENT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-Agent/1.0) Chrome/154.0.0.0 Safari/537.36'
// https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent
const GOOGLE_AGENT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent) Chrome/W.X.Y.Z Safari/537.36'
const CLAUDE_USER_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)'
// RFC 5737 documentation space: in no operator's published list.
const UNLISTED_IP = '203.0.113.40'

const BROWSER_AGENTS = [
  { botId: 'claude-agent', operator: 'Anthropic', userAgent: CLAUDE_AGENT_UA },
  { botId: 'google-agent', operator: 'Google', userAgent: GOOGLE_AGENT_UA },
] as const

type Kind = 'page' | 'action' | 'resource'

/**
 * What a hosted browser sends while it reads pages for a person, across the
 * site stacks Canonry's sources see: a page load brings the page's own files,
 * data calls, prefetches and beacons. Each request names what it was.
 */
const BROWSER_REQUESTS: ReadonlyArray<{ id: string, method: string | null, path: string, queryString?: string, kind: Kind }> = [
  { id: 'page', method: 'GET', path: '/pricing', kind: 'page' },
  { id: 'script', method: 'GET', path: '/_next/static/chunks/app/pricing/page-4f1c2a9d.js', kind: 'resource' },
  { id: 'style', method: 'GET', path: '/_next/static/css/9a8b7c6d.css', kind: 'resource' },
  { id: 'image-optimizer', method: 'GET', path: '/_next/image', queryString: 'url=%2Fhero.png&w=1080&q=75', kind: 'resource' },
  { id: 'nuxt-image', method: 'GET', path: '/_ipx/w_640/hero.jpg', kind: 'resource' },
  { id: 'favicon', method: 'GET', path: '/favicon.ico', kind: 'resource' },
  { id: 'manifest', method: 'GET', path: '/site.webmanifest', kind: 'resource' },
  { id: 'prefetch', method: 'GET', path: '/about', queryString: '_rsc=1ld0r', kind: 'resource' },
  { id: 'vercel-beacon', method: 'POST', path: '/_vercel/insights/view', kind: 'resource' },
  { id: 'cloudflare-beacon', method: 'POST', path: '/cdn-cgi/rum', kind: 'resource' },
  { id: 'api-call', method: 'GET', path: '/api/plans', kind: 'resource' },
  { id: 'json', method: 'GET', path: '/collections/all/products.json', kind: 'resource' },
  { id: 'route-data', method: 'GET', path: '/pricing.data', kind: 'resource' },
  { id: 'wordpress-ajax', method: 'POST', path: '/wp-admin/admin-ajax.php', kind: 'resource' },
  { id: 'woocommerce-ajax', method: 'POST', path: '/', queryString: 'wc-ajax=get_refreshed_fragments', kind: 'resource' },
  { id: 'azure-user', method: 'GET', path: '/.auth/me', kind: 'resource' },
  { id: 'netlify-identity', method: 'GET', path: '/.netlify/identity/user', kind: 'resource' },
  { id: 'head', method: 'HEAD', path: '/pricing', kind: 'resource' },
  { id: 'preflight', method: 'OPTIONS', path: '/contact', kind: 'resource' },
  { id: 'form-post', method: 'POST', path: '/contact', kind: 'action' },
  { id: 'next-page', method: 'GET', path: '/contact', queryString: 'sent=1', kind: 'page' },
  { id: 'document', method: 'GET', path: '/menu.pdf', kind: 'page' },
  { id: 'no-method', method: null, path: '/locations/', kind: 'page' },
]
const ofKind = (kind: Kind) => BROWSER_REQUESTS.filter(request => request.kind === kind)

function request(overrides: Partial<NormalizedTrafficRequest>): NormalizedTrafficRequest {
  return {
    sourceType: TrafficSourceTypes.vercel,
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId: 'request',
    observedAt: '2026-11-11T10:00:00.000Z',
    method: 'GET',
    requestUrl: null,
    host: 'example.com',
    path: '/',
    queryString: null,
    status: 200,
    userAgent: CLAUDE_AGENT_UA,
    remoteIp: UNLISTED_IP,
    referer: null,
    latencyMs: null,
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: { type: null, labels: {} },
    providerLabels: {},
    ...overrides,
  }
}

function session(userAgent: string, overrides: Partial<NormalizedTrafficRequest> = {}): NormalizedTrafficRequest[] {
  return BROWSER_REQUESTS.map((row, index) => request({
    eventId: row.id,
    observedAt: new Date(Date.parse('2026-11-11T10:00:00.000Z') + index * 1000).toISOString(),
    method: row.method,
    path: row.path,
    queryString: row.queryString ?? null,
    userAgent,
    ...overrides,
  }))
}

describe.each(BROWSER_AGENTS)('$botId, a hosted browser', ({ botId, operator, userAgent }) => {
  it('counts only its page loads as AI user fetches; the rest is counted apart', () => {
    const report = buildTrafficProbeReport(session(userAgent))
    const pages = ofKind('page')

    expect(report.totals.aiUserFetchHits).toBe(4)
    expect(report.totals.aiUserFetchBrowserNonPageHits).toBe(19)
    expect(report.totals).toMatchObject({ aiUserFetchLikelyFakeHits: 0, unknownHits: 0, crawlerHits: 0 })
    // Every request lands in exactly one count.
    expect(report.totals.aiUserFetchHits + report.totals.aiUserFetchBrowserNonPageHits + report.totals.aiUserFetchLikelyFakeHits)
      .toBe(BROWSER_REQUESTS.length)
    expect(pages).toHaveLength(report.totals.aiUserFetchHits)
    expect(report.aiUserFetchEventsHourly.map(bucket => [bucket.botId, bucket.pathNormalized, bucket.hits])).toEqual([
      [botId, '/contact', 1],
      [botId, '/locations/', 1],
      [botId, '/menu.pdf', 1],
      [botId, '/pricing', 1],
    ])
    expect(report.topAiUserFetchBots).toEqual([{ botId, operator, hits: 4 }])
  })

  it('keeps the requests it made in its journey: page loads and form posts, in order', () => {
    const rows = extractAgentJourneyRequests(session(userAgent))

    expect(rows.map(row => row.sourceEventId)).toEqual(['page', 'form-post', 'next-page', 'document', 'no-method'])
    expect(rows.map(row => [row.method, row.path])).toEqual([
      ['GET', '/pricing'], ['POST', '/contact'], ['GET', '/contact'], ['GET', '/menu.pdf'], [null, '/locations/'],
    ])
    expect(new Set(rows.map(row => row.agentId))).toEqual(new Set([botId]))
  })

  it('reads the app files its pages load as page files, not scanner probes, so its session stays countable', () => {
    // A Blazor app on Azure, from an IP missing from the published list: the
    // page's settings files and sign-in check would each be a probe from a
    // link fetcher, and one probe marks every request from that IP for ten minutes.
    const blazor = [
      request({ eventId: 'page', path: '/', userAgent }),
      request({ eventId: 'settings', path: '/appsettings.json', userAgent }),
      request({ eventId: 'environment-settings', path: '/appsettings.Production.json', userAgent }),
      request({ eventId: 'runtime-settings', path: '/env.js', userAgent }),
      request({ eventId: 'signed-in', path: '/.auth/me', userAgent }),
      request({ eventId: 'sign-in', path: '/.auth/login/aad', userAgent, status: 302 }),
    ]
    expect(blazor.map(event => classifyAiUserFetch(event)?.trust)).toEqual(Array(6).fill('unknown'))

    const report = buildTrafficProbeReport(blazor)
    expect(report.totals).toMatchObject({ aiUserFetchHits: 2, aiUserFetchBrowserNonPageHits: 4, aiUserFetchLikelyFakeHits: 0 })
    expect(extractAgentJourneyRequests(blazor).map(row => row.sourceEventId)).toEqual(['page', 'sign-in'])
  })

  it('still marks a scanner claiming to be it likely fake, its whole burst included', () => {
    const scan = [
      request({ eventId: 'probe', path: '/.env', userAgent, status: 404 }),
      request({ eventId: 'git', path: '/.git/config', userAgent, status: 404 }),
      request({ eventId: 'sign-in-probe', path: '/wp-login.php', userAgent, status: 404 }),
      request({ eventId: 'page', path: '/', userAgent, observedAt: '2026-11-11T10:05:00.000Z' }),
      request({ eventId: 'script', path: '/app.js', userAgent, observedAt: '2026-11-11T10:05:01.000Z' }),
    ]
    expect(classifyAiUserFetch(scan[2]!)).toMatchObject({ trust: 'likely_fake', trustReasons: ['scanner-path', 'ip-outside-published-list'] })

    const report = buildTrafficProbeReport(scan)
    expect(report.totals).toMatchObject({ aiUserFetchHits: 0, aiUserFetchBrowserNonPageHits: 0, aiUserFetchLikelyFakeHits: 5 })
    expect(report.aiUserFetchLikelyFakeHourly.map(bucket => [bucket.reason, bucket.hits])).toEqual([['scanner-burst', 2], ['scanner-path', 3]])
    expect(extractAgentJourneyRequests(scan)).toEqual([])
  })
})

describe('Claude-User, a link fetcher', () => {
  it('still counts every request it makes and keeps its data calls in its journey', () => {
    // Its hidden-folder requests are probes from a link fetcher (see the scanner rules).
    const requests = session(CLAUDE_USER_UA).filter(event => !event.path.startsWith('/.'))
    const report = buildTrafficProbeReport(requests)

    expect(report.totals).toMatchObject({ aiUserFetchHits: requests.length, aiUserFetchBrowserNonPageHits: 0, aiUserFetchLikelyFakeHits: 0 })
    expect(extractAgentJourneyRequests(requests).map(row => row.sourceEventId))
      .toEqual(expect.arrayContaining(['api-call', 'json', 'prefetch', 'head', 'form-post']))
  })
})
