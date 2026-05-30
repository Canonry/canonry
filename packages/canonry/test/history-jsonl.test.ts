import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { AuditLogEntry } from '@ainyc/canonry-contracts'

const mockGetHistory = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getHistory: mockGetHistory,
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

const { showHistory } = await import('../src/commands/history.js')

const entries: AuditLogEntry[] = [
  {
    id: 'a1',
    projectId: 'p1',
    actor: 'cli',
    action: 'project.create',
    entityType: 'project',
    entityId: 'p1',
    createdAt: '2026-04-28T00:00:00.000Z',
  },
  {
    id: 'a2',
    projectId: 'p1',
    actor: 'scheduler',
    action: 'run.completed',
    entityType: 'run',
    entityId: 'r1',
    createdAt: '2026-04-28T01:00:00.000Z',
  },
]

describe('showHistory --format jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits one self-contained record per line — no envelope to unwrap', async () => {
    mockGetHistory.mockResolvedValue(entries)
    const cap = captureStdout(() => showHistory('demo', 'jsonl'))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    // Each line parses on its own.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it('tags every line with the injected project context', async () => {
    mockGetHistory.mockResolvedValue(entries)
    const cap = captureStdout(() => showHistory('demo', 'jsonl'))
    await cap.run
    const records = cap.lines().map(l => JSON.parse(l))
    expect(records.every(r => r.project === 'demo')).toBe(true)
    // Record's own fields survive (spread last) — e.g. action + actor.
    expect(records[0]).toMatchObject({
      project: 'demo',
      action: 'project.create',
      actor: 'cli',
      entityType: 'project',
    })
  })

  it('empty collection writes nothing', async () => {
    mockGetHistory.mockResolvedValue([])
    const cap = captureStdout(() => showHistory('demo', 'jsonl'))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('--format json branch is unchanged — full envelope pretty-printed via console.log', async () => {
    mockGetHistory.mockResolvedValue(entries)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showHistory('demo', 'json')
    } finally {
      console.log = origLog
    }
    expect(JSON.parse(logs.join(''))).toEqual(entries)
  })
})
