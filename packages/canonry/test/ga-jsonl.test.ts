import { describe, expect, it, beforeEach, vi } from 'vitest'
import type {
  GA4AiReferralHistoryEntry,
  GA4SessionHistoryEntry,
  GA4SocialReferralHistoryEntry,
  GaCoverageResponse,
} from '@ainyc/canonry-contracts'

const mockGaAiReferralHistory = vi.fn()
const mockGaSocialReferralHistory = vi.fn()
const mockGaSessionHistory = vi.fn()
const mockGaCoverage = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    gaAiReferralHistory: mockGaAiReferralHistory,
    gaSocialReferralHistory: mockGaSocialReferralHistory,
    gaSessionHistory: mockGaSessionHistory,
    gaCoverage: mockGaCoverage,
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

/** Capture `console.log` (the json-envelope path). */
function captureLog(fn: () => Promise<void>): { run: Promise<void>; text: () => string } {
  const logs: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  const run = fn().finally(() => { console.log = orig })
  return { run, text: () => logs.join('') }
}

const {
  gaAiReferralHistory,
  gaSocialReferralHistory,
  gaSessionHistory,
  gaCoverage,
} = await import('../src/commands/ga.js')

const aiRows: GA4AiReferralHistoryEntry[] = [
  { date: '2026-05-01', source: 'chatgpt.com', medium: 'referral', landingPage: '/a', sourceDimension: 'session', sessions: 12, users: 9 },
  { date: '2026-05-02', source: 'perplexity.ai', medium: 'referral', landingPage: '/b', sourceDimension: 'first_user', sessions: 5, users: 4 },
]

const socialRows: GA4SocialReferralHistoryEntry[] = [
  { date: '2026-05-01', source: 'x.com', medium: 'referral', sessions: 8, users: 7, channelGroup: 'Organic Social' },
  { date: '2026-05-02', source: 'linkedin.com', medium: 'referral', sessions: 3, users: 3, channelGroup: 'Paid Social' },
]

const sessionRows: GA4SessionHistoryEntry[] = [
  { date: '2026-05-01', sessions: 120, organicSessions: 80, users: 100 },
  { date: '2026-05-02', sessions: 130, organicSessions: 90, users: 110 },
]

const coverage: GaCoverageResponse = {
  pages: [
    { landingPage: '/', sessions: 200, organicSessions: 150, users: 180 },
    { landingPage: '/pricing', sessions: 50, organicSessions: 40, users: 45 },
  ],
}

describe('gaAiReferralHistory --format jsonl', () => {
  beforeEach(() => vi.clearAllMocks())

  it('emits one self-contained record per line, each tagged with project + window', async () => {
    mockGaAiReferralHistory.mockResolvedValue(aiRows)
    const cap = captureStdout(() => gaAiReferralHistory('demo', { window: '28d', format: 'jsonl' }))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(aiRows.length)
    const records = lines.map(l => JSON.parse(l))
    expect(records.every(r => r.project === 'demo')).toBe(true)
    expect(records.every(r => r.window === '28d')).toBe(true)
    expect(records[0]).toMatchObject({ project: 'demo', window: '28d', date: '2026-05-01', source: 'chatgpt.com', sessions: 12, users: 9 })
  })

  it('stamps window as the resolved value (omitted from JSON when --window not passed)', async () => {
    mockGaAiReferralHistory.mockResolvedValue(aiRows)
    const cap = captureStdout(() => gaAiReferralHistory('demo', { format: 'jsonl' }))
    await cap.run
    const record = JSON.parse(cap.lines()[0]!)
    expect(record.project).toBe('demo')
    // window === undefined, so JSON.stringify drops the key entirely.
    expect('window' in record).toBe(false)
    expect(record.window).toBeUndefined()
  })

  it('emits nothing for an empty collection', async () => {
    mockGaAiReferralHistory.mockResolvedValue([])
    const cap = captureStdout(() => gaAiReferralHistory('demo', { window: '28d', format: 'jsonl' }))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('leaves --format json unchanged (full array envelope)', async () => {
    mockGaAiReferralHistory.mockResolvedValue(aiRows)
    const cap = captureLog(() => gaAiReferralHistory('demo', { window: '28d', format: 'json' }))
    await cap.run
    expect(JSON.parse(cap.text())).toEqual(aiRows)
  })
})

describe('gaSocialReferralHistory --format jsonl', () => {
  beforeEach(() => vi.clearAllMocks())

  it('emits one record per line tagged with project + window', async () => {
    mockGaSocialReferralHistory.mockResolvedValue(socialRows)
    const cap = captureStdout(() => gaSocialReferralHistory('demo', { window: '90d', format: 'jsonl' }))
    await cap.run
    const records = cap.lines().map(l => JSON.parse(l))
    expect(records).toHaveLength(socialRows.length)
    expect(records.every(r => r.project === 'demo' && r.window === '90d')).toBe(true)
    expect(records[1]).toMatchObject({ source: 'linkedin.com', channelGroup: 'Paid Social', sessions: 3 })
  })

  it('emits nothing for an empty collection', async () => {
    mockGaSocialReferralHistory.mockResolvedValue([])
    const cap = captureStdout(() => gaSocialReferralHistory('demo', { format: 'jsonl' }))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('leaves --format json unchanged (full array envelope)', async () => {
    mockGaSocialReferralHistory.mockResolvedValue(socialRows)
    const cap = captureLog(() => gaSocialReferralHistory('demo', { format: 'json' }))
    await cap.run
    expect(JSON.parse(cap.text())).toEqual(socialRows)
  })
})

describe('gaSessionHistory --format jsonl', () => {
  beforeEach(() => vi.clearAllMocks())

  it('emits one record per line tagged with project + window', async () => {
    mockGaSessionHistory.mockResolvedValue(sessionRows)
    const cap = captureStdout(() => gaSessionHistory('demo', { window: '7d', format: 'jsonl' }))
    await cap.run
    const records = cap.lines().map(l => JSON.parse(l))
    expect(records).toHaveLength(sessionRows.length)
    expect(records.every(r => r.project === 'demo' && r.window === '7d')).toBe(true)
    expect(records[0]).toMatchObject({ date: '2026-05-01', sessions: 120, organicSessions: 80, users: 100 })
  })

  it('emits nothing for an empty collection', async () => {
    mockGaSessionHistory.mockResolvedValue([])
    const cap = captureStdout(() => gaSessionHistory('demo', { format: 'jsonl' }))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('leaves --format json unchanged (full array envelope)', async () => {
    mockGaSessionHistory.mockResolvedValue(sessionRows)
    const cap = captureLog(() => gaSessionHistory('demo', { format: 'json' }))
    await cap.run
    expect(JSON.parse(cap.text())).toEqual(sessionRows)
  })
})

describe('gaCoverage --format jsonl', () => {
  beforeEach(() => vi.clearAllMocks())

  it('emits one page record per line tagged with project (no window)', async () => {
    mockGaCoverage.mockResolvedValue(coverage)
    const cap = captureStdout(() => gaCoverage('demo', 'jsonl'))
    await cap.run
    const records = cap.lines().map(l => JSON.parse(l))
    expect(records).toHaveLength(coverage.pages.length)
    expect(records.every(r => r.project === 'demo')).toBe(true)
    expect(records[0]).toMatchObject({ project: 'demo', landingPage: '/', sessions: 200, organicSessions: 150, users: 180 })
    // No window context for coverage.
    expect('window' in records[0]).toBe(false)
  })

  it('emits nothing when pages is empty', async () => {
    mockGaCoverage.mockResolvedValue({ pages: [] })
    const cap = captureStdout(() => gaCoverage('demo', 'jsonl'))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('leaves --format json unchanged (full envelope)', async () => {
    mockGaCoverage.mockResolvedValue(coverage)
    const cap = captureLog(() => gaCoverage('demo', 'json'))
    await cap.run
    expect(JSON.parse(cap.text())).toEqual(coverage)
  })
})
