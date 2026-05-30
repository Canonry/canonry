import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { TimelineDto } from '../src/client.js'

const mockGetTimeline = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getTimeline: mockGetTimeline,
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

const { showEvidence } = await import('../src/commands/evidence.js')

const timeline: TimelineDto[] = [
  {
    query: 'best widgets',
    runs: [
      { runId: 'r1', createdAt: '2026-04-28T00:00:00.000Z', citationState: 'not-cited', transition: 'stable' },
      { runId: 'r2', createdAt: '2026-04-29T00:00:00.000Z', citationState: 'cited', transition: 'emerging' },
    ],
  },
  {
    query: 'top gizmos',
    runs: [
      { runId: 'r3', createdAt: '2026-04-29T00:00:00.000Z', citationState: 'not-cited', transition: 'lost' },
    ],
  },
]

describe('showEvidence — jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('format=jsonl emits one self-contained record per tracked query', async () => {
    mockGetTimeline.mockResolvedValue(timeline)
    const cap = captureStdout(() => showEvidence('demo', 'jsonl'))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    // Each line parses on its own.
    const records = lines.map(l => JSON.parse(l!))
    expect(records[0]).toMatchObject({ query: 'best widgets', cited: true })
    expect(records[1]).toMatchObject({ query: 'top gizmos', cited: false })
    // The full enriched TimelineDto rides each line.
    expect(records[0].runs).toHaveLength(2)
  })

  it('format=jsonl tags each line with the project it describes', async () => {
    mockGetTimeline.mockResolvedValue(timeline)
    const cap = captureStdout(() => showEvidence('demo', 'jsonl'))
    await cap.run
    const records = cap.lines().map(l => JSON.parse(l!))
    expect(records.every(r => r.project === 'demo')).toBe(true)
  })

  it('format=jsonl derives cited from the latest run, not any run', async () => {
    // First run is cited, latest is not — `cited` must read the last run.
    mockGetTimeline.mockResolvedValue([
      {
        query: 'fading query',
        runs: [
          { runId: 'a', createdAt: '2026-04-01T00:00:00.000Z', citationState: 'cited', transition: 'stable' },
          { runId: 'b', createdAt: '2026-04-02T00:00:00.000Z', citationState: 'not-cited', transition: 'lost' },
        ],
      },
    ] satisfies TimelineDto[])
    const cap = captureStdout(() => showEvidence('demo', 'jsonl'))
    await cap.run
    expect(JSON.parse(cap.lines()[0]!).cited).toBe(false)
  })

  it('format=jsonl writes nothing for an empty timeline', async () => {
    mockGetTimeline.mockResolvedValue([])
    const cap = captureStdout(() => showEvidence('demo', 'jsonl'))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('format=json is unchanged — prints the full enriched envelope', async () => {
    mockGetTimeline.mockResolvedValue(timeline)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showEvidence('demo', 'json')
    } finally {
      console.log = origLog
    }
    const expected = timeline.map(entry => ({
      ...entry,
      cited: entry.runs[entry.runs.length - 1]?.citationState === 'cited',
    }))
    expect(JSON.parse(logs.join(''))).toEqual(expected)
  })
})
