import { test, expect } from 'vitest'

import { buildDashboard, buildPortfolioProject, buildProjectCommandCenter, type ProjectData } from '../src/build-dashboard.js'
import type { ApiSettings } from '../src/api.js'

test('buildProjectCommandCenter evidence summary uses canonical mention vocabulary, not legacy "visible"', () => {
  // AGENTS.md vocabulary rule: new UI labels for the answer-text-presence
  // signal must say "mentioned", not "visible". The visibilityEvidenceSummary
  // helper used to mix the two terms in the same function — "visible in AI
  // answers" for one branch and "was not mentioned in AI answers" for the
  // adjacent branch. The fix unifies on "mentioned".
  const baseRun = {
    id: 'run_1',
    projectId: 'proj_1',
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    startedAt: '2026-03-15T00:00:00Z',
    finishedAt: '2026-03-15T00:00:10Z',
    error: null,
    createdAt: '2026-03-15T00:00:00Z',
  } as const

  const data: ProjectData = {
    project: {
      id: 'proj_1',
      name: 'mention-vocab',
      displayName: 'Mention Vocab',
      canonicalDomain: 'example.com',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['gemini'],
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-03-10T00:00:00Z',
      updatedAt: '2026-03-15T00:00:00Z',
    },
    runs: [baseRun],
    queries: [{ id: 'q_1', query: 'best polyurea roof coating', createdAt: '2026-03-10T00:00:00Z' }],
    competitors: [],
    timeline: [{
      query: 'best polyurea roof coating',
      runs: [{
        runId: 'run_1',
        createdAt: '2026-03-15T00:00:00Z',
        citationState: 'cited',
        transition: 'new',
        answerMentioned: true,
        visibilityState: 'visible',
        visibilityTransition: 'new',
        mentionState: 'mentioned',
        mentionTransition: 'new',
      }],
    }],
    latestRunDetails: [{
      ...baseRun,
      snapshots: [{
        id: 'snap_1',
        runId: 'run_1',
        queryId: 'q_1',
        query: 'best polyurea roof coating',
        provider: 'gemini',
        citationState: 'cited',
        answerMentioned: true,
        visibilityState: 'visible',
        mentionState: 'mentioned',
        answerText: 'The brand is mentioned.',
        citedDomains: ['example.com'],
        competitorOverlap: [],
        groundingSources: [],
        searchQueries: [],
        model: 'gemini-2.5-flash',
        location: null,
        createdAt: '2026-03-15T00:00:00Z',
      }],
    }],
    previousRunDetails: [],
  }

  const cc = buildProjectCommandCenter(data)
  const evidence = cc.visibilityEvidence[0]
  expect(evidence).toBeDefined()
  // Summary text must use the canonical "mentioned" vocabulary, not "visible".
  expect(evidence!.summary).toMatch(/mentioned/i)
  expect(evidence!.summary).not.toMatch(/\bvisible\b/i)
})

test('buildProjectCommandCenter carries the model web search queries into evidence', () => {
  // The search queries the model actually issued (snapshot.searchQueries, parsed
  // from the provider raw response) must reach the evidence view-model so the
  // detail modal can surface "Web searches the model ran". This is a pure
  // data-threading path: provider -> snapshot -> RunDetailDto -> evidence VM.
  const baseRun = {
    id: 'run_1',
    projectId: 'proj_1',
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    startedAt: '2026-03-15T00:00:00Z',
    finishedAt: '2026-03-15T00:00:10Z',
    error: null,
    createdAt: '2026-03-15T00:00:00Z',
  } as const

  const data: ProjectData = {
    project: {
      id: 'proj_1',
      name: 'web-queries',
      displayName: 'Web Queries',
      canonicalDomain: 'example.com',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['gemini'],
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-03-10T00:00:00Z',
      updatedAt: '2026-03-15T00:00:00Z',
    },
    runs: [baseRun],
    queries: [{ id: 'q_1', query: 'best polyurea roof coating', createdAt: '2026-03-10T00:00:00Z' }],
    competitors: [],
    timeline: [{
      query: 'best polyurea roof coating',
      runs: [{
        runId: 'run_1',
        createdAt: '2026-03-15T00:00:00Z',
        citationState: 'cited',
        transition: 'new',
        answerMentioned: true,
        visibilityState: 'visible',
        visibilityTransition: 'new',
        mentionState: 'mentioned',
        mentionTransition: 'new',
      }],
    }],
    latestRunDetails: [{
      ...baseRun,
      snapshots: [{
        id: 'snap_1',
        runId: 'run_1',
        queryId: 'q_1',
        query: 'best polyurea roof coating',
        provider: 'gemini',
        citationState: 'cited',
        answerMentioned: true,
        visibilityState: 'visible',
        mentionState: 'mentioned',
        answerText: 'The brand is mentioned.',
        citedDomains: ['example.com'],
        competitorOverlap: [],
        groundingSources: [],
        searchQueries: ['best polyurea roof coating brands', 'polyurea vs silicone roof coating'],
        model: 'gemini-2.5-flash',
        location: null,
        createdAt: '2026-03-15T00:00:00Z',
      }],
    }],
    previousRunDetails: [],
  }

  const cc = buildProjectCommandCenter(data)
  const evidence = cc.visibilityEvidence[0]
  expect(evidence).toBeDefined()
  expect(evidence!.searchQueries).toEqual([
    'best polyurea roof coating brands',
    'polyurea vs silicone roof coating',
  ])
})

test('buildProjectCommandCenter defaults searchQueries to empty for not-yet-run queries', () => {
  // A saved query with no run must still produce a well-formed evidence VM with
  // an empty searchQueries array (the modal renders nothing rather than crashing).
  const data: ProjectData = {
    project: {
      id: 'proj_1',
      name: 'pending-q',
      displayName: 'Pending Q',
      canonicalDomain: 'example.com',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['gemini'],
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-03-10T00:00:00Z',
      updatedAt: '2026-03-15T00:00:00Z',
    },
    runs: [],
    queries: [{ id: 'q_1', query: 'not run yet', createdAt: '2026-03-10T00:00:00Z' }],
    competitors: [],
    timeline: [],
    latestRunDetails: [],
    previousRunDetails: [],
  }

  const cc = buildProjectCommandCenter(data)
  const evidence = cc.visibilityEvidence.find((e) => e.query === 'not run yet')
  expect(evidence).toBeDefined()
  expect(evidence!.searchQueries).toEqual([])
})

test('buildDashboard maps Google settings into the dashboard view model', () => {
  const apiSettings: ApiSettings = {
    providers: [{
      name: 'gemini',
      configured: true,
      model: 'gemini-2.5-flash',
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

test('buildDashboard surfaces both the model override and the adapter default model', () => {
  const apiSettings: ApiSettings = {
    providers: [
      { name: 'gemini', configured: true, model: 'gemini-2.5-flash', defaultModel: 'gemini-3-flash-preview' },
      { name: 'openai', configured: true, defaultModel: 'gpt-5.4' },
    ],
    google: { configured: false },
  }

  const statuses = buildDashboard([], apiSettings).settings.providerStatuses

  // Explicit override is preserved verbatim.
  const gemini = statuses.find((p) => p.name === 'gemini')
  expect(gemini?.model).toBe('gemini-2.5-flash')
  expect(gemini?.defaultModel).toBe('gemini-3-flash-preview')

  // No override: model stays undefined, but the adapter default is carried
  // through so the settings card can show the effective model instead of a blank.
  const openai = statuses.find((p) => p.name === 'openai')
  expect(openai?.model).toBeUndefined()
  expect(openai?.defaultModel).toBe('gpt-5.4')
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
    latestRunDetails: [{
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
    }],
    previousRunDetails: [{
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
    }],
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
    latestRunDetails: [{
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
    }],
    previousRunDetails: [],
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
    latestRunDetails: [],
    previousRunDetails: [],
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
      queryCounts: { totalQueries: 4, citedQueries: 3, notCitedQueries: 1, citedRate: 0.75, mentionedQueries: 3, notMentionedQueries: 1, mentionRate: 0.75 },
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
    latestRunDetails: [],
    previousRunDetails: [],
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
      queryCounts: { totalQueries: 0, citedQueries: 0, notCitedQueries: 0, citedRate: 0, mentionedQueries: 0, notMentionedQueries: 0, mentionRate: 0 },
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

test('portfolio "All projects stable" attention item is non-navigable (no dead link)', () => {
  // Regression: the stable placeholder used to carry href:'/' + actionLabel
  // 'View portfolio'. On the overview page (which IS '/'), the whole card was
  // a <Link to="/"> that navigated to the page you were already on — a button
  // that did nothing. A non-actionable positive status must omit href so the
  // renderer shows a static row, not a dead link.
  const stableProject: ProjectData = {
    project: {
      id: 'proj_stable',
      name: 'stable-co',
      displayName: 'Stable Co',
      canonicalDomain: 'stable.example',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['gemini'],
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-05-10T00:00:00Z',
      updatedAt: '2026-05-13T00:00:00Z',
    },
    // A completed run (not running/queued) and no lost-citation evidence →
    // nothing needs attention → the stable placeholder is emitted.
    runs: [{ id: 'run_ok', projectId: 'proj_stable', kind: 'answer-visibility', status: 'completed', trigger: 'manual', startedAt: '2026-05-13T00:00:00Z', finishedAt: '2026-05-13T00:00:10Z', error: null, createdAt: '2026-05-13T00:00:00Z' }],
    queries: [],
    competitors: [],
    timeline: [],
    latestRunDetails: [],
    previousRunDetails: [],
  }

  const items = buildDashboard([stableProject], null).portfolioOverview.attentionItems
  const stable = items.find(i => i.id === 'attention_stable')
  expect(stable).toBeDefined()
  expect(stable!.title).toBe('All projects stable')
  expect(stable!.tone).toBe('positive')
  // The bug fix: no href and no action label → rendered as a static row.
  expect(stable!.href).toBeUndefined()
  expect(stable!.actionLabel).toBeUndefined()
})

test('portfolio active-runs attention item stays navigable', () => {
  // Symmetry guard: making href optional for the stable case must not strip
  // the real destination off actionable items. An in-progress run still links
  // to /runs.
  const activeProject: ProjectData = {
    project: {
      id: 'proj_active',
      name: 'active-co',
      displayName: 'Active Co',
      canonicalDomain: 'active.example',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['gemini'],
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-05-10T00:00:00Z',
      updatedAt: '2026-05-13T00:00:00Z',
    },
    runs: [{ id: 'run_live', projectId: 'proj_active', kind: 'answer-visibility', status: 'running', trigger: 'manual', startedAt: '2026-05-13T00:00:00Z', finishedAt: null, error: null, createdAt: '2026-05-13T00:00:00Z' }],
    queries: [],
    competitors: [],
    timeline: [],
    latestRunDetails: [],
    previousRunDetails: [],
  }

  const items = buildDashboard([activeProject], null).portfolioOverview.attentionItems
  const active = items.find(i => i.id === 'attention_proj_active_active')
  expect(active).toBeDefined()
  expect(active!.href).toBe('/runs')
  expect(active!.actionLabel).toBe('View runs')
  // The stable placeholder must NOT appear when something needs attention.
  expect(items.find(i => i.id === 'attention_stable')).toBeUndefined()
})

test('buildProjectCommandCenter emits one evidence row per location when a multi-location sweep fans out', () => {
  // Regression test for issue #477. Two same-timestamp runs (one per location)
  // must both surface evidence rows; the latest-run aggregate previously
  // collapsed to one non-deterministic location and dropped the other.
  const sharedCreatedAt = '2026-05-13T17:23:20.060Z'
  const data: ProjectData = {
    project: {
      id: 'proj_multi',
      name: 'azcoatings',
      displayName: 'AZ Coatings',
      canonicalDomain: 'azcoatings.example',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['gemini'],
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-05-10T00:00:00Z',
      updatedAt: '2026-05-13T00:00:00Z',
      locations: [
        { label: 'florida', city: 'Orlando', region: 'Florida', country: 'US' },
        { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' },
      ],
    },
    runs: [
      { id: 'run_fl', projectId: 'proj_multi', kind: 'answer-visibility', status: 'completed', trigger: 'manual', startedAt: sharedCreatedAt, finishedAt: sharedCreatedAt, error: null, createdAt: sharedCreatedAt },
      { id: 'run_mi', projectId: 'proj_multi', kind: 'answer-visibility', status: 'completed', trigger: 'manual', startedAt: sharedCreatedAt, finishedAt: sharedCreatedAt, error: null, createdAt: sharedCreatedAt },
    ],
    queries: [{ id: 'kw_1', query: 'polyurea roof coating', createdAt: '2026-05-10T00:00:00Z' }],
    competitors: [],
    timeline: [{
      query: 'polyurea roof coating',
      runs: [
        { runId: 'run_fl', createdAt: sharedCreatedAt, citationState: 'cited', transition: 'new' },
        { runId: 'run_mi', createdAt: sharedCreatedAt, citationState: 'not-cited', transition: 'new' },
      ],
      providerRuns: {
        gemini: [
          { runId: 'run_fl', createdAt: sharedCreatedAt, citationState: 'cited', transition: 'new' },
          { runId: 'run_mi', createdAt: sharedCreatedAt, citationState: 'not-cited', transition: 'new' },
        ],
      },
      modelRuns: {},
    }],
    latestRunDetails: [
      {
        id: 'run_fl',
        projectId: 'proj_multi',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        startedAt: sharedCreatedAt,
        finishedAt: sharedCreatedAt,
        error: null,
        createdAt: sharedCreatedAt,
        snapshots: [{
          id: 'snap_fl',
          runId: 'run_fl',
          queryId: 'kw_1',
          query: 'polyurea roof coating',
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          citationState: 'cited',
          answerMentioned: true,
          answerText: 'AZ Coatings is one Florida vendor for polyurea roof coating.',
          citedDomains: ['azcoatings.example'],
          competitorOverlap: [],
          groundingSources: [],
          searchQueries: [],
          location: 'florida',
          createdAt: sharedCreatedAt,
        }],
      },
      {
        id: 'run_mi',
        projectId: 'proj_multi',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        startedAt: sharedCreatedAt,
        finishedAt: sharedCreatedAt,
        error: null,
        createdAt: sharedCreatedAt,
        snapshots: [{
          id: 'snap_mi',
          runId: 'run_mi',
          queryId: 'kw_1',
          query: 'polyurea roof coating',
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          citationState: 'not-cited',
          answerMentioned: false,
          answerText: 'Several Michigan suppliers offer roof coatings.',
          citedDomains: [],
          competitorOverlap: [],
          groundingSources: [],
          searchQueries: [],
          location: 'michigan',
          createdAt: sharedCreatedAt,
        }],
      },
    ],
    previousRunDetails: [],
  }

  const vm = buildProjectCommandCenter(data)
  const evidence = vm.visibilityEvidence
  const florida = evidence.find(e => e.location === 'florida')
  const michigan = evidence.find(e => e.location === 'michigan')

  expect(florida).toBeDefined()
  expect(michigan).toBeDefined()
  expect(florida?.citationState).toBe('cited')
  expect(michigan?.citationState).toBe('not-cited')
  expect(florida?.citedDomains).toEqual(['azcoatings.example'])
  expect(michigan?.citedDomains).toEqual([])
  expect(florida?.answerSnippet).toContain('Florida')
  expect(michigan?.answerSnippet).toContain('Michigan')
})

test('buildProjectCommandCenter scopes per-location streak/changeLabel to that location only', () => {
  // Florida has been "cited" consistently across both prior and current runs.
  // Michigan was "cited" previously but is "not-cited" in the latest run, so
  // its row should display a "lost" transition derived from michigan's own
  // history, not florida's continued-cited streak.
  const prevCreatedAt = '2026-05-12T17:23:20.060Z'
  const latestCreatedAt = '2026-05-13T17:23:20.060Z'
  const data: ProjectData = {
    project: {
      id: 'proj_loc_history',
      name: 'azcoatings',
      displayName: 'AZ Coatings',
      canonicalDomain: 'azcoatings.example',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['gemini'],
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-05-10T00:00:00Z',
      updatedAt: latestCreatedAt,
      locations: [
        { label: 'florida', city: 'Orlando', region: 'Florida', country: 'US' },
        { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' },
      ],
    },
    runs: [
      { id: 'run_fl_prev', projectId: 'proj_loc_history', kind: 'answer-visibility', status: 'completed', trigger: 'manual', startedAt: prevCreatedAt, finishedAt: prevCreatedAt, error: null, createdAt: prevCreatedAt },
      { id: 'run_mi_prev', projectId: 'proj_loc_history', kind: 'answer-visibility', status: 'completed', trigger: 'manual', startedAt: prevCreatedAt, finishedAt: prevCreatedAt, error: null, createdAt: prevCreatedAt },
      { id: 'run_fl', projectId: 'proj_loc_history', kind: 'answer-visibility', status: 'completed', trigger: 'manual', startedAt: latestCreatedAt, finishedAt: latestCreatedAt, error: null, createdAt: latestCreatedAt },
      { id: 'run_mi', projectId: 'proj_loc_history', kind: 'answer-visibility', status: 'completed', trigger: 'manual', startedAt: latestCreatedAt, finishedAt: latestCreatedAt, error: null, createdAt: latestCreatedAt },
    ],
    queries: [{ id: 'kw_1', query: 'polyurea roof coating', createdAt: '2026-05-10T00:00:00Z' }],
    competitors: [],
    timeline: [{
      query: 'polyurea roof coating',
      runs: [
        { runId: 'run_fl_prev', createdAt: prevCreatedAt, citationState: 'cited', transition: 'new', location: 'florida' },
        { runId: 'run_mi_prev', createdAt: prevCreatedAt, citationState: 'cited', transition: 'cited', location: 'michigan' },
        { runId: 'run_fl', createdAt: latestCreatedAt, citationState: 'cited', transition: 'cited', location: 'florida' },
        { runId: 'run_mi', createdAt: latestCreatedAt, citationState: 'not-cited', transition: 'lost', location: 'michigan' },
      ],
      providerRuns: {
        gemini: [
          { runId: 'run_fl_prev', createdAt: prevCreatedAt, citationState: 'cited', transition: 'new', location: 'florida' },
          { runId: 'run_mi_prev', createdAt: prevCreatedAt, citationState: 'cited', transition: 'cited', location: 'michigan' },
          { runId: 'run_fl', createdAt: latestCreatedAt, citationState: 'cited', transition: 'cited', location: 'florida' },
          { runId: 'run_mi', createdAt: latestCreatedAt, citationState: 'not-cited', transition: 'lost', location: 'michigan' },
        ],
      },
      modelRuns: {},
    }],
    latestRunDetails: [
      {
        id: 'run_fl',
        projectId: 'proj_loc_history',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        startedAt: latestCreatedAt,
        finishedAt: latestCreatedAt,
        error: null,
        createdAt: latestCreatedAt,
        snapshots: [{
          id: 'snap_fl',
          runId: 'run_fl',
          queryId: 'kw_1',
          query: 'polyurea roof coating',
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          citationState: 'cited',
          answerMentioned: true,
          answerText: 'florida snap',
          citedDomains: ['azcoatings.example'],
          competitorOverlap: [],
          groundingSources: [],
          searchQueries: [],
          location: 'florida',
          createdAt: latestCreatedAt,
        }],
      },
      {
        id: 'run_mi',
        projectId: 'proj_loc_history',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        startedAt: latestCreatedAt,
        finishedAt: latestCreatedAt,
        error: null,
        createdAt: latestCreatedAt,
        snapshots: [{
          id: 'snap_mi',
          runId: 'run_mi',
          queryId: 'kw_1',
          query: 'polyurea roof coating',
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          citationState: 'not-cited',
          answerMentioned: false,
          answerText: 'michigan snap',
          citedDomains: [],
          competitorOverlap: [],
          groundingSources: [],
          searchQueries: [],
          location: 'michigan',
          createdAt: latestCreatedAt,
        }],
      },
    ],
    previousRunDetails: [],
  }

  const evidence = buildProjectCommandCenter(data).visibilityEvidence
  const florida = evidence.find(e => e.location === 'florida')
  const michigan = evidence.find(e => e.location === 'michigan')

  expect(florida?.citationState).toBe('cited')
  expect(michigan?.citationState).toBe('lost')
  // Florida's runHistory should contain only florida entries — michigan's
  // "lost" transition must not leak into florida's chart.
  expect(florida?.runHistory.map(r => r.runId)).toEqual(['run_fl_prev', 'run_fl'])
  expect(michigan?.runHistory.map(r => r.runId)).toEqual(['run_mi_prev', 'run_mi'])
})

test('buildProjectCommandCenter emits a single history-only row when no location has a snap', () => {
  // openai has no snapshot in the latest run for either location but does
  // have provider-level history. Pre-fix, this would emit one row per
  // configured location with identical data; the fix should produce a
  // single synthetic fallback row with null location.
  const sharedCreatedAt = '2026-05-13T17:23:20.060Z'
  const data: ProjectData = {
    project: {
      id: 'proj_history_only',
      name: 'azcoatings',
      displayName: 'AZ Coatings',
      canonicalDomain: 'azcoatings.example',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['gemini', 'openai'],
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-05-10T00:00:00Z',
      updatedAt: sharedCreatedAt,
      locations: [
        { label: 'florida', city: 'Orlando', region: 'Florida', country: 'US' },
        { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' },
      ],
    },
    runs: [
      { id: 'run_fl', projectId: 'proj_history_only', kind: 'answer-visibility', status: 'completed', trigger: 'manual', startedAt: sharedCreatedAt, finishedAt: sharedCreatedAt, error: null, createdAt: sharedCreatedAt },
      { id: 'run_mi', projectId: 'proj_history_only', kind: 'answer-visibility', status: 'completed', trigger: 'manual', startedAt: sharedCreatedAt, finishedAt: sharedCreatedAt, error: null, createdAt: sharedCreatedAt },
    ],
    queries: [{ id: 'kw_1', query: 'polyurea roof coating', createdAt: '2026-05-10T00:00:00Z' }],
    competitors: [],
    timeline: [{
      query: 'polyurea roof coating',
      runs: [
        { runId: 'run_fl', createdAt: sharedCreatedAt, citationState: 'cited', transition: 'new', location: 'florida' },
        { runId: 'run_mi', createdAt: sharedCreatedAt, citationState: 'not-cited', transition: 'new', location: 'michigan' },
      ],
      providerRuns: {
        gemini: [
          { runId: 'run_fl', createdAt: sharedCreatedAt, citationState: 'cited', transition: 'new', location: 'florida' },
          { runId: 'run_mi', createdAt: sharedCreatedAt, citationState: 'not-cited', transition: 'new', location: 'michigan' },
        ],
        openai: [
          { runId: 'older_run', createdAt: '2026-05-01T00:00:00Z', citationState: 'cited', transition: 'cited', location: 'florida' },
        ],
      },
      modelRuns: {},
    }],
    latestRunDetails: [
      {
        id: 'run_fl',
        projectId: 'proj_history_only',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        startedAt: sharedCreatedAt,
        finishedAt: sharedCreatedAt,
        error: null,
        createdAt: sharedCreatedAt,
        snapshots: [{
          id: 'snap_fl',
          runId: 'run_fl',
          queryId: 'kw_1',
          query: 'polyurea roof coating',
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          citationState: 'cited',
          answerMentioned: true,
          answerText: 'florida gemini snap',
          citedDomains: ['azcoatings.example'],
          competitorOverlap: [],
          groundingSources: [],
          searchQueries: [],
          location: 'florida',
          createdAt: sharedCreatedAt,
        }],
      },
      {
        id: 'run_mi',
        projectId: 'proj_history_only',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        startedAt: sharedCreatedAt,
        finishedAt: sharedCreatedAt,
        error: null,
        createdAt: sharedCreatedAt,
        snapshots: [{
          id: 'snap_mi',
          runId: 'run_mi',
          queryId: 'kw_1',
          query: 'polyurea roof coating',
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          citationState: 'not-cited',
          answerMentioned: false,
          answerText: 'michigan gemini snap',
          citedDomains: [],
          competitorOverlap: [],
          groundingSources: [],
          searchQueries: [],
          location: 'michigan',
          createdAt: sharedCreatedAt,
        }],
      },
    ],
    previousRunDetails: [],
  }

  const evidence = buildProjectCommandCenter(data).visibilityEvidence
  const openaiRows = evidence.filter(e => e.provider === 'openai')
  // History-only provider must not multiply across configured locations.
  expect(openaiRows).toHaveLength(1)
  expect(openaiRows[0]?.location).toBeNull()
  // Gemini has a snap per location and should still emit two rows.
  const geminiRows = evidence.filter(e => e.provider === 'gemini')
  expect(geminiRows).toHaveLength(2)
})

test('buildPortfolioProject carries the mention-rate trend, score, and subtitle from the overview', () => {
  const base: ProjectData = {
    project: {
      id: 'proj_portfolio',
      name: 'portfolio-demo',
      displayName: 'Portfolio Demo',
      canonicalDomain: 'portfolio.example',
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
    latestRunDetails: [],
    previousRunDetails: [],
    overview: {
      project: {
        id: 'proj_portfolio',
        name: 'portfolio-demo',
        displayName: 'Portfolio Demo',
        canonicalDomain: 'portfolio.example',
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
      queryCounts: { totalQueries: 4, citedQueries: 3, notCitedQueries: 1, citedRate: 0.75, mentionedQueries: 3, notMentionedQueries: 1, mentionRate: 0.75 },
      providers: [{ provider: 'gemini', cited: 3, total: 4, citedRate: 0.75 }],
      transitions: { since: null, gained: 0, lost: 0, emerging: 0 },
      scores: {
        // The server populates each headline score's trend from runHistory.
        // Mention is the headline metric the portfolio row reads; give it a
        // distinct trend + progress from visibility to prove the builder reads
        // mention, not cited.
        mention: { label: 'Mention Coverage', value: '60', delta: '3 of 4 queries mentioned', tone: 'positive', description: '', tooltip: '', trend: [40, 60, 80], progress: 60 },
        visibility: { label: 'Citation Coverage', value: '75', delta: '3 of 4 queries', tone: 'positive', description: '', tooltip: '', trend: [25, 50, 75], progress: 75 },
        mentionShare: { label: 'Mention Share', value: 'No data', delta: '', tone: 'neutral', description: '', tooltip: '', trend: [], breakdown: { projectMentionSnapshots: 0, competitorMentionSnapshots: 0, perCompetitor: [], snapshotsWithAnswerText: 0, snapshotsTotal: 0 } },
        mentionGaps: { label: 'Mention Gaps', value: '0', delta: '', tone: 'positive', description: '', tooltip: '', trend: [] },
        gapQueries: { label: 'Gap Queries', value: '0', delta: '', tone: 'positive', description: '', tooltip: '', trend: [] },
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

  // The headline metric is Mention Coverage — the portfolio row reads the
  // mention score + mention trend, NOT the cited/visibility ones. Mention's
  // trend ([40,60,80]) and progress (60) differ from visibility's so this
  // proves the builder switched signals.
  expect(buildPortfolioProject(base).trend).toEqual([40, 60, 80])
  expect(buildPortfolioProject(base).mentionScore).toBe(60)

  // The headline delta + subtitle both read the MENTION count
  // (answerMentioned), never the cited count. Seed mentioned≠cited and prove
  // both track mentioned (1 of 4) rather than cited (3 of 4).
  const distinctMention = buildPortfolioProject({
    ...base,
    overview: {
      ...base.overview!,
      queryCounts: { totalQueries: 4, citedQueries: 3, notCitedQueries: 1, citedRate: 0.75, mentionedQueries: 1, notMentionedQueries: 3, mentionRate: 0.25 },
    },
  })
  expect(distinctMention.insight).toBe('1 of 4 queries mentioned across 1 provider.')
  expect(distinctMention.mentionDelta).toBe('1 of 4 queries')

  // Without an overview (no runs yet) the trend is empty and the sparkline no-ops.
  expect(buildPortfolioProject({ ...base, overview: null }).trend).toEqual([])
})
