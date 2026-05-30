import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockGetReport = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ getReport: mockGetReport }),
}))

/** Capture console.log lines (the json / jsonl degrade path uses console.log). */
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

const { runReportCommand } = await import('../src/commands/report.js')

const report = {
  project: { name: 'demo', canonicalDomain: 'example.com' },
  generatedAt: '2026-05-30T00:00:00.000Z',
  sections: [],
}

describe('runReportCommand — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetReport.mockResolvedValue(report)
  })

  it('format=jsonl emits parseable JSON equal to format=json (the degrade)', async () => {
    const jsonOut = await captureLog(() => runReportCommand('demo', { format: 'json' }))
    const jsonlOut = await captureLog(() => runReportCommand('demo', { format: 'jsonl' }))

    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
    expect(JSON.parse(jsonlOut)).toMatchObject(report)
  })

  it('format=jsonl does NOT write a report file or print "Report written"', async () => {
    const out = await captureLog(() => runReportCommand('demo', { format: 'jsonl' }))
    expect(out).not.toMatch(/Report written to/)
  })
})
