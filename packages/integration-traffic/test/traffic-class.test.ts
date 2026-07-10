import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type NormalizedTrafficRequest,
} from '@ainyc/canonry-contracts'
import { describe, expect, it } from 'vitest'
import {
  buildTrafficProbeReport,
  classifyAiReferral,
  classifyAiReferralTrafficClassFromEvent,
} from '../src/index.js'

function event(overrides: Partial<NormalizedTrafficRequest>): NormalizedTrafficRequest {
  return {
    sourceType: TrafficSourceTypes['cloud-run'],
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId: overrides.eventId ?? crypto.randomUUID(),
    observedAt: overrides.observedAt ?? '2026-06-15T12:30:00.000Z',
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

describe('classifyAiReferralTrafficClassFromEvent', () => {
  it('reads paid intent from utm_medium on the request query string', () => {
    // The exact ChatGPT-ads shape: engine identified by referer host, paid-ness
    // carried by utm_medium=cpc on the request — the field the classifier did
    // not previously read.
    expect(classifyAiReferralTrafficClassFromEvent(event({
      referer: 'https://chatgpt.com/',
      queryString: 'utm_source=chatgpt&utm_medium=cpc&utm_campaign=openai_ads',
    }))).toBe('paid')
  })

  it('reads paid intent from the referer query string for edge-cached sub-resources', () => {
    // The landing HTML is served from the CDN; only the sub-resource reaches the
    // origin, carrying the landing UTMs on ITS referer.
    expect(classifyAiReferralTrafficClassFromEvent(event({
      path: '/_next/static/chunk.js',
      referer: 'https://example.com/pricing?utm_source=chatgpt&utm_medium=cpc',
      queryString: null,
    }))).toBe('paid')
  })

  it('is organic when an AI referral carries no paid UTM tags', () => {
    expect(classifyAiReferralTrafficClassFromEvent(event({
      referer: 'https://chatgpt.com/',
      queryString: 'utm_source=chatgpt',
    }))).toBe('organic')
    expect(classifyAiReferralTrafficClassFromEvent(event({ referer: 'https://chatgpt.com/' }))).toBe('organic')
  })
})

describe('classifyAiReferral traffic class', () => {
  it('stamps the class on the classified referral for every evidence tier', () => {
    const paidReferer = classifyAiReferral(event({
      referer: 'https://chatgpt.com/',
      queryString: 'utm_medium=cpc',
    }))
    expect(paidReferer).toMatchObject({ evidenceType: 'referer', trafficClass: 'paid' })

    const organicUtm = classifyAiReferral(event({
      referer: null,
      queryString: 'utm_source=perplexity',
    }))
    expect(organicUtm).toMatchObject({ evidenceType: 'utm', trafficClass: 'organic' })
  })
})

describe('buildTrafficProbeReport referral class split', () => {
  it('splits the bucket measure so paidHits + organicHits === hits', () => {
    // Three distinct actors (distinct IPs) so each is its own session, all
    // landing on the same path in the same hour → one bucket, three sessions.
    const events = [
      event({ eventId: 'a', remoteIp: '1.1.1.1', path: '/pricing', referer: 'https://chatgpt.com/', queryString: 'utm_medium=cpc' }),
      event({ eventId: 'b', remoteIp: '2.2.2.2', path: '/pricing', referer: 'https://chatgpt.com/', queryString: 'utm_medium=cpc' }),
      event({ eventId: 'c', remoteIp: '3.3.3.3', path: '/pricing', referer: 'https://chatgpt.com/', queryString: null }),
    ]
    const report = buildTrafficProbeReport(events)

    expect(report.totals.aiReferralSessions).toBe(3)
    expect(report.totals.aiReferralPaidSessions).toBe(2)
    expect(report.totals.aiReferralOrganicSessions).toBe(1)

    expect(report.aiReferralEventsHourly).toHaveLength(1)
    const bucket = report.aiReferralEventsHourly[0]
    expect(bucket.hits).toBe(3)
    expect(bucket.paidHits).toBe(2)
    expect(bucket.organicHits).toBe(1)
    expect(bucket.paidHits + bucket.organicHits).toBe(bucket.hits)
  })

  it('classes a whole session paid when any hit in it is paid, and merges across window hits', () => {
    // One actor, one session window: the landing request carries the ad UTMs,
    // the follow-up sub-resource carries none. The session must be paid, not
    // downgraded to organic by the later tag-less hit.
    const events = [
      event({ eventId: 'land', remoteIp: '9.9.9.9', path: '/pricing', referer: 'https://chatgpt.com/', queryString: 'utm_medium=cpc', observedAt: '2026-06-15T12:30:00.000Z' }),
      event({ eventId: 'sub', remoteIp: '9.9.9.9', path: '/pricing', referer: 'https://chatgpt.com/', queryString: null, observedAt: '2026-06-15T12:30:05.000Z' }),
    ]
    const report = buildTrafficProbeReport(events)

    expect(report.totals.aiReferralSessions).toBe(1)
    expect(report.totals.aiReferralPaidSessions).toBe(1)
    expect(report.totals.aiReferralOrganicSessions).toBe(0)
    expect(report.aiReferralEventsHourly[0]).toMatchObject({ hits: 1, paidHits: 1, organicHits: 0 })
  })

  it('reports zero paid and zero organic when there are no referrals', () => {
    const report = buildTrafficProbeReport([event({ userAgent: 'Mozilla/5.0 GPTBot/1.2' })])
    expect(report.totals.aiReferralSessions).toBe(0)
    expect(report.totals.aiReferralPaidSessions).toBe(0)
    expect(report.totals.aiReferralOrganicSessions).toBe(0)
  })
})
