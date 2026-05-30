import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { BacklinkListResponse, CcCachedRelease } from '@ainyc/canonry-contracts'

const mockBacklinksDomains = vi.fn()
const mockBacklinksCachedReleases = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    backlinksDomains: mockBacklinksDomains,
    backlinksCachedReleases: mockBacklinksCachedReleases,
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

const { backlinksList, backlinksReleases } = await import('../src/commands/backlinks.js')

const listResponse: BacklinkListResponse = {
  summary: {
    projectId: 'proj-1',
    release: 'CC-MAIN-2026-05',
    targetDomain: 'example.com',
    totalLinkingDomains: 2,
    totalHosts: 7,
    top10HostsShare: '100%',
    queriedAt: '2026-04-28T00:00:00.000Z',
  },
  total: 2,
  rows: [
    { linkingDomain: 'partner-a.com', numHosts: 4 },
    { linkingDomain: 'partner-b.com', numHosts: 3 },
  ],
}

const cachedReleases: CcCachedRelease[] = [
  { release: 'CC-MAIN-2026-05', syncStatus: 'ready', bytes: 1024, lastUsedAt: '2026-04-28T00:00:00.000Z' },
  { release: 'CC-MAIN-2026-01', syncStatus: 'ready', bytes: 2048, lastUsedAt: null },
]

describe('backlinksList --format jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits one self-contained linking-domain record per line, each carrying project + release + targetDomain', async () => {
    mockBacklinksDomains.mockResolvedValue(listResponse)
    const cap = captureStdout(() => backlinksList({ project: 'demo', format: 'jsonl' }))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    const records = lines.map(l => JSON.parse(l))
    // Context injected from the envelope so each line stands alone.
    expect(records[0]).toMatchObject({
      project: 'demo',
      release: 'CC-MAIN-2026-05',
      targetDomain: 'example.com',
      linkingDomain: 'partner-a.com',
      numHosts: 4,
    })
    expect(records[1]).toMatchObject({
      project: 'demo',
      release: 'CC-MAIN-2026-05',
      targetDomain: 'example.com',
      linkingDomain: 'partner-b.com',
      numHosts: 3,
    })
    expect(records.every(r => r.project === 'demo')).toBe(true)
    expect(records.every(r => r.release === 'CC-MAIN-2026-05')).toBe(true)
    expect(records.every(r => r.targetDomain === 'example.com')).toBe(true)
  })

  it('the record fields win over context when keys collide (record spread last)', async () => {
    mockBacklinksDomains.mockResolvedValue(listResponse)
    const cap = captureStdout(() => backlinksList({ project: 'demo', format: 'jsonl' }))
    await cap.run
    const record = JSON.parse(cap.lines()[0]!)
    // No `linkingDomain` collision, but assert the row's own fields survive intact.
    expect(record.linkingDomain).toBe('partner-a.com')
    expect(record.numHosts).toBe(4)
  })

  it('emits nothing when there are no rows', async () => {
    mockBacklinksDomains.mockResolvedValue({ summary: listResponse.summary, total: 0, rows: [] })
    const cap = captureStdout(() => backlinksList({ project: 'demo', format: 'jsonl' }))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('emits nothing when there is no ready release (summary null, rows empty)', async () => {
    mockBacklinksDomains.mockResolvedValue({ summary: null, total: 0, rows: [] })
    const cap = captureStdout(() => backlinksList({ project: 'demo', format: 'jsonl' }))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('leaves --format json output unchanged (full envelope, pretty-printed)', async () => {
    mockBacklinksDomains.mockResolvedValue(listResponse)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await backlinksList({ project: 'demo', format: 'json' })
    } finally {
      console.log = origLog
    }
    expect(JSON.parse(logs.join(''))).toEqual(listResponse)
  })
})

describe('backlinksReleases --format jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits one bare cached-release record per line — no project tag (global workspace scope)', async () => {
    mockBacklinksCachedReleases.mockResolvedValue(cachedReleases)
    const cap = captureStdout(() => backlinksReleases({ format: 'jsonl' }))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    const records = lines.map(l => JSON.parse(l))
    // Records self-identify by `release`; no `project` tag is injected.
    expect(records.every(r => !('project' in r))).toBe(true)
    expect(records[0]).toEqual(cachedReleases[0])
    expect(records[1]).toEqual(cachedReleases[1])
  })

  it('emits nothing when there are no cached releases', async () => {
    mockBacklinksCachedReleases.mockResolvedValue([])
    const cap = captureStdout(() => backlinksReleases({ format: 'jsonl' }))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('leaves --format json output unchanged (full array, pretty-printed)', async () => {
    mockBacklinksCachedReleases.mockResolvedValue(cachedReleases)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await backlinksReleases({ format: 'json' })
    } finally {
      console.log = origLog
    }
    expect(JSON.parse(logs.join(''))).toEqual(cachedReleases)
  })
})
