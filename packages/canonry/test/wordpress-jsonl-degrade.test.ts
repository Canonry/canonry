import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockWordpressStatus = vi.fn()
const mockWordpressDiff = vi.fn()
const mockWordpressUpdatePage = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    wordpressStatus: mockWordpressStatus,
    wordpressDiff: mockWordpressDiff,
    wordpressUpdatePage: mockWordpressUpdatePage,
  }),
}))

/** Capture console.log output (printJson and the human printers both use console.log). */
function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  return fn()
    .finally(() => {
      console.log = origLog
    })
    .then(() => logs.join('\n'))
}

const { wordpressStatus, wordpressDiff, wordpressUpdatePage } = await import('../src/commands/wordpress.js')

// A disconnected status — the simplest human path (two-line message, early return).
const statusResult = { connected: false, defaultEnv: 'live' as const, live: null, staging: null }

const diffResult = {
  slug: 'about',
  hasDifferences: true,
  differences: { title: true, content: false },
  live: {
    title: 'About (live)',
    slug: 'about',
    contentHash: 'aaa',
    contentSnippet: 'live snippet',
    seo: { title: 'About', description: 'desc', noindex: false },
    schemaBlocks: [],
  },
  staging: {
    title: 'About (staging)',
    slug: 'about',
    contentHash: 'bbb',
    contentSnippet: 'staging snippet',
    seo: { title: 'About', description: 'desc', noindex: false },
    schemaBlocks: [],
  },
}

const updatedPage = {
  title: 'Hello',
  slug: 'hello',
  status: 'publish',
  env: 'live' as const,
  modifiedAt: '2026-05-30T00:00:00Z',
  link: 'https://example.com/hello',
  seo: { title: 'Hello', description: 'desc', noindex: false, writable: true },
  schemaBlocks: [],
  content: '<p>Hello</p>',
}

describe('wordpress commands — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWordpressStatus.mockResolvedValue(statusResult)
    mockWordpressDiff.mockResolvedValue(diffResult)
    mockWordpressUpdatePage.mockResolvedValue(updatedPage)
  })

  describe('wordpressStatus (format? signature, single-object read)', () => {
    it('format=jsonl emits parseable JSON equal to format=json', async () => {
      const jsonOut = await captureLog(() => wordpressStatus('demo', 'json'))
      const jsonlOut = await captureLog(() => wordpressStatus('demo', 'jsonl'))

      expect(jsonlOut).toBe(jsonOut)
      expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
      expect(JSON.parse(jsonlOut)).toEqual(statusResult)
    })

    it('no format → human output is unchanged (not JSON)', async () => {
      const out = await captureLog(() => wordpressStatus('demo'))
      expect(out).toContain('No WordPress connection for project "demo".')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('wordpressDiff (format? signature, richer DTO)', () => {
    it('format=jsonl emits parseable JSON equal to format=json', async () => {
      const jsonOut = await captureLog(() => wordpressDiff('demo', 'about', 'json'))
      const jsonlOut = await captureLog(() => wordpressDiff('demo', 'about', 'jsonl'))

      expect(jsonlOut).toBe(jsonOut)
      expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
      expect(JSON.parse(jsonlOut)).toEqual(diffResult)
    })

    it('no format → human diff table is unchanged (not JSON)', async () => {
      const out = await captureLog(() => wordpressDiff('demo', 'about'))
      expect(out).toContain('WordPress diff for "about":')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('wordpressUpdatePage (body.format signature, mutation)', () => {
    it('format=jsonl emits parseable JSON equal to format=json', async () => {
      const jsonOut = await captureLog(() => wordpressUpdatePage('demo', { currentSlug: 'hello', format: 'json' }))
      const jsonlOut = await captureLog(() => wordpressUpdatePage('demo', { currentSlug: 'hello', format: 'jsonl' }))

      expect(jsonlOut).toBe(jsonOut)
      expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
      expect(JSON.parse(jsonlOut)).toEqual(updatedPage)
    })

    it('no format → human confirmation line is unchanged (not JSON)', async () => {
      const out = await captureLog(() => wordpressUpdatePage('demo', { currentSlug: 'hello' }))
      expect(out).toContain('Updated WordPress page "hello" in live.')
      expect(() => JSON.parse(out)).toThrow()
    })
  })
})
