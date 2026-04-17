import { describe, it, expect } from 'vitest'
import type { HealthSnapshotDto, ProjectDto, RunDto } from '@ainyc/canonry-contracts'
import { buildReadTools, type ToolContext } from '../src/agent/tools.js'
import type { ApiClient, TimelineDto } from '../src/client.js'

interface StubState {
  project: ProjectDto
  runs: RunDto[]
  health: HealthSnapshotDto
  timeline: TimelineDto[]
  lastListRunsLimit?: number
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
  }
}

function contextFor(state: StubState): ToolContext {
  return { client: stubClient(state), projectName: 'demo' }
}

describe('buildReadTools', () => {
  it('returns 3 tools with the expected names and metadata', () => {
    const tools = buildReadTools(contextFor(defaultState()))
    expect(tools.map((t) => t.name)).toEqual(['get_status', 'get_health', 'get_timeline'])
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
