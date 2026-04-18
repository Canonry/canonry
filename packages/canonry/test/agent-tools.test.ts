import { describe, it, expect } from 'vitest'
import type {
  HealthSnapshotDto,
  InsightDto,
  ProjectDto,
  RunDto,
} from '@ainyc/canonry-contracts'
import { buildReadTools, type ToolContext } from '../src/agent/tools.js'
import type { ApiClient, CompetitorDto, RunDetailDto, TimelineDto } from '../src/client.js'

interface StubState {
  project: ProjectDto
  runs: RunDto[]
  health: HealthSnapshotDto
  timeline: TimelineDto[]
  insights: InsightDto[]
  keywords: { id: string; keyword: string }[]
  competitors: CompetitorDto[]
  runDetail: RunDetailDto
  lastListRunsLimit?: number
  lastInsightsOpts?: { dismissed?: boolean; runId?: string }
  lastGetRunId?: string
}

function stubClient(state: StubState): ApiClient {
  return {
    getProject: async () => state.project,
    listRuns: async (_project: string, limit?: number) => {
      state.lastListRunsLimit = limit
      return state.runs
    },
    getHealth: async () => state.health,
    getTimeline: async () => state.timeline,
    getInsights: async (_project: string, opts?: { dismissed?: boolean; runId?: string }) => {
      state.lastInsightsOpts = opts
      return state.insights
    },
    listKeywords: async () => state.keywords,
    listCompetitors: async () => state.competitors,
    getRun: async (id: string) => {
      state.lastGetRunId = id
      return state.runDetail
    },
  } as unknown as ApiClient
}

function defaultState(): StubState {
  return {
    project: {
      name: 'demo',
      displayName: 'Demo',
      canonicalDomain: 'demo.example.com',
      country: 'US',
      language: 'en',
    } as ProjectDto,
    runs: [],
    health: {
      id: 'health-1',
      projectId: 'proj-1',
      runId: null,
      overallCitedRate: 0.42,
      totalPairs: 10,
      citedPairs: 4,
      providerBreakdown: { gemini: { citedRate: 0.6, cited: 3, total: 5 } },
      createdAt: '2026-04-17T00:00:00.000Z',
    },
    timeline: [
      { keyword: 'alpha', runs: [] },
      { keyword: 'beta', runs: [] },
    ],
    insights: [
      {
        id: 'i1',
        projectId: 'p1',
        runId: 'r1',
        type: 'regression',
        severity: 'high',
        title: 'Lost citation on alpha',
        keyword: 'alpha',
        provider: 'claude',
        dismissed: false,
        createdAt: '2026-04-17T00:00:00Z',
      },
    ],
    keywords: [
      { id: 'k1', keyword: 'alpha' },
      { id: 'k2', keyword: 'beta' },
    ],
    competitors: [{ id: 'c1', domain: 'rival.example.com', createdAt: '2026-01-01T00:00:00Z' }],
    runDetail: {
      id: 'r1',
      projectId: 'p1',
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      createdAt: '2026-04-17T00:00:00Z',
      finishedAt: '2026-04-17T00:01:00Z',
      providers: ['claude'],
    } as RunDetailDto,
  }
}

function contextFor(state: StubState): ToolContext {
  return { client: stubClient(state), projectName: 'demo' }
}

describe('buildReadTools', () => {
  it('returns 7 tools with the expected names and metadata', () => {
    const tools = buildReadTools(contextFor(defaultState()))
    expect(tools.map((t) => t.name)).toEqual([
      'get_status',
      'get_health',
      'get_timeline',
      'get_insights',
      'list_keywords',
      'list_competitors',
      'get_run',
    ])
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.label.length).toBeGreaterThan(0)
      expect(tool.parameters).toBeDefined()
    }
  })
})

describe('get_status', () => {
  it('returns project + runs in details and JSON text content', async () => {
    const state = defaultState()
    const tool = buildReadTools(contextFor(state)).find((t) => t.name === 'get_status')!
    const result = await tool.execute('call-1', {})

    expect(result.details).toMatchObject({ project: { name: 'demo' }, runs: [] })
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('"name": "demo"')
  })

  it('defaults runLimit to 5 and respects an override', async () => {
    const stateA = defaultState()
    await buildReadTools(contextFor(stateA)).find((t) => t.name === 'get_status')!.execute('call-1', {})
    expect(stateA.lastListRunsLimit).toBe(5)

    const stateB = defaultState()
    await buildReadTools(contextFor(stateB))
      .find((t) => t.name === 'get_status')!
      .execute('call-1', { runLimit: 12 })
    expect(stateB.lastListRunsLimit).toBe(12)
  })
})

describe('get_health', () => {
  it('returns the health snapshot', async () => {
    const state = defaultState()
    const tool = buildReadTools(contextFor(state)).find((t) => t.name === 'get_health')!
    const result = await tool.execute('call-1', {})
    expect(result.details).toMatchObject({ overallCitedRate: 0.42, citedPairs: 4 })
  })
})

describe('get_timeline', () => {
  it('returns every keyword when no filter provided', async () => {
    const state = defaultState()
    const tool = buildReadTools(contextFor(state)).find((t) => t.name === 'get_timeline')!
    const result = await tool.execute('call-1', {})
    expect(result.details).toHaveLength(2)
  })

  it('filters to a single keyword when provided', async () => {
    const state = defaultState()
    const tool = buildReadTools(contextFor(state)).find((t) => t.name === 'get_timeline')!
    const result = await tool.execute('call-1', { keyword: 'alpha' })
    const details = result.details as TimelineDto[]
    expect(details).toHaveLength(1)
    expect(details[0].keyword).toBe('alpha')
  })
})

describe('get_insights', () => {
  it('passes opts through to the ApiClient', async () => {
    const state = defaultState()
    const tool = buildReadTools(contextFor(state)).find((t) => t.name === 'get_insights')!

    await tool.execute('call-1', {})
    expect(state.lastInsightsOpts).toEqual({ dismissed: undefined, runId: undefined })

    await tool.execute('call-2', { includeDismissed: true, runId: 'r1' })
    expect(state.lastInsightsOpts).toEqual({ dismissed: true, runId: 'r1' })
  })

  it('returns the insight list', async () => {
    const state = defaultState()
    const tool = buildReadTools(contextFor(state)).find((t) => t.name === 'get_insights')!
    const result = await tool.execute('call-1', {})
    const details = result.details as InsightDto[]
    expect(details).toHaveLength(1)
    expect(details[0].severity).toBe('high')
  })
})

describe('list_keywords', () => {
  it('returns every tracked keyword', async () => {
    const state = defaultState()
    const tool = buildReadTools(contextFor(state)).find((t) => t.name === 'list_keywords')!
    const result = await tool.execute('call-1', {})
    expect(result.details).toEqual(state.keywords)
  })
})

describe('list_competitors', () => {
  it('returns every tracked competitor', async () => {
    const state = defaultState()
    const tool = buildReadTools(contextFor(state)).find((t) => t.name === 'list_competitors')!
    const result = await tool.execute('call-1', {})
    const details = result.details as CompetitorDto[]
    expect(details).toHaveLength(1)
    expect(details[0].domain).toBe('rival.example.com')
  })
})

describe('get_run', () => {
  it('fetches the requested run by id', async () => {
    const state = defaultState()
    const tool = buildReadTools(contextFor(state)).find((t) => t.name === 'get_run')!
    const result = await tool.execute('call-1', { runId: 'r1' })
    const details = result.details as RunDetailDto
    expect(state.lastGetRunId).toBe('r1')
    expect(details.id).toBe('r1')
  })
})
