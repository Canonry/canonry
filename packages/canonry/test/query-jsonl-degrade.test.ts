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
    // The API answers an append with the project's whole query list, classed.
    beforeEach(() => mockAppendQueries.mockResolvedValue([
      { id: 'q0', query: 'already tracked', createdAt: '2026-04-01T00:00:00.000Z', queryClass: 'non-brand' },
      { id: 'q1', query: 'best crm', createdAt: '2026-04-02T00:00:00.000Z', queryClass: 'non-brand' },
      { id: 'q2', query: 'demo crm pricing', createdAt: '2026-04-02T00:00:00.000Z', queryClass: 'branded' },
      { id: 'q3', query: 'unclassed', createdAt: '2026-04-02T00:00:00.000Z', queryClass: null },
    ]))

    it('format=jsonl emits parseable JSON equal to format=json', async () => {
      const jsonOut = await captureLog(() => addQueries('demo', ['best crm'], 'json'))
      const jsonlOut = await captureLog(() => addQueries('demo', ['best crm'], 'jsonl'))
      expect(jsonlOut).toBe(jsonOut)
      expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
      expect(JSON.parse(jsonlOut)).toEqual({
        project: 'demo',
        queries: ['best crm'],
        addedCount: 1,
        queryClasses: [{ query: 'best crm', queryClass: 'non-brand' }],
      })
    })

    it('format=json reports the server class of each requested query, in request order', async () => {
      const out = await captureLog(() => addQueries('demo', ['demo crm pricing', 'best crm', 'unclassed'], 'json'))
      expect(JSON.parse(out)).toEqual({
        project: 'demo',
        queries: ['demo crm pricing', 'best crm', 'unclassed'],
        addedCount: 3,
        queryClasses: [
          { query: 'demo crm pricing', queryClass: 'branded' },
          { query: 'best crm', queryClass: 'non-brand' },
          { query: 'unclassed', queryClass: null },
        ],
      })
    })

    it('no format → the count line, then one class line per query', async () => {
      const out = await captureLog(() => addQueries('demo', ['demo crm pricing', 'best crm'], undefined))
      expect(out).toBe([
        'Added 2 queries to "demo".',
        '  branded    demo crm pricing',
        '  non-brand  best crm',
      ].join('\n'))
      expect(() => JSON.parse(out)).toThrow()
    })

    it('no format → a dash and its meaning where the server reported no class', async () => {
      const out = await captureLog(() => addQueries('demo', ['unclassed'], undefined))
      expect(out).toBe([
        'Added 1 query to "demo".',
        '  -          unclassed',
        '  - = no class: the project has no usable brand name, or its measurement plan holds no single class for that query (canonry query workspace shows the class per Property).',
      ].join('\n'))
    })

    describe('against a server older than queryClass', () => {
      // An append answered with rows that carry no class at all.
      beforeEach(() => mockAppendQueries.mockResolvedValue([
        { id: 'q1', query: 'best crm', createdAt: '2026-04-02T00:00:00.000Z' },
      ]))

      it('format=json leaves queryClass off the entry, since null would say no single class exists', async () => {
        const out = await captureLog(() => addQueries('demo', ['best crm'], 'json'))
        expect(JSON.parse(out)).toEqual({
          project: 'demo',
          queries: ['best crm'],
          addedCount: 1,
          queryClasses: [{ query: 'best crm' }],
        })
      })

      it('no format → a dash explained as not reported', async () => {
        const out = await captureLog(() => addQueries('demo', ['best crm'], undefined))
        expect(out).toBe([
          'Added 1 query to "demo".',
          '  -          best crm',
          '  - = class not reported: this server version does not send a query class. Upgrade the server to see it.',
        ].join('\n'))
      })
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
