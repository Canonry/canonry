import { describe, expect, it } from 'vitest'
import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type NormalizedTrafficRequest,
} from '@canonry/canonry-contracts'
import {
  browserAgentRequestKind,
  BrowserAgentRequestKinds,
  buildTrafficProbeReport,
  classifyAiUserFetch,
  extractAgentJourneyRequests,
  type BrowserAgentRequestKind,
} from '../src/index.js'

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

const { page, action, resource } = BrowserAgentRequestKinds

interface BrowserRequest {
  id: string
  method: string | null
  /** Without its query, as sources store it. */
  path: string
  queryString?: string
  kind: BrowserAgentRequestKind
}

/**
 * What a hosted browser sends while it reads pages and acts for a person,
 * across the site stacks Canonry's sources see: the pages and files it opens,
 * what it sends (form posts, checkouts, API writes), and what each page
 * fetches or sends by itself (files, data calls, prefetches, beacons). Each
 * request names what it was.
 */
const BROWSER_REQUESTS: readonly BrowserRequest[] = [
  // Pages and files it opened, wherever they are kept.
  { id: 'page', method: 'GET', path: '/pricing', kind: page },
  { id: 'next-page', method: 'GET', path: '/contact', queryString: 'sent=1', kind: page },
  { id: 'no-method', method: null, path: '/locations/', kind: page },
  { id: 'document', method: 'GET', path: '/menu.pdf', kind: page },
  { id: 'wordpress-upload', method: 'GET', path: '/wp-content/uploads/2026/05/application-form.docx', kind: page },
  { id: 'api-reference', method: 'GET', path: '/api/fs.html', kind: page },
  { id: 'docs-api-page', method: 'GET', path: '/docs/api/authentication', kind: page },
  { id: 'azure-sign-in', method: 'GET', path: '/.auth/login/aad', kind: page },
  { id: 'azure-sign-out', method: 'GET', path: '/.auth/logout', kind: page },
  // What it sent, wherever it went: form posts, checkouts and API writes.
  { id: 'form-post', method: 'POST', path: '/contact', kind: action },
  { id: 'contact-form-7', method: 'POST', path: '/wp-json/contact-form-7/v1/contact-forms/123/feedback', kind: action },
  { id: 'woocommerce-checkout', method: 'POST', path: '/', queryString: 'wc-ajax=checkout', kind: action },
  { id: 'wordpress-form', method: 'POST', path: '/wp-admin/admin-ajax.php', kind: action },
  { id: 'api-booking', method: 'POST', path: '/api/bookings', kind: action },
  { id: 'route-action', method: 'POST', path: '/contact.data', kind: action },
  { id: 'cart-removal', method: 'DELETE', path: '/api/cart/items/42', kind: action },
  // Framework files, image optimizers and route data, at the root or under a sub-path.
  { id: 'script', method: 'GET', path: '/_next/static/chunks/app/pricing/page-4f1c2a9d.js', kind: resource },
  { id: 'style', method: 'GET', path: '/_next/static/css/9a8b7c6d.css', kind: resource },
  { id: 'image-optimizer', method: 'GET', path: '/_next/image', queryString: 'url=%2Fhero.png&w=1080&q=75', kind: resource },
  { id: 'sub-path-image-optimizer', method: 'GET', path: '/docs/_next/image', queryString: 'url=%2Fdocs%2Fhero.png&w=1080&q=75', kind: resource },
  { id: 'nuxt-image', method: 'GET', path: '/_ipx/w_640/hero.jpg', kind: resource },
  { id: 'nuxt-image-no-extension', method: 'GET', path: '/_ipx/w_640/avatars/ceo', kind: resource },
  { id: 'astro-image', method: 'GET', path: '/_image', queryString: 'href=%2F_astro%2Fhero.a1b2c3.png&w=800&f=webp', kind: resource },
  { id: 'vercel-image', method: 'GET', path: '/_vercel/image', queryString: 'url=%2Fhero.png&w=640&q=75', kind: resource },
  { id: 'blazor-assembly', method: 'GET', path: '/_framework/System.Private.CoreLib.dll', kind: resource },
  { id: 'blazor-icu', method: 'GET', path: '/_framework/icudt_EFIGS.dat', kind: resource },
  { id: 'route-data', method: 'GET', path: '/pricing.data', kind: resource },
  { id: 'favicon', method: 'GET', path: '/favicon.ico', kind: resource },
  { id: 'manifest', method: 'GET', path: '/site.webmanifest', kind: resource },
  { id: 'json', method: 'GET', path: '/collections/all/products.json', kind: resource },
  // Data calls marked only by their query: prefetches, route data, section renders, AJAX.
  { id: 'prefetch', method: 'GET', path: '/about', queryString: '_rsc=1ld0r', kind: resource },
  { id: 'remix-data', method: 'GET', path: '/pricing', queryString: '_data=routes%2Fpricing', kind: resource },
  { id: 'shopify-section', method: 'GET', path: '/products/blue-mug', queryString: 'variant=41234567890123&section_id=template--16253__main', kind: resource },
  { id: 'shopify-sections', method: 'GET', path: '/cart', queryString: 'sections=cart-drawer,cart-icon-bubble', kind: resource },
  { id: 'woocommerce-ajax-read', method: 'GET', path: '/', queryString: 'wc-ajax=get_refreshed_fragments', kind: resource },
  // API, CMS and platform calls.
  { id: 'api-call', method: 'GET', path: '/api/plans', kind: resource },
  { id: 'api-call-mixed-case', method: 'GET', path: '/Api/Orders', kind: resource },
  { id: 'graphql', method: 'GET', path: '/graphql', queryString: 'query=%7Bshop%7Bname%7D%7D', kind: resource },
  { id: 'wordpress-rest', method: 'GET', path: '/wp-json/wp/v2/posts', queryString: 'per_page=3', kind: resource },
  { id: 'wordpress-plugin-call', method: 'GET', path: '/wp-content/plugins/related-posts/ajax.php', queryString: 'post=12', kind: resource },
  { id: 'sub-path-wordpress-rest', method: 'GET', path: '/blog/wp-json/contact-form-7/v1/contact-forms/12/refill', kind: resource },
  { id: 'sub-path-wordpress-ajax', method: 'GET', path: '/blog/wp-admin/admin-ajax.php', queryString: 'action=load_more', kind: resource },
  { id: 'azure-user', method: 'GET', path: '/.auth/me', kind: resource },
  { id: 'azure-token-refresh', method: 'GET', path: '/.auth/refresh', kind: resource },
  { id: 'netlify-identity', method: 'GET', path: '/.netlify/identity/user', kind: resource },
  // Writes a page's own scripts send: beacons, bot checks and background AJAX.
  { id: 'vercel-beacon', method: 'POST', path: '/_vercel/insights/view', kind: resource },
  { id: 'vercel-speed-insights', method: 'POST', path: '/_vercel/speed-insights/vitals', kind: resource },
  { id: 'cloudflare-beacon', method: 'POST', path: '/cdn-cgi/rum', kind: resource },
  { id: 'cloudflare-bot-check', method: 'POST', path: '/cdn-cgi/challenge-platform/h/b/jsd/r/8f1a2b3c4d5e6f70', kind: resource },
  { id: 'woocommerce-fragments', method: 'POST', path: '/', queryString: 'wc-ajax=get_refreshed_fragments', kind: resource },
  { id: 'woocommerce-order-review', method: 'POST', path: '/', queryString: 'wc-ajax=update_order_review', kind: resource },
  { id: 'wordpress-heartbeat', method: 'POST', path: '/wp-admin/admin-ajax.php', queryString: 'action=heartbeat', kind: resource },
  { id: 'head', method: 'HEAD', path: '/pricing', kind: resource },
  { id: 'preflight', method: 'OPTIONS', path: '/contact', kind: resource },
]
const ofKind = (kind: BrowserAgentRequestKind) => BROWSER_REQUESTS.filter(row => row.kind === kind)

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

describe('browserAgentRequestKind', () => {
  it.each(BROWSER_REQUESTS)('reads $id ($method $path) as $kind', ({ method, path, queryString, kind }) => {
    expect(browserAgentRequestKind({ method, path, queryString: queryString ?? null })).toBe(kind)
  })
})

describe.each(BROWSER_AGENTS)('$botId, a hosted browser', ({ botId, operator, userAgent }) => {
  it('counts only its page loads as AI user fetches; the rest is counted apart', () => {
    const report = buildTrafficProbeReport(session(userAgent))

    expect(report.totals).toMatchObject({
      aiUserFetchHits: ofKind(page).length,
      aiUserFetchBrowserNonPageHits: ofKind(action).length + ofKind(resource).length,
      aiUserFetchLikelyFakeHits: 0,
      unknownHits: 0,
      crawlerHits: 0,
    })
    expect(report.aiUserFetchEventsHourly.map(bucket => [bucket.botId, bucket.pathNormalized, bucket.hits])).toEqual([
      [botId, '/.auth/login/aad', 1],
      [botId, '/.auth/logout', 1],
      [botId, '/api/fs.html', 1],
      [botId, '/contact', 1],
      [botId, '/docs/api/authentication', 1],
      [botId, '/locations/', 1],
      [botId, '/menu.pdf', 1],
      [botId, '/pricing', 1],
      [botId, '/wp-content/uploads/:id/:id/application-form.docx', 1],
    ])
    expect(report.topAiUserFetchBots).toEqual([{ botId, operator, hits: ofKind(page).length }])
  })

  it('keeps the requests it made in its journey: page loads and actions, in order', () => {
    const rows = extractAgentJourneyRequests(session(userAgent))

    expect(rows.map(row => [row.sourceEventId, row.method, row.path])).toEqual(
      BROWSER_REQUESTS.filter(row => row.kind !== resource).map(row => [row.id, row.method, row.path]),
    )
    expect(new Set(rows.map(row => row.agentId))).toEqual(new Set([botId]))
  })

  it('keeps a request that failed in its journey with its status, while counting only its page load', () => {
    const visit = [
      request({ eventId: 'page', path: '/pricing', userAgent }),
      request({ eventId: 'script', path: '/_next/static/chunks/main-4f1c.js', userAgent }),
      request({ eventId: 'blocked-script', path: '/_next/static/chunks/app-9d8e.js', userAgent, status: 403 }),
      request({ eventId: 'failed-data', path: '/api/plans', userAgent, status: 500 }),
      request({ eventId: 'failed-image', path: '/_next/image', queryString: 'url=%2Fhero.png&w=1080&q=75', userAgent, status: 502 }),
      request({ eventId: 'throttled-prefetch', path: '/about', queryString: '_rsc=1ld0r', userAgent, status: 429 }),
      request({ eventId: 'refused-head', method: 'HEAD', path: '/pricing', userAgent, status: 405 }),
      request({ eventId: 'rejected-booking', method: 'POST', path: '/api/bookings', userAgent, status: 422 }),
    ]

    const report = buildTrafficProbeReport(visit)
    expect(report.totals).toMatchObject({ aiUserFetchHits: 1, aiUserFetchBrowserNonPageHits: 7, aiUserFetchLikelyFakeHits: 0 })
    expect(report.aiUserFetchEventsHourly.map(bucket => [bucket.pathNormalized, bucket.status, bucket.hits])).toEqual([['/pricing', 200, 1]])

    expect(extractAgentJourneyRequests(visit).map(row => [row.sourceEventId, row.method, row.path, row.status])).toEqual([
      ['page', 'GET', '/pricing', 200],
      ['blocked-script', 'GET', '/_next/static/chunks/app-9d8e.js', 403],
      ['failed-data', 'GET', '/api/plans', 500],
      ['failed-image', 'GET', '/_next/image', 502],
      ['throttled-prefetch', 'GET', '/about', 429],
      ['refused-head', 'HEAD', '/pricing', 405],
      ['rejected-booking', 'POST', '/api/bookings', 422],
    ])
  })

  it('reads the app files and sign-in calls its pages make as theirs, not scanner probes, so its session stays countable', () => {
    // A Blazor app on Azure, from an IP missing from the published list: the
    // page's settings files and sign-in calls would each be a probe from a
    // link fetcher, and one probe marks every request from that IP for ten minutes.
    const azure = [
      request({ eventId: 'page', path: '/', userAgent }),
      request({ eventId: 'boot', path: '/_framework/blazor.boot.json', userAgent }),
      request({ eventId: 'assembly', path: '/_framework/System.Private.CoreLib.dll', userAgent }),
      request({ eventId: 'settings', path: '/appsettings.json', userAgent }),
      request({ eventId: 'environment-settings', path: '/appsettings.Production.json', userAgent }),
      request({ eventId: 'runtime-settings', path: '/env.js', userAgent }),
      request({ eventId: 'signed-in', path: '/.auth/me', userAgent }),
      request({ eventId: 'token-refresh', path: '/.auth/refresh', userAgent }),
      request({ eventId: 'sign-in', path: '/.auth/login/aad', userAgent, status: 302 }),
      request({ eventId: 'sign-in-callback', path: '/.auth/login/aad/callback', userAgent, status: 302 }),
      request({ eventId: 'sign-out', path: '/.auth/logout', userAgent, status: 302 }),
      request({ eventId: 'signed-out', path: '/.auth/logout/complete', userAgent }),
    ]
    expect(azure.map(event => classifyAiUserFetch(event)?.trust)).toEqual(Array(azure.length).fill('unknown'))

    const report = buildTrafficProbeReport(azure)
    expect(report.totals).toMatchObject({ aiUserFetchHits: 5, aiUserFetchBrowserNonPageHits: 7, aiUserFetchLikelyFakeHits: 0 })
    expect(extractAgentJourneyRequests(azure).map(row => row.sourceEventId))
      .toEqual(['page', 'sign-in', 'sign-in-callback', 'sign-out', 'signed-out'])
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
