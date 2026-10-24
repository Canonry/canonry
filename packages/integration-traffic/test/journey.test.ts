import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type NormalizedTrafficRequest,
} from '@canonry/canonry-contracts'
import { describe, expect, it } from 'vitest'
import {
  extractJourneyRequests,
  sessionizeJourneyRequests,
  type JourneyVisitorState,
  type KeyedJourneyRequest,
} from '../src/index.js'

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const OPTIONS = { idleMs: 30 * MINUTE, lookbackMs: 30 * DAY }

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
    expect(request!.signal).toMatchObject({ refererHost: 'www.google.com', utmSource: 'google', utmMedium: 'cpc', clickId: true })
    expect(request!.observedAt).toBe('2026-10-18T12:00:00.123Z')
  })

  it('treats a same-site referer as a step, not an entry, with or without www', () => {
    const [request] = extractJourneyRequests([event({ host: 'example.com', referer: 'https://www.example.com/rooms' })])
    expect(request!.sameSiteReferer).toBe(true)
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
})
