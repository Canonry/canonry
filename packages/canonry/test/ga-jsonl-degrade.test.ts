import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'

// Mock the API client so the GA command handlers run against canned DTOs and
// never touch the network. We assert the OUTPUT-FORMAT contract only: `jsonl`
// degrades to the same JSON document `json` emits (these are object/composite
// reads, not jsonl-streaming collections), while no-format stays human text.
const gaStatusMock = vi.fn()
const gaTrafficMock = vi.fn()
const gaAttributionTrendMock = vi.fn()
const gaSyncMock = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    gaStatus: gaStatusMock,
    gaTraffic: gaTrafficMock,
    gaAttributionTrend: gaAttributionTrendMock,
    gaSync: gaSyncMock,
  }),
}))

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  return { logs, restore: () => { console.log = origLog } }
}

async function run(fn: () => Promise<void>): Promise<string> {
  const { logs, restore } = captureLog()
  try {
    await fn()
  } finally {
    restore()
  }
  return logs.join('\n')
}

const TRAFFIC_DTO = {
  totalSessions: 100,
  totalOrganicSessions: 20,
  totalUsers: 80,
  totalDirectSessions: 30,
  aiSessionsDeduped: 12,
  aiUsersDeduped: 10,
  aiSessionsBySession: 5,
  aiUsersBySession: 4,
  socialSessions: 8,
  socialUsers: 6,
  aiSharePct: 12,
  aiSharePctBySession: 5,
  socialSharePct: 8,
  organicSharePct: 20,
  directSharePct: 30,
  organicSharePctDisplay: '20%',
  aiSharePctDisplay: '12%',
  aiSharePctBySessionDisplay: '5%',
  socialSharePctDisplay: '8%',
  directSharePctDisplay: '30%',
  otherSessions: 30,
  otherSharePct: 30,
  otherSharePctDisplay: '30%',
  socialSharePctDisplayUnused: undefined,
  channelBreakdown: {
    organic: { sessions: 20, sharePctDisplay: '20%' },
    social: { sessions: 8, sharePctDisplay: '8%' },
    direct: { sessions: 30, sharePctDisplay: '30%' },
    ai: { sessions: 5, sharePctDisplay: '5%' },
    other: { sessions: 30, sharePctDisplay: '30%' },
  },
  aiReferrals: [
    { source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session', sessions: 5, users: 4 },
  ],
  aiReferralLandingPages: [
    { landingPage: '/pricing', source: 'chatgpt.com', sourceDimension: 'session', sessions: 12, users: 10 },
  ],
  socialReferrals: [
    { source: 'reddit.com', medium: 'referral', channelGroup: 'Organic Social', sessions: 8, users: 6 },
  ],
  topPages: [
    { landingPage: '/', sessions: 50, organicSessions: 10, users: 40 },
  ],
  periodStart: '2026-05-01',
  periodEnd: '2026-05-30',
  lastSyncedAt: '2026-05-30T00:00:00.000Z',
}

describe('ga jsonl degrades to json for object/composite reads', () => {
  beforeEach(() => {
    gaStatusMock.mockReset()
    gaTrafficMock.mockReset()
    gaAttributionTrendMock.mockReset()
    gaSyncMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gaTraffic: --format jsonl emits the same JSON object as --format json', async () => {
    gaTrafficMock.mockResolvedValue(TRAFFIC_DTO)
    const { gaTraffic } = await import('../src/commands/ga.js')

    const jsonOut = await run(() => gaTraffic('p', { format: 'json' }))
    const jsonlOut = await run(() => gaTraffic('p', { format: 'jsonl' }))
    const humanOut = await run(() => gaTraffic('p', {}))

    // Both machine formats parse and are byte-identical documents.
    const jsonParsed = JSON.parse(jsonOut)
    const jsonlParsed = JSON.parse(jsonlOut)
    expect(jsonlParsed).toEqual(jsonParsed)
    expect(jsonlOut).toBe(jsonOut)
    expect(jsonParsed.totalSessions).toBe(100)

    // Human output is the decorated table, not JSON.
    expect(humanOut).toContain('GA4 Traffic for "p"')
    expect(() => JSON.parse(humanOut)).toThrow()
    expect(humanOut).not.toBe(jsonOut)
  })

  it('gaAttribution: --format jsonl emits the same JSON object as --format json', async () => {
    gaTrafficMock.mockResolvedValue(TRAFFIC_DTO)
    const { gaAttribution } = await import('../src/commands/ga.js')

    const jsonOut = await run(() => gaAttribution('p', { format: 'json' }))
    const jsonlOut = await run(() => gaAttribution('p', { format: 'jsonl' }))
    const humanOut = await run(() => gaAttribution('p', {}))

    const jsonParsed = JSON.parse(jsonOut)
    const jsonlParsed = JSON.parse(jsonlOut)
    expect(jsonlParsed).toEqual(jsonParsed)
    expect(jsonlOut).toBe(jsonOut)
    expect(jsonParsed.totalSessions).toBe(100)
    expect(jsonParsed.aiSessions).toBe(12)

    expect(humanOut).toContain('GA4 Attribution Overview for "p"')
    expect(() => JSON.parse(humanOut)).toThrow()
    expect(humanOut).not.toBe(jsonOut)
  })

  it('gaStatus: --format jsonl emits the same JSON object as --format json', async () => {
    const STATUS_DTO = {
      connected: true,
      propertyId: '999888',
      authMethod: 'service-account' as const,
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      lastSyncedAt: '2026-05-30T00:00:00.000Z',
      createdAt: '2026-05-01T00:00:00.000Z',
    }
    gaStatusMock.mockResolvedValue(STATUS_DTO)
    const { gaStatus } = await import('../src/commands/ga.js')

    const jsonOut = await run(() => gaStatus('p', 'json'))
    const jsonlOut = await run(() => gaStatus('p', 'jsonl'))
    const humanOut = await run(() => gaStatus('p'))

    expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonOut).propertyId).toBe('999888')

    expect(humanOut).toContain('GA4 for "p"')
    expect(() => JSON.parse(humanOut)).toThrow()
  })
})
