import { describe, expect, it, beforeEach, vi } from 'vitest'

/**
 * These commands read a single composite/object payload — they never stream a
 * jsonl collection. Before this fix, `--format jsonl` fell through their
 * `format === 'json'` gate into the human-text branch, so an agent asking for
 * machine output silently got a decorated table. The fix degrades `jsonl` to
 * the same JSON document `--format json` emits (via `isMachineFormat`).
 *
 * Each block asserts the degrade is byte-identical to the json output, and
 * that the no-format (human/text) path is unchanged.
 */

const mockGetProject = vi.fn()
const mockListRuns = vi.fn()
const mockGetLatestRun = vi.fn()
const mockSearchProject = vi.fn()
const mockGetProjectOverview = vi.fn()
const mockListProjects = vi.fn()
const mockCreateSnapshot = vi.fn()
const mockGetExport = vi.fn()
const mockGetRun = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getProject: mockGetProject,
    listRuns: mockListRuns,
    getLatestRun: mockGetLatestRun,
    searchProject: mockSearchProject,
    getProjectOverview: mockGetProjectOverview,
    listProjects: mockListProjects,
    createSnapshot: mockCreateSnapshot,
    getExport: mockGetExport,
    getRun: mockGetRun,
  }),
}))

// PDF writer is a heavy dependency the snapshot command imports — stub it so
// the test never touches the filesystem / a headless browser.
vi.mock('../src/snapshot-pdf.js', () => ({
  writeSnapshotPdf: vi.fn(),
}))

const { showStatus } = await import('../src/commands/status.js')
const { searchProject } = await import('../src/commands/search.js')
const { showOverview, showAllOverviews } = await import('../src/commands/overview.js')
const { createSnapshotReport } = await import('../src/commands/snapshot.js')
const { getCommand } = await import('../src/commands/get.js')
const { exportProject } = await import('../src/commands/export-cmd.js')

/** Capture every `console.log` line (the json/human path uses console.log). */
function captureLog(fn: () => Promise<void>): { run: Promise<void>; text: () => string } {
  const logs: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  })
  const run = fn().finally(() => spy.mockRestore())
  return { run, text: () => logs.join('\n') }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('canonry status — jsonl degrades to the json document', () => {
  const project = {
    id: 'p-1',
    name: 'demo',
    displayName: 'Demo',
    canonicalDomain: 'demo.example.com',
    country: 'US',
    language: 'en',
  }
  const runs = [
    { id: 'run-1', status: 'completed', createdAt: '2026-04-28T00:00:00.000Z', finishedAt: '2026-04-28T00:00:05.000Z' },
  ]
  const latest = { totalRuns: 1, run: runs[0] }

  function seed(): void {
    mockGetProject.mockResolvedValue(project)
    mockListRuns.mockResolvedValue(runs)
    mockGetLatestRun.mockResolvedValue(latest)
  }

  it('json and jsonl emit the same parseable document', async () => {
    seed()
    const jsonCap = captureLog(() => showStatus('demo', 'json'))
    await jsonCap.run
    const jsonText = jsonCap.text()

    seed()
    const jsonlCap = captureLog(() => showStatus('demo', 'jsonl'))
    await jsonlCap.run
    const jsonlText = jsonlCap.text()

    expect(jsonlText).toBe(jsonText)
    const parsed = JSON.parse(jsonlText)
    expect(parsed).toEqual({ project, runs, latestRun: latest.run, totalRuns: latest.totalRuns })
  })

  it('no-format output is the human "Status:" block (unchanged)', async () => {
    seed()
    const cap = captureLog(() => showStatus('demo', undefined))
    await cap.run
    const text = cap.text()
    expect(text).toContain('Status: Demo (demo)')
    expect(() => JSON.parse(text)).toThrow()
  })
})

describe('canonry search — jsonl degrades to the json document', () => {
  const result = {
    query: 'pricing',
    totalHits: 1,
    truncated: false,
    hits: [
      {
        kind: 'snapshot',
        query: 'best pricing tool',
        provider: 'openai',
        citationState: 'cited',
        matchedField: 'answer',
        snippet: 'matched text',
        runId: 'run-1',
        createdAt: '2026-04-28T00:00:00.000Z',
      },
    ],
  }

  it('json and jsonl emit the same parseable document', async () => {
    mockSearchProject.mockResolvedValue(result)
    const jsonCap = captureLog(() => searchProject('demo', { query: 'pricing', format: 'json' }))
    await jsonCap.run

    mockSearchProject.mockResolvedValue(result)
    const jsonlCap = captureLog(() => searchProject('demo', { query: 'pricing', format: 'jsonl' }))
    await jsonlCap.run

    expect(jsonlCap.text()).toBe(jsonCap.text())
    expect(JSON.parse(jsonlCap.text())).toEqual(result)
  })

  it('no-format output is the human "Search:" block (unchanged)', async () => {
    mockSearchProject.mockResolvedValue(result)
    const cap = captureLog(() => searchProject('demo', { query: 'pricing' }))
    await cap.run
    const text = cap.text()
    expect(text).toContain('Search: "pricing"')
    expect(() => JSON.parse(text)).toThrow()
  })
})

function makeOverview(name: string) {
  return {
    project: {
      id: `p-${name}`,
      name,
      displayName: name,
      canonicalDomain: `${name}.example.com`,
      ownedDomains: [],
      aliases: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      locations: [],
      defaultLocation: null,
      autoExtractBacklinks: false,
      configSource: 'manual',
      configRevision: null,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    },
    latestRun: { run: null, totalRuns: 0 },
    health: null,
    topInsights: [],
    queryCounts: { totalQueries: 0, citedQueries: 0, notCitedQueries: 0, citedRate: 0 },
    providers: [],
    transitions: { since: null, gained: 0, lost: 0, emerging: 0 },
    scores: {
      mention: { label: 'Mention', value: '0', delta: '', tone: 'neutral', description: '', trend: [], progress: 0 },
      visibility: { label: 'Citation', value: '0', delta: '', tone: 'neutral', description: '', trend: [], progress: 0 },
      mentionShare: {
        label: 'Mention Share', value: 'Add competitors', delta: '', tone: 'neutral', description: '', trend: [], progress: 0,
        breakdown: { projectMentionSnapshots: 0, competitorMentionSnapshots: 0, perCompetitor: [], snapshotsWithAnswerText: 0, snapshotsTotal: 0 },
      },
      gapQueries: { label: 'Gap queries', value: '0', delta: '', tone: 'neutral', description: '', trend: [] },
      mentionGaps: { label: 'Mention gaps', value: '0', delta: '', tone: 'neutral', description: '', trend: [] },
      indexCoverage: { label: 'Index coverage', value: 'No data', delta: '', tone: 'neutral', description: '', trend: [] },
      competitorPressure: { label: 'Competitor pressure', value: 'None', delta: '', tone: 'neutral', description: '', trend: [] },
      runStatus: { label: 'Run status', value: 'Healthy', delta: '', tone: 'positive', description: '', trend: [] },
    },
    movementSummary: { gained: 0, lost: 0, tone: 'neutral', hasPreviousRun: false },
    competitors: [],
    providerScores: [],
    attentionItems: [],
    runHistory: [],
    suggestedQueries: { rows: [], totalCandidates: 0, skippedAlreadyTracked: 0 },
    dateRangeLabel: 'All time',
    contextLabel: 'US / EN',
  }
}

describe('canonry overview — jsonl degrades to the json document', () => {
  it('single project: json and jsonl emit the same parseable document', async () => {
    const overview = makeOverview('demo')
    mockGetProjectOverview.mockResolvedValue(overview)
    const jsonCap = captureLog(() => showOverview('demo', { format: 'json' }))
    await jsonCap.run

    mockGetProjectOverview.mockResolvedValue(overview)
    const jsonlCap = captureLog(() => showOverview('demo', { format: 'jsonl' }))
    await jsonlCap.run

    expect(jsonlCap.text()).toBe(jsonCap.text())
    expect(JSON.parse(jsonlCap.text())).toEqual(overview)
  })

  it('single project: no-format output is the human "Overview:" block (unchanged)', async () => {
    mockGetProjectOverview.mockResolvedValue(makeOverview('demo'))
    const cap = captureLog(() => showOverview('demo', {}))
    await cap.run
    const text = cap.text()
    expect(text).toContain('Overview: demo (demo)')
    expect(() => JSON.parse(text)).toThrow()
  })

  it('--all: json and jsonl emit the same parseable array', async () => {
    const projects = [{ name: 'a' }, { name: 'b' }]
    const overviews = [makeOverview('a'), makeOverview('b')]
    mockListProjects.mockResolvedValue(projects)
    mockGetProjectOverview.mockImplementation((name: string) =>
      Promise.resolve(overviews.find(o => o.project.name === name)),
    )
    const jsonCap = captureLog(() => showAllOverviews({ format: 'json' }))
    await jsonCap.run

    mockListProjects.mockResolvedValue(projects)
    const jsonlCap = captureLog(() => showAllOverviews({ format: 'jsonl' }))
    await jsonlCap.run

    expect(jsonlCap.text()).toBe(jsonCap.text())
    expect(JSON.parse(jsonlCap.text())).toEqual(overviews)
  })

  it('--all: empty project list emits "[]" for both json and jsonl', async () => {
    mockListProjects.mockResolvedValue([])
    const jsonCap = captureLog(() => showAllOverviews({ format: 'json' }))
    await jsonCap.run
    expect(jsonCap.text()).toBe('[]')

    mockListProjects.mockResolvedValue([])
    const jsonlCap = captureLog(() => showAllOverviews({ format: 'jsonl' }))
    await jsonlCap.run
    expect(jsonlCap.text()).toBe('[]')
  })
})

describe('canonry snapshot — jsonl degrades to the json document', () => {
  const report = {
    companyName: 'Acme',
    domain: 'acme.com',
    generatedAt: '2026-04-28T00:00:00.000Z',
    audit: { overallScore: 80, overallGrade: 'B', summary: 'ok', factors: [] },
    summary: { visibilityGap: 'gap', whatThisMeans: [], recommendedActions: [], topCompetitors: [] },
    queryResults: [],
  }

  it('json and jsonl emit the same parseable document', async () => {
    mockCreateSnapshot.mockResolvedValue(report)
    const jsonCap = captureLog(() => createSnapshotReport('Acme', { domain: 'acme.com', format: 'json' }))
    await jsonCap.run

    mockCreateSnapshot.mockResolvedValue(report)
    const jsonlCap = captureLog(() => createSnapshotReport('Acme', { domain: 'acme.com', format: 'jsonl' }))
    await jsonlCap.run

    expect(jsonlCap.text()).toBe(jsonCap.text())
    expect(JSON.parse(jsonlCap.text())).toEqual(report)
  })

  it('no-format output is the human "Snapshot:" block (unchanged)', async () => {
    mockCreateSnapshot.mockResolvedValue(report)
    const cap = captureLog(() => createSnapshotReport('Acme', { domain: 'acme.com' }))
    await cap.run
    const text = cap.text()
    expect(text).toContain('Snapshot: Acme (acme.com)')
    expect(() => JSON.parse(text)).toThrow()
  })
})

describe('canonry get — jsonl degrades to the json document', () => {
  // `get` extracts a leaf from the overview payload by default; an object leaf
  // is emitted as JSON. jsonl must hit the same machine branch.
  const overview = makeOverview('demo')

  it('object leaf: json and jsonl emit the same parseable document', async () => {
    mockGetProjectOverview.mockResolvedValue(overview)
    const jsonCap = captureLog(() => getCommand({ project: 'demo', path: 'scores.mention', format: 'json' }))
    await jsonCap.run

    mockGetProjectOverview.mockResolvedValue(overview)
    const jsonlCap = captureLog(() => getCommand({ project: 'demo', path: 'scores.mention', format: 'jsonl' }))
    await jsonlCap.run

    expect(jsonlCap.text()).toBe(jsonCap.text())
    expect(JSON.parse(jsonlCap.text())).toEqual(overview.scores.mention)
  })

  it('scalar leaf: no-format prints bare (unchanged), jsonl emits JSON', async () => {
    mockGetProjectOverview.mockResolvedValue(overview)
    const bareCap = captureLog(() => getCommand({ project: 'demo', path: 'scores.mention.value' }))
    await bareCap.run
    expect(bareCap.text()).toBe('0') // bare scalar, no quotes

    mockGetProjectOverview.mockResolvedValue(overview)
    const jsonlCap = captureLog(() => getCommand({ project: 'demo', path: 'scores.mention.value', format: 'jsonl' }))
    await jsonlCap.run
    expect(JSON.parse(jsonlCap.text())).toBe('0') // JSON-quoted string
    expect(jsonlCap.text()).toBe('"0"')
  })
})

describe('canonry export — jsonl degrades to the json document', () => {
  const data = {
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name: 'demo' },
    spec: { canonicalDomain: 'demo.example.com', queries: ['q1'], competitors: [] },
  }

  it('json and jsonl emit the same parseable document', async () => {
    mockGetExport.mockResolvedValue({ ...data })
    const jsonCap = captureLog(() => exportProject('demo', { format: 'json' }))
    await jsonCap.run

    mockGetExport.mockResolvedValue({ ...data })
    const jsonlCap = captureLog(() => exportProject('demo', { format: 'jsonl' }))
    await jsonlCap.run

    expect(jsonlCap.text()).toBe(jsonCap.text())
    expect(JSON.parse(jsonlCap.text())).toEqual(data)
  })

  it('no-format output is YAML (unchanged, not JSON)', async () => {
    mockGetExport.mockResolvedValue({ ...data })
    const cap = captureLog(() => exportProject('demo', {}))
    await cap.run
    const text = cap.text()
    expect(text).toContain('apiVersion: canonry/v1')
    expect(() => JSON.parse(text)).toThrow()
  })
})
