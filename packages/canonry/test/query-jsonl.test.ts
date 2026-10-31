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
  { id: 'q1', query: 'best running shoes', createdAt: '2026-04-01T00:00:00.000Z', queryClass: 'non-brand' },
  { id: 'q2', query: 'demo shoes review', createdAt: '2026-04-02T00:00:00.000Z', queryClass: 'branded' },
  { id: 'q3', query: 'marathon training plan', createdAt: '2026-04-03T00:00:00.000Z', queryClass: null },
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
    expect(records[0]).toEqual({
      project: 'demo',
      id: 'q1',
      query: 'best running shoes',
      createdAt: '2026-04-01T00:00:00.000Z',
      queryClass: 'non-brand',
    })
    // A missing class stays null on the wire; the dash is human output only.
    expect(records.map(r => r.queryClass)).toEqual(['non-brand', 'branded', null])
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

describe('listQueries human output', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function humanLines(): Promise<string[]> {
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await listQueries('demo')
    } finally {
      console.log = origLog
    }
    return logs.join('\n').split('\n')
  }

  it('shows the server class of every query in a CLASS column, with a dash where there is none', async () => {
    mockListQueries.mockResolvedValue(sampleQueries)
    expect(await humanLines()).toEqual([
      'Queries for "demo" (3):',
      '',
      '  CLASS      QUERY',
      '  non-brand  best running shoes',
      '  branded    demo shoes review',
      '  -          marathon training plan',
      '',
      '  - = no class: the project has no usable brand name, or its measurement plan holds no single class for that query (canonry query workspace shows the class per Property).',
    ])
  })

  it('omits the dash note when every query has a class', async () => {
    mockListQueries.mockResolvedValue(sampleQueries.slice(0, 2))
    expect(await humanLines()).toEqual([
      'Queries for "demo" (2):',
      '',
      '  CLASS      QUERY',
      '  non-brand  best running shoes',
      '  branded    demo shoes review',
    ])
  })

  it('says the class was not reported, not that none exists, for a server older than the field', async () => {
    // Rows as a server without queryClass sends them. No class is known, so
    // none is shown, and the dash is not explained as "no single class".
    mockListQueries.mockResolvedValue([
      { id: 'q1', query: 'best running shoes', createdAt: '2026-04-01T00:00:00.000Z' },
      { id: 'q2', query: 'demo shoes review', createdAt: '2026-04-02T00:00:00.000Z' },
    ])
    expect(await humanLines()).toEqual([
      'Queries for "demo" (2):',
      '',
      '  CLASS      QUERY',
      '  -          best running shoes',
      '  -          demo shoes review',
      '',
      '  - = class not reported: this server version does not send a query class. Upgrade the server to see it.',
    ])
  })
})
