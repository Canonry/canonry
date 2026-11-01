import { describe, expect, it } from 'vitest'
import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type NormalizedTrafficRequest,
} from '@canonry/canonry-contracts'
import {
  buildTrafficProbeReport,
  findScannerBursts,
  findScannerBurstsInBatch,
  SCANNER_BURST_WINDOW_MS,
  type ScannerProbeWindow,
} from '../src/index.js'
import chatgptUserRanges from '../src/ip-ranges/chatgpt-user.json' with { type: 'json' }
import { firstPublishedIp } from './fixtures/vendored-ranges.js'

const CHATGPT_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot'
const CHATGPT_ODD_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)'
const CLAUDE_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)'
const PERPLEXITY_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)'
// RFC 5737 documentation space: no publisher can list it.
const SCANNER_IP = '203.0.113.9'
const OTHER_IP = '198.51.100.7'
const VERIFIED_IP = firstPublishedIp(chatgptUserRanges, 4)
const START = Date.parse('2026-11-01T03:57:00.000Z')
const MINUTE = 60_000

function request(eventId: string, minutes: number, overrides: Partial<NormalizedTrafficRequest> = {}): NormalizedTrafficRequest {
  return {
    sourceType: TrafficSourceTypes.cloudflare,
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId,
    observedAt: new Date(START + minutes * MINUTE).toISOString(),
    method: 'GET',
    requestUrl: null,
    host: 'example.com',
    path: '/',
    queryString: null,
    status: 200,
    userAgent: CLAUDE_UA,
    remoteIp: SCANNER_IP,
    referer: null,
    latencyMs: null,
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: { type: 'cloudflare_worker', labels: {} },
    providerLabels: {},
    ...overrides,
  }
}

const byIp = { clientKey: (remoteIp: string) => remoteIp }

describe('findScannerBursts', () => {
  it('marks every agent the client posed as within the window of its probe, and nothing else', () => {
    const batch = [
      request('before', -SCANNER_BURST_WINDOW_MS / MINUTE),
      request('probe', 0, { path: '/firebase-credentials.json', status: 302 }),
      request('redirect', 0.01, { path: '/404' }),
      request('as-perplexity', 0.02, { path: '/account', userAgent: PERPLEXITY_UA }),
      request('as-chatgpt', 1, { path: '/pricing', userAgent: CHATGPT_UA }),
      request('after', SCANNER_BURST_WINDOW_MS / MINUTE),
      request('too-late', SCANNER_BURST_WINDOW_MS / MINUTE + 0.1),
      request('other-ip', 0.5, { remoteIp: OTHER_IP }),
      request('no-ip', 0.5, { remoteIp: null }),
      request('browser', 0.5, { userAgent: 'Mozilla/5.0 (Macintosh)' }),
    ]
    const bursts = findScannerBursts(batch, byIp)
    expect([...bursts.eventIds].sort()).toEqual(['after', 'as-chatgpt', 'as-perplexity', 'before', 'redirect'])
    expect(bursts.windows).toEqual(new Map([[SCANNER_IP, { firstProbeAt: START, lastProbeAt: START }]]))
    expect(findScannerBurstsInBatch(batch)).toEqual(bursts.eventIds)
  })

  it('never marks or learns from a verified request', () => {
    const batch = [
      // Through the operator's own IP, a person asked for the file.
      request('verified-probe', 0, { path: '/.env', remoteIp: VERIFIED_IP, userAgent: CHATGPT_UA }),
      request('verified-page', 1, { remoteIp: VERIFIED_IP, userAgent: CHATGPT_UA }),
      request('probe', 2, { path: '/.git/config' }),
      request('verified-from-scanner-time', 3, { remoteIp: VERIFIED_IP, userAgent: CHATGPT_UA }),
    ]
    const bursts = findScannerBursts(batch, byIp)
    expect([...bursts.eventIds]).toEqual([])
    expect([...bursts.windows.keys()]).toEqual([SCANNER_IP])
  })

  it('keeps the reason of a request already judged likely fake', () => {
    const batch = [
      request('probe', 0, { path: '/.env' }),
      request('odd-user-agent', 1, { userAgent: CHATGPT_ODD_UA }),
    ]
    expect(findScannerBurstsInBatch(batch)).toEqual(new Set())
    const report = buildTrafficProbeReport(batch)
    expect(report.aiUserFetchLikelyFakeHourly.map(bucket => [bucket.botId, bucket.reason])).toEqual([
      ['claude-user', 'scanner-path'],
      ['openai-chatgpt-user', 'unusual-user-agent'],
    ])
  })

  it('chains probes into one window and skips clients the key leaves out', () => {
    const batch = [
      request('probe-1', 0, { path: '/.env' }),
      request('probe-2', 8, { path: '/secrets.json' }),
      request('probe-3', 16, { path: '/id_rsa' }),
      request('between', 12),
      request('skipped', 12, { remoteIp: OTHER_IP, path: '/.env' }),
    ]
    const bursts = findScannerBursts(batch, { clientKey: ip => (ip === OTHER_IP ? null : `key:${ip}`) })
    expect(bursts.windows).toEqual(new Map([[`key:${SCANNER_IP}`, { firstProbeAt: START, lastProbeAt: START + 16 * MINUTE }]]))
    expect([...bursts.eventIds]).toEqual(['between'])
  })

  it('reads the same pushed one request at a time as in one batch, for requests after the first probe', () => {
    const traffic = [
      request('recon', 0),
      request('probe', 1, { path: '/.aws/credentials' }),
      request('page', 2, { path: '/404' }),
      request('as-perplexity', 3, { path: '/account', userAgent: PERPLEXITY_UA }),
      request('probe-2', 14, { path: '/.git/config' }),
      request('late', 20),
    ]
    const store = new Map<string, ScannerProbeWindow>()
    const marked = new Set<string>()
    for (const event of traffic) {
      const bursts = findScannerBursts([event], { ...byIp, known: clients => new Map(clients.flatMap(client => (store.has(client) ? [[client, store.get(client)!] as const] : []))) })
      for (const id of bursts.eventIds) marked.add(id)
      for (const [client, window] of bursts.windows) store.set(client, window)
    }
    // Only the request sent before the first probe, in an earlier push, is missed.
    expect([...marked].sort()).toEqual(['as-perplexity', 'late', 'page'])
    expect([...findScannerBurstsInBatch(traffic)].sort()).toEqual(['as-perplexity', 'late', 'page', 'recon'])
    // The probes are 13 minutes apart, so the store keeps the second run only.
    expect(store.get(SCANNER_IP)).toEqual({ firstProbeAt: START + 14 * MINUTE, lastProbeAt: START + 14 * MINUTE })
  })

  it('keeps the latest burst: a newer one replaces a stored window, an older one leaves it', () => {
    const stored = { firstProbeAt: START, lastProbeAt: START }
    const known = () => new Map([[SCANNER_IP, stored]])
    const newer = findScannerBursts([request('probe', 60, { path: '/.env' })], { ...byIp, known })
    expect(newer.windows.get(SCANNER_IP)).toEqual({ firstProbeAt: START + 60 * MINUTE, lastProbeAt: START + 60 * MINUTE })
    const older = findScannerBursts([request('probe', -60, { path: '/.env' }), request('near-old', -55)], { ...byIp, known })
    expect(older.windows.size).toBe(0)
    expect([...older.eventIds]).toEqual(['near-old'])
    const extends_ = findScannerBursts([request('probe', 5, { path: '/.env' })], { ...byIp, known })
    expect(extends_.windows.get(SCANNER_IP)).toEqual({ firstProbeAt: START, lastProbeAt: START + 5 * MINUTE })
    // A repeat of a stored probe changes nothing.
    expect(findScannerBursts([request('probe', 0, { path: '/.env' })], { ...byIp, known }).windows.size).toBe(0)
  })
})
