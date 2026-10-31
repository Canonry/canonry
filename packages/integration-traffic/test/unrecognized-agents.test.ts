import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type NormalizedTrafficRequest,
} from '@canonry/canonry-contracts'
import { describe, expect, it } from 'vitest'
import { buildTrafficProbeReport, unrecognizedAgentName } from '../src/index.js'

function event(overrides: Partial<NormalizedTrafficRequest>): NormalizedTrafficRequest {
  return {
    sourceType: TrafficSourceTypes['cloud-run'],
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId: overrides.eventId ?? crypto.randomUUID(),
    observedAt: overrides.observedAt ?? '2026-05-01T12:30:00.000Z',
    method: overrides.method ?? 'GET',
    requestUrl: overrides.requestUrl ?? 'https://example.com/',
    host: overrides.host ?? 'example.com',
    path: overrides.path ?? '/',
    queryString: overrides.queryString ?? null,
    status: overrides.status ?? 200,
    userAgent: overrides.userAgent ?? 'Mozilla/5.0',
    remoteIp: overrides.remoteIp ?? '203.0.113.10',
    referer: overrides.referer ?? null,
    latencyMs: overrides.latencyMs ?? null,
    requestSizeBytes: overrides.requestSizeBytes ?? null,
    responseSizeBytes: overrides.responseSizeBytes ?? null,
    providerResource: overrides.providerResource ?? { type: 'cloud_run_revision', labels: {} },
    providerLabels: overrides.providerLabels ?? {},
  }
}

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'

describe('unrecognizedAgentName', () => {
  it('names self-identified bots and agents by the name they give', () => {
    expect(unrecognizedAgentName({ userAgent: 'meta-externalfetcher/1.1' })).toBe('meta-externalfetcher')
    expect(unrecognizedAgentName({ userAgent: 'Example-User/1.0 (+https://agent.example/about)' })).toBe('example-user')
    expect(unrecognizedAgentName({ userAgent: 'Mozilla/5.0 (compatible; Example-User/1.0; +https://agent.example)' })).toBe('example-user')
    expect(unrecognizedAgentName({ userAgent: 'Mozilla/5.0 (X11) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 ExampleBot/2.0' })).toBe('examplebot')
    expect(unrecognizedAgentName({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36' })).toBe('headlesschrome')
    expect(unrecognizedAgentName({ userAgent: 'ExampleAgent/2.0', path: '/llms.txt', method: 'HEAD' })).toBe('exampleagent')
  })

  it('names nobody for browsers, generic HTTP tools, static files and writes', () => {
    for (const userAgent of [CHROME, 'Mozilla/5.0', 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Trident/5.0)', 'Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', 'curl/8.7.1', 'python-requests/2.32.3', 'Python/3.12 aiohttp/3.9.5', 'Go-http-client/2.0', 'node', '', null]) {
      expect(unrecognizedAgentName({ userAgent }), String(userAgent)).toBeNull()
    }
    expect(unrecognizedAgentName({ userAgent: 'ExampleAgent/2.0', path: '/hero.png' })).toBeNull()
    expect(unrecognizedAgentName({ userAgent: 'ExampleAgent/2.0', path: '/app.js?v=3' })).toBeNull()
    expect(unrecognizedAgentName({ userAgent: 'ExampleAgent/2.0', method: 'POST' })).toBeNull()
  })
})

describe('buildTrafficProbeReport unrecognized agents', () => {
  it('counts requests no rule recognizes by hour and name, keeping the latest sample', () => {
    const report = buildTrafficProbeReport([
      event({ userAgent: 'ExampleAgent/2.0', path: '/rooms', observedAt: '2026-05-01T12:05:00.000Z' }),
      event({ userAgent: 'ExampleAgent/2.1', path: '/rooms/1234', observedAt: '2026-05-01T12:40:00.000Z' }),
      event({ userAgent: 'ExampleAgent/2.1', path: '/', observedAt: '2026-05-01T13:10:00.000Z' }),
    ])
    expect(report.unrecognizedAgentEventsHourly).toEqual([
      { tsHour: '2026-05-01T12:00:00.000Z', agentName: 'exampleagent', hits: 2, sampledUserAgent: 'ExampleAgent/2.1', sampledPath: '/rooms/:id' },
      { tsHour: '2026-05-01T13:00:00.000Z', agentName: 'exampleagent', hits: 1, sampledUserAgent: 'ExampleAgent/2.1', sampledPath: '/' },
    ])
    expect(report.totals.unknownHits).toBe(3)
  })

  it('leaves out recognized bots, AI referrals and people', () => {
    const report = buildTrafficProbeReport([
      event({ userAgent: 'Mozilla/5.0 GPTBot/1.2' }),
      event({ userAgent: 'Mozilla/5.0 (compatible; Claude-User/1.0)' }),
      event({ userAgent: CHROME, referer: 'https://chatgpt.com/' }),
      event({ userAgent: CHROME }),
    ])
    expect(report.unrecognizedAgentEventsHourly).toEqual([])
  })

  it('keeps the busiest 200 names when a batch carries more', () => {
    const events = Array.from({ length: 205 }, (_, i) => event({ userAgent: `Agent${String(i).padStart(3, '0')}/1.0` }))
    events.push(event({ userAgent: 'Agent204/1.0' }))
    const names = new Set(buildTrafficProbeReport(events).unrecognizedAgentEventsHourly.map((bucket) => bucket.agentName))
    expect(names.size).toBe(200)
    expect(names.has('agent204')).toBe(true)
  })
})
