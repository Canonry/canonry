import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockListRuns = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    listRuns: mockListRuns,
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

const { listRuns } = await import('../src/commands/run.js')

const runRows = [
  {
    id: 'run-1',
    status: 'completed',
    kind: 'answer-visibility',
    trigger: 'manual',
    startedAt: '2026-04-28T00:00:01.000Z',
    finishedAt: '2026-04-28T00:00:05.000Z',
    createdAt: '2026-04-28T00:00:00.000Z',
  },
  {
    id: 'run-2',
    status: 'completed',
    kind: 'answer-visibility',
    trigger: 'probe',
    startedAt: '2026-04-28T01:00:01.000Z',
    finishedAt: '2026-04-28T01:00:05.000Z',
    createdAt: '2026-04-28T01:00:00.000Z',
  },
]

describe('listRuns --format jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits one self-contained run per line — no envelope to unwrap', async () => {
    mockListRuns.mockResolvedValue(runRows)
    const cap = captureStdout(() => listRuns('demo', { format: 'jsonl' }))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    // Each line parses on its own.
    const records = lines.map(l => JSON.parse(l!))
    expect(records.map(r => r.id)).toEqual(['run-1', 'run-2'])
    expect(records[0]).toMatchObject({
      project: 'demo',
      id: 'run-1',
      status: 'completed',
      kind: 'answer-visibility',
      trigger: 'manual',
    })
  })

  it('tags every line with the project arg the handler received', async () => {
    mockListRuns.mockResolvedValue(runRows)
    const cap = captureStdout(() => listRuns('demo', { format: 'jsonl' }))
    await cap.run
    const records = cap.lines().map(l => JSON.parse(l!))
    expect(records.every(r => r.project === 'demo')).toBe(true)
  })

  it('includes probe runs in the jsonl stream (no probe filtering)', async () => {
    mockListRuns.mockResolvedValue(runRows)
    const cap = captureStdout(() => listRuns('demo', { format: 'jsonl' }))
    await cap.run
    const records = cap.lines().map(l => JSON.parse(l!))
    expect(records.map(r => r.trigger)).toContain('probe')
  })

  it('writes nothing for an empty collection', async () => {
    mockListRuns.mockResolvedValue([])
    const cap = captureStdout(() => listRuns('demo', { format: 'jsonl' }))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('leaves the --format json branch unchanged (full envelope, pretty-printed)', async () => {
    mockListRuns.mockResolvedValue(runRows)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await listRuns('demo', { format: 'json' })
    } finally {
      console.log = origLog
    }
    expect(JSON.parse(logs.join(''))).toEqual(runRows)
    // The json branch pretty-prints with 2-space indentation, unchanged.
    expect(logs.join('')).toBe(JSON.stringify(runRows, null, 2))
  })
})
