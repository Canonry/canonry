import { describe, expect, it, beforeEach, vi } from 'vitest'

// These commands are NOT collection streams — they emit a single JSON document.
// The degrade contract: `--format jsonl` must produce the SAME JSON as `--format json`
// (not the human text block), while default/no-format output stays human-readable.

const mockBingStatus = vi.fn()
const mockBingCoverage = vi.fn()
const mockBingConnect = vi.fn()
const mockBingSetSite = vi.fn()
const mockBingDisconnect = vi.fn()
const mockBingInspectUrl = vi.fn()
const mockBingRequestIndexing = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    bingStatus: mockBingStatus,
    bingCoverage: mockBingCoverage,
    bingConnect: mockBingConnect,
    bingSetSite: mockBingSetSite,
    bingDisconnect: mockBingDisconnect,
    bingInspectUrl: mockBingInspectUrl,
    bingRequestIndexing: mockBingRequestIndexing,
  }),
}))

/** Capture `console.log`, returning each call joined as one string. */
function captureLog(fn: () => Promise<void>): { run: Promise<void>; logs: () => string } {
  const logs: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  const run = fn().finally(() => { console.log = orig })
  return { run, logs: () => logs.join('') }
}

const {
  bingStatus,
  bingCoverage,
  bingConnect,
  bingSetSite,
  bingDisconnect,
  bingInspect,
  bingRequestIndexing,
} = await import('../src/commands/bing.js')

const statusResult = {
  connected: true,
  domain: 'example.com',
  siteUrl: 'https://example.com/',
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-02T00:00:00.000Z',
}

const coverageResult = {
  summary: { total: 12, indexed: 10, notIndexed: 2, unknown: 0, percentage: 83 },
  lastInspectedAt: '2026-05-02T00:00:00.000Z',
  indexed: [{ url: 'https://example.com/a', inIndex: true, lastCrawledDate: '2026-05-01T00:00:00.000Z' }],
  notIndexed: [{ url: 'https://example.com/b', inIndex: false, httpCode: 404 }],
  unknown: [],
}

const connectResult = {
  connected: true,
  domain: 'example.com',
  availableSites: [{ url: 'https://example.com/', verified: true }],
}

const inspectResult = {
  url: 'https://example.com/a',
  httpCode: 200,
  inIndex: true,
  lastCrawledDate: '2026-05-01T00:00:00.000Z',
  inIndexDate: '2026-05-01T00:00:00.000Z',
  inspectedAt: '2026-05-02T00:00:00.000Z',
  documentSize: 1234,
  anchorCount: 5,
  discoveryDate: '2026-04-01T00:00:00.000Z',
}

const requestIndexingResult = {
  summary: { total: 1, succeeded: 1, failed: 0 },
  results: [{ url: 'https://example.com/a', status: 'success', submittedAt: '2026-05-02T00:00:00.000Z' }],
}

describe('bing jsonl degrade (object/status commands)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('bing status', () => {
    it('jsonl emits the same JSON document as json', async () => {
      mockBingStatus.mockResolvedValue(statusResult)
      const jsonCap = captureLog(() => bingStatus('demo', 'json'))
      await jsonCap.run
      const jsonlCap = captureLog(() => bingStatus('demo', 'jsonl'))
      await jsonlCap.run
      expect(JSON.parse(jsonlCap.logs())).toEqual(JSON.parse(jsonCap.logs()))
      expect(JSON.parse(jsonlCap.logs())).toEqual(statusResult)
    })

    it('default (no format) output is human text, not JSON', async () => {
      mockBingStatus.mockResolvedValue(statusResult)
      const cap = captureLog(() => bingStatus('demo'))
      await cap.run
      const out = cap.logs()
      expect(out).toContain('Bing Webmaster Tools for "demo"')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('bing coverage', () => {
    it('jsonl emits the same JSON document as json', async () => {
      mockBingCoverage.mockResolvedValue(coverageResult)
      const jsonCap = captureLog(() => bingCoverage('demo', 'json'))
      await jsonCap.run
      const jsonlCap = captureLog(() => bingCoverage('demo', 'jsonl'))
      await jsonlCap.run
      expect(JSON.parse(jsonlCap.logs())).toEqual(JSON.parse(jsonCap.logs()))
      expect(JSON.parse(jsonlCap.logs())).toEqual(coverageResult)
    })

    it('default (no format) output is human text, not JSON', async () => {
      mockBingCoverage.mockResolvedValue(coverageResult)
      const cap = captureLog(() => bingCoverage('demo'))
      await cap.run
      const out = cap.logs()
      expect(out).toContain('Bing Index Coverage for "demo"')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('bing connect', () => {
    it('jsonl emits the same JSON document as json', async () => {
      mockBingConnect.mockResolvedValue(connectResult)
      const jsonCap = captureLog(() => bingConnect('demo', { apiKey: 'k', format: 'json' }))
      await jsonCap.run
      const jsonlCap = captureLog(() => bingConnect('demo', { apiKey: 'k', format: 'jsonl' }))
      await jsonlCap.run
      expect(JSON.parse(jsonlCap.logs())).toEqual(JSON.parse(jsonCap.logs()))
      expect(JSON.parse(jsonlCap.logs())).toEqual(connectResult)
    })

    it('default (no format) output is human text, not JSON', async () => {
      mockBingConnect.mockResolvedValue(connectResult)
      const cap = captureLog(() => bingConnect('demo', { apiKey: 'k' }))
      await cap.run
      const out = cap.logs()
      expect(out).toContain('Bing Webmaster Tools connected for project "demo"')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('bing set-site', () => {
    it('jsonl emits the same JSON document as json', async () => {
      mockBingSetSite.mockResolvedValue(undefined)
      const jsonCap = captureLog(() => bingSetSite('demo', 'https://example.com/', 'json'))
      await jsonCap.run
      const jsonlCap = captureLog(() => bingSetSite('demo', 'https://example.com/', 'jsonl'))
      await jsonlCap.run
      expect(JSON.parse(jsonlCap.logs())).toEqual(JSON.parse(jsonCap.logs()))
      expect(JSON.parse(jsonlCap.logs())).toEqual({ project: 'demo', siteUrl: 'https://example.com/' })
    })

    it('default (no format) output is human text, not JSON', async () => {
      mockBingSetSite.mockResolvedValue(undefined)
      const cap = captureLog(() => bingSetSite('demo', 'https://example.com/'))
      await cap.run
      const out = cap.logs()
      expect(out).toContain('Bing site set to')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('bing disconnect', () => {
    it('jsonl emits the same JSON document as json', async () => {
      mockBingDisconnect.mockResolvedValue(undefined)
      const jsonCap = captureLog(() => bingDisconnect('demo', 'json'))
      await jsonCap.run
      const jsonlCap = captureLog(() => bingDisconnect('demo', 'jsonl'))
      await jsonlCap.run
      expect(JSON.parse(jsonlCap.logs())).toEqual(JSON.parse(jsonCap.logs()))
      expect(JSON.parse(jsonlCap.logs())).toEqual({ project: 'demo', disconnected: true })
    })

    it('default (no format) output is human text, not JSON', async () => {
      mockBingDisconnect.mockResolvedValue(undefined)
      const cap = captureLog(() => bingDisconnect('demo'))
      await cap.run
      expect(cap.logs()).toContain('Bing Webmaster Tools disconnected')
    })
  })

  describe('bing inspect', () => {
    it('jsonl emits the same JSON document as json', async () => {
      mockBingInspectUrl.mockResolvedValue(inspectResult)
      const jsonCap = captureLog(() => bingInspect('demo', 'https://example.com/a', 'json'))
      await jsonCap.run
      const jsonlCap = captureLog(() => bingInspect('demo', 'https://example.com/a', 'jsonl'))
      await jsonlCap.run
      expect(JSON.parse(jsonlCap.logs())).toEqual(JSON.parse(jsonCap.logs()))
      expect(JSON.parse(jsonlCap.logs())).toEqual(inspectResult)
    })

    it('default (no format) output is human text, not JSON', async () => {
      mockBingInspectUrl.mockResolvedValue(inspectResult)
      const cap = captureLog(() => bingInspect('demo', 'https://example.com/a'))
      await cap.run
      const out = cap.logs()
      expect(out).toContain('Bing URL Inspection')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('bing request-indexing', () => {
    it('jsonl emits the same JSON document as json', async () => {
      mockBingRequestIndexing.mockResolvedValue(requestIndexingResult)
      const jsonCap = captureLog(() => bingRequestIndexing('demo', { url: 'https://example.com/a', format: 'json' }))
      await jsonCap.run
      const jsonlCap = captureLog(() => bingRequestIndexing('demo', { url: 'https://example.com/a', format: 'jsonl' }))
      await jsonlCap.run
      expect(JSON.parse(jsonlCap.logs())).toEqual(JSON.parse(jsonCap.logs()))
      expect(JSON.parse(jsonlCap.logs())).toEqual(requestIndexingResult)
    })
  })
})
