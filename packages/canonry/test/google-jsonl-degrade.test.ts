import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockGscCoverage = vi.fn()
const mockGscInspect = vi.fn()
const mockGoogleSetProperty = vi.fn()
const mockGoogleConnect = vi.fn()
const mockGoogleDisconnect = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    gscCoverage: mockGscCoverage,
    gscInspect: mockGscInspect,
    googleSetProperty: mockGoogleSetProperty,
    googleConnect: mockGoogleConnect,
    googleDisconnect: mockGoogleDisconnect,
  }),
}))

/** Capture `console.log` (the machine-output path). */
function captureLog(fn: () => Promise<void>): { run: Promise<void>; text: () => string } {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  const run = fn().finally(() => { console.log = origLog })
  return { run, text: () => logs.join('') }
}

const {
  googleCoverage,
  googleInspect,
  googleSetProperty,
  googleConnect,
  googleDisconnect,
} = await import('../src/commands/google.js')

const PROJECT = 'demo'

const coverageResult = {
  summary: { total: 50, indexed: 42, notIndexed: 6, deindexed: 2, percentage: 84 },
  lastInspectedAt: '2026-05-02T00:00:00.000Z',
  indexed: [{ url: 'https://x/1', indexingState: 'INDEXING_ALLOWED', crawlTime: '2026-05-01T00:00:00.000Z' }],
  notIndexed: [{ url: 'https://x/2', indexingState: null, coverageState: 'Crawled - not indexed' }],
  deindexed: [{ url: 'https://x/3', previousState: 'INDEXED', currentState: 'NOT_INDEXED', transitionDate: '2026-05-02' }],
}

const inspectResult = {
  url: 'https://x/1',
  indexingState: 'INDEXING_ALLOWED',
  verdict: 'PASS',
  coverageState: 'Submitted and indexed',
  pageFetchState: 'SUCCESSFUL',
  robotsTxtState: 'ALLOWED',
  crawlTime: '2026-05-01T00:00:00.000Z',
  lastCrawlResult: 'OK',
  isMobileFriendly: true,
  richResults: ['Breadcrumb'],
  inspectedAt: '2026-05-02T00:00:00.000Z',
}

describe('google jsonl degrade (composite/object commands)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('googleCoverage (composite GscCoverageSummaryDto)', () => {
    it('jsonl degrades to the json document — emits the coverage object, not the human table', async () => {
      mockGscCoverage.mockResolvedValue(coverageResult)
      const cap = captureLog(() => googleCoverage(PROJECT, 'jsonl'))
      await cap.run
      const parsed = JSON.parse(cap.text())
      expect(parsed).toEqual(coverageResult)
    })

    it('jsonl output equals json output byte-for-byte', async () => {
      mockGscCoverage.mockResolvedValue(coverageResult)
      const jsonCap = captureLog(() => googleCoverage(PROJECT, 'json'))
      await jsonCap.run
      const jsonlCap = captureLog(() => googleCoverage(PROJECT, 'jsonl'))
      await jsonlCap.run
      expect(jsonlCap.text()).toBe(jsonCap.text())
    })

    it('default (no format) human output is unchanged — renders the table, not JSON', async () => {
      mockGscCoverage.mockResolvedValue(coverageResult)
      const cap = captureLog(() => googleCoverage(PROJECT, undefined))
      await cap.run
      const out = cap.text()
      expect(out).toContain('Index Coverage for "demo"')
      expect(out).toContain('42 / 50 pages indexed')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('googleInspect (single object)', () => {
    it('jsonl degrades to the json document — emits the inspection object', async () => {
      mockGscInspect.mockResolvedValue(inspectResult)
      const cap = captureLog(() => googleInspect(PROJECT, 'https://x/1', 'jsonl'))
      await cap.run
      expect(JSON.parse(cap.text())).toEqual(inspectResult)
    })

    it('jsonl equals json', async () => {
      mockGscInspect.mockResolvedValue(inspectResult)
      const jsonCap = captureLog(() => googleInspect(PROJECT, 'https://x/1', 'json'))
      await jsonCap.run
      const jsonlCap = captureLog(() => googleInspect(PROJECT, 'https://x/1', 'jsonl'))
      await jsonlCap.run
      expect(jsonlCap.text()).toBe(jsonCap.text())
    })

    it('default human output is unchanged', async () => {
      mockGscInspect.mockResolvedValue(inspectResult)
      const cap = captureLog(() => googleInspect(PROJECT, 'https://x/1', undefined))
      await cap.run
      const out = cap.text()
      expect(out).toContain('URL Inspection: https://x/1')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('googleSetProperty (mutation)', () => {
    it('jsonl degrades to the json document', async () => {
      mockGoogleSetProperty.mockResolvedValue(undefined)
      const cap = captureLog(() => googleSetProperty(PROJECT, 'sc-domain:x', 'jsonl'))
      await cap.run
      expect(JSON.parse(cap.text())).toEqual({ project: PROJECT, type: 'gsc', propertyUrl: 'sc-domain:x' })
    })

    it('jsonl equals json', async () => {
      mockGoogleSetProperty.mockResolvedValue(undefined)
      const jsonCap = captureLog(() => googleSetProperty(PROJECT, 'sc-domain:x', 'json'))
      await jsonCap.run
      const jsonlCap = captureLog(() => googleSetProperty(PROJECT, 'sc-domain:x', 'jsonl'))
      await jsonlCap.run
      expect(jsonlCap.text()).toBe(jsonCap.text())
    })

    it('default human output is unchanged', async () => {
      mockGoogleSetProperty.mockResolvedValue(undefined)
      const cap = captureLog(() => googleSetProperty(PROJECT, 'sc-domain:x', undefined))
      await cap.run
      const out = cap.text()
      expect(out).toContain('GSC property set to "sc-domain:x"')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('googleConnect (mutation)', () => {
    it('jsonl degrades to the json document', async () => {
      mockGoogleConnect.mockResolvedValue({ authUrl: 'https://accounts.google.com/auth', redirectUri: 'https://app/cb' })
      const cap = captureLog(() => googleConnect(PROJECT, { type: 'gsc', format: 'jsonl' }))
      await cap.run
      expect(JSON.parse(cap.text())).toEqual({
        project: PROJECT,
        type: 'gsc',
        authUrl: 'https://accounts.google.com/auth',
        redirectUri: 'https://app/cb',
      })
    })

    it('jsonl equals json', async () => {
      mockGoogleConnect.mockResolvedValue({ authUrl: 'https://accounts.google.com/auth', redirectUri: 'https://app/cb' })
      const jsonCap = captureLog(() => googleConnect(PROJECT, { type: 'gsc', format: 'json' }))
      await jsonCap.run
      const jsonlCap = captureLog(() => googleConnect(PROJECT, { type: 'gsc', format: 'jsonl' }))
      await jsonlCap.run
      expect(jsonlCap.text()).toBe(jsonCap.text())
    })
  })

  describe('googleDisconnect (mutation)', () => {
    it('jsonl degrades to the json document', async () => {
      mockGoogleDisconnect.mockResolvedValue(undefined)
      const cap = captureLog(() => googleDisconnect(PROJECT, { type: 'gsc', format: 'jsonl' }))
      await cap.run
      expect(JSON.parse(cap.text())).toEqual({ project: PROJECT, type: 'gsc', disconnected: true })
    })

    it('jsonl equals json', async () => {
      mockGoogleDisconnect.mockResolvedValue(undefined)
      const jsonCap = captureLog(() => googleDisconnect(PROJECT, { type: 'gsc', format: 'json' }))
      await jsonCap.run
      const jsonlCap = captureLog(() => googleDisconnect(PROJECT, { type: 'gsc', format: 'jsonl' }))
      await jsonlCap.run
      expect(jsonlCap.text()).toBe(jsonCap.text())
    })

    it('default human output is unchanged', async () => {
      mockGoogleDisconnect.mockResolvedValue(undefined)
      const cap = captureLog(() => googleDisconnect(PROJECT, { type: 'gsc', format: undefined }))
      await cap.run
      const out = cap.text()
      expect(out).toContain('Disconnected Google GSC')
      expect(() => JSON.parse(out)).toThrow()
    })
  })
})
