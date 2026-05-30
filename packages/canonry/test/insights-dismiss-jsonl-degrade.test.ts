import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockDismissInsight = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    dismissInsight: mockDismissInsight,
  }),
}))

/** Capture console.log lines (dismiss's machine + human paths both use console.log). */
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

const { dismissInsight } = await import('../src/commands/insights.js')

const result = { ok: true }

describe('dismissInsight — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDismissInsight.mockResolvedValue(result)
  })

  it('format=jsonl emits parseable JSON equal to format=json (the degrade)', async () => {
    const jsonOut = await captureLog(() => dismissInsight('demo', 'insight-1', { format: 'json' }))
    const jsonlOut = await captureLog(() => dismissInsight('demo', 'insight-1', { format: 'jsonl' }))

    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
    expect(JSON.parse(jsonlOut)).toEqual(result)
  })

  it('format=jsonl does NOT print the human confirmation line', async () => {
    const out = await captureLog(() => dismissInsight('demo', 'insight-1', { format: 'jsonl' }))
    expect(out).not.toMatch(/dismissed\./)
    // It IS parseable JSON.
    expect(JSON.parse(out)).toEqual(result)
  })

  it('no format → human confirmation line is unchanged', async () => {
    const out = await captureLog(() => dismissInsight('demo', 'insight-1', {}))
    expect(out).toBe('Insight insight-1 dismissed.')
    expect(() => JSON.parse(out)).toThrow()
  })
})
