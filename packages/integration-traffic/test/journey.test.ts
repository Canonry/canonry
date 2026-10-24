import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type NormalizedTrafficRequest,
} from '@canonry/canonry-contracts'
import { describe, expect, it } from 'vitest'
import {
  extractJourneyRequests,
  maskJourneyPath,
  sessionizeJourneyRequests,
  type JourneyVisitorState,
  type KeyedJourneyRequest,
} from '../src/index.js'

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const OPTIONS = { idleMs: 30 * MINUTE, lookbackMs: 30 * DAY, maxRequestsPerDay: 300 }

function event(overrides: Partial<NormalizedTrafficRequest>): NormalizedTrafficRequest {
  return {
    sourceType: TrafficSourceTypes['cloud-run'],
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId: overrides.eventId ?? crypto.randomUUID(),
    observedAt: overrides.observedAt ?? '2026-10-18T12:00:00.000Z',
    method: overrides.method ?? 'GET',
    requestUrl: overrides.requestUrl ?? `https://www.example.com${overrides.path ?? '/'}`,
    host: overrides.host ?? 'www.example.com',
    path: overrides.path ?? '/',
    queryString: overrides.queryString ?? null,
    status: overrides.status ?? 200,
    userAgent: overrides.userAgent === undefined ? MAC_CHROME : overrides.userAgent,
    remoteIp: overrides.remoteIp ?? null,
    referer: overrides.referer ?? null,
    latencyMs: null,
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: { type: 'cloud_run_revision', labels: {} },
    providerLabels: {},
  }
}

/** One visitor's requests, keyed, from `[minutesFromStart, overrides]` pairs. */
function requests(start: string, steps: Array<[number, Partial<NormalizedTrafficRequest>]>, visitorKey = 'v1'): KeyedJourneyRequest[] {
  const t0 = Date.parse(start)
  return extractJourneyRequests(steps.map(([minutes, overrides], i) => event({
    eventId: `${visitorKey}-${i}`,
    observedAt: new Date(t0 + minutes * MINUTE).toISOString(),
    ...overrides,
  }))).map(r => ({ ...r, visitorKey }))
}

/** Feed a result back as stored state, as the persistence layer does between batches. */
function storedState(result: ReturnType<typeof sessionizeJourneyRequests>, visitorKey = 'v1'): Map<string, JourneyVisitorState> {
  const visitor = result.visitors.find(v => v.visitorKey === visitorKey)
  return new Map([[visitorKey, {
    firstAiAt: visitor?.firstAiAt ?? null,
    firstAiEngine: visitor?.firstAiEngine ?? null,
    lastAiAt: visitor?.lastAiAt ?? null,
    aiTimes: result.visits.filter(v => v.entry.entryClass === 'ai').map(v => v.startedAt),
    visits: result.visits.map(({ id, startedAt, endedAt, entry, requestCount, pageCount }) => ({ id, startedAt, endedAt, entry, requestCount, pageCount })),
  }]])
}

function ids() {
  let n = 0
  return () => `visit-${++n}`
}

const fromChatGpt = { referer: 'https://chatgpt.com/', queryString: 'utm_source=chatgpt.com' }
const fromGoogle = { referer: 'https://www.google.com/' }
const internal = (path: string) => ({ path, referer: `https://www.example.com/` })

describe('extractJourneyRequests', () => {
  it('keeps browser pages and data calls, drops assets, bots, HEAD and self traffic', () => {
    const kept = extractJourneyRequests([
      event({ eventId: 'page', path: '/rooms' }),
      event({ eventId: 'api', path: '/api/contact', method: 'POST' }),
      event({ eventId: 'json', path: '/_next/data/build/rooms.json' }),
      event({ eventId: 'css', path: '/_next/static/app.css' }),
      event({ eventId: 'png', path: '/hero.png' }),
      event({ eventId: 'head', method: 'HEAD' }),
      event({ eventId: 'gptbot', userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)' }),
      event({ eventId: 'chatgpt-user', userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot' }),
      event({ eventId: 'curl', userAgent: 'curl/8.7.1' }),
      event({ eventId: 'self', userAgent: 'AINYC-AEO-Audit/1.0' }),
      event({ eventId: 'no-ua', userAgent: null }),
      event({ eventId: 'bad-time', observedAt: 'not a time' }),
    ])
    expect(kept.map(r => [r.eventId, r.kind])).toEqual([['page', 'page'], ['api', 'data'], ['json', 'data']])
  })

  it('keeps only utm parameters, records a click id by presence, and normalizes time', () => {
    const [request] = extractJourneyRequests([event({
      path: '/rooms',
      queryString: 'utm_source=google&utm_medium=cpc&gclid=abc123&email=a%40b.c',
      referer: 'https://www.google.com/',
      observedAt: '2026-10-18T12:00:00.123456789Z',
    })])
    expect(request!.path).toBe('/rooms?utm_source=google&utm_medium=cpc')
    expect(request!.signal).toMatchObject({ refererHost: 'www.google.com', utmSource: 'google', utmMedium: 'cpc', adClickId: true, clickNetwork: null })
    expect(request!.observedAt).toBe('2026-10-18T12:00:00.123Z')
  })

  it('treats a same-site referer as a step, not an entry, with or without www', () => {
    const [request] = extractJourneyRequests([event({ host: 'example.com', referer: 'https://www.example.com/rooms' })])
    expect(request!.stepReferer).toBe(true)
    expect(request!.signal.refererHost).toBeNull()
  })

  it('reads the AI engine from the AI-referral classifier', () => {
    const [request] = extractJourneyRequests([event(fromChatGpt)])
    expect(request!.signal.aiProduct).toBe('ChatGPT')
  })
})

describe('sessionizeJourneyRequests', () => {
  it('drops visitors with no AI visit', () => {
    const result = sessionizeJourneyRequests(requests('2026-10-18T12:00:00Z', [[0, fromGoogle], [1, internal('/rooms')]]), new Map(), { ...OPTIONS, newId: ids() })
    expect(result).toMatchObject({ visits: [], events: [], visitors: [], dropped: 2 })
  })

  it('groups an AI visit and splits on idle time and on a new outside source', () => {
    const result = sessionizeJourneyRequests(requests('2026-10-18T12:00:00Z', [
      [0, { ...fromChatGpt, path: '/' }],
      [2, internal('/rooms')],
      [3, { ...internal('/api/availability'), method: 'POST' }],
      [90, { path: '/' }], // direct, after 30 idle minutes: new visit
      [95, { ...fromGoogle, path: '/book' }], // Google within the visit: new visit
      [96, internal('/book/confirm')],
    ]), new Map(), { ...OPTIONS, newId: ids() })

    expect(result.visits.map(v => [v.entry.entryClass, v.entry.entryName, v.landingPath, v.requestCount, v.pageCount])).toEqual([
      ['ai', 'ChatGPT', '/?utm_source=chatgpt.com', 3, 2],
      ['direct', null, '/', 1, 1],
      ['search', 'Google', '/book', 2, 2],
    ])
    expect(result.visitors).toEqual([{
      visitorKey: 'v1',
      firstAiAt: '2026-10-18T12:00:00.000Z',
      firstAiEngine: 'ChatGPT',
      lastAiAt: '2026-10-18T12:00:00.000Z',
      userAgent: MAC_CHROME,
      lastSeenAt: '2026-10-18T13:36:00.000Z',
      cappedDays: [],
    }])
    expect(result.events).toHaveLength(6)
    expect(result.dropped).toBe(0)
  })

  it('keeps visits for 30 days after the latest AI visit and drops what came before the first', () => {
    const state = new Map<string, JourneyVisitorState>([['v1', {
      firstAiAt: '2026-09-01T12:00:00.000Z', firstAiEngine: 'Perplexity', lastAiAt: '2026-09-01T12:00:00.000Z', visits: [],
    }]])
    const result = sessionizeJourneyRequests([
      ...requests('2026-08-30T12:00:00Z', [[0, fromGoogle]]),
      ...requests('2026-09-20T12:00:00Z', [[0, fromGoogle]]),
      ...requests('2026-10-05T12:00:00Z', [[0, fromGoogle]]),
    ].map((r, i) => ({ ...r, eventId: `e${i}` })), state, { ...OPTIONS, newId: ids() })

    expect(result.events.map(e => e.request.observedAt)).toEqual(['2026-09-20T12:00:00.000Z'])
    expect(result.dropped).toBe(2)
    expect(result.visitors[0]).toMatchObject({ firstAiAt: '2026-09-01T12:00:00.000Z', firstAiEngine: 'Perplexity' })
  })

  it('measures the lookback from the AI visit before each request, whatever the arrival order', () => {
    const state = new Map<string, JourneyVisitorState>([['v1', {
      firstAiAt: '2026-08-01T12:00:00.000Z',
      firstAiEngine: 'ChatGPT',
      lastAiAt: '2026-10-20T12:00:00.000Z',
      aiTimes: ['2026-08-01T12:00:00.000Z', '2026-10-20T12:00:00.000Z'],
      visits: [],
    }]])
    const result = sessionizeJourneyRequests([
      ...requests('2026-08-15T12:00:00Z', [[0, fromGoogle]]),
      ...requests('2026-09-15T12:00:00Z', [[0, fromGoogle]]),
      ...requests('2026-10-25T12:00:00Z', [[0, fromGoogle]]),
    ].map((r, i) => ({ ...r, eventId: `e${i}` })), state, { ...OPTIONS, newId: ids() })
    expect(result.events.map(e => e.request.observedAt)).toEqual(['2026-08-15T12:00:00.000Z', '2026-10-25T12:00:00.000Z'])
    expect(result.dropped).toBe(1)
  })

  it('a new AI visit extends the window', () => {
    const state = new Map<string, JourneyVisitorState>([['v1', {
      firstAiAt: '2026-08-01T12:00:00.000Z', firstAiEngine: 'ChatGPT', lastAiAt: '2026-08-01T12:00:00.000Z', visits: [],
    }]])
    const result = sessionizeJourneyRequests(requests('2026-10-01T12:00:00Z', [[0, fromChatGpt], [60 * 24 * 20, fromGoogle]]), state, { ...OPTIONS, newId: ids() })
    expect(result.events).toHaveLength(2)
    expect(result.visitors[0]).toMatchObject({ firstAiAt: '2026-08-01T12:00:00.000Z', lastAiAt: '2026-10-01T12:00:00.000Z' })
  })

  it('continues a stored visit and moves the journey start back for an earlier AI visit from a backfill', () => {
    const state = new Map<string, JourneyVisitorState>([['v1', {
      firstAiAt: '2026-10-18T12:00:00.000Z',
      firstAiEngine: 'ChatGPT',
      lastAiAt: '2026-10-18T12:00:00.000Z',
      visits: [{
        id: 'stored',
        startedAt: '2026-10-18T12:00:00.000Z',
        endedAt: '2026-10-18T12:05:00.000Z',
        entry: { entryClass: 'ai', entryName: 'ChatGPT', entryHost: 'chatgpt.com', paid: false },
        requestCount: 3,
        pageCount: 3,
      }],
    }]])
    const result = sessionizeJourneyRequests([
      ...requests('2026-10-18T12:10:00Z', [[0, internal('/menu')]]),
      ...requests('2026-10-10T09:00:00Z', [[0, { referer: 'https://www.perplexity.ai/' }]]),
    ].map((r, i) => ({ ...r, eventId: `e${i}` })), state, { ...OPTIONS, newId: ids() })

    const stored = result.visits.find(v => v.id === 'stored')!
    expect(stored).toMatchObject({ isNew: false, endedAt: '2026-10-18T12:10:00.000Z', requestCount: 4, pageCount: 4 })
    expect(result.visits.find(v => v.isNew)).toMatchObject({ entry: { entryClass: 'ai', entryName: 'Perplexity' } })
    expect(result.visitors[0]).toMatchObject({ firstAiAt: '2026-10-10T09:00:00.000Z', firstAiEngine: 'Perplexity', lastAiAt: '2026-10-18T12:00:00.000Z' })
  })

  it('keeps visitors apart', () => {
    const result = sessionizeJourneyRequests([
      ...requests('2026-10-18T12:00:00Z', [[0, fromChatGpt]], 'a'),
      ...requests('2026-10-18T12:00:00Z', [[1, internal('/rooms')]], 'b'),
    ], new Map(), { ...OPTIONS, newId: ids() })
    expect(result.visitors.map(v => v.visitorKey)).toEqual(['a'])
    expect(result.dropped).toBe(1)
  })

  it('a late outside arrival heads the stored visit it opened, as in time order', () => {
    const base = sessionizeJourneyRequests(requests('2026-10-18T09:00:00Z', [[0, fromChatGpt]]), new Map(), { ...OPTIONS, newId: ids() })
    const newId = ids()
    // In time order: Google /g at 09:58, '/' at 10:00 (no referer), /pricing at 10:05 (internal).
    const steps: Array<[number, Partial<NormalizedTrafficRequest>]> = [[58, { ...fromGoogle, path: '/g' }], [60, { path: '/' }], [65, internal('/pricing')]]
    const inOrder = sessionizeJourneyRequests(requests('2026-10-18T09:00:00Z', steps), storedState(base), { ...OPTIONS, newId })
    expect(inOrder.visits.filter(v => v.isNew).map(v => [v.entry.entryClass, v.landingPath, v.requestCount])).toEqual([['search', '/g', 3]])

    // Out of order: /pricing, then '/', then Google, each in its own batch.
    let state = storedState(base)
    const all = requests('2026-10-18T09:00:00Z', steps)
    const visits = new Map<string, { entry: string; landing: string; count: number; startedAt: string }>()
    for (const request of [all[2]!, all[1]!, all[0]!]) {
      const result = sessionizeJourneyRequests([request], state, { ...OPTIONS, newId })
      for (const v of result.visits) visits.set(v.id, { entry: v.entry.entryClass, landing: v.landingPath || visits.get(v.id)?.landing || '', count: v.requestCount, startedAt: v.startedAt })
      const merged = { ...result, visits: [...(state.get('v1')?.visits ?? []).filter(v => !result.visits.some(r => r.id === v.id)).map(v => ({ ...v, visitorKey: 'v1', landingPath: '', isNew: false, headChanged: false })), ...result.visits] }
      state = storedState(merged)
    }
    const late = [...visits.values()].filter(v => v.entry !== 'ai')
    expect(late).toEqual([{ entry: 'search', landing: '/g', count: 3, startedAt: '2026-10-18T09:58:00.000Z' }])
  })

  it('a late request with no entry evidence heads a stored direct visit and marks the head changed', () => {
    const state = new Map<string, JourneyVisitorState>([['v1', {
      firstAiAt: '2026-10-18T09:00:00.000Z', firstAiEngine: 'ChatGPT', lastAiAt: '2026-10-18T09:00:00.000Z',
      visits: [{ id: 'direct', startedAt: '2026-10-18T11:05:00.000Z', endedAt: '2026-10-18T11:05:00.000Z', entry: { entryClass: 'direct', entryName: null, entryHost: null, paid: false }, requestCount: 1, pageCount: 1 }],
    }]])
    const result = sessionizeJourneyRequests(requests('2026-10-18T11:00:00Z', [[0, { path: '/' }]]), state, { ...OPTIONS, newId: ids() })
    expect(result.visits).toMatchObject([{ id: 'direct', isNew: false, headChanged: true, landingPath: '/', startedAt: '2026-10-18T11:00:00.000Z', requestCount: 2 }])
  })

  it('treats sign-in and payment return pages as steps, not returns', () => {
    const result = sessionizeJourneyRequests(requests('2026-10-18T12:00:00Z', [
      [0, fromChatGpt],
      [3, { path: '/auth/callback', referer: 'https://accounts.google.com/' }],
      [4, internal('/account')],
      [9, { path: '/thanks', referer: 'https://checkout.stripe.com/c/pay/cs_live_abc' }],
    ]), new Map(), { ...OPTIONS, newId: ids() })
    expect(result.visits.map(v => [v.entry.entryClass, v.requestCount])).toEqual([['ai', 4]])
  })

  it('treats a referer on the project domain as a step when the provider reports no host', () => {
    const events = [
      event({ eventId: 'a', observedAt: '2026-10-18T12:00:00.000Z', ...fromChatGpt, host: null, requestUrl: '/' }),
      event({ eventId: 'b', observedAt: '2026-10-18T12:01:00.000Z', path: '/pricing', host: null, requestUrl: '/pricing', referer: 'https://www.example.com/' }),
    ]
    const keyed = extractJourneyRequests(events, { siteDomains: ['https://example.com/'] }).map(r => ({ ...r, visitorKey: 'v1' }))
    expect(keyed.map(r => r.stepReferer)).toEqual([false, true])
    const result = sessionizeJourneyRequests(keyed, new Map(), { ...OPTIONS, newId: ids() })
    expect(result.visits.map(v => [v.entry.entryClass, v.requestCount])).toEqual([['ai', 2]])
  })

  it('treats a referer from another subdomain of the site or with a port as a step', () => {
    const [docs, port] = extractJourneyRequests([
      event({ host: 'example.com', referer: 'https://docs.example.com/guide' }),
      event({ host: 'example.com:8080', referer: 'http://example.com:8080/' }),
    ])
    expect([docs!.stepReferer, port!.stepReferer]).toEqual([true, true])
  })

  it('keeps the rest of a visit that crosses the 30-day mark', () => {
    const state = new Map<string, JourneyVisitorState>([['v1', {
      firstAiAt: '2026-09-18T10:00:00.000Z', firstAiEngine: 'ChatGPT', lastAiAt: '2026-09-18T10:00:00.000Z', visits: [],
    }]])
    const result = sessionizeJourneyRequests(requests('2026-10-18T09:50:00Z', [[0, fromGoogle], [15, internal('/pricing')], [20, internal('/book')]]), state, { ...OPTIONS, newId: ids() })
    expect(result.visits.map(v => [v.entry.entryClass, v.requestCount])).toEqual([['search', 3]])
    expect(result.dropped).toBe(0)
  })

  it('counts an AI utm seen only on a same-site referer as a touch only without a recent AI touch', () => {
    // Open tab: the landing was seen, so a later internal click is a step.
    const openTab = sessionizeJourneyRequests(requests('2026-10-18T10:00:00Z', [
      [0, { path: '/', queryString: 'utm_source=chatgpt.com' }],
      [45, { path: '/pricing', referer: 'https://www.example.com/?utm_source=chatgpt.com' }],
    ]), new Map(), { ...OPTIONS, newId: ids() })
    expect(openTab.visits.map(v => v.entry.entryClass)).toEqual(['ai', 'direct'])
    expect(openTab.visitors[0]).toMatchObject({ firstAiAt: '2026-10-18T10:00:00.000Z', lastAiAt: '2026-10-18T10:00:00.000Z' })

    // Cached landing: the logs never saw it, so the internal request is the AI arrival.
    const cached = sessionizeJourneyRequests(requests('2026-10-18T10:00:00Z', [
      [1, { path: '/pricing', referer: 'https://www.example.com/?utm_source=chatgpt.com' }],
      [2, internal('/book')],
    ]), new Map(), { ...OPTIONS, newId: ids() })
    expect(cached.visits.map(v => [v.entry.entryClass, v.entry.entryName, v.requestCount])).toEqual([['ai', 'ChatGPT', 2]])
  })

  it('labels a step that opens a visit after an idle gap as direct, ignoring utm tags carried on internal links', () => {
    const result = sessionizeJourneyRequests(requests('2026-10-18T10:00:00Z', [
      [0, fromChatGpt],
      [45, { path: '/pricing', queryString: 'utm_source=newsletter', referer: 'https://www.example.com/' }],
    ]), new Map(), { ...OPTIONS, newId: ids() })
    expect(result.visits.map(v => [v.entry.entryClass, v.entry.entryName])).toEqual([['ai', 'ChatGPT'], ['direct', null]])
  })

  it('never lets a background data call open a visit', () => {
    const result = sessionizeJourneyRequests(requests('2026-10-18T10:00:00Z', [
      [0, fromChatGpt],
      [90, { path: '/api/cart', referer: 'https://www.example.com/' }],
    ]), new Map(), { ...OPTIONS, newId: ids() })
    expect(result.visits.map(v => v.entry.entryClass)).toEqual(['ai'])
    expect(result.dropped).toBe(1)
  })

  it('stores at most the daily cap per visitor and counts the rest', () => {
    const steps: Array<[number, Partial<NormalizedTrafficRequest>]> = [[0, fromChatGpt], [1, internal('/a')], [2, internal('/b')], [3, internal('/c')]]
    const state = new Map<string, JourneyVisitorState>([['v1', { firstAiAt: null, firstAiEngine: null, lastAiAt: null, visits: [], requestsByDay: { '2026-10-18': 1 } }]])
    const result = sessionizeJourneyRequests(requests('2026-10-18T10:00:00Z', steps), state, { ...OPTIONS, maxRequestsPerDay: 3, newId: ids() })
    expect(result.events).toHaveLength(2)
    expect(result.capped).toBe(2)
    expect(result.visitors[0]).toMatchObject({ cappedDays: ['2026-10-18'] })
  })

  it('always stores AI touches, even over the daily cap, and marks them', () => {
    const state = new Map<string, JourneyVisitorState>([['v1', { firstAiAt: null, firstAiEngine: null, lastAiAt: null, visits: [], requestsByDay: { '2026-10-18': 5 } }]])
    const result = sessionizeJourneyRequests(requests('2026-10-18T10:00:00Z', [[0, fromChatGpt], [1, internal('/a')]]), state, { ...OPTIONS, maxRequestsPerDay: 5, newId: ids() })
    expect(result.events.map(e => [e.request.path, e.aiTouch])).toEqual([['/?utm_source=chatgpt.com', true]])
    expect(result.capped).toBe(1)
  })

  it('a late outside arrival inside a stored visit takes its later requests', () => {
    // Stored: ChatGPT visit 09:00 to 09:10 (checkout at 09:10). Late: Google at 09:05.
    const state = new Map<string, JourneyVisitorState>([['v1', {
      firstAiAt: '2026-10-18T09:00:00.000Z', firstAiEngine: 'ChatGPT', lastAiAt: '2026-10-18T09:00:00.000Z',
      aiTimes: ['2026-10-18T09:00:00.000Z'],
      visits: [{ id: 'chatgpt', startedAt: '2026-10-18T09:00:00.000Z', endedAt: '2026-10-18T09:10:00.000Z', entry: { entryClass: 'ai', entryName: 'ChatGPT', entryHost: 'chatgpt.com', paid: false }, requestCount: 2, pageCount: 2 }],
    }]])
    const result = sessionizeJourneyRequests(requests('2026-10-18T09:05:00Z', [[0, { ...fromGoogle, path: '/g' }], [2, internal('/after')]]), state, { ...OPTIONS, newId: ids() })
    const google = result.visits.find(v => v.isNew)!
    expect(google).toMatchObject({ entry: { entryClass: 'search' }, splitFrom: { visitId: 'chatgpt', after: '2026-10-18T09:05:00.000Z' } })
    // A later request in the batch continues the new visit, not the split one.
    expect(result.events.map(e => e.visitId)).toEqual([google.id, google.id])
  })
})

describe('maskJourneyPath', () => {
  it.each([
    ['/reset/3f2a9c1e-8b4d-4e2f-9a1b-2c3d4e5f6a7b', '/reset/:token'],
    ['/invite/a8f3k2j9d0s8f7g6h5j4k3', '/invite/:token'],
    ['/share/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', '/share/:token'],
    ['/files/0123456789abcdef0123', '/files/:token'],
    ['/u/jane.doe@example.com/settings', '/u/:email/settings'],
    ['/u/jane.doe%40example.com', '/u/:email'],
    ['/cart;jsessionid=ABC123', '/cart'],
  ])('masks %s', (path, masked) => {
    expect(maskJourneyPath(path)).toBe(masked)
  })

  it.each([['/blog/top-10-hotels-in-venice-beach-2026'], ['/orders/12345'], ['/rooms/ocean-view-suite'], ['/']])('keeps %s', path => {
    expect(maskJourneyPath(path)).toBe(path)
  })
})
