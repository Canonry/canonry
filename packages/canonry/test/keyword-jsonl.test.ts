import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockListKeywords = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    listKeywords: mockListKeywords,
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

const { listKeywords } = await import('../src/commands/keyword.js')

const keywords = [
  { id: 'kw_1', keyword: 'best running shoes', createdAt: '2026-04-28T00:00:00.000Z' },
  { id: 'kw_2', keyword: 'trail running gear', createdAt: '2026-04-28T01:00:00.000Z' },
  { id: 'kw_3', keyword: 'marathon training', createdAt: '2026-04-28T02:00:00.000Z' },
]

describe('listKeywords --format jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits one self-contained key-phrase record per line', async () => {
    mockListKeywords.mockResolvedValue(keywords)
    const cap = captureStdout(() => listKeywords('demo', 'jsonl'))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(3)
    // Each line parses on its own — no envelope to unwrap.
    const records = lines.map(l => JSON.parse(l!))
    expect(records[0]).toMatchObject({
      project: 'demo',
      id: 'kw_1',
      keyword: 'best running shoes',
      createdAt: '2026-04-28T00:00:00.000Z',
    })
    expect(records.map(r => r.id)).toEqual(['kw_1', 'kw_2', 'kw_3'])
  })

  it('tags every line with the project arg the handler received', async () => {
    mockListKeywords.mockResolvedValue(keywords)
    const cap = captureStdout(() => listKeywords('demo', 'jsonl'))
    await cap.run
    const records = cap.lines().map(l => JSON.parse(l!))
    expect(records.every(r => r.project === 'demo')).toBe(true)
  })

  it('record fields win over the injected context (spread last)', async () => {
    mockListKeywords.mockResolvedValue(keywords)
    const cap = captureStdout(() => listKeywords('demo', 'jsonl'))
    await cap.run
    const record = JSON.parse(cap.lines()[0]!)
    // The injected project is prepended; the record's own fields are intact.
    expect(record.project).toBe('demo')
    expect(record.keyword).toBe('best running shoes')
  })

  it('empty collection writes nothing on the jsonl path', async () => {
    mockListKeywords.mockResolvedValue([])
    const cap = captureStdout(() => listKeywords('demo', 'jsonl'))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('leaves the --format json envelope unchanged (bare array, pretty-printed)', async () => {
    mockListKeywords.mockResolvedValue(keywords)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await listKeywords('demo', 'json')
    } finally {
      console.log = origLog
    }
    // json prints the bare collection exactly as before — no project tag, no flattening.
    expect(JSON.parse(logs.join(''))).toEqual(keywords)
  })
})
