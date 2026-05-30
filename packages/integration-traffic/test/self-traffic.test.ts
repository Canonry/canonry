import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type NormalizedTrafficRequest,
} from '@ainyc/canonry-contracts'
import { describe, expect, it } from 'vitest'
import { buildTrafficProbeReport, isSelfTraffic } from '../src/index.js'

function event(overrides: Partial<NormalizedTrafficRequest>): NormalizedTrafficRequest {
  return {
    sourceType: TrafficSourceTypes['cloud-run'],
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId: overrides.eventId ?? crypto.randomUUID(),
    observedAt: overrides.observedAt ?? '2026-05-29T12:30:00.000Z',
    method: overrides.method ?? 'GET',
    requestUrl: overrides.requestUrl ?? 'https://example.com/',
    host: overrides.host ?? 'example.com',
    path: overrides.path ?? '/',
    queryString: overrides.queryString ?? null,
    status: overrides.status ?? 200,
    userAgent: overrides.userAgent ?? 'Mozilla/5.0',
    remoteIp: overrides.remoteIp ?? null,
    referer: overrides.referer ?? null,
    latencyMs: overrides.latencyMs ?? null,
    requestSizeBytes: overrides.requestSizeBytes ?? null,
    responseSizeBytes: overrides.responseSizeBytes ?? null,
    providerResource: overrides.providerResource ?? { type: 'cloud_run_revision', labels: {} },
    providerLabels: overrides.providerLabels ?? {},
  }
}

describe('isSelfTraffic', () => {
  it('matches Canonry AEO auditor user agents', () => {
    expect(isSelfTraffic(event({ userAgent: 'AINYC-AEO-Audit/1.0' }))).toBe(true)
  })

  it('does not match real visitors, real crawlers, or empty UAs', () => {
    expect(isSelfTraffic(event({ userAgent: 'Mozilla/5.0' }))).toBe(false)
    expect(isSelfTraffic(event({ userAgent: 'Mozilla/5.0 GPTBot/1.2' }))).toBe(false)
    expect(isSelfTraffic(event({ userAgent: '' }))).toBe(false)
    // A UA that merely mentions the brand is not swept up (pattern is specific).
    expect(isSelfTraffic(event({ userAgent: 'canonry-fan/1.0' }))).toBe(false)
  })
})

describe('buildTrafficProbeReport self-traffic exclusion', () => {
  it('drops self-traffic from totals, hit counts, and samples', () => {
    const events = [
      event({ eventId: 'self-1', userAgent: 'AINYC-AEO-Audit/1.0', path: '/sitemap.xml' }),
      event({ eventId: 'self-2', userAgent: 'AINYC-AEO-Audit/1.0', path: '/llms.txt' }),
      event({ eventId: 'bot-1', userAgent: 'Mozilla/5.0 GPTBot/1.2', path: '/rooms' }),
      event({ eventId: 'human-1', userAgent: 'Mozilla/5.0', path: '/' }),
    ]

    const report = buildTrafficProbeReport(events)

    // Two self-audit hits dropped; only the real crawler + the human remain.
    expect(report.totals.selfTrafficExcluded).toBe(2)
    expect(report.totals.normalizedEvents).toBe(2)
    expect(report.totals.crawlerHits).toBe(1)
    expect(report.totals.unknownHits).toBe(1)

    // No sample carries the auditor UA.
    expect(report.samples).toHaveLength(2)
    expect(report.samples.some((s) => s.userAgent === 'AINYC-AEO-Audit/1.0')).toBe(false)

    // The real crawler bucket is unaffected by the exclusion.
    expect(report.crawlerEventsHourly).toHaveLength(1)
    expect(report.crawlerEventsHourly[0]?.botId).toBe('openai-gptbot')
  })

  it('reports zero exclusions when no self-traffic is present', () => {
    const report = buildTrafficProbeReport([event({ userAgent: 'Mozilla/5.0' })])
    expect(report.totals.selfTrafficExcluded).toBe(0)
    expect(report.totals.normalizedEvents).toBe(1)
  })
})
