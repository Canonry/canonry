import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../src/client.js'
import { CliError, EXIT_SYSTEM_ERROR, EXIT_USER_ERROR } from '../src/cli-error.js'
import { connectionFailureMessage, redactRequestTarget } from '../src/client-reliability.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function apiError(status: number, headers?: HeadersInit, details: Record<string, unknown> = { reason: 'quota' }): Response {
  return new Response(JSON.stringify({
    error: { code: 'RATE_LIMITED', message: 'Slow down', details },
  }), { status, headers: { 'content-type': 'application/json', ...headers } })
}

async function expectCliError(call: () => Promise<unknown>): Promise<CliError> {
  try {
    await call()
  } catch (error) {
    expect(error).toBeInstanceOf(CliError)
    return error as CliError
  }
  throw new Error('Expected ApiClient to reject')
}

describe('ApiClient reliability metadata', () => {
  it.each(['key', 'api key', 'refresh_token', 'cookie', 'credential', 'auth'])('redacts URL parameter %s without masking unrelated names', key => {
    const target = `https://example.test/?${encodeURIComponent(key)}=fixture-secret&monkey=visible`
    expect(redactRequestTarget(target)).not.toContain('fixture-secret')
    expect(connectionFailureMessage(target)).not.toContain('fixture-secret')
    expect(redactRequestTarget(target)).toContain('monkey=visible')
  })

  it('redacts URL credentials from diagnostic targets while retaining remote guidance', () => {
    const target = 'https://operator:password@example.test/canonry?apiKey=secret&safe=yes'

    expect(redactRequestTarget(target)).toBe('https://example.test/canonry?apiKey=%3Credacted%3E&safe=yes')
    expect(connectionFailureMessage(target)).toContain('Check that this URL is reachable')
    expect(connectionFailureMessage(target)).not.toContain('password')
    expect(connectionFailureMessage(target)).not.toContain('secret')
  })

  it('maps 429 response details, Retry-After delta seconds, and request ID without retrying', async () => {
    const fetchMock = vi.fn(async () => apiError(429, {
      'retry-after': '2.5',
      'x-request-id': 'request-429',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true })

    const error = await expectCliError(() => client.listProjects())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(error.exitCode).toBe(EXIT_USER_ERROR)
    expect(error.details).toEqual({
      reason: 'quota',
      httpStatus: 429,
      retryAfterMs: 2500,
      requestId: 'request-429',
    })
  })

  it.each([400, 401, 403, 429])('preserves the existing HTTP %i user-error contract without retry headers', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => apiError(status)))
    const client = new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true })

    const error = await expectCliError(() => client.listProjects())

    expect(error.exitCode).toBe(EXIT_USER_ERROR)
    expect(error.details).toEqual({ reason: 'quota', httpStatus: status })
  })

  it('preserves 5xx system errors and omits invalid Retry-After values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiError(503, { 'retry-after': '-1' })))
    const client = new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true })

    const error = await expectCliError(() => client.listProjects())

    expect(error.exitCode).toBe(EXIT_SYSTEM_ERROR)
    expect(error.details).toEqual({ reason: 'quota', httpStatus: 503 })
  })

  it('parses HTTP-date Retry-After values without producing negative metadata', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-11T12:00:00.000Z'))
    vi.stubGlobal('fetch', vi.fn(async () => apiError(429, {
      'retry-after': 'Fri, 11 Sep 2026 12:00:03 GMT',
    })))
    const client = new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true })

    const error = await expectCliError(() => client.listProjects())

    expect(error.details).toMatchObject({ retryAfterMs: 3000 })
    vi.useRealTimers()
  })

  it('maps SSE errors with original server details and response metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiError(429, {
      'retry-after': '4',
      'x-request-id': 'sse-request',
    }, { session: 'agent-42' })))
    const client = new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true })

    const error = await expectCliError(() => client.streamPost('/projects/demo/agent/prompt', { prompt: 'hi' }))

    expect(error.exitCode).toBe(EXIT_USER_ERROR)
    expect(error.details).toEqual({
      session: 'agent-42',
      httpStatus: 429,
      retryAfterMs: 4000,
      requestId: 'sse-request',
    })
  })

  it.each(['sdk', 'stream'] as const)('preserves the daily research policy error through %s requests', async (transport) => {
    const details = { projectName: 'demo', limit: 20, date: '2026-09-08' }
    const message = 'The viewer research run limit has been reached today.'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'RESEARCH_DAILY_LIMIT_EXCEEDED', message, details },
    }), { status: 429, headers: { 'content-type': 'application/json' } })))
    const client = new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true })

    const error = await expectCliError(() => transport === 'sdk'
      ? client.listProjects()
      : client.streamPost('/projects/demo/agent/prompt', { prompt: 'hi' }))

    expect(error.code).toBe('RESEARCH_DAILY_LIMIT_EXCEEDED')
    expect(error.message).toBe(message)
    expect(error.exitCode).toBe(EXIT_USER_ERROR)
    expect(error.details).toEqual({ ...details, httpStatus: 429 })
  })
})

describe('ApiClient request identity', () => {
  it('sends bounded identity headers on SDK and streamed requests', async () => {
    const requests: Request[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init))
      return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } })
    }))
    const client = new ApiClient('https://canonry.test', 'cnry_test', {
      skipProbe: true,
      clientName: 'canonry-mcp',
      actorSession: 'session:abc-123',
    })

    await client.listProjects()
    await client.streamPost('/projects/demo/agent/prompt', { prompt: 'hi' })

    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.headers.get('user-agent')).toBe('canonry-mcp')
      expect(request.headers.get('x-canonry-actor-session')).toBe('session:abc-123')
      expect(request.headers.get('authorization')).toBe('Bearer cnry_test')
    }
  })

  it('keeps identity headers when base-path probing refreshes the SDK client', async () => {
    const requests: Array<string | Request> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | Request) => {
      requests.push(input)
      if (typeof input === 'string') {
        return new Response(JSON.stringify({ basePath: '/mounted' }), { headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } })
    }))
    const client = new ApiClient('https://canonry.test', 'cnry_test', {
      clientName: 'canonry-mcp',
      actorSession: 'session-1',
    })

    await client.listProjects()

    const apiRequest = requests[1] as Request
    expect(apiRequest.url).toBe('https://canonry.test/mounted/api/v1/projects')
    expect(apiRequest.headers.get('user-agent')).toBe('canonry-mcp')
    expect(apiRequest.headers.get('x-canonry-actor-session')).toBe('session-1')
  })

  it('uses the CLI user agent and rejects unsafe correlation header values', async () => {
    let request: Request | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      request = input instanceof Request ? input : new Request(input)
      return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } })
    }))
    const client = new ApiClient('https://canonry.test', 'cnry_test', {
      skipProbe: true,
      clientName: 'unsafe name',
      actorSession: 'bad\r\nheader',
    })

    await client.listProjects()

    expect(request?.headers.get('user-agent')).toMatch(/^canonry-cli\/\d+\.\d+\.\d+$/)
    expect(request?.headers.has('x-canonry-actor-session')).toBe(false)
  })
})

describe('ApiClient settings writes', () => {
  it('updates Google settings through the generated SDK operation', async () => {
    let request: Request | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init)
      return new Response(JSON.stringify({ configured: true }), { headers: { 'content-type': 'application/json' } })
    }))
    const client = new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true })

    await expect(client.updateGoogleSettings({ clientId: 'client-id', clientSecret: 'client-secret' })).resolves.toEqual({ configured: true })

    expect(request?.method).toBe('PUT')
    expect(new URL(request!.url).pathname).toBe('/api/v1/settings/google')
    await expect(request?.json()).resolves.toEqual({ clientId: 'client-id', clientSecret: 'client-secret' })
  })
})
