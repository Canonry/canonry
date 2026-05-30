import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { DiscoverySessionDetailDto, DiscoverySessionDto } from '@ainyc/canonry-contracts'

const mockListDiscoverySessions = vi.fn()
const mockGetDiscoverySession = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    listDiscoverySessions: mockListDiscoverySessions,
    getDiscoverySession: mockGetDiscoverySession,
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

const { discoverList, discoverShow, discoverProbe } = await import('../src/commands/discover.js')

function session(id: string): DiscoverySessionDto {
  return {
    id,
    projectId: 'proj-1',
    status: 'completed',
    probeCount: 2,
    citedCount: 1,
    aspirationalCount: 0,
    wastedCount: 1,
    competitorMap: [],
    createdAt: '2026-05-01T00:00:00.000Z',
  }
}

function probe(query: string, bucket: DiscoverySessionDetailDto['probes'][number]['bucket']) {
  return {
    id: `probe-${query}`,
    sessionId: 'sess-1',
    projectId: 'proj-1',
    query,
    bucket,
    citationState: 'cited' as const,
    citedDomains: ['example.com'],
    createdAt: '2026-05-01T00:00:00.000Z',
  }
}

const detail: DiscoverySessionDetailDto = {
  ...session('sess-1'),
  probes: [probe('best crm', 'cited'), probe('cheap crm', 'wasted-surface')],
}

describe('discoverList --format jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits one self-contained session per line, each tagged with project', async () => {
    const sessions = [session('sess-a'), session('sess-b'), session('sess-c')]
    mockListDiscoverySessions.mockResolvedValue(sessions)
    const cap = captureStdout(() => discoverList('demo', { format: 'jsonl' }))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(3)
    const records = lines.map(l => JSON.parse(l))
    expect(records.map(r => r.id)).toEqual(['sess-a', 'sess-b', 'sess-c'])
    expect(records.every(r => r.project === 'demo')).toBe(true)
    // Record fields survive — the record is spread last so its own fields win.
    expect(records[0]).toMatchObject({ project: 'demo', id: 'sess-a', status: 'completed' })
  })

  it('empty collection emits nothing', async () => {
    mockListDiscoverySessions.mockResolvedValue([])
    const cap = captureStdout(() => discoverList('demo', { format: 'jsonl' }))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('--format json is unchanged — prints the full session array envelope', async () => {
    const sessions = [session('sess-a'), session('sess-b')]
    mockListDiscoverySessions.mockResolvedValue(sessions)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await discoverList('demo', { format: 'json' })
    } finally {
      console.log = origLog
    }
    expect(JSON.parse(logs.join(''))).toEqual(sessions)
  })
})

describe('discoverShow --format jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('streams probes one per line, each stamped with project + sessionId', async () => {
    mockGetDiscoverySession.mockResolvedValue(detail)
    const cap = captureStdout(() => discoverShow('demo', 'sess-1', { format: 'jsonl' }))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    const records = lines.map(l => JSON.parse(l))
    expect(records.map(r => r.query)).toEqual(['best crm', 'cheap crm'])
    expect(records.every(r => r.project === 'demo' && r.sessionId === 'sess-1')).toBe(true)
    expect(records[0]).toMatchObject({
      project: 'demo',
      sessionId: 'sess-1',
      query: 'best crm',
      bucket: 'cited',
      citationState: 'cited',
    })
  })

  it('session with no probes emits nothing', async () => {
    mockGetDiscoverySession.mockResolvedValue({ ...session('sess-1'), probes: [] })
    const cap = captureStdout(() => discoverShow('demo', 'sess-1', { format: 'jsonl' }))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('--format json is unchanged — prints the full session detail envelope', async () => {
    mockGetDiscoverySession.mockResolvedValue(detail)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await discoverShow('demo', 'sess-1', { format: 'json' })
    } finally {
      console.log = origLog
    }
    expect(JSON.parse(logs.join(''))).toEqual(detail)
  })
})

describe('discoverProbe --format jsonl (alias of show)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('streams probes one per line with the same project + sessionId stamp', async () => {
    mockGetDiscoverySession.mockResolvedValue(detail)
    const cap = captureStdout(() => discoverProbe('demo', 'sess-1', { format: 'jsonl' }))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    const records = lines.map(l => JSON.parse(l))
    expect(records.every(r => r.project === 'demo' && r.sessionId === 'sess-1')).toBe(true)
    expect(records.map(r => r.query)).toEqual(['best crm', 'cheap crm'])
  })

  it('--format json is unchanged — prints the full session detail envelope', async () => {
    mockGetDiscoverySession.mockResolvedValue(detail)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await discoverProbe('demo', 'sess-1', { format: 'json' })
    } finally {
      console.log = origLog
    }
    expect(JSON.parse(logs.join(''))).toEqual(detail)
  })
})
