import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { CompetitorDto } from '@ainyc/canonry-contracts'

const mockListCompetitors = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    listCompetitors: mockListCompetitors,
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

const { listCompetitors } = await import('../src/commands/competitor.js')

// The stored shape: `aliases` is always present, often empty.
const comps: CompetitorDto[] = [
  { id: 'c1', domain: 'rival-one.com', aliases: ['Rival One', 'R1 Supply'], createdAt: '2026-04-01T00:00:00.000Z' },
  { id: 'c2', domain: 'rival-two.com', aliases: [], createdAt: '2026-04-02T00:00:00.000Z' },
  { id: 'c3', domain: 'rival-three.com', aliases: [], createdAt: '2026-04-03T00:00:00.000Z' },
]

describe('listCompetitors jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('format=jsonl emits one self-contained competitor per line — no envelope to unwrap', async () => {
    mockListCompetitors.mockResolvedValue(comps)
    const cap = captureStdout(() => listCompetitors('demo', 'jsonl'))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(comps.length)
    // Each line parses on its own.
    const records = lines.map(l => JSON.parse(l))
    expect(records.map(r => r.domain)).toEqual([
      'rival-one.com',
      'rival-two.com',
      'rival-three.com',
    ])
  })

  it('format=jsonl injects project on every line and the record fields win', async () => {
    mockListCompetitors.mockResolvedValue(comps)
    const cap = captureStdout(() => listCompetitors('demo', 'jsonl'))
    await cap.run
    const records = cap.lines().map(l => JSON.parse(l))
    expect(records.every(r => r.project === 'demo')).toBe(true)
    expect(records[0]).toEqual({
      project: 'demo',
      id: 'c1',
      domain: 'rival-one.com',
      aliases: ['Rival One', 'R1 Supply'],
      createdAt: '2026-04-01T00:00:00.000Z',
    })
    expect(records.map(r => r.aliases)).toEqual([['Rival One', 'R1 Supply'], [], []])
  })

  it('format=jsonl on an empty collection writes nothing', async () => {
    mockListCompetitors.mockResolvedValue([])
    const cap = captureStdout(() => listCompetitors('demo', 'jsonl'))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('format=json is unchanged — prints the full envelope exactly as before', async () => {
    mockListCompetitors.mockResolvedValue(comps)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await listCompetitors('demo', 'json')
    } finally {
      console.log = origLog
    }
    const printed = JSON.parse(logs.join('')) as CompetitorDto[]
    expect(printed).toEqual(comps)
    expect(printed.map(c => c.aliases)).toEqual([['Rival One', 'R1 Supply'], [], []])
  })
})
