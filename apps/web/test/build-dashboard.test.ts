import { test, expect } from 'vitest'

import { buildDashboard, buildProjectCommandCenter, type ProjectData } from '../src/build-dashboard.js'
import type { ApiSettings } from '../src/api.js'

test('buildDashboard maps Google settings into the dashboard view model', () => {
  const apiSettings: ApiSettings = {
    providers: [{
      name: 'gemini',
      configured: true,
      model: 'gemini-3-flash',
    }],
    google: {
      configured: true,
    },
  }

  const dashboard = buildDashboard([], apiSettings)

  expect(dashboard.settings.google.state).toBe('ready')
  expect(dashboard.settings.google.detail).toMatch(/configured/i)
  expect(
    dashboard.settings.selfHostNotes.some((note) => note.includes('source of truth for authentication credentials')),
  ).toBeTruthy()
  expect(dashboard.settings.bootstrapNote).toMatch(/Authentication credentials persist to local config/)
})

test('buildDashboard marks Google settings as needing config when OAuth is not configured', () => {
  const apiSettings: ApiSettings = {
    providers: [],
    google: {
      configured: false,
    },
  }

  const dashboard = buildDashboard([], apiSettings)

  expect(dashboard.settings.google.state).toBe('needs-config')
  expect(dashboard.settings.google.detail).toMatch(/not configured yet/i)
})

test('buildProjectCommandCenter preserves provider continuity while marking mixed-model history', () => {
  const data: ProjectData = {
    project: {
      id: 'proj_1',
      name: 'citypoint',
      displayName: 'Citypoint',
      canonicalDomain: 'citypoint.example',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['openai'],
      configSource: 'api',
      configRevision: 2,
      createdAt: '2026-03-10T00:00:00Z',
      updatedAt: '2026-03-15T00:00:00Z',
    },
    runs: [
      {
        id: 'run_2',
        projectId: 'proj_1',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        startedAt: '2026-03-15T00:00:00Z',
        finishedAt: '2026-03-15T00:00:10Z',
        error: null,
        createdAt: '2026-03-15T00:00:00Z',
      },
      {
        id: 'run_1',
        projectId: 'proj_1',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        startedAt: '2026-03-14T00:00:00Z',
        finishedAt: '2026-03-14T00:00:10Z',
        error: null,
        createdAt: '2026-03-14T00:00:00Z',
      },
    ],
    queries: [{ id: 'kw_1', query: 'best ai seo agency', createdAt: '2026-03-10T00:00:00Z' }],
    competitors: [],
    timeline: [{
      query: 'best ai seo agency',
      runs: [
        { runId: 'run_1', createdAt: '2026-03-14T00:00:00Z', citationState: 'cited', transition: 'new' },
        { runId: 'run_2', createdAt: '2026-03-15T00:00:00Z', citationState: 'cited', transition: 'cited' },
      ],
      providerRuns: {
        openai: [
          { runId: 'run_1', createdAt: '2026-03-14T00:00:00Z', citationState: 'cited', transition: 'new' },
          { runId: 'run_2', createdAt: '2026-03-15T00:00:00Z', citationState: 'cited', transition: 'cited' },
        ],
      },
      modelRuns: {
        'openai:gpt-4o': [
          { runId: 'run_1', createdAt: '2026-03-14T00:00:00Z', citationState: 'cited', transition: 'new' },
        ],
        'openai:gpt-4.1': [
          { runId: 'run_2', createdAt: '2026-03-15T00:00:00Z', citationState: 'cited', transition: 'new' },
        ],
      },
    }],
    latestRunDetail: {
      id: 'run_2',
      projectId: 'proj_1',
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      startedAt: '2026-03-15T00:00:00Z',
      finishedAt: '2026-03-15T00:00:10Z',
      error: null,
      createdAt: '2026-03-15T00:00:00Z',
      snapshots: [{
        id: 'snap_2',
        runId: 'run_2',
        queryId: 'kw_1',
        query: 'best ai seo agency',
        provider: 'openai',
        model: 'gpt-4.1',
        citationState: 'cited',
        answerText: 'Citypoint is cited here.',
        citedDomains: ['citypoint.example'],
        competitorOverlap: [],
        groundingSources: [],
        searchQueries: [],
        createdAt: '2026-03-15T00:00:00Z',
      }],
    },
    previousRunDetail: {
      id: 'run_1',
      projectId: 'proj_1',
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      startedAt: '2026-03-14T00:00:00Z',
      finishedAt: '2026-03-14T00:00:10Z',
      error: null,
      createdAt: '2026-03-14T00:00:00Z',
      snapshots: [{
        id: 'snap_1',
        runId: 'run_1',
        queryId: 'kw_1',
        query: 'best ai seo agency',
        provider: 'openai',
        model: 'gpt-4o',
        citationState: 'cited',
        answerText: 'Citypoint is cited here.',
        citedDomains: ['citypoint.example'],
        competitorOverlap: [],
        groundingSources: [],
        searchQueries: [],
        createdAt: '2026-03-14T00:00:00Z',
      }],
    },
  }

  const evidence = buildProjectCommandCenter(data).visibilityEvidence[0]!

  expect(evidence.changeLabel).toBe('Cited for 2 runs')
  expect(evidence.historyScope).toBe('provider')
  expect(evidence.modelsSeen).toEqual(['gpt-4o', 'gpt-4.1'])
  expect(
    evidence.runHistory.map(point => point.model),
  ).toEqual(['gpt-4o', 'gpt-4.1'])
  expect(evidence.modelTransitions).toEqual([{
    runId: 'run_2',
    createdAt: '2026-03-15T00:00:00Z',
    fromModel: 'gpt-4o',
    toModel: 'gpt-4.1',
  }])
})

test('buildProjectCommandCenter keeps historical-only provider badges on their own last known state', () => {
  const data: ProjectData = {
    project: {
      id: 'proj_history',
      name: 'history-demo',
      displayName: 'History Demo',
      canonicalDomain: 'history.example',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['gemini', 'openai'],
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-03-20T00:00:00Z',
      updatedAt: '2026-03-22T00:00:00Z',
    },
    runs: [
      {
        id: 'run_1',
        projectId: 'proj_history',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        startedAt: '2026-03-21T00:00:00Z',
        finishedAt: '2026-03-21T00:00:10Z',
        error: null,
        createdAt: '2026-03-21T00:00:00Z',
      },
      {
        id: 'run_2',
        projectId: 'proj_history',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        startedAt: '2026-03-22T00:00:00Z',
        finishedAt: '2026-03-22T00:00:10Z',
        error: null,
        createdAt: '2026-03-22T00:00:00Z',
      },
    ],
    queries: [{ id: 'kw_1', query: 'best ai seo agency', createdAt: '2026-03-20T00:00:00Z' }],
    competitors: [],
    timeline: [{
      query: 'best ai seo agency',
      runs: [
        { runId: 'run_1', createdAt: '2026-03-21T00:00:00Z', citationState: 'cited', transition: 'new' },
        { runId: 'run_2', createdAt: '2026-03-22T00:00:00Z', citationState: 'not-cited', transition: 'lost' },
      ],
      providerRuns: {
        gemini: [
          { runId: 'run_1', createdAt: '2026-03-21T00:00:00Z', citationState: 'cited', transition: 'new' },
        ],
        openai: [
          { runId: 'run_1', createdAt: '2026-03-21T00:00:00Z', citationState: 'not-cited', transition: 'new' },
          { runId: 'run_2', createdAt: '2026-03-22T00:00:00Z', citationState: 'not-cited', transition: 'not-cited' },
        ],
      },
      modelRuns: {},
    }],
    latestRunDetail: {
      id: 'run_2',
      projectId: 'proj_history',
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      startedAt: '2026-03-22T00:00:00Z',
      finishedAt: '2026-03-22T00:00:10Z',
      error: null,
      createdAt: '2026-03-22T00:00:00Z',
      snapshots: [{
        id: 'snap_2',
        runId: 'run_2',
        queryId: 'kw_1',
        query: 'best ai seo agency',
        provider: 'openai',
        model: 'gpt-5.4',
        citationState: 'not-cited',
        answerText: null,
        citedDomains: [],
        competitorOverlap: [],
        groundingSources: [],
        searchQueries: [],
        location: null,
        createdAt: '2026-03-22T00:00:00Z',
      }],
    },
    previousRunDetail: null,
  }

  const evidence = buildProjectCommandCenter(data).visibilityEvidence
  const geminiEvidence = evidence.find(item => item.provider === 'gemini')
  const openaiEvidence = evidence.find(item => item.provider === 'openai')

  expect(geminiEvidence?.citationState).toBe('cited')
  expect(geminiEvidence?.changeLabel).toBe('First observation')
  expect(geminiEvidence?.runHistory).toHaveLength(1)
  expect(openaiEvidence?.citationState).toBe('not-cited')
})

test('buildProjectCommandCenter populates score gauges from the overview DTO when provided', () => {
  const data: ProjectData = {
    project: {
      id: 'proj_overview',
      name: 'overview-demo',
      displayName: 'Overview Demo',
      canonicalDomain: 'overview.example',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['gemini'],
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T00:00:00Z',
    },
    runs: [],
    queries: [],
    competitors: [],
    timeline: [],
    latestRunDetail: null,
    previousRunDetail: null,
    overview: {
      project: {
        id: 'proj_overview',
        name: 'overview-demo',
        displayName: 'Overview Demo',
        canonicalDomain: 'overview.example',
        ownedDomains: [],
        country: 'US',
        language: 'en',
        tags: [],
        labels: {},
        locations: [],
        defaultLocation: null,
        autoExtractBacklinks: false,
        configSource: 'api',
        configRevision: 1,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      },
      latestRun: { totalRuns: 0, run: null },
      health: null,
      topInsights: [],
      queryCounts: { totalQueries: 4, citedQueries: 3, notCitedQueries: 1, citedRate: 0.75 },
      providers: [{ provider: 'gemini', cited: 3, total: 4, citedRate: 0.75 }],
      transitions: { since: null, gained: 0, lost: 0, emerging: 0 },
      scores: {
        visibility: { label: 'Answer Visibility', value: '75', delta: '3 of 4 queries visible', tone: 'positive', description: '', tooltip: '', trend: [], progress: 75 },
        gapQueries: { label: 'Gap Queries', value: '0', delta: '0 of 4 queries at risk', tone: 'positive', description: '', tooltip: '', trend: [] },
        indexCoverage: { label: 'Index Coverage', value: 'No data', delta: '', tone: 'neutral', description: '', tooltip: '', trend: [] },
        competitorPressure: { label: 'Competitor Pressure', value: 'None', delta: '', tone: 'neutral', description: '', tooltip: '', trend: [] },
        runStatus: { label: 'Run Status', value: 'None', delta: '', tone: 'neutral', description: '', tooltip: '', trend: [] },
      },
      movementSummary: { gained: 0, lost: 0, tone: 'neutral', hasPreviousRun: false },
      competitors: [],
      providerScores: [{ provider: 'gemini', model: 'flash', score: 75, cited: 3, total: 4 }],
      attentionItems: [],
      runHistory: [],
      dateRangeLabel: 'All time',
      contextLabel: 'US / EN',
    },
  }

  const vm = buildProjectCommandCenter(data)
  expect(vm.visibilitySummary.value).toBe('75')
  expect(vm.visibilitySummary.tone).toBe('positive')
  expect(vm.queryCounts).toEqual({ cited: 3, total: 4 })
  expect(vm.providerScores).toEqual([{ provider: 'gemini', model: 'flash', score: 75, cited: 3, total: 4 }])
  expect(vm.dateRangeLabel).toBe('All time')
  expect(vm.contextLabel).toBe('US / EN')
})

test('buildProjectCommandCenter surfaces synthesized attention items (e.g. stale_visibility) as project insights', () => {
  const data: ProjectData = {
    project: {
      id: 'proj_attention',
      name: 'attention-demo',
      displayName: 'Attention Demo',
      canonicalDomain: 'attention.example',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['gemini'],
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T00:00:00Z',
    },
    runs: [],
    queries: [],
    competitors: [],
    timeline: [],
    latestRunDetail: null,
    previousRunDetail: null,
    overview: {
      project: {
        id: 'proj_attention',
        name: 'attention-demo',
        displayName: 'Attention Demo',
        canonicalDomain: 'attention.example',
        ownedDomains: [],
        country: 'US',
        language: 'en',
        tags: [],
        labels: {},
        locations: [],
        defaultLocation: null,
        autoExtractBacklinks: false,
        configSource: 'api',
        configRevision: 1,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      },
      latestRun: { totalRuns: 0, run: null },
      health: null,
      topInsights: [],
      queryCounts: { totalQueries: 0, citedQueries: 0, notCitedQueries: 0, citedRate: 0 },
      providers: [],
      transitions: { since: null, gained: 0, lost: 0, emerging: 0 },
      scores: {
        visibility: { label: 'Answer Visibility', value: 'No data', delta: '', tone: 'neutral', description: '', tooltip: '', trend: [] },
        gapQueries: { label: 'Gap Queries', value: 'No data', delta: '', tone: 'neutral', description: '', tooltip: '', trend: [] },
        indexCoverage: { label: 'Index Coverage', value: 'No data', delta: '', tone: 'neutral', description: '', tooltip: '', trend: [] },
        competitorPressure: { label: 'Competitor Pressure', value: 'None', delta: '', tone: 'neutral', description: '', tooltip: '', trend: [] },
        runStatus: { label: 'Run Status', value: 'None', delta: '', tone: 'neutral', description: '', tooltip: '', trend: [] },
      },
      movementSummary: { gained: 0, lost: 0, tone: 'neutral', hasPreviousRun: false },
      competitors: [],
      providerScores: [],
      attentionItems: [
        // DB-echo (id starts with insight_) — already in topInsights, must be deduped
        { id: 'insight_abc', tone: 'negative', title: 'Lost citation', detail: 'on query: foo', actionLabel: 'Critical', href: '#insight-abc' },
        // Synthesized — no insight_ prefix, must surface as a project insight
        { id: 'stale_visibility', tone: 'caution', title: 'Stale visibility data', detail: 'Last visibility sweep is older than the latest sync.', actionLabel: 'Stale', href: '#runs' },
      ],
      runHistory: [],
      dateRangeLabel: 'All time',
      contextLabel: 'US / EN',
    },
  }

  const vm = buildProjectCommandCenter(data)
  const ids = vm.insights.map(i => i.id)
  expect(ids).toContain('stale_visibility')
  expect(ids).not.toContain('insight_abc') // DB echoes don't double up
  const stale = vm.insights.find(i => i.id === 'stale_visibility')!
  expect(stale.tone).toBe('caution')
  expect(stale.actionLabel).toBe('Stale')
})
