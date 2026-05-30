import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockBingCoverageHistory = vi.fn()
const mockBingInspections = vi.fn()
const mockBingPerformance = vi.fn()
const mockBingSites = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    bingCoverageHistory: mockBingCoverageHistory,
    bingInspections: mockBingInspections,
    bingPerformance: mockBingPerformance,
    bingSites: mockBingSites,
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

/** Capture `console.log` (the json path). */
function captureLog(fn: () => Promise<void>): { run: Promise<void>; logs: () => string } {
  const logs: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  const run = fn().finally(() => { console.log = orig })
  return { run, logs: () => logs.join('') }
}

const {
  bingCoverageHistory,
  bingInspections,
  bingPerformance,
  bingSites,
} = await import('../src/commands/bing.js')

const coverageRows = [
  { date: '2026-05-01', indexed: 10, notIndexed: 2, unknown: 1 },
  { date: '2026-05-02', indexed: 12, notIndexed: 1, unknown: 0 },
]

const inspectionRows = [
  { id: 'i1', url: 'https://example.com/a', httpCode: 200, inIndex: true, lastCrawledDate: '2026-05-01T00:00:00.000Z', inspectedAt: '2026-05-02T00:00:00.000Z' },
  { id: 'i2', url: 'https://example.com/b', httpCode: 404, inIndex: false, lastCrawledDate: null, inspectedAt: '2026-05-02T00:00:00.000Z' },
]

const performanceRows = [
  { query: 'best widgets', impressions: 1000, clicks: 50, ctr: 0.05, averagePosition: 3.2 },
  { query: 'cheap widgets', impressions: 500, clicks: 10, ctr: 0.02, averagePosition: 8.1 },
]

const sitesResult = {
  sites: [
    { url: 'https://example.com/', verified: true },
    { url: 'https://other.example.com/', verified: false },
  ],
}

describe('bing jsonl output', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('bing coverage-history', () => {
    it('jsonl emits one self-contained record per line, each tagged with project', async () => {
      mockBingCoverageHistory.mockResolvedValue(coverageRows)
      const cap = captureStdout(() => bingCoverageHistory('demo', { format: 'jsonl' }))
      await cap.run
      const lines = cap.lines()
      expect(lines).toHaveLength(2)
      const records = lines.map((l) => JSON.parse(l))
      expect(records.every((r) => r.project === 'demo')).toBe(true)
      expect(records[0]).toMatchObject({ project: 'demo', date: '2026-05-01', indexed: 10, notIndexed: 2, unknown: 1 })
      expect(records[1]).toMatchObject({ project: 'demo', date: '2026-05-02' })
    })

    it('jsonl writes nothing for an empty collection', async () => {
      mockBingCoverageHistory.mockResolvedValue([])
      const cap = captureStdout(() => bingCoverageHistory('demo', { format: 'jsonl' }))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('json branch is unchanged — emits the full envelope verbatim', async () => {
      mockBingCoverageHistory.mockResolvedValue(coverageRows)
      const cap = captureLog(() => bingCoverageHistory('demo', { format: 'json' }))
      await cap.run
      expect(JSON.parse(cap.logs())).toEqual(coverageRows)
    })
  })

  describe('bing inspections', () => {
    it('jsonl emits one self-contained record per line, each tagged with project', async () => {
      mockBingInspections.mockResolvedValue(inspectionRows)
      const cap = captureStdout(() => bingInspections('demo', { format: 'jsonl' }))
      await cap.run
      const lines = cap.lines()
      expect(lines).toHaveLength(2)
      const records = lines.map((l) => JSON.parse(l))
      expect(records.every((r) => r.project === 'demo')).toBe(true)
      expect(records[0]).toMatchObject({ project: 'demo', id: 'i1', url: 'https://example.com/a', httpCode: 200, inIndex: true })
    })

    it('jsonl writes nothing for an empty collection', async () => {
      mockBingInspections.mockResolvedValue([])
      const cap = captureStdout(() => bingInspections('demo', { format: 'jsonl' }))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('json branch is unchanged — emits the full envelope verbatim', async () => {
      mockBingInspections.mockResolvedValue(inspectionRows)
      const cap = captureLog(() => bingInspections('demo', { format: 'json' }))
      await cap.run
      expect(JSON.parse(cap.logs())).toEqual(inspectionRows)
    })
  })

  describe('bing performance', () => {
    it('jsonl emits one self-contained record per line, each tagged with project (all rows, no truncation)', async () => {
      // 60 rows proves jsonl emits ALL rows, not the 50-row human truncation.
      const manyRows = Array.from({ length: 60 }, (_, i) => ({
        query: `q${i}`,
        impressions: i,
        clicks: i,
        ctr: 0.01,
        averagePosition: 1,
      }))
      mockBingPerformance.mockResolvedValue(manyRows)
      const cap = captureStdout(() => bingPerformance('demo', 'jsonl'))
      await cap.run
      const lines = cap.lines()
      expect(lines).toHaveLength(60)
      const records = lines.map((l) => JSON.parse(l))
      expect(records.every((r) => r.project === 'demo')).toBe(true)
      expect(records[0]).toMatchObject({ project: 'demo', query: 'q0' })
      expect(records[59]).toMatchObject({ project: 'demo', query: 'q59' })
    })

    it('jsonl writes nothing for an empty collection', async () => {
      mockBingPerformance.mockResolvedValue([])
      const cap = captureStdout(() => bingPerformance('demo', 'jsonl'))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('json branch is unchanged — emits the full envelope verbatim', async () => {
      mockBingPerformance.mockResolvedValue(performanceRows)
      const cap = captureLog(() => bingPerformance('demo', 'json'))
      await cap.run
      expect(JSON.parse(cap.logs())).toEqual(performanceRows)
    })
  })

  describe('bing sites', () => {
    it('jsonl emits one self-contained record per line from result.sites, each tagged with project', async () => {
      mockBingSites.mockResolvedValue(sitesResult)
      const cap = captureStdout(() => bingSites('demo', 'jsonl'))
      await cap.run
      const lines = cap.lines()
      expect(lines).toHaveLength(2)
      const records = lines.map((l) => JSON.parse(l))
      expect(records.every((r) => r.project === 'demo')).toBe(true)
      expect(records[0]).toMatchObject({ project: 'demo', url: 'https://example.com/', verified: true })
      expect(records[1]).toMatchObject({ project: 'demo', url: 'https://other.example.com/', verified: false })
    })

    it('jsonl writes nothing for an empty collection', async () => {
      mockBingSites.mockResolvedValue({ sites: [] })
      const cap = captureStdout(() => bingSites('demo', 'jsonl'))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('json branch is unchanged — emits the full envelope verbatim', async () => {
      mockBingSites.mockResolvedValue(sitesResult)
      const cap = captureLog(() => bingSites('demo', 'json'))
      await cap.run
      expect(JSON.parse(cap.logs())).toEqual(sitesResult)
    })
  })
})
