import { describe, expect, it } from 'vitest'
import { TrafficEventConfidences, TrafficEvidenceKinds, TrafficSourceTypes, type NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { extractAgentJourneyRequests } from '../src/index.js'

function request(id: string, overrides: Partial<NormalizedTrafficRequest> = {}): NormalizedTrafficRequest {
  return {
    sourceType: TrafficSourceTypes['cloud-run'], evidenceKind: TrafficEvidenceKinds['raw-request'], confidence: TrafficEventConfidences.observed,
    eventId: id, observedAt: '2026-10-27T10:00:00Z', method: 'GET', requestUrl: 'https://example.com/', host: 'example.com', path: '/',
    queryString: null, status: 200, userAgent: 'ChatGPT-User/1.0', remoteIp: '198.51.100.20', referer: null,
    latencyMs: null, requestSizeBytes: null, responseSizeBytes: null, providerResource: { type: null, labels: {} }, providerLabels: {},
    ...overrides,
  }
}

describe('observed agent request extraction', () => {
  it('keeps user-triggered pages, API responses, documents and failures without promoting crawlers or referrals', () => {
    const rows = extractAgentJourneyRequests([
      request('page'), request('data', { path: '/api/availability.json', method: 'POST' }),
      request('document', { path: '/menu.pdf' }), request('blocked', { method: 'HEAD', status: 403 }),
      request('asset', { path: '/app.css' }), request('crawler', { userAgent: 'GPTBot/1.0' }),
      request('referral', { userAgent: 'Mozilla/5.0', referer: 'https://chatgpt.com/' }),
      request('self', { userAgent: 'AINYC-AEO-Audit/1.0 ChatGPT-User/1.0' }), request('invalid-time', { observedAt: 'invalid' }),
    ])
    expect(rows.map(row => row.sourceEventId)).toEqual(['page', 'data', 'document', 'blocked'])
    expect(rows.map(row => [row.method, row.status])).toEqual([['GET', 200], ['POST', 200], ['GET', 200], ['HEAD', 403]])
    expect(rows[0]).toMatchObject({ agentId: 'openai-chatgpt-user', operator: 'OpenAI', product: 'ChatGPT-User', verificationStatus: 'claimed_unverified' })
  })

  it('removes query and fragment secrets, masks sensitive path segments, and preserves missing evidence', () => {
    const [row, truncated] = extractAgentJourneyRequests([request('private', {
      path: '/reset/person%40example.com/123e4567-e89b-12d3-a456-426614174000?token=secret#key',
      queryString: 'token=secret', observedAt: '2026-10-27T06:00:00-04:00', host: 'WWW.EXAMPLE.COM',
      remoteIp: null, status: null, method: null, latencyMs: -1,
    }), request('long-path', { path: '/page'.repeat(140) })])
    expect(row).toMatchObject({ path: '/reset/:email/:token', host: 'example.com', ts: '2026-10-27T10:00:00.000Z', remoteIp: null, status: null, method: null, latencyMs: null })
    expect(row?.verificationStatus).toBe('claimed_unverified')
    expect(truncated?.path).toBe(`${'/page'.repeat(101)}/:token`)
  })
})
