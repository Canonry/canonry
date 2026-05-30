import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockAppendQueries = vi.fn()
const mockListQueries = vi.fn()
const mockDeleteQueries = vi.fn()
const mockGenerateQueries = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    appendQueries: mockAppendQueries,
    listQueries: mockListQueries,
    deleteQueries: mockDeleteQueries,
    generateQueries: mockGenerateQueries,
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

const { addQueries, removeQueries, generateQueries } = await import('../src/commands/query.js')

describe('query mutations — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('addQueries', () => {
    beforeEach(() => mockAppendQueries.mockResolvedValue(undefined))

    it('format=jsonl emits parseable JSON equal to format=json', async () => {
      const jsonOut = await captureLog(() => addQueries('demo', ['best crm'], 'json'))
      const jsonlOut = await captureLog(() => addQueries('demo', ['best crm'], 'jsonl'))
      expect(jsonlOut).toBe(jsonOut)
      expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
      expect(JSON.parse(jsonlOut)).toEqual({ project: 'demo', queries: ['best crm'], addedCount: 1 })
    })

    it('no format → human line unchanged', async () => {
      const out = await captureLog(() => addQueries('demo', ['best crm'], undefined))
      expect(out).toBe('Added 1 query to "demo".')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('removeQueries', () => {
    beforeEach(() => {
      mockListQueries.mockResolvedValue([{ query: 'best crm' }, { query: 'keep me' }])
      mockDeleteQueries.mockResolvedValue(undefined)
    })

    it('format=jsonl emits parseable JSON equal to format=json', async () => {
      const jsonOut = await captureLog(() => removeQueries('demo', ['best crm'], 'json'))
      const jsonlOut = await captureLog(() => removeQueries('demo', ['best crm'], 'jsonl'))
      expect(jsonlOut).toBe(jsonOut)
      expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
      expect(JSON.parse(jsonlOut)).toMatchObject({ project: 'demo', removedQueries: ['best crm'], removedCount: 1 })
    })

    it('no format → human line unchanged', async () => {
      const out = await captureLog(() => removeQueries('demo', ['best crm'], undefined))
      expect(out).toBe('Removed 1 query from "demo".')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('generateQueries', () => {
    beforeEach(() => {
      mockGenerateQueries.mockResolvedValue({ provider: 'openai', queries: ['q1', 'q2'] })
      mockAppendQueries.mockResolvedValue(undefined)
    })

    it('format=jsonl emits parseable JSON equal to format=json', async () => {
      const jsonOut = await captureLog(() => generateQueries('demo', 'openai', { format: 'json' }))
      const jsonlOut = await captureLog(() => generateQueries('demo', 'openai', { format: 'jsonl' }))
      expect(jsonlOut).toBe(jsonOut)
      expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
      expect(JSON.parse(jsonlOut)).toMatchObject({
        project: 'demo',
        provider: 'openai',
        queries: ['q1', 'q2'],
        generatedCount: 2,
        saved: false,
      })
    })

    it('format=jsonl prints no human prose', async () => {
      const out = await captureLog(() => generateQueries('demo', 'openai', { format: 'jsonl' }))
      expect(out).not.toMatch(/Generated/)
      expect(JSON.parse(out)).toMatchObject({ generatedCount: 2 })
    })

    it('no format → human prose unchanged', async () => {
      const out = await captureLog(() => generateQueries('demo', 'openai', {}))
      expect(out).toContain('Generated 2 queries using openai:')
      expect(out).toContain('  q1')
    })
  })
})
