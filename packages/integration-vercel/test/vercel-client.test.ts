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
})
