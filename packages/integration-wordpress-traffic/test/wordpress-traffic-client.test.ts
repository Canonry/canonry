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

  it('returns null for events missing required fields', () => {
    expect(normalizeWordpressTrafficEvent({
      id: 0,
      observed_at: '',
      method: null,
      host: null,
      path: '',
      query_string: null,
      status: null,
      user_agent: null,
      remote_ip: null,
      referer: null,
    })).toBeNull()

    expect(normalizeWordpressTrafficEvent({
      id: 1,
      observed_at: '2026-05-11T12:00:00.000Z',
      method: null,
      host: null,
      path: '',
      query_string: null,
      status: null,
      user_agent: null,
      remote_ip: null,
      referer: null,
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
    expect(String(url)).toBe('https://example.com/wp-json/canonry/v1/events?limit=500')
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
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      'https://example.com/wp-json/canonry/v1/events?limit=500',
    )
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
    expect(urls[0]).toBe('https://example.com/wp-json/canonry/v1/events?limit=100')
    expect(urls[1]).toBe('https://example.com/wp-json/canonry/v1/events?limit=100&cursor=1')
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
      new Response('Unauthorized — bad Application Password', {
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
})
