import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { InsightDto } from '@ainyc/canonry-contracts'

const mockGetInsights = vi.fn()
const mockDismissInsight = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getInsights: mockGetInsights,
    dismissInsight: mockDismissInsight,
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

const { listInsights } = await import('../src/commands/insights.js')

const insights: InsightDto[] = [
  {
    id: 'insight-1',
    projectId: 'proj-1',
    runId: 'run-1',
    type: 'citation-loss',
    severity: 'critical',
    title: 'Lost citation for "best crm"',
    query: 'best crm',
    provider: 'openai',
    recommendation: {
      action: 'publish-comparison',
      target: 'example.com/crm',
      reason: 'Competitor now ranks where you did',
    },
    dismissed: false,
    createdAt: '2026-05-28T00:00:00.000Z',
  },
  {
    id: 'insight-2',
    projectId: 'proj-1',
    runId: null,
    type: 'competitor-gain',
    severity: 'high',
    title: 'Competitor surged on "crm pricing"',
    query: 'crm pricing',
    provider: 'gemini',
    cause: {
      cause: 'New comparison content',
      competitorDomain: 'rival.com',
    },
    dismissed: false,
    createdAt: '2026-05-28T00:00:00.000Z',
  },
]

describe('listInsights — jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('format=jsonl emits one self-contained record per line', async () => {
    mockGetInsights.mockResolvedValue(insights)
    const cap = captureStdout(() => listInsights('demo', { format: 'jsonl' }))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    // Each line parses on its own — no envelope to unwrap.
    const records = lines.map(l => JSON.parse(l))
    expect(records[0]).toMatchObject({
      id: 'insight-1',
      type: 'citation-loss',
      severity: 'critical',
      title: 'Lost citation for "best crm"',
      runId: 'run-1',
    })
    expect(records[1]).toMatchObject({
      id: 'insight-2',
      type: 'competitor-gain',
      severity: 'high',
      runId: null,
    })
  })

  it('format=jsonl tags every line with the project arg', async () => {
    mockGetInsights.mockResolvedValue(insights)
    const cap = captureStdout(() => listInsights('demo', { format: 'jsonl' }))
    await cap.run
    const records = cap.lines().map(l => JSON.parse(l))
    expect(records.every(r => r.project === 'demo')).toBe(true)
  })

  it('format=jsonl spreads the record last so its own fields win over context', async () => {
    mockGetInsights.mockResolvedValue(insights)
    const cap = captureStdout(() => listInsights('demo', { format: 'jsonl' }))
    await cap.run
    const record = JSON.parse(cap.lines()[0]!)
    // project is prepended; the insight's own id/runId/recommendation survive intact.
    expect(record.id).toBe('insight-1')
    expect(record.runId).toBe('run-1')
    expect(record.recommendation).toEqual({
      action: 'publish-comparison',
      target: 'example.com/crm',
      reason: 'Competitor now ranks where you did',
    })
  })

  it('empty collection → emitJsonl writes nothing', async () => {
    mockGetInsights.mockResolvedValue([])
    const cap = captureStdout(() => listInsights('demo', { format: 'jsonl' }))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('forwards dismissed + runId filters to the client', async () => {
    mockGetInsights.mockResolvedValue([])
    const cap = captureStdout(() =>
      listInsights('demo', { format: 'jsonl', dismissed: true, runId: 'run-9' }),
    )
    await cap.run
    expect(mockGetInsights).toHaveBeenCalledWith('demo', { dismissed: true, runId: 'run-9' })
  })

  it('format=json is unchanged — prints the full envelope exactly as before', async () => {
    mockGetInsights.mockResolvedValue(insights)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await listInsights('demo', { format: 'json' })
    } finally {
      console.log = origLog
    }
    // The json branch prints the bare InsightDto[] envelope, no project tag.
    expect(JSON.parse(logs.join(''))).toEqual(insights)
  })
})
