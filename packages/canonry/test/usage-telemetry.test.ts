import { describe, expect, it } from 'vitest'
import type { ApiRequestCompletedInfo } from '@ainyc/canonry-api-routes'
import type { TelemetryProperties, TrackEventOptions } from '../src/telemetry.js'
import { API_REQUEST_BUCKET_CAPACITY, classifyUsageSurface, createApiUsageTelemetry } from '../src/usage-telemetry.js'

const CALL_ID = '4f8c2a1e-9b3d-4c7a-8e21-5d6f7a8b9c0d'

function request(overrides: Partial<ApiRequestCompletedInfo> = {}): ApiRequestCompletedInfo {
  return {
    method: 'GET',
    route: '/api/v1/projects/:name',
    statusCode: 200,
    durationMs: 42,
    userAgent: 'canonry-mcp',
    actorSession: 'session-a',
    principalKind: 'api-key',
    usageLabels: { surface: 'mcp-stdio', agent: 'claude', mcpTool: 'canonry_project_overview', mcpCall: CALL_ID, mcpClient: 'claude-code' },
    ...overrides,
  }
}

function recorder(now: () => number = () => 0) {
  const events: Array<{ event: string; properties: TelemetryProperties; options?: TrackEventOptions }> = []
  const hook = createApiUsageTelemetry({ emit: (event, properties, options) => events.push({ event, properties, options }), now })
  return { events, hook }
}

describe('classifyUsageSurface', () => {
  it('takes a valid label over the user agent', () => {
    expect(classifyUsageSurface({ userAgent: 'canonry-cli/5.1.2', usageLabels: { surface: 'aero' } })).toBe('aero')
  })

  it.each([
    ['canonry-cli/5.1.2', 'cli'],
    ['canonry-mcp/5.1.2', 'mcp-http'],
    ['canonry-mcp', 'mcp-stdio'],
    ['Mozilla/5.0 (Macintosh)', 'dashboard'],
    ['curl/8.7.1', 'api'],
    [undefined, 'api'],
  ] as const)('falls back to the user agent %s for a client older than the label: %s', (userAgent, surface) => {
    expect(classifyUsageSurface({ userAgent, usageLabels: { surface: 'not-a-surface' } })).toBe(surface)
  })
})

describe('createApiUsageTelemetry', () => {
  it('emits one api.request per MCP API request, attributed to its tool, agent, and client', () => {
    const { events, hook } = recorder()

    hook(request({ statusCode: 404, durationMs: 1_500 }))

    const requests = events.filter(e => e.event === 'api.request')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual({
      event: 'api.request',
      properties: {
        surface: 'mcp-stdio',
        agent: 'claude',
        method: 'GET',
        route: '/api/v1/projects/:name',
        statusClass: '4xx',
        durationBucket: '1s_to_10s',
        mcpClient: 'claude-code',
        mcpTool: 'canonry_project_overview',
        mcpCallId: CALL_ID,
      },
      options: { source: 'cli-server' },
    })
  })

  it('skips the CLI and the dashboard, which are measured elsewhere, and infrastructure routes', () => {
    const { events, hook } = recorder()

    hook(request({ usageLabels: { surface: 'cli', agent: 'claude' }, userAgent: 'canonry-cli/5.1.2' }))
    hook(request({ usageLabels: {}, userAgent: 'Mozilla/5.0' }))
    hook(request({ route: '/health' }))
    hook(request({ route: '/api/v1/openapi.json' }))
    hook(request({ route: '/api/v1/telemetry/onboarding', method: 'POST' }))
    hook(request({ method: 'OPTIONS' }))

    expect(events).toEqual([])
  })

  it('names a hosted MCP agent from its client, since the server process has no agent environment', () => {
    const { events, hook } = recorder()

    hook(request({ userAgent: 'canonry-mcp/5.1.2', usageLabels: { surface: 'mcp-http', agent: 'none', mcpClient: 'Claude Desktop', mcpTool: 'canonry_help' } }))

    expect(events.find(e => e.event === 'api.request')?.properties).toMatchObject({ surface: 'mcp-http', agent: 'claude-desktop', mcpClient: 'claude-desktop' })
  })

  it('drops labels that fail validation instead of forwarding caller-controlled text', () => {
    const { events, hook } = recorder()

    hook(request({ usageLabels: { surface: 'api', agent: '!!!', mcpTool: 'DROP TABLE runs', mcpCall: 'not-a-uuid', mcpClient: '' } }))

    expect(events).toHaveLength(1)
    expect(events[0]!.properties).toEqual({
      surface: 'api',
      agent: 'none',
      method: 'GET',
      route: '/api/v1/projects/:name',
      statusClass: '2xx',
      durationBucket: 'under_1s',
    })
  })

  it('counts an MCP session once, on its first tool call, not on the startup probe', () => {
    const { events, hook } = recorder()

    hook(request({ route: '/api/v1/keys/self', usageLabels: { surface: 'mcp-stdio', agent: 'claude' } }))
    hook(request())
    hook(request({ usageLabels: { surface: 'mcp-stdio', agent: 'claude', mcpTool: 'canonry_runs_list', mcpCall: CALL_ID } }))
    hook(request({ actorSession: 'session-b' }))

    const sessions = events.filter(e => e.event === 'mcp.session.started')
    expect(sessions).toEqual([
      { event: 'mcp.session.started', properties: { surface: 'mcp-stdio', agent: 'claude', mcpClient: 'claude-code' }, options: { source: 'cli-server' } },
      { event: 'mcp.session.started', properties: { surface: 'mcp-stdio', agent: 'claude', mcpClient: 'claude-code' }, options: { source: 'cli-server' } },
    ])
  })

  it('stays inside the collector hourly per-IP budget under a sustained agent loop', () => {
    // The collector drops every event from an IP past 1,000/hour, so this stream
    // must leave room for the install's other events.
    let clock = 0
    const { events, hook } = recorder(() => clock)
    for (let second = 0; second < 3_600; second++) {
      clock = second * 1_000
      for (let i = 0; i < 10; i++) hook(request({ usageLabels: { surface: 'api' }, actorSession: undefined }))
    }
    expect(events.length).toBeLessThanOrEqual(API_REQUEST_BUCKET_CAPACITY + 360)
    expect(events.length).toBeLessThan(500)
  })

  it('caps api.request per process and reports what it suppressed on the next event', () => {
    let clock = 0
    const { events, hook } = recorder(() => clock)
    const raw = (n: number) => { for (let i = 0; i < n; i++) hook(request({ usageLabels: { surface: 'api' }, actorSession: undefined })) }

    raw(API_REQUEST_BUCKET_CAPACITY + 5)
    expect(events).toHaveLength(API_REQUEST_BUCKET_CAPACITY)
    expect(events.some(e => 'droppedBefore' in e.properties)).toBe(false)

    clock += 10_000
    raw(1)
    expect(events).toHaveLength(API_REQUEST_BUCKET_CAPACITY + 1)
    expect(events.at(-1)!.properties.droppedBefore).toBe(5)

    clock += 10_000
    raw(1)
    expect(events.at(-1)!.properties).not.toHaveProperty('droppedBefore')
  })
})
