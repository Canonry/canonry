import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VercelLogsApiError, listVercelTrafficEvents, normalizeVercelLogRow } from '../src/index.js'
import type { VercelRequestLogRow } from '../src/index.js'

// A serverless row where the top-level `statusCode` is 0 (Vercel populates it
// lazily) — `status` must fall back to the last `events[].httpStatus`.
const statusZeroRow: VercelRequestLogRow = {
  requestId: 'xkhwp-1778784321070-22c8d2d3a690',
  timestamp: '2026-05-14T18:45:21.070Z',
  deploymentId: 'dpl_GN4o8XFnt6ZnfziroiCyCVpRir1E',
  environment: 'production',
  domain: 'project-5umza.vercel.app',
  requestMethod: 'GET',
  requestPath: '/api/no-log',
  statusCode: 0,
  branch: '',
  cache: '',
  clientUserAgent: 'ChatGPT-User/1.0',
  requestSearchParams: { probe: 'nomw-chatgpt-1778784320' },
  requestDurationMs: 0,
  clientRegion: 'iad1',
  requestReferer: 'https://chatgpt.com/',
  proxyEvents: [],
  functionEvents: [{ source: 'serverless', httpStatus: 200, region: 'iad1' }],
  events: [{ source: 'serverless', httpStatus: 200, region: 'iad1' }],
}

// A static 404 with a valid top-level `statusCode`, an empty referer, and no
// query params — empties must coerce to null.
const favicon404Row: VercelRequestLogRow = {
  requestId: '4ctc5-1778784026388-10219bcf8bec',
  timestamp: '2026-05-14T18:40:26.388Z',
  deploymentId: 'dpl_2Qik6u3MzrzHePJAWPDMk5pZCwic',
  environment: 'production',
  domain: 'project-5umza.vercel.app',
  requestMethod: 'GET',
  requestPath: '/favicon.png',
  statusCode: 404,
  clientUserAgent: 'vercel-favicon/1.0',
  requestSearchParams: {},
  requestDurationMs: 148,
  clientRegion: 'sfo1',
  requestReferer: '',
  events: [
    { source: 'edge-middleware', httpStatus: 200 },
    { source: 'static', httpStatus: 404 },
  ],
}

describe('normalizeVercelLogRow', () => {
  it('maps a Vercel request-logs row into Canonry request evidence', () => {
    expect(normalizeVercelLogRow(statusZeroRow)).toEqual({
      sourceType: 'vercel',
      evidenceKind: 'raw-request',
      confidence: 'observed',
      eventId: 'vercel:2026-05-14T18:45:21.070Z:xkhwp-1778784321070-22c8d2d3a690',
      observedAt: '2026-05-14T18:45:21.070Z',
      method: 'GET',
      requestUrl: 'https://project-5umza.vercel.app/api/no-log?probe=nomw-chatgpt-1778784320',
      host: 'project-5umza.vercel.app',
      path: '/api/no-log',
      queryString: 'probe=nomw-chatgpt-1778784320',
      status: 200,
      userAgent: 'ChatGPT-User/1.0',
      remoteIp: null,
      referer: 'https://chatgpt.com/',
      latencyMs: 0,
      requestSizeBytes: null,
      responseSizeBytes: null,
      providerResource: {
        type: 'vercel_deployment',
        labels: {
          deploymentId: 'dpl_GN4o8XFnt6ZnfziroiCyCVpRir1E',
          environment: 'production',
          region: 'iad1',
        },
      },
      providerLabels: {},
    })
  })

  it('falls back to the last events[] httpStatus when top-level statusCode is 0', () => {
    expect(normalizeVercelLogRow(statusZeroRow)?.status).toBe(200)
  })

  it('uses the top-level statusCode when it is a valid HTTP status', () => {
    expect(normalizeVercelLogRow(favicon404Row)?.status).toBe(404)
  })

  it('coerces an empty referer and empty query params to null', () => {
    const event = normalizeVercelLogRow(favicon404Row)
    expect(event?.referer).toBeNull()
    expect(event?.queryString).toBeNull()
    expect(event?.requestUrl).toBe('https://project-5umza.vercel.app/favicon.png')
  })

  it('drops rows missing the request path, timestamp, or request id', () => {
    expect(normalizeVercelLogRow({ ...statusZeroRow, requestPath: '' })).toBeNull()
    expect(normalizeVercelLogRow({ ...statusZeroRow, timestamp: undefined })).toBeNull()
    expect(normalizeVercelLogRow({ ...statusZeroRow, requestId: undefined })).toBeNull()
  })
})

describe('listVercelTrafficEvents', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('calls the request-logs endpoint with bearer auth + query params and paginates', async () => {
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      const page = url.searchParams.get('page')
      return new Response(
        JSON.stringify({
          rows: page === '0' ? [statusZeroRow] : [favicon404Row],
          hasMoreRows: page === '0',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })

    const result = await listVercelTrafficEvents({
      token: 'vcp_test',
      projectId: 'prj_abc',
      teamId: 'team_xyz',
      startDate: '2026-05-14T18:00:00.000Z',
      endDate: '2026-05-14T19:00:00.000Z',
      maxPages: 3,
    })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const firstUrl = new URL(String(fetchSpy.mock.calls[0]![0]))
    expect(firstUrl.origin + firstUrl.pathname).toBe('https://vercel.com/api/logs/request-logs')
    expect(firstUrl.searchParams.get('projectId')).toBe('prj_abc')
    expect(firstUrl.searchParams.get('teamId')).toBe('team_xyz')
    expect(firstUrl.searchParams.get('ownerId')).toBe('team_xyz')
    expect(firstUrl.searchParams.get('environment')).toBe('production')
    expect(firstUrl.searchParams.get('page')).toBe('0')
    expect(firstUrl.searchParams.get('startDate')).toBe(String(Date.parse('2026-05-14T18:00:00.000Z')))
    expect(firstUrl.searchParams.get('endDate')).toBe(String(Date.parse('2026-05-14T19:00:00.000Z')))
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({
      method: 'GET',
      headers: { Authorization: 'Bearer vcp_test' },
    })
    expect(new URL(String(fetchSpy.mock.calls[1]![0])).searchParams.get('page')).toBe('1')
    expect(result.events.map((event) => event.path)).toEqual(['/api/no-log', '/favicon.png'])
    expect(result.rawEntryCount).toBe(2)
    expect(result.skippedEntryCount).toBe(0)
    expect(result.hasMore).toBe(false)
  })

  it('stops paginating at maxPages even when more rows remain', async () => {
    fetchSpy.mockImplementation(async () => new Response(
      JSON.stringify({ rows: [statusZeroRow], hasMoreRows: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))

    const result = await listVercelTrafficEvents({
      token: 'vcp_test',
      projectId: 'prj_abc',
      teamId: 'team_xyz',
      startDate: 0,
      endDate: 1,
      maxPages: 2,
    })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result.hasMore).toBe(true)
  })

  it('throws VercelLogsApiError with the HTTP status on a non-2xx response', async () => {
    fetchSpy.mockImplementation(async () => new Response('forbidden', { status: 403 }))

    const error = await listVercelTrafficEvents({
      token: 'vcp_bad',
      projectId: 'prj_abc',
      teamId: 'team_xyz',
      startDate: 0,
      endDate: 1,
    }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(VercelLogsApiError)
    expect((error as VercelLogsApiError).status).toBe(403)
  })

  it('counts rows that fail to normalize as skipped', async () => {
    fetchSpy.mockImplementation(async () => new Response(
      JSON.stringify({
        rows: [statusZeroRow, { requestId: 'x', timestamp: '2026-01-01T00:00:00.000Z' }],
        hasMoreRows: false,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))

    const result = await listVercelTrafficEvents({
      token: 'vcp_test',
      projectId: 'prj_abc',
      teamId: 'team_xyz',
      startDate: 0,
      endDate: 1,
    })

    expect(result.rawEntryCount).toBe(2)
    expect(result.skippedEntryCount).toBe(1)
    expect(result.events).toHaveLength(1)
  })

  /**
   * Retry-on-transient is the difference between a 73-minute backfill that
   * recovers from one Vercel 502 mid-flight and one that throws all its work
   * away at the replace-mode rollback. The cases below pin the contract so a
   * future refactor can't silently remove that resilience.
   */
  describe('transient-failure retry', () => {
    const successPayload = () => new Response(
      JSON.stringify({ rows: [statusZeroRow], hasMoreRows: false }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

    function makeFetch(responses: Array<Response | Error>): () => Promise<Response> {
      let i = 0
      return async () => {
        const next = responses[i++]
        if (!next) throw new Error('test fetch ran out of scripted responses')
        if (next instanceof Error) throw next
        return next
      }
    }

    it('retries on HTTP 502 and returns the eventual success', async () => {
      fetchSpy.mockImplementation(makeFetch([
        new Response('upstream broken', { status: 502 }),
        new Response('upstream broken', { status: 502 }),
        successPayload(),
      ]))

      const result = await listVercelTrafficEvents({
        token: 'vcp_test',
        projectId: 'prj_abc',
        teamId: 'team_xyz',
        startDate: 0,
        endDate: 1,
        initialRetryDelayMs: 0,
      })
      expect(fetchSpy).toHaveBeenCalledTimes(3)
      expect(result.events).toHaveLength(1)
    })

    it('retries on HTTP 503 and 429 too', async () => {
      fetchSpy.mockImplementation(makeFetch([
        new Response('service unavailable', { status: 503 }),
        new Response('too many requests', { status: 429 }),
        successPayload(),
      ]))

      const result = await listVercelTrafficEvents({
        token: 'vcp_test',
        projectId: 'prj_abc',
        teamId: 'team_xyz',
        startDate: 0,
        endDate: 1,
        initialRetryDelayMs: 0,
      })
      expect(fetchSpy).toHaveBeenCalledTimes(3)
      expect(result.events).toHaveLength(1)
    })

    it('honors Retry-After when shorter than the computed backoff', async () => {
      fetchSpy.mockImplementation(makeFetch([
        new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '0' },
        }),
        successPayload(),
      ]))

      // No need to mock timing; Retry-After=0 short-circuits any sleep.
      await listVercelTrafficEvents({
        token: 'vcp_test',
        projectId: 'prj_abc',
        teamId: 'team_xyz',
        startDate: 0,
        endDate: 1,
        // Set a huge initialRetryDelayMs to prove Retry-After overrides it —
        // if the override were broken this test would hang for ~60s.
        initialRetryDelayMs: 60_000,
      })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('retries on a network error from fetch itself', async () => {
      fetchSpy.mockImplementation(makeFetch([
        new TypeError('fetch failed'),
        successPayload(),
      ]))

      const result = await listVercelTrafficEvents({
        token: 'vcp_test',
        projectId: 'prj_abc',
        teamId: 'team_xyz',
        startDate: 0,
        endDate: 1,
        initialRetryDelayMs: 0,
      })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(result.events).toHaveLength(1)
    })

    it('does NOT retry on 4xx auth/permission errors', async () => {
      fetchSpy.mockImplementation(async () => new Response('forbidden', { status: 403 }))

      const error = await listVercelTrafficEvents({
        token: 'vcp_bad',
        projectId: 'prj_abc',
        teamId: 'team_xyz',
        startDate: 0,
        endDate: 1,
        initialRetryDelayMs: 0,
      }).catch((err: unknown) => err)
      expect(error).toBeInstanceOf(VercelLogsApiError)
      expect((error as VercelLogsApiError).status).toBe(403)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('does NOT retry on a retention 400 (ExceedsBillingLimitError)', async () => {
      // The drain.ts retention probe relies on this — a retried retention 400
      // would multiply probe cost by 4x and slow the backfill noticeably.
      fetchSpy.mockImplementation(async () => new Response(
        '{"error":{"name":"ExceedsBillingLimitError","message":"out of retention"}}',
        { status: 400 },
      ))

      const error = await listVercelTrafficEvents({
        token: 'vcp_test',
        projectId: 'prj_abc',
        teamId: 'team_xyz',
        startDate: 0,
        endDate: 1,
        initialRetryDelayMs: 0,
      }).catch((err: unknown) => err)
      expect(error).toBeInstanceOf(VercelLogsApiError)
      expect((error as VercelLogsApiError).status).toBe(400)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('gives up after maxRetries+1 attempts and rethrows the last error', async () => {
      fetchSpy.mockImplementation(async () => new Response('upstream broken', { status: 502 }))

      const error = await listVercelTrafficEvents({
        token: 'vcp_test',
        projectId: 'prj_abc',
        teamId: 'team_xyz',
        startDate: 0,
        endDate: 1,
        maxRetries: 2,
        initialRetryDelayMs: 0,
      }).catch((err: unknown) => err)
      expect(error).toBeInstanceOf(VercelLogsApiError)
      expect((error as VercelLogsApiError).status).toBe(502)
      // maxRetries=2 means 1 initial + 2 retries = 3 attempts total.
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    })

    it('disables retry entirely when maxRetries=0', async () => {
      fetchSpy.mockImplementation(async () => new Response('upstream broken', { status: 502 }))

      const error = await listVercelTrafficEvents({
        token: 'vcp_test',
        projectId: 'prj_abc',
        teamId: 'team_xyz',
        startDate: 0,
        endDate: 1,
        maxRetries: 0,
        initialRetryDelayMs: 0,
      }).catch((err: unknown) => err)
      expect(error).toBeInstanceOf(VercelLogsApiError)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })
})
