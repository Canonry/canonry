import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WordpressTrafficApiError,
  listWordpressTrafficEvents,
  normalizeWordpressTrafficEvent,
} from '../src/index.js'

describe('normalizeWordpressTrafficEvent', () => {
  it('normalizes a plugin event row into a NormalizedTrafficRequest', () => {
    const event = normalizeWordpressTrafficEvent({
      id: 42,
      observed_at: '2026-05-11T12:00:00.000Z',
      method: 'GET',
      host: 'example.com',
      path: '/blog/post',
      query_string: 'utm_source=chatgpt.com',
      status: 200,
      user_agent: 'GPTBot/1.2',
      remote_ip: '203.0.113.4',
      referer: 'https://chatgpt.com/',
    })

    expect(event).toMatchObject({
      sourceType: 'wordpress',
      evidenceKind: 'raw-request',
      confidence: 'observed',
      eventId: 'wordpress:2026-05-11T12:00:00.000Z:42',
      observedAt: '2026-05-11T12:00:00.000Z',
      method: 'GET',
      requestUrl: 'https://example.com/blog/post?utm_source=chatgpt.com',
      host: 'example.com',
      path: '/blog/post',
      queryString: 'utm_source=chatgpt.com',
      status: 200,
      userAgent: 'GPTBot/1.2',
      remoteIp: '203.0.113.4',
      referer: 'https://chatgpt.com/',
      latencyMs: null,
      requestSizeBytes: null,
      responseSizeBytes: null,
      providerResource: {
        type: 'wordpress_site',
        labels: { host: 'example.com' },
      },
      providerLabels: {},
    })
  })

  it.each([
    ['missing timestamp', { observed_at: '' }],
    ['NaN id', { id: Number.NaN }],
    ['positive infinite id', { id: Number.POSITIVE_INFINITY }],
    ['negative infinite id', { id: Number.NEGATIVE_INFINITY }],
    ['missing path', { path: '' }],
  ])('returns null for an otherwise valid event with %s', (_description, invalidField) => {
    expect(normalizeWordpressTrafficEvent({
      id: 1,
      observed_at: '2026-05-11T12:00:00.000Z',
      method: null,
      host: null,
      path: '/valid',
      query_string: null,
      status: null,
      user_agent: null,
      remote_ip: null,
      referer: null,
      ...invalidField,
    })).toBeNull()
  })

  it('omits the host from labels when the plugin did not capture it', () => {
    const event = normalizeWordpressTrafficEvent({
      id: 1,
      observed_at: '2026-05-11T12:00:00.000Z',
      method: 'GET',
      host: null,
      path: '/about',
      query_string: null,
      status: 200,
      user_agent: 'Mozilla/5.0',
      remote_ip: null,
      referer: null,
    })

    expect(event).not.toBeNull()
    expect(event?.host).toBeNull()
    expect(event?.requestUrl).toBe('/about')
    expect(event?.providerResource.labels).toEqual({})
  })

  it('carries the stable WordPress anonymous id as a provider resource label', () => {
    const event = normalizeWordpressTrafficEvent({
      id: 1,
      observed_at: '2026-05-11T12:00:00.000Z',
      method: 'GET',
      host: 'example.com',
      path: '/about',
      query_string: null,
      status: 200,
      user_agent: 'Mozilla/5.0',
      remote_ip: null,
      referer: null,
    }, { anonymous_id: '11111111-2222-5333-8444-555555555555' })

    expect(event?.providerResource.labels).toEqual({
      host: 'example.com',
      anonymousId: '11111111-2222-5333-8444-555555555555',
    })
  })

  it('trims empty strings to null so blanks do not survive into the rollup', () => {
    const event = normalizeWordpressTrafficEvent({
      id: 1,
      observed_at: '2026-05-11T12:00:00.000Z',
      method: '  ',
      host: 'example.com',
      path: '/x',
      query_string: '   ',
      status: 200,
      user_agent: '',
      remote_ip: null,
      referer: null,
    })

    expect(event?.method).toBeNull()
    expect(event?.userAgent).toBeNull()
    expect(event?.queryString).toBeNull()
  })

  it('trims surrounding whitespace on path and rejects whitespace-only paths', () => {
    const trimmed = normalizeWordpressTrafficEvent({
      id: 1,
      observed_at: '2026-05-11T12:00:00.000Z',
      method: 'GET',
      host: 'example.com',
      path: '  /blog  ',
      query_string: null,
      status: 200,
      user_agent: 'GPTBot/1.2',
      remote_ip: null,
      referer: null,
    })

    expect(trimmed?.path).toBe('/blog')
    expect(trimmed?.requestUrl).toBe('https://example.com/blog')

    expect(normalizeWordpressTrafficEvent({
      id: 1,
      observed_at: '2026-05-11T12:00:00.000Z',
      method: 'GET',
      host: 'example.com',
      path: '   ',
      query_string: null,
      status: 200,
      user_agent: 'GPTBot/1.2',
      remote_ip: null,
      referer: null,
    })).toBeNull()
  })
})

describe('listWordpressTrafficEvents', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('hits the plugin endpoint with Basic auth and normalizes the page', async () => {
    fetchSpy.mockImplementation(async () => (
      new Response(JSON.stringify({
        events: [
          {
            id: 1,
            observed_at: '2026-05-11T12:00:00.000Z',
            method: 'GET',
            host: 'example.com',
            path: '/one',
            query_string: null,
            status: 200,
            user_agent: 'GPTBot/1.2',
            remote_ip: '203.0.113.4',
            referer: null,
          },
        ],
        next_cursor: null,
        has_more: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ))

    const result = await listWordpressTrafficEvents({
      baseUrl: 'https://example.com',
      username: 'canonry-bot',
      applicationPassword: 'xxxx xxxx xxxx xxxx xxxx xxxx',
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    const parsedUrl = new URL(String(url))
    expect(parsedUrl.origin + parsedUrl.pathname).toBe('https://example.com/wp-json/canonry/v1/events')
    expect(parsedUrl.searchParams.get('limit')).toBe('500')
    expect((init as RequestInit).method).toBe('GET')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('canonry-bot:xxxx xxxx xxxx xxxx xxxx xxxx', 'utf8').toString('base64')}`,
    )
    expect(headers.Accept).toBe('application/json')

    expect(result.endpoint).toBe('https://example.com/wp-json/canonry/v1/events')
    expect(result.events).toHaveLength(1)
    expect(result.events[0]!.path).toBe('/one')
    expect(result.rawEntryCount).toBe(1)
    expect(result.skippedEntryCount).toBe(0)
    expect(result.nextCursor).toBeUndefined()
  })

  it('strips a trailing slash from baseUrl when composing the endpoint', async () => {
    fetchSpy.mockImplementation(async () => (
      new Response(JSON.stringify({ events: [], next_cursor: null, has_more: false }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    ))

    const result = await listWordpressTrafficEvents({
      baseUrl: 'https://example.com/',
      username: 'u',
      applicationPassword: 'p',
    })

    expect(result.endpoint).toBe('https://example.com/wp-json/canonry/v1/events')
    const composedUrl = new URL(String(fetchSpy.mock.calls[0]![0]))
    expect(composedUrl.origin + composedUrl.pathname).toBe('https://example.com/wp-json/canonry/v1/events')
  })

  it('paginates through multiple pages until has_more is false', async () => {
    const urls: string[] = []
    fetchSpy.mockImplementation(async (input) => {
      urls.push(String(input))
      const u = new URL(String(input))
      const cursor = u.searchParams.get('cursor')
      if (!cursor) {
        return new Response(JSON.stringify({
          events: [
            { id: 1, observed_at: '2026-05-11T12:00:00.000Z', method: 'GET', host: 'x', path: '/a', query_string: null, status: 200, user_agent: 'a', remote_ip: null, referer: null },
          ],
          next_cursor: '1',
          has_more: true,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        events: [
          { id: 2, observed_at: '2026-05-11T12:01:00.000Z', method: 'GET', host: 'x', path: '/b', query_string: null, status: 200, user_agent: 'a', remote_ip: null, referer: null },
        ],
        next_cursor: null,
        has_more: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const result = await listWordpressTrafficEvents({
      baseUrl: 'https://example.com',
      username: 'u',
      applicationPassword: 'p',
      maxPages: 5,
      pageSize: 100,
    })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const page0 = new URL(urls[0]!)
    expect(page0.searchParams.get('limit')).toBe('100')
    expect(page0.searchParams.get('cursor')).toBeNull()
    const page1 = new URL(urls[1]!)
    expect(page1.searchParams.get('limit')).toBe('100')
    expect(page1.searchParams.get('cursor')).toBe('1')
    expect(result.events.map((event) => event.path)).toEqual(['/a', '/b'])
    expect(result.rawEntryCount).toBe(2)
    expect(result.nextCursor).toBeUndefined()
  })

  it('stops paginating once maxPages is reached and surfaces the next cursor', async () => {
    fetchSpy.mockImplementation(async () => (
      new Response(JSON.stringify({
        events: [
          { id: 1, observed_at: '2026-05-11T12:00:00.000Z', method: 'GET', host: 'x', path: '/a', query_string: null, status: 200, user_agent: 'a', remote_ip: null, referer: null },
        ],
        next_cursor: '999',
        has_more: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ))

    const result = await listWordpressTrafficEvents({
      baseUrl: 'https://example.com',
      username: 'u',
      applicationPassword: 'p',
      maxPages: 1,
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(result.nextCursor).toBe('999')
    expect(result.hasMore).toBe(true)
  })

  it.each([
    ['a missing events array', { next_cursor: null, has_more: false }, /events must be an array/],
    ['a missing has_more flag', { events: [], next_cursor: null }, /has_more must be a boolean/],
    ['a non-boolean has_more flag', { events: [], next_cursor: null, has_more: 'false' }, /has_more must be a boolean/],
    ['has_more=true without a continuation cursor', { events: [], next_cursor: null, has_more: true }, /has_more=true requires a nonempty next_cursor/],
    ['has_more=true with a blank continuation cursor', { events: [], next_cursor: '  ', has_more: true }, /has_more=true requires a nonempty next_cursor/],
    ['has_more=false with a continuation cursor', { events: [], next_cursor: 'NEXT', has_more: false }, /has_more=false requires next_cursor=null/],
  ])('rejects %s', async (_description, responseBody, message) => {
    fetchSpy.mockImplementation(async () => (
      new Response(JSON.stringify(responseBody), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ))

    await expect(listWordpressTrafficEvents({
      baseUrl: 'https://example.com',
      username: 'u',
      applicationPassword: 'p',
      maxPages: 1,
    })).rejects.toMatchObject({
      name: 'WordpressTrafficApiError',
      status: 502,
      message: expect.stringMatching(message),
    })
  })

  it('counts events that fail normalization as skipped without throwing', async () => {
    fetchSpy.mockImplementation(async () => (
      new Response(JSON.stringify({
        events: [
          { id: 1, observed_at: '2026-05-11T12:00:00.000Z', method: 'GET', host: 'x', path: '/a', query_string: null, status: 200, user_agent: 'a', remote_ip: null, referer: null },
          { id: 2, observed_at: '', method: null, host: null, path: '', query_string: null, status: null, user_agent: null, remote_ip: null, referer: null },
        ],
        next_cursor: null,
        has_more: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ))

    const result = await listWordpressTrafficEvents({
      baseUrl: 'https://example.com',
      username: 'u',
      applicationPassword: 'p',
    })

    expect(result.events).toHaveLength(1)
    expect(result.rawEntryCount).toBe(2)
    expect(result.skippedEntryCount).toBe(1)
  })

  it('throws WordpressTrafficApiError on non-2xx responses with truncated body', async () => {
    fetchSpy.mockImplementation(async () => (
      new Response('A'.repeat(500) + 'PRIVATE-TAIL', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      })
    ))

    await expect(listWordpressTrafficEvents({
      baseUrl: 'https://example.com',
      username: 'u',
      applicationPassword: 'p',
    })).rejects.toMatchObject({
      name: 'WordpressTrafficApiError',
      status: 401,
      body: 'A'.repeat(500) + '... [truncated]',
    })
  })

  it('rejects empty credentials before issuing a request', async () => {
    await expect(listWordpressTrafficEvents({
      baseUrl: 'https://example.com',
      username: '',
      applicationPassword: 'p',
    })).rejects.toBeInstanceOf(WordpressTrafficApiError)
    await expect(listWordpressTrafficEvents({
      baseUrl: 'https://example.com',
      username: 'u',
      applicationPassword: '   ',
    })).rejects.toBeInstanceOf(WordpressTrafficApiError)
    await expect(listWordpressTrafficEvents({
      baseUrl: '',
      username: 'u',
      applicationPassword: 'p',
    })).rejects.toBeInstanceOf(WordpressTrafficApiError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('passes since/until ISO 8601 bounds through as query params on every page', async () => {
    const urls: string[] = []
    fetchSpy.mockImplementation(async (input) => {
      urls.push(String(input))
      const u = new URL(String(input))
      const cursor = u.searchParams.get('cursor')
      if (!cursor) {
        return new Response(JSON.stringify({
          events: [
            { id: 1, observed_at: '2026-05-11T12:00:00.000Z', method: 'GET', host: 'x', path: '/a', query_string: null, status: 200, user_agent: 'a', remote_ip: null, referer: null },
          ],
          next_cursor: 'NEXT',
          has_more: true,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        events: [
          { id: 2, observed_at: '2026-05-11T12:30:00.000Z', method: 'GET', host: 'x', path: '/b', query_string: null, status: 200, user_agent: 'a', remote_ip: null, referer: null },
        ],
        next_cursor: null,
        has_more: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    await listWordpressTrafficEvents({
      baseUrl: 'https://example.com',
      username: 'u',
      applicationPassword: 'p',
      since: '2026-05-11T11:00:00.000Z',
      until: '2026-05-11T13:00:00.000Z',
      maxPages: 5,
      pageSize: 100,
    })

    expect(urls).toHaveLength(2)
    // Both pages carry the same window bounds; cursor advances on page 2.
    const u1 = new URL(urls[0]!)
    expect(u1.searchParams.get('since')).toBe('2026-05-11T11:00:00.000Z')
    expect(u1.searchParams.get('until')).toBe('2026-05-11T13:00:00.000Z')
    expect(u1.searchParams.get('cursor')).toBeNull()

    const u2 = new URL(urls[1]!)
    expect(u2.searchParams.get('since')).toBe('2026-05-11T11:00:00.000Z')
    expect(u2.searchParams.get('until')).toBe('2026-05-11T13:00:00.000Z')
    expect(u2.searchParams.get('cursor')).toBe('NEXT')
  })

  it.each([
    ['an event before since', '2026-05-11T10:59:59.999Z'],
    ['an event at until', '2026-05-11T13:00:00.000Z'],
    ['an event with an invalid timestamp', 'not-a-timestamp'],
  ])('rejects %s when bounded sync data violates the requested window', async (_description, observedAt) => {
    fetchSpy.mockImplementation(async () => (
      new Response(JSON.stringify({
        events: [
          { id: 1, observed_at: observedAt, method: 'GET', host: 'x', path: '/a', query_string: null, status: 200, user_agent: 'a', remote_ip: null, referer: null },
        ],
        next_cursor: null,
        has_more: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ))

    await expect(listWordpressTrafficEvents({
      baseUrl: 'https://example.com',
      username: 'u',
      applicationPassword: 'p',
      since: '2026-05-11T11:00:00.000Z',
      until: '2026-05-11T13:00:00.000Z',
    })).rejects.toMatchObject({
      name: 'WordpressTrafficApiError',
      status: 502,
      message: expect.stringMatching(/bounded-window-capable Canonry traffic-logger extension/),
    })
  })

  it('omits since/until when the caller does not supply them (backwards compatible default)', async () => {
    const urls: string[] = []
    fetchSpy.mockImplementation(async (input) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ events: [], next_cursor: null, has_more: false }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    })

    await listWordpressTrafficEvents({
      baseUrl: 'https://example.com',
      username: 'u',
      applicationPassword: 'p',
    })

    expect(urls).toHaveLength(1)
    const u = new URL(urls[0]!)
    expect(u.searchParams.has('since')).toBe(false)
    expect(u.searchParams.has('until')).toBe(false)
  })

  it('adds a unique cache-buster param and a no-cache header on every request', async () => {
    const urls: string[] = []
    fetchSpy.mockImplementation(async (input) => {
      urls.push(String(input))
      const firstPage = new URL(String(input)).searchParams.get('cursor') === null
      return new Response(JSON.stringify({
        events: [],
        next_cursor: firstPage ? 'NEXT' : null,
        has_more: firstPage,
      }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    })

    const options = { baseUrl: 'https://example.com', username: 'u', applicationPassword: 'p', maxPages: 2 }
    await listWordpressTrafficEvents(options)
    await listWordpressTrafficEvents(options)

    expect(urls).toHaveLength(4)
    const requests = urls.map(url => new URL(url))
    expect(requests.map(url => url.searchParams.get('cursor'))).toEqual([null, 'NEXT', null, 'NEXT'])
    const cacheBusters = requests.map(url => url.searchParams.get('_cb'))
    expect(cacheBusters.every(value => typeof value === 'string' && value.length > 0)).toBe(true)
    expect(new Set(cacheBusters).size).toBe(4)
    expect(fetchSpy.mock.calls.map(([, init]) => (
      ((init as RequestInit).headers as Record<string, string>)['Cache-Control']
    ))).toEqual(['no-cache', 'no-cache', 'no-cache', 'no-cache'])
  })
})
