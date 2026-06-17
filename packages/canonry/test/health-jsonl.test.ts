import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { HealthSnapshotDto } from '@ainyc/canonry-contracts'

const mockGetHealth = vi.fn()
const mockGetHealthHistory = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getHealth: mockGetHealth,
    getHealthHistory: mockGetHealthHistory,
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

const { showHealth } = await import('../src/commands/health-cmd.js')

const snapshots: HealthSnapshotDto[] = [
  {
    id: 'snap-1',
    projectId: 'proj-1',
    runId: 'run-1',
    overallCitedRate: 0.42,
    overallMentionRate: 0.25,
    totalPairs: 12,
    citedPairs: 5,
    mentionedPairs: 3,
    providerBreakdown: { openai: { citedRate: 0.5, mentionRate: 0.33, cited: 3, mentioned: 2, total: 6 } },
    createdAt: '2026-04-28T00:00:00.000Z',
    status: 'ready',
  },
  {
    id: 'snap-2',
    projectId: 'proj-1',
    runId: 'run-2',
    overallCitedRate: 0.5,
    overallMentionRate: 0.33,
    totalPairs: 12,
    citedPairs: 6,
    mentionedPairs: 4,
    providerBreakdown: { openai: { citedRate: 0.6, mentionRate: 0.5, cited: 4, mentioned: 3, total: 6 } },
    createdAt: '2026-04-29T00:00:00.000Z',
    status: 'ready',
  },
]

const health: HealthSnapshotDto = {
  id: 'snap-latest',
  projectId: 'proj-1',
  runId: 'run-2',
  overallCitedRate: 0.5,
  overallMentionRate: 0.33,
  totalPairs: 12,
  citedPairs: 6,
  mentionedPairs: 4,
  providerBreakdown: { openai: { citedRate: 0.6, mentionRate: 0.5, cited: 4, mentioned: 3, total: 6 } },
  createdAt: '2026-04-29T00:00:00.000Z',
  status: 'ready',
}

describe('showHealth --format jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('--history (list-shaped)', () => {
    it('emits one self-contained snapshot per line, each tagged with project', async () => {
      mockGetHealthHistory.mockResolvedValue(snapshots)
      const cap = captureStdout(() => showHealth('demo', { history: true, format: 'jsonl' }))
      await cap.run
      const lines = cap.lines()
      expect(lines).toHaveLength(2)
      const records = lines.map(l => JSON.parse(l))
      // each line parses on its own and carries the injected project context
      expect(records.every(r => r.project === 'demo')).toBe(true)
      expect(records[0]).toMatchObject({
        project: 'demo',
        id: 'snap-1',
        overallCitedRate: 0.42,
        citedPairs: 5,
        totalPairs: 12,
        // Mention fields ride alongside cited in the machine output.
        overallMentionRate: 0.25,
        mentionedPairs: 3,
      })
      expect(records[1]).toMatchObject({ project: 'demo', id: 'snap-2', citedPairs: 6, mentionedPairs: 4 })
    })

    it('empty history emits nothing on jsonl', async () => {
      mockGetHealthHistory.mockResolvedValue([])
      const cap = captureStdout(() => showHealth('demo', { history: true, format: 'jsonl' }))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('--format json prints the unchanged history envelope', async () => {
      mockGetHealthHistory.mockResolvedValue(snapshots)
      const logs: string[] = []
      const origLog = console.log
      console.log = (...args: unknown[]) => logs.push(args.join(' '))
      try {
        await showHealth('demo', { history: true, format: 'json' })
      } finally {
        console.log = origLog
      }
      expect(JSON.parse(logs.join(''))).toEqual(snapshots)
    })
  })

  describe('default (single object)', () => {
    it('jsonl maps onto json — prints the object, does not fall through to human text', async () => {
      mockGetHealth.mockResolvedValue(health)
      const logs: string[] = []
      const origLog = console.log
      console.log = (...args: unknown[]) => logs.push(args.join(' '))
      try {
        await showHealth('demo', { format: 'jsonl' })
      } finally {
        console.log = origLog
      }
      // single status object is emitted as machine output, identical to json
      expect(JSON.parse(logs.join(''))).toEqual(health)
      // no human "Health: ...% cited" line leaked
      expect(logs.join('\n')).not.toContain('Health:')
    })

    it('--format json prints the unchanged single-health envelope', async () => {
      mockGetHealth.mockResolvedValue(health)
      const logs: string[] = []
      const origLog = console.log
      console.log = (...args: unknown[]) => logs.push(args.join(' '))
      try {
        await showHealth('demo', { format: 'json' })
      } finally {
        console.log = origLog
      }
      expect(JSON.parse(logs.join(''))).toEqual(health)
    })
  })
})

describe('showHealth human render', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('leads with mention rate and shows cited rate alongside it', async () => {
    mockGetHealth.mockResolvedValue(health)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showHealth('demo', {})
    } finally {
      console.log = origLog
    }
    const out = logs.join('\n')
    // Both signals present, mention first.
    expect(out).toContain('33.0% mentioned (4/12 pairs)')
    expect(out).toContain('50.0% cited (6/12 pairs)')
    const mentionIdx = out.indexOf('mentioned')
    const citedIdx = out.indexOf('cited')
    expect(mentionIdx).toBeGreaterThanOrEqual(0)
    expect(mentionIdx).toBeLessThan(citedIdx) // mention leads
    // Per-provider line carries both rates too.
    expect(out).toContain('50.0% mentioned (3/6)')
    expect(out).toContain('60.0% cited (4/6)')
  })

  it('--history table renders a Mention Rate column next to Cited Rate', async () => {
    mockGetHealthHistory.mockResolvedValue(snapshots)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showHealth('demo', { history: true })
    } finally {
      console.log = origLog
    }
    const out = logs.join('\n')
    expect(out).toContain('Mention Rate')
    expect(out).toContain('Cited Rate')
    // Header puts mention before cited.
    const header = logs.find(l => l.includes('Mention Rate')) ?? ''
    expect(header.indexOf('Mention Rate')).toBeLessThan(header.indexOf('Cited Rate'))
    // Row carries the mention numerator/denominator (3/12) and cited (5/12).
    expect(out).toContain('25.0%')
    expect(out).toContain('3/12')
    expect(out).toContain('5/12')
  })
})
