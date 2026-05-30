import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockAppendKeywords = vi.fn()
const mockPutKeywords = vi.fn()
const mockGenerateKeywords = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    appendKeywords: mockAppendKeywords,
    putKeywords: mockPutKeywords,
    generateKeywords: mockGenerateKeywords,
  }),
}))

/** Capture console.log lines (the machine + human paths both use console.log). */
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

const { addKeywords, replaceKeywords, generateKeywords } = await import('../src/commands/keyword.js')

describe('keyword mutations — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('addKeywords', () => {
    beforeEach(() => mockAppendKeywords.mockResolvedValue(undefined))

    it('format=jsonl emits parseable JSON equal to format=json', async () => {
      const jsonOut = await captureLog(() => addKeywords('demo', ['saas analytics'], 'json'))
      const jsonlOut = await captureLog(() => addKeywords('demo', ['saas analytics'], 'jsonl'))
      expect(jsonlOut).toBe(jsonOut)
      expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
      expect(JSON.parse(jsonlOut)).toEqual({ project: 'demo', keywords: ['saas analytics'], addedCount: 1 })
    })

    it('no format → human line unchanged', async () => {
      const out = await captureLog(() => addKeywords('demo', ['saas analytics'], undefined))
      expect(out).toBe('Added 1 key phrase(s) to "demo".')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('replaceKeywords', () => {
    beforeEach(() => mockPutKeywords.mockResolvedValue(undefined))

    it('format=jsonl emits parseable JSON equal to format=json', async () => {
      const jsonOut = await captureLog(() => replaceKeywords('demo', ['a', 'b'], 'json'))
      const jsonlOut = await captureLog(() => replaceKeywords('demo', ['a', 'b'], 'jsonl'))
      expect(jsonlOut).toBe(jsonOut)
      expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
      expect(JSON.parse(jsonlOut)).toEqual({ project: 'demo', keywords: ['a', 'b'], replacedCount: 2 })
    })

    it('no format → human line unchanged', async () => {
      const out = await captureLog(() => replaceKeywords('demo', ['a', 'b'], undefined))
      expect(out).toBe('Set 2 key phrase(s) for "demo".')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('generateKeywords', () => {
    beforeEach(() => {
      mockGenerateKeywords.mockResolvedValue({ provider: 'openai', keywords: ['k1', 'k2'] })
      mockAppendKeywords.mockResolvedValue(undefined)
    })

    it('format=jsonl emits parseable JSON equal to format=json', async () => {
      const jsonOut = await captureLog(() => generateKeywords('demo', 'openai', { format: 'json' }))
      const jsonlOut = await captureLog(() => generateKeywords('demo', 'openai', { format: 'jsonl' }))
      expect(jsonlOut).toBe(jsonOut)
      expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
      expect(JSON.parse(jsonlOut)).toMatchObject({
        project: 'demo',
        provider: 'openai',
        keywords: ['k1', 'k2'],
        generatedCount: 2,
        saved: false,
      })
    })

    it('format=jsonl prints no human prose', async () => {
      const out = await captureLog(() => generateKeywords('demo', 'openai', { format: 'jsonl' }))
      expect(out).not.toMatch(/Generated/)
      expect(JSON.parse(out)).toMatchObject({ generatedCount: 2 })
    })

    it('no format → human prose unchanged', async () => {
      const out = await captureLog(() => generateKeywords('demo', 'openai', {}))
      expect(out).toContain('Generated 2 key phrase(s) using openai:')
      expect(out).toContain('  k1')
    })
  })
})
