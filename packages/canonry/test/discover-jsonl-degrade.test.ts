import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { DiscoveryRunStartResponse } from '../src/client.js'
import type { DiscoveryPromotePreview, DiscoveryPromoteResult } from '@ainyc/canonry-contracts'

// discover run / promote / promote-preview are object-document commands (NOT
// jsonl-streaming collections). Their machine-output gate must DEGRADE
// `--format jsonl` to the same JSON document `--format json` emits — an agent
// asking for jsonl must never fall through to the decorated human text.
//
// (discover list / show / probe ARE jsonl-streaming collection commands and
// are covered by discover-jsonl.test.ts — left untouched here.)

const mockTriggerDiscoveryRun = vi.fn()
const mockPreviewDiscoveryPromote = vi.fn()
const mockPromoteDiscovery = vi.fn()
const mockGetDiscoverySession = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    triggerDiscoveryRun: mockTriggerDiscoveryRun,
    previewDiscoveryPromote: mockPreviewDiscoveryPromote,
    promoteDiscovery: mockPromoteDiscovery,
    getDiscoverySession: mockGetDiscoverySession,
  }),
}))

/** Capture console.log lines (the json / jsonl degrade path uses console.log). */
function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  return fn()
    .finally(() => {
      console.log = origLog
    })
    .then(() => logs.join('\n'))
}

const { discoverRun, discoverPromotePreview, discoverPromote } = await import('../src/commands/discover.js')

const start: DiscoveryRunStartResponse = {
  runId: 'run-1',
  sessionId: 'sess-1',
  status: 'running',
  consolidated: false,
}

const preview: DiscoveryPromotePreview = {
  sessionId: 'sess-1',
  projectId: 'proj-1',
  status: 'completed',
  queriesByBucket: {
    cited: ['best crm', 'crm for startups'],
    aspirational: ['enterprise crm'],
    'wasted-surface': ['cheap crm'],
  },
  suggestedCompetitors: [
    { domain: 'rival.com', hits: 4, competitorType: 'direct-competitor', sources: [{ domain: 'offers.rival.com', hits: 4, competitorType: 'direct-competitor' }] },
  ],
  skippedCompetitors: [
    {
      domain: 'pagehost.com',
      hits: 3,
      competitorType: 'direct-competitor',
      sources: [
        { domain: 'a.pagehost.com', hits: 2, competitorType: 'direct-competitor' },
        { domain: 'b.pagehost.com', hits: 1, competitorType: 'direct-competitor' },
      ],
      reason: 'shared-host',
      message: 'pagehost.com was cited as 2 different subdomains (a.pagehost.com, b.pagehost.com), which may be different sites on one shared host',
    },
  ],
}

const promoteResult: DiscoveryPromoteResult = {
  sessionId: 'sess-1',
  projectId: 'proj-1',
  promoted: { queries: ['best crm'], competitors: ['rival.com'] },
  skipped: { queries: ['crm for startups'], competitors: ['pagehost.com', 'tracked.com'] },
  competitorDetails: {
    promoted: preview.suggestedCompetitors,
    skipped: [
      ...preview.skippedCompetitors,
      { domain: 'tracked.com', hits: 2, competitorType: 'direct-competitor', sources: [{ domain: 'tracked.com', hits: 2, competitorType: 'direct-competitor' }], reason: 'already-tracked', message: 'tracked.com is already tracked' },
    ],
  },
}

describe('discoverRun (no-wait) — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTriggerDiscoveryRun.mockResolvedValue(start)
  })

  it('format=jsonl emits parseable JSON equal to format=json (the degrade)', async () => {
    const jsonOut = await captureLog(() => discoverRun('demo', { icp: 'crm buyers', format: 'json' }))
    const jsonlOut = await captureLog(() => discoverRun('demo', { icp: 'crm buyers', format: 'jsonl' }))

    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
    expect(JSON.parse(jsonlOut)).toEqual(start)
  })

  it('format=jsonl does NOT print the human "Discovery run started" text', async () => {
    const out = await captureLog(() => discoverRun('demo', { icp: 'crm buyers', format: 'jsonl' }))
    expect(out).not.toMatch(/Discovery run started/)
    expect(out).not.toMatch(/Tail:/)
  })

  it('no format → human text output is unchanged (prints the started headline)', async () => {
    const out = await captureLog(() => discoverRun('demo', { icp: 'crm buyers' }))
    expect(out).toMatch(/Discovery run started: run-1/)
    expect(out).toMatch(/Session: sess-1/)
    // Human path must not emit the JSON envelope.
    expect(() => JSON.parse(out)).toThrow()
  })
})

describe('discoverPromotePreview — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPreviewDiscoveryPromote.mockResolvedValue(preview)
  })

  it('format=jsonl emits parseable JSON equal to format=json (the degrade)', async () => {
    const jsonOut = await captureLog(() => discoverPromotePreview('demo', 'sess-1', { format: 'json' }))
    const jsonlOut = await captureLog(() => discoverPromotePreview('demo', 'sess-1', { format: 'jsonl' }))

    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
    expect(JSON.parse(jsonlOut)).toEqual(preview)
  })

  it('format=jsonl does NOT print the human preview text', async () => {
    const out = await captureLog(() => discoverPromotePreview('demo', 'sess-1', { format: 'jsonl' }))
    expect(out).not.toMatch(/Promote preview for session/)
    expect(out).not.toMatch(/Suggested new competitors/)
  })

  it('no format → human text output is unchanged (prints the decorated preview)', async () => {
    const out = await captureLog(() => discoverPromotePreview('demo', 'sess-1', {}))
    expect(out).toMatch(/Promote preview for session sess-1/)
    // The cited host a stored domain comes from, and why an eligible one is left out.
    expect(out).toContain('    - rival.com (4 hits, direct-competitor) (from offers.rival.com)')
    expect(out).toContain('    ! pagehost.com (shared-host): pagehost.com was cited as 2 different subdomains')
    expect(() => JSON.parse(out)).toThrow()
  })
})

describe('discoverPromote — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPromoteDiscovery.mockResolvedValue(promoteResult)
  })

  it('format=jsonl emits parseable JSON equal to format=json (the degrade)', async () => {
    const jsonOut = await captureLog(() => discoverPromote('demo', 'sess-1', { format: 'json' }))
    const jsonlOut = await captureLog(() => discoverPromote('demo', 'sess-1', { format: 'jsonl' }))

    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
    expect(JSON.parse(jsonlOut)).toEqual(promoteResult)
  })

  it('format=jsonl does NOT print the human "Promoted discovery session" text', async () => {
    const out = await captureLog(() => discoverPromote('demo', 'sess-1', { format: 'jsonl' }))
    expect(out).not.toMatch(/Promoted discovery session/)
    expect(out).not.toMatch(/Queries:/)
  })

  it('no format → human text output is unchanged (prints the decorated result)', async () => {
    const out = await captureLog(() => discoverPromote('demo', 'sess-1', {}))
    expect(out).toMatch(/Promoted discovery session sess-1/)
    expect(out).toContain('  Competitors: 1 added, 1 already tracked, 1 left out')
    expect(out).toContain('    + rival.com (from offers.rival.com)')
    expect(out).toContain('    ! pagehost.com (shared-host): ')
    expect(out).not.toContain('tracked.com (already-tracked)')
    expect(() => JSON.parse(out)).toThrow()
  })
})
