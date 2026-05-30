import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockListQueries = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    listQueries: mockListQueries,
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

const { listQueries } = await import('../src/commands/query.js')

const sampleQueries = [
  { id: 'q1', query: 'best running shoes', createdAt: '2026-04-01T00:00:00.000Z' },
  { id: 'q2', query: 'how to clean suede', createdAt: '2026-04-02T00:00:00.000Z' },
  { id: 'q3', query: 'marathon training plan', createdAt: '2026-04-03T00:00:00.000Z' },
]

describe('listQueries jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('format=jsonl emits one self-contained query per line — no envelope to unwrap', async () => {
    mockListQueries.mockResolvedValue(sampleQueries)
    const cap = captureStdout(() => listQueries('demo', 'jsonl'))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(3)
    // Each line parses on its own.
    const records = lines.map(l => JSON.parse(l!))
    expect(records.map(r => r.id)).toEqual(['q1', 'q2', 'q3'])
    expect(records[0]).toMatchObject({
      project: 'demo',
      id: 'q1',
      query: 'best running shoes',
      createdAt: '2026-04-01T00:00:00.000Z',
    })
  })

  it('format=jsonl tags every line with the project context', async () => {
    mockListQueries.mockResolvedValue(sampleQueries)
    const cap = captureStdout(() => listQueries('demo', 'jsonl'))
    await cap.run
    const records = cap.lines().map(l => JSON.parse(l!))
    expect(records.every(r => r.project === 'demo')).toBe(true)
  })

  it('format=jsonl writes nothing for an empty query set', async () => {
    mockListQueries.mockResolvedValue([])
    const cap = captureStdout(() => listQueries('demo', 'jsonl'))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('format=json is unchanged — prints the full array envelope exactly as before', async () => {
    mockListQueries.mockResolvedValue(sampleQueries)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await listQueries('demo', 'json')
    } finally {
      console.log = origLog
    }
    expect(JSON.parse(logs.join(''))).toEqual(sampleQueries)
  })
})
