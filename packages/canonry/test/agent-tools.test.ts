import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type {
  HealthSnapshotDto,
  InsightDto,
  NotificationDto,
  ProjectDto,
  RunDto,
  ScheduleDto,
} from '@ainyc/canonry-contracts'
import { createClient, migrate, type DatabaseClient } from '@ainyc/canonry-db'
import {
  buildAllTools,
  buildReadTools,
  buildWriteTools,
  type ToolContext,
} from '../src/agent/tools.js'
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
  notifications: NotificationDto[]
  schedule: ScheduleDto
  triggerRunResult: RunDto
  lastListRunsLimit?: number
  lastInsightsOpts?: { dismissed?: boolean; runId?: string }
  lastGetRunId?: string
  lastTriggerBody?: Record<string, unknown>
  lastDismissId?: string
  lastAppendedKeywords?: string[]
  lastPutCompetitors?: string[]
  lastPutSchedule?: Record<string, unknown>
  lastCreatedNotification?: Record<string, unknown>
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
    triggerRun: async (_project: string, body?: Record<string, unknown>) => {
      state.lastTriggerBody = body
      return state.triggerRunResult
    },
    dismissInsight: async (_project: string, id: string) => {
      state.lastDismissId = id
      return { ok: true }
    },
    appendKeywords: async (_project: string, keywords: string[]) => {
      state.lastAppendedKeywords = keywords
    },
    putCompetitors: async (_project: string, competitors: string[]) => {
      state.lastPutCompetitors = competitors
    },
    putSchedule: async (_project: string, body: Record<string, unknown>) => {
      state.lastPutSchedule = body
      return state.schedule
    },
    listNotifications: async () => state.notifications,
    createNotification: async (_project: string, body: Record<string, unknown>) => {
      state.lastCreatedNotification = body
      return { id: 'notif-new', ...body } as unknown as NotificationDto
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
    notifications: [],
    schedule: {
      id: 's1',
      projectId: 'p1',
      cronExpr: '0 */6 * * *',
      preset: null,
      timezone: 'UTC',
      enabled: true,
      providers: [],
      lastRunAt: null,
      nextRunAt: null,
      createdAt: '2026-04-17T00:00:00Z',
      updatedAt: '2026-04-17T00:00:00Z',
    },
    triggerRunResult: {
      id: 'new-run',
      projectId: 'p1',
      kind: 'answer-visibility',
      status: 'queued',
      trigger: 'agent',
      createdAt: '2026-04-17T00:00:00Z',
    } as RunDto,
  }
}

let sharedTmpDir: string
let sharedDb: DatabaseClient

beforeEach(() => {
  sharedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-tools-'))
  sharedDb = createClient(path.join(sharedTmpDir, 'test.db'))
  migrate(sharedDb)
})

afterEach(() => {
  fs.rmSync(sharedTmpDir, { recursive: true, force: true })
})

function contextFor(state: StubState): ToolContext {
  return {
    client: stubClient(state),
    projectName: 'demo',
    db: sharedDb,
    projectId: 'proj_demo',
  }
}

describe('buildReadTools', () => {
  it('returns 8 tools with the expected names and metadata', () => {
    const tools = buildReadTools(contextFor(defaultState()))
    expect(tools.map((t) => t.name)).toEqual([
      'get_status',
      'get_health',
      'get_timeline',
      'get_insights',
      'list_keywords',
      'list_competitors',
      'get_run',
      'recall',
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

describe('buildWriteTools', () => {
  it('returns 8 tools with the expected names', () => {
    const tools = buildWriteTools(contextFor(defaultState()))
    expect(tools.map((t) => t.name)).toEqual([
      'run_sweep',
      'dismiss_insight',
      'add_keywords',
      'add_competitors',
      'update_schedule',
      'attach_agent_webhook',
      'remember',
      'forget',
    ])
  })
})

describe('buildAllTools', () => {
  it('returns 16 tools combining reads + writes', () => {
    expect(buildAllTools(contextFor(defaultState()))).toHaveLength(16)
  })
})

describe('run_sweep', () => {
  it('passes provider filter + noLocation through to triggerRun', async () => {
    const state = defaultState()
    const tool = buildWriteTools(contextFor(state)).find((t) => t.name === 'run_sweep')!
    await tool.execute('call-1', { providers: ['claude', 'openai'], noLocation: true })
    expect(state.lastTriggerBody).toEqual({ providers: ['claude', 'openai'], noLocation: true })
  })

  it('omits optional fields when not provided', async () => {
    const state = defaultState()
    const tool = buildWriteTools(contextFor(state)).find((t) => t.name === 'run_sweep')!
    await tool.execute('call-1', {})
    expect(state.lastTriggerBody).toEqual({})
  })
})

describe('dismiss_insight', () => {
  it('dismisses the given insight id', async () => {
    const state = defaultState()
    const tool = buildWriteTools(contextFor(state)).find((t) => t.name === 'dismiss_insight')!
    const result = await tool.execute('call-1', { insightId: 'i1' })
    expect(state.lastDismissId).toBe('i1')
    expect(result.details).toEqual({ ok: true })
  })
})

describe('add_keywords', () => {
  it('appends keywords and echoes what was added', async () => {
    const state = defaultState()
    const tool = buildWriteTools(contextFor(state)).find((t) => t.name === 'add_keywords')!
    const result = await tool.execute('call-1', { keywords: ['gamma', 'delta'] })
    expect(state.lastAppendedKeywords).toEqual(['gamma', 'delta'])
    expect(result.details).toEqual({ added: ['gamma', 'delta'] })
  })
})

describe('add_competitors', () => {
  it('merges new domains onto the existing list', async () => {
    const state = defaultState()
    const tool = buildWriteTools(contextFor(state)).find((t) => t.name === 'add_competitors')!
    const result = await tool.execute('call-1', { domains: ['new.example.com'] })
    expect(state.lastPutCompetitors).toEqual(['rival.example.com', 'new.example.com'])
    expect(result.details).toEqual({ added: ['new.example.com'], alreadyTracked: [] })
  })

  it('no-ops when every domain is already tracked', async () => {
    const state = defaultState()
    const tool = buildWriteTools(contextFor(state)).find((t) => t.name === 'add_competitors')!
    const result = await tool.execute('call-1', { domains: ['rival.example.com'] })
    expect(state.lastPutCompetitors).toBeUndefined()
    expect(result.details).toEqual({ added: [], alreadyTracked: ['rival.example.com'] })
  })
})

describe('update_schedule', () => {
  it('requires exactly one of cron or preset', async () => {
    const state = defaultState()
    const tool = buildWriteTools(contextFor(state)).find((t) => t.name === 'update_schedule')!

    await expect(tool.execute('call-1', {})).rejects.toThrow(/exactly one/)
    await expect(
      tool.execute('call-2', { cron: '* * * * *', preset: 'daily' }),
    ).rejects.toThrow(/exactly one/)
  })

  it('forwards the cron + options to putSchedule', async () => {
    const state = defaultState()
    const tool = buildWriteTools(contextFor(state)).find((t) => t.name === 'update_schedule')!
    await tool.execute('call-1', {
      cron: '0 */6 * * *',
      timezone: 'America/New_York',
      enabled: true,
      providers: ['claude'],
    })
    expect(state.lastPutSchedule).toEqual({
      cron: '0 */6 * * *',
      timezone: 'America/New_York',
      enabled: true,
      providers: ['claude'],
    })
  })
})

describe('attach_agent_webhook', () => {
  it('creates a webhook when none exists', async () => {
    const state = defaultState()
    const tool = buildWriteTools(contextFor(state)).find((t) => t.name === 'attach_agent_webhook')!
    const result = await tool.execute('call-1', { url: 'https://agent.example.com/hook' })
    expect(state.lastCreatedNotification).toMatchObject({
      channel: 'webhook',
      url: 'https://agent.example.com/hook',
      source: 'agent',
      events: ['run.completed', 'insight.critical', 'insight.high', 'citation.gained'],
    })
    expect(result.details).toMatchObject({ status: 'attached', url: 'https://agent.example.com/hook' })
  })

  it('is idempotent when an agent webhook already exists', async () => {
    const state = defaultState()
    state.notifications = [
      {
        id: 'existing',
        projectId: 'p1',
        channel: 'webhook',
        url: 'https://old',
        urlDisplay: 'old',
        urlHost: 'old',
        events: ['run.completed'],
        enabled: true,
        source: 'agent',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]
    const tool = buildWriteTools(contextFor(state)).find((t) => t.name === 'attach_agent_webhook')!
    const result = await tool.execute('call-1', { url: 'https://agent.example.com/hook' })
    expect(state.lastCreatedNotification).toBeUndefined()
    expect(result.details).toEqual({ status: 'already-attached' })
  })
})
