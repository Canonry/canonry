import { describe, expect, it, beforeEach, vi } from 'vitest'
import type {
  ContentTargetsResponseDto,
  ContentSourcesResponseDto,
  ContentGapsResponseDto,
} from '@ainyc/canonry-contracts'

const mockGetContentTargets = vi.fn()
const mockGetContentSources = vi.fn()
const mockGetContentGaps = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getContentTargets: mockGetContentTargets,
    getContentSources: mockGetContentSources,
    getContentGaps: mockGetContentGaps,
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

/** Capture `console.log` (the json/human path). */
async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  try {
    await fn()
  } finally {
    console.log = origLog
  }
  return logs
}

const { listContentTargets, listContentSources, listContentGaps } = await import(
  '../src/commands/content.js'
)

const targetsResponse: ContentTargetsResponseDto = {
  targets: [
    {
      query: 'best crm for startups',
      ourBestPage: { url: 'https://acme.com/crm', gscAvgPosition: 4 },
      winningCompetitor: { url: 'https://rival.com/crm', citationCount: 7 },
      action: 'create',
      score: 88.2,
      scoreBreakdown: { demand: 40, gap: 30, feasibility: 18.2 },
      drivers: ['high demand', 'competitor cited'],
      demandSource: 'gsc',
      actionConfidence: 'high',
      existingAction: null,
    },
    {
      query: 'crm pricing comparison',
      ourBestPage: null,
      winningCompetitor: null,
      action: 'improve',
      score: 55.0,
      scoreBreakdown: { demand: 20, gap: 20, feasibility: 15 },
      drivers: [],
      demandSource: 'llm',
      actionConfidence: 'medium',
      existingAction: null,
    },
  ],
  contextMetrics: {
    totalAiReferralSessions: 1200,
    latestRunId: 'run_abc123',
    runTimestamp: '2026-05-30T00:00:00.000Z',
  },
} as unknown as ContentTargetsResponseDto

const emptyTargetsResponse: ContentTargetsResponseDto = {
  targets: [],
  contextMetrics: {
    totalAiReferralSessions: 0,
    latestRunId: 'run_empty',
    runTimestamp: '2026-05-30T00:00:00.000Z',
  },
}

const sourcesResponse: ContentSourcesResponseDto = {
  sources: [
    {
      query: 'best crm for startups',
      groundingSources: [
        {
          uri: 'https://acme.com/crm',
          title: 'Acme CRM',
          domain: 'acme.com',
          isOurDomain: true,
          isCompetitor: false,
          citationCount: 3,
          providers: ['gemini'],
        },
      ],
    },
    {
      query: 'crm pricing comparison',
      groundingSources: [],
    },
  ],
  latestRunId: 'run_xyz789',
} as unknown as ContentSourcesResponseDto

const emptySourcesResponse: ContentSourcesResponseDto = {
  sources: [],
  latestRunId: 'run_empty',
}

const gapsResponse: ContentGapsResponseDto = {
  gaps: [
    {
      query: 'crm for nonprofits',
      competitorDomains: ['rival.com', 'other.com'],
      competitorCount: 2,
      missRate: 0.75,
      lastSeenInRunId: 'run_g1',
    },
    {
      query: 'free crm software',
      competitorDomains: ['rival.com'],
      competitorCount: 1,
      missRate: 0.5,
      lastSeenInRunId: 'run_g2',
    },
  ],
  latestRunId: 'run_gaps',
}

const emptyGapsResponse: ContentGapsResponseDto = {
  gaps: [],
  latestRunId: 'run_empty',
}

describe('listContentTargets jsonl', () => {
  beforeEach(() => vi.clearAllMocks())

  it('emits one self-contained record per target, tagged with project + latestRunId', async () => {
    mockGetContentTargets.mockResolvedValue(targetsResponse)
    const cap = captureStdout(() => listContentTargets('demo', { format: 'jsonl' }))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    const records = lines.map(l => JSON.parse(l))
    for (const record of records) {
      expect(record.project).toBe('demo')
      expect(record.latestRunId).toBe('run_abc123')
    }
    // Record fields win — query/action/score survive the spread.
    expect(records[0]).toMatchObject({
      project: 'demo',
      latestRunId: 'run_abc123',
      query: 'best crm for startups',
      action: 'create',
      score: 88.2,
    })
  })

  it('empty collection writes nothing', async () => {
    mockGetContentTargets.mockResolvedValue(emptyTargetsResponse)
    const cap = captureStdout(() => listContentTargets('demo', { format: 'jsonl' }))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('--format json is unchanged: prints the full envelope verbatim', async () => {
    mockGetContentTargets.mockResolvedValue(targetsResponse)
    const logs = await captureLog(() => listContentTargets('demo', { format: 'json' }))
    expect(JSON.parse(logs.join('\n'))).toEqual(targetsResponse)
  })
})

describe('listContentSources jsonl', () => {
  beforeEach(() => vi.clearAllMocks())

  it('emits one self-contained record per source, tagged with project', async () => {
    mockGetContentSources.mockResolvedValue(sourcesResponse)
    const cap = captureStdout(() => listContentSources('demo', { format: 'jsonl' }))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    const records = lines.map(l => JSON.parse(l))
    expect(records.every(r => r.project === 'demo')).toBe(true)
    expect(records[0]).toMatchObject({
      project: 'demo',
      query: 'best crm for startups',
    })
    expect(records[0].groundingSources).toHaveLength(1)
  })

  it('empty collection writes nothing', async () => {
    mockGetContentSources.mockResolvedValue(emptySourcesResponse)
    const cap = captureStdout(() => listContentSources('demo', { format: 'jsonl' }))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('--format json is unchanged: prints the full envelope verbatim', async () => {
    mockGetContentSources.mockResolvedValue(sourcesResponse)
    const logs = await captureLog(() => listContentSources('demo', { format: 'json' }))
    expect(JSON.parse(logs.join('\n'))).toEqual(sourcesResponse)
  })
})

describe('listContentGaps jsonl', () => {
  beforeEach(() => vi.clearAllMocks())

  it('emits one self-contained record per gap, tagged with project', async () => {
    mockGetContentGaps.mockResolvedValue(gapsResponse)
    const cap = captureStdout(() => listContentGaps('demo', { format: 'jsonl' }))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    const records = lines.map(l => JSON.parse(l))
    expect(records.every(r => r.project === 'demo')).toBe(true)
    expect(records[0]).toMatchObject({
      project: 'demo',
      query: 'crm for nonprofits',
      missRate: 0.75,
      competitorCount: 2,
      competitorDomains: ['rival.com', 'other.com'],
    })
  })

  it('empty collection writes nothing', async () => {
    mockGetContentGaps.mockResolvedValue(emptyGapsResponse)
    const cap = captureStdout(() => listContentGaps('demo', { format: 'jsonl' }))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('--format json is unchanged: prints the full envelope verbatim', async () => {
    mockGetContentGaps.mockResolvedValue(gapsResponse)
    const logs = await captureLog(() => listContentGaps('demo', { format: 'json' }))
    expect(JSON.parse(logs.join('\n'))).toEqual(gapsResponse)
  })
})
