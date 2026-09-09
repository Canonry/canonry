import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { AuditLogEntry } from '@ainyc/canonry-contracts'

const mockClearResults = vi.fn()
const mockGetHistory = vi.fn()
const mockGetGlobalHistory = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getHistory: mockGetHistory,
    clearResults: mockClearResults,
    getGlobalHistory: mockGetGlobalHistory,
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

const { clearResults, showHistory } = await import('../src/commands/history.js')

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

  it('emits instance-wide history with a null project context', async () => {
    mockGetGlobalHistory.mockResolvedValue(entries)
    const cap = captureStdout(() => showHistory(undefined, 'jsonl', { limit: 10, actor: 'cli' }))
    await cap.run

    expect(mockGetGlobalHistory).toHaveBeenCalledWith({ limit: 10, actor: 'cli' })
    expect(cap.lines().map(line => JSON.parse(line))).toEqual(
      entries.map(entry => ({ project: null, ...entry })),
    )
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

describe('results clear', () => {
  beforeEach(() => vi.clearAllMocks())
  it('sends only exact IDs and explicit confirmation through the client, with machine-readable output', async () => {
    const result = { dryRun: true, runIds: ['saved'], researchRunIds: ['research'], querySnapshots: 3, researchQueries: 1, insights: 0, healthSnapshots: 0 }
    mockClearResults.mockResolvedValue(result)
    const cap = captureStdout(() => clearResults('demo', { runIds: ['saved'], researchRunIds: ['research'], confirm: false, format: 'jsonl' }))
    await cap.run
    expect(mockClearResults).toHaveBeenCalledWith('demo', { runIds: ['saved'], researchRunIds: ['research'], confirm: false })
    expect(cap.lines().map(line => JSON.parse(line))).toEqual([result])
  })
  it('refuses an empty selection before contacting the server', async () => {
    await expect(clearResults('demo', { runIds: [], researchRunIds: [], confirm: true })).rejects.toMatchObject({ exitCode: 1 })
    expect(mockClearResults).not.toHaveBeenCalled()
  })
})
