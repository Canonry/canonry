import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'

// Mock the API client so these are pure output-format tests — no server, no DB.
// Each command reads from createApiClient().<method> and we assert that the
// `jsonl` format degrades to the same JSON document `json` emits (a single
// object), and that human/text output is left untouched.
const mocks = {
  getGbpSummary: vi.fn(),
  listGbpMetrics: vi.fn(),
  listGbpAccounts: vi.fn(),
  listGbpKeywords: vi.fn(),
  listGbpPlaceActions: vi.fn(),
  listGbpLodging: vi.fn(),
  listGbpPlaces: vi.fn(),
  listGbpLocations: vi.fn(),
  googleConnect: vi.fn(),
  disconnectGbp: vi.fn(),
  triggerGbpSync: vi.fn(),
  setGbpLocationSelection: vi.fn(),
}

vi.mock('../src/client.js', () => ({
  createApiClient: () => mocks,
}))

import {
  gbpSummary,
  gbpMetrics,
  gbpAccounts,
  gbpKeywords,
  gbpPlaceActions,
  gbpLodging,
  gbpPlaces,
  gbpConnect,
  gbpDisconnect,
  gbpSync,
  gbpLocationSelect,
} from '../src/commands/gbp.js'

/** Capture every console.log emission joined by newline. */
async function capture(fn: () => Promise<void>): Promise<string> {
  let out = ''
  const orig = console.log
  console.log = (msg?: unknown) => { out += `${String(msg)}\n` }
  try {
    await fn()
  } finally {
    console.log = orig
  }
  return out
}

const SUMMARY = {
  scope: { locationName: 'locations/1', locationCount: 1 },
  freshness: { dataThroughDate: '2026-05-27', latestStoredDate: '2026-05-29', pendingDays: 2 },
  performance: { totals: { WEBSITE_CLICKS: 30 }, deltaPct: { WEBSITE_CLICKS: 10 } },
  keywords: { total: 5, thresholdedPct: 20 },
  placeActions: { total: 2, hasReservationCta: true, hasBookingCta: false, hasDirectMerchantCta: true },
  lodging: { lodgingLocationCount: 1, populatedLodgingCount: 1, emptyLodgingCount: 0 },
  timeseries: [],
}

const METRICS = { total: 1, metrics: [{ metric: 'WEBSITE_CLICKS', value: 30, locationName: 'locations/1', date: '2026-05-27' }] }
const ACCOUNTS = { total: 1, accounts: [{ name: 'accounts/123', accountName: 'Hotels', type: 'PERSONAL', role: 'OWNER' }] }

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.getGbpSummary.mockResolvedValue(SUMMARY)
  mocks.listGbpMetrics.mockResolvedValue(METRICS)
  mocks.listGbpAccounts.mockResolvedValue(ACCOUNTS)
  mocks.listGbpKeywords.mockResolvedValue({ total: 0, keywords: [], thresholdedPct: 0 })
  mocks.listGbpPlaceActions.mockResolvedValue({ total: 0, placeActions: [] })
  mocks.listGbpLodging.mockResolvedValue({ total: 0, lodging: [] })
  mocks.listGbpPlaces.mockResolvedValue({ total: 0, places: [] })
  mocks.googleConnect.mockResolvedValue({ authUrl: 'https://auth.example', redirectUri: 'https://cb.example' })
  mocks.disconnectGbp.mockResolvedValue(undefined)
  mocks.triggerGbpSync.mockResolvedValue({ runId: 'run-1', status: 'queued' })
  mocks.setGbpLocationSelection.mockResolvedValue({ locationName: 'locations/1', displayName: 'Hotel One', selected: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('gbp jsonl degrades to the json document', () => {
  it('gbp summary: jsonl emits the same JSON object as json (not the human scorecard)', async () => {
    const jsonOut = await capture(() => gbpSummary('hotels', { format: 'json' }))
    const jsonlOut = await capture(() => gbpSummary('hotels', { format: 'jsonl' }))

    // Both parse, and to the identical payload.
    const fromJson = JSON.parse(jsonOut)
    const fromJsonl = JSON.parse(jsonlOut)
    expect(fromJsonl).toEqual(fromJson)
    expect(fromJson).toEqual(SUMMARY)
    // jsonl must NOT fall through to the human scorecard text.
    expect(jsonlOut).not.toContain('GBP local-AEO summary')
  })

  it('gbp summary: default (text) output is unchanged human prose', async () => {
    const textOut = await capture(() => gbpSummary('hotels', {}))
    expect(textOut).toContain('GBP local-AEO summary')
    expect(textOut).toContain('Website clicks') // label, not raw key
    expect(textOut).not.toContain('WEBSITE_CLICKS')
    // Not JSON.
    expect(() => JSON.parse(textOut)).toThrow()
  })

  it('gbp metrics: jsonl == json', async () => {
    const fromJson = JSON.parse(await capture(() => gbpMetrics('hotels', { format: 'json' })))
    const fromJsonl = JSON.parse(await capture(() => gbpMetrics('hotels', { format: 'jsonl' })))
    expect(fromJsonl).toEqual(fromJson)
    expect(fromJson).toEqual(METRICS)
  })

  it('gbp accounts: jsonl == json', async () => {
    const fromJson = JSON.parse(await capture(() => gbpAccounts('hotels', { format: 'json' })))
    const fromJsonl = JSON.parse(await capture(() => gbpAccounts('hotels', { format: 'jsonl' })))
    expect(fromJsonl).toEqual(fromJson)
    expect(fromJson).toEqual(ACCOUNTS)
  })

  it('gbp keywords / place-actions / lodging / places: jsonl == json', async () => {
    for (const [fn, mock] of [
      [() => gbpKeywords('hotels', { format: 'jsonl' }), () => gbpKeywords('hotels', { format: 'json' })],
      [() => gbpPlaceActions('hotels', { format: 'jsonl' }), () => gbpPlaceActions('hotels', { format: 'json' })],
      [() => gbpLodging('hotels', { format: 'jsonl' }), () => gbpLodging('hotels', { format: 'json' })],
      [() => gbpPlaces('hotels', { format: 'jsonl' }), () => gbpPlaces('hotels', { format: 'json' })],
    ] as const) {
      const fromJsonl = JSON.parse(await capture(fn))
      const fromJson = JSON.parse(await capture(mock))
      expect(fromJsonl).toEqual(fromJson)
    }
  })

  it('gbp connect: jsonl emits the connect JSON, not the human auth-URL block', async () => {
    const expected = { project: 'hotels', type: 'gbp', authUrl: 'https://auth.example', redirectUri: 'https://cb.example' }
    const fromJson = JSON.parse(await capture(() => gbpConnect('hotels', { format: 'json' })))
    const fromJsonl = JSON.parse(await capture(() => gbpConnect('hotels', { format: 'jsonl' })))
    expect(fromJsonl).toEqual(fromJson)
    expect(fromJson).toEqual(expected)
  })

  it('gbp disconnect: jsonl == json', async () => {
    const fromJson = JSON.parse(await capture(() => gbpDisconnect('hotels', { format: 'json' })))
    const fromJsonl = JSON.parse(await capture(() => gbpDisconnect('hotels', { format: 'jsonl' })))
    expect(fromJsonl).toEqual(fromJson)
    expect(fromJson).toEqual({ project: 'hotels', disconnected: true })
  })

  it('gbp sync (no --wait): jsonl == json', async () => {
    const fromJson = JSON.parse(await capture(() => gbpSync('hotels', { format: 'json' })))
    const fromJsonl = JSON.parse(await capture(() => gbpSync('hotels', { format: 'jsonl' })))
    expect(fromJsonl).toEqual(fromJson)
    expect(fromJson).toEqual({ runId: 'run-1', status: 'queued' })
  })

  it('gbp locations select: jsonl == json', async () => {
    const fromJson = JSON.parse(await capture(() => gbpLocationSelect('hotels', { location: 'locations/1', format: 'json' })))
    const fromJsonl = JSON.parse(await capture(() => gbpLocationSelect('hotels', { location: 'locations/1', format: 'jsonl' })))
    expect(fromJsonl).toEqual(fromJson)
    expect(fromJson).toEqual({ locationName: 'locations/1', displayName: 'Hotel One', selected: true })
  })
})
