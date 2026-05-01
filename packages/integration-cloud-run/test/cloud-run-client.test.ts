import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildCloudRunLogFilter,
  listCloudRunTrafficEvents,
  normalizeCloudRunLogEntry,
} from '../src/index.js'

describe('buildCloudRunLogFilter', () => {
  it('builds a selective Cloud Logging filter for one Cloud Run service', () => {
    const filter = buildCloudRunLogFilter({
      serviceName: 'canonry-web',
      location: 'us-central1',
      startTime: '2026-04-30T10:00:00.000Z',
      endTime: '2026-04-30T11:00:00.000Z',
    })

    expect(filter).toContain('resource.type="cloud_run_revision"')
    expect(filter).toContain('resource.labels.service_name="canonry-web"')
    expect(filter).toContain('resource.labels.location="us-central1"')
    expect(filter).toContain('timestamp >= "2026-04-30T10:00:00.000Z"')
    expect(filter).toContain('timestamp < "2026-04-30T11:00:00.000Z"')
  })

  it('escapes filter values and can add user-agent narrowing clauses', () => {
    const filter = buildCloudRunLogFilter({
      serviceName: 'web"quoted',
      userAgentSubstrings: ['GPTBot/', 'ClaudeBot/'],
      requestUrlSubstrings: ['ainyc.ai'],
    })

    expect(filter).toContain('resource.labels.service_name="web\\"quoted"')
    expect(filter).toContain('(httpRequest.userAgent:"GPTBot/" OR httpRequest.userAgent:"ClaudeBot/")')
    expect(filter).toContain('(httpRequest.requestUrl:"ainyc.ai")')
  })
})

describe('normalizeCloudRunLogEntry', () => {
  it('normalizes a Cloud Logging LogEntry httpRequest into Canonry request evidence', () => {
    const event = normalizeCloudRunLogEntry({
      insertId: 'abc123',
      timestamp: '2026-04-30T12:00:00.123Z',
      resource: {
        type: 'cloud_run_revision',
        labels: {
          project_id: 'sample-project',
          service_name: 'canonry-web',
          location: 'us-central1',
        },
      },
      httpRequest: {
        requestMethod: 'GET',
        requestUrl: 'https://example.com/blog/post?utm_source=chatgpt.com',
        status: 200,
        userAgent: 'GPTBot/1.2',
        remoteIp: '203.0.113.10',
        referer: 'https://chatgpt.com/',
        latency: '0.123400s',
        requestSize: '456',
        responseSize: '789',
      },
      labels: {
        'run.googleapis.com/base_image_versions': 'ignored-but-preserved',
      },
    })

    expect(event).toMatchObject({
      eventId: 'cloud-run:2026-04-30T12:00:00.123Z:abc123',
      observedAt: '2026-04-30T12:00:00.123Z',
      method: 'GET',
      requestUrl: 'https://example.com/blog/post?utm_source=chatgpt.com',
      host: 'example.com',
      path: '/blog/post',
      queryString: 'utm_source=chatgpt.com',
      status: 200,
      userAgent: 'GPTBot/1.2',
      remoteIp: '203.0.113.10',
      referer: 'https://chatgpt.com/',
      latencyMs: 123.4,
      requestSizeBytes: 456,
      responseSizeBytes: 789,
      providerResource: {
        type: 'cloud_run_revision',
        labels: {
          project_id: 'sample-project',
          service_name: 'canonry-web',
          location: 'us-central1',
        },
      },
      providerLabels: {
        'run.googleapis.com/base_image_versions': 'ignored-but-preserved',
      },
    })
  })

  it('drops non-request log entries that have no httpRequest/requestUrl evidence', () => {
    expect(normalizeCloudRunLogEntry({
      insertId: 'log-line',
      timestamp: '2026-04-30T12:00:00.123Z',
      resource: { type: 'cloud_run_revision', labels: {} },
      textPayload: 'application log',
    })).toBeNull()
  })
})

describe('listCloudRunTrafficEvents', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('calls entries.list with the Cloud Run filter and paginates normalized request events', async () => {
    const bodies: unknown[] = []
    fetchSpy.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string))
      const body = bodies[bodies.length - 1] as { pageToken?: string }
      return new Response(JSON.stringify({
        entries: [
          {
            insertId: body.pageToken ? 'page-2' : 'page-1',
            timestamp: body.pageToken ? '2026-04-30T12:01:00.000Z' : '2026-04-30T12:00:00.000Z',
            resource: { type: 'cloud_run_revision', labels: { service_name: 'web' } },
            httpRequest: {
              requestMethod: 'GET',
              requestUrl: body.pageToken ? 'https://example.com/two' : 'https://example.com/one',
              status: 200,
              userAgent: 'GPTBot/1.2',
            },
          },
        ],
        nextPageToken: body.pageToken ? undefined : 'next-page',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const result = await listCloudRunTrafficEvents('token-123', {
      gcpProjectId: 'sample-project',
      serviceName: 'web',
      startTime: '2026-04-30T12:00:00.000Z',
      maxPages: 2,
      pageSize: 100,
    })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://logging.googleapis.com/v2/entries:list')
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-123',
        'Content-Type': 'application/json',
      },
    })
    expect(bodies[0]).toMatchObject({
      resourceNames: ['projects/sample-project'],
      orderBy: 'timestamp asc',
      pageSize: 100,
    })
    expect((bodies[0] as { filter: string }).filter).toContain('resource.type="cloud_run_revision"')
    expect(bodies[1]).toMatchObject({ pageToken: 'next-page' })
    expect(result.events.map((event) => event.path)).toEqual(['/one', '/two'])
    expect(result.rawEntryCount).toBe(2)
    expect(result.skippedEntryCount).toBe(0)
    expect(result.nextPageToken).toBeUndefined()
  })
})
