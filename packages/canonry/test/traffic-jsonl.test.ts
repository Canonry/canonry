import { describe, expect, it, beforeEach, vi } from 'vitest'
import type {
  TrafficEventsResponse,
  TrafficSourceListResponse,
  TrafficStatusResponse,
} from '@ainyc/canonry-contracts'

const mockTrafficListEvents = vi.fn()
const mockTrafficListSources = vi.fn()
const mockTrafficStatus = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    trafficListEvents: mockTrafficListEvents,
    trafficListSources: mockTrafficListSources,
    trafficStatus: mockTrafficStatus,
  }),
}))

/** Capture `process.stdout.write` (the jsonl path) rather than console.log. */
function captureStdout(fn: () => Promise<void>): { run: Promise<void>; lines: () => string[] } {
  let buf = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    buf += String(chunk)
    return true
  })
  const run = fn().finally(() => spy.mockRestore())
  return { run, lines: () => buf.split('\n').filter(Boolean) }
}

/** Capture `console.log` (the json envelope path). */
async function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  try {
    await fn()
  } finally {
    console.log = origLog
  }
  return logs.join('\n')
}

const { trafficEvents, trafficSources, trafficStatus } = await import('../src/commands/traffic.js')

const eventsResponse: TrafficEventsResponse = {
  windowStart: '2026-05-01T00:00:00.000Z',
  windowEnd: '2026-05-02T00:00:00.000Z',
  series: {
    granularity: 'day',
    points: [{
      bucket: '2026-05-01',
      crawlerHits: 5,
      aiUserFetchHits: 2,
      aiReferralHits: 1,
    }],
  },
  totals: {
    crawlerHits: 5,
    crawlerContentHits: 3,
    crawlerInfraHits: 2,
    crawlerSegments: { content: 3, sitemap: 2, robots: 0, asset: 0, other: 0 },
    aiUserFetchHits: 2,
    aiReferralHits: 1,
    aiReferralPaidHits: 0,
    aiReferralOrganicHits: 1,
    aiReferralUnknownHits: 0,
  },
  eventRows: { total: 2, returned: 2, truncated: false },
  events: [
    {
      kind: 'crawler',
      sourceId: 'src_1',
      tsHour: '2026-05-01T03:00:00.000Z',
      botId: 'GPTBot',
      operator: 'OpenAI',
      verificationStatus: 'verified',
      pathNormalized: '/about',
      pathClass: 'content',
      status: 200,
      hits: 3,
    },
    {
      kind: 'ai-referral',
      sourceId: 'src_1',
      tsHour: '2026-05-01T04:00:00.000Z',
      product: 'chatgpt',
      operator: 'OpenAI',
      sourceDomain: 'chatgpt.com',
      evidenceType: 'referer',
      landingPathNormalized: '/pricing',
      status: 200,
      hits: 1,
    },
  ],
}

const sourceA = {
  id: 'src_1',
  projectId: 'proj_1',
  sourceType: 'cloud-run' as const,
  status: 'active' as const,
  displayName: 'Prod Cloud Run',
  lastSyncedAt: '2026-05-01T12:00:00.000Z',
  lastError: null,
  config: { gcpProjectId: 'gcp-prod' },
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-05-01T12:00:00.000Z',
}

const sourceB = {
  id: 'src_2',
  projectId: 'proj_1',
  sourceType: 'wordpress' as const,
  status: 'active' as const,
  displayName: 'Blog WP',
  lastSyncedAt: null,
  lastError: null,
  config: { baseUrl: 'https://blog.example.com', username: 'svc' },
  createdAt: '2026-04-15T00:00:00.000Z',
  updatedAt: '2026-04-15T00:00:00.000Z',
}

const sourcesResponse: TrafficSourceListResponse = {
  sources: [sourceA, sourceB] as unknown as TrafficSourceListResponse['sources'],
}

const statusResponse: TrafficStatusResponse = {
  sources: [
    {
      ...sourceA,
      totals24h: {
        crawlerHits: 10,
        crawlerContentHits: 7,
        crawlerInfraHits: 3,
        crawlerSegments: { content: 7, sitemap: 2, robots: 1, asset: 0, other: 0 },
        aiUserFetchHits: 4,
        aiReferralHits: 2,
        sampleCount: 6,
      },
      latestRun: {
        runId: 'run_1',
        status: 'completed',
        startedAt: '2026-05-01T11:00:00.000Z',
        finishedAt: '2026-05-01T11:05:00.000Z',
        error: null,
      },
    },
    {
      ...sourceB,
      totals24h: {
        crawlerHits: 0,
        crawlerContentHits: 0,
        crawlerInfraHits: 0,
        crawlerSegments: { content: 0, sitemap: 0, robots: 0, asset: 0, other: 0 },
        aiUserFetchHits: 0,
        aiReferralHits: 0,
        sampleCount: 0,
      },
      latestRun: null,
    },
  ] as unknown as TrafficStatusResponse['sources'],
}

describe('traffic jsonl output', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('trafficEvents', () => {
    it('format=jsonl emits one self-contained event per line, stamped with project + window', async () => {
      mockTrafficListEvents.mockResolvedValue(eventsResponse)
      const cap = captureStdout(() => trafficEvents('demo', { format: 'jsonl' }))
      await cap.run
      const lines = cap.lines()
      expect(lines).toHaveLength(2)
      const records = lines.map(l => JSON.parse(l))
      // Every line parses on its own and carries the injected envelope context.
      for (const record of records) {
        expect(record.project).toBe('demo')
        expect(record.windowStart).toBe('2026-05-01T00:00:00.000Z')
        expect(record.windowEnd).toBe('2026-05-02T00:00:00.000Z')
      }
      // The record's own discriminant fields win (spread last). Crawler rows
      // carry the per-event path class so an agent can segment from jsonl.
      expect(records[0]).toMatchObject({ kind: 'crawler', sourceId: 'src_1', botId: 'GPTBot', pathClass: 'content' })
      expect(records[1]).toMatchObject({ kind: 'ai-referral', sourceDomain: 'chatgpt.com' })
    })

    it('format=text surfaces the content / infra / other crawler split', async () => {
      mockTrafficListEvents.mockResolvedValue(eventsResponse)
      const out = await captureLog(() => trafficEvents('demo', {}))
      expect(out).toContain('Content crawls (window):       3')
      expect(out).toContain('Infra fetches (window):        2  (sitemap 2 · robots 0 · asset 0)')
      expect(out).toContain('Other fetches (window):        0')
      expect(out).toContain('Crawler hits total (window):   5')
      // per-event path class is rendered next to the path
      expect(out).toContain('/about [content]')
    })

    it('format=jsonl writes nothing for an empty event collection', async () => {
      mockTrafficListEvents.mockResolvedValue({
        windowStart: '2026-05-01T00:00:00.000Z',
        windowEnd: '2026-05-02T00:00:00.000Z',
        series: { granularity: 'day', points: [] },
        totals: {
          crawlerHits: 0,
          crawlerContentHits: 0,
          crawlerInfraHits: 0,
          crawlerSegments: { content: 0, sitemap: 0, robots: 0, asset: 0, other: 0 },
          aiUserFetchHits: 0,
          aiReferralHits: 0,
          aiReferralPaidHits: 0,
          aiReferralOrganicHits: 0,
          aiReferralUnknownHits: 0,
        },
        eventRows: { total: 0, returned: 0, truncated: false },
        events: [],
      } satisfies TrafficEventsResponse)
      const cap = captureStdout(() => trafficEvents('demo', { format: 'jsonl' }))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('format=json is unchanged — the full envelope is emitted verbatim', async () => {
      mockTrafficListEvents.mockResolvedValue(eventsResponse)
      const out = await captureLog(() => trafficEvents('demo', { format: 'json' }))
      expect(JSON.parse(out)).toEqual(eventsResponse)
    })
  })

  describe('trafficSources', () => {
    it('format=jsonl emits one self-contained source per line, stamped with project', async () => {
      mockTrafficListSources.mockResolvedValue(sourcesResponse)
      const cap = captureStdout(() => trafficSources('demo', { format: 'jsonl' }))
      await cap.run
      const lines = cap.lines()
      expect(lines).toHaveLength(2)
      const records = lines.map(l => JSON.parse(l))
      expect(records.every(r => r.project === 'demo')).toBe(true)
      expect(records[0]).toMatchObject({ id: 'src_1', sourceType: 'cloud-run' })
      expect(records[1]).toMatchObject({ id: 'src_2', sourceType: 'wordpress' })
    })

    it('format=jsonl writes nothing when no sources are connected', async () => {
      mockTrafficListSources.mockResolvedValue({ sources: [] } satisfies TrafficSourceListResponse)
      const cap = captureStdout(() => trafficSources('demo', { format: 'jsonl' }))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('format=json is unchanged — the full envelope is emitted verbatim', async () => {
      mockTrafficListSources.mockResolvedValue(sourcesResponse)
      const out = await captureLog(() => trafficSources('demo', { format: 'json' }))
      expect(JSON.parse(out)).toEqual(sourcesResponse)
    })
  })

  describe('trafficStatus', () => {
    it('format=jsonl emits one self-contained per-source status per line, stamped with project', async () => {
      mockTrafficStatus.mockResolvedValue(statusResponse)
      const cap = captureStdout(() => trafficStatus('demo', { format: 'jsonl' }))
      await cap.run
      const lines = cap.lines()
      expect(lines).toHaveLength(2)
      const records = lines.map(l => JSON.parse(l))
      expect(records.every(r => r.project === 'demo')).toBe(true)
      // Per-source totals (incl. the segmented crawler fields) + latestRun survive into each line.
      expect(records[0]).toMatchObject({
        id: 'src_1',
        totals24h: {
          crawlerHits: 10,
          crawlerContentHits: 7,
          crawlerInfraHits: 3,
          crawlerSegments: { content: 7, sitemap: 2, robots: 1, asset: 0, other: 0 },
        },
        latestRun: { runId: 'run_1', status: 'completed' },
      })
      expect(records[1]).toMatchObject({ id: 'src_2', latestRun: null })
    })

    it('format=text leads with content crawls and breaks out infra / other', async () => {
      mockTrafficStatus.mockResolvedValue(statusResponse)
      const out = await captureLog(() => trafficStatus('demo', {}))
      expect(out).toContain('24h content:     7 crawls')
      expect(out).toContain('24h infra:       3 sitemap/robots/asset fetches')
      expect(out).toContain('24h other:       0 fetches')
      expect(out).toContain('24h crawler:     10 hits total')
    })

    it('format=jsonl writes nothing when no sources are connected', async () => {
      mockTrafficStatus.mockResolvedValue({ sources: [] } satisfies TrafficStatusResponse)
      const cap = captureStdout(() => trafficStatus('demo', { format: 'jsonl' }))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('format=json is unchanged — the full envelope is emitted verbatim', async () => {
      mockTrafficStatus.mockResolvedValue(statusResponse)
      const out = await captureLog(() => trafficStatus('demo', { format: 'json' }))
      expect(JSON.parse(out)).toEqual(statusResponse)
    })
  })
})
