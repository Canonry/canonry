import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { CompetitorDto } from '@ainyc/canonry-contracts'

const mockListCompetitors = vi.fn()
const mockAppendCompetitors = vi.fn()
const mockDeleteCompetitors = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    listCompetitors: mockListCompetitors,
    appendCompetitors: mockAppendCompetitors,
    deleteCompetitors: mockDeleteCompetitors,
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

const { addCompetitors, removeCompetitors } = await import('../src/commands/competitor.js')

function comp(domain: string): CompetitorDto {
  return { id: `id-${domain}`, domain, createdAt: '2026-04-01T00:00:00.000Z' }
}

describe('competitor mutations — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('addCompetitors', () => {
    beforeEach(() => {
      mockListCompetitors.mockResolvedValue([comp('existing.com')])
      mockAppendCompetitors.mockResolvedValue([comp('existing.com'), comp('rival.com')])
    })

    it('format=jsonl emits parseable JSON equal to format=json', async () => {
      const jsonOut = await captureLog(() => addCompetitors('demo', ['rival.com'], 'json'))
      const jsonlOut = await captureLog(() => addCompetitors('demo', ['rival.com'], 'jsonl'))
      expect(jsonlOut).toBe(jsonOut)
      expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
      expect(JSON.parse(jsonlOut)).toMatchObject({ project: 'demo', addedDomains: ['rival.com'], addedCount: 1 })
    })

    it('no format → human line unchanged', async () => {
      const out = await captureLog(() => addCompetitors('demo', ['rival.com'], undefined))
      expect(out).toBe('Added 1 competitor(s) to "demo".')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('removeCompetitors', () => {
    beforeEach(() => {
      mockListCompetitors.mockResolvedValue([comp('rival.com'), comp('keep.com')])
      mockDeleteCompetitors.mockResolvedValue([comp('keep.com')])
    })

    it('format=jsonl emits parseable JSON equal to format=json', async () => {
      const jsonOut = await captureLog(() => removeCompetitors('demo', ['rival.com'], 'json'))
      const jsonlOut = await captureLog(() => removeCompetitors('demo', ['rival.com'], 'jsonl'))
      expect(jsonlOut).toBe(jsonOut)
      expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
      expect(JSON.parse(jsonlOut)).toMatchObject({ project: 'demo', removedDomains: ['rival.com'], removedCount: 1 })
    })

    it('no format → human line unchanged', async () => {
      const out = await captureLog(() => removeCompetitors('demo', ['rival.com'], undefined))
      expect(out).toBe('Removed 1 competitor(s) from "demo".')
      expect(() => JSON.parse(out)).toThrow()
    })
  })
})
