import { describe, expect, it } from 'vitest'
import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type CloudflareWorkerEvent,
} from '@ainyc/canonry-contracts'
import { normalizeCloudflareWorkerEvent } from '../src/normalize.js'

const FULL_EVENT: CloudflareWorkerEvent = {
  eventId: '8a3d2b0c-cf-ray',
  observedAt: '2026-05-27T15:30:00.123Z',
  method: 'GET',
  host: 'example.com',
  path: '/blog/post',
  queryString: 'utm_source=chatgpt',
  status: 200,
  userAgent: 'GPTBot/1.2',
  remoteIp: '20.171.207.34',
  referer: 'https://chat.openai.com/',
  cf: {
    verifiedBot: true,
    botScore: 30,
    country: 'US',
    asn: 8075,
    asOrganization: 'Microsoft Corporation',
  },
}

describe('normalizeCloudflareWorkerEvent', () => {
  it('produces a NormalizedTrafficRequest tagged with the cloudflare source type', () => {
    const result = normalizeCloudflareWorkerEvent(FULL_EVENT)
    expect(result).not.toBeNull()
    expect(result?.sourceType).toBe(TrafficSourceTypes.cloudflare)
    expect(result?.evidenceKind).toBe(TrafficEvidenceKinds['raw-request'])
    expect(result?.confidence).toBe(TrafficEventConfidences.observed)
  })

  it('reconstructs the full request URL when host and queryString are present', () => {
    const result = normalizeCloudflareWorkerEvent(FULL_EVENT)
    expect(result?.requestUrl).toBe('https://example.com/blog/post?utm_source=chatgpt')
  })

  it('returns a null requestUrl when host is missing', () => {
    const result = normalizeCloudflareWorkerEvent({ ...FULL_EVENT, host: null })
    expect(result?.requestUrl).toBeNull()
    expect(result?.host).toBeNull()
    expect(result?.path).toBe('/blog/post')
  })

  it('omits the query string from requestUrl when queryString is null', () => {
    const result = normalizeCloudflareWorkerEvent({ ...FULL_EVENT, queryString: null })
    expect(result?.requestUrl).toBe('https://example.com/blog/post')
  })

  it('preserves remoteIp so IP-range verification can promote claimed → verified', () => {
    const result = normalizeCloudflareWorkerEvent(FULL_EVENT)
    expect(result?.remoteIp).toBe('20.171.207.34')
  })

  it('passes verifiedBot through provider labels for downstream classification', () => {
    const result = normalizeCloudflareWorkerEvent(FULL_EVENT)
    expect(result?.providerLabels.verifiedBot).toBe('true')
    expect(result?.providerLabels.botScore).toBe('30')
    expect(result?.providerLabels.country).toBe('US')
    expect(result?.providerLabels.asn).toBe('8075')
    expect(result?.providerLabels.asOrganization).toBe('Microsoft Corporation')
  })

  it('handles cf=null without dropping the event', () => {
    const result = normalizeCloudflareWorkerEvent({ ...FULL_EVENT, cf: null })
    expect(result).not.toBeNull()
    expect(result?.providerLabels).toEqual({})
  })

  it('omits null cf.* properties from provider labels', () => {
    const result = normalizeCloudflareWorkerEvent({
      ...FULL_EVENT,
      cf: { verifiedBot: null, botScore: 30, country: null, asn: null, asOrganization: null },
    })
    expect(result?.providerLabels).toEqual({ botScore: '30' })
  })

  it('returns null when path is missing (defensive — schema already enforces)', () => {
    const result = normalizeCloudflareWorkerEvent({ ...FULL_EVENT, path: '' })
    expect(result).toBeNull()
  })

  it('returns null when observedAt is missing', () => {
    const result = normalizeCloudflareWorkerEvent({ ...FULL_EVENT, observedAt: '' })
    expect(result).toBeNull()
  })

  it('returns null when eventId is missing', () => {
    const result = normalizeCloudflareWorkerEvent({ ...FULL_EVENT, eventId: '' })
    expect(result).toBeNull()
  })

  it('namespaces the eventId so it cannot collide with other adapters', () => {
    const result = normalizeCloudflareWorkerEvent(FULL_EVENT)
    expect(result?.eventId).toBe('cloudflare-worker:8a3d2b0c-cf-ray')
  })

  it('sets the providerResource type to cloudflare_zone', () => {
    const result = normalizeCloudflareWorkerEvent(FULL_EVENT)
    expect(result?.providerResource.type).toBe('cloudflare_zone')
  })

  it('threads requestSizeBytes/responseSizeBytes/latencyMs as null (Worker has no native source)', () => {
    const result = normalizeCloudflareWorkerEvent(FULL_EVENT)
    expect(result?.requestSizeBytes).toBeNull()
    expect(result?.responseSizeBytes).toBeNull()
    expect(result?.latencyMs).toBeNull()
  })

  it('empties strings (host, queryString) are treated as absent in providerLabels', () => {
    const result = normalizeCloudflareWorkerEvent({
      ...FULL_EVENT,
      cf: { verifiedBot: false, botScore: 99, country: '', asn: 0, asOrganization: '' },
    })
    expect(result?.providerLabels.country).toBeUndefined()
    expect(result?.providerLabels.asOrganization).toBeUndefined()
    expect(result?.providerLabels.verifiedBot).toBe('false')
    expect(result?.providerLabels.botScore).toBe('99')
    expect(result?.providerLabels.asn).toBe('0')
  })
})
